// 写队列事务/崩溃补偿/坏载荷与 keeper 消费边界；依赖 writer-harness.mjs 的临时库，不 import 其它测试文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { Config } from '../../src/host/config.js'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper } from '../../src/core/keeper.js'
import {
  contradiction, createWriteQueue, decideWrite, findCandidates, privacyCheck, processEvent,
  recordWrite, slotsOf, timeOverlap,
} from '../../src/core/writer.js'
import { IDENT, auto, event, fakeLlm, freshDb, judgeQueue, judgeWrite, storeOf } from './writer-harness.mjs'

test('queue：先落盘再处理，enqueue 的 Promise 在 job done 时 resolve', async (t) => {
  const db = freshDb(t)
  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())

  const pendingPromise = q.enqueue(event('队列持久化记忆'))
  const jobRow = db.prepare('SELECT id,state,kind FROM jobs').get()
  assert.equal(jobRow.kind, 'write')
  assert.equal(jobRow.state, 'queued')
  assert.equal(q.pending(), 1)

  const p1 = q.drain()
  const p2 = q.drain()
  assert.equal(p1, p2, 'drain 必须单飞（同一 Promise）')
  const { processed } = await p1
  assert.equal(processed, 1)

  const result = await pendingPromise
  assert.equal(result.action, 'ADD')
  assert.match(result.id, /^n\d+_[0-9a-f]{10}$/)

  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobRow.id)
  assert.equal(job.state, 'done')
  assert.equal(Number(job.attempts), 1)
  assert.match(String(job.payload), /"result":\{"action":"ADD"/)
  assert.equal(q.pending(), 0)

  const duplicate = await q.enqueue(event('队列持久化记忆'))
  assert.equal(duplicate.action, 'NOOP')
  assert.equal(duplicate.duplicate, true)
})

test('queue 崩溃补偿：遗留 running job 复位 queued 后 drain 跑完', async (t) => {
  const db = freshDb(t)
  const payload = JSON.stringify(event('崩溃前遗留的记忆'))
  const jobId = Number(db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('write', 'running', 0, payload, now(), now()).lastInsertRowid)

  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'queued')

  const { processed } = await q.drain()
  assert.equal(processed, 1)
  const job = db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(jobId)
  assert.equal(job.state, 'done')
  assert.equal(Number(job.attempts), 1)
  const node = db.prepare('SELECT text FROM nodes').get()
  assert.equal(node.text, '崩溃前遗留的记忆')
})

test('queue：单条坏 payload 记 REJECT 后继续处理同批', async (t) => {
  const db = freshDb(t)
  const insert = db.prepare('INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  insert.run('write', 'queued', 0, '{不是 JSON', now(), now())
  insert.run('write', 'queued', 0, JSON.stringify(event('坏 job 之后仍要处理')), now(), now())

  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())
  const { processed } = await q.drain()
  assert.equal(processed, 2)
  const states = db.prepare('SELECT state FROM jobs ORDER BY id').all().map((r) => r.state)
  assert.deepEqual(states, ['done', 'done'])
  assert.ok(db.prepare('SELECT text FROM nodes').get())
})

test('review：accept 落节点并改审计为 ADD；reject 改 REJECT；找不到候选报错', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  processEvent(db, event('待审核的候选记忆'), shadow)
  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const accepted = q.review(candidate.id, 'accept')
  assert.equal(accepted.ok, true)
  assert.match(accepted.id, /^n\d+_[0-9a-f]{10}$/)

  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(accepted.id)
  assert.equal(node.text, candidate.after_text)
  assert.equal(node.source, 'self')
  // 契约变更（R12）：accept 保留候选原始 origin，不再统一改写 shadow-review，便于回查来源。
  assert.equal(node.origin, 'unit')
  assert.equal(node.status, 'active')
  assert.equal(node.user_id, 'u1')
  assert.equal(node.workspace, 'web')
  const afterAccept = db.prepare('SELECT action,node_id FROM writes WHERE id=?').get(candidate.id)
  assert.equal(afterAccept.action, 'ADD')
  assert.equal(afterAccept.node_id, accepted.id)

  const rejectedCandidate = processEvent(db, event('要被驳回的候选记忆'), shadow)
  assert.equal(rejectedCandidate.action, 'CANDIDATE')
  const rejectRow = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const rejected = q.review(rejectRow.id, 'reject', '重复冲突')
  assert.equal(rejected.ok, true)
  const afterReject = db.prepare('SELECT action,reason FROM writes WHERE id=?').get(rejectRow.id)
  assert.equal(afterReject.action, 'REJECT')
  assert.match(afterReject.reason, /review:reject:重复冲突/)

  assert.deepEqual(q.review(999999, 'accept'), { ok: false, error: 'candidate_not_found' })
  assert.deepEqual(q.review(candidate.id, 'accept'), { ok: false, error: 'candidate_not_found' })
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
})

test('keeper 不接管 write job；写队列 drain 才是唯一消费者（数据丢失回归）', async (t) => {
  const db = freshDb(t)
  const store = { withDb: (fn) => fn(db), dbFile: join(tmpdir(), 'unused.db') }
  // 模拟崩溃遗留：一条 queued 写 job 已在库里，但没有内存 waiter。
  const event = { text: '崩溃遗留写入', identity: IDENT, source: 'owner', traceId: 't-crash' }
  const jobId = Number(db.prepare(`INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at)
    VALUES ('write','queued',0,?,?,?)`).run(JSON.stringify(event), now(), now()).lastInsertRowid)

  const keeper = createKeeper({ store, config: {}, pressure: () => ({ stress: false }), nowFn: () => now() })
  t.after(() => keeper.dispose())
  const r = await keeper.tick()
  assert.deepEqual(r, { ran: [], skipped: 'no_job' }, 'keeper 必须跳过 write job')
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'queued')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 0)

  const q = createWriteQueue({ store, config: { write: { reviewMode: 'auto' } } })
  t.after(() => q.dispose())
  const drained = await q.drain()
  assert.equal(drained.processed, 1)
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'done')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, '遗留事件必须真正落库')
})
