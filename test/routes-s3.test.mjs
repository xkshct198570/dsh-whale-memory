import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../src/host/routes.js'

const state = { job: { id: 7, state: 'done', total: 60, added: 60, skipped: 0, errors: 0 } }
const backend = {
  async startImport({ jsonl }) { return { ok: true, async: true, jobId: 7, total: jsonl.split('\n').filter(Boolean).length } },
  async importStatus(id) { return { ok: true, job: { ...state.job, id: Number(id) } } },
  async getNode(id) { return id === 'n1' ? { ok: true, node: { id: 'n1', text: '节点' } } : { ok: false, error: 'node_not_found' } },
  async updateNode(id, patch) { return { ok: true, id, patch } },
  async writes() { return { items: [{ id: 1, action: 'ADD' }] } },
  async recalls() { return { items: [{ id: 1, hits: 2 }] } },
}
const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' }, panel: { allowRemote: false }, recall: {} }
let server, base
before(async () => {
  server = http.createServer(createRoutes({ config, backend }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise((r) => server.close(r)) })

test('大导入：>50 行返回 202 + jobId', async () => {
  const jsonl = Array.from({ length: 60 }, (_, i) => JSON.stringify({ text: `r${i}` })).join('\n')
  const res = await fetch(base + '/whale-memory/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonl }) })
  assert.equal(res.status, 202)
  const body = await res.json()
  assert.equal(body.async, true)
  assert.equal(body.jobId, 7)
})

test('导入进度：GET /import/status', async () => {
  const res = await fetch(base + '/whale-memory/api/import/status?id=7')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.state, 'done')
  assert.equal(body.added, 60)
})

test('节点详情：GET /nodes/:id', async () => {
  const ok = await fetch(base + '/whale-memory/api/nodes/n1')
  assert.equal((await ok.json()).node.text, '节点')
  const miss = await fetch(base + '/whale-memory/api/nodes/nope')
  assert.equal(miss.status, 404)
})

test('节点编辑：PATCH /nodes/:id', async () => {
  const res = await fetch(base + '/whale-memory/api/nodes/n1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { status: 'archived' } }) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).patch.status, 'archived')
})

test('审计列表：writes/recalls', async () => {
  const w = await (await fetch(base + '/whale-memory/api/writes')).json()
  assert.equal(w.items[0].action, 'ADD')
  const r = await (await fetch(base + '/whale-memory/api/recalls')).json()
  assert.equal(r.items[0].hits, 2)
})
