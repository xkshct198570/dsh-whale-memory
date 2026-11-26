/**
 * 设置页 · 反思峰时窗口（S5 / P2-8）：回显、按行归一、保存只提交 maintenance 差异叶子。
 *
 * 为什么单独成文件：峰时窗口是 maintenance 组的唯一面板入口，用例要断言“保存 payload 长什么样”，
 * 与概览/收尾卡渲染用例职责不同；渲染双件见 render-harness.mjs。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadSlots, treeText, findNode } from './render-harness.mjs'

test('S5 峰时窗口：回显服务端窗口、按行归一、保存只提交 maintenance 叶子', async () => {
  const calls = []
  const { slots, mount } = loadSlots(
    { maintenance: { suppressWindows: ['00:00-08:00', '23:00-07:00'] }, panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupReflect': true }, calls },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const area = findNode(tree, (n) => n.type === 'textarea' && n.props.id === 'wm-maintenance-suppressWindows')
  assert.ok(area, '反思组缺「峰时窗口」输入卡')
  assert.equal(area.props.value, '00:00-08:00\n23:00-07:00', '峰时窗口必须回显服务端值（按行）')
  assert.match(treeText(tree), /settings\.maintenanceWindowsNote/, '缺格式说明（HH:MM-HH:MM/跨午夜/坏值跳过）')

  // 改动：两侧空白 + 空行 + 一条新窗口 → 保存前必须 trim 去空行（坏值不在这里判，运行期 fail-open）。
  area.props.onChange({ target: { value: ' 23:00-07:00 \n\n08:00-12:00\n' } })
  const next = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const save = findNode(next, (n) => n.type === 'button' && treeText(n).includes('settings.save'))
  assert.ok(save && typeof save.props.onClick === 'function', '找不到保存按钮')
  calls.length = 0
  await save.props.onClick()
  const posts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/config'))
  assert.equal(posts.length, 1, `保存应只发一次 /config POST，实际 ${posts.length}`)
  const payload = JSON.parse(posts[0].body)
  assert.deepEqual(payload, {
    config: { maintenance: { suppressWindows: ['23:00-07:00', '08:00-12:00'] } },
  }, '保存必须只提交 maintenance 差异叶子（不得把全部默认值钉进 profile）')
})
