/**
 * R9-19 提案闸（hook 路径）：任务书/提问不建候选、不追加提示行；单句规则陈述仍提案。
 *
 * 用 cordis 风格 ctx（不读 timer 服务）+ 临时规则目录，不碰真实规则仓。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../../src/host/hook.js'
import { listProposals } from '../../src/core/rule-proposal.js'

function cordisLikeCtx() {
  const state = { pre: null, context: null }
  const base = {
    on(event, fn) {
      if (event === 'agent/pre-step') state.pre = fn
      return () => { if (event === 'agent/pre-step') state.pre = null }
    },
    systemPrompt: { context(def) { state.context = def; return () => {} } },
    effect(fn) { return fn() },
    get() { return null },
  }
  return { ctx: base, state }
}

function freshRulesDir(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-proposal-gate-hook-'))
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

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const TASK_BOOK = '你是鲸忆插件（/home/hy/dsh-whale-memory）的实现工程师。请你按设计文档 v3.10 §2.5/§3.1/§3.2 与计划 v2.0 修 P0/P1：确认整句锚定与提案闸，审查铁律10 只作引用，对比 rule-store 与 rules-routes 的取号路径，分析墓碑闸与 affected_inactive，解释编号单一真源；不许改 client.js、routes 层、locale、persona 仓，禁止 git commit/push，禁止对真实规则仓写。补充完善细节'

test('提案闸：任务书原文（253 字）不产候选、不追加提示行', async (t) => {
  const rulesDir = freshRulesDir(t)
  const { ctx, state } = cordisLikeCtx()
  const logs = []
  const hook = installHook(ctx, {
    backend: { async recall() { return { prefix: '【你想到的旧事】某条记忆', hits: 1 } } },
    config: cfg(rulesDir),
    log: (line) => logs.push(String(line)),
  })
  t.after(() => hook.dispose())

  await state.pre(preStepPayload(TASK_BOOK), async () => ({ kind: 'enter' }))
  await flush()
  assert.deepEqual(listProposals({ rulesDir }).proposals, [], '任务书不得产候选')
  assert.equal(logs.some((line) => line.includes('rules proposal id=')), false, '不得留"提案成功"日志')
  const injected = state.context.text({ scope: { session: { id: 's1' } } })
  assert.equal(/【规则候选】/.test(injected), false, '不得追加候选提示行')
  assert.equal(/收录 p[0-9a-f]{8}/.test(injected), false, '不得追加 nonce 提示')
})

test('提案闸：任务书之后单句规则陈述仍产候选并给出 nonce', async (t) => {
  const rulesDir = freshRulesDir(t)
  const { ctx, state } = cordisLikeCtx()
  const logs = []
  const hook = installHook(ctx, {
    backend: { async recall() { return { prefix: '', hits: 0 } } },
    config: cfg(rulesDir),
    log: (line) => logs.push(String(line)),
  })
  t.after(() => hook.dispose())

  await state.pre(preStepPayload(TASK_BOOK), async () => ({ kind: 'enter' }))
  await flush()
  assert.equal(listProposals({ rulesDir }).proposals.length, 0)

  await state.pre(preStepPayload('以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flush()
  const proposals = listProposals({ rulesDir }).proposals
  assert.equal(proposals.length, 1, '单句规则陈述必须产候选')
  assert.equal(proposals[0].status, 'pending')
  assert.match(state.context.text({ scope: { session: { id: 's1' } } }), /【规则候选】/)
  assert.match(state.context.text({ scope: { session: { id: 's1' } } }), /回复「收录 p[0-9a-f]{8}」确认收进铁律/)
  assert.ok(logs.some((line) => line.includes('rules proposal id=')))
})
