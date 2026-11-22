import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook, extractQuery } from '../src/host/hook.js'

function fakeCtx() {
  const state = { pre: null, context: null, handlers: {} }
  const ctx = {
    on(ev, fn) { state.handlers[ev] = fn; if (ev === 'agent/pre-step') state.pre = fn; return () => {} },
    systemPrompt: { context(def) { state.context = def; return () => {} } },
    effect(fn) { return fn() },
  }
  return { ctx, state }
}

const config = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
}

test('extractQuery：取最后一条用户文本', () => {
  const q = extractQuery([
    { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] },
    { source: { kind: 'assistant' }, content: [{ type: 'text', text: '答' }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] },
  ])
  assert.equal(q, '第二问')
})

test('hook：pre-step 写缓存，context 本轮可读到；dispose 后清空', async () => {
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, {
    backend: { async recall() { return { prefix: '【你想到的旧事】记忆', hits: 2 } } },
    config,
  })
  const decision = { kind: 'enter' }
  const ret = await state.pre({
    agent: { session: { id: 's1' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
  }, async () => decision)
  assert.equal(ret, decision)
  assert.equal(state.context.order, 100)
  assert.match(state.context.text({ scope: { session: { id: 's1' } } }), /旧事/)
  hook.dispose()
  assert.equal(state.context.text({ scope: { session: { id: 's1' } } }), '')
})

test('hook：subagent 不召回', async () => {
  const { ctx, state } = fakeCtx()
  let called = 0
  installHook(ctx, {
    backend: { async recall() { called += 1; return { prefix: 'X', hits: 1 } } },
    config,
  })
  await state.pre({
    agent: { session: { id: 's2', header: { origin: 'subagent' } } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
  }, async () => ({ kind: 'enter' }))
  assert.equal(called, 0)
})

test('hook：recall 传入非空 traceId 且含 session id', async () => {
  const { ctx, state } = fakeCtx()
  const seen = []
  installHook(ctx, {
    backend: { async recall(args) { seen.push(args); return { prefix: 'P', hits: 1 } } },
    config,
  })
  await state.pre({
    agent: { session: { id: 'session-42' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
  }, async () => ({ kind: 'enter' }))
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0].traceId, 'string')
  assert.ok(seen[0].traceId.length > 0)
  assert.ok(seen[0].traceId.includes('session-42'), 'traceId 必须带 session id 前缀')
})

/** 构造一次"注入 → 回复引用 → 回合关闭"的完整链路；判定回写必须落在真实参数上。 */
const INJECTED_TEXT = '网关端口 3982 是回调端口，出站走 3002'

function streamFrame(turn, step, text, sid = 's3') {
  return { agent: { id: sid }, frame: { type: 'chunk', turn, step, chunk: { type: 'text-delta', text } } }
}

test('hook：回复引用注入节点 → turn-stopping 回写 used=1（真实 recallId）', async () => {
  const { ctx, state } = fakeCtx()
  const calls = []
  installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】\n- ${INJECTED_TEXT}`, hits: 1, recallId: 7, injectedNodes: [{ id: 'n1', text: INJECTED_TEXT }] }
      },
      markRecallUsed(id, used) { calls.push([id, used]); return { ok: true, updated: 1 } },
    },
    config,
  })
  await state.pre({
    agent: { session: { id: 's3' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '网关端口怎么起' }] }],
    turn: 1, step: 1,
  }, async () => ({ kind: 'enter' }))
  assert.equal(calls.length, 0, '未收到回复前不许判定')

  state.handlers['agent/assistant-stream'](streamFrame(1, 1, `按记忆：${INJECTED_TEXT}，所以用 start-gateway.sh。`))
  state.handlers['agent/turn-stopping']({ agent: { session: { id: 's3' } } })
  assert.deepEqual(calls, [[7, true]])
})

test('hook：回复没有引用 → 不回写（used 保持未判定 0）', async () => {
  const { ctx, state } = fakeCtx()
  const calls = []
  installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】\n- ${INJECTED_TEXT}`, hits: 1, recallId: 11, injectedNodes: [{ id: 'n1', text: INJECTED_TEXT }] }
      },
      markRecallUsed(id, used) { calls.push([id, used]); return { ok: true, updated: 1 } },
    },
    config,
  })
  await state.pre({
    agent: { session: { id: 's4' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '面板配色' }] }],
    turn: 1, step: 1,
  }, async () => ({ kind: 'enter' }))
  state.handlers['agent/assistant-stream'](streamFrame(1, 1, '今天下午三点开会，先改面板配色。', 's4'))
  state.handlers['agent/turn-stopping']({ agent: { session: { id: 's4' } } })
  assert.deepEqual(calls, [])
})

test('hook：下一条 pre-step 结算上一步（不必等 turn-stopping）', async () => {
  const { ctx, state } = fakeCtx()
  const calls = []
  installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】\n- ${INJECTED_TEXT}`, hits: 1, recallId: 21, injectedNodes: [{ id: 'n1', text: INJECTED_TEXT }] }
      },
      markRecallUsed(id, used) { calls.push([id, used]); return { ok: true, updated: 1 } },
    },
    config,
  })
  const pre = (step) => state.pre({
    agent: { session: { id: 's5' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
    turn: 1, step,
  }, async () => ({ kind: 'enter' }))
  await pre(1)
  state.handlers['agent/assistant-stream'](streamFrame(1, 1, INJECTED_TEXT, 's5'))
  await pre(2)
  assert.deepEqual(calls, [[21, true]], '第二步开始时第一步的证据必须已结算')
  state.handlers['agent/turn-stopping']({ agent: { session: { id: 's5' } } })
  assert.equal(calls.length, 1, '已结算的条目不许重复回写')
})

test('hook：backend 没有 markRecallUsed（旧实现）也不影响回复链路', async () => {
  const { ctx, state } = fakeCtx()
  installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】\n- ${INJECTED_TEXT}`, hits: 1, recallId: 31, injectedNodes: [{ id: 'n1', text: INJECTED_TEXT }] }
      },
    },
    config,
  })
  await state.pre({
    agent: { session: { id: 's6' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
    turn: 1, step: 1,
  }, async () => ({ kind: 'enter' }))
  state.handlers['agent/assistant-stream'](streamFrame(1, 1, INJECTED_TEXT, 's6'))
  assert.doesNotThrow(() => state.handlers['agent/turn-stopping']({ agent: { session: { id: 's6' } } }))
})

test('hook：dispose 清空待判条目，不再回写', async () => {
  const { ctx, state } = fakeCtx()
  const calls = []
  const hook = installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】\n- ${INJECTED_TEXT}`, hits: 1, recallId: 41, injectedNodes: [{ id: 'n1', text: INJECTED_TEXT }] }
      },
      markRecallUsed(id, used) { calls.push([id, used]); return { ok: true, updated: 1 } },
    },
    config,
  })
  await state.pre({
    agent: { session: { id: 's7' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }],
    turn: 1, step: 1,
  }, async () => ({ kind: 'enter' }))
  hook.dispose()
  assert.equal(hook.cache.size, 0)
  state.handlers['agent/assistant-stream'](streamFrame(1, 1, INJECTED_TEXT, 's7'))
  state.handlers['agent/turn-stopping']({ agent: { session: { id: 's7' } } })
  assert.deepEqual(calls, [])
})
