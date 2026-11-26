/**
 * 首轮画像注入（profile-context）契约：每会话一次、≤800 码点、装配零 IO、子代理/身份缺失/中止跳过、
 * 第二轮不再出现、agent/disposed 清缓存、缓存上限淘汰、context 顺序 129 < 召回 130。
 *
 * 口径：用假 ctx 驱动真 waterfall（逐个 listener 传 next），假 backend 计数以证明"装配阶段零查询"；
 * 预算/整条跳过断言渲染产物本身（不只看函数返回值长度）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPromptService, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { installProfileContext, PROFILE_CHAR_BUDGET, PROFILE_CONTEXT_NAME, PROFILE_CONTEXT_ORDER } from '../../src/host/profile-context.js'
import { CONTEXT_ORDER as RECALL_ORDER } from '../../src/host/hook.js'

const HEADER = { cwd: '/tmp/whale-profile-ws' }
const chars = (text) => Array.from(String(text ?? '')).length

/** 会话 agent（真实宿主形状：session.id + session.header）。 */
function agentOf(id = 's1', header = HEADER) {
  return { session: { id, header } }
}

/** 假后端：记录每次取数（装配阶段必须零调用）。 */
function stubBackend(groups, { fail = false } = {}) {
  const calls = []
  return {
    calls,
    async profileLayers(limits, opts) {
      calls.push({ limits, identity: opts?.identity })
      if (fail) throw new Error('db_unavailable')
      return groups
    },
  }
}

/** 假 ctx：事件表 + systemPrompt.context 注册面（不依赖宿主运行时）。 */
function fakeHost({ backend = stubBackend({}), header = HEADER, hostUserId = 'u1', identityCfg = { mode: 'auto' }, systemPrompt = true } = {}) {
  const listeners = new Map()
  const contexts = []
  const logs = []
  const disposers = []
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      const off = () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
      return off
    },
    systemPrompt: systemPrompt ? {
      context(definition) {
        contexts.push(definition)
        const off = () => {
          const index = contexts.indexOf(definition)
          if (index >= 0) contexts.splice(index, 1)
        }
        return off
      },
    } : undefined,
  }
  const host = {
    ctx,
    backend,
    header,
    logs,
    contexts,
    listeners,
    install() {
      const profile = installProfileContext({
        ctx,
        backend,
        getIdentityCfg: () => identityCfg,
        getIdentityHint: () => null,
        getHostUserId: () => hostUserId,
        log: (line) => logs.push(String(line)),
      })
      disposers.push(profile)
      return profile
    },
    /** 真 waterfall 形状：逐个 listener 传 next（本插件 listener 必须原样透传 decision）。 */
    async preStep(agent, { turn = 1, step = 1, aborted = false } = {}) {
      const payload = {
        agent, turn, step, messages: [],
        signal: { get aborted() { return aborted }, addEventListener() {}, removeEventListener() {} },
      }
      let decision = { kind: 'enter' }
      for (const handler of [...(listeners.get('agent/pre-step') || [])]) {
        const current = decision
        decision = await handler(payload, async () => current)
      }
      return decision
    },
    disposeAgent(agent) {
      for (const handler of [...(listeners.get('agent/disposed') || [])]) handler({ agent })
    },
    /** 真宿主在 turn/end 时派发 session/event（profile 靠它在本轮结束后摘 active）。 */
    endTurn(agent, turn = 1) {
      for (const handler of [...(listeners.get('session/event') || [])]) {
        handler(agent?.session, { type: 'turn/end', seq: 1, time: 1, data: { turn } })
      }
    },
    /** 装配阶段求值：当前注册的 profile context 文本。 */
    assemble(sessionId) {
      const definition = contexts.find((item) => item.name === PROFILE_CONTEXT_NAME)
      if (!definition) return ''
      return definition.text({ scope: { session: { id: sessionId } } })
    },
  }
  return host
}

const GROUPS = {
  user: [{ id: 'u1', text: '基线只在全绿后刷新', layer: 'user' }, { id: 'u2', text: '先跑门禁再提交', layer: 'user' }],
  lesson: [{ id: 'l1', text: '动库前必须先备份', layer: 'lesson' }],
  fact: [{ id: 'f1', text: '网关端口是 3982', layer: 'fact' }],
}

test('首轮注入：三类条目成块、≤800 码点；同轮多 step 不重查；第二轮不再出现', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  host.install()
  const agent = agentOf('s1')

  await host.preStep(agent, { turn: 1, step: 1 })
  const text = host.assemble('s1')
  assert.match(text, /^【长期画像】/)
  assert.match(text, /偏好：基线只在全绿后刷新；先跑门禁再提交/)
  assert.match(text, /教训：动库前必须先备份/)
  assert.match(text, /事实：网关端口是 3982/)
  assert.ok(chars(text) <= PROFILE_CHAR_BUDGET, `画像不得超预算：${chars(text)}`)
  assert.equal(backend.calls.length, 1)
  assert.deepEqual(backend.calls[0].limits, { user: 5, lesson: 5, fact: 3 }, '取数上限必须按契约')
  assert.equal(backend.calls[0].identity.workspace, HEADER.cwd, '身份来自会话 cwd 派生')

  // 同轮第二步：文本不变、不重查。
  await host.preStep(agent, { turn: 1, step: 2 })
  assert.equal(host.assemble('s1'), text)
  assert.equal(backend.calls.length, 1)

  // 第二轮：预步骤摘掉 active，请求里不得再出现画像。
  await host.preStep(agent, { turn: 2, step: 1 })
  assert.equal(host.assemble('s1'), '')
  assert.equal(backend.calls.length, 1, '第二轮不得重新查库')
})

test('子代理/身份缺失/中止：跳过且零后端调用', async () => {
  {
    const backend = stubBackend(GROUPS)
    const host = fakeHost({ backend })
    host.install()
    await host.preStep(agentOf('sub1', { cwd: HEADER.cwd, origin: 'subagent' }), { turn: 1 })
    assert.equal(host.assemble('sub1'), '')
    assert.equal(backend.calls.length, 0, '子代理不得查画像')
  }
  {
    const backend = stubBackend(GROUPS)
    const host = fakeHost({ backend })
    host.install()
    await host.preStep(agentOf('sub2', { cwd: HEADER.cwd, delegationDepth: 2 }), { turn: 1 })
    assert.equal(host.assemble('sub2'), '')
    assert.equal(backend.calls.length, 0, 'delegationDepth 变体同样算子代理')
  }
  {
    const backend = stubBackend(GROUPS)
    const host = fakeHost({ backend })
    host.install()
    await host.preStep(agentOf('no-ws', {}), { turn: 1 })
    assert.equal(host.assemble('no-ws'), '')
    assert.equal(backend.calls.length, 0, '身份不可判定不得查画像')
  }
  {
    const backend = stubBackend(GROUPS)
    const host = fakeHost({ backend })
    host.install()
    await host.preStep(agentOf('ab1'), { turn: 1, aborted: true })
    assert.equal(host.assemble('ab1'), '')
    assert.equal(backend.calls.length, 0, '中止的预步骤不得启动查询')
  }
})

test('空库：注入空块且只查一次（不注入空标题）', async () => {
  const backend = stubBackend({ user: [], lesson: [], fact: [] })
  const host = fakeHost({ backend })
  host.install()
  const agent = agentOf('s-empty')
  await host.preStep(agent, { turn: 1, step: 1 })
  assert.equal(host.assemble('s-empty'), '')
  await host.preStep(agent, { turn: 1, step: 2 })
  assert.equal(backend.calls.length, 1, '空结果也必须记住，不能每 step 重查')
})

test('预算：超预算条目整条跳过（不截半句），后续小条目仍可进入', async () => {
  const long = '超长偏好'.repeat(200) // 800 码点：单独一条就超预算
  const backend = stubBackend({
    user: [
      { id: 'u1', text: '短偏好甲', layer: 'user' },
      { id: 'u2', text: long, layer: 'user' },
      { id: 'u3', text: '短偏好乙', layer: 'user' },
    ],
    lesson: [{ id: 'l1', text: '短教训', layer: 'lesson' }],
    fact: [],
  })
  const host = fakeHost({ backend })
  host.install()
  await host.preStep(agentOf('s-budget'), { turn: 1 })
  const text = host.assemble('s-budget')
  assert.ok(chars(text) <= PROFILE_CHAR_BUDGET, `整块必须 ≤800：${chars(text)}`)
  assert.ok(!text.includes(long), '超预算条目必须整条跳过，不得截半句')
  assert.equal(text.includes('短偏好甲'), true)
  assert.equal(text.includes('短偏好乙'), true, '跳过超长条目后，后续小条目仍应进入')
  assert.equal(text.includes('短教训'), true)
})

test('装配零 IO：反复求值 context 文本不触发后端调用', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  host.install()
  await host.preStep(agentOf('s-io'), { turn: 1 })
  const first = host.assemble('s-io')
  for (let i = 0; i < 5; i += 1) assert.equal(host.assemble('s-io'), first)
  assert.equal(backend.calls.length, 1, '装配阶段只读缓存，不得查库')
})

test('顺序契约：画像 order=129 且紧在召回（130）之前；名字独立不抢召回', () => {
  const host = fakeHost({ backend: stubBackend({}) })
  host.install()
  const definition = host.contexts.find((item) => item.name === PROFILE_CONTEXT_NAME)
  assert.ok(definition, '必须注册 whale-memory:profile')
  assert.equal(PROFILE_CONTEXT_ORDER, 129)
  assert.equal(definition.order, PROFILE_CONTEXT_ORDER)
  assert.ok(definition.order < RECALL_ORDER, '画像必须先于召回')
  assert.equal(definition.interpolate, false, '画像文案不得参与变量插值')
})

test('agent/disposed 清缓存：会话结束后文本为空、条目清零', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  const profile = host.install()
  const agent = agentOf('s-disposed')
  await host.preStep(agent, { turn: 1 })
  assert.equal(profile.size(), 1)
  host.disposeAgent(agent)
  assert.equal(profile.size(), 0)
  assert.equal(host.assemble('s-disposed'), '')
})

test('缓存上限 200：超限淘汰最早会话（不无限增长）', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  const profile = host.install()
  for (let i = 0; i < 205; i += 1) await host.preStep(agentOf(`cap-${i}`), { turn: 1 })
  assert.equal(profile.size(), 200)
  assert.equal(host.assemble('cap-0'), '', '最早的会话必须被淘汰')
  assert.equal(host.assemble('cap-204'), host.assemble('cap-204'))
  assert.match(host.assemble('cap-204'), /【长期画像】/, '最新会话仍应命中')
  assert.equal(backend.calls.length, 205)
})

test('查询失败 fail-open：注入空块、留日志、同会话不重试', async () => {
  const backend = stubBackend(GROUPS, { fail: true })
  const host = fakeHost({ backend })
  host.install()
  const agent = agentOf('s-fail')
  await host.preStep(agent, { turn: 1 })
  assert.equal(host.assemble('s-fail'), '')
  assert.ok(host.logs.some((line) => line.includes('profile query fail-open')), '失败必须留痕而不是静默')
  await host.preStep(agent, { turn: 1, step: 2 })
  assert.equal(backend.calls.length, 1, '同会话失败不重试（避免每 step 重扫库）')
})

test('dispose：反注册 context 与监听器，之后不再注入', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  const profile = host.install()
  const agent = agentOf('s-dispose')
  await host.preStep(agent, { turn: 1 })
  assert.match(host.assemble('s-dispose'), /【长期画像】/)
  profile.dispose()
  assert.equal(host.contexts.length, 0)
  assert.equal(host.listeners.get('agent/pre-step')?.length ?? 0, 0)
  assert.equal(host.listeners.get('agent/disposed')?.length ?? 0, 0)
  assert.equal(host.listeners.get('session/event')?.length ?? 0, 0)
  assert.equal(host.assemble('s-dispose'), '')
})


test('真库端到端：写入的 user/lesson/fact 节点在首轮请求里按分组出现，NULL/他人分区不出现', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-profile-e2e-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const identity = { userId: 'u1', roleId: '', workspace: resolve(HEADER.cwd) }
  const seed = [
    { text: '发布前必须跑全量门禁', layer: 'lesson' },
    { text: '基线只在全绿后刷新', layer: 'user' },
    { text: '网关端口是 3982', layer: 'fact' },
    { text: '未分层的老节点不该进画像', layer: null },
    { text: '别人分区的偏好', layer: 'user', identity: { userId: 'u2', roleId: '', workspace: resolve(HEADER.cwd) } },
  ]
  for (const row of seed) {
    const res = await backend.write({
      text: row.text, identity: row.identity || identity,
      ...(row.layer ? { layer: row.layer } : {}),
    })
    assert.equal(res.ok, true, `seed 写入失败：${row.text}`)
  }

  const host = fakeHost({ backend })
  host.install()
  await host.preStep(agentOf('s-e2e'), { turn: 1 })
  const text = host.assemble('s-e2e')
  assert.match(text, /教训：发布前必须跑全量门禁/)
  assert.match(text, /偏好：基线只在全绿后刷新/)
  assert.match(text, /事实：网关端口是 3982/)
  assert.equal(text.includes('未分层的老节点不该进画像'), false)
  assert.equal(text.includes('别人分区的偏好'), false)
  assert.ok(chars(text) <= PROFILE_CHAR_BUDGET)
})


test('第二轮在 next() 之前摘掉 active：默认处理器投影时已不含画像（防跨轮残留）', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  host.install()
  const agent = agentOf('s-order')
  await host.preStep(agent, { turn: 1 })
  assert.match(host.assemble('s-order'), /【长期画像】/)
  const handler = host.listeners.get('agent/pre-step')[0]
  const seenAtNext = []
  const decision = await handler(
    { agent, turn: 2, step: 1, signal: { aborted: false } },
    async () => {
      // 默认处理器就是在这一步把 assembly 投影成 runtime-context 消息的。
      seenAtNext.push(host.assemble('s-order'))
      return { kind: 'enter' }
    },
  )
  assert.deepEqual(seenAtNext, [''], '第二轮投影时必须已摘掉 active')
  assert.equal(decision.kind, 'enter')
  assert.equal(backend.calls.length, 1)
})

test('宿主无 systemPrompt 面：不装监听器、不查库，只留一条不可用日志', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend, systemPrompt: false })
  const profile = host.install()
  assert.equal(profile.size(), 0)
  assert.equal(host.listeners.get('agent/pre-step')?.length ?? 0, 0, '没有注入面时不得白装监听器')
  assert.match(host.logs.join('\n'), /profile context unavailable/)
  await host.preStep(agentOf('s-nosp'), { turn: 1 })
  assert.equal(backend.calls.length, 0)
  assert.equal(profile.textOf({ scope: { session: { id: 's-nosp' } } }), '')
})


test('turn/end 即摘 active：下一轮装配期（assemble 先于 pre-step）就不带画像', async () => {
  const backend = stubBackend(GROUPS)
  const host = fakeHost({ backend })
  host.install()
  const agent = agentOf('s-turnend')
  await host.preStep(agent, { turn: 1 })
  assert.match(host.assemble('s-turnend'), /【长期画像】/)
  host.endTurn(agent, 1)
  assert.equal(host.assemble('s-turnend'), '', 'turn/end 后装配期必须已为空（第二轮不出现）')
  await host.preStep(agent, { turn: 2 })
  assert.equal(host.assemble('s-turnend'), '')
  assert.equal(backend.calls.length, 1)
})

test('真 SystemPrompt 机制：装配期解析为空 → refreshContext 带画像；turn/end 后下一轮装配即无画像', async () => {
  const ctx = new Context()
  ctx.plugin(SystemPromptService)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const backend = stubBackend(GROUPS)
  const logs = []
  installProfileContext({
    ctx, backend,
    getIdentityCfg: () => ({ mode: 'auto' }),
    getIdentityHint: () => null,
    getHostUserId: () => 'u1',
    log: (line) => logs.push(line),
  })
  const agent = { session: { id: 'mech-1', header: HEADER } }
  const scope = agent
  const firstAssembly = await ctx.systemPrompt.assemble({ scope })
  // rc.5 的顺序是 assemble 先于 pre-step：装配阶段 provider 求值必须是空（不查库、不提前注入）。
  assert.deepEqual(renderContextSections(firstAssembly).filter((s) => s.text), [])
  await ctx.waterfall('agent/pre-step', {
    agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' }))
  const firstRequest = renderContextSections(ctx.systemPrompt.refreshContext(firstAssembly, { scope }))
  assert.match(firstRequest.map((s) => s.text).join('\n'), /【长期画像】/, '首轮请求必须带画像')
  // turn/end 在下一轮 assemble 前落盘：第二轮从装配期就不带画像。
  ctx.emit('session/event', agent.session, { type: 'turn/end', seq: 42, time: 42, data: { turn: 1 } })
  const secondAssembly = await ctx.systemPrompt.assemble({ scope })
  const secondRequest = renderContextSections(ctx.systemPrompt.refreshContext(secondAssembly, { scope }))
  assert.equal(secondRequest.some((s) => s.text.includes('【长期画像】')), false, '第二轮不得带画像')
  assert.equal(backend.calls.length, 1, '每会话只查一次')
  assert.ok(logs.some((line) => line.includes('profile injected chars=')))
})

test('查询期间被中止：不写缓存、不标注入（该会话下一轮仍可重试）', async () => {
  let aborted = false
  const backend = {
    calls: 0,
    async profileLayers() { this.calls += 1; aborted = true; return GROUPS },
  }
  const host = fakeHost({ backend })
  const profile = host.install()
  const agent = agentOf('s-late-abort')
  const handler = host.listeners.get('agent/pre-step')[0]
  await handler(
    { agent, turn: 1, step: 1, signal: { get aborted() { return aborted } } },
    async () => ({ kind: 'enter' }),
  )
  assert.equal(profile.size(), 0, '中止的查询结果不得进缓存')
  assert.equal(host.assemble('s-late-abort'), '')
  assert.equal(backend.calls, 1)
})

test('后端无 profileLayers（http/远端）：不装监听器、不查库，只留一条不可用日志', async () => {
  const host = fakeHost({ backend: { calls: 0 } })
  const profile = host.install()
  assert.equal(profile.size(), 0)
  assert.equal(host.listeners.get('agent/pre-step')?.length ?? 0, 0)
  assert.match(host.logs.join('\n'), /profile unavailable: backend has no profileLayers/)
})
