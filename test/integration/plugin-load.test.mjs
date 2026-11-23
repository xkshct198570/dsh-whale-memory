/**
 * R9-09 真宿主装载（发布门槛）：
 * - 用真实 cordis Context（不是假 ctx）装载插件 apply：有/无 timer 服务都不得抛；
 * - webServer.register / systemPrompt.context 必须真的被注册（hook 接线可达）；
 * - 走真实 waterfall `agent/pre-step` 灌一条规则陈述 → 候选文件落盘（提案链路可达）。
 *
 * 只读临时 DSH_HOME；不联网、不碰真实规则仓。timer 用官方 cordis-plugin-timer。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import { apply, inject } from '../../index.js'

const noopDisposer = () => () => {}

/**
 * 建一个"像宿主"的 cordis 上下文：只提供插件 inject 声明的服务，其余不提供（缺服务也要能降级）。
 * @param {{timer?:boolean}} [opts] @returns {{ctx:Context, calls:object[]}}
 */
function hostContext({ timer = false } = {}) {
  const ctx = new Context()
  const calls = []
  if (timer) ctx.plugin(TimerService)
  ctx.provide('webServer', {
    register: (route) => {
      calls.push({ kind: 'webServer.register', path: route?.path, mode: route?.kind })
      return noopDisposer()
    },
  })
  ctx.provide('systemPrompt', {
    section: (entry) => { calls.push({ kind: 'systemPrompt.section', name: entry?.name }); return noopDisposer() },
    context: (entry) => { calls.push({ kind: 'systemPrompt.context', name: entry?.name }); return noopDisposer() },
  })
  return { ctx, calls }
}

/** 插件 config 最小可用集（identity 必填：缺 cfg 时 resolveIdentity 直接拒绝）。 */
function configOf(home) {
  return {
    backend: { mode: 'local' },
    dataDir: home,
    identity: { mode: 'auto' },
    recall: { enabled: false },
    rules: { enabled: true, dir: join(home, 'rules') },
  }
}

for (const timer of [false, true]) {
  test(`R9-09：真宿主装载（${timer ? '有' : '无'} timer）——apply 不抛、hook 注册、提案链路可达`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'whale-host-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const logs = []
    t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')) })

    const { ctx, calls } = hostContext({ timer })
    assert.doesNotThrow(() => apply(ctx, configOf(home)), 'apply 在真宿主里不得抛错')
    const service = ctx.get('whaleMemory')
    assert.ok(service && typeof service.invalidateCache === 'function', 'whaleMemory 服务必须注册')

    // 接线证据：路由前缀 + 注入 context 都必须注册（hook 不是"只在日志里说装了"）。
    assert.ok(calls.some((call) => call.kind === 'webServer.register' && call.path === '/whale-memory/api' && call.mode === 'prefix'),
      JSON.stringify(calls))
    assert.ok(calls.some((call) => call.kind === 'systemPrompt.context'), JSON.stringify(calls))

    // 提案链路：真实 waterfall（listener 的最后参数是 next）。一条标准规则陈述必须产出候选文件。
    const decision = await ctx.waterfall('agent/pre-step', {
      agent: { session: { id: 's-host-load', header: {} } },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '以后都别删源文件' }] }],
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter' }))
    assert.equal(decision?.kind, 'enter', 'waterfall 必须把 decision 原样传回')
    // 提案在 setImmediate 里落盘：等到文件或超时，避免拿"还没跑完"当失败。
    const proposalsDir = join(home, 'rules', 'proposals')
    for (let i = 0; i < 40 && !(existsSync(proposalsDir) && readdirSync(proposalsDir).some((name) => name.endsWith('.json'))); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const files = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter((name) => name.endsWith('.json')) : []
    assert.equal(files.length, 1, `规则陈述必须产出候选：${JSON.stringify(logs.slice(-5))}`)
    assert.ok(logs.some((line) => line.includes('rules proposal id=')), `日志必须打 proposal id：${JSON.stringify(logs.slice(-5))}`)
  })
}

test('R9-09：宿主缺 llm/模型选择时降级为 null 且不抛（fail-open 可观察）', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-host-degrade-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => {})
  const { ctx } = hostContext()
  assert.doesNotThrow(() => apply(ctx, configOf(home)))
  assert.equal(ctx.get('llm') ?? null, null, '缺 llm 服务时读到的必须是空值（不是抛错）')
  assert.equal(inject.includes('llm'), false, 'llm 不得进入 inject（可选依赖必须降级，不能硬依赖）')
})
