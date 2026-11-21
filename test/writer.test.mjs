/**
 * 写入决策与队列的单测（架构书 §6.2/§7.3）：只碰临时库，不访问真实数据目录/网络。
 *
 * 覆盖口径：
 * - 四个纯函数（隐私/槽位/冲突/时间重叠）先单验，再验过程（ADD/NOOP/MERGE/SUPERSEDE/REVIEW/CANDIDATE）。
 * - 落库断言查真实列值（双时态、三隔离列、text_bigrams/text_hash），不只信返回值。
 * - 队列断言查 jobs 行状态 + payload 里的 result，确认"先落盘再处理"与崩溃补偿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../src/core/db.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'
import {
  contradiction, createWriteQueue, decideWrite, privacyCheck, processEvent,
  recordWrite, slotsOf, timeOverlap,
} from '../src/core/writer.js'

const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }

/** 临时库：每个用例独立目录，结束时关闭。 */
function freshDb(t) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-writer-')))
  t.after(() => closeDb(db))
  return db
}

/** 造事件（缺省值对齐真实写入入口）。 */
function event(text, extra = {}) {
  return {
    traceId: 'tr-1',
    source: 'chat',
    identity: IDENT,
    text,
    tags: [],
    at: 0,
    candidateType: 'fact',
    origin: 'unit',
    level: 'normal',
    memory_type: 'semantic',
    ...extra,
  }
}

/** auto 模式配置（可覆盖 write 段）。 */
function auto(write = {}) {
  return { write: { reviewMode: 'auto', ...write } }
}

/** 内存 store：队列只需要 withDb 同步入口。 */
function storeOf(db) {
  return { withDb: (fn) => fn(db) }
}

test('slotsOf：只认端口/路径/版本/日期，且端口必须同句含语境词', (t) => {
  assert.deepEqual(
    slotsOf('服务端口是 8080，回调路径 /tmp/x，版本 v1.2，日期 2026-11-22'),
    ['port:8080', 'path:/tmp/x', 'version:1.2', 'date:2026-11-22'],
  )
  // 没有 端口|port|回调|webhook 语境：数字不算端口
  assert.deepEqual(slotsOf('数字 8080 没有语境'), [])
  // URL 协议头不是路径
  assert.deepEqual(slotsOf('地址 http://example.com/a'), [])
  assert.deepEqual(slotsOf(''), [])
  assert.deepEqual(slotsOf(null), [])
})

test('privacyCheck：严格模式拒绝，脱敏模式替换命中片段', (t) => {
  const raw = '联系人 a@b.com 电话 13800138000 身份证 110101199003071234'
  const strict = privacyCheck(raw, { redact: false })
  assert.equal(strict.ok, false)
  assert.equal(strict.reason, 'privacy')
  assert.equal(strict.text, raw, 'redact=false 不改写原文')

  const soft = privacyCheck(`${raw} 密钥 sk-abcdefgh12345678 Bearer abcdefgh12345678 密码=hunter2`)
  assert.equal(soft.ok, true)
  assert.equal(soft.reason, 'privacy_redacted')
  assert.match(soft.text, /\[已脱敏\]/)
  for (const leaked of ['a@b.com', '13800138000', '110101199003071234', 'sk-abcdefgh12345678', 'hunter2']) {
    assert.ok(!soft.text.includes(leaked), `不应残留 ${leaked}`)
  }
  // 干净文本原样返回
  assert.deepEqual(privacyCheck('今天下午开会'), { ok: true, text: '今天下午开会' })
})

test('contradiction：否定对优先，其次同前缀槽位差异；无关文本不冲突', (t) => {
  assert.equal(contradiction({ text: '允许访客访问共享目录' }, '禁止访客访问共享目录'), 'negation')
  assert.equal(contradiction({ text: '这个模块必须双人复核' }, '这个模块不必双人复核'), 'negation')
  assert.equal(
    contradiction({ text: '项目部署在测试环境 端口是 8080' }, '项目部署在测试环境 端口是 9090'),
    'slot',
  )
  assert.equal(contradiction({ text: '项目部署在测试环境 端口是 8080' }, '今天午餐吃了面条'), null)
})

test('timeOverlap：三段式（旧事实先失效 / 新事实先失效 / 重叠）', (t) => {
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: 20 }, { valid_at: 30 }), 'no-overlap')
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: null }, { valid_at: 30, invalid_at: 5 }), 'no-overlap')
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: null }, { valid_at: 30 }), 'overlap')
  // 缺时间戳不能被当成 0（Number(null)===0 会制造假"不重叠"）
  assert.equal(timeOverlap({ valid_at: null, invalid_at: null }, 30), 'overlap')
})

test('ADD：节点字段全填、三隔离列与审计行一致', (t) => {
  const db = freshDb(t)
  const text = '记住项目代号是蓝鲸'
  const r = processEvent(db, event(text, { tags: ['项目'] }), auto())
  assert.equal(r.ok, true)
  assert.equal(r.action, 'ADD')
  assert.match(r.id, /^n\d+_[0-9a-f]{10}$/)

  const row = db.prepare('SELECT * FROM nodes WHERE id=?').get(r.id)
  assert.equal(row.text, text)
  assert.equal(row.text_hash, contentHash(text))
  assert.equal(row.text_bigrams, bigrams(text))
  assert.equal(row.status, 'active')
  assert.equal(row.source, 'self') // 事件 source='chat' → nodes.source 合法值 'self'
  assert.equal(row.level, 'normal')
  assert.equal(row.memory_type, 'semantic')
  assert.equal(row.user_id, 'u1')
  assert.equal(row.role_id, '')
  assert.equal(row.workspace, 'web')
  assert.deepEqual(JSON.parse(row.tags), ['项目'])
  assert.equal(row.origin, 'unit')
  assert.equal(row.trace_id, 'tr-1')
  assert.ok(Number(row.created_at) > 0)
  assert.ok(Number(row.valid_at) > 0)

  const write = db.prepare('SELECT * FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'ADD')
  assert.equal(write.node_id, r.id)
  assert.equal(write.mode, 'auto')
  assert.equal(write.after_text, text)
  assert.equal(write.user_id, 'u1')
  assert.equal(write.trace_id, 'tr-1')
})

test('NOOP：同身份原文重复只记命中，不新增节点', (t) => {
  const db = freshDb(t)
  const first = processEvent(db, event('重复消息只记一次'), auto())
  const second = processEvent(db, event('重复消息只记一次'), auto())
  assert.equal(second.action, 'NOOP')
  assert.equal(second.id, first.id)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  const row = db.prepare('SELECT hits,last_hit_at FROM nodes WHERE id=?').get(first.id)
  assert.equal(Number(row.hits), 1)
  assert.ok(Number(row.last_hit_at) > 0)
  const write = db.prepare('SELECT action,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'NOOP')
  assert.equal(write.node_id, first.id)
})

test('shadow：会落库的动作降级为 CANDIDATE，nodes 一行不写', (t) => {
  const db = freshDb(t)
  const r = processEvent(db, event('影子模式下的候选记忆'), { write: { reviewMode: 'shadow' } })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'CANDIDATE')
  assert.equal(r.id, undefined)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 0)

  const write = db.prepare('SELECT * FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'CANDIDATE')
  assert.equal(write.node_id, null)
  assert.match(write.reason, /shadow:ADD/)
  assert.equal(write.after_text, '影子模式下的候选记忆')
  assert.equal(write.mode, 'shadow')
})

test('MERGE：信息只增不减时合并到旧节点，不新增节点', (t) => {
  const db = freshDb(t)
  const oldText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const newText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用功能'
  const old = processEvent(db, event(oldText), auto())
  const r = processEvent(db, event(newText), auto())
  assert.equal(r.action, 'MERGE')
  assert.equal(r.id, old.id)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  const row = db.prepare('SELECT text,text_hash,text_bigrams,updated_at FROM nodes WHERE id=?').get(old.id)
  assert.equal(row.text, newText)
  assert.equal(row.text_hash, contentHash(newText))
  assert.equal(row.text_bigrams, bigrams(newText))

  const write = db.prepare('SELECT action,before_text,after_text,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'MERGE')
  assert.equal(write.node_id, old.id)
  assert.equal(write.before_text, oldText)
  assert.equal(write.after_text, newText)
})

test('SUPERSEDE：端口槽位冲突取代旧节点，双时态与 supersede 边齐备', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const newText = '项目部署在测试环境 端口是 9090'
  const old = processEvent(db, event(oldText), auto())
  const r = processEvent(db, event(newText), auto())
  assert.equal(r.action, 'SUPERSEDE')
  assert.notEqual(r.id, old.id)

  const oldRow = db.prepare('SELECT status,invalid_at,expired_at,superseded_by FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.status, 'superseded')
  assert.ok(Number(oldRow.invalid_at) > 0)
  assert.ok(Number(oldRow.expired_at) > 0)
  assert.equal(oldRow.superseded_by, r.id)

  const newRow = db.prepare('SELECT status,text FROM nodes WHERE id=?').get(r.id)
  assert.equal(newRow.status, 'active')
  assert.equal(newRow.text, newText)

  const edge = db.prepare("SELECT * FROM edges WHERE etype='supersede' AND from_id=? AND to_id=?").get(old.id, r.id)
  assert.ok(edge, '必须留下 supersede 溯源边')
  assert.equal(Number(edge.conf), 1)
})

test('REVIEW：受保护节点冲突只告警（mutex 边），旧节点保持 active', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const old = processEvent(db, event(oldText, { level: 'core' }), auto())
  const r = processEvent(db, event('项目部署在测试环境 端口是 9090'), auto())
  assert.equal(r.action, 'REVIEW')
  assert.equal(r.reason, 'protected')

  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(r.id).status, 'active')
  const edge = db.prepare("SELECT * FROM edges WHERE etype='mutex' AND from_id=? AND to_id=?").get(old.id, r.id)
  assert.ok(edge, '冲突告警要有 mutex 边')
  const write = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REVIEW')
  assert.equal(write.reason, 'protected')

  // 关掉保护后，同样的冲突回到 SUPERSEDE
  const db2 = freshDb(t)
  processEvent(db2, event(oldText, { level: 'core' }), auto())
  const r2 = processEvent(db2, event('项目部署在测试环境 端口是 9090'), auto({ protect: false }))
  assert.equal(r2.action, 'SUPERSEDE')
})

test('隐私：默认脱敏后落库；严格入口直接 REJECT', (t) => {
  const db = freshDb(t)
  const r = processEvent(db, event('密钥是 sk-abcdefgh12345678 其余内容正常'), auto())
  assert.equal(r.action, 'ADD')
  const row = db.prepare('SELECT text FROM nodes WHERE id=?').get(r.id)
  assert.match(row.text, /\[已脱敏\]/)
  assert.ok(!row.text.includes('sk-abcdefgh12345678'))
  const write = db.prepare('SELECT reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.match(write.reason, /privacy:redacted/)

  const strictEvent = event('联系我 a@b.com')
  const rejected = processEvent(db, strictEvent, auto({ redact: false }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.action, 'REJECT')
  assert.equal(rejected.reason, 'privacy')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
})

test('每日上限：达到 dailyCap 后新事实被拒（NOOP/REJECT 不占额度）', (t) => {
  const db = freshDb(t)
  const config = auto({ dailyCap: 1 })
  assert.equal(processEvent(db, event('第一条独立记忆内容'), config).action, 'ADD')
  const capped = processEvent(db, event('第二条独立记忆内容'), config)
  assert.equal(capped.ok, false)
  assert.equal(capped.action, 'REJECT')
  assert.equal(capped.reason, 'daily_cap')
  const write = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REJECT')
  assert.equal(write.reason, 'daily_cap')
})

test('计划/承诺词：冲突只新增，不取代已落地事实', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('服务器端口使用 8080 并开启回调'), auto())
  const r = processEvent(db, event('下周计划把服务器端口改成 9090 并开启回调'), auto())
  assert.equal(r.action, 'ADD')
  assert.match(r.reason, /plan_deferred/)
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(r.id).status, 'active')
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM edges WHERE etype='supersede'").get().n), 0)
})

test('decideWrite：纯决策不落库，返回目标与前后文本', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const old = processEvent(db, event(oldText), auto())
  const decision = decideWrite(db, event('项目部署在测试环境 端口是 9090'), { mode: 'auto' })
  assert.equal(decision.action, 'SUPERSEDE')
  assert.equal(decision.targetId, old.id)
  assert.equal(decision.beforeText, oldText)
  assert.equal(decision.afterText, '项目部署在测试环境 端口是 9090')
  // 决策阶段不写审计
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM writes').get().n), 1)
})

test('recordWrite：审计行字段（mode/身份/trace/前后文本）完整可查', (t) => {
  const db = freshDb(t)
  const id = recordWrite(db, event('审计行专用文本', { traceId: 'tr-audit' }), {
    action: 'ADD', reason: 'manual', beforeText: '', afterText: '审计行专用文本', mode: 'auto',
  })
  assert.ok(Number.isInteger(id) && id > 0)
  const row = db.prepare('SELECT * FROM writes WHERE id=?').get(id)
  assert.equal(row.action, 'ADD')
  assert.equal(row.reason, 'manual')
  assert.equal(row.mode, 'auto')
  assert.equal(row.trace_id, 'tr-audit')
  assert.equal(row.user_id, 'u1')
  assert.equal(row.role_id, '')
  assert.equal(row.workspace, 'web')
  assert.equal(row.before_text, '')
  assert.equal(row.after_text, '审计行专用文本')
})

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
  assert.equal(node.origin, 'shadow-review')
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
