/**
 * 「规则」页签提案/确认链路契约测试（零依赖、零网络、无 DOM）。
 *
 * 锁住 R3b 客户端面：提案列表渲染契约、关系/状态徽标映射、守卫失败与丢弃子句风险条、
 * 收录二次确认（写入文件+commit+渲染 AGENTS+镜像）、改写提交 decisions.text、拒绝调用与
 * 冷却文案、错误码文案、待确认计数、空态、手动提案、三语 key 齐全。
 * 唯一执行源码的用例抽取 client 的 `rules:pure` 标记块（纯函数、无 React/无 t()）在 node 里跑，
 * 确认缺字段不抛、不出现 undefined。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
const LANGS = ['zh', 'en', 'ja']

function flatten(node, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flatten(value, dotted))
    else out[dotted] = value
  }
  return out
}

function locale(lang) {
  return flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', `${lang}.json`), 'utf8')))
}

const dicts = Object.fromEntries(LANGS.map((lang) => [lang, locale(lang)]))

function contractBlock(marker) {
  const start = CLIENT.indexOf(`// >>> ${marker}`)
  const end = CLIENT.indexOf(`// <<< ${marker}`, start)
  assert.ok(start >= 0, `缺少 ${marker} 起始标记`)
  assert.ok(end > start, `缺少 ${marker} 结束标记`)
  return CLIENT.slice(start, end)
}

function sliceFrom(name, nextMarker) {
  const start = CLIENT.indexOf(name)
  assert.ok(start >= 0, `找不到 ${name}`)
  const end = CLIENT.indexOf(nextMarker, start)
  assert.ok(end > start, `${name} 缺少结束边界 ${nextMarker}`)
  return CLIENT.slice(start, end)
}

function proposalApi() {
  const source = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  return new Function(`${source}
return {
  PROPOSAL_RELATIONS, PROPOSAL_STATUSES, PROPOSAL_RELATION_KEYS, PROPOSAL_STATUS_KEYS,
  proposalRelationOf, proposalStatusOf, proposalRelationTone, proposalStatusTone,
  proposalAffectedOf, proposalCandidateOf, proposalGuardOf, proposalDroppedOf,
  proposalRiskOf, proposalPreview, composeProposalText, proposalDecisionsFor,
}`)()
}

const tKeys = (source, prefix) => new Set(
  [...source.matchAll(new RegExp(`t\\('(${prefix}\\.[A-Za-z0-9_.]+)'`, 'g'))].map((match) => match[1]),
)

const cardSource = () => sliceFrom('function RulesProposalsCard(props) {', 'function RulesTable(props) {')
const itemSource = () => sliceFrom('function RulesProposalItem(props) {', 'function RulesProposalsCard(props) {')
const editorSource = () => sliceFrom('function RulesProposalEditor(props) {', 'function RulesProposalItem(props) {')
const riskSource = () => sliceFrom('function RulesProposalRiskBar(props) {', 'function RulesProposalEditor(props) {')
const viewSource = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
const drawerSource = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
const emptyGuideSource = () => sliceFrom('function RulesEmptyGuide(props) {', 'function RulesGitGuide(props) {')

test('提案端点与契约：GET ?status=pending / propose / apply / reject', () => {
  assert.ok(CLIENT.includes("callJson('/rules/proposals?status=pending,needs_manual')"), '缺少 GET /rules/proposals?status=pending,needs_manual')
  assert.ok(CLIENT.includes("callJson('/rules/propose', {"), '缺少 POST /rules/propose')
  assert.ok(CLIENT.includes("callJson('/rules/apply', {"), '缺少 POST /rules/apply')
  assert.ok(CLIENT.includes("callJson('/rules/reject', {"), '缺少 POST /rules/reject')
  const item = itemSource()
  assert.ok(item.includes('body: JSON.stringify({ id, decisions })'), 'apply 载荷必须只有 id/decisions')
  assert.ok(item.includes('await callJson(\'/rules/reject\''), '拒绝未走 POST /rules/reject')
  const card = cardSource()
  assert.match(card, /Array\.isArray\(proposals\.items\) \? proposals\.items : \[\]/, '提案列表缺 items 兜底')
  assert.match(viewSource(), /Array\.isArray\(body && body\.items\)/, '接口缺 items 数组兜底')
})

test('关系徽标：六种关系映射 + 未知值归中性', () => {
  const api = proposalApi()
  assert.deepEqual(api.PROPOSAL_RELATIONS, ['new', 'duplicate', 'refine', 'merge', 'conflict', 'unrelated'])
  for (const relation of api.PROPOSAL_RELATIONS) {
    assert.equal(Object.prototype.hasOwnProperty.call(api.PROPOSAL_RELATION_KEYS, relation), true, `缺少关系键 ${relation}`)
    assert.ok(api.PROPOSAL_RELATION_KEYS[relation].startsWith('rules.rel'), `关系键前缀错误 ${relation}`)
  }
  assert.equal(api.proposalRelationOf({ relation: 'merge' }), 'merge')
  assert.equal(api.proposalRelationOf({ relation: 'MERGE' }), 'merge')
  assert.equal(api.proposalRelationOf({}), 'unrelated', '缺 relation 未兜底')
  assert.equal(api.proposalRelationOf(null), 'unrelated')
  assert.equal(api.proposalRelationTone('conflict'), 'error', '冲突应为红色调')
  assert.equal(api.proposalRelationTone('merge'), 'warn')
  assert.equal(api.proposalRelationTone('new'), 'brand')
  assert.equal(api.proposalRelationTone('refine'), 'brand')
  assert.equal(api.proposalRelationTone('duplicate'), 'warn')
  assert.equal(api.proposalRelationTone('unrelated'), 'muted')
})

test('提案状态徽标：pending/needs_manual/accepted/rejected/expired + 未知归一 pending', () => {
  const api = proposalApi()
  assert.deepEqual(api.PROPOSAL_STATUSES, ['pending', 'needs_manual', 'accepted', 'rejected', 'expired'])
  for (const status of api.PROPOSAL_STATUSES) {
    assert.equal(Object.prototype.hasOwnProperty.call(api.PROPOSAL_STATUS_KEYS, status), true, `缺少状态键 ${status}`)
    assert.ok(api.PROPOSAL_STATUS_KEYS[status].startsWith('rules.proposalStatus'), `状态键前缀错误 ${status}`)
  }
  assert.equal(api.proposalStatusOf({ status: 'accepted' }), 'accepted')
  assert.equal(api.proposalStatusOf({ status: 'proposed' }), 'pending', '历史写法未收敛到 pending')
  assert.equal(api.proposalStatusOf({}), 'pending')
  assert.equal(api.proposalStatusTone('accepted'), 'ok')
  assert.equal(api.proposalStatusTone('pending'), 'warn')
  assert.equal(api.proposalStatusTone('expired'), 'muted')
})

test('候选与受影响旧规则：字段缺失兜底、字符串子句包成数组、changed 推断', () => {
  const api = proposalApi()
  const empty = api.proposalCandidateOf({})
  assert.equal(empty.text, '')
  assert.deepEqual(empty.conditions, [])
  assert.deepEqual(empty.exceptions, [])
  assert.equal(empty.number, null)
  assert.equal(empty.chars, 0)
  const fromAffected = api.proposalCandidateOf({
    affected: [{ key: 'R-1', number: 2, oldText: 'a', newText: 'b', preserved: 'p', dropped: 'd' }],
  })
  assert.equal(fromAffected.text, 'b', '缺 candidate.text 未退到 affected.newText')
  const rows = api.proposalAffectedOf({
    affected: [{ key: 'R-1', number: 2, oldText: 'a', newText: 'b', preserved: 'p', dropped: 'd' }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].changed, true, 'changed 未按新旧正文推断')
  assert.deepEqual(rows[0].preserved, ['p'], '字符串 preserved 未包成数组')
  assert.deepEqual(rows[0].dropped, ['d'], '字符串 dropped 未包成数组')
  assert.equal(api.proposalAffectedOf({ affected: 'nope' }).length, 0)
  assert.equal(api.proposalAffectedOf(null).length, 0)
  const dropped = api.proposalDroppedOf({ affected: [{ key: 'R-1', number: 2, dropped: ['x', { text: 'y' }] }] })
  assert.deepEqual(dropped.map((row) => row.text), ['x', 'y'])
})

test('守卫归一与风险判定：guard 缺失放行，失败/丢弃必须勾选 acknowledgeDropped', () => {
  const api = proposalApi()
  const missing = api.proposalGuardOf({})
  assert.equal(missing.ok, true, '缺 guard 不应默认失败')
  assert.deepEqual(missing.failures, [])
  const failed = api.proposalGuardOf({ guard: { ok: false, failures: [{ code: 'scope_missing', key: 'R-1', detail: 'scope' }] } })
  assert.equal(failed.ok, false)
  assert.equal(failed.failures[0].code, 'scope_missing')
  const clean = api.proposalRiskOf({ relation: 'conflict', guard: { ok: true, failures: [] } })
  assert.equal(clean.risky, false)
  assert.equal(clean.requiresAck, false)
  const guardRisk = api.proposalRiskOf({ relation: 'merge', guard: { ok: false, failures: [{ code: 'dup' }] } })
  assert.equal(guardRisk.risky, true)
  assert.equal(guardRisk.requiresAck, true)
  assert.deepEqual(guardRisk.reasons, ['guard'])
  const droppedRisk = api.proposalRiskOf({
    relation: 'merge',
    guard: { ok: true, failures: [] },
    affected: [{ key: 'R-1', number: 1, dropped: ['clause'] }],
  })
  assert.equal(droppedRisk.risky, true)
  assert.equal(droppedRisk.requiresAck, true)
  assert.deepEqual(droppedRisk.dropped.map((row) => row.text), ['clause'])
  assert.deepEqual(droppedRisk.reasons, ['dropped'])
})

test('正文预览 ≤200 字截断、展开标记、空白压平', () => {
  const api = proposalApi()
  const short = api.proposalPreview('  a\n\n b  ', 200)
  assert.equal(short.text, 'a b')
  assert.equal(short.truncated, false)
  const long = api.proposalPreview('x'.repeat(250), 200)
  assert.equal(long.truncated, true)
  assert.equal(long.preview.length, 201)
  assert.ok(long.preview.endsWith('…'))
  assert.equal(api.proposalPreview(null, 200).text, '')
  assert.equal(api.proposalPreview('y'.repeat(200), 200).truncated, false, '200 字边界不应截断')
})

test('改写提交：正文+条件/例外/作用域合成，decisions 只带契约字段', () => {
  const api = proposalApi()
  const composed = api.composeProposalText({
    text: ' 正文 ', conditions: ['c1', { text: 'c2' }], exceptions: ['e1'], scope: ' workspace:w ',
  })
  assert.equal(composed, '正文\n\n条件：\n- c1\n- c2\n\n例外：\n- e1\n\n作用域：workspace:w')
  assert.equal(api.composeProposalText({ text: '' }), '')
  assert.equal(api.composeProposalText(null), '')
  const decisions = api.proposalDecisionsFor({ text: '  x  ', acknowledgeDropped: true, acceptAffected: ['R-1'] })
  assert.deepEqual(decisions, { text: 'x', acknowledgeDropped: true, acceptAffected: ['R-1'] })
  assert.deepEqual(api.proposalDecisionsFor({}), {})
  assert.deepEqual(api.proposalDecisionsFor({ text: '', acknowledgeDropped: false }), {})
})

test('提案卡渲染契约：徽标/正文/元信息/来源/旧→新/保留丢弃/守卫/三操作', () => {
  const item = itemSource()
  for (const token of [
    'proposalCandidateOf(item)', 'proposalAffectedOf(item)', 'proposalGuardOf(item)', 'proposalRiskOf(item)',
    "proposalPreview(candidate.text, 200)", "t('rules.proposalMeta'", "t('rules.proposalSource'",
    "t('rules.proposalAffected'", "t('rules.proposalOld'", "t('rules.proposalNew'",
    "'rules.proposalPreserved'", "'rules.proposalDropped'", "t('rules.proposalGuardFailed'",
    "t('rules.proposalApply'", "t('rules.proposalRewrite'", "t('rules.proposalReject'",
    'h(RulesProposalBadge, { t, kind: \'relation\'', 'h(RulesProposalBadge, { t, kind: \'status\'',
    "t('rules.proposalExpand')", "t('rules.proposalCollapse')", "t('rules.proposalRejectReason')",
  ]) {
    assert.ok(item.includes(token), `提案卡缺少 ${token}`)
  }
  const card = cardSource()
  assert.match(card, /items\.map\(\(item, index\) => h\(RulesProposalItem/, '提案列表未渲染真实提案卡')
  assert.ok(card.includes("t('rules.proposalLoading')"), '缺少加载态')
  assert.ok(card.includes("t('rules.proposalError')") && card.includes('onRetry'), '缺少错误态与重试')
})

test('风险条：警告色克制、列出守卫/丢弃原因、勾选 acknowledgeDropped 才放行', () => {
  const risk = riskSource()
  assert.ok(risk.includes('role: \'alert\''), '风险条缺少 role=alert')
  assert.ok(risk.includes("t('rules.proposalRiskTitle')"), '缺少风险标题')
  assert.ok(risk.includes("t('rules.proposalRiskGuard')"), '缺少守卫失败原因')
  assert.ok(risk.includes("t('rules.proposalRiskDropped'"), '缺少丢弃子句原因')
  assert.ok(risk.includes("t('rules.proposalAckDropped')"), '缺少确认勾选文案')
  assert.ok(risk.includes('type: \'checkbox\''), '缺少风险确认勾选框')
  const cssBlock = CLIENT.slice(CLIENT.indexOf('      rulesRiskBar: {'), CLIENT.indexOf('      rulesRiskDroppedList:'))
  assert.ok(cssBlock.includes('var(--dsw-alias-state-warn-primary)'), '风险条未用警告色')
  assert.ok(cssBlock.includes('inset 3px 0 0 var(--dsw-alias-state-error-primary)'), '风险条缺少克制的红色风险标记')
  assert.ok(!cssBlock.includes('background: var(--dsw-alias-state-error-primary)'), '风险条不应整块报红')
  const item = itemSource()
  assert.match(item, /const gated = risk\.requiresAck && !ack/, '缺少勾选门禁')
  assert.ok(item.includes('disabled: applyDisabled'), '收录按钮未按门禁禁用')
  assert.ok(item.includes('acknowledgeDropped: risk.requiresAck ? ack : false'), '未把勾选结果写进 decisions')
})

test('收录二次确认说明写入文件+commit+渲染 AGENTS+镜像', () => {
  const item = itemSource()
  assert.ok(item.includes("askConfirm(t('rules.proposalApplyConfirm'))"), '收录缺少二次确认')
  const zh = dicts.zh['rules.proposalApplyConfirm']
  for (const token of ['规则文件', 'git commit', 'AGENTS.md', '镜像']) {
    assert.ok(zh.includes(token), `确认文案缺少 ${token}`)
  }
  for (const lang of LANGS) {
    assert.equal(typeof dicts[lang]['rules.proposalApplyConfirm'], 'string', `${lang} 缺少收录确认文案`)
  }
})

test('改写弹层：预填候选正文，可编辑条件/例外/作用域，提交 decisions.text', () => {
  const editor = editorSource()
  assert.ok(editor.includes("useState(initialText || candidate.text || '')"), '正文未预填候选正文')
  for (const token of [
    "t('rules.proposalRewriteTitle')", "t('rules.proposalRewriteHint')", "t('rules.proposalEditorText')",
    "t('rules.proposalEditorConditions')", "t('rules.proposalEditorExceptions')",
    "t('rules.proposalEditorScope')", "t('rules.proposalRewriteNote')", "t('rules.proposalRewriteSubmit')",
  ]) {
    assert.ok(editor.includes(token), `改写弹层缺少 ${token}`)
  }
  assert.ok(editor.includes('composeProposalText('), '改写弹层未合成正文')
  assert.ok(editor.includes('blocked ? h(') && editor.includes("t('rules.proposalAckHint')"), '风险未勾选时改写提交未拦住')
  const item = itemSource()
  assert.ok(item.includes('initialText: candidate.text'), '改写入口未传候选正文')
  assert.ok(item.includes('blocked: gated'), '改写弹层未接风险门禁')
  assert.match(item, /text: typeof text === 'string' \? text : ''/, '改写提交未带 decisions.text')
})

test('拒绝：可选理由、30 天冷却提示、成功后从列表移除', () => {
  const item = itemSource()
  assert.ok(item.includes('reason: trimmed || undefined'), '拒绝理由未按可选字段提交')
  assert.ok(item.includes('maxLength: 120'), '拒绝理由缺少长度上限')
  assert.ok(item.includes("t('rules.proposalRejectConfirm')"), '拒绝缺少二次确认')
  assert.ok(item.includes('onChanged({ kind: \'rejected\', id })'), '拒绝成功未通知父级移除')
  const view = viewSource()
  assert.match(view, /String\(item\.id\) !== String\(event\.id\)/, '拒绝后未从列表本地移除')
  assert.ok(view.includes("t('rules.proposalCooldown')"), '缺少 30 天冷却提示')
  assert.ok(dicts.zh['rules.proposalCooldown'].includes('30 天'), '冷却文案未说明 30 天')
})

test('待确认计数实时刷新：动作成功后重载列表+详情+git', () => {
  const view = viewSource()
  assert.ok(view.includes("t('rules.proposalsCount', { n: fmtNum(proposalCount, locale) })"), '规则列表顶部缺少待确认徽标')
  assert.ok(view.includes('const proposalCount = Array.isArray(proposals.items)'), '待确认计数未取实时提案状态')
  assert.ok(view.includes("const onProposalChanged"), '缺少提案动作统一回调')
  assert.ok(view.includes('setReloadTick((v) => v + 1)'), '提案动作成功后未刷新')
  assert.ok(view.includes('onChanged: onProposalChanged'), '提案卡未接动作回调')
  assert.ok(view.includes('refreshTick: reloadTick'), '详情抽屉未接刷新 tick')
  const drawer = drawerSource()
  assert.match(drawer, /\}, \[ruleKey, refreshTick, retryTick\]\)/, '详情抽屉未随刷新重载')
  assert.ok(view.includes("callJson('/rules')"), '列表（含 git 状态）刷新缺失')
})

test('空态手动提案：文本域 → POST /rules/propose → 跳到待确认区', () => {
  const guide = emptyGuideSource()
  assert.ok(guide.includes("callJson('/rules/propose', {"), '空态缺少手动提案请求')
  assert.ok(guide.includes('body: JSON.stringify({ text })'), '手动提案未提交 text')
  assert.ok(guide.includes('textarea'), '手动提案缺少文本域')
  for (const token of [
    "t('rules.proposalManualTitle')", "t('rules.proposalManualHint')",
    "t('rules.proposalManualPlaceholder')", "t('rules.proposalManualSubmit')", "t('rules.proposalManualDone')",
  ]) {
    assert.ok(guide.includes(token), `手动提案缺少 ${token}`)
  }
  const view = viewSource()
  assert.ok(view.includes("onProposed: () => onProposalChanged({ kind: 'propose' })"), '提案成功未通知父级')
  assert.ok(view.includes('scrollIntoView'), '提案成功后未跳到待确认区')
  assert.ok(view.includes('ref: proposalsRef'), '待确认区缺少滚动锚点')
})

test('详情：历史版本查看可用，编辑/回滚走 R5 接线（详情内不再有占位 disabled）', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes('lineDiff(') && drawer.includes("t('rules.diffOld')"), '历史版本查看/diff 丢失')
  assert.ok(drawer.includes("askConfirm(t('rules.revertConfirm'))"), '回滚缺少二次确认')
  assert.ok(drawer.includes('h(RulesEditDialog') || drawer.includes('RulesEditDialog'), '详情缺少编辑弹层')
  assert.ok(!drawer.includes('rules.rollbackPending') && !drawer.includes('rules.editPending'), 'R5 不应再留占位 disabled 文案')
  assert.ok(!drawer.includes("disabled: true, title: t('rules.history')"), '历史版本不应被禁用')
})

test('i18n：提案关系/状态/按钮/风险/错误码三语齐全', () => {
  const proposalSource = [cardSource(), itemSource(), editorSource(), riskSource(), emptyGuideSource()].join('\n')
  const used = tKeys(proposalSource, 'rules')
  assert.ok(used.size >= 30, `提案链路只引用 ${used.size} 个 rules 键，疑似渲染被删`)
  for (const key of used) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  for (const key of [
    'rules.relNew', 'rules.relDuplicate', 'rules.relRefine', 'rules.relMerge', 'rules.relConflict', 'rules.relUnrelated',
    'rules.proposalStatusPending', 'rules.proposalStatusNeedsManual', 'rules.proposalStatusAccepted',
    'rules.proposalStatusRejected', 'rules.proposalStatusExpired',
    'rules.proposalApply', 'rules.proposalRewrite', 'rules.proposalReject', 'rules.proposalAckDropped',
    'rules.proposalApplyConfirm', 'rules.proposalRejectConfirm', 'rules.proposalCooldown',
    'rules.proposalsCount', 'rules.proposalsEmpty',
    'err.rule_guard_failed', 'err.rule_proposal_not_found', 'err.rule_proposal_expired',
  ]) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
    }
  }
  assert.equal(dicts.zh['rules.proposalsEmpty'], '暂无待确认提案')
  assert.ok(dicts.zh['rules.proposalsTitle'].includes('{n}'), '标题缺少 {n} 占位符')
  for (const lang of LANGS) {
    assert.ok(dicts[lang]['rules.proposalsTitle'].includes('{n}'), `${lang} 标题缺少 {n}`)
  }
})

test('运行时冒烟：提案卡真实渲染（有 risk 的 merge 提案 + 空态 + 错误态）', () => {
  const pureSource = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  const uiSource = contractBlock('rules-proposals:ui')
    .replace(/\/\/ >>> rules-proposals:ui[^\n]*/, '')
    .replace(/\/\/ <<< rules-proposals:ui[^\n]*/, '')
  const stubs = `
    const h = (type, props, ...children) => {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: merged.children }
    }
    const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    const useRef = (value) => ({ current: value })
    const css = new Proxy({}, { get: () => ({}) })
    const Card = (props) => h('section', null, props.children)
    const SectionTitle = (props) => h('div', null, props.children)
    const fmtNum = (value) => (value === null || value === undefined ? '—' : String(value))
    const fmtTime = (value) => (value === null || value === undefined ? '—' : String(value))
    const errText = (t) => t('err.unknown')
    const askConfirm = () => true
    const callJson = async () => ({})
  `
  const api = new Function(`${pureSource}\n${stubs}\n${uiSource}
return { RulesProposalsCard, RulesProposalRiskBar, RulesProposalEditor, proposalRiskOf }`)()
  const t = (key, params) => {
    const raw = dicts.zh[key] === undefined ? key : dicts.zh[key]
    return String(raw).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      params && params[name] !== undefined ? String(params[name]) : match
    ))
  }
  const textOf = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ')
    if (typeof node === 'object') {
      const props = node.props || {}
      const title = props.title ? ' ' + String(props.title) : ''
      return (textOf(node.children) + title).trim()
    }
    return ''
  }
  const item = {
    id: 'p1', createdAt: 1763800000000, status: 'pending', relation: 'merge',
    candidate: {
      key: 'R-9', type: 'normal', number: 9, priority: 2, scope: 'workspace:x',
      text: '新正文', conditions: [], exceptions: [], chars: 3,
    },
    affected: [{
      key: 'R-1', number: 1, oldText: '旧正文', newText: '新正文',
      preserved: ['保留的'], dropped: ['要删的'], changed: true,
    }],
    guard: { ok: false, failures: [{ code: 'guard_scope', key: 'R-1', detail: '作用域冲突' }] },
    source: { text: '来源要求', identity: { roleId: 'role', workspace: 'ws' }, traceId: 'tr-1' },
    cooling: false,
  }
  const tree = api.RulesProposalsCard({
    t, locale: 'zh', proposals: { status: 'ok', items: [item] }, onChanged() {}, onRetry() {},
  })
  const text = textOf(tree)
  for (const token of [
    '待确认 1 条', '合并', '待确认', '编号 #9 · 优先级 2 · 作用域 workspace:x',
    '新正文', '来源要求', 'role · ws', 'trace tr-1',
    '受影响旧规则', '旧正文', '保留的', '要删的', '守卫未通过', '作用域冲突',
    '高风险操作', '我已确认删除这些子句', '收录', '改写', '拒绝',
  ]) {
    assert.ok(text.includes(token), `渲染结果缺少「${token}」：${text.slice(0, 600)}`)
  }
  const emptyText = textOf(api.RulesProposalsCard({
    t, locale: 'zh', proposals: { status: 'ok', items: [] }, onChanged() {}, onRetry() {},
  }))
  assert.ok(emptyText.includes('暂无待确认提案'), '空态未渲染「暂无待确认提案」')
  const errorText = textOf(api.RulesProposalsCard({
    t, locale: 'zh', proposals: { status: 'error', items: [], err: { code: 'network_error' } }, onChanged() {}, onRetry() {},
  }))
  assert.ok(errorText.includes('提案读取失败'), '错误态未渲染「提案读取失败」')
  assert.ok(errorText.includes('重试'), '错误态缺少重试按钮')
  const risk = api.proposalRiskOf(item)
  assert.equal(risk.risky, true)
  const riskText = textOf(api.RulesProposalRiskBar({ t, risk, ack: false, onAck() {} }))
  for (const token of ['高风险操作', '守卫校验未通过', '丢弃 1 条子句', '要删的', '我已确认删除这些子句']) {
    assert.ok(riskText.includes(token), `风险条缺少「${token}」：${riskText}`)
  }
  const riskless = textOf(api.RulesProposalRiskBar({ t, risk: null, ack: false, onAck() {} }))
  assert.equal(riskless, '', 'risk 缺失时风险条不应渲染')
  const editorTree = api.RulesProposalEditor({
    t, item, initialText: '新正文', busy: false, blocked: false, onClose() {}, onSubmit() {},
  })
  const editorText = textOf(editorTree)
  assert.ok(editorText.includes('改写提案正文'), '改写弹层未渲染标题')
  assert.ok(editorText.includes('条件（每行一条）'), '改写弹层缺少条件输入')
  const textareas = []
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'textarea') textareas.push(node)
    collect(node.children)
  }
  collect(editorTree)
  assert.ok(textareas.length >= 3, '改写弹层正文/条件/例外文本域不全')
  assert.equal(textareas[0].props.value, '新正文', '改写弹层未预填候选正文')
})
