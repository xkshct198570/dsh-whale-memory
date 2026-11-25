/**
 * Session Wrap 路由契约：POST /wrap、GET /wrap/status、GET /wrap/report。
 *
 * 只验契约（状态码/错误码/身份透传/路径安全/JSON 写闸），不碰真实库与模型。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRoutes } from '../../src/host/routes.js'

const calls = { manual: 0, manualArgs: [], status: [], sessions: [], report: [] }
let manualResult = { ok: true, runId: 7, state: 'queued' }
let reportResult = { ok: true, runId: 7, text: '# 会话收尾报告 2026-11-24' }

const wrap = {
  async manual(args = {}) { calls.manual += 1; calls.manualArgs.push(args); return manualResult },
  status(args) {
    calls.status.push(args)
    return {
      ok: true, supported: true, enabled: true, runsToday: 1, maxRunsPerDay: 6,
      latest: { id: 7, state: 'done', candidates: 2, ruleProposals: 0, openLoops: 1 },
      recent: [], jobs: 0, spool: { files: 0, bytes: 0 }, lastSkip: null,
    }
  },
  sessions(args) {
    calls.sessions.push(args)
    return {
      ok: true,
      items: [{ sessionId: 's1', lastActivity: 1, materialTurns: 3, open: false, skipAuto: false, lastRunId: 7, lastRunState: 'done' }],
      auto: { enabled: false, idleMinutes: 10 },
    }
  },
  setSessionPrefs(args) {
    calls.prefs = calls.prefs || []
    calls.prefs.push(args)
    if (!args.sessionId) return { ok: false, error: 'invalid_session' }
    if (typeof args.skipAuto !== 'boolean') return { ok: false, error: 'invalid_value' }
    return { ok: true, sessionId: args.sessionId, skipAuto: args.skipAuto }
  },
  report(id) { calls.report.push(id); return reportResult },
}

const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  wrap: { enabled: true },
}
const backend = { async stats() { return { totals: {} } } }
let server, base
before(async () => {
  const handler = createRoutes({ config, backend, wrap })
  server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise((resolve) => server.close(resolve)) })

async function postJson(path, body, contentType = 'application/json') {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

test('POST /wrap：成功 200，返回 runId/state', async () => {
  calls.manual = 0
  manualResult = { ok: true, runId: 7, state: 'queued' }
  const r = await postJson('/whale-memory/api/wrap', { trigger: 'manual' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.runId, 7)
  assert.equal(calls.manual, 1)
})

test('POST /wrap：可判定错误码映射（409/501/502），不透内部异常', async () => {
  const cases = [
    [{ ok: false, reason: 'wrap_disabled' }, 409, 'wrap_disabled'],
    [{ ok: false, reason: 'no_material' }, 409, 'no_material'],
    [{ ok: false, reason: 'turn_in_progress' }, 409, 'turn_in_progress'],
    [{ ok: false, reason: 'busy' }, 409, 'busy'],
    [{ ok: false, reason: 'unsupported_backend' }, 501, 'unsupported_backend'],
    [{ ok: false, reason: 'session_queue_full' }, 409, 'session_queue_full'],
    [{ ok: false, reason: 'busy_queue_full' }, 409, 'busy_queue_full'],
    [{ ok: false, reason: 'no_session' }, 409, 'no_session'],
    [{ ok: false, reason: 'db_error' }, 502, 'db_error'],
    [{ ok: false, reason: 'identity_required' }, 400, 'identity_required'],
  ]
  for (const [result, status, error] of cases) {
    manualResult = result
    const r = await postJson('/whale-memory/api/wrap', {})
    assert.equal(r.status, status, `${error} 状态码`)
    assert.equal(r.body.error, error)
  }
})

test('POST /wrap：非 JSON 简单请求被写闸拒绝（不进入业务）', async () => {
  manualResult = { ok: true, runId: 7, state: 'queued' }
  const before = calls.manual
  const r = await postJson('/whale-memory/api/wrap', { trigger: 'manual' }, 'text/plain')
  assert.ok(r.status >= 400)
  assert.equal(calls.manual, before, '被闸拒绝的请求不得触发收尾')
})

test('GET /wrap/status：无身份参数按本机最近一次；显式身份参数透传', async () => {
  const first = await fetch(base + '/whale-memory/api/wrap/status')
  assert.equal(first.status, 200)
  const body = await first.json()
  assert.equal(body.ok, true)
  assert.equal(body.latest.id, 7)
  assert.deepEqual(calls.status.at(-1), { identity: null })

  const scoped = await fetch(base + '/whale-memory/api/wrap/status?userId=u1&workspace=%2Fw')
  assert.equal(scoped.status, 200)
  const scopedBody = await scoped.json()
  assert.equal(scopedBody.ok, true)
  assert.deepEqual(calls.status.at(-1).identity, { userId: 'u1', roleId: '', workspace: '/w' })
})

test('GET /wrap/report：id 校验、成功返回文本、错误映射', async () => {
  const bad = await fetch(base + '/whale-memory/api/wrap/report?id=abc')
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'invalid_id')

  reportResult = { ok: true, runId: 7, text: '# 报告' }
  const ok = await fetch(base + '/whale-memory/api/wrap/report?id=7')
  assert.equal(ok.status, 200)
  const okBody = await ok.json()
  assert.equal(okBody.text, '# 报告')
  assert.deepEqual(calls.report.at(-1), 7)

  reportResult = { ok: false, error: 'report_missing' }
  const missing = await fetch(base + '/whale-memory/api/wrap/report?id=8')
  assert.equal(missing.status, 404)

  reportResult = { ok: false, error: 'report_path_outside' }
  const outside = await fetch(base + '/whale-memory/api/wrap/report?id=8')
  assert.equal(outside.status, 403)
})

test('未安装 wrap 服务：三类端点均 502 wrap_unavailable，不抛裸异常', async () => {
  const handler = createRoutes({ config, backend, wrap: null })
  const srv = http.createServer(handler)
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const b = `http://127.0.0.1:${srv.address().port}`
  try {
    for (const path of ['/whale-memory/api/wrap/status', '/whale-memory/api/wrap/report?id=1']) {
      const r = await fetch(b + path)
      assert.equal(r.status, 502)
      assert.equal((await r.json()).error, 'wrap_unavailable')
    }
    const r = await fetch(b + '/whale-memory/api/wrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 502)
    assert.equal((await r.json()).error, 'wrap_unavailable')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('POST /wrap：sessionId 透传给 manual（指定会话收尾）', async () => {
  calls.manualArgs = []
  manualResult = { ok: true, runId: 8, state: 'queued' }
  const r = await postJson('/whale-memory/api/wrap', { trigger: 'manual', sessionId: ' s-abc ' })
  assert.equal(r.status, 200)
  assert.deepEqual(calls.manualArgs.at(-1), { sessionId: 's-abc' })
})

test('GET /wrap/sessions：键集合只有 id/活动/轮数/最近 run，绝无正文/标题/cwd', async () => {
  const res = await fetch(base + '/whale-memory/api/wrap/sessions')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.items))
  const allowed = new Set([
    'sessionId', 'lastActivity', 'materialTurns', 'open', 'turn', 'pendingIntent', 'lastTriggeredAt',
    'hasMaterial', 'skipAuto', 'lastRunId', 'lastRunState',
  ])
  for (const item of body.items) {
    for (const key of Object.keys(item)) assert.ok(allowed.has(key), `泄露字段：${key}`)
    const raw = JSON.stringify(item)
    for (const forbidden of ['text', 'title', 'header', 'cwd', 'message']) assert.equal(raw.includes(forbidden), false, `不得含 ${forbidden}`)
  }
  assert.deepEqual(body.auto, { enabled: false, idleMinutes: 10 })
})

test('GET /wrap/sessions：显式身份参数按分区过滤（透传 identity）', async () => {
  calls.sessions = []
  const res = await fetch(base + '/whale-memory/api/wrap/sessions?workspace=web')
  assert.equal(res.status, 200)
  assert.deepEqual(calls.sessions.at(-1).identity, { userId: 'u1', roleId: '', workspace: 'web' })
})

test('S1b POST /wrap 矩阵：新 run=202 + position；同材料 existing=200', async () => {
  manualResult = { ok: true, queued: true, runId: 21, position: 2, state: 'queued' }
  const created = await postJson('/whale-memory/api/wrap', { trigger: 'manual' })
  assert.equal(created.status, 202)
  assert.equal(created.body.queued, true)
  assert.equal(created.body.position, 2)
  assert.equal(created.body.runId, 21)

  manualResult = { ok: true, existing: true, runId: 21, state: 'running' }
  const existing = await postJson('/whale-memory/api/wrap', { trigger: 'manual' })
  assert.equal(existing.status, 200)
  assert.equal(existing.body.existing, true)
  assert.equal(existing.body.state, 'running')
  assert.equal(existing.body.queued, undefined, 'existing 不得伪装成新入队')
})

test('S2 PATCH /wrap/session：skipAuto 透传与错误码（invalid_session/invalid_value）', async () => {
  const ok = await fetch(base + '/whale-memory/api/wrap/session', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', skipAuto: true }),
  })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.deepEqual(body, { ok: true, sessionId: 's1', skipAuto: true })
  assert.deepEqual(calls.prefs.at(-1), { sessionId: 's1', skipAuto: true })

  const badSession = await fetch(base + '/whale-memory/api/wrap/session', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skipAuto: true }),
  })
  assert.equal(badSession.status, 400)
  assert.equal((await badSession.json()).error, 'invalid_session')

  const badValue = await fetch(base + '/whale-memory/api/wrap/session', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', skipAuto: 'yes' }),
  })
  assert.equal(badValue.status, 400)
  assert.equal((await badValue.json()).error, 'invalid_value')
})
