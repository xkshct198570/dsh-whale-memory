// apply 守卫/审计/LLM 改写接线（dropped·acknowledge·no_model）；依赖 rule-proposal-harness.mjs 的临时规则根，不 import 其它测试文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRules, listTxns, readRule, regenerateManifest, writeRule, writeTombstone } from '../../src/core/rule-store.js'
import { compileStructured } from '../../src/core/rule-reconcile.js'
import {
  applyProposal,
  buildProposalAskLine,
  clearSessionPending,
  confirmNonceOf,
  confirmPendingForSession,
  createProposal,
  detectConfirmIntent,
  listProposals,
  readProposal,
  proposalNonce,
  rejectProposal,
  resetSessionPending,
  SESSION_PENDING_TTL_MS,
  getSessionPending,
  setSessionPending,
} from '../../src/core/rule-proposal.js'
import { buildApplyPlan } from '../../src/core/rule-plan.js'
import { IDENTITY, fakeBackend, fakeGit, freshRoot, frontOf, jsonFile, readRuleText, ruleFiles, seed } from './rule-proposal-harness.mjs'

test('applyProposal：守卫失败 → rule_guard_failed + needs_manual，且不落规则文件', async (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'merge')
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: { text: '源文件必须保留，过程稿归档到临时目录。' }, // 丢了旧例外
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'rule_guard_failed')
  assert.equal(result.status, 'needs_manual')
  assert.ok(result.failures.some((f) => f.code === 'dropped_exception'))
  assert.equal(ruleFiles(root).length, 1, '拒绝时不得写新规则')
  const disk = jsonFile(root, `${made.proposal.id}.json`)
  assert.equal(disk.status, 'needs_manual')
  assert.equal(disk.needsManual.code, 'rule_guard_failed')
})

test('applyProposal：合并需要改写但 rules.llm=false → llm_unavailable + needs_manual', async (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: { llm: false } }, git: false })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'llm_unavailable')
  assert.equal(result.status, 'needs_manual')
  assert.equal(ruleFiles(root).length, 1)
})

test('applyProposal：acknowledgeDropped 子句粒度——strict 拒绝，非 strict 逐子句确认才放行', async (t) => {
  const root = freshRoot(t)
  seed(root, { number: 5, exceptions: ['用户原件'] })
  const made = createProposal({
    text: '按 rule:rule-src-keep 源文件必须保留，例外：用户原件', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'refine')
  const strict = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { guardStrict: true } },
    git: false,
    decisions: { text: '源文件必须保留。', acknowledgeDropped: [{ key: 'rule-src-keep', clauses: ['用户原件'] }] },
  })
  assert.equal(strict.ok, false)
  assert.equal(strict.error, 'rule_guard_failed')

  const lax = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { guardStrict: false } },
    git: false,
    decisions: { text: '源文件必须保留。', acknowledgeDropped: [{ key: 'rule-src-keep', clauses: ['用户原件'] }] },
  })
  assert.equal(lax.ok, true, JSON.stringify({ err: lax.error, failures: lax.failures }))
  const kept = readRule(root, 'rule-src-keep')
  assert.equal(kept.ok, true)
  assert.equal(kept.rule.text.includes('用户原件'), false, 'owner 显式确认后允许丢弃例外')
  assert.deepEqual(kept.rule.front.exceptions, [], 'front 例外不得与正文漂移')
})

test('applyProposal：守卫失败 → needs_manual 保留 failures，面板 pending,needs_manual 可见，改写后重试成功', async (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const failed = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: { text: '源文件必须保留，过程稿归档到临时目录。' },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'rule_guard_failed')
  const disk = jsonFile(root, `${made.proposal.id}.json`)
  assert.equal(disk.status, 'needs_manual')
  assert.ok(disk.needsManual.failures.some((item) => item.code === 'dropped_exception'), '失败项必须留档')
  const visible = listProposals({ rulesDir: root, config: { rules: {} }, status: 'pending,needs_manual' })
  assert.ok(visible.proposals.some((item) => item.id === made.proposal.id), 'needs_manual 必须出现在面板查询')
  // 面板改稿后重试：同一个候选、同一个入口，成功即 accepted。
  const retried = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: { text: '源文件必须保留，过程稿归档到临时目录；例外：正在被引用的文件。' },
  })
  assert.equal(retried.ok, true, JSON.stringify({ err: retried.error, failures: retried.failures }))
  assert.equal(retried.proposal.status, 'accepted')
})

test('R9-14：审计 beforeText 取锁内旧正文（refine 不记成新建）', async (t) => {
  const root = freshRoot(t)
  seed(root, { type: 'iron-rule', number: 5, exceptions: ['用户原件'] }, '源文件必须保留。')
  const oldText = readRule(root, 'rule-src-keep').rule.text
  const made = createProposal({
    text: '按 rule:rule-src-keep 记成铁律：源文件必须保留，例外：用户原件',
    identity: IDENTITY,
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'refine')
  const backend = fakeBackend()
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    backend,
    decisions: { text: '源文件必须保留，例外：用户原件。' },
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  const writesRun = backend.calls.find((call) => call.kind === 'run' && /INSERT INTO writes/.test(call.sql))
  assert.ok(writesRun, '必须写 writes 审计')
  // 列序：ts,trace_id,action,node_id,reason,before_text,after_text,… → before_text = args[5]
  assert.equal(writesRun.args[5], oldText, 'beforeText 必须是磁盘旧正文，不是空串')
})

test('R9-14：acknowledgeDropped 旧布尔形状被明确拒绝（不静默放行）', async (t) => {
  const root = freshRoot(t)
  seed(root, { number: 5, exceptions: ['用户原件'] })
  const made = createProposal({
    text: '按 rule:rule-src-keep 源文件必须保留，例外：用户原件', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { guardStrict: false } },
    git: false,
    decisions: { text: '源文件必须保留。', acknowledgeDropped: true },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid_acknowledge')
})

test('R9-10：LLM 改写缺 provider/model → needs_manual(no_model)，且不调用模型', async (t) => {
  const root = freshRoot(t)
  seed(root, { type: 'iron-rule', number: 5, exceptions: ['用户原件'] }, '源文件必须保留，例外：用户原件。')
  const made = createProposal({
    text: '按 rule:rule-src-keep 记成铁律：源文件必须保留，例外：用户原件', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'refine')
  const calls = []
  const llm = { chat: async (args) => { calls.push(args); return '{"merged_text":"源文件必须保留。"}' } }
  const out = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { llm: true } },
    git: false,
    getLlm: () => llm,
    getSelection: () => ({}),
  })
  assert.equal(out.ok, false)
  assert.equal(out.status, 'needs_manual')
  assert.equal(out.code, 'no_model')
  assert.equal(calls.length, 0, '缺 selection 不得猜测默认模型去调用')
})

test('R9-10：面板 LLM 接线——provider/model 透传到 llm.chat', async (t) => {
  const root = freshRoot(t)
  seed(root, { type: 'iron-rule', number: 5, exceptions: ['用户原件'] }, '源文件必须保留，例外：用户原件。')
  const made = createProposal({
    text: '按 rule:rule-src-keep 记成铁律：源文件必须保留，例外：用户原件', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const calls = []
  const llm = { chat: async (args) => { calls.push(args); return JSON.stringify({ merged_text: '源文件必须保留，例外：用户原件。', affected: [] }) } }
  const out = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { llm: true } },
    git: false,
    getLlm: () => llm,
    getSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  })
  assert.equal(out.ok, true, JSON.stringify({ err: out.error, failures: out.failures }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek')
  assert.equal(calls[0].model, 'deepseek-chat')
  assert.ok(calls[0].system, 'prompt.system 必须随调用下发（防正文指令污染）')
})
