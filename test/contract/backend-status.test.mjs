/**
 * 后端状态出口（审计 P0-7）与统一错误出口（审计 P2-1）的契约回归。
 *
 * 为什么单独一份：
 * - `/version` 是面板页头「local/http/hybrid · 协议 OK/不兼容 · outbox n」的唯一数据源，
 *   字段少一个面板就退回"后端：未知"；local 模式又必须恒 match（本地没有协议可谈）。
 * - 后端抛错以前会穿出 webServer 变成空响应/断连，面板只能显示"加载失败"。
 *   这里逐端点钉死 502 `{ok:false,error:'backend_error'}` JSON，证明不再是空响应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRoutes } from '../../src/host/routes.js'
import { LocalBackend, createBackend } from '../../src/core/backend.js'

const WHALE = 'whale-memory/1'

const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  recall: {},
  backend: { mode: 'local' },
}

/** 起一个临时 HTTP 服务器并返回取 JSON 的小工具。 */
async function serve(backend) {
  const server = http.createServer(createRoutes({ config, backend }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${server.address().port}/whale-memory/api`
  const get = async (path, init) => {
    const res = await fetch(root + path, init)
    const text = await res.text()
    return { status: res.status, text, body: text ? JSON.parse(text) : null }
  }
  return { server, get, close: () => new Promise((resolve) => server.close(resolve)) }
}

const statsFixture = { totals: { nodes_total: 2, nodes_active: 1, edges: 1 } }

test('P0-7 /version：local 模式 match=true、outbox=null、protocolStatus=null', async () => {
  const peer = await serve({ mode: 'local', ready: true, stats: async () => statsFixture })
  try {
    const v = await peer.get('/version')
    assert.equal(v.status, 200)
    assert.deepEqual(v.body, {
      ok: true,
      protocol: WHALE,
      expected: WHALE,
      match: true,
      mode: 'local',
      baseUrl: '',
      protocolStatus: null,
      outbox: null,
    })
  } finally { await peer.close() }
})

test('P0-7 /version：http 协议不匹配 → match=false 且证据留在 protocolStatus', async () => {
  const protocolStatus = {
    ok: false, protocol: 'whale-memory/9', expected: WHALE,
    mismatch: { protocol: 'whale-memory/9', expected: WHALE, baseUrl: 'http://peer', at: 123 }, checked_at: 123,
    baseUrl: 'http://peer',
  }
  const peer = await serve({ mode: 'http', ready: true, baseUrl: 'http://peer', protocolStatus, stats: async () => statsFixture })
  try {
    const v = await peer.get('/version')
    assert.equal(v.body.match, false)
    assert.equal(v.body.protocol, 'whale-memory/9')
    assert.equal(v.body.expected, WHALE)
    assert.equal(v.body.mode, 'http')
    assert.equal(v.body.baseUrl, 'http://peer')
    assert.deepEqual(v.body.protocolStatus, protocolStatus, '不匹配证据必须原样可见')
    assert.equal(v.body.outbox, null)

    // /stats 的 backend 视图与 /version 同口径（面板两处不能各说一套）。
    const s = await peer.get('/stats')
    assert.deepEqual(s.body.backend, { mode: 'http', ready: true, protocol: 'whale-memory/9', expected: WHALE, match: false })
    assert.equal(s.body.outbox, undefined, 'http 模式没有 outbox 时不出现该键')
  } finally { await peer.close() }
})

test('P0-7 /version + /stats：hybrid 回 protocolStatus 与 outbox 计数', async () => {
  const protocolStatus = { ok: true, protocol: WHALE, expected: WHALE, mismatch: null, checked_at: 9, baseUrl: 'http://peer' }
  const outbox = { queued: 2, running: 1, failed: 0, oldestAgeSec: 45 }
  const peer = await serve({ mode: 'hybrid', ready: true, protocolStatus, outbox, stats: async () => statsFixture })
  try {
    const v = await peer.get('/version')
    assert.equal(v.body.match, true)
    assert.equal(v.body.protocol, WHALE)
    assert.deepEqual(v.body.outbox, outbox)
    assert.deepEqual(v.body.protocolStatus, protocolStatus)

    const s = await peer.get('/stats')
    assert.deepEqual(s.body.backend, { mode: 'hybrid', ready: true, protocol: WHALE, expected: WHALE, match: true })
    assert.deepEqual(s.body.outbox, outbox, '/stats 顶部也要有 outbox（hybrid 才有）')
  } finally { await peer.close() }
})

test('P2-1 统一错误出口：后端抛错 → 502 backend_error JSON（不是空响应）', async () => {
  const boom = {
    mode: 'local',
    ready: true,
    stats() { throw new Error('db_locked') },
    recent() { throw new Error('db_locked') },
    search() { throw new Error('db_locked') },
    recalls() { throw new Error('db_locked') },
    writes() { throw new Error('db_locked') },
    edges() { throw new Error('db_locked') },
    evolution() { throw new Error('db_locked') },
  }
  const peer = await serve(boom)
  try {
    const expected = { ok: false, error: 'backend_error' }
    const cases = [
      ['/stats'],
      ['/recent?limit=3'],
      ['/recalls?limit=5'],
      ['/writes?limit=5'],
      ['/edges?limit=5'],
      ['/evolution?limit=5'],
      ['/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '记忆' }) }],
    ]
    for (const [path, init] of cases) {
      const got = await peer.get(path, init)
      assert.equal(got.status, 502, `${path} 必须 502`)
      assert.ok(got.text.length > 0, `${path} 不得是空响应`)
      assert.deepEqual(got.body, expected, `${path} 错误体统一为 backend_error`)
    }
  } finally { await peer.close() }
})

test('P2-1 统一错误出口：正常路径不受影响（502 兜底不误伤）', async () => {
  const ok = {
    mode: 'local', ready: true,
    stats: async () => statsFixture,
    recent: async () => ({ items: [] }),
    recalls: async () => ({ items: [] }),
    writes: async () => ({ items: [] }),
    edges: async () => ({ ok: true, items: [], edges: 0 }),
    evolution: async () => ({ items: [] }),
    search: async () => ({ hits: [], count: 0 }),
  }
  const peer = await serve(ok)
  try {
    for (const path of ['/stats', '/recent?limit=3', '/recalls', '/writes', '/edges', '/evolution']) {
      const got = await peer.get(path)
      assert.equal(got.status, 200, `${path} 正常路径保持 200`)
    }
    const s = await peer.get('/stats')
    assert.equal(s.body.ok, true)
    assert.equal(s.body.stats.totals.nodes_total, 2)
  } finally { await peer.close() }
})

test('P0-7 真后端：LocalBackend → /version 走真实 local 口径（不是 fake 的形状）', async () => {
  const backend = new LocalBackend({ dataDir: mkdtempSync(join(tmpdir(), 'whale-version-')), useWorker: false })
  const peer = await serve(backend)
  try {
    const v = await peer.get('/version')
    assert.equal(v.status, 200)
    assert.equal(v.body.ok, true)
    assert.equal(v.body.mode, 'local')
    assert.equal(v.body.match, true, '本地没有远端协议可谈，恒 match')
    assert.equal(v.body.protocol, WHALE)
    assert.equal(v.body.expected, WHALE)
    assert.equal(v.body.protocolStatus, null, 'local 没有协议探测结果')
    assert.equal(v.body.outbox, null, 'local 没有 outbox 表语义')
    assert.equal(v.body.baseUrl, '')

    const s = await peer.get('/stats')
    assert.equal(s.status, 200)
    assert.deepEqual(s.body.backend, { mode: 'local', ready: true, protocol: WHALE, expected: WHALE, match: true })
    assert.equal(s.body.outbox, undefined)
  } finally {
    await peer.close()
    backend.dispose()
  }
})

test('P0-7 真后端：HybridBackend → /version 回 protocolStatus 与真实 outbox 计数', async () => {
  // 远端地址故意不可达：/version 只读状态不探测，不能因为远端挂了就 502。
  const backend = createBackend(
    { mode: 'hybrid', url: 'http://127.0.0.1:9', timeoutMs: 50 },
    { dataDir: mkdtempSync(join(tmpdir(), 'whale-hybrid-version-')), useWorker: false, log: () => {} },
  )
  const peer = await serve(backend)
  try {
    const before = await peer.get('/version')
    assert.equal(before.status, 200)
    assert.equal(before.body.mode, 'hybrid')
    assert.equal(before.body.match, false, '未探测 = 不匹配（面板要显示"协议未知"而不是 OK）')
    assert.equal(before.body.protocol, null)
    assert.equal(before.body.expected, WHALE)
    assert.equal(before.body.baseUrl, 'http://127.0.0.1:9')
    assert.ok(before.body.protocolStatus && typeof before.body.protocolStatus === 'object', 'http 客户端的状态对象必须原样可见')
    assert.deepEqual(before.body.outbox, { queued: 0, running: 0, failed: 0, oldestAgeSec: 0 })

    // 本地写一条 → outbox 入队一条：/version 的 outbox 计数必须真实跟着动。
    const w = await backend.write({ text: '混合后端写入留待同步', identity: { userId: 'u1', roleId: '', workspace: '' } })
    assert.equal(w.ok, true)
    const after = await peer.get('/version')
    assert.equal(after.body.outbox.queued, 1)

    const s = await peer.get('/stats')
    assert.equal(s.status, 200)
    assert.deepEqual(s.body.backend, { mode: 'hybrid', ready: true, protocol: null, expected: WHALE, match: false })
    assert.equal(s.body.outbox.queued, 1, '/stats 顶部 outbox 与 /version 同源')
  } finally {
    await peer.close()
    backend.dispose()
  }
})
