// createProposal 候选生成/冷却/上限/去重与候选存储读接口；依赖 rule-proposal-harness.mjs 的临时规则根，不 import 其它测试文件。

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

test('createProposal：rules.enabled=false → rules_disabled，不写任何文件', (t) => {
  const root = freshRoot(t)
  const got = createProposal({
    text: '以后都别删源文件', identity: IDENTITY, rulesDir: root,
    config: { rules: { enabled: false } },
  })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'rules_disabled')
  assert.equal(existsSync(join(root, 'proposals')), false)
})

test('createProposal：隐私/纯偏好/描述句一律不提案', (t) => {
  const root = freshRoot(t)
  const cfg = { rules: {} }
  assert.equal(createProposal({ text: '以后都记住手机号 13800138000', identity: IDENTITY, rulesDir: root, config: cfg }).code, 'privacy')
  assert.equal(createProposal({ text: '以后尽量早点睡', identity: IDENTITY, rulesDir: root, config: cfg }).code, 'preference')
  assert.equal(createProposal({ text: '端口固定为 3982', identity: IDENTITY, rulesDir: root, config: cfg }).code, 'descriptive')
})

test('createProposal：落候选 JSON（id/hash/relation/candidate/affectedKeys）', (t) => {
  const root = freshRoot(t)
  const got = createProposal({
    text: '以后都别删源文件', source: 'owner', identity: IDENTITY, rulesDir: root,
    config: { rules: {} }, sessionId: 's1', traceId: 't1',
  })
  assert.equal(got.ok, true, got.code)
  assert.equal(got.cooling, false)
  assert.match(got.proposal.id, /^p\d{13}_[0-9a-f]{8}$/)
  assert.equal(got.proposal.status, 'pending')
  assert.equal(got.proposal.relation.relation, 'new')
  assert.equal(got.proposal.draft.type, 'iron-rule')
  assert.equal(got.proposal.affectedKeys.length, 0)
  const onDisk = jsonFile(root, `${got.proposal.id}.json`)
  assert.equal(onDisk.hash, got.proposal.hash)
  assert.equal(onDisk.sessionId, 's1')
  assert.equal(onDisk.traceId, 't1')
})

test('createProposal：非 owner 来源最高普通规则（不置铁律）', (t) => {
  const root = freshRoot(t)
  const got = createProposal({
    text: '以后必须只保留最终交付件', source: 'self', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(got.ok, true)
  assert.equal(got.proposal.draft.type, 'rule')
})

test('createProposal：同 hash 只留一条候选（hits 累加，不新建文件）', (t) => {
  const root = freshRoot(t)
  const args = { text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 1000 }
  const first = createProposal(args)
  const second = createProposal({ ...args, now: 2000 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.existing, true)
  assert.equal(second.proposal.id, first.proposal.id)
  assert.equal(second.proposal.hits, 2)
  assert.equal(readdirSync(join(root, 'proposals')).filter((n) => n.endsWith('.json')).length, 1)
})

test('createProposal：同 hash 在冷却期内 → cooling:true（仍可面板查看）', (t) => {
  const root = freshRoot(t)
  const cfg = { rules: {} }
  const first = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 1000 })
  const rejected = rejectProposal({ id: first.proposal.id, reason: '不需要', identity: IDENTITY, rulesDir: root, config: cfg, now: 2000 })
  assert.equal(rejected.ok, true)
  const again = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 3000 })
  assert.equal(again.ok, true)
  assert.equal(again.cooling, true)
  // 冷却期外（默认 30 天）不再冷却：同文本可重新提案。
  const later = createProposal({
    text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: { askCooldownDays: 0 } }, now: 3_000_000_000,
  })
  assert.equal(later.cooling, false)
  const log = readFileSync(join(root, 'proposals', '.rejected.jsonl'), 'utf8')
  assert.match(log, /"hash"/)
})

test('createProposal：超过 maxProposals 时最旧 pending 标 expired 并归档（不删证据）', (t) => {
  const root = freshRoot(t)
  const cfg = { rules: { maxProposals: 2 } }
  const a = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 1000 })
  const b = createProposal({ text: '审计日志必须保留', identity: IDENTITY, rulesDir: root, config: cfg, now: 2000 })
  const c = createProposal({ text: '过程稿一律归档到临时目录', identity: IDENTITY, rulesDir: root, config: cfg, now: 3000 })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, true)
  assert.equal(c.expired.includes(a.proposal.id), true, JSON.stringify(c.expired))
  const list = listProposals({ rulesDir: root, status: 'pending' })
  assert.equal(list.proposals.length, 2)
  // R9-14 改语义：过期候选从主目录移到 archive/（状态 expired 仍落盘，证据不删）。
  // 原因：主目录无限堆积会让每次候选扫描越来越慢，也挤占面板「待确认」视野。
  assert.equal(existsSync(join(root, 'proposals', `${a.proposal.id}.json`)), false, '过期候选应退出主扫描目录')
  assert.equal(existsSync(join(root, 'proposals', 'archive', `${a.proposal.id}.json`)), true, '证据必须留在 archive/')
})

test('listProposals/readProposal：status 过滤与非法 id 不越界', (t) => {
  const root = freshRoot(t)
  const cfg = { rules: {} }
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg })
  assert.equal(listProposals({ rulesDir: root }).proposals.length, 1)
  assert.equal(listProposals({ rulesDir: root, status: 'accepted' }).proposals.length, 0)
  assert.equal(readProposal({ rulesDir: root, id: made.proposal.id }).ok, true)
  assert.equal(readProposal({ rulesDir: root, id: '../etc/passwd' }).ok, false)
  assert.equal(readProposal({ rulesDir: root, id: 'p1234567890123_deadbeef' }).error, 'proposal_not_found')
})

test('createProposal：去重 hash 含 scope+role（同句跨工作区/角色是两条候选）', (t) => {
  const root = freshRoot(t)
  const text = '以后都别删源文件'
  const a = createProposal({ text, identity: { userId: 'u1', roleId: 'reviewer', workspace: '' }, rulesDir: root, config: { rules: {} }, now: 1000 })
  const b = createProposal({ text, identity: { userId: 'u1', roleId: 'reviewer', workspace: '/tmp/ws-a' }, rulesDir: root, config: { rules: {} }, now: 2000 })
  const c = createProposal({ text, identity: { userId: 'u1', roleId: 'owner', workspace: '' }, rulesDir: root, config: { rules: {} }, now: 3000 })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(c.ok, true)
  assert.notEqual(b.proposal.hash, a.proposal.hash, '跨 work区 不得共用 hash')
  assert.notEqual(c.proposal.hash, a.proposal.hash, '跨 role 不得共用 hash')
  assert.notEqual(b.proposal.id, a.proposal.id)
  assert.equal(listProposals({ rulesDir: root, config: { rules: {} } }).proposals.length, 3)
})

test('rejectProposal：冷却落绝对窗口，时钟回拨不会永久冻结', (t) => {
  const root = freshRoot(t)
  const cfg = { rules: {} }
  const first = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 1000 })
  rejectProposal({ id: first.proposal.id, reason: '不需要', identity: IDENTITY, rulesDir: root, config: cfg, now: 2000 })
  const log = readFileSync(join(root, 'proposals', '.rejected.jsonl'), 'utf8')
  assert.match(log, /"expiresAt":/)
  // 时钟回拨到拒绝之前：仍在绝对窗口内 → 冷却（不是"now-ts 为负"的永冻）。
  const rolledBack = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 500 })
  assert.equal(rolledBack.cooling, true)
  // 窗口到期后（绝对时间）解除：30 天 + 1ms。
  const expired = createProposal({
    text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg, now: 2000 + 30 * 24 * 3600 * 1000 + 1,
  })
  assert.equal(expired.cooling, false)
})

test('R9-14：rejected.jsonl 裁剪——180 天外且非最近 200 条被裁，冷却记录保留', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(made.ok, true)
  const file = join(root, 'proposals', '.rejected.jsonl')
  const day = 24 * 3600 * 1000
  const stale = Array.from({ length: 250 }, (_, i) => ({ hash: `stale${i}`, ts: 1000, expiresAt: 1000 + day }))
  writeFileSync(file, `${stale.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')

  const rejected = rejectProposal({ id: made.proposal.id, reason: '测试裁剪', rulesDir: root, config: { rules: {} } })
  assert.equal(rejected.ok, true)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length <= 201, `裁剪后仍留 ${lines.length} 行（应 ≈ 最近 200 + 本次）`)
  const hashes = lines.map((line) => JSON.parse(line).hash)
  assert.equal(hashes.includes('stale0'), false, '最旧记录必须被裁掉')
  assert.equal(hashes.includes(made.proposal.hash), true, '本次拒绝记录不得被裁')
})
