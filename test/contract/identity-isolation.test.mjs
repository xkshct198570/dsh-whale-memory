/**
 * 跨身份泄漏回归（审计 P0-2）+ 人工写保护/审计（审计 P0-3）。
 *
 * 为什么必须走真实后端 + 真实 HTTP：这些端点的漏洞形态是"路由把身份吞了、backend 没过滤"，
 * 用 fake backend 断言参数只能证明"传了"，证明不了"只回本区"。这里两个 userId 各写自己的
 * 记忆，然后逐端点核对返回集合里没有对方分区的行（正文/身份列/边/演化）。
 *
 * 只碰 mkdtemp 临时库；不访问真实数据目录与网络。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'
import { createRoutes } from '../../src/host/routes.js'
import { upsertEdge } from '../../src/core/relations.js'

const U1 = { userId: 'user-a', roleId: '', workspace: 'web' }
const U2 = { userId: 'user-b', roleId: '', workspace: 'web' }
/** 路由侧 Config 身份：默认就是 user-a，请求可带 userId 覆盖（P0-2 的"请求可覆盖"口径）。 */
const config = {
  identity: { mode: 'fixed', userId: 'user-a', roleId: '', workspace: 'web' },
  panel: { allowRemote: false },
  recall: { enabled: true, maxHits: 5, timeoutMs: 1000, injectLevels: ['core', 'important', 'normal'], showSources: true },
  write: { enabled: true, reviewMode: 'auto', maxChars: 500, dailyCap: 200 },
}

/** @type {LocalBackend} */
let backend
/** @type {{ a1: any, a2: any, b1: any, b2: any, core: any }} */
const nodes = {}
let server, base

const api = (p) => `http://127.0.0.1:${server.address().port}/whale-memory/api${p}`
const getJson = async (p, init) => {
  const res = await fetch(api(p), init)
  return { status: res.status, body: await res.json() }
}
/** PATCH 节点：可带 x-trace-id（审计留痕要能追到请求）。 */
const patchJson = (id, body, traceId = '') => getJson(`/nodes/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) },
  body: JSON.stringify(body),
})

before(async () => {
  backend = new LocalBackend({ dataDir: mkdtempSync(join(tmpdir(), 'whale-isolation-')), useWorker: false })
  // 两个分区各两条互不相干的事实（同一 writer 决策链，但不该跨区合并/取代）。
  nodes.a1 = await backend.write({ text: '甲区第一条：周末团建在西湖', tags: ['甲区'], identity: U1 })
  nodes.a2 = await backend.write({ text: '甲区第二条：季度预算冻结', tags: ['甲区'], identity: U1 })
  nodes.b1 = await backend.write({ text: '乙区第一条：下周上线预演', tags: ['乙区'], identity: U2 })
  nodes.b2 = await backend.write({ text: '乙区第二条:供应商合同归档', tags: ['乙区'], identity: U2 })
  // 受保护目标（core 级）：面板只能改状态，不能改正文。
  nodes.core = await backend.write({ text: '核心铁律:重启必须先备份', level: 'core', identity: U1 })
  for (const key of ['a1', 'a2', 'b1', 'b2', 'core']) {
    assert.equal(nodes[key].ok, true, `夹具写入失败：${key}`)
    assert.ok(nodes[key].id, `夹具必须拿到 id：${key}`)
    // 夹具必须各自成条（ADD）：合并/取代会让"每个用户 2 条"的前提失效，
    // 那时的隔离断言即使通过也只是在测错对象——所以在这里钉死决策动作。
    assert.equal(nodes[key].action, 'ADD', `夹具必须落成新节点：${key}`)
  }

  // 边：本区各一条 + 一条跨区边（跨区边对任何一侧都不可见）。
  backend.withDb((db) => {
    upsertEdge(db, { fromId: nodes.a1.id, toId: nodes.a2.id, etype: 'topic', source: 'manual', conf: 0.9 })
    upsertEdge(db, { fromId: nodes.b1.id, toId: nodes.b2.id, etype: 'topic', source: 'manual', conf: 0.9 })
    upsertEdge(db, { fromId: nodes.a1.id, toId: nodes.b1.id, etype: 'reference', source: 'manual', conf: 0.9 })
  })

  await backend.recall({ query: '西湖', maxHits: 3, identity: U1, source: 'panel-test' })
  await backend.recall({ query: '上线预演', maxHits: 3, identity: U2, source: 'panel-test' })

  // 人工编辑/归档：两条都要留 writes + evolution（P0-3 审计）。
  assert.equal((await backend.updateNode(nodes.a1.id, { text: '甲区第一条：周末团建改到灵隐寺' }, { identity: U1, traceId: 'tr-edit-a' })).ok, true)
  assert.equal((await backend.updateNode(nodes.b1.id, { status: 'archived' }, { identity: U2, traceId: 'tr-archive-b' })).ok, true)

  server = http.createServer(createRoutes({ config, backend }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  backend?.dispose()
})

test('P0-2 /nodes：只回本区且 total 同步过滤，请求可覆盖身份', async () => {
  const own = await getJson('/nodes?limit=100')
  assert.equal(own.status, 200)
  assert.equal(own.body.total, own.body.items.length, 'total 必须与过滤后的集合同口径')
  assert.ok(own.body.items.every((row) => row.user_id === 'user-a'), '默认身份只看 user-a')
  assert.equal(own.body.items.length, 3)
  assert.equal(own.body.items.some((row) => String(row.text).includes('乙区')), false, '不得出现对方分区正文')

  const other = await getJson('/nodes?limit=100&userId=user-b')
  assert.equal(other.body.items.length, 2)
  assert.equal(other.body.total, 2)
  assert.ok(other.body.items.every((row) => row.user_id === 'user-b'))
  assert.equal(other.body.items.some((row) => String(row.text).includes('甲区')), false)
})

test('P0-2 详情：跨身份按 node_not_found（404）而不是把正文送出去', async () => {
  const own = await getJson(`/nodes/${encodeURIComponent(nodes.a1.id)}`)
  assert.equal(own.status, 200)
  assert.match(own.body.node.text, /灵隐寺/)

  const cross = await getJson(`/nodes/${encodeURIComponent(nodes.a1.id)}?userId=user-b`)
  assert.equal(cross.status, 404)
  assert.equal(cross.body.error, 'node_not_found')
  assert.equal(cross.body.node, undefined, '404 响应不得夹带节点正文')

  // 改也一样：跨身份 PATCH 先按身份校验，落到 node_not_found，而不是改别人的节点。
  const crossEdit = await patchJson(nodes.a1.id, { patch: { status: 'archived' }, userId: 'user-b' })
  assert.equal(crossEdit.status, 400)
  assert.equal(crossEdit.body.error, 'node_not_found')
  assert.equal((await getJson(`/nodes/${encodeURIComponent(nodes.a1.id)}`)).body.node.status, 'active')
})

test('P0-2 /writes /recalls /edges /evolution /recent：同一身份口径', async () => {
  const writesB = await getJson('/writes?limit=100&userId=user-b')
  assert.equal(writesB.status, 200)
  assert.ok(writesB.body.items.length >= 1)
  assert.ok(writesB.body.items.every((row) => row.user_id === 'user-b'), '写审计不得混入对方分区')
  assert.ok(writesB.body.items.some((row) => row.action === 'ARCHIVE'), '本区归档动作要看得见')

  const writesA = await getJson('/writes?limit=100')
  assert.ok(writesA.body.items.some((row) => row.action === 'EDIT'))
  assert.equal(writesA.body.items.some((row) => row.user_id === 'user-b'), false)

  // action 过滤与身份条件同层 AND（少一层就会"按 action 查全表"）。
  const archB = await getJson('/writes?action=ARCHIVE&limit=100&userId=user-b')
  assert.ok(archB.body.items.length >= 1)
  assert.ok(archB.body.items.every((row) => row.action === 'ARCHIVE' && row.user_id === 'user-b'))

  const recallsB = await getJson('/recalls?limit=100&userId=user-b')
  assert.equal(recallsB.status, 200)
  assert.ok(recallsB.body.items.length >= 1)
  assert.equal(recallsB.body.items.some((item) => item.query === '西湖'), false, '召回查询词也是分区数据')
  assert.ok(recallsB.body.items.every((item) => item.query === '上线预演'))

  const recentB = await getJson('/recent?limit=10&userId=user-b')
  assert.equal(recentB.status, 200)
  assert.ok(recentB.body.items.every((item) => item.query === '上线预演'))

  const edgesB = await getJson('/edges?limit=100&userId=user-b')
  assert.equal(edgesB.status, 200)
  assert.equal(edgesB.body.items.length, 1, '只回本区那条边')
  assert.equal(edgesB.body.edges, 1, '统计与明细同口径')
  assert.equal(edgesB.body.items[0].from_id, nodes.b1.id)
  const edgesA = await getJson('/edges?limit=100')
  assert.equal(edgesA.body.items.length, 1, '跨区边对甲区也不可见')
  assert.equal(edgesA.body.items[0].to_id, nodes.a2.id)

  const evoB = await getJson('/evolution?limit=100&userId=user-b')
  assert.equal(evoB.status, 200)
  assert.ok(evoB.body.items.length >= 1)
  assert.ok(evoB.body.items.every((item) => item.to_id === nodes.b1.id), '演化审计只回本区被改节点')
  assert.ok(evoB.body.items.some((item) => item.field === 'status' && item.new_value === 'archived'))
})

test('P0-3 受保护目标：core/owner/procedural 只能改状态，改正文 400 protected_target', async () => {
  const denied = await patchJson(nodes.core.id, { patch: { text: '核心铁律:重启可以先删库' } })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error, 'protected_target')
  const still = await getJson(`/nodes/${encodeURIComponent(nodes.core.id)}`)
  assert.equal(still.body.node.text, '核心铁律:重启必须先备份', '被拒绝的编辑不得落库')
  assert.equal(still.body.node.status, 'active')

  // 非正文状态改动允许（面板归档受保护节点是合法动作）。
  const archived = await patchJson(nodes.core.id, { patch: { status: 'archived' } })
  assert.equal(archived.status, 200)
  assert.equal(archived.body.ok, true)
  const after = await getJson(`/nodes/${encodeURIComponent(nodes.core.id)}`)
  assert.equal(after.body.node.status, 'archived')
})

test('P0-3 superseded 必须带 superseded_by，防半残数据', async () => {
  const missing = await patchJson(nodes.a2.id, { patch: { status: 'superseded' } })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error, 'superseded_by_required')
  assert.equal((await getJson(`/nodes/${encodeURIComponent(nodes.a2.id)}`)).body.node.status, 'active')

  const ok = await patchJson(nodes.a2.id, { patch: { status: 'superseded', superseded_by: nodes.b2.id } })
  assert.equal(ok.status, 200)
  const row = (await getJson(`/nodes/${encodeURIComponent(nodes.a2.id)}`)).body.node
  assert.equal(row.status, 'superseded')
  assert.equal(row.superseded_by, nodes.b2.id)

  // 重新激活时指针必须一起清空：留着"继任者"而状态是 active 等于半残数据。
  const back = await patchJson(nodes.a2.id, { patch: { status: 'active' } })
  assert.equal(back.status, 200)
  const active = (await getJson(`/nodes/${encodeURIComponent(nodes.a2.id)}`)).body.node
  assert.equal(active.status, 'active')
  assert.equal(active.superseded_by, null)
})

test('P0-3/A7 人工编辑留痕：writes(EDIT, before_text) + evolution(旧值/新值) + trace', async () => {
  const target = nodes.b2.id
  const res = await patchJson(target, { patch: { text: '乙区第二条:供应商合同已归档' }, userId: 'user-b' }, 'tr-manual-1')
  assert.equal(res.status, 200)

  const audit = backend.withDb((db) => ({
    writes: db.prepare("SELECT action,before_text,after_text,reason,trace_id,mode,user_id FROM writes WHERE node_id=? AND action='EDIT' ORDER BY id DESC").all(target),
    evo: db.prepare("SELECT field,old_value,new_value,trace_id,from_id,to_id FROM evolution WHERE to_id=? AND field='text' ORDER BY id DESC").all(target),
  }))
  const write = audit.writes[0]
  assert.ok(write, '人工改正文必须写 writes(action=EDIT)')
  assert.equal(write.before_text, '乙区第二条:供应商合同归档')
  assert.equal(write.after_text, '乙区第二条:供应商合同已归档')
  assert.equal(write.trace_id, 'tr-manual-1')
  assert.equal(write.mode, 'manual', '人工编辑与 shadow/auto 决策可区分')
  assert.equal(write.user_id, 'user-b', '审计行身份跟节点分区一致，才能被 /writes 正确过滤')

  const evo = audit.evo[0]
  assert.ok(evo, '人工改正文必须写 evolution(field=text)')
  assert.equal(evo.old_value, '乙区第二条:供应商合同归档')
  assert.equal(evo.new_value, '乙区第二条:供应商合同已归档')
  assert.equal(evo.from_id, target)
  assert.equal(evo.trace_id, 'tr-manual-1')
})
