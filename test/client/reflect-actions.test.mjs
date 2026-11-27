/**
 * 0.8.1-10 手动反思两态：无会话身份 → 400 reason + 可行动文案；有身份 → 正常跑。
 *
 * 为什么必须渲染级用例：路由只回 error=identity_required 时，面板会显示「身份键缺失」，
 * 用户无法知道下一步（真机复现）。这里锁「面板把该码换成能照做的文案」，同时锁
 * 「reflect.enabled=false 时按钮仍可点」——显式动作绕过开关是 S4/S5 契约，不得因本次改动回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadSlots, treeText, findNode } from './render-harness.mjs'

const props = { t: (key) => key, locale: 'zh' }

/** 反思按钮（概览卡）：disabled 只在执行中为真。 */
function reflectButton(tree) {
  return findNode(tree, (n) => n.type === 'button' && treeText(n).includes('reflect.button'))
}

test('无会话身份：按钮可点（enabled=false 不禁用），400 reason 渲染可行动文案', async () => {
  const calls = []
  const { slots, mount, rerender } = loadSlots(
    { reflect: { ...DEFAULT_CONFIG.reflect, enabled: false }, panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    {
      calls,
      reflectPost: {
        status: 400,
        body: { ok: false, error: 'identity_required', reason: 'no_session_identity' },
      },
    },
  )
  const tree = await mount(slots.main, props)
  const button = reflectButton(tree)
  assert.ok(button, '概览缺少「反思」按钮')
  assert.notEqual(button.props.disabled, true, '开关关闭时不得禁用按钮（显式动作绕过开关）')

  calls.length = 0
  await button.props.onClick()
  const tree2 = await rerender(slots.main, props)
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reflect')).length, 1, '必须真的 POST /reflect')
  const text = treeText(tree2)
  assert.match(text, /reflect\.needIdentity/, '身份缺失必须渲染可行动文案，而不是通用错误码')
  const box = findNode(tree2, (n) => n.type === 'div' && n.props && n.props['data-reason'] !== undefined)
  assert.ok(box, '错误卡缺少 data-reason（机器可读原因要能被诊断读到）')
  assert.equal(box.props['data-reason'], 'no_session_identity')
})

test('有身份：正常跑并显示结果（同一按钮两态）', async () => {
  const calls = []
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    { calls, reflectPost: { status: 200, body: { ok: true, started: true, result: { added: 2, material: 3 } } } },
  )
  const tree = await mount(slots.main, props)
  await reflectButton(tree).props.onClick()
  const tree2 = await rerender(slots.main, props)
  assert.match(treeText(tree2), /reflect\.done/, '成功后必须显示完成文案')
  assert.equal(findNode(tree2, (n) => n.type === 'div' && n.props && n.props['data-reason'] !== undefined), null)
})
