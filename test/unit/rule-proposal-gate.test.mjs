/**
 * R9-19 提案闸 / 确认整句化 / 铁律引用（P0）回归。
 *
 * - `confirmNonceOf` 必须整句锚定：提示行原文、带问号、日志查询句、额外文字都不算确认；
 * - `isRuleStatement`：任务书/提问/长文不进入提案（hook 在 createProposal 之前调用）；
 * - `铁律N` 只作引用：纯引用不得按引用号造 key；
 * - 候选创建前查 key 全仓唯一与 occupancy()，注定冲突的候选不落盘。
 *
 * 全部临时规则目录，不碰真实规则仓，不依赖 git。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProposal, confirmNonceOf, listProposals } from '../../src/core/rule-proposal.js'
import { compileStructured, extractExplicitRef } from '../../src/core/rule-reconcile.js'
import { isRuleStatement } from '../../src/core/rules.js'
import { applyProposal } from '../../src/core/rule-proposal.js'
import { writeRule, writeTombstone } from '../../src/core/rule-store.js'

const IDENTITY = { userId: 'u1', roleId: 'reviewer', workspace: '' }

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-proposal-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function frontOf(overrides = {}) {
  return {
    key: 'rule-src-keep',
    type: 'rule',
    number: null,
    priority: 'P1',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '保留',
    object: '源文件',
    conditions: [],
    exceptions: [],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-23',
    updated: '2026-11-23',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

function seed(root, overrides = {}, text = '源文件必须保留。') {
  const got = writeRule(root, { front: frontOf(overrides), text }, { git: false })
  assert.equal(got.ok, true, JSON.stringify(got.detail || got.error))
  return got
}

/** 今次任务书原文（253 码点，含「请你…审查…铁律10」）。 */
const TASK_BOOK = '你是鲸忆插件（/home/hy/dsh-whale-memory）的实现工程师。请你按设计文档 v3.10 §2.5/§3.1/§3.2 与计划 v2.0 修 P0/P1：确认整句锚定与提案闸，审查铁律10 只作引用，对比 rule-store 与 rules-routes 的取号路径，分析墓碑闸与 affected_inactive，解释编号单一真源；不许改 client.js、routes 层、locale、persona 仓，禁止 git commit/push，禁止对真实规则仓写。补充完善细节'

test('confirmNonceOf：只认整句「[确认]收录 p+8hex」；提示行/问号/日志查询/否定/额外文字一律不确认', () => {
  const nonce = 'p48752161'
  // 正常确认（前置「确认」可选；p 大小写容忍；末尾句号/叹号可选）。
  for (const query of [`收录 ${nonce}`, `确认收录 ${nonce}`, ` 收录  P48752161 `, `收录 ${nonce}。`, `确认收录 ${nonce}！`]) {
    assert.equal(confirmNonceOf(query), nonce, query)
  }
  // 问号/否定/额外文字：整句锚定必须拒绝（不是"句中包含 nonce"）。
  const rejected = [
    `收录 ${nonce}？`,
    `收录 ${nonce} 吗`,
    `确认收录 ${nonce} 吗？`,
    `先不收录 ${nonce}`,
    `不要收录 ${nonce}`,
    `帮我查一下日志里有没有 收录 ${nonce}`,
    `我看到提示「回复 收录 ${nonce} 确认」`,
    `【规则候选】草稿——回复「收录 ${nonce}」确认收进铁律，或到规则页签处理。`,
    `收录 ${nonce} 这条`,
    `确认收录 ${nonce} 谢谢`,
    `收录 ${nonce} 并删除旧规则`,
  ]
  for (const query of rejected) assert.equal(confirmNonceOf(query), '', query)
  // 4–7 位/17 位/非 hex 一律拒绝。
  for (const query of ['收录 p1234', '收录 p12345', '收录 p123456', '收录 p1234567', '收录 p123456789abcdef01', '收录 pzzzzzzzz', '收录 p1234567g']) {
    assert.equal(confirmNonceOf(query), '', query)
  }
})

test('isRuleStatement：任务书/提问/长文/代码块/URL 不是规则陈述，单句短陈述通过', () => {
  assert.equal(Array.from(TASK_BOOK).length, 253, '任务书样例必须是 253 码点')
  assert.equal(isRuleStatement(TASK_BOOK), false, '任务书（含请你/审查/铁律10）不得进提案闸')
  for (const text of [
    '这个规则是不是要改一下？',
    '请你审查一下规则仓',
    '帮我看看铁律10 有没有编号冲突',
    '以后都别删源文件\n再补一条',
    '以后都别删源文件。因为删了会出事。',
    '以后都别删源文件 `rm -rf`',
    '以后都别删源文件 https://example.com/a',
    '以后都别删源文件 [参考](https://example.com)',
    '',
    'x'.repeat(121),
  ]) {
    assert.equal(isRuleStatement(text), false, JSON.stringify(text))
  }
  for (const text of ['以后都别删源文件', '必须保留审计日志', '禁止在提交信息里写密钥；例外：公开样例。']) {
    assert.equal(isRuleStatement(text), true, text)
  }
})

test('extractExplicitRef/compileStructured：`铁律N` 纯引用不得按引用号造 key', () => {
  // 明确指令才返回身份。
  assert.deepEqual(extractExplicitRef('记成铁律17：删文档前先核路径'), { key: 'iron-rule-17', number: 17 })
  assert.deepEqual(extractExplicitRef('把这条收进铁律12'), { key: 'iron-rule-12', number: 12 })
  assert.deepEqual(extractExplicitRef('铁律17：文件卫生与阅后即焚'), { key: 'iron-rule-17', number: 17 })
  // 纯引用只当引用：不得返回 number/key。
  assert.equal(extractExplicitRef('务必做到铁律10'), null)
  assert.equal(extractExplicitRef('铁律10 要求收尾四件套'), null)
  const got = compileStructured('务必做到铁律10：以后都别删源文件', {}, { source: 'owner', nextNumber: 10 })
  assert.equal(got.ok, true, got.error)
  assert.equal(got.draft.type, 'rule', '纯引用不得被收成新铁律')
  assert.notEqual(got.draft.key, 'iron-rule-10', '纯引用不得按引用号造 key')
  assert.equal(got.draft.number, null)
})

test('createProposal：跨 scope 同 key → target_conflict，不创建候选、不落候选文件', (t) => {
  const root = freshRoot(t)
  seed(root, { key: 'rule-src-keep', scope: 'global' })
  const made = createProposal({
    text: '按 rule:rule-src-keep 记成铁律：源文件必须保留。',
    identity: { userId: 'u1', roleId: 'reviewer', workspace: '/tmp/ws-a' },
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.ok, false)
  assert.equal(made.code, 'target_conflict')
  const files = existsSync(join(root, 'proposals'))
    ? readdirSync(join(root, 'proposals')).filter((name) => name.endsWith('.json'))
    : []
  assert.deepEqual(files, [], '注定 target_conflict 的候选不得创建')
  assert.equal(listProposals({ rulesDir: root, config: { rules: {} } }).proposals.length, 0)
})

test('createProposal：编号命中墓碑 → number_retired，不创建候选', (t) => {
  const root = freshRoot(t)
  assert.equal(writeTombstone(root, { key: 'iron-rule-1', number: 1 }).ok, true)
  const made = createProposal({
    text: '记成铁律1：以后都别删源文件',
    identity: IDENTITY,
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.ok, false)
  assert.equal(made.code, 'number_retired')
  assert.deepEqual(
    existsSync(join(root, 'proposals')) ? readdirSync(join(root, 'proposals')).filter((n) => n.endsWith('.json')) : [],
    [],
  )
})

test('applyProposal：机器起草 iron-rule 的落盘文件名/key 为 iron-rule-<n>（草案 key 只做关系判定）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(made.ok, true, made.code)
  // 草案仍可用临时 key（rule-<domain>-<hash8>）做关系判定；落盘必须由 plan 决定。
  assert.match(made.proposal.draft.key, /^rule-/)
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(result.applied.key, `iron-rule-${result.applied.number}`)
  assert.equal(existsSync(join(root, `${result.applied.key}.md`)), true)
  const rules = listProposals({ rulesDir: root, config: { rules: {} } }).proposals
  assert.equal(rules[0].status, 'accepted')
})
