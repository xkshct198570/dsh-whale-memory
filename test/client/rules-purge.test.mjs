/**
 * 「彻底删除规则」（purge）的客户端契约测试（零依赖、零网络、无 DOM）。
 *
 * 锁住小白可用面：详情操作区「删除」按钮位于「停用」之后、危险色；二次确认四要素
 * （物理删除文件 / 不可撤销 / 编号作废永不复用 / 历史快照可在 git·history 追溯），
 * 默认铁律另说"删除后不会自动恢复"；调用 POST /rules/delete {key,mode:'purge'}；
 * 成功后关抽屉并走 reloadTick 刷新列表/提案/git；错误码 rule_not_found/git_required/
 * rules_disabled 三语文案。含运行时渲染冒烟（真渲染按钮、真点、真校验载荷）。
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

const drawerSource = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
const viewSource = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')

const PURGE_KEYS = [
  'rules.purge', 'rules.purgeHint', 'rules.purgeConfirm',
  'rules.purgeDefaultHint', 'rules.purgeDone', 'rules.purgeNumberRetired',
]

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

/**
 * 运行时渲染桩：额外把 confirm 文案 / POST 载荷 / onChanged / onClose 记进 capture，
 * 这样"真点按钮"能断言到真实接线，而不是只 grep 源码字符串。
 */
function purgeRuntime(presets, response) {
  const capture = { confirm: null, posted: null, changed: null, closed: 0 }
  // 跨 new Function 边界共享同一个 capture：函数体通过 globalThis 取引用，不靠字符串拷贝。
  globalThis.__PURGE_CAPTURE__ = capture
  const source = `
    const h = (type, props, ...children) => {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: merged.children }
    }
    let __stateIndex = 0
    const __presets = ${JSON.stringify(presets)}
    const useState = (initial) => [__presets[__stateIndex++] !== undefined ? __presets[__stateIndex - 1] : initial, () => {}]
    const useEffect = () => {}
    const css = new Proxy({}, { get: () => ({}) })
    const Row = (props) => h('div', null, props.k, ': ', props.v)
    const SectionTitle = (props) => h('div', null, props.children)
    const StateBlock = () => null
    const RulesStatusBadge = (props) => h('span', null, props.value || '')
    const RulesDefaultBadge = () => h('span', null, '默认')
    const RulesDiffRows = () => null
    const RulesEditDialog = () => null
    const SelectInput = (props) => h('select', null, (props.options || []).map(([v, l]) => h('option', { value: v }, l)))
    const TextInput = (props) => h('input', { value: props.value, placeholder: props.placeholder })
    const ruleNumberText = (rule) => (Number.isFinite(Number(rule && rule.number)) ? '#' + String(rule.number) : '—')
    const ruleTypeLabel = (t, value) => (String(value || '') === 'rule' ? t('rules.typeNormal') : t('rules.typeIron'))
    const ruleStatusLabel = (t, value) => String(value || '')
    const ruleList = (value) => h('ul', null, (Array.isArray(value) ? value : []).map((item) => h('li', null, item)))
    const fmtNum = (value) => (value === null || value === undefined ? '—' : String(value))
    const fmtTime = (value) => (value === null || value === undefined ? '—' : String(value))
    const errText = (t, err) => t(hasKey('err.' + String((err && err.code) || 'unknown')) ? 'err.' + String(err.code) : 'err.unknown')
    const hasKey = (key) => Object.prototype.hasOwnProperty.call(__DICT__, key)
    const askConfirm = (message) => { __CAPTURE__.confirm = message; return true }
    const callJson = async (url, opts) => { __CAPTURE__.posted = { url, opts }; return __RESPONSE__ }
  `
  const pure = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  const src = `${pure}\nconst __DICT__ = ${JSON.stringify(dicts.zh)}\nconst __CAPTURE__ = globalThis.__PURGE_CAPTURE__\nconst __RESPONSE__ = ${JSON.stringify(response)}\n${source}\n${drawerSource()}\nreturn { RuleDrawer }`
  const api = new Function(src)()
  return { api, capture }
}

test('详情操作区有「删除」危险按钮：DangerButton 输入 key 才能点，仍用危险色与后果说明', () => {
  const drawer = drawerSource()
  const gateStart = drawer.indexOf("const purgeRuleNow = async (rule) => {")
  assert.ok(gateStart > 0, '缺少 purgeRuleNow')
  assert.ok(drawer.includes("t('rules.purgeKeyLabel'"), '缺少输入 key 才能删除的标签')
  assert.ok(drawer.includes('TextInput'), '删除闸必须有一个用户手打 key 的输入框')
  assert.ok(drawer.includes("String(purgeKeyInput || '').trim() !== String(rule.key || ruleKey)"), '按钮未按 key 输入是否一致决定可点')
  assert.ok(drawer.includes("confirmKey: purgeKey"), '请求未带 confirmKey=key（服务端 422 闸）')

  const purgeButton = drawer.indexOf("onClick: () => purgeRuleNow(rule)")
  assert.ok(purgeButton > 0, '找不到「删除」按钮')
  const purgeBlock = drawer.slice(purgeButton - 300, purgeButton + 300)
  assert.ok(purgeBlock.includes("t('rules.purge')"), '「删除」按钮缺少文案')
  assert.ok(purgeBlock.includes('css.buttonDanger'), '「删除」必须用危险色，不能混用停用的警告色')
  assert.ok(purgeBlock.includes("t('rules.purgeHint')"), '「删除」缺少后果说明 title')
  // 已停用规则也可删除：按钮 disabled 只看 busy 与 key 输入，不看 isRetired/canToggle。
  assert.ok(!/disabled:\s*!canToggle/.test(purgeBlock), '删除按钮不得复用停用的 canToggle 闸门')

  // 危险色 token 与不可撤销语义一致。
  const styleStart = CLIENT.indexOf('buttonDanger: {')
  assert.ok(styleStart > 0, '缺少 css.buttonDanger')
  const styleBlock = CLIENT.slice(styleStart, styleStart + 320)
  assert.ok(styleBlock.includes('--dsw-alias-state-error-primary'), 'buttonDanger 未使用 error 色')
})

test('危险区写清四要素，且确认只认手打 key（不再用 window.confirm 代替）', () => {
  const drawer = drawerSource()
  const purgeStart = drawer.indexOf('const purgeRuleNow = async (rule) => {')
  const body = drawer.slice(purgeStart, drawer.indexOf('const restoreDefaultRule', purgeStart))
  assert.ok(body.length > 0, 'purgeRuleNow 片段为空')
  assert.ok(!body.includes('askConfirm('), 'purge 不得用 window.confirm 当确认闸')
  assert.ok(body.includes("code: 'confirm_required'"), '输入不符必须显式 confirm_required 且不发请求')
  assert.ok(drawer.includes("t('rules.purgeConfirm')"), 'purge 确认未取 rules.purgeConfirm')
  assert.ok(drawer.includes("t('rules.purgeDefaultHint')"), '默认铁律缺「删除后不会自动恢复」提示')

  const zh = dicts.zh['rules.purgeConfirm']
  for (const token of ['物理删除', '规则文件', '不可撤销', '编号', '永不复用', '历史快照', 'git', 'history']) {
    assert.ok(zh.includes(token), `zh 删除确认缺少「${token}」`)
  }
  const defaultHint = dicts.zh['rules.purgeDefaultHint']
  assert.ok(/不会自动恢复|自动恢复/.test(defaultHint), 'zh 默认铁律提示未说明不会自动恢复')

  const expectations = {
    en: [/permanently|permanent/i, /file/i, /cannot be undone|irreversible/i, /number/i, /never (be )?reused/i, /history snapshot/i, /git/i, /cannot|will not come back|not come back/i],
    ja: [/物理削除|完全に削除/, /ファイル/, /取り消せません|取り消し不可/, /番号/, /再利用されません|再利用/, /履歴スナップショット/, /git/, /自動復元されることはありません|自動復元/],
  }
  for (const [lang, regexes] of Object.entries(expectations)) {
    const text = `${dicts[lang]['rules.purgeConfirm']} ${dicts[lang]['rules.purgeDefaultHint']}`
    for (const re of regexes) assert.ok(re.test(text), `${lang} 删除确认缺少 ${re}`)
  }
  for (const lang of LANGS) {
    for (const key of PURGE_KEYS.concat(['rules.purgeKeyLabel', 'rules.purgeKeyPlaceholder'])) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} ${key} 为空`)
    }
  }
})

test('调用 mode=purge；成功后关抽屉 + 走 reloadTick 刷新列表/提案/git；顶部提示编号作废', () => {
  const drawer = drawerSource()
  const purgeStart = drawer.indexOf('const purgeRuleNow = async (rule) => {')
  assert.ok(purgeStart > 0, '缺少 purgeRuleNow')
  const body = drawer.slice(purgeStart, drawer.indexOf('/** 编辑成功', purgeStart))
  assert.ok(body.includes("callJson('/rules/delete'"), 'purge 未走 POST /rules/delete')
  assert.ok(body.includes("mode: 'purge'"), 'purge 载荷缺 mode=purge')
  assert.ok(body.includes('confirmKey: purgeKey'), 'purge 载荷缺 confirmKey=key')
  assert.ok(body.includes('onChanged(event)'), 'purge 成功后未通知父级刷新')
  assert.ok(body.includes('onClose()'), 'purge 成功后未关闭抽屉')
  assert.ok(body.includes('number: body && body.number'), '未把编号回传给父级')
  assert.ok(body.includes('retiredNumbers'), '未接收 retiredNumbers 便于提示')

  const view = viewSource()
  const changedStart = view.indexOf('const onRuleChanged = (event) => {')
  const changedBody = view.slice(changedStart, view.indexOf('const onRuleCreated', changedStart))
  assert.ok(changedBody.includes("kind === 'purge' ? 'purge'"), '父级未识别 purge 事件')
  assert.ok(changedBody.includes('setReloadTick((v) => v + 1)'), 'purge 后未统一刷新列表/提案/git')
  assert.ok(view.includes("op.kind === 'purge'"), '顶部提示未处理 purge')
  assert.ok(view.includes("t('rules.purgeNumberRetired'"), '顶部提示未说明编号作废与下一个编号')
})

test('错误码三语：rule_not_found / git_required / rules_disabled，抽屉按 error 码渲染', () => {
  const drawer = drawerSource()
  const purgeStart = drawer.indexOf('const purgeRuleNow = async (rule) => {')
  const body = drawer.slice(purgeStart, drawer.indexOf('/** 编辑成功', purgeStart))
  assert.ok(body.includes('code: (err && err.code) ||'), 'purge 失败未保留错误码')
  assert.ok(drawer.includes('errText(t, { code: feedback.code })'), '失败未走 errText 映射')

  for (const lang of LANGS) {
    for (const key of ['err.rule_not_found', 'err.git_required', 'err.rules_disabled']) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} ${key} 为空`)
    }
  }
})

test('运行时冒烟：已停用规则渲染「删除」按钮，真点后确认四要素并 POST {key,mode:purge}，成功关抽屉', async () => {
  const retiredRule = {
    key: 'iron-rule-17', type: 'iron-rule', number: 17, priority: 'P0', scope: 'global',
    status: 'retired', text: '必须先验证再覆盖正式库。', conditions: [], exceptions: [], version: 3,
    created: '2026-01-01', updated: '2026-02-02', origin: 'default:iron-rule-17',
  }
  // useState 顺序：loaded,selected,serverDiff,feedback,editOpen,revertBusy,statusBusy,purgeBusy,
  // retryTick,restoreBusy,purgeKeyInput —— 删除闸的输入值必须喂到最后一个。
  const presets = [
    { status: 'ok', rule: retiredRule, history: [] },
    null, { status: 'idle', rows: null, rev: null }, null, false, false, false, false,
    0, false, 'iron-rule-17',
  ]
  const response = { ok: true, number: 17, nextNumber: 18, retiredNumbers: [17], commit: 'rule: purge iron-rule-17 (#17)' }
  const { api, capture } = purgeRuntime(presets, response)
  const t = tFrom(dicts.zh)
  const tree = api.RuleDrawer({ t, locale: 'zh', ruleKey: 'iron-rule-17', refreshTick: 0, onChanged(event) { capture.changed = event }, onClose() { capture.closed += 1 } })
  const text = textOf(tree)
  assert.ok(text.includes('已停用'), 'retired 详情应显示已停用徽标')
  const purge = collectButtons(tree).find((node) => textOf(node) === '删除')
  assert.ok(purge, '已停用规则的详情缺「删除」按钮')
  assert.equal(purge.props.disabled, false, '已停用规则也必须可删除')

  assert.ok(text.includes('输入规则 key「iron-rule-17」才能删除'), '危险区必须写明输入哪个 key 才能删')
  assert.ok(text.includes('不会自动恢复'), '默认铁律提示缺少「不会自动恢复」')
  purge.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(capture.confirm, null, 'purge 不得再用 window.confirm 当确认闸')
  assert.equal(capture.posted.url, '/rules/delete')
  assert.equal(JSON.parse(capture.posted.opts.body).key, 'iron-rule-17')
  assert.equal(JSON.parse(capture.posted.opts.body).mode, 'purge')
  assert.equal(JSON.parse(capture.posted.opts.body).confirmKey, 'iron-rule-17')
  assert.equal(capture.changed.kind, 'purge')
  assert.equal(capture.changed.number, 17)
  assert.equal(capture.changed.nextNumber, 18)
  assert.deepEqual(capture.changed.retiredNumbers, [17])
  assert.equal(capture.closed, 1, '成功后必须关闭抽屉')
})
