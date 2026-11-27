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

/** 最近会话身份：手动反思必须落会话分区（workspace 非空），不能拿控制面 workspace='' 冒充。 */
const sessionState = {
  lastRecall: { sessionId: 's1', userId: 'u1', roleId: '', workspace: '/work/ws', workspaceSource: 'session', at: 1 },
}

test('POST /reflect：手动传最近会话身份 → 200 started；缺服务 → 501；busy → 409；无 workspace → 400（带机器可读 reason）', async () => {
  const calls = []
  const ok = await startRoutes({
    identityState: sessionState,
    reflect: { trigger: async (opts) => { calls.push(opts); return { ok: true, added: 1 } } },
  })
  try {
    const got = await post(ok.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 200)
    assert.equal(got.body.ok, true)
    assert.equal(got.body.started, true)
    assert.deepEqual(calls[0].identity, { userId: 'u1', roleId: '', workspace: '/work/ws' })
    assert.equal(calls[0].sessionId, 's1')
    assert.equal(calls[0].reason, 'manual')
  } finally { await ok.close() }

  const missing = await startRoutes()
  try {
    const got = await post(missing.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 501)
    assert.equal(got.body.error, 'reflect_unavailable')
  } finally { await missing.close() }

  const busy = await startRoutes({
    identityState: sessionState,
    reflect: { trigger: async () => ({ ok: false, reason: 'busy' }) },
  })
  try {
    const got = await post(busy.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 409)
    assert.equal(got.body.error, 'busy')
  } finally { await busy.close() }

  // 无最近会话身份时，控制面 workspace='' 不得被当成共享分区去反思。
  // 基础 config 是 fixed 且 workspace 为空 → 原因是「fixed 配置不全」（0.8.1-10）。
  const noWs = await startRoutes({ reflect: { trigger: async () => ({ ok: true }) } })
  try {
    const got = await post(noWs.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 400)
    assert.equal(got.body.error, 'identity_required')
    assert.equal(got.body.reason, 'fixed_identity_incomplete')
  } finally { await noWs.close() }

  // auto 模式即使控制面有 workspace，也不能在无会话身份时触发（可能是 local 兜底分区）。
  const autoCalls = []
  const auto = await startRoutes({
    config: { ...config, identity: { mode: 'auto', userId: '', roleId: '', workspace: '/work/ws' } },
    reflect: { trigger: async (opts) => { autoCalls.push(opts); return { ok: true } } },
  })
  try {
    const got = await post(auto.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 400)
    assert.equal(got.body.error, 'identity_required')
    assert.equal(got.body.reason, 'no_session_identity', 'auto 且无会话身份 → 让用户先去说话')
    assert.equal(autoCalls.length, 0)
  } finally { await auto.close() }

  // 有最近会话身份但缺 userId（宿主 identity 未就绪）：仍拒绝，原因与「完全没有会话」区分开。
  const partialCalls = []
  const partial = await startRoutes({
    identityState: { lastRecall: { sessionId: 's2', userId: '', roleId: '', workspace: '/work/ws', at: 1 } },
    reflect: { trigger: async (opts) => { partialCalls.push(opts); return { ok: true } } },
  })
  try {
    const got = await post(partial.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 400)
    assert.equal(got.body.reason, 'identity_incomplete')
    assert.equal(partialCalls.length, 0)
  } finally { await partial.close() }

  // fixed 模式的显式固定身份是稳定分区：无会话也可手动反思，且身份原样下传。
  const fixedCalls = []
  const fixed = await startRoutes({
    config: { ...config, identity: { mode: 'fixed', userId: 'u1', roleId: 'r1', workspace: 'web' } },
    reflect: { trigger: async (opts) => { fixedCalls.push(opts); return { ok: true } } },
  })
  try {
    const got = await post(fixed.base, '/whale-memory/api/reflect', {})
    assert.equal(got.status, 200)
    assert.deepEqual(fixedCalls[0].identity, { userId: 'u1', roleId: 'r1', workspace: 'web' })
  } finally { await fixed.close() }
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
