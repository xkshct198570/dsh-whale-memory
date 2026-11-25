/**
 * 真宿主集成（隔离 home）：验证 apply → 采集事件 → 显式收尾 → run/job/spool/状态路由全链路。
 *
 * 不调模型、不联网：只验接线可达与「入队前不烧模型」。真实执行由 session-wrap 单测覆盖。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import { apply } from '../../index.js'
import { openDb, closeDb } from '../../src/core/db.js'

const noopDisposer = () => () => {}

function hostContext() {
  const ctx = new Context()
  const calls = { routes: null }
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register(route) { calls.routes = route; return noopDisposer() },
  })
  ctx.provide('systemPrompt', {
    section: () => noopDisposer(),
    context: () => noopDisposer(),
  })
  return { ctx, calls }
}

test('真宿主：显式收尾入队 run+job+spool，/wrap/status 可见；job payload 不含正文', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-wrap-host-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => {})

  const { ctx, calls } = hostContext()
  assert.doesNotThrow(() => apply(ctx, {
    dataDir: home,
    backend: { mode: 'local' },
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    recall: { enabled: false },
    write: { enabled: true, reviewMode: 'shadow' },
    rules: { enabled: false },
    wrap: { enabled: true, idleMinutes: 5 },
  }))
  assert.ok(calls.routes && typeof calls.routes.handler === 'function', '路由必须注册')

  const server = http.createServer(calls.routes.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await new Promise((resolve) => server.close(resolve)) })

  const session = { id: 'host-s1', header: { cwd: home } }
  const event = (seq, type, data) => ({ type, seq, time: seq, data })
  const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

  // 真实事件总线：session/event 是 emit 模式，agent/pre-step 是 waterfall。
  ctx.emit('session/event', session, event(1, 'turn/start', { turn: 1 }))
  ctx.emit('session/event', session, event(2, 'user/message', userMsg('这轮先收尾，把教训记一下')))
  ctx.emit('session/event', session, event(3, 'assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '记下了：动库前先备份。' }], source: { kind: 'model' } },
    stream: [],
  }))
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { session },
    messages: [userMsg('这轮先收尾，把教训记一下')],
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' }))
  assert.equal(decision?.kind, 'enter')
  ctx.emit('agent/turn-stopping', { agent: { session } })

  // 入队是异步的（捕获器不阻塞回复）：等到 run 行出现。
  const db = openDb(home)
  try {
    let row = null
    for (let i = 0; i < 60 && !row; i += 1) {
      row = db.prepare("SELECT * FROM wrap_runs WHERE session_id='host-s1' ORDER BY id DESC LIMIT 1").get()
      if (!row) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(row, '显式收尾必须建 wrap_runs 行')
    // 入队后会主动踢一次 keeper：干净 host 没有 llm，执行会立刻落 skipped:no_model。
    assert.ok(['queued', 'running', 'skipped'].includes(row.state), `unexpected state ${row.state}`)
    assert.equal(row.trigger, 'explicit')

    const job = db.prepare("SELECT * FROM jobs WHERE kind='wrap' ORDER BY id DESC LIMIT 1").get()
    assert.ok(job, '必须有 wrap job')
    assert.ok(['queued', 'running', 'done'].includes(job.state), `unexpected job state ${job.state}`)
    assert.equal(String(job.payload).includes('动库前先备份'), false, 'job payload 不得含正文')

    const status = await (await fetch(base + '/whale-memory/api/wrap/status')).json()
    assert.equal(status.ok, true)
    assert.equal(status.supported, true)
    assert.equal(status.latest.id, Number(row.id))
    assert.equal(status.latest.state, row.state)
    assert.equal(JSON.stringify(status).includes('动库前先备份'), false, '状态接口不得泄露正文')

    // S1：会话列表可读且不带正文/路径；指定不存在的会话明确 409 no_session。
    const sessionsRes = await fetch(base + '/whale-memory/api/wrap/sessions')
    assert.equal(sessionsRes.status, 200)
    const sessionsBody = await sessionsRes.json()
    assert.equal(sessionsBody.ok, true)
    const hostItem = sessionsBody.items.find((item) => item.sessionId === 'host-s1')
    assert.ok(hostItem, '采集中的会话必须出现在列表')
    assert.equal(JSON.stringify(sessionsBody).includes('动库前先备份'), false, '会话列表不得泄露正文')
    assert.equal(JSON.stringify(sessionsBody).includes(home), false, '会话列表不得泄露 cwd')

    const missing = await fetch(base + '/whale-memory/api/wrap', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'nope' }),
    })
    assert.equal(missing.status, 409)
    assert.equal((await missing.json()).error, 'no_session')

    const spoolDir = join(home, 'spool', 'session-wrap')
    const names = existsSync(spoolDir) ? readdirSync(spoolDir) : []
    assert.equal(names.length, 1, `必须有一条 spool：${JSON.stringify(names)}`)
    const spoolPath = join(spoolDir, names[0])
    assert.equal(statSync(spoolPath).mode & 0o777, 0o600)
    const spool = JSON.parse(readFileSync(spoolPath, 'utf8'))
    assert.equal(spool.sessionId, 'host-s1')
    assert.equal(spool.identity.userId, 'u1')
    assert.equal(spool.material.turns.length, 2)
  } finally {
    closeDb(db)
  }
})
