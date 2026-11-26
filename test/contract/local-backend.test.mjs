import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'
import { Config } from '../../src/host/config.js'

const ident = { userId: 'u1', roleId: '', workspace: 'web' }

function fresh(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-'))
  return new LocalBackend({ dataDir: dir, useWorker: false, ...opts })
}

test('write → search → recall 闭环；同 hash 去重', async () => {
  const b = fresh()
  try {
    const w = await b.write({ text: '网关端口 3982 是回调端口', level: 'core', memory_type: 'procedural', tags: ['端口'], identity: ident })
    assert.equal(w.ok, true)
    const dup = await b.write({ text: '网关端口 3982 是回调端口', identity: ident })
    assert.equal(dup.duplicate, true)
    const hits = await b.search({ query: '网关端口', limit: 5, identity: ident })
    assert.ok(hits.hits.length >= 1)
    assert.equal(hits.hits[0].text.includes('3982'), true)
    const r = await b.recall({ query: '网关端口', maxHits: 3, identity: ident })
    assert.match(r.prefix, /旧事/)
    assert.ok(r.chars > 0)
  } finally { b.dispose() }
})

test('身份隔离：web 节点不被共享查询意外串入 aluna', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网页专属规则', identity: { userId: 'u1', roleId: '', workspace: 'web' } })
    await b.write({ text: '共享规则', identity: { userId: 'u1', roleId: '', workspace: '' } })
    const web = await b.search({ query: '规则', limit: 5, identity: { userId: 'u1', roleId: 'aluna', workspace: 'web' } })
    assert.ok(web.hits.some((h) => h.text === '网页专属规则'))
    assert.ok(web.hits.some((h) => h.text === '共享规则'))
    const other = await b.search({ query: '网页专属', limit: 5, identity: { userId: 'u1', roleId: 'aluna', workspace: 'qq' } })
    assert.equal(other.hits.some((h) => h.text === '网页专属规则'), false)
  } finally { b.dispose() }
})

test('export → import 幂等；nodes/stats', async () => {
  const src = fresh(); const dst = fresh()
  try {
    await src.write({ text: '迁移规则一', identity: ident })
    await src.write({ text: '迁移规则二', identity: ident })
    const jsonl = await src.exportJsonl({ identity: ident })
    assert.equal(jsonl.trim().split('\n').length, 2)
    const dry = await dst.importJsonl({ jsonl, identity: ident, dryRun: true })
    assert.equal(dry.added, 2)
    assert.equal(dry.dryRun, true)
    const real = await dst.importJsonl({ jsonl, identity: ident })
    assert.equal(real.added, 2)
    const again = await dst.importJsonl({ jsonl, identity: ident })
    assert.equal(again.added, 0)
    assert.equal(again.skipped, 2)
    const page = await dst.nodes({ limit: 1, offset: 0 })
    assert.equal(page.items.length, 1)
    assert.equal(page.total, 2)
    const st = await dst.stats()
    assert.equal(st.totals.nodes_total, 2)
  } finally { src.dispose(); dst.dispose() }
})

test('异步导入：>50 行返回 jobId，后台分批完成', async () => {
  const b = fresh()
  try {
    const jsonl = Array.from({ length: 120 }, (_, i) => JSON.stringify({ text: `批量规则 ${i}`, user_id: 'u1' })).join('\n')
    const started = await b.startImport({ jsonl, identity: ident })
    assert.equal(started.async, true)
    assert.equal(started.total, 120)
    let st
    for (let i = 0; i < 50; i += 1) {
      st = await b.importStatus(started.jobId)
      if (st.job?.state === 'done') break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(st.job.state, 'done')
    assert.equal(st.job.added, 120)
    const page = await b.nodes({ limit: 1, offset: 0 })
    assert.equal(page.total, 120)
  } finally { b.dispose() }
})

test('节点详情/编辑/审计列表', async () => {
  const b = fresh()
  try {
    const w = await b.write({ text: '可编辑规则', identity: ident })
    const got = await b.getNode(w.id)
    assert.equal(got.node.text, '可编辑规则')
    const upd = await b.updateNode(w.id, { text: '已归档规则', status: 'archived' })
    assert.equal(upd.ok, true)
    const after = await b.getNode(w.id)
    assert.equal(after.node.status, 'archived')
    await b.write({ text: '审计召回规则', identity: ident })
    await b.recall({ query: '审计召回', maxHits: 3, identity: ident })
    const rec = await b.recalls(5)
    assert.ok(rec.items.length >= 1)
  } finally { b.dispose() }
})

test('写库：超长/空文本拒绝' , async () => {
  const b = fresh()
  try {
    assert.equal((await b.write({ text: '', identity: ident })).ok, false)
    assert.equal((await b.write({ text: 'x'.repeat(501), identity: ident })).ok, false)
  } finally { b.dispose() }
})

// ---------------------------------------------------------------------------
// 审计缺陷回归（P0）：真实 Config（schemastery Ref）喂 backend，开关必须生效
// ---------------------------------------------------------------------------

test('真实 Config：write.enabled=false 拦写入；reviewMode=auto 落库；maxChars 生效', async () => {
  const off = fresh({ config: new Config({ write: { enabled: false } }) })
  try {
    const r = await off.write({ text: '关写开关下不该落库', identity: ident })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'write_disabled')
    assert.equal((await off.stats()).totals.nodes_total, 0)
    // 关写时连 jobs 队列都不应入队（没有可处理的写事件）
    assert.equal(off.withDb((db) => Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='write'").get().n)), 0)
  } finally { off.dispose() }

  const live = fresh({ config: new Config({ write: { reviewMode: 'auto', maxChars: 20 } }) })
  try {
    const ok = await live.write({ text: 'a'.repeat(20), identity: ident })
    assert.equal(ok.ok, true)
    assert.equal(ok.action, 'ADD', 'auto 模式必须真落库（Ref 未解包会退化成 CANDIDATE）')
    assert.equal(ok.candidate, false)
    const long = await live.write({ text: 'b'.repeat(21), identity: ident })
    assert.equal(long.ok, false)
    assert.equal(long.error, 'text_too_long')
    assert.equal((await live.stats()).totals.nodes_total, 1)
  } finally { live.dispose() }

  const shadow = fresh({ config: new Config({}) })
  try {
    const cand = await shadow.write({ text: '默认配置下的影子候选', identity: ident })
    assert.equal(cand.ok, true)
    assert.equal(cand.action, 'CANDIDATE')
    assert.equal(cand.candidate, true)
    assert.equal((await shadow.stats()).totals.nodes_total, 0)
  } finally { shadow.dispose() }
})

test('召回注入开关（P1-1）：injectLevels 按层级过滤，showSources 控制来源标记', async () => {
  const b = fresh()
  try {
    // 先写 core 级事实；同槽位冲突的第二条会走 REVIEW（core 受保护），因此两条都 active。
    await b.write({ text: '核心端口规则 8080 回调', level: 'core', identity: ident })
    await b.write({ text: '普通端口规则 9090 回调', level: 'normal', identity: ident })

    // 不传 injectLevels = 不过滤（旧调用方行为不变），默认带来源标记。
    const all = await b.recall({ query: '端口规则 回调', maxHits: 5, intentBudget: false, identity: ident })
    assert.equal(all.hits, 2)
    assert.match(all.prefix, /\[core\/self\]/, 'showSources 默认 true：每行带 [level/source]')
    assert.match(all.prefix, /\[normal\/self\]/)

    const coreOnly = await b.recall({
      query: '端口规则 回调', maxHits: 5, intentBudget: false, identity: ident, injectLevels: ['core'],
    })
    assert.equal(coreOnly.hits, 1, 'normal 层级不注入')
    assert.match(coreOnly.prefix, /8080/)
    assert.equal(coreOnly.prefix.includes('9090'), false, '被层级挡掉的正文不得出现在注入文本里')

    const noSources = await b.recall({
      query: '端口规则 回调', maxHits: 5, intentBudget: false, identity: ident, showSources: false,
    })
    assert.doesNotMatch(noSources.prefix, /\[(core|important|normal)\//, 'showSources=false 不能残留 [core/owner] 类标记')
    assert.match(noSources.prefix, /旧事/)

    // 空数组是显式"一层都不要"：一条都不注入，但检索命中集合仍要落审计（可解释性）。
    const none = await b.recall({
      query: '端口规则 回调', maxHits: 5, intentBudget: false, identity: ident, injectLevels: [],
    })
    assert.equal(none.hits, 0)
    assert.equal(none.prefix, '')
    assert.equal(none.level_filtered, 2)
    const row = b.withDb((db) => db.prepare('SELECT hit_ids,injected,chars FROM recalls ORDER BY id DESC LIMIT 1').get())
    assert.equal(JSON.parse(row.hit_ids).length, 2, 'hit_ids 记检索命中集合，不因层级过滤而清空')
    assert.equal(Number(row.injected), 0)
    assert.equal(Number(row.chars), 0)
  } finally { b.dispose() }
})

test('节点详情带 1 跳邻居边（同分区可见，跨分区不泄露）', async () => {
  const b = fresh()
  try {
    // 两条正文必须低相似：S1 判重会把 0.7+ 的无增益近文转审核候选，不再静默新增节点。
    const a = await b.write({ text: '邻居边测试甲：磁盘挂载点 /data 只读', identity: ident })
    const c = await b.write({ text: '邻居边测试乙：夏令时切换脚本每周跑', identity: ident })
    // 同分区 + 跨分区各插一条边：getNode 只回两端都可见的那条。
    b.withDb((db) => {
      const now = Date.now() / 1000
      const ins = db.prepare('INSERT INTO edges(from_id,to_id,etype,source,conf,weight,created_at) VALUES (?,?,?,?,?,?,?)')
      ins.run(a.id, c.id, 'similar', 'manual', 0.9, 0.9, now)
      ins.run(a.id, 'n-not-visible', 'similar', 'manual', 0.8, 0.8, now)
    })
    const got = await b.getNode(a.id, { identity: ident })
    assert.equal(got.ok, true)
    assert.equal(got.edges.length, 1, '只应看到同分区的那条边')
    assert.equal(got.edges[0].neighbor, c.id)
    const invisible = await b.getNode(a.id, { identity: { userId: 'u1', roleId: '', workspace: 'qq' } })
    assert.equal(invisible.ok, false, '跨身份按 404 处理')
  } finally { b.dispose() }
})
