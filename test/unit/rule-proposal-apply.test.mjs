// applyProposal 落盘/关系/事务/编号/并发（含 planHash 与回滚）；依赖 rule-proposal-harness.mjs 的临时规则根，不 import 其它测试文件。

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

test('applyProposal：new 直接落盘（编号/文件/accepted/镜像/渲染/审计）', async (t) => {
  const root = freshRoot(t)
  const backend = fakeBackend()
  const mirrors = []
  const renders = []
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    identity: IDENTITY,
    git: false,
    backend,
    mirror: (args) => { mirrors.push(args); return { ok: true, mirrored: 1 } },
    renderAgents: (args) => { renders.push(args); return { ok: true, changed: true, count: 1 } },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  // R9-20 ④ 语义变更：机器起草的 iron-rule 落盘 key 由 plan 按最终编号盖成 iron-rule-<n>，
  // 草案里的临时 key（rule-<domain>-<hash8>）只用于关系判定，不再当文件名。
  assert.equal(result.applied.key, `iron-rule-${result.applied.number}`)
  assert.equal(result.applied.number, made.proposal.draft.number)
  assert.equal(result.applied.commit, null, 'git:false 时不得报 commit')
  assert.equal(result.applied.mirror.ok, true)
  assert.equal(result.applied.agents.ok, true)
  assert.equal(result.proposal.status, 'accepted')
  assert.match(readRuleText(root, result.applied.key), /禁止删源文件/)
  assert.equal(mirrors.length, 1)
  assert.equal(renders.length, 1)
  // 审计：writes 一行 reason=rule_apply + evolution 一行（正文从无到有）。
  const writesRun = backend.calls.find((call) => call.kind === 'run' && /INSERT INTO writes/.test(call.sql))
  assert.ok(writesRun, '必须写 writes 审计')
  assert.equal(writesRun.args[4], 'rule_apply')
  assert.equal(writesRun.args[2], 'ADD')
  assert.ok(backend.calls.some((call) => call.kind === 'run' && /INSERT INTO evolution/.test(call.sql)))
  // 候选状态已落盘：面板重开也能看到 accepted。
  assert.equal(jsonFile(root, `${made.proposal.id}.json`).status, 'accepted')
})

test('applyProposal：duplicate 不新建文件（只标 accepted + NOOP 审计）', async (t) => {
  const root = freshRoot(t)
  const backend = fakeBackend()
  const cfg = { rules: {} }
  // duplicate 的真实来源：仓里已有一条"不同 key、同一正文"的规则（如历史导入件），
  // 再提同一句话时 key 不同、dedupeKey 相同 → duplicate，不新建文件。
  const template = compileStructured('以后都别删源文件', {}, { source: 'owner', nextNumber: 1 }).draft.text
  seed(root, { key: 'rule-legacy-same', number: 9, object: '源文件', exceptions: [], modality: 'must_not' }, template)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: cfg })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.relation.relation, 'duplicate')
  const result = await applyProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false, backend,
  })
  assert.equal(result.ok, true)
  assert.equal(result.duplicate, true)
  assert.equal(result.applied.key, 'rule-legacy-same')
  assert.equal(ruleFiles(root).length, 1, '规则文件不新增')
  const writesRun = backend.calls.find((call) => /INSERT INTO writes/.test(call.sql))
  assert.equal(writesRun.args[2], 'NOOP')
})

test('applyProposal：合并走 LLM 改写（保留旧例外）→ 新规则 + 旧规则 superseded/merged_into', async (t) => {
  const root = freshRoot(t)
  seed(root)
  const mergedText = '【规则·file-hygiene】源文件必须保留，过程稿归档到临时目录；例外：正在被引用的文件；作用域：共享。'
  const llmCalls = []
  const llm = {
    async chat(args) {
      llmCalls.push(args)
      return '```json\n' + JSON.stringify({ merged_text: mergedText, affected: [], preserved: ['正在被引用的文件'], dropped: [] }) + '\n```'
    },
  }
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { llm: true } },
    git: false,
    getLlm: () => llm,
    // R9-10：模型调用必须带 provider/model（旧用例只给 llm 不给选择，已是非法接线）。
    getSelection: () => ({ provider: 'stub', model: 'stub' }),
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(llmCalls.length, 1)
  assert.equal(result.proposal.status, 'accepted')
  assert.match(readRuleText(root, result.applied.key), /正在被引用的文件/)
  const old = readRuleText(root, 'rule-src-keep')
  assert.match(old, /status: superseded/)
  assert.match(old, /merged_into: .+/)
})

test('applyProposal：refine 沿用旧编号并在同一文件上升版本', async (t) => {
  const root = freshRoot(t)
  seed(root, { type: 'iron-rule', number: 5, exceptions: ['用户原件'] })
  const made = createProposal({
    text: '按 rule:rule-src-keep 记成铁律：源文件必须保留，例外：用户原件', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.relation.relation, 'refine')
  assert.equal(made.proposal.draft.number, 5)
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: { text: '源文件必须保留，例外：用户原件。' },
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(result.applied.number, 5)
  assert.equal(result.applied.key, 'rule-src-keep')
  const text = readRuleText(root, 'rule-src-keep')
  assert.match(text, /version: 2/)
  assert.match(text, /例外：用户原件/)
  assert.equal(ruleFiles(root).length, 1, 'refine 不新建文件')
})

test('applyProposal：conflict → 新规则 + 旧规则 superseded_by', async (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'conflict')
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: { text: '源文件禁止删除，必须保留。' },
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  const old = readRuleText(root, 'rule-src-keep')
  assert.match(old, /status: superseded/)
  assert.match(old, /superseded_by: .+/)
})

test('applyProposal：单次 git commit（消息 rule: apply <id> <key> (#n)）', async (t) => {
  const root = freshRoot(t)
  const git = fakeGit()
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: true,
    exec: git.exec,
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error }))
  const commits = git.calls.filter((call) => call.args.includes('commit'))
  assert.equal(commits.length, 1, '多文件写必须合并成一次 commit')
  const message = commits[0].args[commits[0].args.indexOf('-m') + 1]
  assert.match(message, new RegExp(`^rule: apply ${made.proposal.id} .+ \\(#\\d+\\)$`))
  assert.match(result.applied.commit, /^rule: apply /)
})

test('applyProposal：commit 失败 → 回滚已写文件并返回 commit_failed', async (t) => {
  const root = freshRoot(t)
  const git = fakeGit({ failCommit: true })
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: true,
    exec: git.exec,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'commit_failed')
  assert.equal(result.rolledBack, true)
  // 落盘文件名是 plan 按编号盖的 iron-rule-<n>.md；回滚必须删掉它（检查草案临时 key 会假绿）。
  assert.equal(existsSync(join(root, `iron-rule-${made.proposal.draft.number}.md`)), false, '回滚必须删掉新文件')
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.total, 0, 'manifest 必须回到初始态')
  // 候选 accepted 只在 commit 成功后写：commit 失败必须仍是 pending（可重试）。
  assert.equal(jsonFile(root, `${made.proposal.id}.json`).status, 'pending')
  // 回滚必须清 index：否则下次任意 commit 会把已回滚的新规则重新带进历史。
  assert.ok(git.calls.some((call) => call.args.includes('reset')), JSON.stringify(git.calls.map((c) => c.args)))
  // 回滚必须清事务日志：残留 .txn 会让下次启动 recover 把之后合法写入当未完成事务处理。
  assert.deepEqual(listTxns(root), [], 'commit 失败回滚后必须 clearTxn')
})

test('applyProposal：编号被抢占 → 锁内复核后自动顺延（不复用被占号）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // 提案之后有人抢先写了同号规则（合法操作）：apply 复核后必须顺延，不得撞号/覆盖。
  const taken = seed(root, { key: 'rule-other', type: 'iron-rule', number: made.proposal.draft.number, object: '审计日志' }, '审计日志必须保留。')
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.notEqual(result.applied.number, taken.rule.front.number, '不得复用被占编号')
  const numbers = listRules(root).rules.map((doc) => Number(doc.front.number)).filter((n) => n > 0)
  assert.equal(new Set(numbers).size, numbers.length, '编号必须唯一')
  // 落盘 key/文件名由 plan 按顺延后的编号盖成，不再是提案草案的临时 key。
  assert.equal(existsSync(join(root, `${result.applied.key}.md`)), true)
})

test('applyProposal：requireGit=true 且 git 不可用 → git_required（不写文件）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: { requireGit: true } }, git: false,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'git_required')
  assert.equal(ruleFiles(root).length, 0)
})

test('applyProposal：候选不存在/已裁定 → proposal_not_found / proposal_not_pending', async (t) => {
  const root = freshRoot(t)
  assert.equal((await applyProposal({ id: 'p1234567890123_deadbeef', rulesDir: root, config: { rules: {} }, git: false })).error, 'proposal_not_found')
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal((await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })).ok, true)
  const again = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'proposal_not_pending')
})

test('applyProposal：decisions.acceptAffected 只处理白名单内的旧规则', async (t) => {
  const root = freshRoot(t)
  seed(root, { key: 'rule-src-keep', number: 1, object: '源文件', exceptions: ['正在被引用的文件'] })
  seed(root, { key: 'rule-doc-keep', number: 2, object: '源文件', exceptions: ['用户原件'] }, '源文件必须保留。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    decisions: {
      text: '源文件必须保留，过程稿归档到临时目录；例外：正在被引用的文件、用户原件。',
      acceptAffected: ['rule-doc-keep'],
    },
  })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(readRuleText(root, 'rule-src-keep').includes('status: active'), true, '未选中的旧规则不得被 supersede')
  assert.match(readRuleText(root, 'rule-doc-keep'), /status: superseded/)
})

test('applyProposal：planHash 与重算不符 → plan_hash_mismatch（不写盘）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: {} },
    git: false,
    planHash: 'deadbeef'.repeat(8),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'plan_hash_mismatch')
  assert.equal(ruleFiles(root).length, 0)
  assert.equal(jsonFile(root, `${made.proposal.id}.json`).status, 'pending', 'CAS 失败不得动候选')
})

test('applyProposal：双击/并发只落一次（只一次 commit、候选 final accepted）', async (t) => {
  const root = freshRoot(t)
  const git = fakeGit()
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const args = {
    id: made.proposal.id, rulesDir: root, config: { rules: {} }, identity: IDENTITY, git: true, exec: git.exec,
  }
  const [a, b] = await Promise.all([applyProposal(args), applyProposal(args)])
  const oks = [a, b].filter((item) => item.ok)
  assert.equal(oks.length, 1, JSON.stringify({ a: a.error, b: b.error }))
  const failed = [a, b].find((item) => !item.ok)
  assert.equal(failed.code, 'proposal_not_pending')
  assert.equal(ruleFiles(root).length, 1, '只允许一条规则文件')
  assert.equal(git.calls.filter((call) => call.args.includes('commit')).length, 1, '只允许一次 commit')
})

test('applyProposal：跨 scope 候选不 supersede 他区规则（global 旧规则保持 active）', async (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录',
    identity: { userId: 'u1', roleId: 'reviewer', workspace: '/tmp/ws-a' },
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.match(readRuleText(root, 'rule-src-keep'), /status: active/, '他区规则不得被 supersede')
  assert.equal(result.applied.affected.length, 0)
})

test('applyProposal：写事务日志并在 commit 成功后清空（.txn 不留残件）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(listTxns(root), [], 'commit 成功后必须 clearTxn')
})

test('applyProposal：superseded 文件仍占号 → 提案期就不承诺该号（R9-02 口径）', async (t) => {
  const root = freshRoot(t)
  seed(root, { key: 'iron-rule-1', type: 'iron-rule', number: 1, object: '审计日志', exceptions: [] }, '审计日志必须保留。')
  seed(root, { key: 'iron-rule-2', type: 'iron-rule', number: 2, object: '过程稿', action: '归档', exceptions: [] }, '过程稿必须归档。')
  seed(root, { key: 'iron-rule-3', type: 'iron-rule', number: 3, object: '报告', status: 'superseded', exceptions: [] }, '报告必须保留。')
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // R9-02 契约变更：提案期算号也按"文件名 ∪ 墓碑"占用（不只 active），
  // 所以 superseded 的 3 号从一开始就不会被承诺给候选——不再出现"先给 3、apply 才顺延 4"的假承诺。
  assert.equal(made.proposal.draft.number, 4)
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(result.applied.number, 4, 'superseded 文件仍占号，不得复用 3')
  const numbers = listRules(root).rules.map((doc) => Number(doc.front.number)).filter((n) => n > 0)
  assert.equal(new Set(numbers).size, numbers.length, '编号必须唯一')
})

test('applyProposal：目标编号写进墓碑 → number_retired 拒绝（永不复用）', async (t) => {
  const root = freshRoot(t)
  seed(root, { key: 'iron-rule-1', type: 'iron-rule', number: 1, object: '审计日志', exceptions: [] }, '审计日志必须保留。')
  const tomb = writeTombstone(root, { key: 'iron-rule-3', number: 3, at: '2026-11-22T00:00:00.000Z', reason: 'purge' })
  assert.equal(tomb.ok, true, tomb.error)
  assert.equal(regenerateManifest(root).ok, true)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // 伪造"提案时拿到墓碑号"：墓碑建立后编号被作废，apply 必须拒绝而不是复用。
  const file = join(root, 'proposals', `${made.proposal.id}.json`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.draft = { ...saved.draft, number: 3 }
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`)
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'number_retired')
  assert.equal(result.status, 'needs_manual')
  assert.equal(jsonFile(root, `${made.proposal.id}.json`).status, 'needs_manual')
  assert.equal(ruleFiles(root).length, 1, '拒绝时不得新建规则文件')
})

test('applyProposal：两提案并发抢同一编号 → 锁内重算顺延，两笔都成功且编号唯一', async (t) => {
  const root = freshRoot(t)
  const a = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 1000 })
  const b = createProposal({ text: '以后都别改审计日志', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 2000 })
  // 空仓两条新铁律都会拿到 1：只有锁内重算能保证第二笔顺延而不是撞号 write_failed。
  assert.equal(a.proposal.draft.number, 1)
  assert.equal(b.proposal.draft.number, 1)
  const results = await Promise.all([
    applyProposal({ id: a.proposal.id, rulesDir: root, config: { rules: {} }, git: false }),
    applyProposal({ id: b.proposal.id, rulesDir: root, config: { rules: {} }, git: false }),
  ])
  assert.deepEqual(results.map((item) => item.ok), [true, true], JSON.stringify(results.map((r) => r.error)))
  const numbers = results.map((item) => item.applied.number).sort((x, y) => x - y)
  assert.deepEqual(numbers, [1, 2], '第二笔必须在锁内顺延到 2')
  const onDisk = listRules(root).rules.map((doc) => Number(doc.front.number)).filter((n) => n > 0)
  assert.deepEqual(onDisk.sort((x, y) => x - y), [1, 2])
})

test('applyProposal：面板 planHash 与锁内重算不一致 → plan_hash_mismatch（不落盘）', async (t) => {
  const root = freshRoot(t)
  const a = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 1000 })
  const b = createProposal({ text: '以后都别改审计日志', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 2000 })
  // 面板先预览 B（此刻空仓 → 号 1），随后 A 抢先落盘占了 1 → B 的计划已过期。
  const preview = buildApplyPlan({ proposal: b.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(preview.ok, true)
  const appliedA = await applyProposal({ id: a.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(appliedA.ok, true, appliedA.error)
  const staleHash = await applyProposal({
    id: b.proposal.id, rulesDir: root, config: { rules: {} }, git: false, planHash: preview.plan.planHash,
  })
  assert.equal(staleHash.ok, false)
  assert.equal(staleHash.code, 'plan_hash_mismatch')
  assert.equal(ruleFiles(root).length, 1, '过期计划不得落盘')
  assert.equal(jsonFile(root, `${b.proposal.id}.json`).status, 'pending', '候选保持 pending 可重新预览')
})

test('applyProposal：预览后目标编号被 purge 作废 → 锁内复核拒绝 number_retired（不复用墓碑号）', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} }, now: 1000 })
  const preview = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(preview.ok, true)
  const number = preview.plan.target.number
  // 预览之后该号被 purge 写成墓碑：apply 必须在锁内重算时挡住，而不是发出作废号。
  const tomb = writeTombstone(root, { key: 'iron-rule-x', number, at: '2026-11-22T00:00:00.000Z', reason: 'purge' })
  assert.equal(tomb.ok, true, tomb.error)
  assert.equal(regenerateManifest(root).ok, true)
  const got = await applyProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false, planHash: preview.plan.planHash,
  })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'number_retired')
  assert.equal(got.status, 'needs_manual')
  assert.equal(ruleFiles(root).length, 0, '墓碑号不得落盘')
  assert.equal(jsonFile(root, `${made.proposal.id}.json`).status, 'needs_manual')
})
