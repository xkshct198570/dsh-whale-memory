/**
 * S2 worker 隔离层测试。
 *
 * 验收点：
 *  - probe 期间主线程事件循环仍在 tick（证明同步 sqlite 没卡主线程）
 *  - 每个请求独立 id，回执后 pending 归零
 *  - dispose 幂等，在途请求 reject worker_disposed
 *  - 超时 → worker_timeout + 线程被替换 + 下一次调用自动可用
 *  - 单请求失败不带走整个线程
 *  - client.js 源码零 node:sqlite（主线程零 SQL）
 *  - search.js 未就绪时明确报 search_unavailable（就绪后由后续用例接管）
 *  - search.js + schema 都就绪时：动态 import 正常出结果
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DbWorkerClient } from '../../src/core/workers/client.js'

const CLIENT_SRC = new URL('../../src/core/workers/client.js', import.meta.url)
const SEARCH_URL = new URL('../../src/core/search.js', import.meta.url)
const SEARCH_READY = existsSync(SEARCH_URL)

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-worker-'))
  const dbPath = join(dir, 'nodes.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, active INTEGER)')
  db.exec("INSERT INTO nodes VALUES ('a', 1), ('b', 0), ('c', 1)")
  db.close()
  return { dir, dbPath }
}

test('probe：50ms 睡眠期间主线程仍能 tick（不阻塞事件循环）', async () => {
  const client = new DbWorkerClient()
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 5)
  try {
    const r = await client.probe(50)
    assert.ok(r.sleptMs >= 45, `worker 实际睡眠 ${r.sleptMs}ms`)
  } finally {
    clearInterval(timer)
    client.dispose()
  }
  assert.ok(ticks >= 1, `主线程在 probe 期间 tick=${ticks}，应 ≥1`)
  assert.equal(client.pendingCount, 0)
})

test('probe：正常返回（独立 id，pending 不泄漏）', async () => {
  const client = new DbWorkerClient()
  try {
    const [a, b] = await Promise.all([client.probe(10), client.probe(20)])
    assert.equal(a.op, 'probe')
    assert.ok(a.sleptMs >= 5 && a.sleptMs < 500, `a.sleptMs=${a.sleptMs}`)
    assert.ok(b.sleptMs >= 15 && b.sleptMs < 500, `b.sleptMs=${b.sleptMs}`)
    assert.equal(client.pendingCount, 0)
    assert.equal(client.alive, true)
  } finally {
    client.dispose()
  }
})

test('dispose：在途请求 reject worker_disposed，且幂等', async () => {
  const client = new DbWorkerClient()
  await client.probe(5)
  const inflight = client.probe(200)
  client.dispose()
  await assert.rejects(inflight, (err) => {
    assert.equal(err.code, 'worker_disposed')
    assert.equal(client.pendingCount, 0)
    return true
  })
  client.dispose() // 第二次调用不得抛错
  await assert.rejects(client.probe(1), { code: 'worker_disposed' })
  assert.equal(client.disposed, true)
  assert.equal(client.pendingCount, 0)
})

test('超时：worker_timeout + 线程重建后自动可用', async () => {
  const client = new DbWorkerClient({ timeoutMs: 100 })
  const first = client.probe(5)
  await first
  const before = client._worker
  await assert.rejects(client.probe(500), (err) => {
    assert.equal(err.code, 'worker_timeout')
    return true
  })
  assert.equal(client.pendingCount, 0, '超时后不得残留 pending')
  assert.ok(client._worker, '超时后应立即重建线程')
  assert.notEqual(client._worker, before, '超时后应是新的 Worker 实例')
  try {
    const r = await client.probe(10)
    assert.ok(r.sleptMs >= 5, `重建后 probe 生效：${r.sleptMs}ms`)
  } finally {
    client.dispose()
  }
})

test('stats：只读计数 nodes/active', async () => {
  const { dir, dbPath } = tempDb()
  const client = new DbWorkerClient()
  try {
    assert.deepEqual(await client.stats(dbPath), { nodes: 3, active: 2 })
    assert.equal(client.pendingCount, 0)
  } finally {
    client.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单请求失败（坏 dbPath）不带走线程：之后 probe 仍可用', async () => {
  const missing = join(tmpdir(), `whale-missing-${process.pid}-${Date.now()}.db`)
  const client = new DbWorkerClient({ timeoutMs: 3000 })
  try {
    await assert.rejects(client.stats(missing), (err) => {
      assert.equal(err.code, 'db_open_failed')
      return true
    })
    assert.equal(client.pendingCount, 0)
    const r = await client.probe(5)
    assert.ok(r.sleptMs >= 0)
    assert.equal(client.alive, true)
  } finally {
    client.dispose()
  }
})

test('主线程零 SQL：client.js 不 import node:sqlite', () => {
  // 头部注释会提到 node:sqlite（讲清为什么要隔离），所以只审实际代码。
  const code = readFileSync(CLIENT_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/node:sqlite/.test(code), false, 'client.js 不得 import node:sqlite')
  assert.equal(/\bnew\s+DatabaseSync\b/.test(code), false, 'client.js 不得直接开库')
  assert.match(code, /db-worker\.js/, 'client.js 必须把 SQL 交给 db-worker.js')
})

test('search：search.js 未就绪时报 search_unavailable，线程存活', { skip: SEARCH_READY ? 'search.js 已就绪，见下一条用例' : false }, async () => {
  const client = new DbWorkerClient()
  try {
    await assert.rejects(client.search({ dbPath: '/tmp/any.db', query: 'x', limit: 50 }), (err) => {
      assert.equal(err.code, 'search_unavailable')
      return true
    })
    const r = await client.probe(5)
    assert.ok(r.sleptMs >= 0)
    assert.equal(client.alive, true)
  } finally {
    client.dispose()
  }
})

test('search：动态 import search.js，只读库出结果（schema 就绪时）', { skip: SEARCH_READY ? false : 'src/core/search.js 尚未就绪（Agent-Core 提供）' }, async (t) => {
  const schemaUrl = [
    new URL('../../src/core/schema.js', import.meta.url),
    new URL('../../src/core/schema.mjs', import.meta.url),
  ].find((u) => existsSync(u))
  if (!schemaUrl) return t.skip('src/core/schema.js 尚未就绪，无法构造规范库')

  const dir = mkdtempSync(join(tmpdir(), 'whale-worker-search-'))
  const dbPath = join(dir, 'nodes.db')
  const db = new DatabaseSync(dbPath)
  let schemaOk = true
  try {
    const mod = await import(schemaUrl.href)
    const apply = mod.ensureSchema ?? mod.applySchema ?? mod.migrate ?? mod.migrateSchema ?? mod.initSchema ?? mod.createSchema
    if (typeof apply === 'function') apply(db)
    else if (typeof mod.SCHEMA === 'string') db.exec(mod.SCHEMA)
    else schemaOk = false
  } catch {
    schemaOk = false
  } finally {
    db.close()
  }
  if (!schemaOk) {
    rmSync(dir, { recursive: true, force: true })
    return t.skip('schema.js 未暴露可用的建表接口')
  }

  const client = new DbWorkerClient()
  try {
    const result = await client.search({ dbPath, query: '记忆', limit: 50, identity: { userId: 'u1', roleId: '', workspace: '' }, minRel: 0 })
    assert.ok(result === null || typeof result === 'object', `search 结果类型异常：${typeof result}`)
    assert.equal(client.pendingCount, 0)
    assert.equal(client.alive, true)
  } finally {
    client.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
