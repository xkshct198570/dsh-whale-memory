import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { HttpBackend, WHALE_PROTOCOL, createBackend } from '../../src/core/backend.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 假 HTTP peer（127.0.0.1:0）：记录每个请求的 method/url/headers/body，
 * handler 负责写响应。测试用临时端口，不假设任何固定端口。
 */
function listen(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, raw, body: null }
        try { record.body = raw ? JSON.parse(raw) : null } catch { record.body = raw }
        requests.push(record)
        try {
          handler(record, res, requests)
        } catch {
          if (!res.headersSent) res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: 'peer_handler_error' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        async close() {
          server.closeAllConnections?.()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

test('HttpBackend.write：POST {event}、Bearer 头、返回远端 action', async () => {
  const peer = await listen((record, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ action: 'ADD', id: 'n-1' }))
  })
  const backend = new HttpBackend({ baseUrl: peer.url, token: 'test-token-secret', timeoutMs: 1000 })
  try {
    const event = { node_id: 'n-1', text: '同步规则', status: 'active' }
    const res = await backend.write(event)
    assert.equal(res.ok, true)
    assert.equal(res.action, 'ADD')
    assert.equal(res.conflict, false)
    assert.equal(res.id, 'n-1')

    assert.equal(peer.requests.length, 1)
    const got = peer.requests[0]
    assert.equal(got.method, 'POST')
    assert.equal(got.url, '/write')
    assert.equal(got.headers.authorization, 'Bearer test-token-secret')
    assert.match(String(got.headers['content-type']), /application\/json/)
    assert.deepEqual(got.body.event, event)
  } finally {
    await peer.close()
  }
})

test('HttpBackend.version：协议匹配返回 protocol；不匹配记录 protocol_mismatch 且不抛', async () => {
  const good = await listen((record, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ protocol: WHALE_PROTOCOL }))
  })
  const bad = await listen((record, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ protocol: 'whale-memory/999' }))
  })
  const okBackend = new HttpBackend({ baseUrl: good.url, token: 't-version', timeoutMs: 1000 })
  const badBackend = new HttpBackend({ baseUrl: bad.url, token: 't-version', timeoutMs: 1000 })
  try {
    const ok = await okBackend.version()
    assert.equal(ok.ok, true)
    assert.equal(ok.protocol, WHALE_PROTOCOL)
    assert.equal(good.requests[0].url, '/version')
    assert.equal(good.requests[0].headers.authorization, 'Bearer t-version')
    assert.equal(okBackend.protocolStatus.ok, true)
    assert.equal(okBackend.protocolStatus.mismatch, null)

    const mismatch = await badBackend.version()
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.error, 'protocol_mismatch')
    assert.equal(mismatch.protocol, 'whale-memory/999')
    assert.equal(mismatch.mismatch, true)
    const status = badBackend.protocolStatus
    assert.equal(status.ok, false)
    assert.equal(status.mismatch.protocol, 'whale-memory/999')
    assert.equal(status.mismatch.expected, WHALE_PROTOCOL)
    assert.ok(status.checked_at > 0)
  } finally {
    await good.close()
    await bad.close()
  }
})

test('HttpBackend.write：404 显式失败（不返回 null、不抛）', async () => {
  const peer = await listen((record, res) => {
    res.statusCode = 404
    res.end('no such route')
  })
  const backend = new HttpBackend({ baseUrl: peer.url, timeoutMs: 1000 })
  try {
    const res = await backend.write({ node_id: 'n-x', text: 'x' })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'http_404')
    assert.equal(res.status, 404)
  } finally {
    await peer.close()
  }
})

test('HttpBackend.write：超时显式失败（timeout）', async () => {
  const peer = await listen((record, res) => {
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify({ action: 'ADD' }))
    }, 120)
  })
  const backend = new HttpBackend({ baseUrl: peer.url, timeoutMs: 30 })
  try {
    const started = Date.now()
    const res = await backend.write({ node_id: 'n-slow', text: '慢响应' })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'timeout')
    assert.equal(res.timedOut, true)
    assert.ok(Date.now() - started < 500, '超时必须按预算返回，不能等满远端响应')
    await sleep(150)
  } finally {
    await peer.close()
  }
})

test('HttpBackend 读接口保持 fail-open（5xx → null）；未配置 baseUrl 时写/version 显式失败', async () => {
  const peer = await listen((record, res) => {
    res.statusCode = 503
    res.end('down')
  })
  const backend = new HttpBackend({ baseUrl: peer.url, timeoutMs: 1000 })
  const noBase = new HttpBackend({ baseUrl: '', timeoutMs: 1000 })
  try {
    assert.equal(await backend.stats(), null)
    assert.equal(await backend.search({ query: 'q' }), null)

    const write = await noBase.write({ node_id: 'n' })
    assert.equal(write.ok, false)
    assert.equal(write.error, 'backend_not_configured')
    const version = await noBase.version()
    assert.equal(version.ok, false)
    assert.equal(version.error, 'backend_not_configured')
  } finally {
    await peer.close()
  }
})

test('createBackend：mode=http 仍是纯 HttpBackend', () => {
  const backend = createBackend({ mode: 'http', url: 'http://127.0.0.1:9', timeoutMs: 1000 }, { token: 'tok' })
  assert.equal(backend instanceof HttpBackend, true)
  assert.equal(backend.baseUrl, 'http://127.0.0.1:9')
  assert.equal(backend.token, 'tok')
})
