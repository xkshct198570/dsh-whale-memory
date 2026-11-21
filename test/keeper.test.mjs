/**
 * Keeper 调度单测（架构书 §8.1）：状态机可测、单飞、启动补偿、水位闸门、默认 handlers。
 * 临时库 + 真 store 形状（{ withDb, dbFile }）+ 假 pressure + 可控时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../src/core/db.js'
import {
  JOB_KINDS, backoffSeconds, createKeeper, installKeeper,
} from '../src/core/keeper.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'

const BASE = 1_700_000_000 // 固定时钟起点（秒）

function fresh({ config = {}, pressure, log, intervalMs = 600_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-keeper-'))
  const db = openDb(dir)
  const dbFile = join(dir, 'memory.db')
  let clock = BASE
  const store = { dbFile, withDb: (fn) => fn(db) }
  const keeper = createKeeper({
    store, config,
    log: log || (() => {}),
    pressure: pressure || (() => ({ stress: false })),
    nowFn: () => clock,
    intervalMs,
  })
  return {
    dir, db, dbFile, store, keeper,
    advance(seconds) { clock += seconds },
    get clock() { return clock },
    close() { keeper.dispose(); closeDb(db) },
  }
}

let seq = 0
function node(db, { text, tags = [], status = 'active', expiredAt = null, updatedAt = now() }) {
  seq += 1
  const id = `k${Date.now()}_${seq}`
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,tags,context_note,weight,hits,
     vector_state,origin,trace_id,expired_at,created_at,updated_at)
    VALUES (?,?,?,?,'normal','semantic','owner',?,?, '',1,0,'none','test','',?,?,?)`).run(
    id, text, contentHash(text), bigrams(text), status, JSON.stringify(tags), expiredAt, updatedAt, updatedAt,
  )
  return id
}

const jobRow = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
const jobCount = (db, where = '1=1', ...args) => Number(db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${where}`).get(...args).n)

test('契约：JOB_KINDS 六种；backoffSeconds 0/60/300/1800', () => {
  assert.deepEqual(JOB_KINDS, ['consolidate', 'reflect', 'write', 'vector', 'archive', 'report'])
  assert.equal(backoffSeconds(0), 0)
  assert.equal(backoffSeconds(1), 60)
  assert.equal(backoffSeconds(2), 300)
  assert.equal(backoffSeconds(3), 1800)
  assert.equal(backoffSeconds(9), 1800)
})

test('queued → running → done；enqueue 校验 kind', async () => {
  const f = fresh()
  const calls = []
  f.keeper.register('write', async (payload, api) => {
    calls.push(payload)
    assert.equal(typeof api.now(), 'number')
    api.log('inside handler')
    return { ok: true }
  })
  try {
    const id = f.keeper.enqueue('write', { text: '甲' })
    assert.equal(typeof id, 'number')
    assert.equal(jobRow(f.db, id).state, 'queued')
    const r = await f.keeper.tick()
    assert.deepEqual(r, { ran: ['write'] })
    const row = jobRow(f.db, id)
    assert.equal(row.state, 'done')
    assert.equal(Number(row.attempts), 0)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { text: '甲' })
    assert.equal(jobRow(f.db, id).last_error, null)

    const status = f.keeper.status()
    assert.equal(status.running, 0)
    assert.equal(status.queued, 0)
    assert.equal(status.failed, 0)
    assert.equal(status.lastError, null)
    assert.deepEqual(Object.keys(status.jobs[0]).sort(),
      ['attempts', 'id', 'kind', 'last_error', 'next_at', 'state'])

    assert.throws(() => f.keeper.enqueue('bogus'), /unknown_kind/)
    assert.throws(() => f.keeper.register('write', () => {}), /duplicate_handler/)
  } finally { f.close() }
})

test('失败退避：第 1 次 +60，第 2 次 +300，未到期不跑', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('write', async () => { calls += 1; throw new Error('boom') })
  try {
    const id = f.keeper.enqueue('write', {})
    const r1 = await f.keeper.tick()
    assert.deepEqual(r1, { ran: ['write'] })
    let row = jobRow(f.db, id)
    assert.equal(row.state, 'queued')
    assert.equal(Number(row.attempts), 1)
    assert.equal(Number(row.next_at), f.clock + 60)
    assert.match(row.last_error, /boom/)
    assert.match(f.keeper.status().lastError, /write: boom/)

    f.advance(59)
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'no_job' })
    assert.equal(calls, 1, '未到 next_at 不得重跑')

    f.advance(1)
    await f.keeper.tick()
    row = jobRow(f.db, id)
    assert.equal(Number(row.attempts), 2)
    assert.equal(Number(row.next_at), f.clock + 300)
    assert.equal(calls, 2)
  } finally { f.close() }
})

test('3 次失败落 failed，不再自动跑', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('write', async () => { calls += 1; throw new Error('always') })
  try {
    const id = f.keeper.enqueue('write', {})
    await f.keeper.tick()
    f.advance(60)
    await f.keeper.tick()
    f.advance(300)
    await f.keeper.tick()
    const row = jobRow(f.db, id)
    assert.equal(row.state, 'failed')
    assert.equal(Number(row.attempts), 3)
    assert.equal(calls, 3)
    assert.equal(f.keeper.status().failed, 1)

    f.advance(10_000)
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'no_job' })
    assert.equal(calls, 3, 'failed 不得自动重跑')
  } finally { f.close() }
})

test('done 永不复跑（启动补偿也不碰）', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('reflect', async () => { calls += 1; return { ok: true } })
  try {
    const id = f.keeper.enqueue('reflect', {})
    await f.keeper.tick()
    assert.equal(jobRow(f.db, id).state, 'done')
    f.advance(86_400 * 30)
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'no_job' })
    assert.deepEqual(await f.keeper.drain({ max: 5 }), { ran: [], failed: 0 })
    assert.equal(calls, 1)
    assert.equal(jobCount(f.db, "state='done'"), 1)
  } finally { f.close() }
})

test('同 kind 单飞：已有 running 时 claim changes=0，跳过不再起一个', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('write', async () => { calls += 1; return { ok: true } })
  try {
    const first = f.keeper.enqueue('write', {})
    const second = f.keeper.enqueue('write', {})
    f.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(first)
    const r = await f.keeper.tick()
    assert.deepEqual(r, { ran: [], skipped: 'same_kind_running' })
    assert.equal(calls, 0)
    assert.equal(jobRow(f.db, second).state, 'queued')
    assert.equal(jobRow(f.db, second).last_error, null)

    // 把残留 running 收尾后，同 kind 才能继续（调度器不负责清理崩溃残留，见注释）。
    f.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(first)
    await f.keeper.tick()
    assert.equal(jobRow(f.db, second).state, 'done')
    assert.equal(calls, 1)
  } finally { f.close() }
})

test('全局并发=1：一个 job 跑着时第二个 tick 让路，两个 kind 只先跑一个', async () => {
  const f = fresh()
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  f.keeper.register('write', async () => { calls.push('write'); await gate; return { ok: true } })
  f.keeper.register('reflect', async () => { calls.push('reflect'); return { ok: true } })
  try {
    f.keeper.enqueue('write', {})
    f.keeper.enqueue('reflect', {})
    const p1 = f.keeper.tick()
    const second = await f.keeper.tick()
    assert.deepEqual(second, { ran: [], skipped: 'busy' })
    assert.deepEqual(calls, ['write'])
    release()
    assert.deepEqual(await p1, { ran: ['write'] })
    assert.equal(jobCount(f.db, "state='done'"), 1)
    assert.equal(jobCount(f.db, "state='queued'"), 1)

    const rest = await f.keeper.drain({ max: 5 })
    assert.deepEqual(rest, { ran: ['reflect'], failed: 0 })
    assert.deepEqual(calls, ['write', 'reflect'])
    assert.equal(jobCount(f.db, "state='done'"), 2)
  } finally { f.close() }
})

test('启动补偿：先 queued 到期，再 failed(attempts<3) 重置回 queued 跑', async () => {
  const f = fresh()
  const order = []
  f.keeper.register('reflect', async () => { order.push('reflect'); return { ok: true } })
  f.keeper.register('write', async () => { order.push('write'); return { ok: true } })
  try {
    const q = f.keeper.enqueue('reflect', {})
    const failedId = f.db.prepare(`INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at)
      VALUES ('write','failed',2,'{}',?,?)`).run(f.clock, f.clock).lastInsertRowid
    const r1 = await f.keeper.tick()
    assert.deepEqual(r1, { ran: ['reflect'] })
    assert.deepEqual(order, ['reflect'])
    assert.equal(jobRow(f.db, q).state, 'done')
    assert.equal(jobRow(f.db, failedId).state, 'failed', '本轮先轮不到 failed')

    const r2 = await f.keeper.tick()
    assert.deepEqual(r2, { ran: ['write'] })
    assert.deepEqual(order, ['reflect', 'write'])
    const compensated = jobRow(f.db, failedId)
    assert.equal(compensated.state, 'done')
    // 补偿是重置回 queued 再跑，不额外加 attempt
    assert.equal(Number(compensated.attempts), 2)
  } finally { f.close() }
})

test('水位闸门：stress → defer，next_at=+600，日志只打一次', async () => {
  const f = fresh()
  let stress = true
  let calls = 0
  const logs = []
  const keeper = createKeeper({
    store: f.store,
    config: {},
    log: (line) => logs.push(line),
    pressure: () => ({ stress, freeMB: 120, rssMB: 900 }),
    nowFn: () => f.clock,
    intervalMs: 600_000,
  })
  keeper.register('write', async () => { calls += 1; return { ok: true } })
  try {
    const id = keeper.enqueue('write', {})
    const r1 = await keeper.tick()
    assert.deepEqual(r1, { ran: [], deferred: 'memory_pressure' })
    assert.equal(calls, 0)
    let row = jobRow(f.db, id)
    assert.equal(row.state, 'queued')
    assert.equal(Number(row.next_at), f.clock + 600)
    assert.equal(logs.length, 1, '压力日志只打一次')

    f.advance(600)
    const r2 = await keeper.tick()
    assert.deepEqual(r2, { ran: [], deferred: 'memory_pressure' })
    assert.equal(logs.length, 1, '持续压力不刷屏')

    stress = false
    f.advance(600)
    assert.deepEqual(await keeper.tick(), { ran: ['write'] })
    assert.equal(calls, 1)
    assert.equal(jobRow(f.db, id).state, 'done')
  } finally { keeper.dispose(); f.close() }
})

test('dispose 后 tick 空转，job 留在队列', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('write', async () => { calls += 1; return { ok: true } })
  try {
    const id = f.keeper.enqueue('write', {})
    f.keeper.dispose()
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'disposed' })
    assert.deepEqual(await f.keeper.drain({ max: 3 }), { ran: [], failed: 0 })
    assert.equal(calls, 0)
    assert.equal(jobRow(f.db, id).state, 'queued')
  } finally { f.close() }
})

test('consolidate 默认 handler：真建 tag 边 + TTL 把 expired 节点置 stale', async () => {
  const f = fresh()
  try {
    const a = node(f.db, { text: '节点甲：网关端口', tags: ['端口'] })
    const b = node(f.db, { text: '节点乙：回调端口', tags: ['端口'] })
    const expired = node(f.db, { text: '过期节点', tags: ['端口'], expiredAt: f.clock - 10 })
    const alive = node(f.db, { text: '正常节点', tags: [], expiredAt: f.clock + 999 })

    const res = await f.keeper.runNow('consolidate', {})
    assert.equal(res.state, 'done')
    assert.ok(res.result.edges > 0, 'tag 共现必须建边')
    assert.ok(res.result.stale >= 1)

    const edgeCount = Number(f.db.prepare('SELECT count(*) AS n FROM edges').get().n)
    assert.ok(edgeCount > 0)
    const edge = f.db.prepare("SELECT * FROM edges WHERE etype='similar' AND source='tag' LIMIT 1").get()
    assert.ok(edge)
    assert.deepEqual([edge.from_id, edge.to_id].sort(), [a, b].sort())

    assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(expired).status, 'stale')
    assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(alive).status, 'active')
    assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(a).status, 'active')
  } finally { f.close() }
})

test('archive：retention 关 → skipped；开 → 物理删过期 archived 并写 ARCHIVE 审计', async () => {
  const off = fresh({ config: { privacy: { retentionDays: 0 } } })
  try {
    const old = node(off.db, { text: '已归档旧节点', status: 'archived', updatedAt: off.clock - 8 * 86400 })
    const res = await off.keeper.runNow('archive', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.skipped, 'retention_disabled')
    assert.ok(off.db.prepare('SELECT id FROM nodes WHERE id=?').get(old), '关闭时不得删')
  } finally { off.close() }

  const on = fresh({ config: { privacy: { retentionDays: 7 } } })
  try {
    const old = node(on.db, { text: '已归档旧节点', status: 'archived', updatedAt: on.clock - 8 * 86400 })
    const recent = node(on.db, { text: '刚归档节点', status: 'archived', updatedAt: on.clock - 86400 })
    const activeOld = node(on.db, { text: '老但还活着', status: 'active', updatedAt: on.clock - 30 * 86400 })
    const res = await on.keeper.runNow('archive', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.deleted, 1)
    assert.equal(on.db.prepare('SELECT id FROM nodes WHERE id=?').get(old), undefined)
    assert.ok(on.db.prepare('SELECT id FROM nodes WHERE id=?').get(recent))
    assert.ok(on.db.prepare('SELECT id FROM nodes WHERE id=?').get(activeOld), '只删 archived')
    const audit = on.db.prepare("SELECT * FROM writes WHERE action='ARCHIVE'").all()
    assert.equal(audit.length, 1)
    assert.match(audit[0].reason, /retention_days=7/)
  } finally { on.close() }
})

test('report：有 dbFile 写 reports/<日期>.md；无 dbFile 跳过', async () => {
  const f = fresh()
  try {
    node(f.db, { text: '日报样本节点', tags: ['日报'] })
    const res = await f.keeper.runNow('report', {})
    assert.equal(res.state, 'done')
    assert.ok(res.result.path.includes(`${join('reports')}`))
    assert.ok(existsSync(res.result.path))
    const body = readFileSync(res.result.path, 'utf8')
    assert.match(body, /记忆日报/)
    assert.match(body, /节点总数：1/)
    assert.match(body, /零注入不计/)
  } finally { f.close() }

  const dir = mkdtempSync(join(tmpdir(), 'whale-keeper-bare-'))
  const db = openDb(dir)
  let clock = BASE
  const keeper = createKeeper({
    store: { withDb: (fn) => fn(db) }, // 无 dbFile
    pressure: () => ({ stress: false }), nowFn: () => clock,
  })
  try {
    const res = await keeper.runNow('report', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.skipped, 'no_dbfile')
  } finally { keeper.dispose(); closeDb(db) }
})

test('vector：embed 关 → skipped；开但无实现 → skipped 不失败', async () => {
  const off = fresh({ config: { embed: { enabled: false } } })
  try {
    const id = node(off.db, { text: '待向量节点' })
    off.db.prepare("UPDATE nodes SET vector_state='pending' WHERE id=?").run(id)
    const res = await off.keeper.runNow('vector', {})
    assert.equal(res.result.skipped, 'embed_disabled')
  } finally { off.close() }

  const on = fresh({ config: { embed: { enabled: true } } })
  try {
    const id = node(on.db, { text: '待向量节点' })
    on.db.prepare("UPDATE nodes SET vector_state='pending' WHERE id=?").run(id)
    const res = await on.keeper.runNow('vector', {})
    assert.equal(res.state, 'done', '无嵌入实现不得算失败')
    assert.equal(res.result.skipped, 'embed_unavailable')
    assert.equal(on.db.prepare('SELECT vector_state FROM nodes WHERE id=?').get(id).vector_state, 'pending')
  } finally { on.close() }
})

test('installKeeper：默认 handlers 可用，ctx.effect 卸载即 dispose', async () => {
  const f = fresh()
  const effects = []
  const ctx = { effect: (fn, label) => { effects.push({ fn, label }); return {} } }
  const keeper = installKeeper(ctx, {
    store: f.store, config: {}, log: () => {},
    pressure: () => ({ stress: false }), nowFn: () => f.clock, intervalMs: 600_000,
  })
  try {
    assert.equal(effects.length, 1)
    assert.equal(effects[0].label, 'whale-memory: keeper')
    keeper.enqueue('write', {})
    // write 没有默认 handler → 失败可重试（visible，不静默）
    const r = await keeper.tick()
    assert.deepEqual(r, { ran: ['write'] })
    assert.equal(keeper.status().jobs[0].state, 'queued')
    assert.match(keeper.status().lastError, /no_handler/)

    const dispose = effects[0].fn()
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.deepEqual(await keeper.tick(), { ran: [], skipped: 'disposed' })
  } finally { f.close() }
})
