/**
 * 0.8.1-01 jobs.payload 正文治理：终态脱敏 + 超期清理 + 续跑证据不误伤。
 *
 * 为什么必须从真库断言（铁律 4）：脱敏点分散在写队列与 keeper 两条终态路径，
 * 单测只验 helper 会让「helper 对、调用点漏」的回归全绿。这里读 jobs 行级 payload。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper } from '../../src/core/keeper.js'
import {
  RETRY_MAX_ATTEMPTS, isTerminalJob, redactJobPayload, sweepJobPayloads,
} from '../../src/core/job-payload.js'

const identity = { userId: 'u1', roleId: '', workspace: '/work/ws' }
const config = {
  write: { enabled: true, reviewMode: 'auto' },
  wrap: { ingest: { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true } },
  reflect: { maxItems: 8 },
}

function makeBackend(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-job-payload-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  return backend
}

test('redactJobPayload：只留白名单键，脏输入落 {}（不抛）', () => {
  const out = JSON.parse(redactJobPayload({
    text: 'SECRET-BODY', tags: ['a'], ingestPolicy: { mode: 'auto' },
    reason: 'turn_steps', sessionId: 's1', identity, result: { action: 'ADD' },
    __judgeVerdict: { ok: true }, unknownFutureField: 'x',
  }))
  assert.equal(out.text, undefined, '正文必须被丢掉')
  assert.equal(out.tags, undefined)
  assert.equal(out.ingestPolicy, undefined)
  assert.equal(out.__judgeVerdict, undefined)
  assert.equal(out.unknownFutureField, undefined, '白名单外的一律丢（黑名单会漏新字段）')
  assert.equal(out.reason, 'turn_steps')
  assert.equal(out.sessionId, 's1')
  assert.deepEqual(out.identity, identity)
  assert.deepEqual(out.result, { action: 'ADD' })
  assert.equal(redactJobPayload('not json{'), '{}')
  assert.equal(redactJobPayload(null), '{}')
  assert.equal(redactJobPayload([1, 2]), '{}')
})

test('isTerminalJob：failed 只有 attempts 到上限才算终态（可重跑的不算）', () => {
  assert.equal(isTerminalJob({ state: 'queued', attempts: 0 }), false)
  assert.equal(isTerminalJob({ state: 'running', attempts: 2 }), false)
  assert.equal(isTerminalJob({ state: 'done', attempts: 1 }), true)
  assert.equal(isTerminalJob({ state: 'failed', attempts: 1 }), false)
  assert.equal(isTerminalJob({ state: 'failed', attempts: RETRY_MAX_ATTEMPTS }), true)
})

test('写队列真库：终态 job payload 不含正文，result 仍可结算', async (t) => {
  const backend = makeBackend(t)
  const r = await backend.write({ text: 'SECRET-WRITE-BODY 门禁失败不得发布', memory_type: 'procedural', identity })
  assert.equal(r.ok, true)
  const row = backend.withDb((db) => db.prepare(
    "SELECT state,payload FROM jobs WHERE kind='write' ORDER BY id DESC LIMIT 1",
  ).get())
  assert.equal(row.state, 'done')
  const payload = JSON.parse(row.payload)
  assert.equal(payload.text, undefined, '终态 payload 不得保留写入正文')
  assert.equal(String(row.payload).includes('SECRET-WRITE-BODY'), false)
  assert.ok(payload.result && payload.result.action, 'result 必须保留（waiter 结算依赖）')
})

test('keeper 终态：可重跑的 failed 保留正文，attempts 到上限才脱敏', async (t) => {
  const backend = makeBackend(t)
  const keeper = createKeeper({ store: backend, config: {}, log: () => {}, intervalMs: 3600_000 })
  t.after(() => keeper.dispose())
  // 'wrap' 的 handler 由 session-wrap 接线，这里未注册 → no_handler 失败（可重试）。
  const id = keeper.enqueue('wrap', { runId: 7, spoolPath: '/tmp/spool.bin', materialHash: 'h', text: 'SECRET-JOB-BODY' })
  await keeper.tick()
  let row = backend.withDb((db) => db.prepare('SELECT state,attempts,payload,last_error FROM jobs WHERE id=?').get(id))
  assert.equal(row.state, 'queued', '未到上限的失败按退避重排（不是终态）')
  assert.equal(Number(row.attempts), 1)
  assert.match(String(row.last_error), /no_handler/)
  assert.equal(String(row.payload).includes('SECRET-JOB-BODY'), true, '还能重排的 failed 必须保留续跑证据')

  backend.withDb((db) => db.prepare('UPDATE jobs SET attempts=?, next_at=NULL WHERE id=?').run(RETRY_MAX_ATTEMPTS - 1, id))
  await keeper.tick()
  row = backend.withDb((db) => db.prepare('SELECT state,attempts,payload FROM jobs WHERE id=?').get(id))
  assert.equal(row.state, 'failed')
  assert.equal(Number(row.attempts), RETRY_MAX_ATTEMPTS)
  assert.equal(String(row.payload).includes('SECRET-JOB-BODY'), false, '终态失败必须脱敏')
  const payload = JSON.parse(row.payload)
  assert.equal(payload.runId, 7, '追溯键保留')
  assert.equal(payload.spoolPath, '/tmp/spool.bin')
  assert.equal(payload.materialHash, 'h')
})

test('sweepJobPayloads：脱敏终态、按 TTL 删超期终态，queued/running/可重试 failed 一概不动', (t) => {
  const backend = makeBackend(t)
  const now = 1_800_000_000
  const old = now - 30 * 86400
  const insert = (kind, state, attempts, payload, ts) => backend.withDb((db) => db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run(kind, state, attempts, payload, ts, ts).lastInsertRowid)

  const queued = insert('write', 'queued', 0, JSON.stringify({ text: 'SECRET-QUEUED' }), old)
  const running = insert('write', 'running', 0, JSON.stringify({ text: 'SECRET-RUNNING' }), old)
  const retryable = insert('write', 'failed', 1, JSON.stringify({ text: 'SECRET-RETRY' }), old)
  const doneOld = insert('write', 'done', 1, JSON.stringify({ text: 'SECRET-DONE', result: { action: 'ADD' } }), old)
  const failedOld = insert('write', 'failed', RETRY_MAX_ATTEMPTS, JSON.stringify({ text: 'SECRET-FAIL' }), old)
  const doneFresh = insert('import', 'done', 1, JSON.stringify({ jsonl: 'SECRET-JSONL', total: 3 }), now - 60)

  const out = sweepJobPayloads(backend.withDb((db) => db), { ttlDays: 7, nowSec: now })
  assert.equal(out.ttlDays, 7)
  assert.equal(out.purged, 2, '只有两条终态旧行被删（不做续跑证据的 queued/running/可重试 failed）')
  assert.ok(out.redacted >= 1)

  const payloadOf = (id) => backend.withDb((db) => {
    const row = db.prepare('SELECT state,payload,attempts FROM jobs WHERE id=?').get(id)
    return row ? { state: row.state, payload: row.payload, attempts: Number(row.attempts) } : null
  })
  assert.equal(payloadOf(queued).payload, JSON.stringify({ text: 'SECRET-QUEUED' }), 'queued 原样')
  assert.equal(payloadOf(running).payload, JSON.stringify({ text: 'SECRET-RUNNING' }), 'running 原样')
  assert.equal(payloadOf(retryable).payload, JSON.stringify({ text: 'SECRET-RETRY' }), '可重跑 failed 原样')
  assert.equal(payloadOf(doneOld), null, '超期终态 done 被删')
  assert.equal(payloadOf(failedOld), null, '超期终态 failed 被删')
  const fresh = payloadOf(doneFresh)
  assert.ok(fresh, '未超期的终态行保留')
  assert.equal(String(fresh.payload).includes('SECRET-JSONL'), false, 'import 的 jsonl 正文必须脱敏')

  // 再跑一次必须幂等（TTL 0 时只脱敏不删）。
  const again = sweepJobPayloads(backend.withDb((db) => db), { ttlDays: 0, nowSec: now })
  assert.equal(again.purged, 0)
})

test('maintenance handler 走 keeper：按 privacy.jobPayloadTtlDays 清理，故障时 job 失败可见', async (t) => {
  const backend = makeBackend(t)
  const now = Date.now() / 1000
  const old = now - 30 * 86400
  backend.withDb((db) => db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('report', 'done', 1, JSON.stringify({ text: 'SECRET-OLD' }), old, old))

  const seen = []
  const keeper = createKeeper({
    store: backend, config: { privacy: { jobPayloadTtlDays: 7 } }, log: (line) => seen.push(line), intervalMs: 3600_000,
  })
  t.after(() => keeper.dispose())
  keeper.enqueue('maintenance', {})
  await keeper.tick()
  assert.ok(seen.some((line) => line.includes('maintenance payload redacted=') && line.includes('purged=1')), '清理计数必须有日志')

  // 故障注入：配置读取抛错 → job 落 failed 且 last_error 可见（不得静默标 done）。
  const badConfig = {
    privacy: { get jobPayloadTtlDays() { throw new Error('cfg_boom') } },
  }
  const flaky = createKeeper({ store: backend, config: badConfig, log: (line) => seen.push(line), intervalMs: 3600_000 })
  t.after(() => flaky.dispose())
  const id = flaky.enqueue('maintenance', {})
  backend.withDb((db) => db.prepare('UPDATE jobs SET attempts=? WHERE id=?').run(RETRY_MAX_ATTEMPTS - 1, id))
  await flaky.tick()
  const row = backend.withDb((db) => db.prepare('SELECT state,attempts,last_error FROM jobs WHERE id=?').get(id))
  assert.equal(row.state, 'failed')
  assert.match(String(row.last_error), /cfg_boom/)
  assert.ok(seen.some((line) => line.includes('maintenance')),
    '失败必须留可见日志（keeper attempt 行）')
})
