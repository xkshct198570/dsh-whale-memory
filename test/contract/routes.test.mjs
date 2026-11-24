import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../../src/host/routes.js'
import { createBackendProxy, createWhaleMemoryService } from '../../index.js'

const calls = { search: 0, recall: 0, searchArgs: null, write: [] }
const backend = {
  async stats() { return { totals: { nodes_total: 3, nodes_active: 2, edges: 1 } } },
  async recent() { return { items: [] } },
  async search(args) { calls.search += 1; calls.searchArgs = args; return { hits: [{ id: 'n1', text: '命中条目', score: 0.7 }], count: 1 } },
  async recall() { calls.recall += 1; return { prefix: 'MEM', hits: 1 } },
  async write(args) { calls.write.push(args); return { ok: true, id: 'n-trace' } },
}
const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
}
let server, base
before(async () => {
  const handler = createRoutes({ config, backend })
  server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise((r) => server.close(r)) })

async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

test('stats：回环可读，返回后端统计', async () => {
  const res = await fetch(base + '/whale-memory/api/stats')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.stats.totals.nodes_total, 3)
})

test('search：只读转发，query 空 -> 400', async () => {
  const ok = await post('/whale-memory/api/search', { query: '记忆', limit: 5 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.count, 1)
  const bad = await post('/whale-memory/api/search', { query: '   ' })
  assert.equal(bad.status, 400)
})

test('recall-test：纯检索，不调用 recall/生成', async () => {
  const before = { ...calls }
  const r = await post('/whale-memory/api/recall-test', { query: '记忆', maxHits: 5 })
  assert.equal(r.status, 200)
  assert.equal(r.body.mode, 'search-only')
  assert.equal(r.body.count, 1)
  assert.equal(calls.search, before.search + 1)
  assert.equal(calls.recall, before.recall, 'recall-test 不得调用 recall')
})

test('trace_id：x-trace-id 头传给 backend.search 并在响应回显', async () => {
  const res = await fetch(base + '/whale-memory/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-search-1' },
    body: JSON.stringify({ query: '记忆' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.trace_id, 'trace-search-1')
  assert.equal(calls.searchArgs.traceId, 'trace-search-1')
})

test('trace_id：/write 收到 x-trace-id 时 backend 收到同值', async () => {
  const res = await fetch(base + '/whale-memory/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-write-1' },
    body: JSON.stringify({ text: '记一条' }),
  })
  assert.equal(res.status, 200)
  assert.equal(calls.write.at(-1).traceId, 'trace-write-1')
})

test('trace_id：无头时生成 panel:<ms> 非空值', async () => {
  const r = await post('/whale-memory/api/recall-test', { query: '记忆' })
  assert.equal(r.status, 200)
  assert.match(r.body.trace_id, /^panel:\d+$/)
  assert.equal(calls.searchArgs.traceId, r.body.trace_id)
})

test('whaleMemory service：6 方法齐全、registerBackend 校验、stats/listPartitions/invalidateCache 透传', async () => {
  const provided = {}
  const ctx = { provide(name, svc) { provided[name] = svc } }
  const identityState = { hint: null }
  const hookState = { cache: new Map([['s1', { text: '旧事', exp: Date.now() + 1000 }]]) }
  const initial = {
    async stats() { return { totals: { nodes_total: 3 } } },
    async search() { return { hits: [] } },
    async recall() { return { prefix: '' } },
    withDb() { return [{ userId: 'u1', roleId: '', workspace: 'web', nodes: 2 }] },
  }
  const backendRef = { current: initial }
  const svc = createWhaleMemoryService({ ctx, backendRef, getHook: () => hookState, identityState, log: () => {} })
  assert.equal(provided.whaleMemory, svc)
  for (const name of ['stats', 'listPartitions', 'registerBackend', 'invalidateCache', 'setIdentityHint', 'clearIdentityHint']) {
    assert.equal(typeof svc[name], 'function', `${name} 必须是 service 方法`)
  }

  // 身份提示保持原语义
  svc.setIdentityHint({ userId: 'u2' })
  assert.deepEqual(identityState.hint, { userId: 'u2' })
  svc.clearIdentityHint()
  assert.equal(identityState.hint, null)

  assert.deepEqual(svc.listPartitions(), [{ userId: 'u1', roleId: '', workspace: 'web', nodes: 2 }])
  assert.equal((await svc.stats()).totals.nodes_total, 3)

  const rejected = svc.registerBackend({ stats() {} })
  assert.equal(rejected.ok, false)
  assert.equal(backendRef.current, initial, '非法后端不得替换 current')

  const next = { async stats() { return { totals: { nodes_total: 9 } } }, async search() { return { hits: [] } }, async recall() { return { prefix: '' } } }
  assert.deepEqual(svc.registerBackend(next), { ok: true })
  assert.equal(backendRef.current, next)
  assert.equal((await svc.stats()).totals.nodes_total, 9)

  // 代理 backend：替换 current 后转发到新实现
  const proxy = createBackendProxy(backendRef)
  assert.equal((await proxy.stats()).totals.nodes_total, 9)
  assert.equal(typeof proxy.search, 'function')

  assert.deepEqual(svc.invalidateCache(), { ok: true, cleared: 1 })
  assert.equal(hookState.cache.size, 0)
  assert.deepEqual(svc.invalidateCache(), { ok: true, cleared: 0 })
})

test('allowRemote：每次请求读实时配置，面板改了无需重挂路由', async () => {
  const live = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
  }
  const handler = createRoutes({ config: live, backend: { async stats() { return { totals: { nodes_total: 1 } } } }, log: () => {} })
  const fakeReq = () => ({ method: 'GET', url: '/whale-memory/api/stats', socket: { remoteAddress: '10.1.2.3' }, headers: {} })
  const fakeRes = () => ({
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(text) { this.body = text },
  })

  const denied = fakeRes()
  await handler(fakeReq(), denied)
  assert.equal(denied.statusCode, 403)
  assert.equal(JSON.parse(denied.body).error, 'not_loopback')

  live.panel.allowRemote = true
  const allowed = fakeRes()
  await handler(fakeReq(), allowed)
  assert.equal(allowed.statusCode, 200, 'allowRemote 改配置后必须立即生效')
})

test('allowRemote：非回环 peer 伪造 Host 也拿不到写权限，只读端点保留', async () => {
  const live = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: 'web' },
    panel: { allowRemote: true },
  }
  let editCalls = 0
  const searchArgs = []
  const backend = {
    async stats() { return { totals: { nodes_total: 1 } } },
    async search(args) { searchArgs.push(args); return { hits: [], count: 0 } },
    async write() { return { ok: true, id: 'n1' } },
  }
  const ctx = {
    get(name) {
      if (name === 'configEditor') return { edit() { editCalls += 1 } }
      return null
    },
    fiber: { entry: {} },
    webServer: { host: '10.0.0.8' },
  }
  const handler = createRoutes({ config: live, backend, ctx, log: () => {} })
  const makeReq = (method, path, body, headers = {}, remoteAddress = '10.1.2.3') => ({
    method, url: path, headers: { host: '127.0.0.1', ...headers }, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  })
  const makeRes = () => ({
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(text) { this.body = String(text ?? '') },
  })

  // 伪造本机 Host + JSON + 无 Origin：写与管理端点仍必须被 peer 闸挡住。
  for (const [method, path, body] of [
    ['POST', '/whale-memory/api/config', { config: { panel: { pollMs: 120000 } } }],
    ['POST', '/whale-memory/api/write', { text: 'x' }],
    ['POST', '/whale-memory/api/import', { jsonl: '{}' }],
    ['GET', '/whale-memory/api/export', undefined],
  ]) {
    const res = makeRes()
    await handler(makeReq(method, path, body), res)
    assert.equal(res.statusCode, 403, `${method} ${path} 必须拒绝远端`)
    assert.equal(JSON.parse(res.body).error, 'read_only_remote')
  }
  assert.equal(editCalls, 0, '远端不得触发 configEditor.edit')

  // 只读 GET 保留。
  const stats = makeRes()
  await handler(makeReq('GET', '/whale-memory/api/stats'), stats)
  assert.equal(stats.statusCode, 200)

  // 纯检索 POST 保留，但身份覆盖（body.workspace）必须被丢弃。
  const search = makeRes()
  await handler(makeReq('POST', '/whale-memory/api/search', { query: '记忆', workspace: '/home/hy/other' }, { 'content-type': 'application/json', origin: 'http://10.0.0.8:3080' }), search)
  assert.equal(search.statusCode, 200)
  assert.equal(searchArgs.at(-1).identity.workspace, 'web', '非回环请求不得覆盖身份分区')
})

test('列表端点缺省 limit 走声明的默认条数（clamp null 回归）', async () => {
  const seen = []
  const backend = {
    async recent(limit) { seen.push(['recent', limit]); return { items: [] } },
    async nodes(q) { seen.push(['nodes', q.limit, q.offset]); return { items: [], total: 0 } },
    async writes(limit) { seen.push(['writes', limit]); return { items: [] } },
    async edges(limit) { seen.push(['edges', limit]); return { items: [], total: 0 } },
    async evolution(limit) { seen.push(['evolution', limit]); return { items: [] } },
    async recalls(limit) { seen.push(['recalls', limit]); return { items: [] } },
  }
  const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' }, panel: { allowRemote: false } }
  const handler = createRoutes({ config, backend, log: () => {} })
  const res = () => ({ statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(t) { this.body = String(t ?? '') } })
  for (const path of ['/recent', '/nodes', '/writes', '/edges', '/evolution', '/recalls']) {
    await handler({ method: 'GET', url: '/whale-memory/api' + path, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res())
  }
  assert.deepEqual(seen, [
    ['recent', 3], ['nodes', 20, 0], ['writes', 20], ['edges', 50], ['evolution', 50], ['recalls', 20],
  ])
})
