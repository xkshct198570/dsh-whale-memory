/**
 * Keeper 调度单测（架构书 §8.1）：状态机可测、单飞、启动补偿、水位闸门、默认 handlers。
 * 临时库 + 真 store 形状（{ withDb, dbFile }）+ 假 pressure + 可控时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../../src/core/db.js'
import {
  JOB_KINDS, archiveScope, backoffSeconds, convergeDuplicateHashes, createKeeper, installKeeper,
} from '../../src/core/keeper.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { Config } from '../../src/host/config.js'

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
function node(db, {
  text, tags = [], status = 'active', expiredAt = null, updatedAt = now(),
  source = 'owner', userId = '', roleId = '', workspace = '', origin = 'test',
}) {
  seq += 1
  const id = `k${Date.now()}_${seq}`
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,hits,vector_state,origin,trace_id,expired_at,created_at,updated_at)
    VALUES (?,?,?,?,'normal','semantic',?,?,?,?,?,?, '',1,0,'none',?,'',?,?,?)`).run(
    id, text, contentHash(text), bigrams(text), source, status, roleId, userId, workspace,
    JSON.stringify(tags), origin, expiredAt, updatedAt, updatedAt,
  )
  return id
}

const jobRow = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
const jobCount = (db, where = '1=1', ...args) => Number(db.prepare(`SELECT count(*) AS n FROM jobs WHERE ${where}`).get(...args).n)

test('契约：JOB_KINDS 八种（含 import/wrap）；backoffSeconds 0/60/300/1800', () => {
  assert.deepEqual(JOB_KINDS, ['consolidate', 'reflect', 'write', 'vector', 'archive', 'report', 'import', 'wrap'])
  assert.equal(backoffSeconds(0), 0)
  assert.equal(backoffSeconds(1), 60)
  assert.equal(backoffSeconds(2), 300)
  // §8.1 退避 1m→5m→30m：第三次失败必须是 1800（旧表 [0,60,300] 靠 if 旁路，数组本身没有 30m）
  assert.equal(backoffSeconds(3), 1800)
  assert.equal(backoffSeconds(4), 1800, '退避表末尾即封顶，不再增长')
  assert.equal(backoffSeconds(9), 1800)
  // 脏输入（负/NaN/小数）不制造负退避
  assert.equal(backoffSeconds(-2), 0)
  assert.equal(backoffSeconds(NaN), 0)
  assert.equal(backoffSeconds(1.9), 60)
})

test('queued → running → done；enqueue 校验 kind', async () => {
  const f = fresh()
  const calls = []
  f.keeper.register('import', async (payload, api) => {
    calls.push(payload)
    assert.equal(typeof api.now(), 'number')
    api.log('inside handler')
    return { ok: true }
  })
  try {
    const id = f.keeper.enqueue('import', { text: '甲' })
    assert.equal(typeof id, 'number')
    assert.equal(jobRow(f.db, id).state, 'queued')
    const r = await f.keeper.tick()
    assert.deepEqual(r, { ran: ['import'] })
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
    assert.throws(() => f.keeper.register('import', () => {}), /duplicate_handler/)
  } finally { f.close() }
})

test('失败退避：第 1 次 +60，第 2 次 +300，未到期不跑', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('import', async () => { calls += 1; throw new Error('boom') })
  try {
    const id = f.keeper.enqueue('import', {})
    const r1 = await f.keeper.tick()
    assert.deepEqual(r1, { ran: ['import'] })
    let row = jobRow(f.db, id)
    assert.equal(row.state, 'queued')
    assert.equal(Number(row.attempts), 1)
    assert.equal(Number(row.next_at), f.clock + 60)
    assert.match(row.last_error, /boom/)
    assert.match(f.keeper.status().lastError, /import: boom/)

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

// 契约变更（2026-11-22，审计 A8 / §8.1 1m→5m→30m）：上限 3 → 4。
// 旧契约「第 3 次失败即 failed」让退避表里的 1800s(30m) 永远走不到（requeue 只到 300s），
// 30m 成了配置里的假档位；改成"前三次按 60/300/1800 重排、第 4 次失败落 failed"后，
// 退避表与调度路径一致。下面的断言逐档核对 next_at，防止只改常量不落地。
test('4 次失败落 failed：前三次按 60/300/1800 重排（§8.1 1m→5m→30m）', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('import', async () => { calls += 1; throw new Error('always') })
  try {
    const id = f.keeper.enqueue('import', {})
    await f.keeper.tick()
    let row = jobRow(f.db, id)
    assert.equal(row.state, 'queued')
    assert.equal(Number(row.attempts), 1)
    assert.equal(Number(row.next_at), f.clock + 60)

    f.advance(60)
    await f.keeper.tick()
    row = jobRow(f.db, id)
    assert.equal(Number(row.attempts), 2)
    assert.equal(Number(row.next_at), f.clock + 300)

    f.advance(300)
    await f.keeper.tick()
    row = jobRow(f.db, id)
    assert.equal(row.state, 'queued', '第 3 次失败仍要重排（旧上限 3 会直接 failed）')
    assert.equal(Number(row.attempts), 3)
    assert.equal(Number(row.next_at), f.clock + 1800, '第 3 次退避必须是 30m')

    f.advance(1799)
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'no_job' }, '30m 未到不得重跑')
    f.advance(1)
    await f.keeper.tick()
    row = jobRow(f.db, id)
    assert.equal(row.state, 'failed')
    assert.equal(Number(row.attempts), 4)
    assert.equal(calls, 4)
    assert.equal(f.keeper.status().failed, 1)

    f.advance(10_000)
    assert.deepEqual(await f.keeper.tick(), { ran: [], skipped: 'no_job' })
    assert.equal(calls, 4, 'failed 不得自动重跑')
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
  f.keeper.register('import', async () => { calls += 1; return { ok: true } })
  try {
    const first = f.keeper.enqueue('import', {})
    const second = f.keeper.enqueue('import', {})
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
  f.keeper.register('import', async () => { calls.push('import'); await gate; return { ok: true } })
  f.keeper.register('reflect', async () => { calls.push('reflect'); return { ok: true } })
  try {
    f.keeper.enqueue('import', {})
    f.keeper.enqueue('reflect', {})
    const p1 = f.keeper.tick()
    const second = await f.keeper.tick()
    assert.deepEqual(second, { ran: [], skipped: 'busy' })
    assert.deepEqual(calls, ['import'])
    release()
    assert.deepEqual(await p1, { ran: ['import'] })
    assert.equal(jobCount(f.db, "state='done'"), 1)
    assert.equal(jobCount(f.db, "state='queued'"), 1)

    const rest = await f.keeper.drain({ max: 5 })
    assert.deepEqual(rest, { ran: ['reflect'], failed: 0 })
    assert.deepEqual(calls, ['import', 'reflect'])
    assert.equal(jobCount(f.db, "state='done'"), 2)
  } finally { f.close() }
})

test('启动补偿：先 queued 到期，再 failed(attempts<4) 重置回 queued 跑', async () => {
  const f = fresh()
  const order = []
  f.keeper.register('reflect', async () => { order.push('reflect'); return { ok: true } })
  f.keeper.register('import', async () => { order.push('import'); return { ok: true } })
  try {
    const q = f.keeper.enqueue('reflect', {})
    const failedId = f.db.prepare(`INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at)
      VALUES ('import','failed',2,'{}',?,?)`).run(f.clock, f.clock).lastInsertRowid
    const r1 = await f.keeper.tick()
    assert.deepEqual(r1, { ran: ['reflect'] })
    assert.deepEqual(order, ['reflect'])
    assert.equal(jobRow(f.db, q).state, 'done')
    assert.equal(jobRow(f.db, failedId).state, 'failed', '本轮先轮不到 failed')

    const r2 = await f.keeper.tick()
    assert.deepEqual(r2, { ran: ['import'] })
    assert.deepEqual(order, ['reflect', 'import'])
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
  keeper.register('import', async () => { calls += 1; return { ok: true } })
  try {
    const id = keeper.enqueue('import', {})
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
    assert.deepEqual(await keeper.tick(), { ran: ['import'] })
    assert.equal(calls, 1)
    assert.equal(jobRow(f.db, id).state, 'done')
  } finally { keeper.dispose(); f.close() }
})

test('dispose 后 tick 空转，job 留在队列', async () => {
  const f = fresh()
  let calls = 0
  f.keeper.register('import', async () => { calls += 1; return { ok: true } })
  try {
    const id = f.keeper.enqueue('import', {})
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

test('consolidate：同身份同 tag 小群体生成 topic 边（conf 0.6），跨 workspace 不连', async () => {
  const f = fresh()
  try {
    const a = node(f.db, { text: '主题甲：端口规则', tags: ['端口'] })
    const b = node(f.db, { text: '主题乙：端口变更', tags: ['端口'] })
    const other = node(f.db, { text: 'QQ端主题：端口规则', tags: ['端口'], workspace: 'qq' })

    const res = await f.keeper.runNow('consolidate', {})
    assert.equal(res.state, 'done')
    assert.ok(res.result.topic_edges >= 1, `topic_edges=${res.result.topic_edges}`)

    const same = f.db.prepare(`SELECT conf FROM edges WHERE etype='topic'
      AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`).get(a, b, b, a)
    assert.ok(same, '同身份同 tag 的节点之间必须有 topic 边')
    assert.equal(Number(same.conf), 0.6)
    assert.equal(f.db.prepare('SELECT source FROM edges WHERE etype=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
      .get('topic', a, b, b, a).source, 'reflect')

    // 跨隔离面：rebuild 的 similar 边可以存在，但 topic 边绝不能连过去（扩散会串记忆）。
    const cross = f.db.prepare(`SELECT 1 FROM edges WHERE etype='topic'
      AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`).get(a, other, other, a)
    assert.equal(cross, undefined)
  } finally { f.close() }
})

test('consolidate：共享 ≥2 个 tag → topic conf 0.8', async () => {
  const f = fresh()
  try {
    const a = node(f.db, { text: '双标签甲：端口 网关', tags: ['端口', '网关'] })
    const b = node(f.db, { text: '双标签乙：端口 网关', tags: ['端口', '网关'] })
    const res = await f.keeper.runNow('consolidate', {})
    assert.equal(res.state, 'done')
    const edge = f.db.prepare(`SELECT conf FROM edges WHERE etype='topic'
      AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`).get(a, b, b, a)
    assert.ok(edge)
    assert.equal(Number(edge.conf), 0.8)
  } finally { f.close() }
})

test('consolidate：同身份 text_hash 重复收敛（保 owner，其余 archived + 审计）', async () => {
  const f = fresh()
  try {
    // 构造旧库现场：v4 唯一索引会阻止新写重复行；consolidate 是给“索引建立前遗留脏库”的收敛器。
    f.db.exec('DROP INDEX IF EXISTS idx_nodes_active_hash')
    const text = '同文重复：网关端口 3982'
    const web = node(f.db, { text, source: 'web' })
    const owner = node(f.db, { text, source: 'owner' })
    const selfNode = node(f.db, { text, source: 'self' })

    const res = await f.keeper.runNow('consolidate', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.merged, 2, '3 条同文收敛掉 2 条')

    const active = f.db.prepare(`SELECT id, source FROM nodes WHERE status='active' AND text_hash=?
      ORDER BY id`).all(contentHash(text))
    assert.equal(active.length, 1)
    assert.equal(active[0].id, owner, '必须保留来源等级最高的 owner')
    assert.equal(active[0].source, 'owner')

    const archived = f.db.prepare(`SELECT id FROM nodes WHERE status='archived' AND text_hash=? ORDER BY id`)
      .all(contentHash(text))
    assert.deepEqual(archived.map((r) => r.id).sort(), [web, selfNode].sort())

    const audit = f.db.prepare("SELECT node_id FROM writes WHERE action='CONSOLIDATE' AND reason='dedupe_hash'").all()
    assert.equal(audit.length, 2, '每条被归档节点都要留审计')
    assert.deepEqual(audit.map((r) => r.node_id).sort(), [web, selfNode].sort())
  } finally { f.close() }
})

test('consolidate：跨身份同文不收敛（分区隔离优先于去重）', async () => {
  const f = fresh()
  try {
    const mine = node(f.db, { text: '同文但不同人：端口规则', userId: 'u1' })
    const other = node(f.db, { text: '同文但不同人：端口规则', userId: 'u2' })
    const res = await f.keeper.runNow('consolidate', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.merged, 0)
    assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(mine).status, 'active')
    assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(other).status, 'active')
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

  const on = fresh({ config: { privacy: { retentionDays: 7 }, identity: { userId: 'u9' } } })
  try {
    const old = node(on.db, { text: '已归档旧节点', status: 'archived', updatedAt: on.clock - 8 * 86400, userId: 'u9' })
    const recent = node(on.db, { text: '刚归档节点', status: 'archived', updatedAt: on.clock - 86400, userId: 'u9' })
    const activeOld = node(on.db, { text: '老但还活着', status: 'active', updatedAt: on.clock - 30 * 86400, userId: 'u9' })
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

test('archive 分区不可判定（auto + 空 userId）→ skipped，绝不退化成全库物理删除', async () => {
  // 审计 P1-F1 反例：旧实现三字段全空 → archiveScope(scope=all)，跨身份物理删 archived 行。
  const f = fresh({ config: { privacy: { retentionDays: 1 } } })
  try {
    const mine = node(f.db, { text: '甲区过期归档', status: 'archived', updatedAt: f.clock - 2 * 86400, userId: 'alice' })
    const other = node(f.db, { text: '乙区过期归档', status: 'archived', updatedAt: f.clock - 2 * 86400, userId: 'bob' })
    const res = await f.keeper.runNow('archive', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.skipped, 'identity_auto_unsafe')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(mine), '不可判定时不得删任何人')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(other))
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM writes WHERE action='ARCHIVE'").get().n, 0)
  } finally { f.close() }
})

test('archive retention=0（真实 Config 默认值）→ skipped，归档一条都不删', async () => {
  const f = fresh({ config: Config({}) })
  try {
    const old = node(f.db, { text: '已归档很久的节点', status: 'archived', updatedAt: f.clock - 400 * 86400 })
    const res = await f.keeper.runNow('archive', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.skipped, 'retention_disabled')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old), '0 = 永不自动清理')
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM writes WHERE action='ARCHIVE'").get().n, 0)
    // 分区条件本身是纯函数：不给身份 = 全局清理（每日定时入队的旧行为）。
    assert.deepEqual(archiveScope(null), { sql: '', params: [], note: '; scope=all' })
    assert.deepEqual(archiveScope({ userId: '', roleId: '', workspace: '' }), { sql: '', params: [], note: '; scope=all' })
    // 共享('')内容不参与"某分区的保留策略"，只有严格相等才进条件。
    assert.deepEqual(
      archiveScope({ userId: 'user-a', roleId: '', workspace: 'web' }),
      { sql: ' AND user_id = ? AND workspace = ?', params: ['user-a', 'web'], note: '; scope=user-a/web' },
    )
  } finally { f.close() }
})

test('archive retention=1 天：按 updated_at 删过期归档，且只删自己分区（他区/共享不动）', async () => {
  // 真实 Config：privacy.retentionDays=1 + identity.userId 是 volatile Ref（必须解包成 user-a）。
  const f = fresh({ config: Config({ privacy: { retentionDays: 1 }, identity: { userId: 'user-a' } }) })
  try {
    const twoDays = 2 * 86400
    const mineOld = node(f.db, { text: '甲区过期归档', status: 'archived', updatedAt: f.clock - twoDays, userId: 'user-a' })
    const mineFresh = node(f.db, { text: '甲区刚归档', status: 'archived', updatedAt: f.clock - 3600, userId: 'user-a' })
    const mineActive = node(f.db, { text: '甲区很老但还活着', status: 'active', updatedAt: f.clock - 30 * 86400, userId: 'user-a' })
    const otherOld = node(f.db, { text: '乙区过期归档', status: 'archived', updatedAt: f.clock - twoDays, userId: 'user-b' })
    const sharedOld = node(f.db, { text: '共享过期归档', status: 'archived', updatedAt: f.clock - twoDays })

    // 定时入队传的是 {}：分区来自 config.identity（解包后 user-a），不是全局清理。
    const res = await f.keeper.runNow('archive', {})
    assert.equal(res.state, 'done')
    assert.equal(res.result.days, 1)
    assert.equal(res.result.deleted, 1)
    assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(mineOld), undefined, '1 天前归档的本区节点必须物理删')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(mineFresh), '未过期（<1 天）不得删')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(mineActive), '只删 archived（active 再老也不删）')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(otherOld), '他区过期归档不得被本区保留策略删掉')
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(sharedOld), '共享内容不属于任何分区，保守不删')
    const audit = f.db.prepare("SELECT action,reason,mode FROM writes WHERE action='ARCHIVE'").all()
    assert.equal(audit.length, 1)
    assert.match(audit[0].reason, /retention_days=1/)
    assert.match(audit[0].reason, /deleted=1/)
    assert.match(audit[0].reason, /scope=user-a/, '审计要能看出这次清理落在哪个分区')
    assert.equal(audit[0].mode, 'auto')

    // payload.identity 可显式改口径：清 user-b 的分区时只动乙区那条（本区那条早已删掉）。
    const resB = await f.keeper.runNow('archive', { identity: { userId: 'user-b', roleId: '', workspace: '' } })
    assert.equal(resB.result.deleted, 1)
    assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(otherOld), undefined)
    assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(sharedOld), '共享内容任何分区口径下都不删')
    assert.match(f.db.prepare("SELECT reason FROM writes WHERE action='ARCHIVE' ORDER BY id DESC LIMIT 1").get().reason, /scope=user-b/)
  } finally { f.close() }
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
    // 日报新增：指标表（十一项）与 metrics 表落行。
    assert.match(body, /## 指标（架构书 §9\.1，十一项）/)
    assert.match(body, /## 命中但未注入 Top10/)
    assert.match(body, /## 未采纳 Top10/)
    assert.match(body, /## 近 24h 失败 job/)
    assert.ok(Number(f.db.prepare('SELECT count(*) AS n FROM metrics').get().n) > 0, '日报必须把当天指标写进 metrics 表')
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

test('report：命中未注入/未采纳/失败 job 三段与指标落表（手算值）', async () => {
  const f = fresh()
  try {
    node(f.db, { text: '日报指标样本节点' })
    const ts = f.clock
    const recallRow = (d) => f.db.prepare(`INSERT INTO recalls
      (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.ts, '', d.query, d.hitIds ?? '[]', d.chars ?? 0, d.injected ?? 0, d.used ?? 0, 5, '', '', '', 'hook',
    )
    const jobInsert = (d) => f.db.prepare(`INSERT INTO jobs
      (kind,state,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(d.kind, d.state, d.attempts ?? 0, d.lastError ?? null, d.ts, d.ts)

    // 近 24h：同一查询两次"命中未注入"；一条已注入未采纳；一条已注入已采纳（必须出表）；
    // 一条零命中（只进零注入率，不进 Top10）。
    recallRow({ ts: ts - 3600, query: '低分命中规则', hitIds: '["n1"]', injected: 0 })
    recallRow({ ts: ts - 3500, query: '低分命中规则', hitIds: '["n1"]', injected: 0 })
    recallRow({ ts: ts - 3400, query: '已注入未采纳', hitIds: '["n2"]', injected: 1, chars: 20 })
    recallRow({ ts: ts - 3300, query: '已注入已采纳', hitIds: '["n3"]', injected: 1, chars: 20, used: 1 })
    recallRow({ ts: ts - 3200, query: '零命中查询', hitIds: '[]', injected: 0 })
    jobInsert({ kind: 'reflect', state: 'failed', attempts: 3, lastError: 'boom_boom', ts: ts - 600 })
    jobInsert({ kind: 'consolidate', state: 'done', ts: ts - 1200 })
    f.db.prepare(`INSERT INTO writes (ts,trace_id,action,reason,mode,user_id,role_id,workspace)
      VALUES (?,?,'REJECT','privacy','auto','','','')`).run(ts - 100, '')
    f.db.prepare(`INSERT INTO writes (ts,trace_id,action,reason,mode,user_id,role_id,workspace)
      VALUES (?,?,'ADD','new','auto','','','')`).run(ts - 200, '')

    const res = await f.keeper.runNow('report', {})
    assert.equal(res.state, 'done')
    assert.match(res.result.metrics_day, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(res.result.metrics_day, res.result.path.split(/[\\/]/).pop().replace(/\.md$/, ''))

    const body = readFileSync(res.result.path, 'utf8')
    // 指标表十一项标签齐全；无评测数据 → 评测两项显示「未接入」而不是 0。
    for (const label of ['precision@3', '识别命中率', '零注入率', '采纳率', '空转率', '注入字数均值', '待向量最长滞留', '作业成功率', '写入拒绝率', 'FTS 对齐', '库体积']) {
      assert.ok(body.includes(label), `指标表缺 ${label}`)
    }
    assert.match(body, /未接入/)
    assert.match(body, /## 命中但未注入 Top10/)
    assert.match(body, /schema v3/)
    assert.match(body, /低分命中规则/)
    assert.match(body, /## 未采纳 Top10/)
    assert.match(body, /已注入未采纳/)
    assert.doesNotMatch(body, /已注入已采纳/, '已采纳的查询不进未采纳表')
    assert.match(body, /## 近 24h 失败 job/)
    assert.match(body, /reflect/)
    assert.match(body, /boom_boom/)

    // metrics 表：当天数字型指标全落（评测两项 null 不落、fts_aligned 布尔不落）。
    const rows = f.db.prepare('SELECT name, value FROM metrics WHERE day = ?').all(res.result.metrics_day)
    const byName = new Map(rows.map((row) => [row.name, Number(row.value)]))
    assert.equal(byName.has('fts_aligned'), false)
    assert.equal(byName.get('zero_injection_rate'), 0.2) // 1 次零命中 / 5 次召回
    assert.equal(byName.get('adoption_rate'), 0.5) // 1 采纳 / 2 注入
    assert.equal(byName.get('idle_rate'), 0.5)
    assert.equal(byName.get('inject_chars_avg'), 20) // (20 + 20) / 2
    assert.equal(byName.get('job_success_7d'), 0.5) // done 1 / (1+1)
    assert.equal(byName.get('write_reject_rate'), 0.5) // REJECT 1 / 2
    assert.equal(byName.get('pending_age_max_min'), 0)
    assert.ok(byName.get('db_size_bytes') > 0)
    assert.equal(rows.length, 8)
  } finally { f.close() }
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
    // write 由写队列独占，keeper 不得入队/接管
    assert.throws(() => keeper.enqueue('write', {}), /reserved_kind/)
    // 未注册的 kind → 失败可重试（visible，不静默）
    keeper.enqueue('reflect', {})
    const r = await keeper.tick()
    assert.deepEqual(r, { ran: ['reflect'] })
    assert.equal(keeper.status().jobs[0].state, 'queued')
    assert.match(keeper.status().lastError, /no_handler/)

    const dispose = effects[0].fn()
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.deepEqual(await keeper.tick(), { ran: [], skipped: 'disposed' })
  } finally { f.close() }
})


test('巩固去重不归档规则镜像：用户同文事实不得被 mirror 挤掉', (t) => {
  const f = fresh()
  t.after(() => f.close())
  const user = node(f.db, { text: '删除 AI 报告前先提炼结论', source: 'self' })
  const mirror = node(f.db, { text: '删除 AI 报告前先提炼结论', source: 'owner', origin: 'rule:iron-rule-17' })
  const out = convergeDuplicateHashes(f.db, { nowSec: f.clock })
  assert.equal(out.merged, 0, 'mirror 参与去重会误归档用户事实')
  assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(user).status, 'active')
  assert.equal(f.db.prepare('SELECT status FROM nodes WHERE id=?').get(mirror).status, 'active')
})
