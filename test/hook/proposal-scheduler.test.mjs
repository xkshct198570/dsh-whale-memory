/**
 * R9-01 回归：提案检测的调度不得触碰宿主 ctx 的 timer 服务。
 *
 * 真实 cordis 里 `ctx.setTimeout` 是 `timer` 服务的 mixin accessor；插件 inject 没有 timer 时
 * **属性读取本身就会抛** `cannot get property "timer" without inject`。旧实现用
 * `typeof ctx?.setTimeout` 探测，throw 在 try 外，冒泡后被外层误记成 `recall fail-open`，
 * 聊天侧提案在真机从未成功。这里用 Proxy 复刻 accessor 语义，锁住"零读取、仍能提案"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../../src/host/hook.js'
import { listProposals } from '../../src/core/rule-proposal.js'

/** cordis 风格 ctx：读 setTimeout/timer 一律抛，模拟"未 inject timer"。 */
function cordisLikeCtx() {
  const state = { pre: null, context: null, reads: { setTimeout: 0, timer: 0 } }
  const base = {
    on(event, fn) {
      if (event === 'agent/pre-step') state.pre = fn
      return () => { if (event === 'agent/pre-step') state.pre = null }
    },
    systemPrompt: { context(def) { state.context = def; return () => {} } },
    effect(fn) { return fn() },
    get() { return null },
  }
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'setTimeout' || prop === 'timer') {
        state.reads[prop] += 1
        throw new Error('cannot get property "timer" without inject')
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  return { ctx, state }
}

function freshRulesDir(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-proposal-scheduler-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return join(home, 'rules')
}

function cfg(rulesDir) {
  return {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
    rules: { enabled: true, dir: rulesDir, askMode: 'panel+chat', llm: false },
  }
}

function preStepPayload(text) {
  return {
    agent: { session: { id: 's1', header: {} } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }
}

/** 等 setImmediate 队列跑完：提案检测现在是宿主无关异步调度。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('提案调度：ctx.setTimeout 读取即抛也不崩，候选仍落盘并给出 nonce', async (t) => {
  const rulesDir = freshRulesDir(t)
  const { ctx, state } = cordisLikeCtx()
  const logs = []
  const hook = installHook(ctx, {
    backend: { async recall() { return { prefix: '【你想到的旧事】某条记忆', hits: 1 } } },
    config: cfg(rulesDir),
    log: (line) => logs.push(String(line)),
  })
  t.after(() => hook.dispose())

  await state.pre(preStepPayload('以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flush()

  const proposals = listProposals({ rulesDir }).proposals
  assert.equal(proposals.length, 1, '候选必须落盘')
  assert.equal(proposals[0].status, 'pending')
  assert.match(state.context.text({ scope: { session: { id: 's1' } } }), /回复「收录 p[0-9a-z]{8}」确认收进铁律/)
  assert.ok(logs.some((line) => line.includes('rules proposal id=')), '必须留提案成功日志')
  assert.equal(logs.some((line) => line.includes('recall fail-open')), false, '不得再误记成 recall 失败')
  assert.equal(state.reads.setTimeout, 0, '不得读取 ctx.setTimeout（cordis accessor 会抛）')
  assert.equal(state.reads.timer, 0, '不得读取 ctx.timer')
})

test('提案调度：offerProposal 自身异常只记 rules proposal fail-open，不污染 pre-step', async (t) => {
  const rulesDir = freshRulesDir(t)
  const { ctx, state } = cordisLikeCtx()
  const logs = []
  // 只让 askMode 的读取抛：offerProposal 第一行即命中，异常必须被第 5 步独立 catch 接住。
  const base = cfg(rulesDir)
  const rulesProxy = new Proxy(base.rules, {
    get(target, prop, receiver) {
      if (prop === 'askMode') throw new Error('askMode boom')
      return Reflect.get(target, prop, receiver)
    },
  })
  const hook = installHook(ctx, {
    backend: { async recall() { return { prefix: '', hits: 0 } } },
    config: { ...base, rules: rulesProxy },
    log: (line) => logs.push(String(line)),
  })
  t.after(() => hook.dispose())

  await assert.doesNotReject(
    state.pre(preStepPayload('以后都别删源文件'), async () => ({ kind: 'enter' })),
    'pre-step 不得因提案异常而抛',
  )
  assert.ok(logs.some((line) => line.includes('rules proposal fail-open')), '必须打独立标签')
  assert.equal(logs.some((line) => line.includes('recall fail-open')), false)
  assert.equal(logs.some((line) => line.includes('pre-step fail-open')), false)
})
