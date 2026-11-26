/**
 * 设置页 · 反思峰时窗口（S5 / P2-8）：回显、真实逐键输入、保存只提交 maintenance 差异叶子。
 *
 * 为什么要逐键模拟：审查实测「每次 onChange 立即 trim/去空行」会让 Enter 无法新增行，
 * 两个窗口被拼成一条非法值静默保存（运行期 fail-open → 用户以为配了实际没生效）。
 * 本文件同时锁「编辑期保留原行」与「提交期归一」两个阶段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadSlots, treeText, findNode } from './render-harness.mjs'

/** 取峰时窗口 textarea（id 由 idOf('maintenance','suppressWindows') 生成）。 */
function areaOf(tree) {
  return findNode(tree, (n) => n.type === 'textarea' && n.props.id === 'wm-maintenance-suppressWindows')
}

test('S5 峰时窗口：回显、逐键换行新增窗口、保存只提交 maintenance 叶子', async () => {
  const calls = []
  const { slots, mount, rerender } = loadSlots(
    { maintenance: { suppressWindows: ['23:00-07:00'] }, panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupReflect': true }, calls },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const area = areaOf(tree)
  assert.ok(area, '反思组缺「峰时窗口」输入卡')
  assert.equal(area.props.value, '23:00-07:00', '峰时窗口必须回显服务端值（按行）')
  assert.match(treeText(tree), /settings\.maintenanceWindowsNote/, '缺格式说明（HH:MM-HH:MM/跨午夜/坏值跳过）')

  // 逐键输入：先按 Enter（值必须保留换行，否则根本加不了第二行）
  area.props.onChange({ target: { value: '23:00-07:00\n' } })
  const afterEnter = areaOf(await rerender(slots.main, { t: (key) => key, locale: 'zh' }))
  assert.equal(afterEnter.props.value, '23:00-07:00\n', 'Enter 后换行必须保留（编辑期不得归一化）')

  // 再输入第二个窗口 + 两侧空白 + 尾随空行
  afterEnter.props.onChange({ target: { value: '23:00-07:00\n  08:00-12:00  \n' } })
  const next = await rerender(slots.main, { t: (key) => key, locale: 'zh' })
  const save = findNode(next, (n) => n.type === 'button' && treeText(n).includes('settings.save'))
  assert.ok(save && typeof save.props.onClick === 'function', '找不到保存按钮')
  calls.length = 0
  await save.props.onClick()
  const posts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/config'))
  assert.equal(posts.length, 1, `保存应只发一次 /config POST，实际 ${posts.length}`)
  const payload = JSON.parse(posts[0].body)
  assert.deepEqual(payload, {
    config: { maintenance: { suppressWindows: ['23:00-07:00', '08:00-12:00'] } },
  }, '保存必须 trim/去空行，且只提交 maintenance 差异叶子（不得把全部默认值钉进 profile）')
})

test('S5 峰时窗口：清空后保存为空数组（关掉抑制），且不写其他叶子', async () => {
  const calls = []
  const { slots, mount, rerender } = loadSlots(
    { maintenance: { suppressWindows: ['00:00-08:00'] }, panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupReflect': true }, calls },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  areaOf(tree).props.onChange({ target: { value: '  \n\n' } })
  const next = await rerender(slots.main, { t: (key) => key, locale: 'zh' })
  const save = findNode(next, (n) => n.type === 'button' && treeText(n).includes('settings.save'))
  calls.length = 0
  await save.props.onClick()
  const posts = calls.filter((call) => call.method === 'POST' && call.path.endsWith('/config'))
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].body), { config: { maintenance: { suppressWindows: [] } } })
})
