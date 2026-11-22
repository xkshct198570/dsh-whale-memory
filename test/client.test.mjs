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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

test('设置页至少 6 个分组标题键，且现有 13 组齐全', () => {
  const groups = Object.keys(dicts.zh).filter((key) => key.startsWith('settings.group'))
  assert.ok(groups.length >= 6, `设置分组只有 ${groups.length} 个`)
  for (const group of [
    'settings.groupBackend', 'settings.groupIdentity', 'settings.groupRecall', 'settings.groupWrite',
    'settings.groupReflect', 'settings.groupConsolidate', 'settings.groupEmbed', 'settings.groupPrivacy',
    'settings.groupEdges', 'settings.groupSync', 'settings.groupPanel', 'settings.groupAdvanced',
    'settings.groupDanger',
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
  const json = JSON.stringify(dicts, null, 2).replace(/\n/g, '\n    ')
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
  assert.ok(CLIENT.includes("callJson('/writes?action=CANDIDATE&limit=100')"), '候选未按要求查询')
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
  assert.match(CLIENT, /trendScroll: \{ overflowX: 'auto' \}/, '7 日曲线缺少窄屏横向滚动样式')
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
