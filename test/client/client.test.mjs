/**
 * 面板契约测试（零依赖、零网络）。
 *
 * 这些断言锁住 i18n 单一真源、五页签、设置分组、可解释召回、候选审核、窄屏表格
 * 与概览观测块（指标卡/7 日曲线/最近失败）；不启动插件、不连后端。
 * 唯一执行源码的用例是「降级」断言：它抽取 client 的 observability:pure 标记块
 * （纯函数、无 React/无 t()）在 node 里跑，确认缺字段不出 NaN/undefined。
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

test('五页签 id 都在 TABS 中', () => {
  for (const id of ['overview', 'memory', 'recall', 'writes', 'settings']) {
    assert.match(CLIENT, new RegExp(`\\['${id}', 'tab\\.${id}'\\]`), `缺少页签 ${id}`)
  }
})

test('设置页至少 6 个分组标题键，且现有 14 组齐全', () => {
  const groups = Object.keys(dicts.zh).filter((key) => key.startsWith('settings.group'))
  assert.ok(groups.length >= 6, `设置分组只有 ${groups.length} 个`)
  for (const group of [
    'settings.groupBackend', 'settings.groupIdentity', 'settings.groupRecall', 'settings.groupWrite',
    'settings.groupReflect', 'settings.groupWrap', 'settings.groupConsolidate', 'settings.groupEmbed',
    'settings.groupPrivacy', 'settings.groupEdges', 'settings.groupSync', 'settings.groupPanel',
    'settings.groupAdvanced', 'settings.groupDanger',
  ]) {
    assert.ok(groups.includes(group), `缺少分组键 ${group}`)
  }
})

test('i18n 三语键集完全一致', () => {
  const zh = new Set(Object.keys(dicts.zh))
  for (const lang of LANGS.slice(1)) {
    const keys = new Set(Object.keys(dicts[lang]))
    assert.deepEqual([...keys].sort(), [...zh].sort(), `${lang} 与 zh 的键集不一致`)
  }
})

test('client 标记块与 locale JSON 逐字一致', () => {
  const START = '// >>> locale:generated（由 scripts/i18n-check.mjs --write 生成，勿手改）'
  const END = '// <<< locale:generated'
  const json = JSON.stringify(dicts)
  const expected = `${START}\n    const dict = ${json}\n    ${END}`
  assert.ok(CLIENT.includes(START), '缺少生成块起始标记')
  assert.ok(CLIENT.includes(END), '缺少生成块结束标记')
  assert.ok(CLIENT.includes(expected), '标记块内容与 locale JSON 不一致；运行 node scripts/i18n-check.mjs --write')
})

test('不再内联旧的 dict = { zh: ... } 写法', () => {
  assert.doesNotMatch(CLIENT, /\bdict\s*=\s*\{\s*zh\s*:/, '旧的 zh/en 内联字典仍然存在')
})

test('13 个错误码文案齐全', () => {
  const codes = [
    'sync_disabled', 'sync_bridge_unset', 'confirm_required', 'invalid_direction', 'busy',
    'reflect_unavailable', 'candidate_not_found', 'invalid_review', 'privacy', 'daily_cap',
    'text_too_long', 'unknown_error', 'network_error',
  ]
  for (const code of codes) {
    assert.ok(Object.prototype.hasOwnProperty.call(dicts.zh, `err.${code}`), `缺少 err.${code}`)
    for (const lang of LANGS) {
      assert.ok(Object.prototype.hasOwnProperty.call(dicts[lang], `err.${code}`), `${lang} 缺少 err.${code}`)
    }
  }
})

test('召回/候选/关系/演化请求路径都在源码中', () => {
  for (const endpoint of [
    "'/recall-test'",
    "'/writes?action=CANDIDATE&limit=100'",
    "'/edges'",
    "'/evolution?limit=10'",
  ]) {
    assert.ok(CLIENT.includes(endpoint), `缺少请求路径 ${endpoint}`)
  }
})

test('记忆库表格由 overflowX:auto 容器包住', () => {
  const start = CLIENT.indexOf('function MemoryTable(props) {')
  assert.ok(start >= 0, '找不到 MemoryTable')
  const end = CLIENT.indexOf('function WriteForm(props) {', start)
  const body = CLIENT.slice(start, end)
  assert.match(body, /overflowX: 'auto'/, '记忆库表格缺少横向滚动容器')
  assert.ok(body.indexOf("overflowX: 'auto'") < body.indexOf("h('table'"), '滚动容器必须在表格外层')
})

test('设置控件带 aria-describedby 关联说明', () => {
  assert.match(CLIENT, /'aria-describedby': describedBy/, '输入控件缺少 aria-describedby')
  assert.match(CLIENT, /aria-describedby/, '设置组件缺少无障碍描述')
})

test('shadow 候选走服务端 action 过滤，并有空态卡', () => {
  assert.ok(CLIENT.includes("t('writes.pendingEmpty')"), '缺少“暂无待审”空态')
  assert.ok(CLIENT.includes("callJson(withIdentity('/writes?action=CANDIDATE&limit=100'))"), '候选未按要求查询')
  assert.ok(!CLIENT.includes("item.action === 'CANDIDATE'"), '仍在用前端过滤候选')
})

test('写入候选返回 id:null 时不显示“已写入：null”', () => {
  assert.ok(CLIENT.includes("result.candidate === true || result.id === null"), '未识别 candidate 响应')
  assert.ok(CLIENT.includes("t('memory.candidateQueued')"), '缺少待审队列提示文案')
})

test('保存配置后回读 /config，且失败带错误码', () => {
  assert.ok(CLIENT.includes("await callJson('/config')"), '保存后未回读配置')
  assert.ok(CLIENT.includes("t('settings.saveFailed') + ' [' + save.code"), '保存失败未显示错误码')
})

// ------------------------------------------------------- 概览观测块（§9.3）

const OBS_KEYS = [
  'overview.kpiZeroInjection', 'overview.kpiAdoption', 'overview.kpiJobSuccess', 'overview.kpiDbSize',
  'overview.targetMet', 'overview.targetMissed',
  'overview.trend', 'overview.trendEmpty', 'overview.trendInjected', 'overview.trendZeroHit',
  'overview.trendToday', 'overview.trendTip',
  'overview.failures', 'overview.failuresEmpty', 'overview.failureAttempts',
]

function overviewSource() {
  const start = CLIENT.indexOf('function Overview(props) {')
  const end = CLIENT.indexOf('// ----------------------------------------------------------------- memory', start)
  assert.ok(start >= 0, '找不到 Overview')
  assert.ok(end > start, '找不到 Overview 的结束边界')
  return CLIENT.slice(start, end)
}

/** client 的纯函数标记块：可脱离 React 执行，供降级断言使用。 */
function pureSource() {
  const start = CLIENT.indexOf('// >>> observability:pure')
  const end = CLIENT.indexOf('// <<< observability:pure', start)
  assert.ok(start >= 0, '缺少 observability:pure 起始标记')
  assert.ok(end > start, '缺少 observability:pure 结束标记')
  return CLIENT.slice(start, end)
}

function observabilityApi() {
  const localeTagSource = (/function localeTag\(active\) \{[\s\S]*?\n    \}/.exec(CLIENT) || [])[0]
  assert.ok(localeTagSource, '找不到 localeTag')
  const source = localeTagSource + '\n' + pureSource()
    + '\nreturn { fmtPercent, fmtBytes, trendPoints, failureRows, targetState, barPercent, dayKey }'
  return new Function(source)()
}

test('概览观测新增键在三语字典齐全且非空', () => {
  assert.equal(OBS_KEYS.length, 15, '新增键数量变了就要同步本断言与 locale')
  for (const lang of LANGS) {
    for (const key of OBS_KEYS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dicts[lang][key].trim().length > 0, `${lang} 的 ${key} 为空`)
    }
  }
})

test('概览渲染引用 metrics / series / recent_failures，并覆盖四个新指标', () => {
  const body = overviewSource()
  assert.match(body, /s\.metrics/, '概览未读取 stats.metrics')
  assert.match(body, /metrics\.values/, '概览未读取 metrics.values')
  assert.match(body, /metrics\.targets/, '概览未读取 metrics.targets')
  assert.match(body, /trendPoints\(s\.series/, '概览未读取 stats.series')
  assert.match(pureSource(), /recent_failures/, '纯函数区未读取 health.jobs.recent_failures')
  for (const name of ['zero_injection_rate', 'adoption_rate', 'job_success_7d', 'db_size_bytes']) {
    assert.ok(body.includes(name), `概览未渲染指标 ${name}`)
  }
  assert.ok(body.includes("t('overview.trend')"), '缺少 7 日曲线块')
  assert.ok(body.includes("t('overview.failures')"), '缺少最近失败块')
  assert.match(body, /css\.trendScroll/, '7 日曲线未走滚动容器')
  // R9-07：单纯 overflowX:auto 会隐式生成纵向滚动容器（Chromium 实测 sticky 失效），
  // 7 日曲线同样补 overflowY:clip，保持"整个面板只有一个纵向滚动根"。
  assert.match(CLIENT, /trendScroll: \{ overflowX: 'auto', overflowY: 'clip' \}/, '7 日曲线缺窄屏横向滚动或 overflowY:clip')
})

test('概览渲染引用的 overview.* 键三语都存在（防拼错）', () => {
  const used = new Set([...overviewSource().matchAll(/t\('(overview\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]))
  assert.ok(used.size >= 12, `概览只引用了 ${used.size} 个 overview 键，疑似渲染被删`)
  for (const key of used) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}（概览渲染引用）`)
    }
  }
})

test('缺失/null 指标降级为「—」，渲染不出 NaN/undefined', () => {
  const api = observabilityApi()

  // 数值降级
  assert.equal(api.fmtPercent(null, 'zh'), '—')
  assert.equal(api.fmtPercent(undefined, 'zh'), '—')
  assert.equal(api.fmtPercent('n/a', 'zh'), '—')
  assert.equal(api.fmtPercent(0.125, 'zh'), '12.5%')
  assert.equal(api.fmtPercent(42, 'zh'), '42%')
  assert.equal(api.fmtBytes(null), '—')
  assert.equal(api.fmtBytes(undefined), '—')
  assert.equal(api.fmtBytes('x'), '—')
  assert.equal(api.fmtBytes(0), '0 B')
  assert.equal(api.fmtBytes(1536), '1.5 KB')
  assert.equal(api.fmtBytes(3 * 1024 * 1024), '3 MB')
  assert.equal(api.barPercent(null), '0%')
  assert.equal(api.dayKey(new Date(2026, 10, 22, 9, 0, 0)), '2026-11-22')

  // 结构缺失：旧后端只有 totals 时也不能抛
  assert.deepEqual(api.trendPoints(undefined, '2026-11-22'), [])
  assert.deepEqual(api.trendPoints(null, '2026-11-22'), [])
  assert.deepEqual(api.failureRows(undefined, 5), [])
  assert.deepEqual(api.failureRows(null, 5), [])
  assert.deepEqual(api.failureRows({ recent_failures: 'nope' }, 5), [])
  assert.deepEqual(api.failureRows({ running: 0, queued: 0, failed: 0 }, 5), [])

  // 零命中/分母为 0 时不除零，今天标记落在最后一项
  const rows = api.trendPoints([
    { day: '2026-11-21', recalls: 0, withHits: 0, injected: null, adopted: null, zeroHit: null, avgChars: null },
    { day: '2026-11-22', recalls: 4, withHits: 3, injected: 2, adopted: 1, zeroHit: 1, avgChars: 120 },
  ], '2026-11-22')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].injectRatio, 0)
  assert.equal(rows[0].zeroRatio, 0)
  assert.equal(rows[0].isToday, false)
  assert.equal(rows[1].isToday, true)
  assert.equal(api.barPercent(rows[1].injectRatio), '67%')
  assert.equal(api.barPercent(rows[1].zeroRatio), '25%')
  const rendered = [
    api.fmtPercent(undefined, 'zh'), api.fmtBytes(undefined), api.barPercent(undefined),
    rows.map((row) => `${row.label} ${row.injectRatio} ${row.zeroRatio}`).join(' '),
  ].join(' ')
  assert.doesNotMatch(rendered, /NaN|undefined|Infinity/)

  // targets 缺失 = 不判断；有目标才给达标/未达标
  assert.equal(api.targetState('zero_injection_rate', null, 0.2), null)
  assert.equal(api.targetState('zero_injection_rate', 0.1, 0.2), 'met')
  assert.equal(api.targetState('zero_injection_rate', 0.3, 0.2), 'missed')
  assert.equal(api.targetState('adoption_rate', 0.5, 0.4), 'met')
  assert.equal(api.targetState('adoption_rate', 0.3, 0.4), 'missed')
  assert.equal(api.targetState('adoption_rate', 0.5, undefined), null)
  assert.equal(api.targetState('db_size_bytes', 1048576, 2097152), 'met')

  // 失败行：字段降级 + last_error 截断
  const fails = api.failureRows({
    running: 1,
    recent_failures: [
      { id: 7, kind: 'keeper', state: 'failed', attempts: 3, last_error: 'x'.repeat(300), updated_at: 1763800000000 },
      null,
    ],
  }, 5)
  assert.equal(fails.length, 1)
  assert.equal(fails[0].kind, 'keeper')
  assert.equal(fails[0].attempts, 3)
  assert.ok(fails[0].errorShort.length <= 120, 'last_error 未截断')
  assert.match(fails[0].errorShort, /…$/)
  assert.match(fails[0].key, /7/)
  const missing = api.failureRows({ recent_failures: [{ id: null, kind: null, state: null, attempts: null, last_error: null }] }, 5)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].kind, '—')
  assert.equal(missing[0].attempts, null)
  assert.equal(missing[0].errorShort, '')
})

// ------------------------------------------------------- 设置项元数据契约（§11.3）

const CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'src/host/config.js'), 'utf8')

/** 解析 config.js：组 → 字段 → { def 字面量, volatile }，外加顶层 dataDir。 */
function configSchema() {
  const out = {}
  const groupRe = /^  (\w+): z\.object\(\{([\s\S]*?)\n  \}\)\.default\(\{\}\),?$/gm
  let group
  while ((group = groupRe.exec(CONFIG_SRC))) {
    const fields = {}
    const fieldRe = /^    (\w+):.*?\.default\((.*?)\)(\.volatile\(\))?(?:,\s*\/\/.*)?,?$/gm
    let field
    while ((field = fieldRe.exec(group[2]))) {
      fields[field[1]] = { def: field[2], volatile: Boolean(field[3]) }
    }
    out[group[1]] = fields
  }
  const dataDir = /^  dataDir: .*?\.default\((.*?)\),?$/m.exec(CONFIG_SRC)
  assert.ok(dataDir, 'config.js 缺少 dataDir 默认值')
  out.dataDir = { def: dataDir[1], volatile: false }
  return out
}

function contractBlock(marker) {
  const start = CLIENT.indexOf(`// >>> ${marker}`)
  const end = CLIENT.indexOf(`// <<< ${marker}`, start)
  assert.ok(start >= 0, `缺少 ${marker} 起始标记`)
  assert.ok(end > start, `缺少 ${marker} 结束标记`)
  return CLIENT.slice(start, end)
}

function settingsMeta() {
  const source = contractBlock('settings:contract')
    .replace(/\/\/ >>> settings:contract[^\n]*/, '')
    .replace(/\/\/ <<< settings:contract[^\n]*/, '')
  return new Function(`${source}\nreturn SETTINGS_META`)()
}

// effect 的显式例外：都由消费方节奏决定，不是 schema volatile 能表达的。
const EFFECT_EXCEPTIONS = {
  'privacy.retentionDays': 'daily', // 每日 job 物理删除过期归档
  'panel.tab': 'instant', // 保存后 Panel 立即切换页签（onSaved）
}

test('设置项元数据单处定义：68 字段默认值对齐 config.js', () => {
  const meta = settingsMeta()
  const schema = configSchema()
  assert.equal(Object.keys(meta).length, 68, 'SETTINGS_META 字段数必须等于 Config 的 14 组 / 68 字段')
  for (const [key, item] of Object.entries(meta)) {
    const [group, field = null] = key.split('.')
    const raw = schema[group] ? (field === null ? schema[group].def : schema[group][field] && schema[group][field].def) : null
    assert.ok(raw !== null && raw !== undefined, `config.js 找不到 ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(item, 'def'), `${key} 缺少默认值`)
    assert.deepEqual(item.def, eval(`(${raw})`), `${key} 默认值与 config.js 不一致`)
    assert.ok(['instant', 'reload', 'daily'].includes(item.effect), `${key} effect 非法：${item.effect}`)
    assert.ok(['general', 'local', 'needsConfig'].includes(item.badge), `${key} badge 非法：${item.badge}`)
  }
})

test('生效徽标按 config.js 的 .volatile() 快照对齐（含 7 处纠错）', () => {
  const meta = settingsMeta()
  const schema = configSchema()
  for (const [key, item] of Object.entries(meta)) {
    const [group, field] = key.split('.')
    if (!schema[group] || !schema[group][field]) continue
    const expected = EFFECT_EXCEPTIONS[key] || (schema[group][field].volatile ? 'instant' : 'reload')
    assert.equal(item.effect, expected, `${key} 生效徽标应为 ${expected}`)
  }
  const corrected = {
    'write.model': 'reload',
    'reflect.enabled': 'reload',
    'consolidate.enabled': 'instant',
    'privacy.retentionDays': 'daily',
    'panel.allowRemote': 'instant',
    'panel.tab': 'instant',
    'advanced.worker': 'instant',
  }
  for (const [key, effect] of Object.entries(corrected)) {
    assert.equal(meta[key].effect, effect, `${key} 的 7 处纠错未落地`)
  }
})

test('依赖徽标结构化：embed/sync/url/model 均带原因且三语齐全（panel.* 是本地面板设置，不受 allowRemote 门控）', () => {
  const meta = settingsMeta()
  const deps = Object.entries(meta).filter(([, item]) => item.dependsOn)
  assert.ok(deps.length >= 5, '依赖徽标条目过少')
  const expected = {
    'backend.url': 'backend.mode',
    'write.model': 'write.judge',
    'embed.endpoint': 'embed.enabled',
    'embed.model': 'embed.enabled',
    'embed.batch': 'embed.enabled',
    'sync.mode': 'sync.enabled',
    'sync.bridgeUrl': 'sync.enabled',
    'sync.dryRun': 'sync.enabled',
  }
  // panel.pollMs/tab 只影响本机面板轮询与默认页签，allowRemote=false 时仍应可调；
  // 早先把它们挂在 allowRemote 下是错误依赖（会让默认配置下整组置灰），这里只断言不门控。
  assert.equal(meta['panel.pollMs'].dependsOn, undefined)
  assert.equal(meta['panel.tab'].dependsOn, undefined)
  for (const [key, dep] of Object.entries(expected)) {
    assert.ok(meta[key] && meta[key].dependsOn, `${key} 缺少 dependsOn`)
    assert.equal(`${meta[key].dependsOn.group}.${meta[key].dependsOn.key}`, dep, `${key} 依赖源错`)
    const reasonKey = meta[key].dependsOn.reasonKey
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][reasonKey], 'string', `${lang} 缺少依赖原因 ${reasonKey}`)
      assert.ok(dicts[lang][reasonKey].trim().length > 0, `${lang} 依赖原因为空`)
    }
  }
})

test('SwitchCard/FieldCard 渲染默认值、通用/本机/需配置徽标与依赖原因', () => {
  assert.match(CLIENT, /function SettingMetaLine\(props\)/, '缺少设置卡副行组件')
  for (const token of [
    "t('settings.defaultValue'", "t('settings.badgeGeneral')", "t('settings.badgeLocal')",
    "t('settings.badgeNeedsConfig')", "t('settings.depUnmet'", "t('settings.effectDaily')",
  ]) {
    assert.ok(CLIENT.includes(token), `缺少 ${token}`)
  }
  for (const marker of ['defaultValue', 'badge', 'depReason', 'dependsOn']) {
    assert.ok(CLIENT.includes(marker), `缺少 ${marker} 契约字段`)
  }
  assert.match(dicts.zh['settings.defaultValue'], /默认：\{value\}/, '默认值文案不是「默认：x」')
  assert.equal(dicts.zh['settings.badgeGeneral'], '通用')
  assert.equal(dicts.zh['settings.badgeLocal'], '本机')
  assert.equal(dicts.zh['settings.badgeNeedsConfig'], '需配置')
  assert.match(CLIENT, /depReasonOf\(meta\)/, '缺少依赖满足性判定')
  assert.match(CLIENT, /disabled: Boolean\(opt\.disabled\) \|\| meta\.disabled/, '依赖未满足时控件未置灰')
})

test('14 组顶部场景句三语齐全且不与标题重复', () => {
  for (const group of [
    'Backend', 'Identity', 'Recall', 'Write', 'Reflect', 'Wrap', 'Consolidate', 'Embed',
    'Privacy', 'Edges', 'Sync', 'Panel', 'Advanced', 'Danger',
  ]) {
    const descKey = `settings.group${group}Desc`
    for (const lang of LANGS) {
      const value = dicts[lang][descKey]
      assert.equal(typeof value, 'string', `${lang} 缺少 ${descKey}`)
      assert.ok(value.trim().length >= 10, `${lang} 的 ${descKey} 太短`)
      assert.notEqual(value, dicts[lang][`settings.group${group}`], `${lang} 的 ${descKey} 只是标题复述`)
    }
    assert.ok(CLIENT.includes(`t('${descKey}')`), `设置页未渲染 ${descKey}`)
  }
})

test('三个无控件字段补齐：backend.id / sync.bridgeUrl / sync.dryRun', () => {
  for (const [group, key] of [['backend', 'id'], ['sync', 'bridgeUrl'], ['sync', 'dryRun']]) {
    assert.ok(CLIENT.includes(`idOf('${group}', '${key}')`), `${group}.${key} 仍无控件`)
  }
  const start = CLIENT.indexOf('function normalizeConfig(config) {')
  const end = CLIENT.indexOf('function configIssue(draft) {', start)
  const body = CLIENT.slice(start, end)
  assert.match(body, /id: backend\.id/, 'normalizeConfig 未回读 backend.id')
  assert.match(body, /bridgeUrl: sync\.bridgeUrl/, 'normalizeConfig 未回读 sync.bridgeUrl')
  assert.match(body, /dryRun: sync\.dryRun !== false/, 'normalizeConfig 未回读 sync.dryRun')
})

// ------------------------------------------------------- 后端状态 / 首装 / 召回 / 写入

function backendStatusApi() {
  const source = contractBlock('backend-status:pure')
    .replace(/\/\/ >>> backend-status:pure[^\n]*/, '')
    .replace(/\/\/ <<< backend-status:pure[^\n]*/, '')
  return new Function(`${source}\nreturn backendStatusView`)()
}

test('页头/概览读 GET /version 显示后端/协议/outbox，失败降级为「—」', () => {
  assert.ok(CLIENT.includes("callJson('/version')"), '页头未读取 GET /version')
  // 身份徽标优先显示会话 workspace（runtimeIdentity），没有召回历史才回 Config。
  assert.match(CLIENT, /runtimeIdentity/, '页头未读取 /config.runtimeIdentity')
  assert.match(CLIENT, /runtime\.runtimeWorkspace/, '页头未优先使用会话 workspace')
  assert.ok(CLIENT.includes("t('header.backendStatus'"), '页头缺少后端状态文案')
  assert.match(CLIENT, /header\.backendStatusTip/, '缺少 /version 来源提示')
  assert.match(CLIENT, /fmtNum\(backendStatus\.outbox/, '页头未渲染 outbox 数量')

  const api = backendStatusApi()
  assert.deepEqual(api(undefined), { checked: true, mode: null, protocol: null, outbox: null })
  assert.deepEqual(api({ mode: 'http', protocol: { ok: false }, outbox: { queued: 3, running: 1 } }),
    { checked: true, mode: 'http', protocol: 'mismatch', outbox: 3 })
  assert.deepEqual(api({ backend: { mode: 'hybrid' }, protocolStatus: { ok: true }, outbox: { pending: 7 } }),
    { checked: true, mode: 'hybrid', protocol: 'ok', outbox: 7 })
  assert.deepEqual(api({ protocol: 'whale-memory/1', expected: 'whale-memory/1', outbox: 2 }),
    { checked: true, mode: null, protocol: 'ok', outbox: 2 })
  assert.equal(api({ protocol: 'x', expected: 'whale-memory/1' }).protocol, 'mismatch')

  const overview = overviewSource()
  assert.match(overview, /callJson\('\/stats'\)/, '概览未读 /stats')
  assert.match(overview, /body\.migration/, '概览未读 stats.migration')
  assert.match(overview, /body\.identity/, '概览未读 stats.identity')
  assert.ok(overview.includes("t('overview.migrationPending')"), '缺少迁移待确认卡')
  assert.ok(overview.includes("onOpenSettings"), '迁移卡没有跳设置页入口')
  assert.match(overview, /t\('health\.backend'\)/, '概览健康区未显示后端模式')
  assert.match(overview, /t\('health\.protocol'\)/, '概览健康区未显示协议状态')
  assert.match(overview, /t\('health\.outbox'\)/, '概览健康区未显示 outbox')
  assert.match(CLIENT, /roleId: String\(\(runtime\.roleId !== undefined/, '身份徽标未接 roleId（优先 runtime，回退 Config）')
  for (const key of ['header.backendStatus', 'header.protocolOk', 'header.protocolMismatch', 'overview.migrationPending']) {
    for (const lang of LANGS) assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
  }
})

test('首装空态：试用样例 3 条可一键清理；后端未配置一键切 local', () => {
  const memoryStart = CLIENT.indexOf('function MemoryTab(props) {')
  const memoryEnd = CLIENT.indexOf('function MemoryTable(props) {', memoryStart)
  const memory = CLIENT.slice(memoryStart, memoryEnd)
  assert.ok(memory.includes("t('memory.sample1')"), '样例未使用三语文案')
  assert.ok(memory.includes("t('memory.sampleCleanup')"), '缺少一键清理入口')
  assert.ok(memory.includes("t('memory.sampleCleanupConfirm')"), '清理缺少二次确认')
  assert.match(memory, /PATCH/, '清理未走 PATCH 归档')
  assert.match(memory, /SAMPLE_TAG/, '样例未带可识别标记')
  assert.ok(CLIENT.includes("const SAMPLE_TAG = 'whale-memory-sample'"), '缺少样例标记常量')

  const overview = overviewSource()
  assert.ok(overview.includes("t('overview.offlineBackendTitle')"), '缺少“未连接外部服务”卡')
  assert.ok(overview.includes("t('overview.switchLocal')"), '缺少“改用本地库”按钮')
  assert.match(CLIENT, /backend: \{ mode: 'local' \}/, '一键切 local 未提交 backend.mode 叶子')
  for (const key of ['memory.sampleTitle', 'memory.sampleDesc', 'memory.sampleWrite', 'memory.sampleCleanup',
    'memory.sample1', 'memory.sample2', 'memory.sample3', 'overview.offlineBackendTitle', 'overview.switchLocal']) {
    for (const lang of LANGS) assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
  }
})

test('召回页：预算回显 + /recalls 服务端过滤 + 最近召回 source 列', () => {
  const start = CLIENT.indexOf('function RecallTab(props) {')
  const end = CLIENT.indexOf('// ----------------------------------------------------------------- writes', start)
  const body = CLIENT.slice(start, end)
  assert.ok(body.includes("t('recall.budgetLine'"), '缺少预算回显')
  assert.match(body, /recallCfg\.charBudget/, '预算未回显 charBudget')
  assert.match(body, /recallCfg\.maxHits/, '预算未回显 maxHits')
  assert.match(body, /recallCfg\.intentBudget/, '预算未回显意图档')
  assert.match(body, /filter=/, '/recalls 未传 filter')
  assert.match(body, /'unused'/, '缺少未采纳过滤')
  assert.match(body, /'zero'/, '缺少零命中过滤')
  assert.ok(body.includes("t('recall.colSource'"), '最近召回缺 source 列')
  for (const key of ['recall.budgetTitle', 'recall.budgetLine', 'recall.filterUnused', 'recall.filterZero', 'recall.colSource']) {
    for (const lang of LANGS) assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
  }
})

test('写入页：shadow 拒绝理由/改写、决策 action 本地化、演化 old/new', () => {
  const start = CLIENT.indexOf('function WritesTab(props) {')
  const end = CLIENT.indexOf('// --------------------------------------------------------------- settings', start)
  const body = CLIENT.slice(start, end)
  assert.ok(body.includes("t('writes.rejectReason')"), '缺少拒绝理由输入')
  assert.ok(body.includes("t('writes.rewrite')"), '缺少改写正文输入')
  assert.match(body, /reason: String\(review\.reason/, '审核请求未带 reason')
  assert.match(body, /patch: \{ text: rewritten \}/, '接受后改写未落地')
  assert.match(body, /actionLabel\(t, item && item\.action\)/, '决策 action 未本地化')
  assert.match(body, /item\.old_value/, '演化卡未显示 old_value')
  assert.match(body, /item\.new_value/, '演化卡未显示 new_value')
  const actions = { ADD: 'writes.actionAdd', NOOP: 'writes.actionNoop', MERGE: 'writes.actionMerge', SUPERSEDE: 'writes.actionSupersede', REJECT: 'writes.actionReject' }
  for (const [action, key] of Object.entries(actions)) {
    assert.ok(CLIENT.includes(`    ${action}: '${key}'`), `action ${action} 未映射 ${key}`)
    for (const lang of LANGS) assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
  }
})

test('设置页注册 settings.section「记忆中枢」，只复用 SettingsTab', () => {
  assert.ok(CLIENT.includes("'settings.section'"), '未注册 settings.section')
  assert.match(CLIENT, /name: 'settings\.section'/, 'settings.section 注册名不正确')
  assert.match(CLIENT, /id: PANEL_ID/, 'settings.section 未复用 PANEL_ID')
  assert.match(CLIENT, /h\(SettingsTab, \{ t: ownerProps\.t \|\| t \}\)/, 'settings.section 未复用 SettingsTab')
  for (const lang of LANGS) assert.equal(typeof dicts[lang]['settings.sectionLabel'], 'string', `${lang} 缺少 settings.sectionLabel`)
})

test('charBudget=0 文案明确“关闭注入”，保存 0 时二次确认', () => {
  for (const lang of LANGS) {
    const text = dicts[lang]['settings.charBudgetDesc']
    assert.ok(text.includes('0'), `${lang} charBudgetDesc 未提 0`)
    assert.ok(/关闭注入|injection off|注入オフ/.test(text), `${lang} charBudgetDesc 未说明 0=关闭注入`)
  }
  assert.ok(CLIENT.includes("t('settings.charBudgetZeroConfirm')"), '保存 0 缺二次确认文案')
  assert.match(CLIENT, /charBudget\) === 0/, '保存 0 未识别')
  assert.match(CLIENT, /askConfirm\(t\('settings\.charBudgetZeroConfirm'\)\)/, '保存 0 未二次确认')
})

test('记忆库归档/编辑二次确认；详情抽屉补证据(origin)与 1 跳邻居边', () => {
  const start = CLIENT.indexOf('function DetailDrawer(props) {')
  const end = CLIENT.indexOf('function Row(props) {', start)
  const body = CLIENT.slice(start, end)
  assert.match(body, /askConfirm\(t\('detail\.saveConfirm'\)\)/, '编辑缺二次确认')
  assert.match(body, /askConfirm\(t\('detail\.archiveConfirm'\)\)/, '归档缺二次确认')
  assert.ok(body.includes("t('detail.origin')"), '详情缺证据(origin)块')
  assert.ok(body.includes("t('detail.edges')"), '详情缺邻居边块')
  assert.ok(body.includes("t('detail.edgesUnavailable')"), '详情缺 edges 未提供降级')
  assert.match(body, /body\.edges/, '/nodes/:id 返回 edges 时未使用')
  for (const key of ['detail.archiveConfirm', 'detail.saveConfirm', 'detail.origin', 'detail.originUnavailable',
    'detail.edges', 'detail.edgesUnavailable']) {
    for (const lang of LANGS) assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}`)
  }
})

test('设置页引用的 settings.* 键三语齐全（防拼错）', () => {
  const start = CLIENT.indexOf('// >>> settings:contract')
  const end = CLIENT.indexOf('// ------------------------------------------------------------------- css', start)
  const body = CLIENT.slice(start, end)
  const used = new Set([...body.matchAll(/t\('(settings\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]))
  assert.ok(used.size >= 40, `设置页只引用 ${used.size} 个 settings 键`)
  for (const key of used) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][key], 'string', `${lang} 缺少 ${key}（设置页渲染引用）`)
    }
  }
})

test('手动同步方向跟随 sync.mode（off 时按钮仍双向，不误当禁用手动）', () => {
  assert.match(CLIENT, /setSyncDir\(modeDir === 'push' \|\| modeDir === 'pull' \|\| modeDir === 'both' \? modeDir : 'both'\)/, '未从 /config.sync.mode 初始化同步方向')
  assert.match(CLIENT, /direction: syncDir, dryRun: true/, '预演未使用 syncDir')
  assert.match(CLIENT, /direction: syncDir, dryRun: false, confirm: true/, '实跑未使用 syncDir')
})

test('R9-07 收尾：记忆详情错误态可重试；设置页有配置层键 Note', () => {
  // 错误态必须带 onRetry，且重载由 reloadTick 驱动（id 变化仍会重置）。
  assert.match(CLIENT, /onRetry: \(\) => setReloadTick\(\(n\) => n \+ 1\)/, '详情错误态缺重试按钮')
  assert.ok(CLIENT.includes('}, [id, reloadTick])'), '详情重载 effect 未随 reloadTick 重跑')
  // 配置层键 Note：三语都有，且在规则分组里渲染。
  for (const lang of LANGS) assert.ok(String(dicts[lang]['settings.rulesConfigLayerNote'] || '').trim(), `${lang} 缺配置层键说明`)
  assert.ok(CLIENT.includes("t('settings.rulesConfigLayerNote')"), '设置页未渲染配置层键 Note')
  for (const key of ['rules.renderAgents', 'rules.injectChars', 'rules.createAgentsIfMissing']) {
    assert.ok(String(dicts.zh['settings.rulesConfigLayerNote']).includes(key), `Note 未点名 ${key}`)
  }
})

test('R10：设置只提交脏叶子；提案 apply/reject 用同步 ref 闸防双击', () => {
  // 只提交与基线不同的叶子：避免一次保存把全部默认值钉进 profile patch。
  assert.match(CLIENT, /const serverRef = useRef\(null\)/)
  assert.match(CLIENT, /const changed = diffConfig\(serverRef\.current, payload\)/)
  assert.match(CLIENT, /JSON\.stringify\(\{ config: changed \}\)/)
  assert.match(CLIENT, /Object\.keys\(changed\)\.length === 0/)
  // 同步闸：busy 是 state，重渲染前连点两次会穿透。
  assert.match(CLIENT, /const busyRef = useRef\(''\)/)
  assert.match(CLIENT, /busyRef\.current = 'apply'/)
  assert.match(CLIENT, /busyRef\.current = 'reject'/)
  assert.match(CLIENT, /busyRef\.current = ''/)
  // 详情 PATCH 回传版本，Host 才能做 CAS（否则 node_changed 是死码）。
  assert.match(CLIENT, /expectedUpdatedAt: loaded\.status === 'ok'/)
})

test('WP1 首启推荐：只在全默认配置出现，应用只提交差异，同步以 dry-run 起步', () => {
  assert.ok(CLIENT.includes('function configIsDefaults(cfg)'), '缺少首启默认值判定')
  assert.match(CLIENT, /key === 'sync\.bridgeUrl' \|\| key === 'panel\.tab'/, '桥地址/上次页签不应算作用户改动')
  assert.match(CLIENT, /const current = field === undefined \? cfg\[group\]/, 'dataDir 顶层键必须参与首启判定（否则推荐卡永不出现）')
  assert.match(CLIENT, /const firstRunSeenRef = useRef\(readFirstRunSeen\(\)\)/, '缺少首启已读标记')
  assert.match(CLIENT, /if \(load\.status !== 'ok' \|\| firstRunSeenRef\.current\) return/, '已处理过仍会弹')
  assert.match(CLIENT, /if \(!configIsDefaults\(serverRef\.current\)\) return/, '已有配置也会弹 / 会覆盖')
  assert.match(CLIENT, /next\.sync = \{ \.\.\.draft\.sync, enabled: true, mode: 'both', dryRun: true \}/,
    '同步推荐未以 dry-run 起步（会直接改远端）')
  assert.match(CLIENT, /const okSaved = await persist\(next\)/, '向导未走差异提交路径')
  assert.match(CLIENT, /if \(okSaved\) markFirstRunSeen\(\)/, '保存后未记首启已处理')
  for (const key of ['settings.firstRunTitle', 'settings.firstRunDesc', 'settings.firstRunApply',
    'settings.firstRunLater', 'settings.firstRunReflectNote',
    'settings.firstRunSyncNote', 'settings.firstRunSyncUnset', 'settings.recommend']) {
    for (const lang of LANGS) assert.ok(String(dicts[lang][key] || '').trim(), `${lang} 缺少 ${key}`)
  }
})

test('WP1 推荐开启徽标：四个需外部条件的开关带 recommend，badge 枚举不被污染', () => {
  const meta = settingsMeta()
  for (const key of ['reflect.enabled', 'sync.enabled', 'write.searchFeed']) {
    assert.equal(meta[key].recommend, true, `${key} 缺推荐标记`)
  }
  const rules = new Function(`${contractBlock('rules-settings:contract')
    .replace(/\/\/ >>> rules-settings:contract[^\n]*/, '')
    .replace(/\/\/ <<< rules-settings:contract[^\n]*/, '')}\nreturn RULES_SETTINGS_META`)()
  assert.equal(rules['rules.llm'].recommend, true, 'rules.llm 缺推荐标记')
  for (const [key, item] of Object.entries(meta)) {
    assert.ok(['general', 'local', 'needsConfig'].includes(item.badge), `${key} badge 枚举被污染`)
  }
  assert.ok(CLIENT.includes("recommend: meta && meta.recommend ? t('settings.recommend') : undefined"), '推荐标记未进卡片元数据')
  assert.match(CLIENT, /recommendChip/, '缺少推荐徽标样式')
  assert.match(CLIENT, /recommend: !checked \? meta\.recommend : undefined/, '已开启的开关仍挂「推荐开启」')
})

test('WP2 设置信息架构：顺序固定、首屏四组展开、其余默认收起、布局根因修复', () => {
  assert.match(CLIENT, /const SETTINGS_GROUP_ORDER = Object\.freeze\(\[\s*'recall', 'write', 'identity', 'rules', 'backend', 'sync',\s*'reflect', 'wrap', 'consolidate', 'privacy', 'edges', 'panel', 'advanced', 'embed',\s*\]\)/)
  assert.match(CLIENT, /SETTINGS_GROUP_ORDER\.map\(\(key\) => \(groupNodes\[key\]/, '未按顺序渲染分组')
  assert.match(CLIENT, /h\(React\.Fragment, \{ key \}, groupNodes\[key\]\(\)\)/, '分组列表缺稳定 key')
  // 折叠卡自己取文案：调用方必须注入 t，否则首渲染就 ReferenceError。
  assert.equal((CLIENT.match(/t, titleKey: 'settings\.group/g) || []).length, 15, '14 个网格分组 + 危险区都必须注入 t')
  assert.match(CLIENT, /t, titleKey: 'settings\.groupRecall'/)
  assert.match(CLIENT, /SETTINGS_CORE_GROUP_KEYS = new Set\(\[\s*'settings\.groupRecall', 'settings\.groupWrite', 'settings\.groupIdentity', 'settings\.groupRules',\s*\]\)/)
  assert.match(CLIENT, /function readGroupOpen\(/, '缺展开状态读取')
  assert.match(CLIENT, /function writeGroupOpen\(/, '缺展开状态持久化')
  assert.match(CLIENT, /titleKey === 'settings\.groupDanger'/, '危险区未强制展开')
  // 危险区调用必须也传 titleKey/t：只传 title 会让 alwaysOpen 判定失败并调用未注入的 t（R11 白屏根因）。
  assert.match(CLIENT, /t, titleKey: 'settings\.groupDanger'/, '危险区分组卡缺 titleKey/t')
  // 布局根因：input 不再继承 flex-basis；grid 不再 stretch。
  assert.match(CLIENT, /fieldInput: \{\s*flex: '0 0 auto', width: '100%'/, 'input 仍会被 column flex-basis 拉高')
  assert.match(CLIENT, /groupGrid: \{\s*display: 'grid', gridTemplateColumns: 'repeat\(auto-fit, minmax\(260px, 1fr\)\)',\s*gap: '10px', alignItems: 'start',/, 'grid 仍会拉伸空卡')
  assert.match(CLIENT, /settingCard: \{[\s\S]{0,220}?alignSelf: 'start'/, '设置卡未禁止拉伸')
  assert.match(CLIENT, /numberInput: \{[^}]*maxWidth: '180px'/, '数值输入未限宽')
  assert.ok(CLIENT.includes("'aria-controls': 'settings-group-' + titleKey + '-body'"), '折叠卡缺 aria-controls 关联')
  assert.ok(CLIENT.includes("id: alwaysOpen ? undefined : 'settings-group-' + titleKey + '-body'"), '折叠卡内容区缺 id 关联')
})

test('WP3 说明书：MD 真源生成块一致、页头按钮与抽屉键盘契约、术语表入口', () => {
  assert.ok(CLIENT.includes('// >>> manual:generated'), '缺少说明书生成块')
  const start = CLIENT.indexOf('// >>> manual:generated')
  const end = CLIENT.indexOf('// <<< manual:generated', start)
  assert.ok(end > start, '说明书生成块标记不完整')
  const block = CLIENT.slice(start, end)
  const jsonText = block.slice(block.indexOf('const MANUAL_DOC = ') + 'const MANUAL_DOC = '.length).trim()
  const docs = JSON.parse(jsonText)
  assert.ok(String(docs.zh || '').split('\n').length >= 100, '中文说明书内容过少')
  assert.ok(String(docs.zh).includes('## 5. 术语表'), '说明书缺少术语表')
  assert.ok(String(docs.zh).includes('## 6. FAQ'), '说明书缺少 FAQ')
  assert.ok(CLIENT.includes('function ManualDrawer'), '缺少说明书抽屉')
  assert.ok(CLIENT.includes('function MiniMarkdown'), '缺少离线 Markdown 渲染')
  assert.match(CLIENT, /onClick: \(\) => setManualOpen\(true\)/, '页头没有说明书按钮')
  assert.match(CLIENT, /e\.key === 'Escape'/, '说明书抽屉缺 Esc 关闭')
  assert.match(CLIENT, /onOpenManual: \(\) => setManualOpen\(true\)/, '设置页未接说明书入口')
  for (const key of ['manual.button', 'manual.title', 'manual.close', 'manual.zhOnly']) {
    for (const lang of LANGS) assert.ok(String(dicts[lang][key] || '').trim(), `${lang} 缺少 ${key}`)
  }
})
