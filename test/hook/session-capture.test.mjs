/**
 * Session Wrap 采集/触发单测：用 fake 事件总线跑真实回调，断言交给 onTrigger 的材料与触发原因。
 *
 * 口径：不碰真实会话/数据库；只验证「事件 → 有界材料 → 三触发」的接线与排除规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSessionCapture, messageText, trimTurnGroups } from '../../src/host/session-capture.js'

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event) },
      effect(fn) { return fn() },
    },
  }
}

function session(id = 's1', header = { cwd: '/w' }) {
  return { id, header }
}

/** 造 SessionEvent（seq/time 与真实事件同形）。 */
function ev(seq, type, data) {
  return { type, seq, time: seq, data }
}

function userMsg(text, kind = 'user') {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

function assistantMsg(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }
}

function install(overrides = {}) {
  const { ctx, handlers } = fakeCtx()
  const triggers = []
  let clock = 1_000_000
  const capture = installSessionCapture(ctx, {
    config: { wrap: { enabled: true, explicit: true, idle: true, disposed: true, idleMinutes: 10 }, privacy: { redact: true } },
    log: () => {},
    getIdentity: () => ({ ok: true, identity: { userId: 'u1', roleId: '', workspace: '/w' } }),
    onTrigger: async (input) => { triggers.push(input); return { ok: true, runId: triggers.length } },
    canTriggerAuto: () => ({ ok: true }),
    now: () => clock,
    idleTickMs: 1000,
    ...overrides,
  })
  return {
    capture, handlers, triggers,
    setClock: (value) => { clock = value },
    tickClock: (ms) => { clock += ms },
  }
}

test('messageText：只取 text 块，忽略 reasoning/tool', () => {
  assert.equal(messageText([
    { type: 'text', text: ' 第一 ' },
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '第二 ' },
  ]), '第一 \n第二')
  assert.equal(messageText('不是数组'), '')
})

test('trimTurnGroups：按整轮裁剪，超字数从最旧整轮丢，单轮超预算保留最后一轮', () => {
  const groups = [
    { turn: 1, user: 'a'.repeat(10), assistants: ['b'.repeat(10)] },
    { turn: 2, user: 'c'.repeat(10), assistants: ['d'.repeat(10)] },
    { turn: 3, user: 'e'.repeat(10), assistants: ['f'.repeat(10)] },
  ]
  assert.deepEqual(trimTurnGroups(groups, { maxTurns: 2 }).map((g) => g.turn), [2, 3])
  assert.deepEqual(trimTurnGroups(groups, { maxTurns: 20, maxChars: 25 }).map((g) => g.turn), [3])
  assert.deepEqual(trimTurnGroups([{ turn: 1, user: 'x'.repeat(99), assistants: [] }], { maxChars: 10 }).length, 1)
})

test('采集：turn/start → user/message → assistant/message，无意图时不触发', async () => {
  const { handlers, triggers } = install()
  const s = session()
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('把网关端口改成 3982')))
  handlers.get('session/event')(s, ev(3, 'assistant/message', {
    turn: 1, step: 1, message: assistantMsg('已改，端口 3982 验证通过'), stream: [],
  }))
  handlers.get('session/event')(s, ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 0, '没有显式意图时 turn-stopping 不触发')
})

test('显式触发：pre-step 意图 → turn-stopping 入队，材料含 user/assistant 原文与 seqTo', async () => {
  const { handlers, triggers } = install()
  const s = session()
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 3 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('这轮先收尾吧')))
  handlers.get('session/event')(s, ev(3, 'assistant/message', {
    turn: 3, step: 1, message: assistantMsg('好，我把这轮沉淀一下。'), stream: [],
  }))
  const decision = await handlers.get('agent/pre-step')({
    agent: { session: s },
    messages: [userMsg('这轮先收尾吧')],
  }, async () => ({ kind: 'enter' }))
  assert.equal(decision.kind, 'enter')
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].trigger, 'explicit')
  assert.equal(triggers[0].identity.workspace, '/w')
  assert.deepEqual(triggers[0].material.turns.map((t) => t.role), ['user', 'assistant'])
  assert.match(triggers[0].material.turns[0].text, /收尾/)
  assert.equal(triggers[0].material.seqTo, 3)
  assert.ok(triggers[0].hash.length >= 12)
})

test('意图排除：问句/否定/普通总结不触发；子代理完全不进缓冲', async () => {
  const { handlers, triggers } = install()
  const s = session('s2')
  const run = async (text) => {
    await handlers.get('agent/pre-step')({ agent: { session: s }, messages: [userMsg(text)] }, async () => ({ kind: 'enter' }))
    handlers.get('agent/turn-stopping')({ agent: { session: s } })
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await run('怎么开新会话？')
  await run('别收尾，继续干')
  await run('总结一下这篇文章')
  assert.equal(triggers.length, 0, '反例不得触发')

  const sub = session('sub1', { origin: 'subagent' })
  handlers.get('session/event')(sub, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(sub, ev(2, 'user/message', userMsg('收尾')))
  await handlers.get('agent/pre-step')({ agent: { session: sub }, messages: [userMsg('收尾')] }, async () => ({ kind: 'enter' }))
  handlers.get('agent/turn-stopping')({ agent: { session: sub } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(triggers.length, 0, '子代理不得触发')
})

test('只收直发用户消息：agent.inject 等合成 context 不入材料', async () => {
  const { handlers, triggers } = install()
  const s = session('s3')
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('运行时注入的上下文', 'runtime-context')))
  handlers.get('session/event')(s, ev(3, 'user/message', userMsg('真正的人类问题')))
  await handlers.get('agent/pre-step')({ agent: { session: s }, messages: [userMsg('收尾')] }, async () => ({ kind: 'enter' }))
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 1)
  assert.deepEqual(triggers[0].material.turns.map((t) => t.text), ['真正的人类问题'])
})

test('隐私：材料入缓冲前脱敏，token 不得进 spool/模型材料', async () => {
  const { handlers, triggers } = install()
  const s = session('s4')
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('我的 token 是 sk-abcdefghijklmnopqrstuvwxyz012345，别记下来')))
  await handlers.get('agent/pre-step')({ agent: { session: s }, messages: [userMsg('收尾')] }, async () => ({ kind: 'enter' }))
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 1)
  const text = triggers[0].material.turns[0].text
  assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), false, `密钥原文泄露：${text}`)
  assert.match(text, /收尾|别记下来/)
})

test('空闲触发：超过 idleMinutes 且无进行中 turn 才入队；同材料不重复，advance 后可再触发', async () => {
  const { handlers, triggers, capture, tickClock, setClock } = install()
  const s = session('s5')
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('空闲前的讨论')))
  handlers.get('session/event')(s, ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  // 未到空闲阈值
  tickClock(5 * 60_000)
  let out = await capture.tick()
  assert.equal(out.triggered, 0)
  // 超过阈值 → 入队一次
  tickClock(6 * 60_000)
  out = await capture.tick()
  assert.equal(out.triggered, 1)
  assert.equal(triggers[0].trigger, 'idle')
  // 同材料再 tick 不重复
  tickClock(60_000)
  out = await capture.tick()
  assert.equal(out.triggered, 0)
  assert.equal(triggers.length, 1)
  // 推进缓冲后无材料：不再触发
  capture.advance('s5', triggers[0].material.seqTo)
  tickClock(60_000)
  out = await capture.tick()
  assert.equal(out.triggered, 0)
  assert.equal(triggers.length, 1)
  void setClock
})

test('进行中的 turn 不空闲触发；disposed 触发且 pending 显式优先', async () => {
  const { handlers, triggers, capture, tickClock } = install()
  const s = session('s6')
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('长工具调用前的问题')))
  tickClock(20 * 60_000)
  let out = await capture.tick()
  assert.equal(out.triggered, 0, 'turn 未结束不得空闲收尾')
  handlers.get('session/event')(s, ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await handlers.get('agent/pre-step')({ agent: { session: s }, messages: [userMsg('先收尾')] }, async () => ({ kind: 'enter' }))
  handlers.get('session/disposed')(s)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].trigger, 'explicit', 'dispose 时未消费的显式意图优先')
})

test('disposed 无显式意图 → disposed 触发；关闭开关则不触发', async () => {
  const { handlers, triggers } = install()
  const s1 = session('s7')
  handlers.get('session/event')(s1, ev(1, 'user/message', userMsg('普通讨论')))
  handlers.get('session/disposed')(s1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].trigger, 'disposed')

  const off = install({ config: { wrap: { enabled: true, explicit: false, idle: true, disposed: false }, privacy: { redact: true } } })
  const s2 = session('s8')
  off.handlers.get('session/event')(s2, ev(1, 'user/message', userMsg('普通讨论')))
  off.handlers.get('session/disposed')(s2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(off.triggers.length, 0)
})

test('onTrigger 失败不推进去重：下一 tick 仍可重试同一材料', async () => {
  const { handlers, triggers, capture, tickClock } = install({
    onTrigger: async (input) => { triggers.push(input); return { ok: false, reason: 'db_error' } },
  })
  const s = session('s9')
  handlers.get('session/event')(s, ev(1, 'user/message', userMsg('要沉淀的内容')))
  tickClock(11 * 60_000)
  let out = await capture.tick()
  assert.equal(out.triggered, 0)
  assert.equal(out.skipped.includes('db_error'), true)
  tickClock(60_000)
  out = await capture.tick()
  assert.equal(out.triggered, 0)
  assert.equal(triggers.length, 2, '失败后必须允许重试')
})

// ---------------------------------------------------------------------------
// 审查 P2 回归：手动跳过 open turn、显式失败保留意图、会话表上限
// ---------------------------------------------------------------------------

test('手动收尾：跳过最近但有进行中 turn 的会话，改取较旧的可收尾会话', async () => {
  const { handlers, triggers, capture, tickClock } = install()
  const a = session('A')
  handlers.get('session/event')(a, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(a, ev(2, 'user/message', userMsg('A 已结束的讨论')))
  handlers.get('session/event')(a, ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  tickClock(5_000)
  // B 更新且仍有 open turn
  const b = session('B')
  handlers.get('session/event')(b, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(b, ev(2, 'user/message', userMsg('B 正在进行的长任务')))
  const out = await capture.triggerRecent('manual')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].sessionId, 'A', '最近但 open 的 B 不得挡住可收尾的 A')
})

test('手动收尾：只有进行中会话时也允许快照入队（不再 turn_in_progress 拒绝点击）', async () => {
  const { handlers, triggers, capture } = install()
  const only = session('only-open')
  handlers.get('session/event')(only, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(only, ev(2, 'user/message', userMsg('正在进行的这一轮也要能点收尾')))
  const out = await capture.triggerRecent('manual')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(triggers.length, 1)
  assert.equal(triggers[0].sessionId, 'only-open')
  assert.ok(triggers[0].material.turns.length > 0, '快照必须带当前已有材料')
})

test('显式入队失败：保留 pendingIntent 并在下一回合重试；status 可见 lastTriggerError', async () => {
  let fail = true
  const { handlers, capture } = install({
    onTrigger: async (input) => {
      if (fail) { fail = false; return { ok: false, reason: 'db_error' } }
      return { ok: true, runId: 5, sessionId: input.sessionId }
    },
  })
  const s = session('E')
  handlers.get('session/event')(s, ev(1, 'turn/start', { turn: 1 }))
  handlers.get('session/event')(s, ev(2, 'user/message', userMsg('这轮先收尾')))
  await handlers.get('agent/pre-step')({ agent: { session: s }, messages: [userMsg('这轮先收尾')] }, async () => ({ kind: 'enter' }))
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const st = capture.status()
  assert.equal(st.pendingIntents, 1, '失败后意图必须保留')
  assert.equal(st.lastTriggerError.reason, 'db_error')

  handlers.get('session/event')(s, ev(3, 'turn/start', { turn: 2 }))
  handlers.get('agent/turn-stopping')({ agent: { session: s } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(capture.status().pendingIntents, 0, '重试成功后消费意图')
})

test('会话表上限：有材料会话也受 maxSessions 约束，超限前尽力入队', async () => {
  const { handlers, triggers, capture } = install({ maxSessions: 8 })
  for (let i = 0; i < 12; i += 1) {
    const s = session(`cap${i}`)
    handlers.get('session/event')(s, ev(1, 'user/message', userMsg(`会话 ${i} 的材料`)))
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  const st = capture.status()
  assert.ok(st.sessions <= 8, `会话表必须受上限约束，实际 ${st.sessions}`)
  assert.ok(triggers.length >= 1, '淘汰有材料会话前必须尽力入队一次')
  assert.ok(st.evicted.material + st.evicted.openTurn + st.evicted.flushed >= 1, '淘汰必须有可见计数')
})
