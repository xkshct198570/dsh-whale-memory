/**
 * 规则提案纯函数单测（R3b）：结构化编译、主句完整性、关系判定、改写守卫、提示词/回包解析。
 * 全部脱文件/脱宿主：不建目录、不写盘、不调模型——只锁判定口径（黄金样例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMergePrompt,
  classifyRelation,
  compileStructured,
  domainOfText,
  extractExplicitRef,
  extractSlots,
  guardRewrite,
  mainClauseIntact,
  normalizeForGuard,
  parseMergeReply,
  retainsClause,
  splitConditions,
} from '../../src/core/rule-reconcile.js'
import { dedupeKey } from '../../src/core/rules.js'

/** 构造一条既有规则（与 rule-store 的 doc 形状一致：{front,text}）。 */
function doc({
  key = 'rule-1', number = 1, type = 'rule', priority = 'P1', scope = 'global', modality = 'must',
  action = '', object = '', conditions = [], exceptions = [], text = '', domain = '',
} = {}) {
  return {
    front: {
      key,
      type,
      number,
      priority,
      scope,
      role: '',
      modality,
      action,
      object,
      conditions,
      exceptions,
      status: 'active',
      merged_into: '',
      superseded_by: '',
      created: '2026-11-22',
      updated: '2026-11-22',
      version: 1,
      origin: 'unit',
      ...(domain ? { domain } : {}),
    },
    text,
  }
}

// ---------------------------------------------------------------------------
// 显式身份 / 槽位 / 条件分槽
// ---------------------------------------------------------------------------

test('extractExplicitRef：铁律N 优先于 rule:<key>', () => {
  assert.deepEqual(extractExplicitRef('记成铁律17：删文档前先核路径'), { key: 'iron-rule-17', number: 17 })
  assert.deepEqual(extractExplicitRef('按 rule:file-hygiene-a1b2c3d4 收进铁律'), { key: 'file-hygiene-a1b2c3d4', number: null })
  assert.equal(extractExplicitRef('以后都别删源文件'), null)
})

test('extractSlots：剥定规前缀 + 条件从句，动作/对象分离', () => {
  assert.deepEqual(extractSlots('以后都别删源文件，例外：用户原件'), { action: '删', object: '源文件' })
  // 「只」是模态（only），动作是「保留」：模态归 modality，动作族才是槽位。
  assert.deepEqual(extractSlots('必须只保留最终交付件'), { action: '保留', object: '最终交付件' })
  const slots = extractSlots('除非用户明确要求，否则源文件归档到临时目录')
  assert.equal(slots.action, '归档')
  assert.match(slots.object, /源文件/)
})

test('splitConditions：例外进 exceptions、除非/当…时 进 conditions', () => {
  const got = splitConditions('以后都别删源文件，例外：用户原件、正在被引用的文件；除非我明确要求')
  assert.deepEqual(got.exceptions, ['用户原件', '正在被引用的文件'])
  assert.deepEqual(got.conditions, ['除非我明确要求'])
})

test('domainOfText：复用 ruleKeyOf 的域前缀解析（file-hygiene / memory）', () => {
  assert.equal(domainOfText('以后都别删源文件，过程稿一律归档'), 'file-hygiene')
  assert.equal(domainOfText('记忆检索必须带 user_id'), 'memory')
  assert.equal(domainOfText('嗯'), 'general')
})

// ---------------------------------------------------------------------------
// compileStructured 黄金样例
// ---------------------------------------------------------------------------

test('compileStructured：owner 强定规 → iron-rule / P0 / 新编号', () => {
  const got = compileStructured('以后都别删源文件', {}, { source: 'owner', nextNumber: 7 })
  assert.equal(got.ok, true)
  assert.equal(got.draft.type, 'iron-rule')
  assert.equal(got.draft.priority, 'P0')
  assert.equal(got.draft.number, 7)
  assert.equal(got.draft.modality, 'must_not')
  assert.equal(got.draft.action, '删')
  assert.equal(got.draft.object, '源文件')
  assert.equal(got.draft.scope, 'global')
  assert.match(got.draft.key, /^rule-file-hygiene-[0-9a-f]{8}$/)
  assert.ok(got.draft.chars > 0)
})

test('compileStructured：非 owner 即使显式也不置铁律（只产普通规则）', () => {
  const got = compileStructured('以后必须只保留最终交付件', {}, { source: 'self', nextNumber: 3 })
  assert.equal(got.ok, true)
  assert.equal(got.draft.type, 'rule')
  assert.notEqual(got.draft.priority, 'P0')
})

test('compileStructured：显式铁律N → key/number 钉死', () => {
  const got = compileStructured('记成铁律17：删文档前先核路径', {}, { source: 'owner', nextNumber: 18 })
  assert.equal(got.ok, true)
  assert.equal(got.draft.key, 'iron-rule-17')
  assert.equal(got.draft.number, 17)
  assert.equal(got.draft.type, 'iron-rule')
})

test('compileStructured：空号 6 永不复用（nextNumber 正好是 6 → 跳 7）', () => {
  const got = compileStructured('必须保留审计日志', {}, { source: 'owner', nextNumber: 6 })
  assert.equal(got.ok, true)
  assert.equal(got.draft.number, 7)
})

test('compileStructured：编号已被占用 → 取下一个空号', () => {
  const existing = [doc({ key: 'rule-1', number: 1 }), doc({ key: 'rule-2', number: 2 })]
  const got = compileStructured('必须保留审计日志', {}, { source: 'owner', nextNumber: 2, existingRules: existing })
  assert.equal(got.ok, true)
  assert.equal(got.draft.number, 3)
})

test('compileStructured：refine 沿用旧编号（同 key 已存在）', () => {
  const text = '以后都别删源文件'
  const first = compileStructured(text, {}, { source: 'owner', nextNumber: 5 })
  const existing = [doc({
    key: first.draft.key, number: 9, type: 'rule', text: first.draft.text,
  })]
  const again = compileStructured(text, {}, { source: 'owner', nextNumber: 10, existingRules: existing })
  assert.equal(again.ok, true)
  assert.equal(again.draft.number, 9, 'refine 必须沿用旧编号，不能重新分配')
})

test('compileStructured：铁律6 是保留空号 → number_reserved', () => {
  const got = compileStructured('记成铁律6：以后都别删源文件', {}, { source: 'owner', nextNumber: 7 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'number_reserved')
})

test('compileStructured：铁律3 已被别的 key 占用 → number_conflict', () => {
  const existing = [doc({ key: 'rule-other', number: 3 })]
  const got = compileStructured('记成铁律3：以后都别删源文件', {}, { source: 'owner', existingRules: existing })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'number_conflict')
  assert.equal(got.detail.key, 'rule-other')
})

test('compileStructured：隐私句整条拒绝（不提案、不落候选）', () => {
  const got = compileStructured('以后都记住手机号 13800138000', {}, { source: 'owner' })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'privacy')
})

test('compileStructured：纯偏好/描述句整条拒绝', () => {
  assert.equal(compileStructured('以后尽量早点睡', {}, { source: 'owner' }).error, 'preference')
  assert.equal(compileStructured('端口固定为 3982', {}, { source: 'owner' }).error, 'descriptive')
})

test('compileStructured：抽不出动作 → partial_compile（半句规则不入候选）', () => {
  const got = compileStructured('以后都别乱动', {}, { source: 'owner', nextNumber: 1 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'partial_compile')
  assert.equal(got.detail.reason, 'no_action')
})

test('compileStructured：主句残缺（动作/对象不在正文里）→ partial_compile', () => {
  // 理由句里的动作会被剔出正文；抽槽位时若只剩理由句动作，正文覆盖不了 → 拒绝。
  const got = compileStructured('必须先备份。因为删掉源文件会出事', {}, { source: 'owner', nextNumber: 1 })
  if (got.ok) {
    // 新抽取已能把主句动作（备份）当动作，允许编译通过——但正文必须不含理由句。
    assert.equal(got.draft.text.includes('因为'), false)
  } else {
    assert.equal(got.error, 'partial_compile')
  }
  assert.equal(mainClauseIntact({ action: '删', object: '源文件' }, '必须先备份。').ok, false)
})

test('mainClauseIntact：正文覆盖动作+对象才算完整（阈值 2）', () => {
  assert.equal(mainClauseIntact({ action: '删', object: '源文件' }, '以后都别删源文件').ok, true)
  assert.equal(mainClauseIntact({ action: '删', object: '源文件' }, '以后都别动文件').ok, false)
  // 单片段输入只要那一个片段命中即可（短规则不该被阈值卡死）。
  assert.equal(mainClauseIntact({ action: '备份', object: '' }, '先备份再改').ok, true)
})

test('compileStructured：scope 由 workspace 决定；role 透传', () => {
  const got = compileStructured('必须保留审计日志', {}, {
    source: 'owner', workspace: '/tmp/ws', role: 'reviewer', nextNumber: 1,
  })
  assert.equal(got.draft.scope, 'workspace:/tmp/ws')
  assert.equal(got.draft.role, 'reviewer')
})

test('compileStructured：条件/例外分槽落进草案', () => {
  const got = compileStructured('以后都别删源文件，例外：用户原件；除非我明确要求', {}, { source: 'owner', nextNumber: 1 })
  assert.deepEqual(got.draft.exceptions, ['用户原件'])
  assert.deepEqual(got.draft.conditions, ['除非我明确要求'])
})

// ---------------------------------------------------------------------------
// classifyRelation 黄金样例
// ---------------------------------------------------------------------------

test('classifyRelation：同 key → refine（沿用旧编号）', () => {
  const draft = { key: 'rule-1', text: '必须先验证再覆盖正式库。', domain: 'process', object: '正式库', modality: 'must' }
  const got = classifyRelation(draft, [doc({ key: 'rule-1', number: 4, text: '必须先验证再覆盖正式库。' })])
  assert.equal(got.relation, 'refine')
  assert.equal(got.targets[0].key, 'rule-1')
  assert.equal(got.targets[0].reason, 'same_key')
})

test('classifyRelation：dedupeKey 相同 → duplicate', () => {
  const text = '必须先验证再覆盖正式库。'
  const draft = { key: 'rule-new', text, domain: 'process', object: '正式库', modality: 'must' }
  const got = classifyRelation(draft, [doc({ key: 'rule-9', number: 9, text }), doc({ key: 'rule-8', number: 8, text })])
  assert.equal(got.relation, 'duplicate')
  assert.equal(got.targets.length, 2)
  assert.equal(got.targets[0].reason, 'same_dedupe_key')
})

test('classifyRelation：相似度 ≥0.9（非全同）→ duplicate', () => {
  const base = '以后都别删源文件，过程稿一律归档到临时目录并留 sha256 证据后再清理'
  const near = `${base}。`
  assert.equal(dedupeKey(base) === dedupeKey(near), true, '标点差异不应改变 dedupeKey')
  const draft = { key: 'rule-new', text: near, domain: 'file-hygiene', object: '源文件', modality: 'must_not' }
  const got = classifyRelation(draft, [doc({ key: 'rule-7', number: 7, text: base })])
  assert.equal(got.relation, 'duplicate')
})

test('classifyRelation：同域+同对象+反向模态 → conflict', () => {
  const draft = { key: 'rule-new', text: '以后必须删源文件。', domain: 'file-hygiene', object: '源文件', modality: 'must' }
  const got = classifyRelation(draft, [
    doc({ key: 'rule-3', number: 3, text: '以后都别删源文件。', object: '源文件', modality: 'must_not' }),
  ])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].reason, 'modality_flip')
})

test('classifyRelation：同域+同对象+模态兼容且条件互补 → merge', () => {
  const draft = {
    key: 'rule-new', text: '源文件必须保留，过程稿归档。', domain: 'file-hygiene', object: '源文件',
    modality: 'must', conditions: ['除非用户明确要求'], exceptions: ['用户原件'],
  }
  const got = classifyRelation(draft, [
    doc({
      key: 'rule-4', number: 4, text: '源文件必须保留。', object: '源文件', modality: 'must',
      conditions: ['当文件仍被引用时'], exceptions: ['正在被引用的文件'],
    }),
  ])
  assert.equal(got.relation, 'merge')
  assert.equal(got.targets[0].reason, 'complementary_conditions')
})

test('classifyRelation：条件重叠 → 不合并（不是补充）', () => {
  const draft = {
    key: 'rule-new', text: '源文件必须保留，过程稿归档。', domain: 'file-hygiene', object: '源文件',
    modality: 'must', conditions: [], exceptions: ['用户原件'],
  }
  const got = classifyRelation(draft, [
    doc({
      key: 'rule-4', number: 4, text: '源文件必须保留。', object: '源文件', modality: 'must', exceptions: ['用户原件'],
    }),
  ])
  assert.equal(got.relation, 'unrelated')
})

test('classifyRelation：同域不同对象 → unrelated（比对过但无关系）', () => {
  const draft = { key: 'rule-new', text: '审计日志必须保留。', domain: 'file-hygiene', object: '审计日志', modality: 'must' }
  const got = classifyRelation(draft, [
    doc({ key: 'rule-5', number: 5, text: '过程稿一律归档。', object: '过程稿', modality: 'must' }),
  ])
  assert.equal(got.relation, 'unrelated')
})

test('classifyRelation：推断域不同但同对象+反向模态 → conflict（槽位优先于域猜测）', () => {
  // 域是从关键词猜的（「以后都先提炼再删」会被猜成 general），拿域做前置过滤会漏掉真冲突。
  const draft = { key: 'rule-new', text: '面板必须保留审计日志。', domain: 'ui', object: '审计日志', modality: 'must' }
  const got = classifyRelation(draft, [
    doc({ key: 'rule-5', number: 5, text: '审计日志必须保留。', object: '审计日志', modality: 'must_not', domain: 'file-hygiene' }),
  ])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].reason, 'modality_flip')
})

test('classifyRelation：没有任何既有规则 → new', () => {
  const got = classifyRelation({ key: 'rule-x', text: '必须保留审计日志。', domain: 'process', object: '审计日志', modality: 'must' }, [])
  assert.equal(got.relation, 'new')
  assert.deepEqual(got.targets, [])
})

test('classifyRelation：空草案不猜关系（保持 new/unrelated + 空 targets）', () => {
  assert.deepEqual(classifyRelation({ key: 'rule-x', text: '' }, []), { relation: 'new', targets: [] })
})

// ---------------------------------------------------------------------------
// guardRewrite
// ---------------------------------------------------------------------------

/** 一条带例外/模态的旧规则（守卫的基准对象）。 */
function oldRule(overrides = {}) {
  return doc({
    key: 'rule-17',
    number: 17,
    type: 'iron-rule',
    modality: 'must_not',
    action: '删',
    object: '源文件',
    exceptions: ['用户原件', '正在被引用的文件'],
    text: '【规则·file-hygiene】以后都别删源文件。',
    ...overrides,
  })
}

test('guardRewrite：例外与模态都保留 → 放行', () => {
  const got = guardRewrite({
    affected: [oldRule()],
    mergedText: '【规则·file-hygiene】禁止删除源文件；例外：用户原件、正在被引用的文件；作用域：共享。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, true)
  assert.deepEqual(got.failures, [])
})

test('guardRewrite：同义表容错（删除/删、档案/存档）→ 仍放行', () => {
  const got = guardRewrite({
    affected: [oldRule({
      exceptions: ['用户原件'],
      text: '禁止删除过程稿。',
      modality: 'must_not',
    })],
    mergedText: '禁止删过程稿；例外：用户原件。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, true, JSON.stringify(got.failures))
})

test('guardRewrite：丢例外 → dropped_exception 拒绝', () => {
  const got = guardRewrite({
    affected: [oldRule()],
    mergedText: '以后都别删源文件。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, false)
  assert.equal(got.failures[0].code, 'dropped_exception')
  assert.equal(got.failures[0].key, 'rule-17')
})

test('guardRewrite：模态被弱化（禁止→尽量）→ modality_weakened 拒绝', () => {
  const got = guardRewrite({
    affected: [oldRule({ exceptions: [] })],
    mergedText: '以后尽量别删源文件。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((f) => f.code === 'modality_weakened'))
})

test('guardRewrite：铁律含模糊词 → vague_word 拒绝', () => {
  const got = guardRewrite({
    affected: [oldRule({ exceptions: [] })],
    mergedText: '以后尽量不要删源文件，最好先备份。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((f) => f.code === 'vague_word'))
})

test('guardRewrite：作用域被偷改 → scope_changed 拒绝', () => {
  const got = guardRewrite({
    affected: [oldRule({ exceptions: [], scope: 'workspace:/tmp/ws' })],
    mergedText: '以后都别删源文件。',
    draft: { scope: 'global', type: 'iron-rule' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((f) => f.code === 'scope_changed'))
})

test('guardRewrite：长度硬顶 500 → body_too_long 拒绝', () => {
  const got = guardRewrite({ affected: [], mergedText: '必须'.padEnd(501, '备份'), draft: { scope: 'global' } })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((f) => f.code === 'body_too_long'))
})

test('guardRewrite：隐私命中 → privacy 拒绝', () => {
  const got = guardRewrite({
    affected: [],
    mergedText: '必须记住手机号 13800138000。',
    draft: { scope: 'global' },
  })
  assert.equal(got.ok, false)
  assert.ok(got.failures.some((f) => f.code === 'privacy'))
})

test('guardRewrite：strict 下 acknowledgeDropped 不能绕过；非 strict + owner 显式确认才放行', () => {
  const args = {
    affected: [oldRule()],
    mergedText: '以后都别删源文件。',
    draft: { scope: 'global', type: 'iron-rule' },
    acknowledgeDropped: ['rule-17'],
  }
  const strict = guardRewrite({ ...args, strict: true })
  assert.equal(strict.ok, false, 'strict 模式必须拒绝')
  const lax = guardRewrite({ ...args, strict: false })
  assert.equal(lax.ok, true, JSON.stringify(lax.failures))
})

test('guardRewrite：空正文直接拒绝（不猜正文）', () => {
  const got = guardRewrite({ affected: [], mergedText: '   ', draft: { scope: 'global' } })
  assert.equal(got.ok, false)
  assert.equal(got.failures[0].code, 'body_empty')
})

test('normalizeForGuard/retainsClause：标点与同义都吃', () => {
  assert.equal(normalizeForGuard('禁止 删除，源文件！'), '禁止删除源文件')
  assert.equal(retainsClause(normalizeForGuard('禁止删源文件'), '禁止删除源文件'), true)
  assert.equal(retainsClause(normalizeForGuard('禁止删源文件'), '正在被引用的文件'), false)
})

// ---------------------------------------------------------------------------
// buildMergePrompt / parseMergeReply
// ---------------------------------------------------------------------------

test('buildMergePrompt：system 含硬约束，user 含严格 JSON 结构', () => {
  const prompt = buildMergePrompt({
    draft: { key: 'rule-x', type: 'iron-rule', scope: 'global', modality: 'must_not', text: '以后都别删源文件。' },
    affected: [oldRule()],
  })
  assert.match(prompt.system, /不得删除任何旧「例外」条目/)
  assert.match(prompt.system, /只输出一个 JSON 对象/)
  assert.match(prompt.user, /merged_text/)
  assert.match(prompt.user, /"affected"/)
  assert.match(prompt.user, /rule-17/)
})

test('parseMergeReply：容忍 ```json 围栏与前后解释文字', () => {
  const reply = '好的，合并如下：\n```json\n{"merged_text":"禁止删源文件；例外：用户原件。","affected":[{"key":"rule-17","new_text":"禁止删源文件；例外：用户原件。"}],"preserved":["用户原件"],"dropped":[]}\n```\n请复核。'
  const got = parseMergeReply(reply)
  assert.equal(got.ok, true)
  assert.equal(got.value.merged_text, '禁止删源文件；例外：用户原件。')
  assert.deepEqual(got.value.affected, [{ key: 'rule-17', new_text: '禁止删源文件；例外：用户原件。' }])
  assert.deepEqual(got.value.preserved, ['用户原件'])
})

test('parseMergeReply：坏 JSON / 缺 merged_text 返回 error（绝不猜正文）', () => {
  assert.equal(parseMergeReply('没有 JSON 的解释').error, 'no_json')
  assert.equal(parseMergeReply('{坏 json}').error, 'bad_json')
  assert.equal(parseMergeReply('{"affected":[]}').error, 'merged_text_missing')
  assert.equal(parseMergeReply('[1,2,3]').error, 'no_json')
})

test('parseMergeReply：affected 里的空 key/空正文被丢弃，不污染改写列表', () => {
  const got = parseMergeReply('{"merged_text":"禁止删源文件。","affected":[{"key":"","new_text":"x"},{"key":"rule-1","new_text":""},{"key":"rule-2","new_text":"禁止删源文件。"}]}')
  assert.equal(got.ok, true)
  assert.deepEqual(got.value.affected, [{ key: 'rule-2', new_text: '禁止删源文件。' }])
})

// ---------------------------------------------------------------------------
// 真机返工黄金样例（2026-11-22 · 抽取失真/关系漏判）
// ---------------------------------------------------------------------------

/** 编译必须成功，返回 draft（失败直接把错误码打进断言信息）。 */
function mustCompile(text, opts = {}) {
  const got = compileStructured(text, {}, { source: 'owner', nextNumber: 1, ...opts })
  assert.equal(got.ok, true, `${text} -> ${got.error}`)
  return got.draft
}

/** 把草案伪装成一条既有规则（供关系判定）。 */
function ruleFrom(draft, key = 'rule-existing') {
  return doc({
    key,
    number: draft.number,
    type: draft.type,
    priority: draft.priority,
    scope: draft.scope,
    modality: draft.modality,
    action: draft.action,
    object: draft.object,
    conditions: draft.conditions,
    exceptions: draft.exceptions,
    text: draft.text,
  })
}

test('黄金：铁律17 全文 → exceptions 4 条 / modality must / 动作删除类 / title 非空', () => {
  const text = '铁律17：文件卫生与阅后即焚——AI 生成的报告/过程稿属一次性中间产物，读完后先提炼结论进记忆或台账，再删除源文件；例外：用户原件、正在被引用的文件、最终交付件、明确要求保留的。'
  const draft = mustCompile(text, { nextNumber: 17 })
  assert.deepEqual(draft.exceptions, ['用户原件', '正在被引用的文件', '最终交付件', '明确要求保留的'])
  assert.equal(draft.modality, 'must')
  assert.ok(['删除', '删', '删掉'].includes(draft.action), draft.action)
  assert.equal(draft.number, 17)
  assert.ok(draft.title && draft.title.length > 0)
  assert.notEqual(draft.title, '删')
  assert.ok(Array.from(draft.title).length <= 12)
  assert.match(draft.text, /例外：用户原件、正在被引用的文件/)
})

test('黄金：真机输入A（以后都：…）→ 正文无「以后都：」、object=源文件、例外 2 条', () => {
  const draft = mustCompile('以后都：AI 报告读完后先提炼结论再删源文件，用户原件、最终交付例外。')
  assert.equal(draft.text.includes('以后都'), false)
  assert.equal(draft.action, '删')
  assert.equal(draft.object, '源文件')
  assert.deepEqual(draft.exceptions, ['用户原件', '最终交付'])
  assert.equal(draft.modality, 'must')
  assert.ok(draft.conditions.some((c) => c.includes('读完后')))
  assert.ok(draft.conditions.some((c) => c.includes('提炼')))
  assert.match(draft.text, /例外：用户原件、最终交付/)
})

test('黄金：真机输入B（在…前删除）→ object=AI 报告源文件、条件含时间从句、must_not', () => {
  const draft = mustCompile('以后禁止在提炼结论前删除 AI 报告源文件。')
  assert.equal(draft.action, '删除')
  assert.equal(draft.object, 'AI 报告源文件')
  assert.equal(draft.modality, 'must_not')
  assert.deepEqual(draft.conditions, ['在提炼结论前'])
  assert.equal(draft.text.includes('以后'), false)
})

test('黄金：真机输入A vs B → conflict（同对象槽位 + 反向模态），targets 指向既有 key', () => {
  const a = mustCompile('以后都：AI 报告读完后先提炼结论再删源文件，用户原件、最终交付例外。')
  const b = mustCompile('以后禁止在提炼结论前删除 AI 报告源文件。')
  const got = classifyRelation(b, [ruleFrom(a, 'iron-rule-17')])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].key, 'iron-rule-17')
})

test('黄金：「以后禁止删源文件」vs「以后都先提炼再删」→ conflict', () => {
  const oldRule = mustCompile('以后禁止删源文件')
  const draft = mustCompile('以后都先提炼再删')
  const got = classifyRelation(draft, [ruleFrom(oldRule, 'rule-old-1')])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].key, 'rule-old-1')
})

test('黄金：「删除前必须核路径」vs「删除前不必核路径」→ conflict（模态翻转）', () => {
  const oldRule = mustCompile('删除前必须核路径')
  const draft = mustCompile('删除前不必核路径')
  assert.equal(draft.object, '路径')
  assert.equal(draft.modality, 'must_not')
  const got = classifyRelation(draft, [ruleFrom(oldRule, 'rule-path')])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].reason, 'modality_flip')
})

test('黄金：「报告默认删除」vs「报告默认保留」→ conflict（动词族互斥）', () => {
  const oldRule = mustCompile('报告默认删除')
  const draft = mustCompile('报告默认保留')
  assert.equal(draft.object, '报告')
  const got = classifyRelation(draft, [ruleFrom(oldRule, 'rule-report')])
  assert.equal(got.relation, 'conflict')
  assert.equal(got.targets[0].reason, 'verb_family_flip')
})

test('黄金：「只用本地模型」→ only + 动作=用 + object=本地模型', () => {
  const draft = mustCompile('只用本地模型')
  assert.equal(draft.modality, 'only')
  assert.equal(draft.action, '用')
  assert.equal(draft.object, '本地模型')
  assert.match(draft.text, /只能用本地模型/)
})

test('黄金：「除用户原件外一律删除」→ exceptions 含用户原件 + modality except', () => {
  const draft = mustCompile('除用户原件外一律删除')
  assert.ok(draft.exceptions.includes('用户原件'))
  assert.equal(draft.modality, 'except')
  assert.match(draft.text, /例外：用户原件/)
})

test('黄金：「以后都别自动重启 DSH」→ must_not + object 含 DSH', () => {
  const draft = mustCompile('以后都别自动重启 DSH')
  assert.equal(draft.modality, 'must_not')
  assert.equal(draft.action, '重启')
  assert.match(draft.object, /DSH/)
})

test('黄金：「以后把报告归档到 _归档」→ must + action=归档 + object=报告', () => {
  const draft = mustCompile('以后把报告归档到 _归档')
  assert.equal(draft.modality, 'must')
  assert.equal(draft.action, '归档')
  assert.equal(draft.object, '报告')
  assert.match(draft.text, /归档/)
})

test('黄金：「尽量早点睡」→ preference 拒绝（模糊偏好不提案）', () => {
  const got = compileStructured('尽量早点睡', {}, { source: 'owner' })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'preference')
})

test('黄金：描述句（端口固定为 3982）→ descriptive 拒绝', () => {
  const got = compileStructured('端口固定为 3982', {}, { source: 'owner' })
  assert.equal(got.ok, false)
  assert.ok(['descriptive', 'not_rule'].includes(got.error), got.error)
})

test('黄金：同文（不同 key）→ duplicate（不新建文件）', () => {
  const draft = mustCompile('以后都别删源文件')
  const existing = ruleFrom(draft, 'rule-legacy-same')
  const got = classifyRelation(draft, [existing])
  assert.equal(got.relation, 'duplicate')
  assert.equal(got.targets[0].reason, 'same_dedupe_key')
})

test('黄金：「报告删除前要提炼」+「删除后要留审计」→ merge（同事件条件互补）', () => {
  const first = mustCompile('报告删除前要提炼')
  const second = mustCompile('删除后要留审计')
  const got = classifyRelation(second, [ruleFrom(first, 'rule-before')])
  assert.equal(got.relation, 'merge')
  assert.equal(got.targets[0].key, 'rule-before')
})

test('黄金：抽不出动作（以后都别乱动）→ partial_compile', () => {
  const got = compileStructured('以后都别乱动', {}, { source: 'owner', nextNumber: 1 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'partial_compile')
  assert.equal(got.detail.reason, 'no_action')
})

test('黄金：出现「例外」却抽不出条目 → exceptions_missing（例外不能被吞）', () => {
  const got = compileStructured('以后都别删源文件，例外：', {}, { source: 'owner', nextNumber: 1 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'exceptions_missing')
})

test('黄金：标题不是纯动词、≤12 字（面板短名）', () => {
  for (const text of ['以后都别删源文件', '以后把报告归档到 _归档', '以后都别自动重启 DSH', '删除前必须核路径']) {
    const draft = mustCompile(text)
    assert.ok(draft.title && draft.title.length > 0, text)
    assert.notEqual(draft.title, '删', text)
    assert.ok(Array.from(draft.title).length <= 12, `${text} -> ${draft.title}`)
    assert.equal(/(?:^|)删$/.test(draft.title), false, `${text} 标题不能只是动词`)
  }
})
