// 提案拒绝/聊天确认/会话 pending 映射；依赖 rule-proposal-harness.mjs 的临时规则根，不 import 其它测试文件。

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

test('rejectProposal：写冷却日志 + status=rejected；读不到返回 proposal_not_found', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const rejected = rejectProposal({ id: made.proposal.id, reason: '不需要', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.proposal.status, 'rejected')
  assert.equal(listProposals({ rulesDir: root, status: 'rejected' }).proposals.length, 1)
  const again = rejectProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} } })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'proposal_not_pending')
})

test('detectConfirmIntent：只认短、明确、无问号的确认（否定优先）', () => {
  for (const q of ['确认', '好，收', '我确认一下', '这条收进铁律', '可以']) assert.equal(detectConfirmIntent(q), 'confirm', q)
  for (const q of ['先不确认', '这条要吗？', '确认吗', '对，就是这样', '看看这个', '', '这是一段很长的说明文字不应该被当成确认短语']) {
    assert.equal(detectConfirmIntent(q), 'none', q)
  }
})

test('confirmPendingForSession：无 pending / 无 nonce 不动状态；收录 <id8> 走同一个 apply', async (t) => {
  resetSessionPending()
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const nonce = proposalNonce(made.proposal)
  assert.match(nonce, /^p[0-9a-f]{8}$/)
  assert.equal((await confirmPendingForSession({ sessionId: 's1', query: `收录 ${nonce}`, rulesDir: root, config: { rules: {} } })).code, 'no_pending')
  setSessionPending('s1', made.proposal.id)
  const vague = await confirmPendingForSession({
    sessionId: 's1', query: '这个怎么样？', rulesDir: root, config: { rules: {} },
  })
  assert.equal(vague.code, 'no_confirm')
  // R8-05：模糊句一律不触发（v3.7 的「确认/好/可以」词表在聊天入口已作废，只留面板按钮）。
  for (const query of ['确认', '好', '可以', '好，那删掉吧']) {
    const got = await confirmPendingForSession({ sessionId: 's1', query, rulesDir: root, config: { rules: {} } })
    assert.equal(got.code, 'no_confirm', query)
    assert.equal(existsSync(join(root, `iron-rule-${made.proposal.draft.number}.md`)), false, query)
  }
  // 非本会话 nonce（面板里另一条候选）不得顶替：必须拒绝且不动文件。
  assert.equal((await confirmPendingForSession({
    sessionId: 's1', query: '收录 pdeadbeef', rulesDir: root, config: { rules: {} },
  })).code, 'nonce_mismatch')
  const applied = await confirmPendingForSession({
    sessionId: 's1',
    query: ` 收录  P${nonce.slice(1)} `, // 空格与 p/HEX 大小写容忍（返回统一小写 nonce）
    rulesDir: root,
    config: { rules: {} },
    identity: IDENTITY,
    git: false,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.applied.key, `iron-rule-${applied.applied.number}`)
  assert.equal(existsSync(join(root, `${applied.applied.key}.md`)), true)
  // 确认成功后映射清空：同一句话不会再重复收录。
  const again = await confirmPendingForSession({ sessionId: 's1', query: `收录 ${nonce}`, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(again.code, 'no_pending')
})

test('buildProposalAskLine：提示行必须带 nonce；confirmNonceOf 只认 收录 <id8>', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const line = buildProposalAskLine(made.proposal)
  const nonce = proposalNonce(made.proposal)
  assert.match(line, /【规则候选】/)
  assert.ok(line.includes(`收录 ${nonce}`), line)
  assert.equal(confirmNonceOf(`收录${nonce}`), nonce)
  assert.equal(confirmNonceOf(`收录 P${nonce.slice(1)}`), nonce)
  for (const q of ['好', '可以', '确认', '先不收录 p12345678', '收录', '']) {
    assert.equal(confirmNonceOf(q), '', q)
  }
})

test('confirmPendingForSession：映射 30min TTL，过期即 no_pending', async (t) => {
  resetSessionPending()
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 1000 })
  setSessionPending('s2', made.proposal.id, 0)
  const expired = await confirmPendingForSession({
    sessionId: 's2', query: '确认', rulesDir: root, config: { rules: {} }, now: 30 * 60 * 1000 + 1,
  })
  assert.equal(expired.code, 'no_pending')
  clearSessionPending('s2')
})

test('R9-14：会话 pending 用绝对 expAt——时钟回拨不冻结 TTL，到点即过期', () => {
  resetSessionPending()
  const id = 'p1795408837317_7dd185e7'
  assert.equal(setSessionPending('s-clock', id, 100_000), true)
  assert.equal(getSessionPending('s-clock', 100_001)?.proposalId, id)
  // 回拨：now 远小于 at。旧实现 now-at 变负 → 永远不过期；绝对 expAt 只到原到期点。
  assert.equal(getSessionPending('s-clock', 50_000)?.proposalId, id, '时钟回拨不得让 pending 提前消失')
  assert.equal(getSessionPending('s-clock', 100_000 + SESSION_PENDING_TTL_MS), null, 'now>=expAt 即过期')
  resetSessionPending()
})
