/**
 * /sync 与 /reflect 端点契约：分支从 routes.js 搬出后必须仍可达（P2d 漏接 traceId/reflect 回归）。
 *
 * 不联网：同步桥用本机临时 http server 返回空 JSONL；reflect 用假 service。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../../src/host/routes.js'

const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
  write: { enabled: true, reviewMode: 'shadow' },
}

/** 最小 backend：同步 dryRun 只需 importJsonl；其余端点不在本文件断言。 */
const backend = {
  async importJsonl({ jsonl }) {
    return { ok: true, added: 0, skipped: 0, errors: 0, dryRun: true, lines: String(jsonl || '').split('\n').filter(Boolean).length }
  },
}

async function startRoutes(deps = {}) {
  const server = http.createServer(createRoutes({ config, backend, ...deps }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

async function startBridge() {
  const server = http.createServer((req, res) => {
    if (req.url === '/sync/pull') { res.writeHead(200); res.end(''); return }
    res.writeHead(404); res.end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('POST /reflect：reflect service 可用 → 200 started；缺服务 → 501；busy → 409', async () => {
  const ok = await startRoutes({ reflect: { trigger: async () => ({ ok: true }) } })
  try {
    const got = await post(ok.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 200)
    assert.equal(got.body.ok, true)
    assert.equal(got.body.started, true)
  } finally { await ok.close() }

  const missing = await startRoutes()
  try {
    const got = await post(missing.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 501)
    assert.equal(got.body.error, 'reflect_unavailable')
  } finally { await missing.close() }

  const busy = await startRoutes({ reflect: { trigger: async () => ({ ok: false, reason: 'busy' }) } })
  try {
    const got = await post(busy.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 409)
    assert.equal(got.body.error, 'busy')
  } finally { await busy.close() }
})

test('POST /sync：dryRun pull 可达且 trace_id 回显；非 dryRun 缺 confirm 拒绝', async () => {
  const bridge = await startBridge()
  const routes = await startRoutes({
    config: { ...config, sync: { enabled: true, bridgeUrl: bridge.baseUrl, dryRun: true } },
  })
  try {
    const got = await post(routes.base, '/whale-memory/api/sync', { direction: 'pull', dryRun: true })
    assert.equal(got.status, 200)
    assert.equal(got.body.ok, true)
    assert.equal(got.body.dryRun, true)
    assert.match(String(got.body.trace_id), /^(panel:|trace-)/)
    assert.equal(got.body.pull?.ok, true)

    const rejected = await post(routes.base, '/whale-memory/api/sync', { direction: 'pull', dryRun: false })
    assert.notEqual(rejected.status, 200)
    assert.equal(rejected.body.error, 'confirm_required')
  } finally { await routes.close(); await bridge.close() }

  const disabled = await startRoutes({ config: { ...config, sync: { enabled: false } } })
  try {
    const got = await post(disabled.base, '/whale-memory/api/sync', { direction: 'pull', dryRun: true })
    assert.equal(got.status, 501)
    assert.equal(got.body.error, 'sync_disabled')
  } finally { await disabled.close() }
})
