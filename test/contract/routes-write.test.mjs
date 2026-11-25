/**
 * S2 写入路由回归：write / import / export / nodes。
 *
 * 只用 fake backend + 临时 HTTP server，绝不访问真实库/网络；
 * 断言重点是契约（状态码、错误码、身份透传、头与正文形态）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../../src/host/routes.js'

const calls = { write: [], importJsonl: [], exportJsonl: [], nodes: [] }
const backend = {
  async stats() { return { totals: { nodes_total: 0 } } },
  async recent() { return { items: [] } },
  async search() { return { hits: [], count: 0 } },
  async recall() { return null },
  async write(args) {
    calls.write.push(args)
    if (args.text === '后端白名单错误') return { ok: false, error: 'invalid_text' }
    if (args.text === '后端内部错误') return { ok: false, error: 'db_locked' }
    return { ok: true, id: 'n9' }
  },
  async exportJsonl(args) {
    calls.exportJsonl.push(args)
    return '{"id":"n1","text":"条目一"}\n{"id":"n2","text":"条目二"}\n'
  },
  async importJsonl(args) {
    calls.importJsonl.push(args)
    return { added: 2, skipped: 1, errors: 0, dryRun: args.dryRun }
  },
  async nodes(args) {
    calls.nodes.push(args)
    return { items: [{ id: 'n1', text: '条目一' }], total: 7 }
  },
}
const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
  write: { enabled: true, reviewMode: 'shadow', maxChars: 500 },
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
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}
async function get(path) {
  return fetch(base + path)
}

test('write：成功 200 且身份/默认字段透传', async () => {
  const r = await post('/whale-memory/api/write', { text: '  记一条  ' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, id: 'n9' })
  const call = calls.write.at(-1)
  assert.equal(call.text, '记一条')
  assert.equal(call.level, 'normal')
  assert.equal(call.memory_type, 'semantic')
  assert.deepEqual(call.tags, [])
  assert.deepEqual(call.identity, { userId: 'u1', roleId: '', workspace: '' })
})

test('write：空文本/纯空白 -> 400 invalid_text', async () => {
  for (const text of ['', '   ', undefined]) {
    const r = await post('/whale-memory/api/write', { text })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid_text')
  }
  assert.equal(calls.write.length, 1, '非法文本不应打到 backend')
})

test('write：超过 500 字符 -> 400 invalid_text（含 501 边界）', async () => {
  const ok500 = await post('/whale-memory/api/write', { text: 'x'.repeat(500) })
  assert.equal(ok500.status, 200)
  const bad = await post('/whale-memory/api/write', { text: 'x'.repeat(501) })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'invalid_text')
})

test('write：后端错误码白名单 400 透传，未知错误 502 脱敏', async () => {
  const known = await post('/whale-memory/api/write', { text: '后端白名单错误' })
  assert.equal(known.status, 400)
  assert.equal(known.body.error, 'invalid_text')
  const unknown = await post('/whale-memory/api/write', { text: '后端内部错误' })
  assert.equal(unknown.status, 502)
  assert.equal(unknown.body.error, 'backend_error')
})

test('write：level/memory_type/tags 白名单校验', async () => {
  const badLevel = await post('/whale-memory/api/write', { text: 'x', level: 'corex' })
  assert.equal(badLevel.status, 400)
  assert.equal(badLevel.body.error, 'invalid_level')
  const badType = await post('/whale-memory/api/write', { text: 'x', memory_type: 'other' })
  assert.equal(badType.status, 400)
  assert.equal(badType.body.error, 'invalid_memory_type')
  const badTags = await post('/whale-memory/api/write', { text: 'x', tags: [1, 2] })
  assert.equal(badTags.status, 400)
  assert.equal(badTags.body.error, 'invalid_tags')
  const ok = await post('/whale-memory/api/write', { text: 'x', level: 'core', memory_type: 'mixed', tags: ['a', 'a', ' b '] })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.write.at(-1).tags, ['a', 'b'])
})

test('import：成功 200 返回统计与 dryRun，身份透传', async () => {
  const r = await post('/whale-memory/api/import', { jsonl: '{"id":"n1"}\n', dryRun: false })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, added: 2, skipped: 1, errors: 0, dryRun: false })
  const call = calls.importJsonl.at(-1)
  assert.equal(call.jsonl, '{"id":"n1"}\n')
  assert.equal(call.dryRun, false)
  assert.deepEqual(call.identity, { userId: 'u1', roleId: '', workspace: '' })
  // 审计 P1-02：HTTP 导入必须强制请求身份，行内 user_id/role_id/workspace 不得指定写入分区。
  assert.equal(call.forceIdentity, true)
  const dry = await post('/whale-memory/api/import', { jsonl: '{"id":"n2"}\n', dryRun: true })
  assert.equal(dry.body.dryRun, true)
})

test('import：jsonl 非字符串 -> 400 invalid_jsonl', async () => {
  for (const jsonl of [undefined, null, 123, ['a'], { x: 1 }]) {
    const r = await post('/whale-memory/api/import', { jsonl })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid_jsonl')
  }
})

test('import：jsonl 超过 4 MiB -> 413 payload_too_large', async () => {
  const before = calls.importJsonl.length
  const r = await post('/whale-memory/api/import', { jsonl: 'x'.repeat(4 * 1024 * 1024 + 1) })
  assert.equal(r.status, 413)
  assert.equal(r.body.error, 'payload_too_large')
  assert.equal(calls.importJsonl.length, before, '超限不应打到 backend')
})

test('export：200 text/plain + attachment 头，正文就是 JSONL', async () => {
  const res = await get('/whale-memory/api/export')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="whale-memory.jsonl"')
  assert.equal(await res.text(), '{"id":"n1","text":"条目一"}\n{"id":"n2","text":"条目二"}\n')
  assert.deepEqual(calls.exportJsonl.at(-1).identity, { userId: 'u1', roleId: '', workspace: '' })
})

test('nodes：limit 夹取 1..100、offset 默认 0，身份透传', async () => {
  const def = await get('/whale-memory/api/nodes?limit=20&offset=0')
  assert.equal(def.status, 200)
  assert.deepEqual(await def.json(), { ok: true, items: [{ id: 'n1', text: '条目一' }], total: 7 })
  assert.deepEqual(calls.nodes.at(-1), {
    identity: { userId: 'u1', roleId: '', workspace: '' },
    limit: 20,
    offset: 0,
  })
  await get('/whale-memory/api/nodes?limit=1000&offset=-5')
  assert.equal(calls.nodes.at(-1).limit, 100)
  assert.equal(calls.nodes.at(-1).offset, 0)
  await get('/whale-memory/api/nodes?limit=0&offset=abc')
  assert.equal(calls.nodes.at(-1).limit, 1)
  assert.equal(calls.nodes.at(-1).offset, 0)
})

test('方法不符 -> 405；未知路径 404 与现有只读路由保持现状', async () => {
  const writeGet = await get('/whale-memory/api/write')
  assert.equal(writeGet.status, 405)
  assert.equal(writeGet.headers.get('allow'), 'POST')
  assert.equal((await writeGet.json()).error, 'method_not_allowed')

  const exportPost = await post('/whale-memory/api/export', {})
  assert.equal(exportPost.status, 405)
  assert.equal(exportPost.body.error, 'method_not_allowed')

  const importGet = await get('/whale-memory/api/import')
  assert.equal(importGet.status, 405)
  const nodesPost = await post('/whale-memory/api/nodes', {})
  assert.equal(nodesPost.status, 405)

  const missing = await get('/whale-memory/api/nope')
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'not_found')

  const stats = await get('/whale-memory/api/stats')
  assert.equal(stats.status, 200)
  assert.equal((await stats.json()).ok, true)
})
