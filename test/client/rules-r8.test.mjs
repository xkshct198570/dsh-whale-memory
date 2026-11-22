/**
 * R8-09 客户端契约：needs_manual 可见/可改写、默认与已停用徽标、全停用空态、
 * 详情错误重试、长列表纵向滚动、versions 接进详情历史、恢复默认按钮按能力隐藏，
 * 以及 21 个规则错误码的三语文案。
 *
 * 零依赖/零网络/无 DOM：纯函数从 client `rules:pure` 标记块抽取执行，UI 用源码断言。
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
const dicts = Object.fromEntries(LANGS.map((lang) => [
  lang, flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', `${lang}.json`), 'utf8'))),
]))

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
return {
  ruleIsDefault, ruleIsRetired, rulesAllRetired, mergeRuleVersions,
  proposalStatusOf, proposalNeedsManualOf, proposalGuardOf, ruleFieldText,
}`)()
}

const viewSource = () => sliceFrom('function RulesView(props) {', 'function RulesGitBar(props) {')
const tableSource = () => sliceFrom('function RulesTable(props) {', 'function RulesTypeBadge(props) {')
const itemSource = () => sliceFrom('function RulesProposalItem(props) {', 'function RulesProposalsCard(props) {')
const drawerSource = () => sliceFrom('function RuleDrawer(props) {', '// ----------------------------------------------------------------- recall')
const badgeBlock = () => sliceFrom('function RulesDefaultBadge(props) {', 'function RulesStatusBadge(props) {')

test('needs_manual 候选：双状态拉取、失败码/失败项可见、按钮改「改写后重试」', () => {
  assert.ok(CLIENT.includes("callJson('/rules/proposals?status=pending,needs_manual')"), '必须同时拉 pending 与 needs_manual')
  const api = rulesApi()
  const manual = {
    id: 'p1234567890123_abcd1234',
    status: 'needs_manual',
    needsManual: { code: 'rule_guard_failed', failures: [{ code: 'modality_lost', key: 'rule-1' }], detail: '旧模态丢失' },
    guard: { ok: false, failures: [{ code: 'modality_lost', key: 'rule-1', detail: '旧模态丢失' }] },
  }
  const info = api.proposalNeedsManualOf(manual)
  assert.equal(info.code, 'rule_guard_failed')
  assert.equal(info.failures.length, 1, 'needs_manual 必须带失败项')
  assert.equal(info.detail, '旧模态丢失')
  assert.equal(api.proposalNeedsManualOf({ status: 'pending' }), null, 'pending 不应显示 needs_manual 提示')
  const item = itemSource()
  assert.ok(item.includes("t('rules.proposalNeedsManual')"), '候选卡缺 needs_manual 说明')
  assert.ok(item.includes("t('rules.proposalNeedsManualCode'"), '候选卡缺失败码展示')
  assert.ok(item.includes("needsManual ? t('rules.proposalRewriteRetry')"), 'needs_manual 按钮未改为「改写后重试」')
  assert.ok(item.includes('proposalNeedsManualOf(item)'), '候选卡未接 needs_manual 归一')
  // 改写重试仍然提交同一 id + decisions.text（不新建候选）。
  assert.ok(item.includes("callJson('/rules/apply'"), '改写重试未走 apply')
})

test('默认/已停用徽标：ruleIsDefault / ruleIsRetired 纯函数 + 列表双徽标', () => {
  const api = rulesApi()
  assert.equal(api.ruleIsDefault({ origin: 'default:iron-rule-1' }), true)
  assert.equal(api.ruleIsDefault({ origin: 'manual:u1' }), false)
  assert.equal(api.ruleIsDefault({}), false, '缺 origin 不得误标默认')
  assert.equal(api.ruleIsRetired({ status: 'retired' }), true)
  assert.equal(api.ruleIsRetired({ status: 'active' }), false)
  assert.equal(api.ruleIsRetired(null), false)
  const table = tableSource()
  assert.ok(table.includes('ruleIsDefault(rule) ? h(RulesDefaultBadge'), '列表缺默认徽标')
  assert.ok(table.includes('ruleIsRetired(rule) ? h(RulesRetiredBadge'), '列表缺已停用徽标')
  const badges = badgeBlock()
  assert.ok(badges.includes("t('rules.defaultBadge')"), '默认徽标缺文案')
  assert.ok(badges.includes("t('rules.retiredBadge')"), '已停用徽标缺文案')
  // GET /rules 的 origin 必须进列表状态，徽标才有判据。
  assert.ok(viewSource().includes("capabilities: body && body.capabilities"), '列表未保存能力探测')
})

test('全部停用空态：筛选=全部时给提示与「查看已退役」入口，旧文案保留', () => {
  const api = rulesApi()
  assert.equal(api.rulesAllRetired([{ status: 'retired' }, { status: 'retired' }]), true)
  assert.equal(api.rulesAllRetired([{ status: 'retired' }, { status: 'active' }]), false)
  const view = viewSource()
  assert.ok(view.includes("rulesAllRetired(rules) && filter === 'all'"), '全停用空态未按筛选=全部生效')
  assert.ok(view.includes("t('rules.emptyRetiredAction')"), '空态缺「查看已退役」入口')
  assert.ok(view.includes("setFilter('retired')"), '入口未切到已退役筛选')
  assert.ok(view.includes("rulesAllRetired(rules) ? 'rules.emptyNoActive' : 'rules.tableEmpty'"), '全停用/筛选无命中文案分支被删')
  for (const lang of LANGS) {
    assert.ok(String(dicts[lang]['rules.emptyRetiredAction'] || '').trim(), `${lang} 缺 emptyRetiredAction`)
  }
})

test('详情：错误态可重试 + versions 合并进历史 + git 提交 subject 展示', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("h(StateBlock, { t, status: 'error', err: loaded.err, onRetry:"), '详情错误态缺重试')
  assert.ok(drawer.includes('setRetryTick((v) => v + 1)'), '重试未触发重载')
  assert.ok(drawer.includes("callJson('/rules/versions?key='"), '详情未拉 /rules/versions')
  assert.ok(drawer.includes('mergeRuleVersions(history, versions)'), 'versions 未合并进详情历史')
  assert.ok(drawer.includes('css.rulesHistorySubject'), 'git 提交 subject 未展示')
  // 合并纯函数：versions 为骨架，detail 补正文，按 rev 去重，current 占位不进历史。
  const api = rulesApi()
  const merged = api.mergeRuleVersions(
    [
      { rev: 'snap-1', version: 1, ts: 1, source: 'snapshot', text: '旧正文' },
      { rev: 'snap-2', version: 2, ts: 2, source: 'snapshot', text: '新正文' },
    ],
    [
      { kind: 'current', rev: '', version: 2, source: 'file' },
      { kind: 'history', rev: 'snap-2', version: 2, ts: 2, source: 'snapshot' },
      { kind: 'git', rev: 'abc123', version: 3, ts: 3, source: 'git', commit: 'abc123', subject: 'rule: update rule-1 v3' },
    ],
  )
  assert.deepEqual(merged.map((row) => row.rev), ['snap-2', 'abc123', 'snap-1'], '未按 versions 顺序去重合并')
  const git = merged.find((row) => row.rev === 'abc123')
  assert.equal(git.subject, 'rule: update rule-1 v3')
  assert.equal(git.commit, 'abc123')
  assert.equal(merged.find((row) => row.rev === 'snap-2').text, '新正文', 'detail 正文未补进 versions 条目')
  assert.equal(merged.some((row) => row.rev === ''), false, 'current 占位不得进历史列表')
  assert.deepEqual(api.mergeRuleVersions([], []), [])
})

test('长列表 overflow:auto 双轴滚动；窄屏横向滚动容器保留', () => {
  const table = tableSource()
  assert.match(table, /overflowY: 'auto'/, '长列表缺纵向滚动')
  assert.match(table, /overflowX: 'auto'/, '窄屏横向滚动被删')
  assert.match(table, /maxHeight: '70vh'/, '缺高度上限，长列表会撑满页面')
  assert.ok(table.indexOf("overflowX: 'auto'") < table.indexOf("h('table'"), '滚动容器必须在表格外层')
})

test('恢复默认按钮：后端无能力时隐藏，只对默认铁律出现，二次确认后 POST', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("ruleIsDefault(rule) && capabilities && capabilities.restoreDefault === true"),
    '恢复默认按钮未按能力+默认铁律双闸门')
  assert.ok(drawer.includes("callJson('/rules/restore-default'"), '恢复默认未接 POST 接口')
  assert.ok(drawer.includes("t('rules.restoreDefaultConfirm')"), '恢复默认缺二次确认')
  assert.ok(drawer.includes("t('rules.restoreDefaultDone')"), '恢复默认缺成功提示')
  // 无 capabilities 的旧服务端：按钮整块不渲染（不是禁用）。
  assert.ok(drawer.includes('? h(\'button\', {\n                style: restoreBusy'), '按钮结构缺失')
  for (const lang of LANGS) {
    for (const key of ['rules.restoreDefault', 'rules.restoreDefaultConfirm', 'rules.restoreDefaultDone']) {
      assert.ok(String(dicts[lang][key] || '').trim(), `${lang} 缺 ${key}`)
    }
  }
})

test('彻底删除强确认不回归：四要素仍在，仍走 mode=purge', () => {
  const drawer = drawerSource()
  assert.ok(drawer.includes("t('rules.purgeConfirm')"), 'purge 强确认被删')
  assert.ok(drawer.includes("mode: 'purge'"), 'purge 未走 mode=purge')
  const zh = dicts.zh['rules.purgeConfirm']
  for (const token of ['物理删除', '不可撤销', '编号', '永不复用', '历史快照']) {
    assert.ok(zh.includes(token), `purge 确认缺「${token}」`)
  }
})

test('21 个规则错误码三语文案齐全（不落到「未知错误」）', () => {
  const codes = [
    'proposal_not_found', 'proposal_not_pending', 'rule_locked', 'diff_too_large', 'needs_manual',
    'llm_unavailable', 'llm_unparseable', 'llm_error', 'commit_failed', 'write_failed',
    'affected_write_failed', 'invalid_json', 'invalid_key', 'invalid_mode', 'invalid_rev',
    'empty_text', 'ensure_failed', 'proposal_corrupt', 'plan_unavailable', 'restore_unavailable',
    'cross_origin_denied',
  ]
  assert.equal(codes.length, 21)
  for (const code of codes) {
    for (const lang of LANGS) {
      assert.equal(typeof dicts[lang][`err.${code}`], 'string', `${lang} 缺 err.${code}`)
      assert.ok(dicts[lang][`err.${code}`].trim().length > 0, `${lang} 的 err.${code} 为空`)
    }
    assert.notEqual(dicts.zh[`err.${code}`], dicts.zh['err.unknown'], `${code} 落在未知错误文案`)
  }
  // 写闸门自己的 415 文案也要有。
  assert.ok(dicts.zh['err.unsupported_media_type'].includes('application/json'))
  // R8-03 计划 CAS / 墓碑 / 冲突码：面板必须能说人话，不能落「未知错误」。
  for (const code of ['plan_hash_mismatch', 'plan_stale', 'number_retired', 'target_conflict',
    'target_missing', 'affected_missing', 'number_exhausted', 'lock_failed', 'txn_failed']) {
    for (const lang of LANGS) {
      assert.ok(String(dicts[lang][`err.${code}`] || '').trim(), `${lang} 缺 err.${code}`)
    }
  }
})

test('apply 前先取 /rules/plan：带 planHash，plan 失败只展示不写盘，501 降级', () => {
  const item = itemSource()
  const planAt = item.indexOf("callJson('/rules/plan'")
  const applyAt = item.indexOf("callJson('/rules/apply'")
  assert.ok(planAt >= 0, 'apply 前未调 /rules/plan')
  assert.ok(applyAt > planAt, '必须先 plan 再 apply')
  assert.ok(item.includes('applyBody.planHash = planned.planHash'), 'apply 未带 planHash')
  assert.ok(item.includes("code === 'plan_unavailable'") && item.includes('failure.status === 501'),
    '501 未降级为不带 planHash')
  assert.ok(item.includes("setErr({ code: planned.code, failures: planned.failures, plan: true })"),
    'plan 失败未展示失败项')
  assert.ok(item.includes('if (!planned.ok)') && item.includes('return'), 'plan 失败未在写盘前返回')
  assert.ok(item.indexOf('if (!planned.ok)') < item.indexOf('applyBody.planHash'), '失败返回必须在 apply 请求之前')
})

test('编号顺延提示：apply 回 numberAdjusted 时顶部可见 from→to', () => {
  const item = itemSource()
  assert.ok(item.includes('applied.numberAdjusted'), 'apply 结果未读 numberAdjusted')
  assert.ok(item.includes("numberAdjusted: adjusted"), 'numberAdjusted 未交给父级事件')
  const view = viewSource()
  assert.ok(view.includes('op.numberAdjusted'), '顶部提示未保存 numberAdjusted')
  assert.ok(view.includes("t('rules.proposalNumberAdjusted'"), '缺「编号已顺延」文案')
  assert.ok(view.includes('NumberAdjusted.from') || view.includes('numberAdjusted.from'), '提示未展示原编号')
  for (const lang of LANGS) {
    const text = String(dicts[lang]['rules.proposalNumberAdjusted'] || '')
    assert.ok(text.includes('{from}') && text.includes('{to}'), `${lang} 顺延文案缺占位符`)
  }
})
