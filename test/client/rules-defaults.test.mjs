/**
 * 「规则」页默认铁律 / 新建 / 停用启用 的客户端契约测试（零依赖、零网络、无 DOM）。
 *
 * 锁住小白可用面：工具行新建入口、新建弹层字段与本地校验、自动编号只读提示、
 * 二次确认（写文件+git commit+重建镜像+渲染 AGENTS）、POST /rules/create 载荷、
 * 详情停用/重新启用走 POST /rules/delete 的 mode=retire|reactivate、默认铁律判定与徽标、
 * 顶部说明条（不写死条数）、全部停用空态、错误码三语映射，以及运行时渲染冒烟。
 * 可执行用例抽取 client 的 `rules:pure` 标记块（纯函数、无 React/无 t()）在 node 里跑。
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

/** 抽取 rules:pure 块并在 node 里跑：默认判定/新建校验/停用方向必须可测。 */
function rulesDefaultsApi() {
  const source = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  return new Function(`${source}
return {
  ruleOriginIsDefault, ruleIsDefault, ruleRetireMode, ruleCanToggleStatus,
  RULE_NEW_TYPES, RULE_BODY_MAX, newRuleDraftProblem, newRuleDraftPayload,
  rulesAllRetired, ruleLinesFromInput, ruleErrorDetailText,
}`)()
}

const viewSource = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
const tableSource = () => sliceFrom('function RulesTable(props) {', 'function RulesTypeBadge(props) {')
const defaultBadgeSource = () => sliceFrom('function RulesDefaultBadge(props) {', 'function RulesStatusBadge(props) {')
const newDialogSource = () => sliceFrom('function RulesNewDialog(props) {', 'function RulesDiffRows(props) {')
const drawerSource = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')

/** 运行时渲染的极小 h/useState 桩：只验证「引用未定义变量」与真实文本/按钮。 */
function runtimeStubs(extra = '') {
  return `
    const h = (type, props, ...children) => {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: merged.children }
    }
    let __stateIndex = 0
    const __presets = __PRESETS__
    const useState = (initial) => [__presets[__stateIndex++] !== undefined ? __presets[__stateIndex - 1] : initial, () => {}]
    const useEffect = () => {}
    const css = new Proxy({}, { get: () => ({}) })
    const Row = (props) => h('div', null, props.k, ': ', props.v)
    const SectionTitle = (props) => h('div', null, props.children)
    const StateBlock = () => null
    const RulesStatusBadge = (props) => h('span', null, props.value || '')
    const RulesDefaultBadge = (props) => h('span', null, '默认徽标')
    const SelectInput = (props) => h('select', null, (props.options || []).map(([v, l]) => h('option', { value: v }, l)))
    const TextInput = (props) => h('input', { value: props.value, placeholder: props.placeholder })
    const ruleNumberText = (rule) => (Number.isFinite(Number(rule && rule.number)) ? '#' + String(rule.number) : '—')
    const ruleTypeLabel = (t, value) => (String(value || '') === 'normal' || String(value || '') === 'rule'
      ? t('rules.typeNormal') : t('rules.typeIron'))
    const ruleStatusLabel = (t, value) => (String(value || '') === 'active' ? t('rules.statusActive') : t('rules.statusRetired'))
    const ruleList = (value, t) => h('ul', null, (Array.isArray(value) ? value : []).map((item) => h('li', null, item)))
    const fmtNum = (value) => (value === null || value === undefined ? '—' : String(value))
    const fmtTime = (value) => (value === null || value === undefined ? '—' : String(value))
    const errText = (t, err) => t(hasKey('err.' + String((err && err.code) || 'unknown')) ? 'err.' + String(err.code) : 'err.unknown')
    const hasKey = (key) => Object.prototype.hasOwnProperty.call(__DICT__, key)
    let __confirm = null
    const askConfirm = (message) => { __confirm = message; return true }
    let __posted = null
    const callJson = async (url, opts) => { __posted = { url, opts }; return __RESPONSE__ }
    ${extra}
  `
}

const tFrom = (dict) => (key, params) => {
  const raw = dict[key] === undefined ? key : dict[key]
  return String(raw).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    params && params[name] !== undefined ? String(params[name]) : match
  ))
}

const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

const collectButtons = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((child) => collectButtons(child, out))
    return out
  }
  if (node.type === 'button') out.push(node)
  collectButtons(node.children, out)
  return out
}

test('工具行有醒目「新建规则」按钮：品牌色、位于搜索/筛选之上且不占顶部 git 状态条', () => {
  const view = viewSource()
  assert.ok(view.includes("t('rules.new')"), '工具行缺少「新建规则」按钮文案')
  assert.ok(view.includes('style: css.buttonPrimary'), '新建按钮未用品牌主色')
  assert.ok(view.includes('onClick: () => setNewOpen(true)'), '新建按钮未打开弹层')
  assert.ok(view.indexOf("t('rules.new')") > view.indexOf('h(RulesGitBar'), '新建按钮不应挤占顶部状态条')
  assert.ok(view.indexOf("t('rules.new')") < view.indexOf("t('rules.searchPlaceholder')"), '新建入口应在搜索框之前')
  assert.ok(view.includes('h(RulesNewDialog'), '规则页未渲染新建弹层')
  assert.ok(view.includes('onCreated: onRuleCreated'), '新建弹层未接成功回调')
})

test('新建弹层字段齐全：类型/优先级/作用域+值/正文/条件/例外/动作/对象', () => {
  const dialog = newDialogSource()
  for (const token of [
    "t('rules.newTitle')", "t('rules.newHint')", "t('rules.newTypeLabel')",
    "t('rules.editPriorityLabel')", "t('rules.editScopeLabel')", "t('rules.editScopeValueLabel')",
    "t('rules.editTextLabel')", "t('rules.editConditionsLabel')", "t('rules.editExceptionsLabel')",
    "t('rules.newActionLabel')", "t('rules.newObjectLabel')", "t('rules.newTextPlaceholder')",
  ]) {
    assert.ok(dialog.includes(token), `新建弹层缺少 ${token}`)
  }
  assert.ok(dialog.includes("['iron-rule', t('rules.typeIron')]"), '类型缺铁律选项')
  assert.ok(dialog.includes("['rule', t('rules.typeNormal')]"), '类型缺普通规则选项')
  assert.ok(dialog.includes("['global', t('rules.editScopeGlobal')]"), '作用域缺 global')
  assert.ok(dialog.includes("['workspace', t('rules.editScopeWorkspace')]"), '作用域缺 workspace')
  assert.ok(dialog.includes("['role', t('rules.editScopeRole')]"), '作用域缺 role')
  assert.ok(dialog.includes('rulePriorityOptions(priority)'), '优先级未用 P0–P3 候选')
  assert.ok(dialog.includes('maxLength: RULE_BODY_MAX'), '正文未限 500 字')
  assert.ok(dialog.includes("t('common.charCount'"), '正文缺字数计数')
})

test('key / 编号只读提示「保存后自动分配」；提交载荷只带 draft 契约字段', () => {
  const dialog = newDialogSource()
  assert.equal((dialog.match(/t\('rules\.newAutoAssign'\)/g) || []).length, 2, '编号与 key 都应显示自动分配')
  assert.ok(dialog.includes("t('rules.newAutoAssignNote')"), '缺少编号稳定/不复用说明')
  assert.ok(dialog.includes("callJson('/rules/create'"), '未走 POST /rules/create')
  assert.ok(dialog.includes('body: JSON.stringify({ draft: newRuleDraftPayload(draft) })'), '载荷必须是 {draft}')
  const api = rulesDefaultsApi()
  const payload = api.newRuleDraftPayload({
    text: '  网关固定 3982  ', type: 'iron-rule', priority: 'p0', scopeKind: 'role', scopeValue: ' reviewer ',
    conditions: 'a\n\n b ', exceptions: ['e1'], action: ' 改口 ', object: '',
  })
  assert.deepEqual(payload, {
    text: '网关固定 3982', type: 'iron-rule', priority: 'P0', scope: 'role:reviewer', role: 'reviewer',
    conditions: ['a', 'b'], exceptions: ['e1'], action: '改口', object: '',
  })
  assert.deepEqual(Object.keys(payload), ['text', 'type', 'priority', 'scope', 'role', 'conditions', 'exceptions', 'action', 'object'],
    'draft 字段必须与建规则契约一致')
  assert.deepEqual(api.newRuleDraftPayload({}), {
    text: '', type: 'rule', priority: 'P1', scope: 'global', role: '',
    conditions: [], exceptions: [], action: '', object: '',
  })
})

test('本地校验：正文非空/≤500、类型/优先级合法、作用域合法（与服务端同口径）', () => {
  const api = rulesDefaultsApi()
  const base = { text: '必须带编号', type: 'rule', priority: 'P1', scopeKind: 'global', scopeValue: '' }
  assert.equal(api.newRuleDraftProblem(base), null)
  assert.equal(api.newRuleDraftProblem({ ...base, text: '   ' }), 'body_empty')
  assert.equal(api.newRuleDraftProblem({ ...base, text: '字'.repeat(api.RULE_BODY_MAX + 1) }), 'body_too_long')
  assert.equal(api.newRuleDraftProblem({ ...base, type: 'candidate' }), 'type_invalid')
  assert.equal(api.newRuleDraftProblem({ ...base, priority: 'P9' }), 'priority_invalid')
  assert.equal(api.newRuleDraftProblem({ ...base, scopeKind: 'workspace', scopeValue: 'rel/path' }), 'scope_workspace_relative')
  assert.equal(api.newRuleDraftProblem({ ...base, scopeKind: 'role', scopeValue: 'has space' }), 'scope_role_invalid')
  assert.equal(api.newRuleDraftProblem({ ...base, scopeKind: 'workspace', scopeValue: '/srv/app' }), null)
  assert.equal(api.newRuleDraftProblem(null), 'body_empty')
  // 本地校验失败时弹层给文案并禁用提交，不静默发请求。
  const dialog = newDialogSource()
  assert.ok(dialog.includes("t('rules.editInvalidText')"), '正文错误缺文案')
  assert.ok(dialog.includes("t('rules.newTypeInvalid')") && dialog.includes("t('rules.newPriorityInvalid')"), '类型/优先级错误缺文案')
  assert.ok(dialog.includes("t('rules.editScopeInvalid')"), '作用域错误缺文案')
  assert.ok(dialog.includes('if (problemCode) {'), '本地校验未拦截提交')
})

test('二次确认说清写文件+git commit+重建镜像+渲染 AGENTS；成功后关层并统一刷新', () => {
  const dialog = newDialogSource()
  const view = viewSource()
  assert.ok(dialog.includes("askConfirm(t('rules.newConfirm'))"), '新建缺少二次确认')
  assert.ok(dialog.includes("kind: 'create'"), '成功回调缺 kind=create')
  assert.ok(view.includes('const onRuleCreated = (event) =>'), '规则页缺新建成功回调')
  assert.ok(view.includes('setNewOpen(false)'), '创建成功后未关闭弹层')
  assert.ok(view.includes('onChanged: onRuleChanged') && view.includes('setReloadTick((v) => v + 1)'), '创建成功后未刷新列表/详情')
  const confirm = dicts.zh['rules.newConfirm']
  for (const token of ['规则文件', 'git commit', '镜像', 'AGENTS']) {
    assert.ok(confirm.includes(token), `新建确认文案缺少「${token}」`)
  }
  for (const lang of LANGS) {
    assert.equal(typeof dicts[lang]['rules.newConfirm'], 'string', `${lang} 缺新建确认文案`)
    assert.ok(dicts[lang]['rules.newConfirm'].trim().length > 0, `${lang} 新建确认文案为空`)
  }
})

test('详情停用/重新启用：mode=retire|reactivate 与「不再注入/生效但保留编号历史可重新启用」', () => {
  const api = rulesDefaultsApi()
  assert.equal(api.ruleRetireMode('active'), 'retire')
  assert.equal(api.ruleRetireMode('retired'), 'reactivate')
  assert.equal(api.ruleRetireMode(''), 'retire')
  assert.equal(api.ruleCanToggleStatus('active'), true)
  assert.equal(api.ruleCanToggleStatus('retired'), true)
  assert.equal(api.ruleCanToggleStatus('merged'), false)
  assert.equal(api.ruleCanToggleStatus('superseded'), false)
  const drawer = drawerSource()
  assert.ok(drawer.includes("callJson('/rules/delete'"), '停用/启用未走 POST /rules/delete')
  assert.ok(drawer.includes("JSON.stringify({ key: String((rule && rule.key) || ruleKey), mode })"), '载荷必须是 {key,mode}')
  assert.ok(drawer.includes("t('rules.retireConfirm')"), '缺少停用二次确认')
  assert.ok(drawer.includes("t('rules.reactivateConfirm')"), '缺少重新启用二次确认')
  assert.ok(drawer.includes("t('rules.retiredBadge')"), 'retired 详情缺「已停用」徽标')
  assert.ok(drawer.includes("t('rules.reactivate')") && drawer.includes("t('rules.retire')"), '缺停用/重新启用按钮文案')
  const zh = dicts.zh['rules.retireConfirm']
  for (const token of ['不再注入', '生效', '文件', '历史', '编号', '重新启用']) {
    assert.ok(zh.includes(token), `停用确认缺少「${token}」`)
  }
  for (const lang of LANGS) {
    const text = dicts[lang]['rules.retireConfirm']
    assert.ok(/不再注入|no longer injected|注入|適用されなく/.test(text), `${lang} 停用确认未说明不再注入`)
    assert.ok(/历史|history|履歴/.test(text), `${lang} 停用确认未说明保留历史`)
    assert.ok(/编号|number|番号/.test(text), `${lang} 停用确认未说明保留编号`)
  }
})

test('默认铁律：origin 以 default: 开头判定；列表「默认」徽标 + 详情安装自带说明', () => {
  const api = rulesDefaultsApi()
  assert.equal(api.ruleOriginIsDefault('default:iron-rule-1'), true)
  assert.equal(api.ruleOriginIsDefault('  default:seed  '), true)
  assert.equal(api.ruleOriginIsDefault('file'), false)
  assert.equal(api.ruleOriginIsDefault(''), false)
  assert.equal(api.ruleOriginIsDefault(null), false)
  assert.equal(api.ruleOriginIsDefault({ text: 'default:obj' }), true)
  assert.equal(api.ruleIsDefault({ origin: 'default:x' }), true)
  assert.equal(api.ruleIsDefault({}), false)
  assert.equal(api.ruleIsDefault(null), false)
  const table = tableSource()
  assert.ok(table.includes('ruleIsDefault(rule) ? h(RulesDefaultBadge'), '列表类型列旁缺默认徽标')
  assert.ok(table.includes('css.rulesTypeCell'), '类型列未做窄屏换行容器')
  const badge = defaultBadgeSource()
  assert.ok(badge.includes("t('rules.defaultBadge')"), '默认徽标缺文案')
  assert.ok(badge.includes("t('rules.defaultOriginNote')"), '默认徽标缺说明 tooltip')
  assert.ok(drawerSource().includes("t('rules.defaultOriginNote')"), '详情缺安装自带默认铁律说明')
})

test('顶部说明条：默认铁律可改/停/删、编号保留、历史可回滚，且不写死条数', () => {
  const view = viewSource()
  assert.ok(view.includes("t('rules.defaultNotice')"), '规则页顶部缺默认铁律说明条')
  const text = dicts.zh['rules.defaultNotice']
  for (const token of ['默认铁律', '安装时已写入', '修改', '停用', '删除', '编号', '历史']) {
    assert.ok(text.includes(token), `顶部说明缺少「${token}」`)
  }
  assert.ok(!/16\s*条/.test(text), '顶部说明不应写死条数（服务端无 count 字段）')
  assert.ok(!/\b16\b/.test(text), '顶部说明不应出现数字 16')
})

test('空态：全部停用时提示去「已退役」筛选重新启用；首次安装自带默认铁律', () => {
  const api = rulesDefaultsApi()
  assert.equal(api.rulesAllRetired([{ status: 'retired' }, { status: 'retired' }]), true)
  assert.equal(api.rulesAllRetired([{ status: 'retired' }, { status: 'merged' }]), false)
  assert.equal(api.rulesAllRetired([{ status: 'active' }, { status: 'retired' }]), false)
  assert.equal(api.rulesAllRetired([]), false)
  assert.equal(api.rulesAllRetired(null), false)
  const view = viewSource()
  assert.ok(view.includes("rulesAllRetired(rules) ? 'rules.emptyNoActive' : 'rules.tableEmpty'"), '空态未按全停用切换文案')
  const text = dicts.zh['rules.emptyNoActive']
  assert.ok(text.includes('没有生效中的规则'), '空态未说明没有生效规则')
  assert.ok(text.includes('已退役'), '空态未指向已退役筛选')
  assert.ok(text.includes('重新启用'), '空态未说明可重新启用')
})

test('错误码三语映射：already_retired/not_retired/rule_not_found/invalid_rule/rules_disabled/git_required', () => {
  for (const key of [
    'err.already_retired', 'err.not_retired', 'err.rule_not_found',
    'err.invalid_rule', 'err.rules_disabled', 'err.git_required', 'err.duplicate_rule',
  ]) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  assert.ok(dicts.zh['err.already_retired'].includes('停用'), 'already_retired 未说明已停用')
  assert.ok(dicts.zh['err.not_retired'].includes('生效'), 'not_retired 未说明当前生效')
  assert.ok(dicts.zh['err.git_required'].includes('git'), 'git_required 未提示 git')
  assert.ok(dicts.zh['err.duplicate_rule'].includes('已存在'), 'duplicate_rule 未说明重复')
  const api = rulesDefaultsApi()
  assert.equal(api.ruleErrorDetailText({ reason: 'empty_text' }), 'empty_text', 'invalid_draft 的 reason 未展示')
  assert.equal(api.ruleErrorDetailText({ reason: 'unknown_field', fields: ['bogus'] }), 'bogus', 'invalid_draft 的 fields 未展示')
  const drawer = drawerSource()
  assert.ok(drawer.includes("errText(t, { code: feedback.code })"), '停用失败未走 i18n 兜底')
  assert.ok(drawer.includes("ruleErrorDetailText(feedback.detail)"), '停用失败未展示后端 detail')
  assert.ok(drawer.includes("feedback.code === 'git_required'"), 'git_required 未给安装/关闭提示')
})

test('三语 key 齐全、键集一致、新增 key 非空', () => {
  const newKeys = [
    'rules.new', 'rules.newTitle', 'rules.newHint', 'rules.newTypeLabel', 'rules.newAutoAssign',
    'rules.newAutoAssignNote', 'rules.newActionLabel', 'rules.newObjectLabel', 'rules.newActionPlaceholder',
    'rules.newObjectPlaceholder', 'rules.newTextPlaceholder', 'rules.newConfirm', 'rules.newSubmit',
    'rules.newDone', 'rules.newTypeInvalid', 'rules.newPriorityInvalid', 'rules.retire',
    'rules.retireConfirm', 'rules.retireDefaultHint', 'rules.retiredBadge', 'rules.reactivate',
    'rules.reactivateConfirm', 'rules.retireDone', 'rules.reactivateDone', 'rules.toggleUnavailable',
    'rules.defaultBadge', 'rules.defaultOriginNote', 'rules.defaultNotice', 'rules.emptyNoActive',
    'err.already_retired', 'err.not_retired', 'err.invalid_draft', 'err.duplicate_rule',
  ]
  for (const key of newKeys) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  const zhKeys = Object.keys(dicts.zh).sort()
  for (const lang of LANGS.slice(1)) {
    assert.deepEqual(Object.keys(dicts[lang]).sort(), zhKeys, `${lang} 与 zh 键集不一致`)
  }
})

test('窄屏与视觉克制：新建复用 94vw/90vh 滚动弹层，停用警告色，类型列可换行', () => {
  const dialog = newDialogSource()
  assert.ok(dialog.includes('style: css.rulesEditPanel'), '新建弹层未复用窄屏面板')
  assert.ok(dialog.includes('style: css.rulesGuideMask'), '新建弹层缺遮罩')
  const drawer = drawerSource()
  assert.ok(drawer.includes('isRetired ? css.button : css.buttonWarn'), '停用按钮应用警告色而非错误红')
  assert.ok(!drawer.includes('state-error-primary'), '停用入口不应使用错误红')
  const css = CLIENT.slice(CLIENT.indexOf('      rulesEditPanel: {'), CLIENT.indexOf('      resultItem: {'))
  assert.match(css, /width: 'min\(640px, 94vw\)'/, '新建弹层窄屏未限宽')
  assert.match(css, /maxHeight: '90vh'/, '新建弹层缺高度上限')
  assert.ok(css.includes("overflowY: 'auto'"), '新建弹层缺纵向滚动')
  assert.ok(css.includes("flexWrap: 'wrap'"), '类型列缺换行保护')
})

test('运行时冒烟：新建弹层渲染字段、本地校验、二次确认与真实提交载荷', async () => {
  const pureSource = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  const presets = ['iron-rule', 'P0', 'role', 'reviewer', '必须带编号', '条件一', '例外一', '', '', false, null]
  const stubs = runtimeStubs()
    .replace('__PRESETS__', JSON.stringify(presets))
    .replace('__RESPONSE__', JSON.stringify({ ok: true, rule: { key: 'iron-rule-18', number: 18 }, commit: 'abc123' }))
    .replace('__DICT__', 'DICT_ZH')
  const source = `${pureSource}\nconst DICT_ZH = ${JSON.stringify(dicts.zh)}\n${stubs}\n${newDialogSource()}
return { RulesNewDialog, getConfirm: () => __confirm, getPosted: () => __posted }`
  const api = new Function(`${source}`)()
  const t = tFrom(dicts.zh)
  const created = []
  const tree = api.RulesNewDialog({ t, locale: 'zh', onClose() {}, onCreated: (event) => created.push(event) })
  const text = textOf(tree)
  for (const token of [
    '新建规则', '保存后自动分配', '铁律', 'P0', '角色', '正文（≤500 字）',
    '条件（每行一条）', '例外（每行一条）', '动作（可选）', '对象（可选）', '5 / 500 字',
  ]) {
    assert.ok(text.includes(token), `新建弹层渲染缺少「${token}」：${text.slice(0, 400)}`)
  }
  const submit = collectButtons(tree).find((node) => textOf(node) === '确认创建')
  assert.ok(submit, '新建弹层缺少「确认创建」按钮')
  await submit.props.onClick()
  assert.equal(api.getConfirm(), dicts.zh['rules.newConfirm'], '提交前未弹二次确认')
  const posted = api.getPosted()
  assert.equal(posted.url, '/rules/create', '提交未走 POST /rules/create')
  assert.deepEqual(JSON.parse(posted.opts.body), {
    draft: {
      text: '必须带编号', type: 'iron-rule', priority: 'P0', scope: 'role:reviewer', role: 'reviewer',
      conditions: ['条件一'], exceptions: ['例外一'], action: '', object: '',
    },
  }, '提交载荷与建规则契约不一致')
  assert.deepEqual(created, [{ kind: 'create', key: 'iron-rule-18', commit: 'abc123' }], '成功后未把新 key 交给父级')
})

test('运行时冒烟：停用详情顶部「已停用」+「重新启用」；默认铁律显示安装自带说明', () => {
  const pureSource = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  const retiredRule = {
    key: 'iron-rule-18', type: 'iron-rule', number: 18, priority: 'P0', scope: 'global',
    status: 'retired', text: '必须带编号', conditions: [], exceptions: [], version: 2,
    created: '2026-01-01', updated: '2026-02-02', origin: 'default:iron-rule-18',
  }
  const presets = [
    { status: 'ok', rule: retiredRule, history: [] },
    null,
    { status: 'idle', rows: null, rev: null },
    null,
    false,
    false,
    false,
  ]
  const stubs = runtimeStubs()
    .replace('__PRESETS__', JSON.stringify(presets))
    .replace('__RESPONSE__', '{}')
    .replace('__DICT__', 'DICT_ZH')
  const source = `${pureSource}\nconst DICT_ZH = ${JSON.stringify(dicts.zh)}\n${stubs}\n${drawerSource()}
return { RuleDrawer }`
  const api = new Function(`${source}`)()
  const t = tFrom(dicts.zh)
  const tree = api.RuleDrawer({ t, locale: 'zh', ruleKey: retiredRule.key, refreshTick: 0, onChanged() {}, onClose() {} })
  const text = textOf(tree)
  assert.ok(text.includes('已停用'), 'retired 详情顶部缺「已停用」徽标')
  assert.ok(text.includes('重新启用'), 'retired 详情缺「重新启用」按钮')
  const toggle = collectButtons(tree).find((node) => textOf(node) === '重新启用')
  assert.ok(toggle, '「重新启用」未渲染成按钮')
  assert.ok(!toggle.props.disabled, 'retired 规则的重新启用按钮不应禁用')
  assert.ok(text.includes('安装自带默认铁律'), '默认铁律详情缺安装自带说明')
})
