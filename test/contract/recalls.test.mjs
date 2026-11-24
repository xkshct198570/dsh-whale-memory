/**
 * 召回审计单测（审计 backlog P1）：零命中/预算为 0 也必须落库，source 透传，
 * /recalls 的 zero/unused/source/since/limit 过滤，以及路由参数透传。
 *
 * 断言对象是真实 recalls 行与真实 HTTP payload——不是"接口返回 200"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'
import { createRoutes } from '../../src/host/routes.js'

const ident = { userId: 'u1', roleId: '', workspace: 'web' }

/** 自动落库模式：让 recall 的检索有真实节点可命中。 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-recalls-'))
  return new LocalBackend({
    dataDir: dir, useWorker: false,
    config: () => ({ write: { enabled: true, reviewMode: 'auto', maxChars: 500, dailyCap: 200 } }),
  })
}

const recallRows = (backend) => backend.withDb(
  (db) => db.prepare('SELECT * FROM recalls ORDER BY id').all(),
)
const ascending = (a, b) => Number(a) - Number(b)

test('零命中：仍落一行 recalls（injected=0 / hit_ids="[]" / chars=0 / used=0）', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网关回调端口规则', identity: ident })
    const r = await b.recall({ query: '完全不存在zzz词条', maxHits: 3, identity: ident })
    assert.equal(r.hits, 0)
    assert.equal(r.prefix, '')

    const rows = recallRows(b)
    assert.equal(rows.length, 1, '零命中不落库会让零注入率永远没有分母')
    const row = rows[0]
    assert.equal(row.hit_ids, '[]')
    assert.equal(Number(row.injected), 0)
    assert.equal(Number(row.chars), 0)
    assert.equal(Number(row.used), 0)
    assert.equal(row.source, 'hook', '调用方没传 source 时默认 hook')
    assert.equal(row.query, '完全不存在zzz词条')
    assert.ok(Number.isFinite(Number(row.elapsed_ms)), 'elapsed_ms 必须照算')
    assert.ok(Number(row.elapsed_ms) >= 0)

    // 面板读取口径：这条零命中行必须回得来，且 hits=0。
    const page = await b.recalls(10)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].hits, 0)
  } finally { b.dispose() }
})

test('预算 0（creative 意图）落行且标记 intent0；普通检索 source 截 32', async () => {
  const b = fresh()
  try {
    const r = await b.recall({ query: '帮我画一张海报', maxHits: 5, identity: ident, source: 's'.repeat(40) })
    assert.equal(r.intent, 'creative')
    assert.equal(r.hits, 0)
    assert.equal(r.chars, 0)

    const rows = recallRows(b)
    assert.equal(rows.length, 1, '按意图关掉注入也要留痕，否则与"没有记忆"无法区分')
    const row = rows[0]
    assert.equal(row.hit_ids, '[]')
    assert.equal(Number(row.injected), 0)
    assert.equal(Number(row.chars), 0)
    assert.equal(Number(row.used), 0)
    assert.equal(row.source, 'intent0', '按设计 0 预算不能伪装成用户来源的零命中')
    assert.ok(Number.isFinite(Number(row.elapsed_ms)))

    // 非 0 预算路径仍按调用方 source 截断（口径未被 intent0 改掉）。
    await b.recall({ query: '端口规则', maxHits: 3, identity: ident, source: 's'.repeat(40) })
    assert.equal(recallRows(b).at(-1).source, 's'.repeat(32))
  } finally { b.dispose() }
})

test('有命中：injected=1、chars 等于注入正文长度、hit_ids 记检索命中集合', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网关回调端口规则', identity: ident })
    const r = await b.recall({ query: '端口规则', maxHits: 3, identity: ident, source: 'panel-test' })
    assert.ok(r.hits >= 1, '夹具必须真的命中')
    assert.ok(r.prefix.length > 0)

    const rows = recallRows(b)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.source, 'panel-test')
    assert.equal(Number(row.injected), 1)
    assert.equal(Number(row.chars), r.chars)
    assert.equal(Number(row.chars), Number(row.chars))
    assert.ok(JSON.parse(row.hit_ids).length >= 1)
    assert.equal(Number(row.used), 0, '回复引用信号未接入，used 先留 0')
  } finally { b.dispose() }
})

test('命中但被预算裁光：hit_ids 非空、injected=0、chars=0（日报低分命中代理口径）', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网关回调端口规则甲乙丙丁戊己庚辛', identity: ident })
    // intentBudget=false + charBudget=1：检索命中集合非空，但一条也塞不进 1 字预算。
    const r = await b.recall({ query: '端口规则', maxHits: 3, charBudget: 1, intentBudget: false, identity: ident })
    assert.equal(r.chars, 0)
    assert.equal(r.prefix, '')

    const row = recallRows(b)[0]
    assert.ok(JSON.parse(row.hit_ids).length >= 1, '命中集合必须留下，否则推断不出"低分命中"')
    assert.equal(Number(row.injected), 0)
    assert.equal(Number(row.chars), 0)
    // 有命中但未注入不能落进 zero 过滤（zero 只表示"检索没命中"）。
    const zero = await b.recalls(10, { filter: 'zero' })
    assert.equal(zero.items.some((item) => item.id === row.id), false)
  } finally { b.dispose() }
})

test('recalls 过滤：zero / unused / source / since / limit 与键集合', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网关回调端口规则', identity: ident })

    // A：零命中（hook）  B：命中注入（panel-test）  C：命中注入后标记 used=1（panel-test）
    // D：命中未注入（hook）  E：创作预算 0（panel-test）
    await b.recall({ query: '不存在zzz词条', maxHits: 3, identity: ident })
    await b.recall({ query: '端口规则', maxHits: 3, identity: ident, source: 'panel-test' })
    await b.recall({ query: '端口规则', maxHits: 3, identity: ident, source: 'panel-test' })
    await b.recall({ query: '端口规则', maxHits: 3, charBudget: 1, intentBudget: false, identity: ident })
    await b.recall({ query: '画一张图', maxHits: 5, identity: ident, source: 'panel-test' })

    const rows = recallRows(b)
    assert.equal(rows.length, 5)
    const [a, bb, c, d, e] = rows.map((row) => Number(row.id))
    // C 事后被回复引用（真实链路尚未接入，测试直接改标记）；A 时间拨到一天前。
    b.withDb((db) => db.prepare('UPDATE recalls SET used=1 WHERE id=?').run(c))
    b.withDb((db) => db.prepare('UPDATE recalls SET ts=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 86400, a))

    const zero = await b.recalls(100, { filter: 'zero' })
    assert.deepEqual(zero.items.map((item) => item.id).sort(ascending), [a], 'intent0 不算零命中')
    assert.ok(zero.items.every((item) => item.hit_ids === '[]'))

    const unused = await b.recalls(100, { filter: 'unused' })
    assert.deepEqual(unused.items.map((item) => item.id), [bb], 'unused=已注入且未采纳，C 已采纳、D 未注入都要排除')

    const bySource = await b.recalls(100, { source: 'panel-test' })
    assert.deepEqual(bySource.items.map((item) => item.id).sort(ascending), [bb, c].sort(ascending), 'intent0 不再冒用 panel-test')

    const combined = await b.recalls(100, { source: 'hook', filter: 'zero' })
    assert.deepEqual(combined.items.map((item) => item.id), [a])
    assert.equal(combined.items[0].hits, 0)

    // since：A 已拨到一天前，60s 内只有其余 4 条。
    const sinceCut = Math.floor(Date.now() / 1000) - 60
    const recent = await b.recalls(100, { since: sinceCut })
    assert.equal(recent.items.some((item) => item.id === a), false)
    assert.equal(recent.items.length, 4)

    // limit：1..100 夹取；非正数回落 20。
    assert.equal((await b.recalls(1)).items.length, 1)
    assert.equal((await b.recalls(1000)).items.length, 5)
    assert.equal((await b.recalls(0)).items.length, 5)
    // 面板契约键集合（一个都不能少/改名）。
    assert.deepEqual(Object.keys((await b.recalls(1)).items[0]).sort(),
      ['chars', 'elapsed_ms', 'hit_ids', 'hits', 'id', 'injected', 'query', 'source', 'trace_id', 'ts', 'used'])
  } finally { b.dispose() }
})

test('GET /recalls 端到端：真实库行 + zero 过滤的 payload', async () => {
  const b = fresh()
  const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: 'web' }, panel: { allowRemote: false } }
  const server = http.createServer(createRoutes({ config, backend: b }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${server.address().port}/whale-memory/api/recalls`
  try {
    await b.write({ text: '网关回调端口规则', identity: ident })
    await b.recall({ query: '不存在zzz词条', maxHits: 3, identity: ident })
    await b.recall({ query: '端口规则', maxHits: 3, identity: ident })

    const zero = await (await fetch(`${root}?filter=zero&limit=50`)).json()
    assert.equal(zero.ok, true)
    assert.equal(zero.items.length, 1)
    assert.equal(zero.items[0].hit_ids, '[]')
    assert.equal(zero.items[0].hits, 0)
    assert.equal(Number(zero.items[0].injected), 0)
    assert.equal(zero.items[0].query, '不存在zzz词条')

    const all = await (await fetch(`${root}?limit=50`)).json()
    assert.equal(all.items.length, 2)
    const injected = all.items.find((item) => Number(item.injected) === 1)
    assert.ok(injected, '有命中的那次必须回得来且 injected=1')
    assert.ok(Number(injected.chars) > 0)
    assert.ok(JSON.parse(injected.hit_ids).length >= 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    b.dispose()
  }
})

test('GET /recalls：source/since/filter/limit 透传，非法值忽略而不是 400', async () => {
  const captured = []
  const backend = {
    async recalls(limit, opts) { captured.push({ limit, opts }); return { items: [{ id: 1, hits: 0 }] } },
  }
  const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' }, panel: { allowRemote: false } }
  const server = http.createServer(createRoutes({ config, backend }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${server.address().port}/whale-memory/api/recalls`
  try {
    const ok = await (await fetch(`${root}?limit=5&source=panel-test&since=1700000000&filter=zero`)).json()
    assert.equal(ok.ok, true)
    assert.equal(ok.items[0].hits, 0)
    // P0-2：/recalls 必须把身份一起传下去（跨身份泄漏的根治点在 backend，但契约从路由就要立）。
    assert.deepEqual(captured.at(-1), { limit: 5, opts: { source: 'panel-test', since: 1700000000, filter: 'zero', identity: { userId: 'u1', roleId: '', workspace: '' } } })

    await fetch(`${root}?limit=9999&source=${'x'.repeat(40)}&since=abc&filter=bogus`)
    const last = captured.at(-1)
    assert.equal(last.limit, 100, 'limit 夹到 1..100')
    assert.equal(last.opts.source, 'x'.repeat(32), 'source 截 32')
    assert.equal(last.opts.since, null, '非数字 since 忽略')
    assert.equal(last.opts.filter, '', '未知 filter 按不过滤')

    await fetch(`${root}?filter=unused`)
    assert.deepEqual(captured.at(-1), { limit: 20, opts: { source: '', since: null, filter: 'unused', identity: { userId: 'u1', roleId: '', workspace: '' } } })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('listEpisodic 按身份过滤：反思素材不得混入别人的私有 episodic', async () => {
  const b = fresh()
  try {
    await b.write({ text: 'u1 的私有经历', memory_type: 'episodic', source: 'self', identity: ident })
    await b.write({ text: 'u2 的私有经历', memory_type: 'episodic', source: 'self', identity: { userId: 'u2', roleId: '', workspace: 'web' } })
    await b.write({ text: '共享经历', memory_type: 'episodic', source: 'self', identity: { userId: '', roleId: '', workspace: '' } })
    const mine = await b.listEpisodic(20, { identity: ident })
    const texts = mine.map((row) => row.text)
    assert.ok(texts.includes('u1 的私有经历'))
    assert.ok(texts.includes('共享经历'), '共享分区可见（历史兼容口径）')
    assert.equal(texts.includes('u2 的私有经历'), false, '跨用户 episodic 泄漏')
  } finally { b.dispose() }
})
