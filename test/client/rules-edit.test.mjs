/**
 * 「规则」详情抽屉的编辑 / 版本 diff / 回滚接线契约测试（R5，零依赖、零网络、无 DOM）。
 *
 * 锁住客户端面：编辑弹层字段与只读边界、条件/例外解析、作用域三选+值、优先级 P0–P3、
 * 提交前 diff 预览（服务端 /rules/diff 优先、失败退回本地 lineDiff）、退役二次确认、
 * 二次确认后提交 /rules/update、历史选中 /rules/diff 与回滚 /rules/revert、
 * 当前版本标记、错误码文案映射（含后端 detail 字段名）、成功后刷新链、三语 key。
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

/** 抽取 rules:pure 块并在 node 里执行：编辑/回滚的纯逻辑必须可测。 */
function rulesEditApi() {
  const source = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  return new Function(`${source}
return {
  RULE_BODY_MAX, RULE_PRIORITY_OPTIONS, RULE_EDIT_FIELD_KEYS,
  ruleTextChars, ruleLinesFromInput, ruleScopeParts, ruleScopeValue, ruleScopeProblem,
  rulePriorityOptions, ruleEditPatch, ruleCurrentRev, ruleDiffRowsFromServer,
  ruleErrorDetailText, ruleEditFieldLabel, lineDiff, ruleFieldText,
}`)()
}

const tKeys = (source, prefix) => new Set(
  [...source.matchAll(new RegExp(`t\\('(${prefix}\\.[A-Za-z0-9_.]+)'`, 'g'))].map((match) => match[1]),
)

const dialogSource = () => sliceFrom('function RulesEditDialog(props) {', 'function RuleDrawer(props) {')
const diffRowsSource = () => sliceFrom('function RulesDiffRows(props) {', 'function RulesEditDialog(props) {')
const drawerSource = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
const viewSource = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')

test('编辑入口可用：详情底部「编辑」不再是 disabled，点开渲染编辑弹层', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("h('button'"), '详情缺少按钮')
  assert.ok(drawer.includes("onClick: () => setEditOpen(true)"), '「编辑」未接线打开弹层')
  assert.ok(drawer.includes("}, t('rules.edit'))"), '缺少编辑按钮文案')
  assert.ok(drawer.includes('h(RulesEditDialog'), '详情未渲染编辑弹层')
  assert.ok(drawer.includes('onSaved: onEditSaved'), '编辑弹层未接保存回调')
  assert.ok(!drawer.includes('rules.editPending'), 'R5 不应再保留「编辑待接入」占位')
})

test('编辑弹层字段齐全：正文/条件/例外/作用域+值/优先级/状态', () => {
  const dialog = dialogSource()
  for (const token of [
    "t('rules.editTextLabel')", "t('rules.editConditionsLabel')", "t('rules.editExceptionsLabel')",
    "t('rules.editScopeLabel')", "t('rules.editScopeValueLabel')", "t('rules.editPriorityLabel')",
    "t('rules.editStatusLabel')", "t('rules.editTitle')", "t('rules.editHint')",
  ]) {
    assert.ok(dialog.includes(token), `编辑弹层缺少 ${token}`)
  }
  // 作用域＝global/workspace/role 三选，另保留未知写法；值单独输入。
  assert.ok(dialog.includes("['global', t('rules.editScopeGlobal')]"), '作用域缺 global 选项')
  assert.ok(dialog.includes("['workspace', t('rules.editScopeWorkspace')]"), '作用域缺 workspace 选项')
  assert.ok(dialog.includes("['role', t('rules.editScopeRole')]"), '作用域缺 role 选项')
  assert.ok(dialog.includes("h(TextInput"), '作用域值缺少输入框')
  assert.ok(dialog.includes("t('rules.editScopeWorkspacePlaceholder')"), '缺工作区路径示例')
  assert.ok(dialog.includes("t('rules.editScopeRolePlaceholder')"), '缺角色 id 示例')
  assert.ok(dialog.includes('maxLength: RULE_BODY_MAX'), '正文未限 500 字')
  assert.ok(dialog.includes("t('common.charCount'"), '正文缺字数计数')
})

test('key / 类型 / 编号只读展示并注明不可改', () => {
  const dialog = dialogSource()
  assert.ok(dialog.includes('ruleNumberText(base)'), '编号未走只读展示')
  assert.ok(dialog.includes('ruleTypeLabel(t, base.type)'), '类型未走本地化只读展示')
  assert.ok(dialog.includes("t('rules.fieldKey')"), '缺少 key 只读行')
  assert.ok(dialog.includes("String(base.key || '—')"), 'key 未只读展示')
  assert.ok(dialog.includes("t('rules.editImmutableNote')"), '缺少「只读不可改」说明')
  // 只读区不应出现 key/type/number 的可编辑输入
  assert.ok(!/setScopeKind\(.*key/.test(dialog), '只读字段被误接成可编辑')
  assert.ok(!dialog.includes('setNumber(') && !dialog.includes('setType('), '编号/类型不应可改')
  for (const lang of LANGS) {
    assert.ok(/key/i.test(dicts[lang]['rules.editImmutableNote']), `${lang} 只读说明未提 key`)
  }
})

test('条件/例外解析：每行一条、空行丢弃、首尾裁剪、数组输入同样归一', () => {
  const api = rulesEditApi()
  assert.deepEqual(api.ruleLinesFromInput('a\n\n b \r\n\tc\t'), ['a', 'b', 'c'])
  assert.deepEqual(api.ruleLinesFromInput('  '), [])
  assert.deepEqual(api.ruleLinesFromInput(null), [])
  assert.deepEqual(api.ruleLinesFromInput(['x', null, 'y\nz']), ['x', 'y', 'z'])
  assert.deepEqual(api.ruleLinesFromInput([{ condition: 'c1' }]), ['c1'])
})

test('作用域三选+值：拆分/合成互逆，本地校验与服务端同口径', () => {
  const api = rulesEditApi()
  assert.deepEqual(api.ruleScopeParts('global'), { kind: 'global', value: '' })
  assert.deepEqual(api.ruleScopeParts('workspace:/a/b'), { kind: 'workspace', value: '/a/b' })
  assert.deepEqual(api.ruleScopeParts('role:reviewer'), { kind: 'role', value: 'reviewer' })
  assert.deepEqual(api.ruleScopeParts(''), { kind: 'global', value: '' })
  assert.deepEqual(api.ruleScopeParts('legacy-scope'), { kind: 'custom', value: 'legacy-scope' })
  assert.equal(api.ruleScopeValue('global', 'ignored'), 'global')
  assert.equal(api.ruleScopeValue('workspace', ' /a/b '), 'workspace:/a/b')
  assert.equal(api.ruleScopeValue('role', 'reviewer'), 'role:reviewer')
  assert.equal(api.ruleScopeValue('custom', 'legacy-scope'), 'legacy-scope')
  assert.equal(api.ruleScopeProblem('global', ''), null)
  assert.equal(api.ruleScopeProblem('workspace', ''), 'scope_workspace_empty')
  assert.equal(api.ruleScopeProblem('workspace', 'rel/path'), 'scope_workspace_relative')
  assert.equal(api.ruleScopeProblem('workspace', 'C:\\work'), null)
  assert.equal(api.ruleScopeProblem('role', 'has space'), 'scope_role_invalid')
  assert.equal(api.ruleScopeProblem('role', 'reviewer'), null)
})

test('优先级下拉 P0–P3；未知优先级追加而不是被改写', () => {
  const api = rulesEditApi()
  assert.deepEqual(api.RULE_PRIORITY_OPTIONS, ['P0', 'P1', 'P2', 'P3'])
  assert.deepEqual(api.rulePriorityOptions('P1'), ['P0', 'P1', 'P2', 'P3'])
  assert.deepEqual(api.rulePriorityOptions(''), ['P0', 'P1', 'P2', 'P3'])
  assert.deepEqual(api.rulePriorityOptions('p2'), ['P0', 'P1', 'P2', 'P3'])
  assert.deepEqual(api.rulePriorityOptions('PX'), ['P0', 'P1', 'P2', 'P3', 'PX'])
  assert.ok(dialogSource().includes('rulePriorityOptions(priority)'), '弹层未用优先级候选')
})

test('编辑补丁只带真正变化的字段（空值不覆盖），无改动给空 patch', () => {
  const api = rulesEditApi()
  const rule = {
    key: 'r-1', text: '正文 A', conditions: ['c1'], exceptions: ['e1'],
    scope: 'global', priority: 'P1', status: 'active',
  }
  const same = api.ruleEditPatch(rule, {
    text: ' 正文 A ', conditions: 'c1\n\n', exceptions: ['e1'],
    scope: 'global', priority: 'p1', status: 'active',
  })
  assert.deepEqual(same.patch, {})
  assert.deepEqual(same.fields, [])

  const changed = api.ruleEditPatch(rule, {
    text: '正文 B\n第二行', conditions: 'c1\nc2', exceptions: '',
    scope: 'workspace:/w', priority: 'P0', status: 'retired',
  })
  assert.deepEqual(changed.patch, {
    text: '正文 B\n第二行',
    conditions: ['c1', 'c2'],
    exceptions: [],
    scope: 'workspace:/w',
    priority: 'P0',
    status: 'retired',
  })
  assert.deepEqual(changed.fields, ['text', 'conditions', 'exceptions', 'scope', 'priority', 'status'])
  // 缺字段的旧载荷不抛
  assert.deepEqual(api.ruleEditPatch(null, null).patch, {})
})

test('正文计数按 Unicode 码点且硬顶 500', () => {
  const api = rulesEditApi()
  assert.equal(api.RULE_BODY_MAX, 500)
  assert.equal(api.ruleTextChars('ab'), 2)
  assert.equal(api.ruleTextChars('鲸忆'), 2)
  assert.equal(api.ruleTextChars('🐟'), 1)
  assert.equal(api.ruleTextChars(null), 0)
  assert.equal(api.ruleTextChars('x'.repeat(501)), 501)
})

test('当前版本识别：version 对齐优先，退到正文一致，都对不上给 null', () => {
  const api = rulesEditApi()
  const history = [
    { rev: '20260101010101000', version: 3, text: '新正文' },
    { rev: '20250101010101000', version: 2, text: '旧正文' },
  ]
  assert.equal(api.ruleCurrentRev({ version: 3, text: '新正文' }, history), '20260101010101000')
  assert.equal(api.ruleCurrentRev({ version: 2, text: '新正文' }, history), '20250101010101000')
  // 没有 version 字段：按正文一致性认
  assert.equal(api.ruleCurrentRev({ text: '旧正文' }, history), '20250101010101000')
  assert.equal(api.ruleCurrentRev({ text: '谁都不像' }, history), null)
  assert.equal(api.ruleCurrentRev({ version: 9, text: '谁都不像' }, history), null)
  assert.equal(api.ruleCurrentRev({ text: 'x' }, []), null)
  assert.equal(api.ruleCurrentRev(null, null), null)
})

test('服务端 diff 归一：type→kind，形状不对返回 null（走本地兜底）', () => {
  const api = rulesEditApi()
  const rows = api.ruleDiffRowsFromServer({
    ok: true, key: 'r-1', rev: '1',
    diff: [
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'del', text: 'c' },
    ],
  })
  assert.deepEqual(rows.map((row) => row.kind), ['same', 'add', 'del'])
  assert.deepEqual(rows.map((row) => row.text), ['a', 'b', 'c'])
  assert.deepEqual(api.ruleDiffRowsFromServer({ diff: [{ kind: '+', text: 'x' }] }).map((row) => row.kind), ['add'])
  assert.equal(api.ruleDiffRowsFromServer(null), null)
  assert.equal(api.ruleDiffRowsFromServer({ diff: 'nope' }), null)
  // 本地 lineDiff 与服务端 rows 同构，渲染层（RulesDiffRows）只认 kind/text
  const local = api.lineDiff('a\nb', 'a\nc')
  assert.deepEqual(local.map((row) => row.kind), ['same', 'del', 'add'])
  assert.ok(diffRowsSource().includes('css.rulesDiffBody'), 'diff 渲染缺等宽正文容器')
})

test('历史选中拉 /rules/diff?key&rev，失败退回本地 lineDiff 并说明来源', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("callJson('/rules/diff?key=' + encodeURIComponent(ruleKey) + '&rev=' + encodeURIComponent(String(selected))"), '历史 diff 未走服务端契约')
  assert.ok(drawer.includes('ruleDiffRowsFromServer(body)'), '服务端 diff 未归一')
  assert.ok(drawer.includes("status: 'local'"), '服务端 diff 失败未降级')
  assert.ok(drawer.includes('lineDiff(selectedItem.text, text)'), '缺少本地逐行兜底')
  assert.ok(drawer.includes("t('rules.diffServerFail')"), '本地兜底未说明来源')
  assert.ok(drawer.includes('h(RulesDiffRows, { t, rows })'), 'diff 未走统一渲染')
  // 选中项随 reloadTick 重取 diff
  assert.ok(drawer.includes('}, [ruleKey, refreshTick, selected])'), 'diff 未随刷新/选中变化重取')
})

test('回滚：二次确认说明「生成新版本、保留历史」，当前版本标「当前」且禁用', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("askConfirm(t('rules.revertConfirm'))"), '回滚缺少二次确认')
  assert.ok(drawer.includes("callJson('/rules/revert'"), '回滚未走 POST /rules/revert')
  assert.ok(drawer.includes("body: JSON.stringify({ key: String(rule.key || ruleKey), rev: String(item.rev) })"), '回滚载荷必须是 {key,rev}')
  assert.ok(drawer.includes("t('rules.revertDone')"), '回滚缺少成功提示')
  assert.ok(drawer.includes("t('rules.currentRev')"), '历史项缺少「当前」标记')
  assert.ok(drawer.includes('selectedIsCurrent'), '当前版本未参与回滚禁用')
  assert.ok(drawer.includes('disabled: !selectedItem || selectedIsCurrent || revertBusy'), '未选版本/当前版本未禁用回滚')
  assert.ok(drawer.includes("t('rules.rollbackHint')"), '回滚按钮缺说明 tooltip')
  for (const lang of LANGS) {
    const text = dicts[lang]['rules.revertConfirm']
    assert.equal(typeof text, 'string', `${lang} 缺少回滚确认文案`)
    assert.ok(/新版本|new version|新しい版/.test(text), `${lang} 回滚确认未说明生成新版本`)
    assert.ok(/历史|history|履歴/.test(text), `${lang} 回滚确认未说明保留历史`)
  }
})

test('编辑提交：预览→二次确认→POST /rules/update；退役单独二次确认「不再注入但保留历史」', () => {
  const dialog = dialogSource()
  assert.ok(dialog.includes("t('rules.editPreview')"), '缺少预览入口')
  assert.ok(dialog.includes("callJson('/rules/diff?key='"), '编辑预览未尝试服务端 diff')
  assert.ok(dialog.includes('lineDiff(baseline, String(draft.text'), '编辑预览缺本地逐行对比')
  assert.ok(dialog.includes("t('rules.editDiffServerNote')") && dialog.includes("t('rules.editDiffLocalNote')"), '预览缺来源说明')
  assert.ok(dialog.includes("t('rules.editDiffFieldsOnly')"), '仅改结构化字段时缺说明')
  assert.ok(dialog.includes("askConfirm(t('rules.editConfirm'))"), '提交缺少二次确认')
  assert.ok(dialog.includes("askConfirm(t('rules.editRetireConfirm'))"), '退役缺少二次确认')
  assert.ok(dialog.includes("callJson('/rules/update'"), '提交未走 POST /rules/update')
  assert.ok(dialog.includes("body: JSON.stringify({ key: String(base.key || ''), patch })"), '提交载荷必须是 {key,patch}')
  assert.ok(dialog.includes("const patch = preview && phase === 'preview' ? preview.patch : edit.patch"), '提交应使用预览过的 patch')
  assert.ok(dialog.includes('disabled: !editing'), '预览阶段未锁死表单')
  const retireIndex = dialog.indexOf("askConfirm(t('rules.editRetireConfirm'))")
  const confirmIndex = dialog.indexOf("askConfirm(t('rules.editConfirm'))")
  assert.ok(retireIndex >= 0 && confirmIndex > retireIndex, '退役确认必须在最终确认之前')
  for (const lang of LANGS) {
    const text = dicts[lang]['rules.editRetireConfirm']
    assert.equal(typeof text, 'string', `${lang} 缺少退役确认文案`)
    assert.ok(/不再注入|no longer injected|注入しません/.test(text), `${lang} 退役确认未说明不再注入`)
    assert.ok(/历史|history|履歴/.test(text), `${lang} 退役确认未说明保留历史`)
  }
})

test('错误码文案映射：git_required/invalid_rule/immutable_field/rev_not_found 走 i18n + 后端 detail', () => {
  const api = rulesEditApi()
  const dialog = dialogSource()
  const drawer = drawerSource()
  for (const key of ['err.git_required', 'err.invalid_rule', 'err.immutable_field', 'err.rev_not_found',
    'err.rule_not_found', 'err.invalid_patch']) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  assert.ok(dicts.zh['err.git_required'].includes('git'), 'git_required 未提示 git')
  assert.ok(/requireGit|必须有 git/.test(dicts.zh['err.git_required']), 'git_required 未提示可关 requireGit')
  assert.ok(dicts.zh['err.immutable_field'].includes('编号'), 'immutable_field 未点明编号只读')
  // invalid_rule 的 detail 可能是数组/对象，统一压成字段名 + 原因
  assert.equal(api.ruleErrorDetailText('正文超过 500 字'), '正文超过 500 字')
  assert.equal(api.ruleErrorDetailText([{ field: 'priority', message: '必须是 P0|P1' }]), 'priority: 必须是 P0|P1')
  assert.equal(api.ruleErrorDetailText({ errors: [{ field: 'text', code: 'body_too_long' }] }), 'text: body_too_long')
  assert.equal(api.ruleErrorDetailText({ fields: ['priority', 'status'] }), 'priority, status')
  assert.equal(api.ruleErrorDetailText(null), '')
  assert.ok(dialog.includes("ruleErrorDetailText(problem.detail)"), '编辑错误未展示后端 detail')
  assert.ok(dialog.includes("t('rules.errInvalidDetail', { detail })"), 'detail 未走 i18n 前缀')
  assert.ok(dialog.includes("problem.code === 'git_required'"), 'git_required 未单独给安装/关闭提示')
  assert.ok(dialog.includes("t('rules.errGitHint')"), '缺少 git 安装或关闭 requireGit 的指引文案')
  assert.ok(drawer.includes("ruleErrorDetailText(feedback.detail)"), '回滚错误未展示后端 detail')
  assert.ok(drawer.includes("errText(t, { code: feedback.code })"), '回滚错误未走 i18n 兜底')
  assert.ok(api.ruleEditFieldLabel((key) => `T:${key}`, 'conditions') === 'T:rules.editPreviewFieldConditions', '字段名未走 i18n')
})

test('成功后刷新链：编辑/回滚 → onChanged → 列表+详情+AGENTS 提示一起刷新', () => {
  const dialog = dialogSource()
  const drawer = drawerSource()
  const view = viewSource()
  assert.ok(dialog.includes("kind: 'edit'"), '编辑回调缺 kind')
  assert.ok(dialog.includes('changed: body && body.changed !== false'), '编辑回调缺 changed')
  assert.ok(dialog.includes("commit: body && body.commit ? String(body.commit) : ''"), '编辑回调缺 commit')
  assert.ok(drawer.includes('const onEditSaved = (event) =>'), '详情缺保存回调')
  assert.ok(drawer.includes("onChanged(event || { kind: 'edit', changed: true })"), '保存后未通知父级刷新')
  assert.ok(drawer.includes("onChanged({ kind: 'revert'"), '回滚后未通知父级刷新')
  assert.ok(view.includes('const onRuleChanged = (event) =>'), '列表缺写动作回调')
  assert.ok(view.includes('setReloadTick((v) => v + 1)'), '写动作成功后未刷新列表/详情')
  assert.ok(view.includes('onChanged: onRuleChanged'), '详情抽屉未接刷新回调')
  assert.ok(view.includes("t('rules.agentsSynced')"), '成功提示未说明 AGENTS 摘要同步')
  assert.ok(view.includes("op.kind === 'edit'") && view.includes("op.kind === 'revert'"), '列表顶部提示缺编辑/回滚分支')
})

test('i18n：R5 新增 key 三语齐全、非空、占位符一致', () => {
  const used = new Set([
    ...tKeys(dialogSource(), 'rules'),
    ...tKeys(drawerSource(), 'rules'),
    ...tKeys(viewSource(), 'rules'),
  ])
  assert.ok(used.size >= 60, `编辑/回滚链路只引用 ${used.size} 个 rules 键，疑似渲染被删`)
  for (const key of used) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  const newKeys = [
    'rules.editTitle', 'rules.editHint', 'rules.editImmutableNote', 'rules.editTextLabel',
    'rules.editConditionsLabel', 'rules.editExceptionsLabel', 'rules.editScopeLabel',
    'rules.editScopeValueLabel', 'rules.editScopeGlobal', 'rules.editScopeWorkspace', 'rules.editScopeRole',
    'rules.editScopeWorkspacePlaceholder', 'rules.editScopeRolePlaceholder', 'rules.editScopeInvalid',
    'rules.editPriorityLabel', 'rules.editStatusLabel', 'rules.editStatusActive', 'rules.editStatusRetired',
    'rules.editRetiredHint', 'rules.editRetireConfirm', 'rules.editPreview', 'rules.editPreviewTitle',
    'rules.editPreviewFieldText', 'rules.editPreviewFieldConditions', 'rules.editPreviewFieldExceptions',
    'rules.editPreviewFieldScope', 'rules.editPreviewFieldPriority', 'rules.editPreviewFieldStatus',
    'rules.editDiffServerNote', 'rules.editDiffLocalNote', 'rules.editDiffFieldsOnly',
    'rules.editBack', 'rules.editSubmit',
    'rules.editConfirm', 'rules.editDone', 'rules.editNoChange', 'rules.editInvalidText',
    'rules.fieldKey', 'rules.agentsSynced', 'rules.currentRev', 'rules.currentRevHint',
    'rules.rollbackHint', 'rules.rollbackSelectHint', 'rules.rollbackCurrentHint',
    'rules.revertConfirm', 'rules.revertDone', 'rules.revertBusy',
    'rules.diffServerFail', 'rules.diffLoading', 'rules.errGitHint', 'rules.errInvalidDetail',
  ]
  for (const key of newKeys) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少新增键 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  // 占位符三语一致（i18n-check 同口径）
  const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',')
  assert.equal(placeholders(dicts.en['rules.errInvalidDetail']), placeholders(dicts.zh['rules.errInvalidDetail']))
  // R3b 的两条占位键必须物理删除（铁律：零封存死代码）
  for (const lang of LANGS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(dicts[lang], 'rules.rollbackPending'), `${lang} 残留 rules.rollbackPending`)
    assert.ok(!Object.prototype.hasOwnProperty.call(dicts[lang], 'rules.editPending'), `${lang} 残留 rules.editPending`)
  }
  const zhKeys = Object.keys(dicts.zh).sort()
  for (const lang of LANGS.slice(1)) {
    assert.deepEqual(Object.keys(dicts[lang]).sort(), zhKeys, `${lang} 与 zh 键集不一致`)
  }
})

test('窄屏与视觉克制：弹层 94vw、正文可换行、警告色仅用于退役/风险', () => {
  const css = CLIENT.slice(CLIENT.indexOf('      rulesEditPanel: {'), CLIENT.indexOf('      resultItem: {'))
  assert.match(css, /width: 'min\(640px, 94vw\)'/, '编辑弹层窄屏未限宽')
  assert.match(css, /maxHeight: '90vh'/, '编辑弹层缺高度上限')
  assert.ok(css.includes('overflowY: \'auto\''), '编辑弹层缺纵向滚动')
  assert.ok(css.includes("gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))'"), '只读区窄屏未自适应')
  const rowCss = CLIENT.slice(CLIENT.indexOf('      rulesDiffBody: {'), CLIENT.indexOf('      rulesHistoryCurrent:'))
  assert.ok(rowCss.includes('wordBreak: \'break-word\''), 'diff 未换行保护')
  assert.ok(rowCss.includes('overflowY: \'auto\''), 'diff 缺滚动容器')
  // 克制：编辑/回滚不使用 error 红（红只留给状态/守卫失败），确认按钮走品牌色。
  const dialog = dialogSource()
  assert.ok(!dialog.includes('state-error-primary'), '编辑弹层不应使用错误红')
  assert.ok(dialog.includes('css.buttonPrimary'), '提交按钮应走品牌色')
  assert.ok(drawerSource().includes('css.buttonWarn'), '回滚按钮应用警告色而非品牌主色')
})

test('运行时冒烟：编辑弹层真实渲染（只读 key/编号、字段与选项文案）', () => {
  const pureSource = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  // 只有 UI 源码参与渲染，纯函数复用真实现：能抓到「引用未定义变量」这类运行时炸点。
  const uiSource = sliceFrom('function RulesDiffRows(props) {', '// ----------------------------------------------------------------- recall')
  const stubs = `
    const h = (type, props, ...children) => {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: merged.children }
    }
    const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    const useEffect = () => {}
    const css = new Proxy({}, { get: () => ({}) })
    const Row = (props) => h('div', null, props.k, ': ', props.v)
    const SelectInput = (props) => h('select', null, (props.options || []).map(([v, l]) => h('option', { value: v }, l)))
    const TextInput = (props) => h('input', { value: props.value, placeholder: props.placeholder })
    const ruleNumberText = (rule) => (Number.isFinite(Number(rule && rule.number)) ? '#' + String(rule.number) : '—')
    const ruleTypeLabel = (t, value) => (String(value || '') === 'normal' ? t('rules.typeNormal') : String(value || '—'))
    const ruleStatusLabel = (t, value) => (String(value || '') === 'active' ? t('rules.statusActive') : String(value || '—'))
    const ruleList = () => null
    const fmtNum = (value) => (value === null || value === undefined ? '—' : String(value))
    const fmtTime = (value) => (value === null || value === undefined ? '—' : String(value))
    const errText = (t) => t('err.unknown')
    const askConfirm = () => true
    const callJson = async () => ({})
    const StateBlock = () => null
    const RulesStatusBadge = () => null
    const SectionTitle = (props) => h('div', null, props.children)
  `
  const api = new Function(`${pureSource}\n${stubs}\n${uiSource}
return { RulesEditDialog, RulesDiffRows }`)()
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
    if (typeof node === 'object') return textOf(node.children)
    return ''
  }
  const rule = {
    key: 'r-port', type: 'normal', number: 7, priority: 'P1', scope: 'global',
    status: 'active', text: '网关固定 3982', conditions: ['loopback'], exceptions: [],
    version: 3, created: '2026-01-01', updated: '2026-02-02', origin: 'file',
  }
  const tree = api.RulesEditDialog({
    t, locale: 'zh', rule, history: [], onClose() {}, onSaved() {},
  })
  const text = textOf(tree)
  for (const token of [
    '编辑规则', '标识（key）', 'r-port', '#7', '普通规则',
    '正文（≤500 字）', '条件（每行一条）', '例外（每行一条）',
    '作用域', '全局', '工作区', '角色', '优先级', 'P0', 'P1', 'P2', 'P3',
    '状态', '生效（active）', '退役（retired）', '9 / 500 字',
    '只读', '预览变更',
  ]) {
    assert.ok(text.includes(token), `编辑弹层渲染缺少「${token}」：${text.slice(0, 500)}`)
  }
  // 退役提示只在「即将退役」时出现：初始 active 状态不应出现「不再注入」。
  assert.ok(!text.includes('不再注入'), '未选择退役却渲染了退役提示')
  // 空 rows 的 diff 渲染给「一致」文案，而不是空白。
  const emptyDiff = textOf(api.RulesDiffRows({ t, rows: [{ kind: 'same', text: 'x' }] }))
  assert.ok(emptyDiff.includes('这个版本与当前正文一致'), '无差异时 diff 未给一致文案')
  const addedDiff = textOf(api.RulesDiffRows({ t, rows: [{ kind: 'add', text: '新行' }] }))
  assert.ok(addedDiff.includes('+ 新行'), '新增行未带 + 前缀')
})

test('运行时冒烟：详情抽屉渲染「当前」标记 + 回滚/编辑可用（diff 行真实输出）', () => {
  const pureSource = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  const uiSource = sliceFrom('function RulesDiffRows(props) {', '// ----------------------------------------------------------------- recall')
  const rule = {
    key: 'r-port', type: 'normal', number: 7, priority: 'P1', scope: 'global',
    status: 'active', text: '网关固定 3982', conditions: ['loopback'], exceptions: [],
    version: 3, created: '2026-01-01', updated: '2026-02-02', origin: 'file',
  }
  const history = [
    { rev: '20260202020202000', version: 3, source: 'git', ts: 1763800000000, text: '网关固定 3982' },
    { rev: '20260101010101000', version: 2, source: 'git', ts: 1763000000000, text: '网关固定 3002' },
  ]
  const stubs = `
    const h = (type, props, ...children) => {
      const merged = { ...(props || {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      if (typeof type === 'function') return type(merged)
      return { type, props: merged, children: merged.children }
    }
    // useState 按调用序号喂固定值：抽屉顺序＝loaded/selected/serverDiff/feedback/editOpen/revertBusy。
    let __stateIndex = 0
    const __presets = __PRESETS__
    const useState = (initial) => [__presets[__stateIndex++] !== undefined ? __presets[__stateIndex - 1] : initial, () => {}]
    const useEffect = () => {}
    const css = new Proxy({}, { get: () => ({}) })
    const Row = (props) => h('div', null, props.k, ': ', props.v)
    const SectionTitle = (props) => h('div', null, props.children)
    const StateBlock = () => null
    const RulesStatusBadge = () => null
    const SelectInput = (props) => h('select', null, (props.options || []).map(([v, l]) => h('option', { value: v }, l)))
    const TextInput = (props) => h('input', { value: props.value })
    const ruleNumberText = (r) => (Number.isFinite(Number(r && r.number)) ? '#' + String(r.number) : '—')
    const ruleTypeLabel = (t, value) => (String(value || '') === 'normal' ? t('rules.typeNormal') : String(value || '—'))
    const ruleStatusLabel = (t, value) => (String(value || '') === 'active' ? t('rules.statusActive') : String(value || '—'))
    const ruleList = (value, t) => h('ul', null, (Array.isArray(value) ? value : []).map((item) => h('li', null, item)))
    const fmtNum = (value) => (value === null || value === undefined ? '—' : String(value))
    const fmtTime = (value) => (value === null || value === undefined ? '—' : String(value))
    const errText = (t) => t('err.unknown')
    const askConfirm = () => true
    const callJson = async () => ({})
  `
  const presets = [
    { status: 'ok', rule, history }, // loaded
    history[1].rev, // selected：选中旧版本（与当前正文不同）
    { status: 'ok', rows: [{ kind: 'del', text: '网关固定 3002' }, { kind: 'add', text: '网关固定 3982' }], rev: history[1].rev },
    null, // feedback
    false, // editOpen
    false, // revertBusy
  ]
  // 状态预设直接拼进函数体：rev 是字符串，JSON 化后仍然逐字一致。
  const injected = stubs.replace('__PRESETS__', JSON.stringify(presets))
  const api = new Function(`${pureSource}\n${injected}\n${uiSource}
return { RuleDrawer }`)()
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
    if (typeof node === 'object') return textOf(node.children)
    return ''
  }
  const tree = api.RuleDrawer({ t, locale: 'zh', ruleKey: 'r-port', refreshTick: 0, onChanged() {}, onClose() {} })
  const text = textOf(tree)
  for (const token of [
    '规则详情', 'r-port', '普通规则', '生效', '网关固定 3982',
    '当前', '历史版本', '网关固定 3002', '版本对比', '回滚到此版本', '编辑',
  ]) {
    assert.ok(text.includes(token), `详情抽屉渲染缺少「${token}」：${text.slice(0, 600)}`)
  }
  // 编号/版本仍是只读展示（详情只读行，不提供输入）
  assert.match(text, /编号\s*:\s*7/, '详情未展示编号')
  assert.match(text, /版本\s*:\s*3/, '详情未展示版本号')
  // 当前版本标记只应落在 version=3 那条；选中旧版本时 diff 必须真实输出增删行。
  assert.ok(text.includes('- 网关固定 3002'), 'diff 未输出删除行')
  assert.ok(text.includes('+ 网关固定 3982'), 'diff 未输出新增行')
  // 选中项是旧版本 → 不是当前版本 → 回滚应可用（button 无 disabled）
  const collect = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { node.forEach((child) => collect(child, out)); return out }
    if (node.type === 'button') out.push(node)
    collect(node.children, out)
    return out
  }
  const buttons = collect(tree)
  const rollback = buttons.find((node) => textOf(node) === '回滚到此版本')
  const edit = buttons.find((node) => textOf(node) === '编辑')
  assert.ok(rollback, '详情缺少回滚按钮')
  assert.ok(edit, '详情缺少编辑按钮')
  assert.ok(!rollback.props.disabled, '选中非当前版本时回滚不应禁用')
  assert.ok(!edit.props.disabled, '编辑按钮不应禁用')
})
