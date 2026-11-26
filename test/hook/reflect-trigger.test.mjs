import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installReflectTrigger, MIN_TOOL_STEPS } from '../../src/host/reflect-trigger.js'

const identityDeps = {
  getIdentityCfg: () => ({ mode: 'auto', userId: '', roleId: '', workspace: '' }),
  getIdentityHint: () => null,
  getHostUserId: () => 'host-u',
  getHostIdentityState: () => 'ready',
}

function fakeCtx() {
  const handlers = new Map()
  const ctx = {
    handlers,
    on(ev, fn) { handlers.set(ev, fn); return () => handlers.delete(ev) },
  }
  return { handlers, ctx }
}

function fakeReflect() {
  const calls = []
  return { calls, reflect: { scheduleAuto(opts) { calls.push(opts); return { ok: true, scheduled: true } } } }
}

const sessionOf = (sid, header = { cwd: '/work/ws' }) => ({ id: sid, header })

async function preStep(ctx, sid, turn, step, header) {
  const decision = { kind: 'enter' }
  const ret = await ctx.handlers.get('agent/pre-step')({ agent: { session: sessionOf(sid, header) }, turn, step, signal: {} }, async () => decision)
  assert.equal(ret, decision, 'pre-step 必须返回 next() 的 decision')
}

const toolResult = (ctx, { name = 'bash', sid = 's1', header, parent = null } = {}) => {
  ctx.handlers.get('tools/result')({ name, parent, agent: { session: sessionOf(sid, header) } }, { value: {} })
}

/** 打一个 turn：steps 个 step，每个 step 一次真实工具。 */
async function turnWithTools(ctx, { sid = 's1', turn, steps = 7, header } = {}) {
  for (let i = 1; i <= steps; i += 1) {
    await preStep(ctx, sid, turn, i, header)
    toolResult(ctx, { sid, header })
  }
}

test('7 个有工具活动的 distinct step → turn 结束触发一次；6 步不触发', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const logs = []
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: (line) => logs.push(line) })
  try {
    await turnWithTools(ctx, { turn: 1, steps: MIN_TOOL_STEPS })
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('s1') }, turn: 1 })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      identity: { userId: 'host-u', roleId: '', workspace: '/work/ws' },
      sessionId: 's1',
      reason: 'turn_steps',
    })
    assert.ok(logs.some((line) => /reflect trigger turn=1 steps=7 result=scheduled/.test(line)))

    // 下一 turn 只有 6 步：不触发，也不重复评估上一 turn。
    await turnWithTools(ctx, { turn: 2, steps: 6 })
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('s1') }, turn: 2 })
    await preStep(ctx, 's1', 3, 1)
    assert.equal(calls.length, 1, '每 turn 至多一次，不足 7 步不触发')
  } finally { trig.dispose() }
})

test('同一步并行调用 / PTC 子派发 / memory_* / run_code 都不增加 distinct step', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: () => {} })
  try {
    // 6 个真实工具步。
    await turnWithTools(ctx, { turn: 1, steps: 6 })
    // 第 7 步只有 PTC 子调用（parent）与 memory_* / run_code：不算活动。
    await preStep(ctx, 's1', 1, 7)
    toolResult(ctx, { name: 'bash', parent: { token: 'p' } })
    toolResult(ctx, { name: 'memory_search' })
    toolResult(ctx, { name: 'run_code' })
    // 同一（第 6）步的并行调用也不新增 step。
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('s1') }, turn: 1 })
    assert.equal(calls.length, 0, '6 个真实 step 不足阈值')
  } finally { trig.dispose() }
})

test('abort/error（无 turn-stopping）：下一次 pre-step turn 变化补评估上一 turn', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: () => {} })
  try {
    await turnWithTools(ctx, { turn: 4, steps: 7 })
    // 模拟 abort：不派发 turn-stopping，直接进入下一 turn 的 pre-step。
    await preStep(ctx, 's1', 5, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].reason, 'turn_steps')
  } finally { trig.dispose() }
})

test('turn-stopping 已评估后，下一 turn pre-step 不重复触发', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: () => {} })
  try {
    await turnWithTools(ctx, { turn: 1, steps: 7 })
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('s1') }, turn: 1 })
    await preStep(ctx, 's1', 2, 1)
    assert.equal(calls.length, 1)
  } finally { trig.dispose() }
})

test('子代理会话不计数、不触发', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: () => {} })
  try {
    await turnWithTools(ctx, { sid: 'sub', turn: 1, steps: 8, header: { cwd: '/work/ws', origin: 'subagent' } })
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('sub', { cwd: '/work/ws', origin: 'subagent' }) }, turn: 1 })
    assert.equal(calls.length, 0)
    assert.equal(trig.size(), 0)
  } finally { trig.dispose() }
})

test('身份不可判定：不触发，但留可见日志（不静默）', async () => {
  const { ctx } = fakeCtx()
  const { calls, reflect } = fakeReflect()
  const logs = []
  const trig = installReflectTrigger({
    ctx,
    ...identityDeps,
    getHostUserId: () => '',
    getHostIdentityState: () => 'pending',
    reflect,
    log: (line) => logs.push(line),
  })
  try {
    await turnWithTools(ctx, { turn: 1, steps: 7 })
    ctx.handlers.get('agent/turn-stopping')({ agent: { session: sessionOf('s1') }, turn: 1 })
    assert.equal(calls.length, 0)
    assert.ok(logs.some((line) => /reflect trigger turn=1 steps=7 skip=identity_required/.test(line)))
  } finally { trig.dispose() }
})

test('dispose 后反注册且清会话状态；agent/disposed 清状态', async () => {
  const { ctx, handlers } = fakeCtx()
  const { reflect } = fakeReflect()
  const trig = installReflectTrigger({ ctx, ...identityDeps, reflect, log: () => {} })
  await preStep(ctx, 's1', 1, 1)
  assert.equal(trig.size(), 1)
  handlers.get('agent/disposed')({ agent: { session: sessionOf('s1') } })
  assert.equal(trig.size(), 0)
  trig.dispose()
  assert.equal(handlers.size, 0)
})
