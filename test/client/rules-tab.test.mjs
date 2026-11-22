/**
 * 「规则」页签 + 设置组契约测试（零依赖、零网络、无 DOM）。
 *
 * 锁住 R3a 契约的客户端面：页签位置、git 三态、过滤/diff 降级、写操作二次确认、
 * 待确认区软降级、空态引导、详情只读边界，以及 rules.* 设置字段的默认值/生效/依赖。
 * 唯一执行源码的用例抽取 client 的 `rules:pure` / `rules-settings:contract` 标记块
 * （纯函数、无 React/无 t()）在 node 里跑，确认缺字段不抛、不出现 undefined。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
const LANGS = ['zh', 'en', 'ja']
const NEW_KEYS = [
  'tab.rules', 'rules.intro', 'rules.gitOk', 'rules.gitMissing', 'rules.gitBroken', 'rules.gitUnknown',
  'rules.gitGuide', 'rules.gitGuideTitle', 'rules.gitGuideBrew', 'rules.gitGuideApt', 'rules.gitGuideWinget',
  'rules.gitGuideDownload', 'rules.gitGuideSnapshot', 'rules.dirLabel', 'rules.copyDir', 'rules.copied',
  'rules.rebuildMirror', 'rules.rebuildConfirm', 'rules.rebuildDone', 'rules.importLegacy',
  'rules.importConfirm', 'rules.importDone', 'rules.proposalsTitle', 'rules.proposalsEmpty',
  'rules.emptyTitle', 'rules.emptyWhy', 'rules.emptyStepImport', 'rules.emptyStepEdit', 'rules.emptyStepRefresh',
  'rules.rollbackPending', 'rules.editPending', 'rules.diffOld', 'rules.diffNew',
  'rules.typeCandidate', 'rules.importSkipped', 'err.rules_disabled', 'err.git_required',
]

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

function rulesApi() {
  const source = contractBlock('rules:pure')
    .replace(/\/\/ >>> rules:pure[^\n]*/, '')
    .replace(/\/\/ <<< rules:pure[^\n]*/, '')
  return new Function(`${source}
return { rulesGitState, ruleBucketOf, filterRuleList, shortPath, ruleSummary, ruleFieldText, lineDiff }`)()
}

function rulesSettingsMeta() {
  const source = contractBlock('rules-settings:contract')
    .replace(/\/\/ >>> rules-settings:contract[^\n]*/, '')
    .replace(/\/\/ <<< rules-settings:contract[^\n]*/, '')
  return new Function(`${source}\nreturn RULES_SETTINGS_META`)()
}

const tKeys = (source, prefix) => new Set(
  [...source.matchAll(new RegExp(`t\\('(${prefix}\\.[A-Za-z0-9_.]+)'`, 'g'))].map((match) => match[1]),
)

test('TABS 含 rules，且位于「记忆库」之后、「召回」之前', () => {
  const tabs = CLIENT.slice(CLIENT.indexOf('const TABS = ['), CLIENT.indexOf(']\n\n    // >>> locale:generated'))
  const memory = tabs.indexOf("['memory', 'tab.memory']")
  const rules = tabs.indexOf("['rules', 'tab.rules']")
  const recall = tabs.indexOf("['recall', 'tab.recall']")
  assert.ok(memory >= 0 && rules >= 0 && recall >= 0, 'TABS 缺少 memory/rules/recall 之一')
  assert.ok(memory < rules && rules < recall, 'rules 页签顺序错误')
  assert.ok(CLIENT.includes("tab === 'rules'") && CLIENT.includes('h(RulesView'), 'Panel 未分发到 RulesView')
})

test('tab.rules 三语标题正确', () => {
  assert.equal(dicts.zh['tab.rules'], '规则')
  assert.equal(dicts.en['tab.rules'], 'Rules')
  assert.equal(dicts.ja['tab.rules'], 'ルール')
})

test('git 三态：可用=绿 / 未安装=黄 / 损坏=红 / 缺字段=未知', () => {
  const api = rulesApi()
  const unknown = api.rulesGitState(null)
  assert.equal(unknown.tone, 'unknown')
  assert.equal(unknown.installed, null)
  const missing = api.rulesGitState({ available: false, required: true, error: 'not found' })
  assert.equal(missing.tone, 'warn')
  assert.equal(missing.installed, false)
  assert.equal(missing.required, true)
  const ok = api.rulesGitState({ available: true, version: '2.44.0', checkedAt: 1763800000000 })
  assert.equal(ok.tone, 'ok')
  assert.equal(ok.version, '2.44.0')
  const broken = api.rulesGitState({ available: true, error: 'corrupt object' })
  assert.equal(broken.tone, 'error')
  assert.equal(broken.broken, true)
  // 字段缺失/非对象同样不抛
  assert.equal(api.rulesGitState('nope').tone, 'unknown')
})

test('规则语义桶与本地过滤：铁律/普通/候选/退役 + key/标题/正文子串', () => {
  const api = rulesApi()
  assert.equal(api.ruleBucketOf({ type: 'iron', status: 'active' }), 'iron')
  assert.equal(api.ruleBucketOf({ type: 'normal', status: 'active' }), 'normal')
  assert.equal(api.ruleBucketOf({ type: 'iron', status: 'candidate' }), 'candidate')
  assert.equal(api.ruleBucketOf({ type: 'normal', status: 'merged' }), 'retired')
  const rows = [
    { key: 'R-1', number: 1, title: '端口固定', excerpt: '网关固定 3982', type: 'normal', status: 'active' },
    { key: 'R-2', number: 2, title: '以后都写测试', excerpt: '回归优先', type: 'iron', status: 'active' },
    { key: 'R-3', number: 3, title: '候选规则', excerpt: '待确认', type: 'normal', status: 'candidate' },
  ]
  assert.equal(api.filterRuleList(rows, 'iron', '').length, 1)
  assert.equal(api.filterRuleList(rows, 'candidate', '').length, 1)
  assert.equal(api.filterRuleList(rows, 'retired', '').length, 0)
  assert.equal(api.filterRuleList(rows, 'all', '3982').length, 1)
  assert.equal(api.filterRuleList(rows, 'all', 'R-2').length, 1)
  assert.equal(api.filterRuleList(rows, 'all', '回归').length, 1)
  assert.deepEqual(api.filterRuleList(null, 'all', ''), [])
  assert.deepEqual(api.filterRuleList([null, 'x'], 'all', ''), [])
})

test('长作用域省略保留头尾、摘要 ≤60 字、对象条目取正文字段', () => {
  const api = rulesApi()
  assert.equal(api.shortPath('/a/b', 28), '/a/b')
  const long = '/home/hy/.dsh/rules/workspaces/very-long-workspace-name/rules'
  const cut = api.shortPath(long, 28)
  assert.ok(cut.length <= 29, `短路径超长：${cut}`)
  assert.match(cut, /…/)
  assert.ok(cut.startsWith('/home/hy'), '短路径未保留头部')
  assert.ok(cut.endsWith('rules'), '短路径未保留尾部')
  const summary = api.ruleSummary({ excerpt: 'x'.repeat(200) }, 60)
  assert.ok(summary.length <= 61, '摘要未截断')
  assert.equal(api.ruleFieldText({ condition: '端口=3982' }), '端口=3982')
  assert.equal(api.ruleFieldText(['a', null, 'b']), 'a / b')
})

test('逐行 diff：旧=del / 新=add / 相同=same，相同文本无变更', () => {
  const api = rulesApi()
  const rows = api.lineDiff('a\nb\nc', 'a\nx\nc')
  assert.deepEqual(rows.filter((row) => row.kind === 'del').map((row) => row.text), ['b'])
  assert.deepEqual(rows.filter((row) => row.kind === 'add').map((row) => row.text), ['x'])
  assert.equal(rows.filter((row) => row.kind === 'same').length, 2)
  assert.ok(!api.lineDiff('same\ntext', 'same\ntext').some((row) => row.kind !== 'same'), '相同文本出现差异')
  assert.deepEqual(api.lineDiff(null, null).map((row) => row.kind), ['same'])
})

test('列表/详情请求走 /rules 契约，缺字段有兜底，失败态可重试', () => {
  assert.ok(CLIENT.includes("callJson('/rules')"), '缺少 GET /rules')
  assert.ok(CLIENT.includes("callJson('/rules/' + encodeURIComponent(ruleKey))"), '缺少 GET /rules/:key')
  assert.ok(CLIENT.includes("callJson('/rules/git-status')"), '缺少 git 状态刷新')
  assert.ok(CLIENT.includes("callJson('/rules/rebuild-mirror'"), '缺少重建镜像 POST')
  assert.ok(CLIENT.includes("callJson('/rules/import-legacy'"), '缺少导入铁律 POST')
  const view = sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
  assert.match(view, /Array\.isArray\(body && body\.rules\) \? body\.rules : \[\]/, '/rules 缺 rules 数组兜底')
  assert.match(view, /typeof \(body && body\.dir\) === 'string'/, '/rules 缺 dir 兜底')
  assert.ok(view.includes("h(StateBlock, { t, status: 'error', err: list.err, onRetry: rerun })"), '列表失败未走可重试错误态')
  const drawer = sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
  assert.match(drawer, /Array\.isArray\(body && body\.history\)/, '详情缺 history 兜底')
  assert.ok(drawer.includes("h(StateBlock, { t, status: 'error', err: loaded.err })"), '详情失败未走错误态')
  assert.ok(drawer.includes('ruleFieldText(rule.origin)'), 'origin 未做对象/缺失降级')
})

test('git 状态条三态文案 + 安装指引含 brew/apt/winget/下载/快照说明', () => {
  const bar = sliceFrom('function RulesGitBar(props) {', 'function RulesProposalsCard(props) {')
  for (const token of ["t('rules.gitOk'", "t('rules.gitMissing')", "t('rules.gitBroken')", "t('rules.gitUnknown')"]) {
    assert.ok(bar.includes(token), `状态条缺少 ${token}`)
  }
  assert.ok(bar.includes("t('rules.gitGuide')"), '缺少查看安装指引入口')
  assert.ok(bar.includes("t('rules.gitTitle')"), '缺少 git 标题')
  assert.ok(bar.includes("t('rules.dirLabel')"), '缺少规则目录显示')
  assert.ok(bar.includes("t('rules.rebuildMirror')"), '缺少重建镜像按钮')
  const guide = sliceFrom('function RulesGitGuide(props) {', 'function ruleList(value, t) {')
  for (const token of ['brew install git', 'sudo apt install git', 'winget install --id Git.Git -e']) {
    assert.ok(guide.includes(token), `安装指引缺少命令 ${token}`)
  }
  assert.ok(guide.includes('https://git-scm.com/downloads'), '安装指引缺少下载链接')
  assert.ok(guide.includes("t('rules.gitGuideSnapshot')"), '安装指引缺少「无 git 仍可用快照」说明')
  assert.ok(guide.includes("t('rules.gitGuideDownload')"), '安装指引缺少下载文案')
})

test('待确认区：404 软降级空态，其它失败给卡片内错误态与重试', () => {
  assert.ok(CLIENT.includes("callJson('/rules/proposals?status=pending')"), '缺少提案请求')
  const view = sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
  assert.ok(view.includes("err.code === 'not_found' || err.status === 404"), '404 未软降级为空态')
  assert.ok(view.includes("setProposals({ status: 'empty', items: [] })"), '404 未回到空态')
  assert.ok(view.includes("setProposals({ status: 'error', items: [], err })"), '非 404 失败未给错误态')
  const card = sliceFrom('function RulesProposalsCard(props) {', 'function RulesTable(props) {')
  assert.ok(card.includes("t('rules.proposalsEmpty')"), '缺少待确认空态文案')
  assert.ok(card.includes("t('rules.proposalError')"), '缺少提案读取错误文案')
  assert.ok(card.includes("t('rules.proposalsTitle'"), '缺少「待确认 N 条」标题')
  assert.ok(card.includes('onRetry'), '提案错误态缺少重试入口')
})

test('所有写操作二次确认，回滚/编辑 R3b 前 disabled + 说明', () => {
  const view = sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
  for (const key of ['rules.rebuildConfirm', 'rules.importConfirm']) {
    assert.ok(view.includes(`askConfirm(t('${key}'))`), `缺少二次确认 ${key}`)
  }
  assert.ok(view.includes("t('rules.rebuildDone')"), '重建缺少成功提示')
  assert.ok(view.includes("t('rules.importDone')"), '导入缺少成功提示')
  const drawer = sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
  assert.match(drawer, /disabled: true, title: t\('rules\.rollbackPending'\)/, '回滚按钮未 disabled + 说明')
  assert.match(drawer, /disabled: true, title: t\('rules\.editPending'\)/, '编辑按钮未 disabled + 说明')
  assert.ok(drawer.includes("t('rules.diffOld')") && drawer.includes("t('rules.diffNew')"), '缺少旧/新对比标记')
  assert.ok(drawer.includes('lineDiff('), '缺少逐行 diff 调用')
})

test('空态引导：为什么需要规则 / 导入铁律 / 文件在 ~/.dsh/rules 可手改', () => {
  const guide = sliceFrom('function RulesEmptyGuide(props) {', 'function RulesGitGuide(props) {')
  for (const key of ['rules.emptyTitle', 'rules.emptyWhy', 'rules.emptyStepImport',
    'rules.emptyStepEdit', 'rules.emptyStepRefresh', 'rules.importLegacy']) {
    assert.ok(guide.includes(`t('${key}')`), `空态缺少 ${key}`)
  }
  assert.ok(dicts.zh['rules.emptyStepEdit'].includes('~/.dsh/rules'), '空态未说明规则文件位置')
  assert.ok(CLIENT.includes('h(RulesEmptyGuide'), '列表为空未走空态引导')
})

test('列表 8 列齐全、窄屏滚动、行 hover 走状态', () => {
  const table = sliceFrom('function RulesTable(props) {', 'function RulesTypeBadge(props) {')
  for (const key of ['rules.colNumber', 'rules.colType', 'rules.colPriority', 'rules.colScope',
    'rules.colStatus', 'rules.colUpdated', 'rules.colExcerpt', 'rules.colOps']) {
    assert.ok(table.includes(`t('${key}')`), `表格缺少列 ${key}`)
  }
  assert.match(table, /overflowX: 'auto'/, '表格缺横向滚动容器')
  assert.ok(table.indexOf("overflowX: 'auto'") < table.indexOf("h('table'"), '滚动容器必须在表格外层')
  assert.match(table, /onMouseEnter: \(\) => setHover/, '表格行缺 hover')
  assert.match(table, /shortPath\(\(rule && rule\.scope\) \|\| '—', 28\)/, '作用域未省略')
  assert.match(table, /title: String\(\(rule && rule\.scope\) \|\| ''\)/, '作用域缺完整值 tooltip')
  assert.match(CLIENT, /rulesRowHover: \{ background: 'var\(--dsw-alias-bg-layer-2\)' \}/, '缺少行 hover 样式')
})

test('rules.* 渲染引用键三语齐全且非空', () => {
  const rulesSource = sliceFrom('// ------------------------------------------------------------------ rules',
    '// ----------------------------------------------------------------- recall')
  const used = tKeys(rulesSource, 'rules')
  assert.ok(used.size >= 45, `规则页只引用 ${used.size} 个 rules 键，疑似渲染被删`)
  for (const key of used) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
  for (const key of NEW_KEYS) {
    for (const lang of LANGS) {
      assert.ok(Object.prototype.hasOwnProperty.call(dicts[lang], key), `${lang} 缺少新增键 ${key}`)
    }
  }
})

test('规则设置组 9 字段：默认值/生效/依赖与 UI 控件齐全', () => {
  const meta = rulesSettingsMeta()
  assert.equal(Object.keys(meta).length, 9, '规则设置字段数应为 9')
  const expected = {
    'rules.enabled': [true, 'instant'],
    'rules.dir': ['', 'reload'],
    'rules.requireGit': [false, 'reload'],
    'rules.askMode': ['panel+chat', 'reload'],
    'rules.llm': [false, 'instant'],
    'rules.maxProposals': [20, 'reload'],
    'rules.guardStrict': [true, 'reload'],
    'rules.mirrorAuto': [true, 'reload'],
    'rules.askCooldownDays': [30, 'reload'],
  }
  for (const [key, [def, effect]] of Object.entries(expected)) {
    assert.ok(meta[key], `缺少 ${key}`)
    assert.deepEqual(meta[key].def, def, `${key} 默认值错误`)
    assert.equal(meta[key].effect, effect, `${key} 生效方式错误`)
    assert.ok(['general', 'local', 'needsConfig'].includes(meta[key].badge), `${key} badge 非法`)
  }
  // 消费类字段依赖 rules.enabled=true，依赖原因三语齐全
  for (const key of Object.keys(meta)) {
    if (!meta[key].dependsOn) continue
    assert.deepEqual(meta[key].dependsOn, {
      group: 'rules', key: 'enabled', equals: true, reasonKey: 'settings.depRulesEnabled',
    }, `${key} 依赖结构错误`)
  }
  for (const lang of LANGS) {
    assert.equal(typeof dicts[lang]['settings.depRulesEnabled'], 'string', `${lang} 缺少依赖原因`)
  }
  const source = sliceFrom('// >>> rules-settings:contract', '// <<< rules-settings:contract')
  assert.ok(source.length > 0)
  const settings = sliceFrom('// >>> settings:contract', '// ------------------------------------------------------------------- css')
  for (const key of Object.keys(meta)) {
    const field = key.split('.')[1]
    assert.ok(settings.includes(`idOf('rules', '${field}')`), `设置页缺少 rules.${field} 控件`)
  }
  assert.ok(settings.includes("t('settings.groupRules')"), '设置页缺少规则分组标题')
  assert.ok(settings.includes('draft.rules.enabled'), '设置页未接 draft.rules')
})

test('normalizeConfig 回读 rules 组 9 字段，configIssue 校验范围', () => {
  const normalize = sliceFrom('function normalizeConfig(config) {', 'function configIssue(draft) {')
  assert.match(normalize, /const rules = cfg\.rules \|\| \{\}/, 'normalizeConfig 未读 cfg.rules')
  for (const field of ['enabled: rules.enabled !== false', "dir: typeof rules.dir === 'string'",
    'requireGit: rules.requireGit === true', 'maxProposals: n(rules.maxProposals, 20)',
    'guardStrict: rules.guardStrict !== false', 'mirrorAuto: rules.mirrorAuto !== false',
    'askCooldownDays: n(rules.askCooldownDays, 30)']) {
    assert.ok(normalize.includes(field), `normalizeConfig 缺 rules 叶子：${field}`)
  }
  assert.match(normalize, /oneOf\(rules\.askMode, \['panel\+chat', 'panel', 'off'\], 'panel\+chat'\)/, 'askMode 枚举兜底错误')
  const issue = CLIENT.slice(CLIENT.indexOf('function configIssue(draft) {'), CLIENT.indexOf('function GroupCard(props) {'))
  assert.match(issue, /\[draft\.rules\.maxProposals, 1, 200\]/, 'maxProposals 未校验范围')
  assert.match(issue, /\[draft\.rules\.askCooldownDays, 0, 3650\]/, 'askCooldownDays 未校验范围')
})

test('三语键集一致且新增规则键全部存在', () => {
  const zh = Object.keys(dicts.zh).sort()
  for (const lang of LANGS.slice(1)) {
    assert.deepEqual(Object.keys(dicts[lang]).sort(), zh, `${lang} 与 zh 键集不一致`)
  }
  const rulesKeys = zh.filter((key) => key.startsWith('rules.'))
  assert.ok(rulesKeys.length >= 90, `规则页键只有 ${rulesKeys.length} 个`)
  assert.equal(dicts.zh['settings.groupRules'], '规则')
  assert.equal(dicts.en['settings.groupRules'], 'Rules')
  assert.equal(dicts.ja['settings.groupRules'], 'ルール')
})

test('列表摘要 ≤60 字与状态色克制：红只用于 git 损坏，不用于规则状态', () => {
  const badge = sliceFrom('function RulesStatusBadge(props) {', 'function RulesEmptyGuide(props) {')
  assert.ok(!badge.includes('state-error-primary'), '规则状态徽标不应使用红色')
  assert.ok(badge.includes('state-success-primary') && badge.includes('state-warn-primary'), '状态徽标缺少绿/黄')
  // 红/绿只留给 git 状态与状态徽标：diff 增删改用品牌色/警告色。
  const diffCss = CLIENT.slice(CLIENT.indexOf('      rulesDiffTagOld:'), CLIENT.indexOf('      rulesDiffDel:'))
  assert.ok(!diffCss.includes('state-success-primary'), 'diff 新行不应使用绿色')
  assert.ok(!diffCss.includes('state-error-primary'), 'diff 旧行不应使用红色')
  const view = sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
  assert.ok(view.includes('ruleSummary(rule, 60)') || CLIENT.includes('ruleSummary(rule, 60)'), '列表摘要未按 60 字截断')
})
