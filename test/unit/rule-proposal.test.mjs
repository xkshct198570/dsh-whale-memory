/**
 * 规则提案制单测（R3b）：候选生成/冷却/上限/拒绝、应用事务（守卫/落盘/回滚/单次 commit/审计）。
 * 全部用临时规则目录；git 用注入 exec 模拟（不依赖本机安装），不碰真实 `$DSH_HOME/rules`。
 */
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
  setSessionPending,
} from '../../src/core/rule-proposal.js'
import { buildApplyPlan } from '../../src/core/rule-plan.js'

const IDENTITY = { userId: 'u1', roleId: 'reviewer', workspace: '' }

/** 临时规则根（每个用例独立；after 时整目录删掉）。 */
function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-proposal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function frontOf(overrides = {}) {
  return {
    key: 'rule-src-keep',
    type: 'rule',
    number: 1,
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

/** 写一条既有规则（真源文件；git 关掉，避免每个用例 spawn）。 */
function seed(root, overrides = {}, text = '源文件必须保留。') {
  const got = writeRule(root, { front: frontOf(overrides), text }, { git: false })
  assert.equal(got.ok, true, JSON.stringify(got.detail || got.error))
  return got
}

/** 审计用假 backend：只记录 SQL，不开库。 */
function fakeBackend() {
  const calls = []
  const db = {
    prepare(sql) {
      return {
        get: (...args) => { calls.push({ kind: 'get', sql, args }); return null },
        all: () => [],
        run: (...args) => { calls.push({ kind: 'run', sql, args }); return { changes: 1 } },
      }
    },
  }
  return { calls, withDb: (fn) => fn(db) }
}

/** 假 git：add/diff/commit 全部本地模拟；failCommit 用来验证回滚。 */
function fakeGit({ failCommit = false } = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push({ file, args })
    if (file === 'git' && args[0] === '--version') return 'git version 2.43.0'
    const cmd = ['rev-parse', 'init', 'add', 'diff', 'commit'].find((name) => args.includes(name))
    if (cmd === 'rev-parse') return 'true'
    if (cmd === 'diff') { const err = new Error('diff exit 1'); err.code = 1; throw err }
    if (cmd === 'commit') {
      if (failCommit) { const err = new Error('commit boom'); err.stderr = 'boom'; throw err }
      return 'committed'
    }
    return ''
  }
  return { exec, calls }
}

/** 规则文件（排除 README.md：ensureRuleRepo 会建它，不能算规则）。 */
function ruleFiles(root) {
  return readdirSync(root).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
}

function readRuleText(root, key) {
  return readFileSync(join(root, `${key}.md`), 'utf8')
}

function jsonFile(root, name) {
  return JSON.parse(readFileSync(join(root, 'proposals', name), 'utf8'))
}

// ---------------------------------------------------------------------------
// createProposal
// ---------------------------------------------------------------------------

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

test('createProposal：超过 maxProposals 时最旧 pending 标 expired（不删文件）', (t) => {
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
  assert.equal(existsSync(join(root, 'proposals', `${a.proposal.id}.json`)), true, '只改状态，不删证据')
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

// ---------------------------------------------------------------------------
// applyProposal
// ---------------------------------------------------------------------------

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
  assert.equal(result.applied.key, made.proposal.draft.key)
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
  assert.equal(existsSync(join(root, `${made.proposal.draft.key}.md`)), false, '回滚必须删掉新文件')
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
  assert.equal(existsSync(join(root, `${made.proposal.draft.key}.md`)), true)
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

// ---------------------------------------------------------------------------
// 拒绝 / 确认 / 会话映射
// ---------------------------------------------------------------------------

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
    assert.equal(existsSync(join(root, `${made.proposal.draft.key}.md`)), false, query)
  }
  // 非本会话 nonce（面板里另一条候选）不得顶替：必须拒绝且不动文件。
  assert.equal((await confirmPendingForSession({
    sessionId: 's1', query: '收录 pdeadbeef', rulesDir: root, config: { rules: {} },
  })).code, 'nonce_mismatch')
  const applied = await confirmPendingForSession({
    sessionId: 's1',
    query: ` 收录  ${nonce.toUpperCase()} `, // 空格/大小写容忍
    rulesDir: root,
    config: { rules: {} },
    identity: IDENTITY,
    git: false,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.applied.key, made.proposal.draft.key)
  assert.equal(existsSync(join(root, `${made.proposal.draft.key}.md`)), true)
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
  assert.equal(confirmNonceOf(`收录 ${nonce.toUpperCase()}`), nonce)
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

test('applyProposal：面板布尔 acknowledgeDropped 只在 guardStrict=false 时放行丢例外', async (t) => {
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
    decisions: { text: '源文件必须保留。', acknowledgeDropped: true },
  })
  assert.equal(strict.ok, false)
  assert.equal(strict.error, 'rule_guard_failed')

  const lax = await applyProposal({
    id: made.proposal.id,
    rulesDir: root,
    config: { rules: { guardStrict: false } },
    git: false,
    decisions: { text: '源文件必须保留。', acknowledgeDropped: true },
  })
  assert.equal(lax.ok, true, JSON.stringify({ err: lax.error, failures: lax.failures }))
  const kept = readRule(root, 'rule-src-keep')
  assert.equal(kept.ok, true)
  assert.equal(kept.rule.text.includes('用户原件'), false, 'owner 显式确认后允许丢弃例外')
  assert.deepEqual(kept.rule.front.exceptions, [], 'front 例外不得与正文漂移')
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

// ---------------------------------------------------------------------------
// R8-03/04/05：planHash CAS / 双击 / needs_manual 可见 / hash 含 scope+role / 冷却绝对窗口
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// R8-01 编号不变式在 apply 的复核：停用/取代号不复用，墓碑号拒绝
// ---------------------------------------------------------------------------

test('applyProposal：停用/取代最高号仍占号 → 新提案自动顺延，不复用该号', async (t) => {
  const root = freshRoot(t)
  seed(root, { key: 'iron-rule-1', type: 'iron-rule', number: 1, object: '审计日志', exceptions: [] }, '审计日志必须保留。')
  seed(root, { key: 'iron-rule-2', type: 'iron-rule', number: 2, object: '过程稿', action: '归档', exceptions: [] }, '过程稿必须归档。')
  seed(root, { key: 'iron-rule-3', type: 'iron-rule', number: 3, object: '报告', status: 'superseded', exceptions: [] }, '报告必须保留。')
  const made = createProposal({ text: '以后都别删源文件', identity: IDENTITY, rulesDir: root, config: { rules: {} } })
  // 提案期按 active 算号 → 3（已被 superseded 规则占着）；apply 必须复核并顺延到 4。
  assert.equal(made.proposal.draft.number, 3)
  const result = await applyProposal({ id: made.proposal.id, rulesDir: root, config: { rules: {} }, git: false })
  assert.equal(result.ok, true, JSON.stringify({ err: result.error, failures: result.failures }))
  assert.equal(result.applied.number, 4, 'superseded 文件仍占号，不得复用 3')
  assert.equal(result.applied.numberAdjusted?.reason, 'occupied', '顺延原因必须回给面板')
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

// ---------------------------------------------------------------------------
// 锁内重算：并发提案抢号 / plan 与 apply 之间的磁盘变化（planHash 以锁内为准）
// ---------------------------------------------------------------------------

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
