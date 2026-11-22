/**
 * 规则引擎单测（架构书 §3.2/§4.2/§4.3/§5.1，施工计划书 R2）。
 * 覆盖：显式/纠正/偏好/描述句、隐私拒绝、条件保留、编译模板与剥噪、
 * 长度硬顶、去重键、相似度边界、冲突（翻转/异值/跨域/跨工作区）、升格判定。
 * 纯函数脱库单测：不碰 DB、不碰宿主，只 import src/core/rules.js。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFLICT_SIMILARITY,
  DEFAULT_MIN_SCORE,
  DOMAINS,
  RULE_HARD_CHARS,
  RULE_RECOMMENDED_CHARS,
  compileRule,
  conflictWith,
  dedupeKey,
  detectSignals,
  normalizeRuleText,
  ruleKeyOf,
  shouldPromote,
  similarity,
} from '../../src/core/rules.js'

test('显式定规：owner「以后都」→ explicit + ruleLike，0.85–0.95 区间', () => {
  const sig = detectSignals('以后都早点睡', { source: 'owner' })
  assert.equal(sig.explicit, true)
  assert.equal(sig.imperative, true)
  assert.equal(sig.ruleLike, true)
  assert.equal(sig.rejectReason, null)
  assert.ok(sig.score >= 0.85 && sig.score <= 0.95)
  assert.equal(sig.repeat, 0, '重复权重由 R3 调用方叠加，本函数固定 0')
  assert.equal(sig.source, 'owner')
})

test('普通显式约束「必须/禁止」= 0.85，强标记「以后都/铁律」= 0.95', () => {
  assert.equal(detectSignals('必须每天备份').score, 0.85)
  assert.equal(detectSignals('以后都早点睡').score, 0.95)
  assert.equal(detectSignals('记成铁律：别动生产库').score, 0.95)
})

test('可机检 +0.05：端口/数字让分数抬一档且封顶 1', () => {
  assert.equal(detectSignals('网关端口必须固定为 3982').score, 0.9)
  const capped = detectSignals('以后都别用 rm 删除 /tmp 目录')
  assert.ok(capped.score <= 1)
  assert.equal(detectSignals('以后都别用 rm').score, 1, '0.95 + 0.05 封顶 1')
})

test('英文祈使：must/never/always/only 都算显式', () => {
  for (const text of ['You must never delete the report', 'always use pnpm', 'only touch src files', 'never push to main']) {
    assert.equal(detectSignals(text).explicit, true, text)
    assert.equal(detectSignals(text).ruleLike, true, text)
  }
})

test('纠正既有行为：correction=true、不是 explicit，分数落在 0.65–0.90', () => {
  const strong = detectSignals('不对，应该改成 pnpm，因为 pnpm 快')
  assert.equal(strong.correction, true)
  assert.equal(strong.explicit, false)
  assert.equal(strong.ruleLike, true)
  assert.ok(strong.score >= 0.65 && strong.score <= 0.9)

  const weak = detectSignals('这样不对')
  assert.equal(weak.correction, true)
  assert.equal(weak.score, 0.65, '无强纠正标记不加成')
})

test('偏好不升：「尽量/最好」→ preference、ruleLike=false、shouldPromote=reject', () => {
  const sig = detectSignals('尽量用中文回答', { source: 'owner' })
  assert.equal(sig.ruleLike, false)
  assert.equal(sig.rejectReason, 'preference')
  assert.equal(sig.score, 0)
  assert.equal(shouldPromote(sig, { rules: { mode: 'auto' } }), 'reject')
})

test('描述句不升：陈述句 ruleLike=false，rejectReason=descriptive', () => {
  const sig = detectSignals('端口是 3982')
  assert.equal(sig.ruleLike, false)
  assert.equal(sig.rejectReason, 'descriptive', '纯描述句没有规则信号')
  assert.equal(sig.score, 0, '描述句即使带端口也不该有规则分')
  assert.equal(shouldPromote(sig, { rules: { mode: 'auto' } }), 'reject')
  // 空文本同样不得被当成规则
  assert.equal(detectSignals('').ruleLike, false)
  assert.equal(detectSignals('').score, 0)
})

test('隐私拒绝：sk- 密钥/手机号/身份证 → rejectReason=privacy，永不升格', () => {
  for (const text of [
    '以后都用 sk-abc123456789 这个 key',
    '以后都记住手机号 13800138000',
    '以后都把身份证 110101199003071234 存起来',
  ]) {
    const sig = detectSignals(text, { source: 'owner' })
    assert.equal(sig.rejectReason, 'privacy', text)
    assert.equal(shouldPromote(sig, { rules: { mode: 'auto' } }), 'reject', text)
    assert.equal(compileRule(text, sig).ok, false, text)
    assert.equal(compileRule(text, sig).error, 'privacy', text)
  }
})

test('条件保留：「例外：」抽原文，编译进「例外」槽且理由句不进正文', () => {
  const text = '记成铁律：以后写报告前先备份；例外：用户原件、最终交付、明确要求保留。因为删了找不回'
  const sig = detectSignals(text)
  assert.deepEqual(sig.conditions, ['用户原件、最终交付、明确要求保留'])
  const out = compileRule(text, sig)
  assert.equal(out.ok, true)
  assert.ok(out.text.startsWith('【规则·file-hygiene】'), out.text)
  assert.ok(out.text.includes('例外：用户原件、最终交付、明确要求保留'), out.text)
  assert.equal(out.text.match(/例外/g).length, 1, '例外只出现一次，正文不再重复')
  assert.ok(!out.text.includes('因为删了找不回'), '理由只进审计，不进正文')
})

test('条件保留：「除非…」抽原文、正文剥掉从句只剩命令', () => {
  const text = '以后都别删源文件，除非我明确要求保留。'
  const sig = detectSignals(text)
  assert.deepEqual(sig.conditions, ['除非我明确要求保留'])
  const out = compileRule(text, sig)
  assert.equal(out.ok, true)
  assert.ok(out.text.includes('以后都别删源文件'), out.text)
  assert.equal((out.text.match(/除非/g) || []).length, 1, '除非只在例外槽出现一次')
})

test('条件保留：「当…时」按片段抽取，不编造内容', () => {
  const sig = detectSignals('当上下文超过 50% 时先提醒我。')
  assert.deepEqual(sig.conditions, ['当上下文超过 50% 时'])
})

test('编译模板：【规则·域】祈使句；作用域：共享。', () => {
  const out = compileRule('网关端口必须固定为 3982')
  assert.equal(out.ok, true)
  assert.equal(out.error, null)
  assert.equal(out.warn, null)
  assert.equal(out.text, '【规则·network】网关端口必须固定为 3982；作用域：共享。')
  assert.equal(out.chars, out.text.length)
})

test('compileRule 剥理由/链接/口水/编号，正文只留指令', () => {
  const noisy = compileRule('嗯，以后都用 pnpm，那个，别用 npm，因为 pnpm 更快（参考 https://pnpm.io/benchmarks）')
  assert.equal(noisy.ok, true)
  assert.ok(noisy.text.includes('以后都用 pnpm'), noisy.text)
  assert.ok(noisy.text.includes('别用 npm'), noisy.text)
  assert.ok(!/嗯|那个|因为|https?:\/\//.test(noisy.text), noisy.text)

  const numbered = compileRule('1. 以后都用 pnpm\n2. 别用 npm')
  assert.equal(numbered.ok, true)
  assert.ok(numbered.text.includes('以后都用 pnpm；别用 npm'), numbered.text)
  assert.ok(!/^\s*[12][.、]/m.test(numbered.text), '编号不得残留')
})

test('compileRule 作用域：透传 workspace，缺省写「共享」', () => {
  const sig = detectSignals('以后都别删源文件', { workspace: '/home/hy/网页端聊天' })
  const out = compileRule('以后都别删源文件', sig)
  assert.equal(out.ok, true)
  assert.ok(out.text.includes('作用域：/home/hy/网页端聊天。'), out.text)
  assert.ok(compileRule('以后都别删源文件').text.includes('作用域：共享。'))
})

test('compileRule 长度：推荐 200 告警、硬顶 500 拒绝（正文不回显）', () => {
  const long = '以后都' + '备份文件'.repeat(60)
  const out = compileRule(long, detectSignals(long))
  assert.equal(out.ok, true)
  assert.equal(out.warn, 'long')
  assert.ok(out.chars > RULE_RECOMMENDED_CHARS && out.chars <= RULE_HARD_CHARS, String(out.chars))

  const huge = '以后都' + '备份文件'.repeat(150)
  const rejected = compileRule(huge, detectSignals(huge))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'too_long')
  assert.equal(rejected.text, '', '超长不返回半句正文')
  assert.ok(rejected.chars > RULE_HARD_CHARS)
})

test('compileRule 失败路径返回明确 error，不返回 undefined', () => {
  assert.deepEqual(compileRule('端口是 3982'), { ok: false, text: '', error: 'descriptive', chars: 0, warn: null })
  assert.equal(compileRule('尽量用中文回答').error, 'preference')
  assert.equal(compileRule('').error, 'empty')
  assert.equal(compileRule('以后都用 sk-abc123456789').error, 'privacy')
  const bad = compileRule(null)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'empty')
})

test('去重键：归一化后稳定（大小写/空白/标点无关），16 hex', () => {
  const a = dedupeKey('以后都用 pnpm')
  assert.equal(a, dedupeKey('以后都用PNPM。'))
  assert.equal(a, dedupeKey('  以后都 用 pnpm！ '))
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, dedupeKey('以后都用 npm'))
  assert.equal(normalizeRuleText('以后都用 PNPM！'), '以后都用pnpm')
  assert.equal(normalizeRuleText('a b'), 'ab', '去空白是设计的一部分：空格不改变规则语义')
})

test('相似度：同文=1、无关=0、空=0、部分重合落在 (0,1)', () => {
  assert.equal(similarity('以后都用 pnpm', '以后都用 pnpm'), 1)
  assert.equal(similarity('以后都用 pnpm', '今天天气不错'), 0)
  assert.equal(similarity('', ''), 0)
  assert.equal(similarity('', '以后都用 pnpm'), 0)
  const mid = similarity('以后都用 pnpm', '以后都别用 npm')
  assert.ok(mid > 0 && mid < 1, String(mid))
  assert.equal(similarity('以后都用 pnpm', '以后都用PNPM。'), 1, '归一化后完全相同')
})

test('冲突：同域 + 否定翻转 → ids + reason=negation_flip', () => {
  const res = conflictWith(
    [{ id: 'n-flip', text: '以后都要删除原始文件', workspace: '' }],
    { text: '以后都不许删除原始文件' },
  )
  assert.equal(res.conflict, true)
  assert.deepEqual(res.ids, ['n-flip'])
  assert.equal(res.reason, 'negation_flip')
})

test('冲突：同域异值（端口 3982 vs 3002）→ reason=value_mismatch', () => {
  const res = conflictWith(
    [{ id: 'n-port', text: '网关端口必须是 3002', workspace: '' }],
    { text: '网关端口必须是 3982' },
  )
  assert.equal(res.conflict, true)
  assert.deepEqual(res.ids, ['n-port'])
  assert.equal(res.reason, 'value_mismatch')
})

test('冲突：不同域 / 不同 workspace 不冲突；共享作用域才算同域', () => {
  assert.equal(conflictWith(
    [{ id: 'x', text: '面板按钮必须用中文', workspace: '', domain: 'ui' }],
    { text: '面板按钮必须用中文', domain: 'network' },
  ).conflict, false)

  assert.equal(conflictWith(
    [{ id: 'y', text: '以后都不许删除原始文件', workspace: '/w1' }],
    { text: '以后都要删除原始文件', workspace: '/w2' },
  ).conflict, false)

  // undefined workspace = 共享，与 '' 同作用域
  assert.equal(conflictWith(
    [{ id: 'z', text: '以后都要删除原始文件' }],
    { text: '以后都不许删除原始文件' },
  ).conflict, true)
})

test('冲突：无输入/无冲突返回稳定空对象', () => {
  assert.deepEqual(conflictWith(null, null), { conflict: false, ids: [], reason: 'none' })
  assert.deepEqual(conflictWith([], { text: '以后都用 pnpm' }), { conflict: false, ids: [], reason: 'none' })
  assert.equal(CONFLICT_SIMILARITY > 0 && CONFLICT_SIMILARITY < 1, true)
})

test('ruleKeyOf：rule:<domain>-<hash8>，hash 与 dedupeKey 前 8 位一致', () => {
  const text = '网关端口必须固定为 3982'
  assert.equal(ruleKeyOf(text), `rule:network-${dedupeKey(text).slice(0, 8)}`)
  assert.equal(ruleKeyOf('随便一句', { domain: 'custom' }), `rule:custom-${dedupeKey('随便一句').slice(0, 8)}`)
  assert.match(ruleKeyOf('以后都用 pnpm'), /^rule:general-[0-9a-f]{8}$/)
  assert.equal(DOMAINS.includes('file-hygiene'), true)
})

test('shouldPromote：owner + 显式 + 达门槛 → auto；差一点 → shadow', () => {
  const owner = detectSignals('必须每天备份', { source: 'owner' })
  assert.equal(owner.score, 0.85)
  assert.equal(shouldPromote(owner, { rules: { mode: 'auto' } }), 'auto')
  assert.equal(shouldPromote(owner, { rules: { mode: 'auto', minScore: 0.85 } }), 'auto', '等于门槛也升')
  assert.equal(shouldPromote(owner, { rules: { mode: 'auto', minScore: 0.86 } }), 'shadow')
  assert.equal(DEFAULT_MIN_SCORE, 0.82)
})

test('shouldPromote：self/group/web 最高 shadow；owner 的纠正也不自动置顶', () => {
  for (const source of ['self', 'group', 'web']) {
    assert.equal(shouldPromote(detectSignals('以后都用 pnpm', { source, workspace: '' }), { rules: { mode: 'auto' } }), 'shadow', source)
  }
  const ownerCorrection = detectSignals('不对，应该改成 pnpm', { source: 'owner' })
  assert.equal(ownerCorrection.explicit, false)
  assert.equal(shouldPromote(ownerCorrection, { rules: { mode: 'auto' } }), 'shadow')
})

test('shouldPromote：mode=off / enabled=false / 非规则 一律 reject；shadow 模式恒 shadow', () => {
  const owner = detectSignals('以后都别用 rm', { source: 'owner' })
  assert.equal(shouldPromote(owner, { rules: { mode: 'off' } }), 'reject')
  assert.equal(shouldPromote(owner, { rules: { enabled: false, mode: 'auto' } }), 'reject')
  assert.equal(shouldPromote(detectSignals('今天天气不错'), { rules: { mode: 'auto' } }), 'reject')
  assert.equal(shouldPromote(null, {}), 'reject')
  assert.equal(shouldPromote(owner, { rules: { mode: 'shadow' } }), 'shadow')
  // 扁平配置（测试/调用方直接传）同样生效
  assert.equal(shouldPromote(owner, { mode: 'auto' }), 'auto')
})

test('域推断：file-hygiene / memory / network / ui / process / general', () => {
  assert.equal(detectSignals('以后都把过程稿归档后删除').domain, 'file-hygiene')
  assert.equal(detectSignals('以后都把这条记进记忆并置顶').domain, 'memory')
  assert.equal(detectSignals('网关端口必须固定为 3982').domain, 'network')
  assert.equal(detectSignals('面板按钮文案必须用中文').domain, 'ui')
  assert.equal(detectSignals('收尾必须做四件套').domain, 'process')
  assert.equal(detectSignals('以后都早点睡').domain, 'general')
})
