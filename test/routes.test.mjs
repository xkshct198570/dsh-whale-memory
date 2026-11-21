import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../src/host/routes.js'

const calls = { search: 0, recall: 0 }
const backend = {
  async stats() { return { totals: { nodes_total: 3, nodes_active: 2, edges: 1 } } },
  async recent() { return { items: [] } },
  async search() { calls.search += 1; return { hits: [{ id: 'n1', text: '命中条目', score: 0.7 }], count: 1 } },
  async recall() { calls.recall += 1; return { prefix: 'MEM', hits: 1 } },
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
