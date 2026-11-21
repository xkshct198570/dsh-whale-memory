/**
 * 面板契约测试（只读源码/JSON，零依赖、零网络）。
 *
 * 这些断言锁住 i18n 单一真源、五页签、设置分组、可解释召回、候选审核与窄屏表格；
 * 不启动插件、不连后端。
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
