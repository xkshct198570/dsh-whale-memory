/**
 * [SHELVED 封存] 语义召回（embed）面板隐藏：设置页不渲染该组、概览不显示「待处理」健康位。
 *
 * 为什么必须锁：封存口径是「代码保留、面板隐藏、零运行时成本」；一旦有人把 embed 加回组顺序
 * 或恢复 /stats.vector_pending，就会重新出现一个「能开但什么都不发生」的假开关（审查 P1-09）。
 * 恢复语义召回时按延后文档 §1.1 全量接线，并同步改写本用例（不是删掉它）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadSlots, treeText, findNode } from './render-harness.mjs'

const props = { t: (key) => key, locale: 'zh' }

test('[SHELVED] 设置页不渲染 embed 组：无组标题、无开关、无 endpoint/batch 卡', async () => {
  const { slots, mount } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupAdvanced': true } },
  )
  const tree = await mount(slots.main, props)
  const text = treeText(tree)
  assert.doesNotMatch(text, /settings\.groupEmbed/, '封存组不得渲染（含标题/说明）')
  assert.equal(findNode(tree, (n) => n.props && n.props.id === 'wm-embed-enabled'), null, '不得出现假开关')
  assert.doesNotMatch(text, /settings\.embedEndpoint|settings\.embedModel|settings\.embedBatch/, '不得出现无效输入卡')
  // 其它组照常渲染：隐藏不能把设置页搞空。
  assert.match(text, /settings\.groupAdvanced/, '高级组仍应渲染')
  assert.match(text, /settings\.singleInstanceLock/, '高级组内容仍应渲染')
})

test('[SHELVED] 概览不显示「待处理（vector_pending）」健康位', async () => {
  const { slots, mount } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } })
  const tree = await mount(slots.main, props)
  const text = treeText(tree)
  assert.doesNotMatch(text, /health\.pending/, '封存后不得再显示没有消费者的待处理计数')
  assert.match(text, /health\.job/, '其它健康位仍应渲染')
})

test('[SHELVED] 三语文案仍保留（恢复时不必重做文案）', async () => {
  // 面板隐藏不等于文案删除：恢复时直接用，不用重跑三语 i18n。
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../lib/client-src/generated/locale.js', import.meta.url), 'utf8')
  for (const key of ['settings.groupEmbed', 'settings.embedEnabled', 'settings.embedEndpoint']) {
    assert.ok(src.includes(key), `封存组文案键 ${key} 应保留（恢复直接可用）`)
  }
})
