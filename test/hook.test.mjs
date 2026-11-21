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
