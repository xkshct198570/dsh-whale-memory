/**
 * S4 四盲区收口断言（架构书 §9.4 / 计划书 §9.4）。
 *
 * 这里把"换到别的会话也成立"的四条判据钉在真实 LocalBackend + 临时库上：
 *  ① 跨端隔离：workspace='' 与 'web' 命中集合不同、写入不互见；
 *  ② 搜索反哺：开关开 → 摘要落 episodic（TTL/Source/Tag），到期被巩固 job 降 stale；
 *  ③ context_note：连续回填永不破 200（正文/tags 不动）；
 *  ④ 后台闸门：压力态 job 回 queued 且延后 10min（OOM 盲区的最小可测单元）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../src/core/backend.js'
import { createKeeper } from '../src/core/keeper.js'
import { installSearchFeed } from '../src/host/search-feed.js'
import { NOTE_MAX } from '../src/core/relations.js'

function fresh(config) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-blind-'))
  const backend = new LocalBackend({ dataDir: dir, useWorker: false, config: () => config })
  return { backend, dir, config }
}

const autoWrite = { write: { enabled: true, reviewMode: 'auto', maxChars: 500, dailyCap: 200 } }

test('盲区①：workspace 隔离——同一查询命中集合不同，写入不互见', async () => {
  const { backend } = fresh({ ...autoWrite, identity: { mode: 'fixed', userId: 'u9', roleId: '', workspace: 'web' } })
  try {
    const web = { userId: 'u9', roleId: '', workspace: 'web' }
    const qq = { userId: 'u9', roleId: '', workspace: 'qq' }
    await backend.write({ text: '网页端专属：面板开关要重启', identity: web, tags: ['面板'] })
    await backend.write({ text: 'QQ端专属：夜间网关停机', identity: qq, tags: ['网关'] })

    const inWeb = await backend.search({ query: '专属 面板 网关', limit: 5, identity: web, minRel: 0 })
    const inQq = await backend.search({ query: '专属 面板 网关', limit: 5, identity: qq, minRel: 0 })
    const webTexts = inWeb.hits.map((h) => h.text).join('\n')
    const qqTexts = inQq.hits.map((h) => h.text).join('\n')
    assert.match(webTexts, /面板/)
    assert.doesNotMatch(webTexts, /QQ端专属/)
    assert.match(qqTexts, /夜间网关/)
    assert.doesNotMatch(qqTexts, /网页端专属/)

    // 共享库（''）两个端都能看见；但端专属节点不互见。
    await backend.write({ text: '共享规则：只读检索不写库', identity: { userId: 'u9', roleId: '', workspace: '' } })
    const shared = await backend.search({ query: '只读检索', limit: 5, identity: web, minRel: 0 })
    assert.ok(shared.hits.some((h) => h.text.includes('共享规则')))
  } finally { backend.dispose() }
})

test('盲区②：搜索反哺落库→可召回→到期被巩固降 stale', async () => {
  const config = { ...autoWrite, identity: { mode: 'fixed', userId: 'u9', roleId: '', workspace: 'web' }, write: { ...autoWrite.write, searchFeed: true, searchTtlHours: 24 } }
  const { backend } = fresh(config)
  const handlers = {}
  const ctx = { on(ev, fn) { handlers[ev] = fn; return () => {} }, effect(fn) { return fn() } }
  try {
    installSearchFeed(ctx, { backend, config })
    handlers['tools/result']({ name: 'free_search', callId: 'c9', arguments: { query: '潮州天气' } },
      { value: { answer: '多云 26 度', sources: [{ title: '天气网', snippet: '潮州今天多云' }] } })
    // 等写队列异步落库
    for (let i = 0; i < 50; i += 1) {
      const page = await backend.nodes({ limit: 10, offset: 0 })
      if (page.items.some((n) => String(n.text).includes('潮州天气'))) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const page = await backend.nodes({ limit: 10, offset: 0 })
    const node = page.items.find((n) => String(n.text).includes('潮州天气'))
    assert.ok(node, '搜索摘要必须落库')
    assert.equal(node.memory_type, 'episodic')
    assert.equal(node.source, 'web')
    assert.deepEqual(JSON.parse(node.tags).slice(0, 1), ['web_search'])
    // 同查询+本地日期的稳定去重键（backend/writer 依 origin 复用；本断言锁 key 形态）。
    assert.match(String(node.origin), /^tool:web_search#[0-9a-f]{16}$/)
    const ttlLeft = Number(node.expired_at) - Date.now() / 1000
    assert.ok(ttlLeft > 23 * 3600 && ttlLeft <= 24 * 3600 + 60, `TTL 应约 24h，实际 ${ttlLeft}s`)

    const hit = await backend.search({ query: '潮州天气', limit: 5, identity: { userId: 'u9', roleId: '', workspace: 'web' }, minRel: 0 })
    assert.ok(hit.hits.some((h) => h.text.includes('潮州天气')), '当天必须能召回')

    // 到期：把 expired_at 拨到过去 → consolidate job 置 stale → 召回不再命中 active。
    backend.withDb((db) => db.prepare('UPDATE nodes SET expired_at=? WHERE id=?').run(Date.now() / 1000 - 60, node.id))
    const keeper = createKeeper({ store: backend, config, pressure: () => ({ stress: false }), intervalMs: 3_600_000 })
    try {
      keeper.enqueue('consolidate', {})
      await keeper.drain({ max: 3 })
    } finally { keeper.dispose() }
    const after = await backend.search({ query: '潮州天气', limit: 5, identity: { userId: 'u9', roleId: '', workspace: 'web' }, minRel: 0 })
    assert.equal(after.hits.some((h) => h.text.includes('潮州天气')), false, '过期节点必须退出召回')
    const stale = backend.withDb((db) => db.prepare('SELECT status FROM nodes WHERE id=?').get(node.id))
    assert.equal(stale.status, 'stale')
  } finally { backend.dispose() }
})

test('盲区③：连续写入回填邻居注记 10 次仍 ≤200 字，正文与 tags 不变', async () => {
  const { backend } = fresh({ ...autoWrite, identity: { mode: 'fixed', userId: 'u9', roleId: '', workspace: 'web' } })
  try {
    const ident = { userId: 'u9', roleId: '', workspace: 'web' }
    const base = await backend.write({ text: '共享邻居：网关端口规则', identity: ident, tags: ['端口'], level: 'important' })
    for (let i = 0; i < 10; i += 1) {
      await backend.write({ text: `第 ${i} 条新规则：端口变更 ${i}`, identity: ident, tags: ['端口', `轮${i}`] })
    }
    const node = backend.withDb((db) => db.prepare('SELECT text,tags,context_note FROM nodes WHERE id=?').get(base.id))
    assert.match(String(node.text), /网关端口规则/)
    assert.deepEqual(JSON.parse(node.tags), ['端口'])
    assert.ok(String(node.context_note).length <= NOTE_MAX, `注记 ${node.context_note.length} 字超硬顶`)
    assert.ok(String(node.context_note).length > 0, '应至少追加过一条注记')
  } finally { backend.dispose() }
})

test('盲区④：压力态后台 job 回 queued、延后 600s，不并跑', async () => {
  const { backend } = fresh(autoWrite)
  const state = { stress: true }
  const keeper = createKeeper({
    store: backend, config: {}, pressure: () => state, intervalMs: 3_600_000,
  })
  try {
    const id = keeper.enqueue('consolidate', {})
    const r = await keeper.tick()
    assert.equal(r.deferred, 'memory_pressure')
    const row = backend.withDb((db) => db.prepare('SELECT state,next_at FROM jobs WHERE id=?').get(id))
    assert.equal(row.state, 'queued')
    assert.ok(Number(row.next_at) > Date.now() / 1000 + 500)
    const status = keeper.status()
    assert.equal(status.running, 0, '不得有并发 running')
    // 清压后可正常跑完（同一 job 不被压力态弃置）
    state.stress = false
    backend.withDb((db) => db.prepare('UPDATE jobs SET next_at=NULL WHERE id=?').run(id))
    const r2 = await keeper.tick()
    assert.deepEqual(r2.ran, ['consolidate'])
    assert.equal(keeper.status().jobs.find((j) => j.id === id).state, 'done')
  } finally { keeper.dispose(); backend.dispose() }
})
