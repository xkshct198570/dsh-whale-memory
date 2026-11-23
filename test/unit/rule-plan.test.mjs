/**
 * 应用计划单测（R8-03）：buildApplyPlan 的契约形状、planHash 稳定性、逐文件守卫、作用域闸。
 * 全部临时规则目录；守卫/关系判定不依赖 git/模型/DB（纯函数口径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateRule, writeRule, writeTombstone } from '../../src/core/rule-store.js'
import { createProposal } from '../../src/core/rule-proposal.js'
import { buildApplyPlan, checkFrontConsistency } from '../../src/core/rule-plan.js'

const IDENTITY = { userId: 'u1', roleId: 'reviewer', workspace: '' }

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-plan-'))
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
    exceptions: ['正在被引用的文件'],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

function seed(root, overrides = {}, text = '源文件必须保留；例外：正在被引用的文件。') {
  const got = writeRule(root, { front: frontOf(overrides), text }, { git: false })
  assert.equal(got.ok, true, JSON.stringify(got.detail || got.error))
  return got
}

/** 直接计划（不带任何 decisions），断言形状与指纹稳定。 */
test('buildApplyPlan：契约形状（target/files/affected/guards/planHash/commitMessage）', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(made.ok, true, made.code)
  const first = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(first.ok, true, JSON.stringify(first))
  const { plan } = first
  assert.equal(plan.proposalId, made.proposal.id)
  assert.match(plan.planHash, /^[0-9a-f]{64}$/)
  assert.equal(plan.files.length, 1)
  const file = plan.files[0]
  assert.equal(file.key, plan.target.key)
  assert.equal(file.oldHash, null, '新文件旧 hash 必须是 null（不存在）')
  assert.ok(Array.isArray(file.guards))
  assert.match(plan.commitMessage, new RegExp(`^rule: apply ${made.proposal.id} .+ \\(#\\d+\\)$`))
  assert.ok(Array.isArray(plan.affected))
  assert.equal(typeof plan.target.front, 'object')
  // planHash 稳定：同样的磁盘 + 同样的 decisions 必须同指纹（面板/apply 才对得上）。
  const second = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(second.ok, true)
  assert.equal(second.plan.planHash, plan.planHash)
  assert.equal(second.plan.files[0].newText, file.newText)
})

test('buildApplyPlan：target 键已存在且不是 refine → target_conflict（不覆盖既有规则）', (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // 伪造一份「new 关系但 key 撞车」的候选快照（历史导入件/手改候选可能出现）。
  const proposal = {
    ...made.proposal,
    draft: { ...made.proposal.draft, key: 'rule-src-keep' },
    relation: { relation: 'new', targets: [] },
    affected: [],
  }
  const got = buildApplyPlan({ proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'target_conflict')
  assert.equal(got.needsManual, true)
})

test('buildApplyPlan：受影响规则已物理删除 → affected_missing（不回写提案快照）', (t) => {
  const root = freshRoot(t)
  const seedDoc = seed(root)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  const proposal = { ...made.proposal, affected: [{ key: 'rule-src-keep', front: seedDoc.rule.front, text: seedDoc.rule.text }] }
  rmSync(join(root, 'rule-src-keep.md'))
  const got = buildApplyPlan({ proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'affected_missing')
})

test('buildApplyPlan：目标正文丢旧例外 → rule_guard_failed/dropped_exception', (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'merge')
  const got = buildApplyPlan({
    proposal: made.proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: { text: '源文件必须保留，过程稿归档到临时目录。' },
  })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'rule_guard_failed')
  assert.ok(got.failures.some((item) => item.code === 'dropped_exception'), JSON.stringify(got.failures))
})

/**
 * v3.7 守卫绕过用例：只守「合并正文」时，`decisions.affected[].new_text` 可把旧规则改写丢例外，
 * 面板/LLM 绕过守卫。R8-03 必须逐文件守 → 该用例现在必须失败。
 */
test('buildApplyPlan：decisions.affected 改写丢旧例外 → 守卫逐文件拒绝（绕过必须失败）', (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const merged = '源文件必须保留，过程稿归档到临时目录；例外：正在被引用的文件。'
  const got = buildApplyPlan({
    proposal: made.proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: {
      text: merged,
      acceptAffected: ['rule-src-keep'],
      affected: [{ key: 'rule-src-keep', new_text: '源文件必须保留。' }],
    },
  })
  assert.equal(got.ok, false, '改写列表不得绕过守卫')
  assert.equal(got.error, 'rule_guard_failed')
  assert.ok(got.failures.some((item) => item.code === 'dropped_exception' && item.key === 'rule-src-keep'))
})

test('buildApplyPlan：旧 conditions 丢失 → dropped_condition（条件与例外同权）', (t) => {
  const root = freshRoot(t)
  seed(root, { conditions: ['当文件仍被引用时'], exceptions: [] }, '源文件必须保留，当文件仍被引用时。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'merge')
  const got = buildApplyPlan({
    proposal: made.proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: { text: '源文件必须保留，过程稿归档到临时目录。' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((item) => item.code === 'dropped_condition'), JSON.stringify(got.failures))
})

test('buildApplyPlan：真冲突 → 新正文表达新模态即放行（旧模态允许被取代）', (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.proposal.relation.relation, 'conflict')
  const got = buildApplyPlan({
    proposal: made.proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: { text: '源文件禁止删除，必须保留。' },
  })
  assert.equal(got.ok, true, JSON.stringify(got.failures))
  assert.equal(got.plan.files.length, 2, '目标文件 + 被 supersede 的旧规则文件')
  const oldFile = got.plan.files.find((file) => file.key === 'rule-src-keep')
  assert.ok(oldFile, '旧规则必须进 files（否则 superseded 不会落盘）')
  assert.equal(oldFile.front.status, 'superseded')
  assert.equal(oldFile.front.superseded_by, got.plan.target.key)
})

test('buildApplyPlan：冲突新正文没表达新模态 → modality_missing', (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  const got = buildApplyPlan({
    proposal: made.proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: { text: '源文件禁止删除。' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((item) => item.code === 'modality_missing'), JSON.stringify(got.failures))
})

test('buildApplyPlan：跨 scope 不 supersede（global 反向规则 vs workspace 草案 → unrelated）', (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录',
    identity: { userId: 'u1', roleId: 'reviewer', workspace: '/tmp/ws-a' },
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.draft.scope, 'workspace:/tmp/ws-a')
  // 无同 scope 既有规则 → 'new'（架构书 §3.3 的 new/unrelated 分工）；关键是不 supersede 他区。
  assert.ok(['new', 'unrelated'].includes(made.proposal.relation.relation), made.proposal.relation.relation)
  assert.ok(made.proposal.relation.crossScope?.some((item) => item.key === 'rule-src-keep'))
  assert.equal(made.proposal.affected.length, 0, '跨 scope 不得把旧规则拉进 affected')
  const got = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, true, JSON.stringify(got.failures))
  assert.equal(got.plan.files.length, 1, '只新建本区规则，不动他区文件')
})

test('checkFrontConsistency：front 条款必须在正文里（字段有、正文无 → front_body_drift）', () => {
  const drift = checkFrontConsistency({
    front: { conditions: ['当文件仍被引用时'], exceptions: ['用户原件'] },
    text: '源文件必须保留；例外：用户原件。',
  })
  assert.equal(drift.ok, false)
  assert.deepEqual(drift.failures.map((item) => item.field), ['conditions'])
  const ok = checkFrontConsistency({
    front: { conditions: ['当文件仍被引用时'], exceptions: ['用户原件'] },
    text: '源文件必须保留，当文件仍被引用时；例外：用户原件。',
  })
  assert.equal(ok.ok, true)
})

test('buildApplyPlan：旧规则仍在正文的条款必须进 front（body 有、front 无 → front_missing_clause）', (t) => {
  const root = freshRoot(t)
  seed(root)
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  // 手工构造 front 缺条款的边界：把白名单勾选保留，但把目标草案的 exceptions 清空，
  // 且让 unionClauses 之外的路径仍然在正文里保留旧例外（模拟历史坏数据）。
  const proposal = {
    ...made.proposal,
    draft: { ...made.proposal.draft, exceptions: [] },
  }
  const got = buildApplyPlan({
    proposal,
    rulesDir: root,
    config: { rules: {} },
    decisions: { text: '源文件必须保留，过程稿归档到临时目录；例外：正在被引用的文件。' },
  })
  assert.equal(got.ok, true, JSON.stringify(got.failures))
  const target = got.plan.files.find((file) => file.role === 'target')
  assert.equal(target.guards.length, 0)
  assert.ok(target.front.exceptions.includes('正在被引用的文件'), '并集把旧例外补回 front')
})

test('buildApplyPlan：铁律编号打满 1–999 → number_exhausted（绝不越界发号）', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // 墓碑占满 1–999（模拟编号耗尽）；草案号缺失 → 只能走 nextFreeNumber，必须返回 null。
  // R9-20 口径变更：墓碑真源是 retired/*.json，不是 manifest.retired（后者禁止当取号输入）。
  mkdirSync(join(root, 'retired'), { recursive: true })
  for (let n = 1; n <= 999; n += 1) {
    writeFileSync(
      join(root, 'retired', `iron-rule-${n}.json`),
      `${JSON.stringify({ key: `iron-rule-${n}`, number: n, numbers: [n], at: '2026-11-22T00:00:00.000Z', reason: 'purge' })}\n`,
    )
  }
  const proposal = { ...made.proposal, draft: { ...made.proposal.draft, number: 0 } }
  const got = buildApplyPlan({ proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'number_exhausted')
  assert.equal(got.needsManual, true)
})

// ---------------------------------------------------------------------------
// R9-20：affected_inactive / 墓碑闸 / plan 决定 iron-rule key
// ---------------------------------------------------------------------------

test('buildApplyPlan：受影响规则文件在盘但 status≠active → affected_inactive（附 status/path）', (t) => {
  const root = freshRoot(t)
  seed(root, { modality: 'must_not', exceptions: [] }, '源文件禁止删除。')
  const made = createProposal({
    text: '源文件必须保留，过程稿归档到临时目录', identity: IDENTITY, rulesDir: root, config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.relation.relation, 'conflict')
  const retired = updateRule({ root, key: 'rule-src-keep', patch: { status: 'retired' } }, { git: false })
  assert.equal(retired.ok, true, JSON.stringify(retired))
  const got = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'affected_inactive')
  assert.equal(got.failures[0].code, 'affected_inactive')
  assert.equal(got.failures[0].key, 'rule-src-keep')
  assert.equal(got.failures[0].status, 'retired')
  assert.match(got.failures[0].path, /rule-src-keep\.md$/, '必须给出仍在盘上的文件路径')
})

test('buildApplyPlan：删掉 manifest 后仍按墓碑拒绝 number_retired（manifest 不是取号输入）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: frontOf({ key: 'iron-rule-1', type: 'iron-rule', number: 1, exceptions: [] }), text: '必须保留审计日志。' }, { git: false }).ok, true)
  assert.equal(writeTombstone(root, { key: 'iron-rule-5', number: 5 }).ok, true)
  rmSync(join(root, 'manifest.json'), { force: true })
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.draft.number, 7, '提案期编号必须含墓碑并跳过保留号 6（max(1,5)+1=6 → 7）')
  // 伪造"提案拿到墓碑号"：plan 必须在锁内按墓碑拒绝，不论 manifest 是否存在。
  const proposal = { ...made.proposal, draft: { ...made.proposal.draft, number: 5 } }
  const got = buildApplyPlan({ proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'number_retired')
  assert.equal(got.failures[0].code, 'number_retired')
})

test('buildApplyPlan：机器起草 iron-rule 的 target key/path 由最终编号决定（iron-rule-<n>）', (t) => {
  const root = freshRoot(t)
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  assert.equal(made.ok, true, made.code)
  const got = buildApplyPlan({ proposal: made.proposal, rulesDir: root, config: { rules: {} }, decisions: {} })
  assert.equal(got.ok, true, JSON.stringify(got.failures))
  const { plan } = got
  assert.equal(plan.target.key, `iron-rule-${plan.target.number}`)
  const target = plan.files.find((file) => file.role === 'target')
  assert.equal(target.key, plan.target.key)
  assert.match(target.path, new RegExp(`/iron-rule-${plan.target.number}\\.md$`))
})
