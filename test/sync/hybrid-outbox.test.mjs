import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend, HttpBackend, createBackend } from '../../src/core/backend.js'
import { HybridBackend, OUTBOX_MAX_ATTEMPTS, installOutboxWatchdog } from '../../src/core/hybrid.js'

const identity = { userId: 'u1', roleId: '', workspace: 'web' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'whale-hybrid-'))
}

/** 假 HTTP peer：读四接口 + write，writeMode 控制写响应（ok/http500/conflict）。 */
function startPeer({ writeMode = 'ok' } = {}) {
  const state = { writeMode, writeCalls: [], statsCalls: 0, searchCalls: 0 }
  const requests = []
  const json = (res, body, status = 200) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, raw }
      try { record.body = raw ? JSON.parse(raw) : null } catch { record.body = raw }
      requests.push(record)
      if (record.url === '/stats') {
        state.statsCalls += 1
        return json(res, { totals: { nodes_total: 777 }, health: { fts_aligned: true } })
      }
      if (record.url === '/write') {
        state.writeCalls.push(record.body || {})
        if (state.writeMode === 'http500') return json(res, { ok: false, error: 'remote_down' }, 500)
        if (state.writeMode === 'conflict') return json(res, { action: 'conflict', conflict: true })
        return json(res, { action: 'ADD', id: record.body?.event?.id || 'remote-id' })
      }
      if (record.url === '/search') {
        state.searchCalls += 1
        return json(res, { hits: [{ id: 'remote-1', text: '远端命中', score: 1 }] })
      }
      if (record.url === '/recall') return json(res, { ok: true, prefix: '远端旧事', chars: 8, hits: 1, injectedNodes: [] })
      if (record.url.startsWith('/recent')) return json(res, { items: [{ ts: 1, query: 'q', hits: 0, chars: 0, injected: false, elapsed_ms: 1 }] })
      if (record.url === '/version') return json(res, { protocol: 'whale-memory/1' })
      return json(res, { ok: false, error: 'not_found' }, 404)
    })
  })
  let closed = false
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        requests,
        url: `http://127.0.0.1:${port}`,
        async close() {
          if (closed) return
          closed = true
          server.closeAllConnections?.()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

/** 直连构造 Hybrid：本地无 config（= write auto），HTTP 预算显式 60ms。 */
function buildHybrid(dir, peerUrl, opts = {}) {
  const local = new LocalBackend({ dataDir: dir, useWorker: false, log: () => {} })
  const http = new HttpBackend({ baseUrl: peerUrl, timeoutMs: opts.httpTimeoutMs ?? 60, token: opts.token || '', log: () => {} })
  return new HybridBackend({
    local, http, log: () => {},
    config: { sync: { httpTimeoutMs: opts.httpTimeoutMs ?? 60 } },
    httpTimeoutMs: opts.httpTimeoutMs ?? 60,
  })
}

test('hybrid 读：HTTP 正常走远端；HTTP 挂掉回退本地且回退计数可观测', async () => {
  const dir = tempDir()
  const peer = await startPeer()
  const h = buildHybrid(dir, peer.url)
  try {
    const w = await h.write({ text: '本地真源规则', identity })
    assert.equal(w.ok, true)
    assert.equal(w.outbox.queued, true)

    const up = await h.stats()
    assert.equal(up.totals.nodes_total, 777, 'HTTP 正常时 stats 走远端')
    assert.equal(up.outbox.queued, 1, 'outbox 统计来自本地真源')
    assert.equal(up.health.outbox.queued, 1)
    assert.ok(peer.state.statsCalls >= 1)

    const search = await h.search({ query: '任意', limit: 3, identity })
    assert.equal(search.hits[0].id, 'remote-1')
    assert.ok(peer.state.searchCalls >= 1)

    await peer.close()
    const down = await h.stats()
    assert.equal(down.totals.nodes_total, 1, 'HTTP 挂掉后 stats 回退本地')
    assert.ok(down.health.sync.http_fallbacks >= 1)
    assert.ok(down.health.sync.fallback_by_method.stats >= 1)
    assert.equal(typeof down.health.sync.last_fallback.reason, 'string')
    assert.equal(down.health.sync.http_timeout_ms, 60)
  } finally {
    h.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hybrid 写：先落本地 + 入队 upsert 行（节点快照 JSON）', async () => {
  const dir = tempDir()
  const peer = await startPeer()
  const h = buildHybrid(dir, peer.url)
  try {
    const w = await h.write({ text: '入队规则', tags: ['t1'], identity })
    assert.equal(w.ok, true)
    assert.ok(w.outbox.id > 0)
    assert.equal(w.outbox.queued, true)
    assert.equal(w.outbox.reused, false)

    const node = await h.getNode(w.id)
    assert.equal(node.ok, true)
    assert.equal(node.node.status, 'active')

    const row = h.withDb((db) => db.prepare('SELECT * FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.op, 'upsert')
    assert.equal(row.node_id, w.id)
    assert.equal(row.state, 'queued')
    assert.equal(row.attempts, 0)
    const snap = JSON.parse(row.payload)
    assert.equal(snap.id, w.id)
    assert.equal(snap.text, '入队规则')
    assert.equal(snap.status, 'active')

    const st = await h.stats()
    assert.equal(st.outbox.queued, 1)
    assert.equal(st.outbox.running, 0)
    assert.equal(st.outbox.failed, 0)
  } finally {
    h.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushOutbox：成功后 state=done，payload 与 Bearer 头都到位', async () => {
  const dir = tempDir()
  const peer = await startPeer()
  const h = buildHybrid(dir, peer.url, { token: 'flush-token' })
  try {
    const w = await h.write({ text: '同步规则', identity })
    const flush = await h.flushOutbox({ limit: 10 })
    assert.equal(flush.ok, true)
    assert.equal(flush.claimed, 1)
    assert.equal(flush.done, 1)
    assert.equal(flush.retry, 0)
    assert.equal(flush.conflict, 0)
    assert.equal(flush.failed, 0)

    assert.equal(peer.state.writeCalls.length, 1)
    assert.equal(peer.state.writeCalls[0].event.text, '同步规则')
    const writeReq = peer.requests.find((r) => r.url === '/write')
    assert.equal(writeReq.headers.authorization, 'Bearer flush-token')

    const row = h.withDb((db) => db.prepare('SELECT state,next_at,last_error FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.state, 'done')
    assert.equal(row.next_at, null)
    assert.equal(row.last_error, null)
    assert.equal((await h.stats()).outbox.queued, 0)
  } finally {
    h.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushOutbox：失败按指数退避重排，attempts 到上限后 failed', async () => {
  const dir = tempDir()
  const peer = await startPeer({ writeMode: 'http500' })
  const h = buildHybrid(dir, peer.url)
  try {
    const w = await h.write({ text: '失败重试规则', identity })
    const first = await h.flushOutbox({ limit: 10 })
    assert.equal(first.claimed, 1)
    assert.equal(first.retry, 1)
    assert.equal(first.done, 0)

    let row = h.withDb((db) => db.prepare('SELECT * FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.state, 'queued')
    assert.equal(row.attempts, 1)
    assert.match(String(row.last_error), /http_500/)
    assert.ok(Number(row.next_at) > Date.now() / 1000, '首次退避必须在未来')

    const immediate = await h.flushOutbox({ limit: 10 })
    assert.equal(immediate.claimed, 0, '退避未到期不得再领取')

    h.withDb((db) => db.prepare('UPDATE sync_outbox SET next_at=0 WHERE id=?').run(w.outbox.id))
    const second = await h.flushOutbox({ limit: 10 })
    assert.equal(second.retry, 1)
    row = h.withDb((db) => db.prepare('SELECT * FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.attempts, 2)
    assert.ok(Number(row.next_at) - Date.now() / 1000 > 1.5, '第二次退避应 ≥2s')

    h.withDb((db) => db.prepare('UPDATE sync_outbox SET attempts=?, next_at=0 WHERE id=?').run(OUTBOX_MAX_ATTEMPTS - 1, w.outbox.id))
    const last = await h.flushOutbox({ limit: 10 })
    assert.equal(last.failed, 1)
    assert.equal(last.retry, 0)
    row = h.withDb((db) => db.prepare('SELECT * FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.state, 'failed')
    assert.equal(row.attempts, OUTBOX_MAX_ATTEMPTS)
    assert.equal(row.next_at, null)
    assert.match(String(row.last_error), /attempts_exhausted/)
  } finally {
    h.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('持久化：重建 backend 后未完成 outbox 仍被续跑（running 行复位 queued）', async () => {
  const dir = tempDir()
  const peer = await startPeer()
  const h1 = buildHybrid(dir, peer.url)
  let nodeId = ''
  try {
    const w = await h1.write({ text: '重启续跑规则', identity })
    nodeId = w.id
    assert.equal(w.outbox.queued, true)
    h1.dispose()
  } finally {
    h1.dispose()
  }
  // 模拟崩溃时留下的 running 行：新实例构造时应复位成 queued。
  const probe = new LocalBackend({ dataDir: dir, useWorker: false })
  probe.withDb((db) => db.prepare("UPDATE sync_outbox SET state='running' WHERE node_id=?").run(nodeId))
  probe.dispose()

  const h2 = buildHybrid(dir, peer.url)
  try {
    assert.equal((await h2.stats()).outbox.queued, 1, '构造时复位 running → queued')
    const flush = await h2.flushOutbox({ limit: 10 })
    assert.equal(flush.done, 1)
    assert.equal(peer.state.writeCalls.length, 1)
    assert.equal(peer.state.writeCalls[0].event.id, nodeId)
    const row = h2.withDb((db) => db.prepare('SELECT state FROM sync_outbox WHERE node_id=?').get(nodeId))
    assert.equal(row.state, 'done')
  } finally {
    h2.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('冲突：远端返回 conflict 时本地节点置 stale，outbox 行保留快照与证据', async () => {
  const dir = tempDir()
  const peer = await startPeer({ writeMode: 'conflict' })
  const h = buildHybrid(dir, peer.url)
  try {
    const w = await h.write({ text: '冲突规则', identity })
    const flush = await h.flushOutbox({ limit: 10 })
    assert.equal(flush.conflict, 1)
    assert.equal(flush.done, 0)
    assert.equal(flush.failed, 0)

    const node = await h.getNode(w.id)
    assert.equal(node.ok, true)
    assert.equal(node.node.status, 'stale', '冲突不得静默覆盖，本地节点标记 stale')

    const row = h.withDb((db) => db.prepare('SELECT * FROM sync_outbox WHERE id=?').get(w.outbox.id))
    assert.equal(row.state, 'failed')
    assert.equal(row.next_at, null)
    const detail = JSON.parse(row.last_error)
    assert.equal(detail.reason, 'conflict')
    assert.equal(detail.remote_action, 'conflict')
    assert.match(row.payload, /冲突规则/, 'payload 快照保留，供人工合并')
    assert.equal((await h.stats()).outbox.failed, 1)
  } finally {
    h.dispose()
    await peer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installOutboxWatchdog：ctx.effect 挂定时器，每周期 flush，dispose 后停表', async () => {
  const calls = []
  const backend = {
    async flushOutbox() { calls.push(Date.now()); return { claimed: 0, done: 0, retry: 0, conflict: 0, failed: 0 } },
  }
  const cleanups = []
  const labels = []
  const ctx = {
    effect(fn, label) {
      labels.push(label)
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
  }
  const handle = installOutboxWatchdog({ backend, config: {}, ctx, log: () => {}, intervalMs: 15 })
  try {
    assert.equal(handle.installed, true)
    assert.match(labels[0], /outbox watchdog/)
    await sleep(70)
    assert.ok(calls.length >= 2, `watchdog 应至少跑两轮，实际 ${calls.length}`)
    handle.dispose()
    const stoppedAt = calls.length
    await sleep(60)
    assert.equal(calls.length, stoppedAt, 'dispose 后不得继续 flush')
  } finally {
    handle.dispose()
  }
})

test('installOutboxWatchdog：非 hybrid backend 安静跳过（不挂定时器）', () => {
  let touched = false
  const ctx = { effect() { touched = true; return () => {} } }
  const handle = installOutboxWatchdog({ backend: { search() {} }, config: {}, ctx, log: () => {} })
  assert.equal(handle.installed, false)
  assert.equal(touched, false)
})

test('createBackend：mode=hybrid 返回 Hybrid（本地+HTTP），mode=local 不变', async () => {
  const dir = tempDir()
  const backend = createBackend(
    { mode: 'hybrid', url: 'http://127.0.0.1:1' },
    { dataDir: dir, config: { sync: { httpTimeoutMs: 25 } }, log: () => {} },
  )
  try {
    assert.equal(backend.mode, 'hybrid')
    assert.equal(backend instanceof HybridBackend, true)
    assert.ok(backend.local instanceof LocalBackend)
    assert.ok(backend.http instanceof HttpBackend)
    assert.equal(typeof backend.flushOutbox, 'function')

    const st = await backend.stats()
    assert.equal(st.totals.nodes_total, 0, 'HTTP 不可达时回退本地')
    assert.equal(st.health.sync.http_timeout_ms, 25, '预算取自 Config.sync.httpTimeoutMs')
    assert.ok(st.health.sync.http_fallbacks >= 1)
    assert.deepEqual(st.outbox, { queued: 0, running: 0, failed: 0, oldestAgeSec: 0 })
  } finally {
    backend.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  const local = createBackend({ mode: 'local' }, { dataDir: tempDir(), useWorker: false, log: () => {} })
  assert.equal(local instanceof LocalBackend, true)
  const localDir = local.dataDir
  local.dispose()
  rmSync(localDir, { recursive: true, force: true })
})
