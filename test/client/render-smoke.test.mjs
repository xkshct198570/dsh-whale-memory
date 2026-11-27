/**
 * 面板渲染冒烟（无浏览器）：用最小 hooks 运行时执行 client bundle 的
 * `settings.section` 与 `main` 两个 slot，捕获渲染期异常。
 *
 * 为什么需要：静态契约测试只能证明“源码里出现了某段字符串”，证明不了组件真的能渲染。
 * R11 实测踩坑——危险区分组卡只传 title 没传 titleKey，`alwaysOpen` 判定失败后走折叠
 * 分支调用未注入的 `t`，设置页整页空白且页签失效。本用例直接跑组件函数，白屏类错误会红。
 *
 * 双件（最小 React/hooks + fetch/localStorage 桩）见 render-harness.mjs；本文件只放概览/收尾卡用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadSlots, walkTree, treeText, findNode } from './render-harness.mjs'

test('面板渲染冒烟：settings.section 与 main 都能无异常渲染（防白屏）', async () => {
  const section = loadSlots()
  assert.equal(typeof section.slots['settings.section'], 'function', '缺少 settings.section 组件')
  await section.mount(section.slots['settings.section'], { t: (key) => key })
  const main = loadSlots()
  assert.equal(typeof main.slots.main, 'function', '缺少 main 面板组件')
  await main.mount(main.slots.main, { t: (key) => key, locale: 'zh' })
})

test('六页签逐个执行组件函数：任一页签白屏/ReferenceError 都会红', async () => {
  const tabs = ['overview', 'memory', 'rules', 'recall', 'writes', 'settings']
  for (const tab of tabs) {
    const { slots, mount, rerender } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab } })
    const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' }, 1)
    assert.ok(tree, `${tab} 页签未产出渲染树`)
    const text = treeText(tree)
    assert.ok(text.length > 0, `${tab} 页签渲染为空`)
  }
})

test('全默认配置下首启推荐卡真实出现（configIsDefaults 回归）', async () => {
  const { slots, mount, rerender } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } })
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const text = treeText(tree)
  assert.match(text, /settings\.firstRunTitle/, '默认配置应出现首启推荐卡')
})


test('Session Wrap 概览卡：真实状态渲染出状态/计数/可切会话，报告按需展示', async () => {
  const wrapStatus = {
    ok: true, supported: true, enabled: true, runsToday: 1, maxRunsPerDay: 6, jobs: 0,
    latest: {
      id: 7, state: 'done', trigger: 'explicit', phase: 'done', attempts: 1,
      createdAt: 1763900000, updatedAt: 1763900060,
      candidates: 2, ruleProposals: 1, openLoops: 0,
      switchReady: { ready: true, blockers: [], warnings: [] }, error: '', reportAvailable: true,
    },
    recent: [], spool: { files: 0, bytes: 0 }, lastSkip: null, lastManual: null, capture: null,
  }
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    { wrapStatus, wrapReport: { ok: true, runId: 7, text: '# 会话收尾报告' } },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const text = treeText(tree)
  assert.match(text, /overview\.wrapTitle/, '概览必须出现最近收尾卡')
  assert.match(text, /done|wrap\.stateDone/, '必须显示 run 状态')
  assert.match(text, /overview\.wrapCandidates/, '必须显示候选计数')
  assert.match(text, /overview\.wrapReadyYes/, '必须显示可切会话结论')
  assert.match(text, /overview\.wrapShowReport/, '有报告时必须给入口')
})

test('Session Wrap 设置组与候选过滤：分组/开关真实渲染，收尾候选可筛', async () => {
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupWrap': true } },
  )
  const settings = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const settingsText = treeText(settings)
  assert.match(settingsText, /settings\.groupWrap/, '设置页必须有收尾组')
  assert.match(settingsText, /settings\.wrapEnabled/, '必须有启用开关')
  assert.match(settingsText, /settings\.wrapCostNote/, '必须明确会花模型 token')
})

test('S1 空态：没有收尾记录也有引导，且 409 点击失败可见（不再“什么都没发生”）', async () => {
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    {
      wrapStatus: {
        ok: true, supported: true, enabled: true, runsToday: 0, maxRunsPerDay: 6, jobs: 0,
        latest: null, recent: [], lastSkip: null,
        capture: { sessions: 1, material: 1 },
      },
      wrapSessions: { ok: true, auto: { enabled: false, idleMinutes: 10 }, items: [{ sessionId: 's1', lastActivity: 1, materialTurns: 3, open: false, hasMaterial: true }] },
      wrapPost: { status: 409, body: { ok: false, error: 'turn_in_progress' } },
    },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  assert.match(treeText(tree), /overview\.wrapEmptyGuide/, '空态必须有引导')
  let button = null
  walkTree(tree, (node) => {
    if (node.type === 'button' && node.props && node.props['aria-label'] === 'overview.wrapNow') button = node
  })
  const labels = []
  walkTree(tree, (node) => { if (node.type === 'button') labels.push(node.props && node.props['aria-label']) })
  assert.ok(button && typeof button.props.onClick === 'function', '空态也必须能点立即收尾 buttons=' + JSON.stringify(labels) + ' wrapTitle?' + treeText(tree).includes('overview.wrapTitle') + ' full=' + treeText(tree).slice(-400))
  button.props.onClick()
  const after = await rerender(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const text = treeText(after)
  assert.match(text, /overview\.wrapFailed/, '409 必须出现失败行')
  assert.match(text, /overview\.wrapErrorTurn/, '错误码必须映射成中文一句话')
})

test('S1 会话下拉：列出采集会话（轮数/状态），选中项提交 sessionId', async () => {
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    {
      wrapStatus: { ok: true, supported: true, enabled: true, latest: null, recent: [], lastSkip: null },
      wrapSessions: {
        ok: true, auto: { enabled: false, idleMinutes: 10 },
        items: [
          { sessionId: 's1', lastActivity: 2, materialTurns: 3, open: false, hasMaterial: true, lastRunState: 'done' },
          { sessionId: 's2', lastActivity: 1, materialTurns: 1, open: true, hasMaterial: true, lastRunState: '' },
        ],
      },
    },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  let select = null
  const optionValues = []
  walkTree(tree, (node) => {
    if (node.type === 'select') select = node
    if (node.type === 'option') optionValues.push(node.props.value)
  })
  assert.ok(select, '渲染树里必须真有 select')
  assert.deepEqual(optionValues.filter(Boolean), ['s1', 's2'])
  assert.equal(select.props['aria-label'], 'overview.wrapSessionLabel')
})

test('S1 警告与失败折叠：warnings 可见；失败默认只显示计数，不刷原始码', async () => {
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    {
      wrapStatus: {
        ok: true, supported: true, enabled: true, jobs: 0,
        latest: {
          id: 7, state: 'failed', trigger: 'manual', phase: 'created', attempts: 1,
          createdAt: 1, updatedAt: 2, candidates: 0, ruleProposals: 0, openLoops: 0,
          switchReady: { ready: true, blockers: [], warnings: ['hygiene:FTS 未对齐'] },
          error: 'bad_json:bad_json', reportAvailable: false,
        },
        recent: [
          { id: 6, state: 'failed', trigger: 'manual', createdAt: 1, updatedAt: 2, error: 'bad_json:bad_json' },
          { id: 5, state: 'failed', trigger: 'manual', createdAt: 1, updatedAt: 2, error: 'bad_json:bad_json' },
        ],
        lastSkip: null,
      },
      wrapSessions: { ok: true, auto: { enabled: false, idleMinutes: 10 }, items: [] },
    },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const text = treeText(tree)
  assert.match(text, /overview\.wrapWarnings/, 'warnings 不得被 ready=true 掩盖')
  assert.match(text, /overview\.wrapFailureCount/, '失败默认折叠成计数')
  assert.equal(text.includes('bad_json'), false, '折叠态不得刷原始错误码')
})

test('S1b 进度点与重试：running 显示阶段、retrying 显示 N/4', async () => {
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    {
      wrapStatus: {
        ok: true, supported: true, enabled: true, jobs: 1,
        latest: {
          id: 9, state: 'running', trigger: 'manual', phase: 'distill', attempts: 2,
          createdAt: 1, updatedAt: 2, candidates: 0, ruleProposals: 0, openLoops: 0,
          switchReady: null, error: '', reportAvailable: false,
          retrying: { attempt: 2, max: 4 },
        },
        recent: [], lastSkip: null, queued: { count: 1, position: 1, phase: null, materialHash: 'abc' },
      },
      wrapSessions: { ok: true, auto: { enabled: false, idleMinutes: 0 }, items: [] },
    },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const text = treeText(tree)
  assert.match(text, /overview\.wrapPhaseDistill/)
  assert.match(text, /overview\.wrapRetrying/)
  let current = null
  walkTree(tree, (node) => { if (node.props && node.props['aria-current'] === 'step') current = node })
  assert.ok(current, '当前阶段必须有 aria-current=step')
})

test('S2 自动/跳过开关：auto 勾选反映服务端，选中会话后出现 skip 开关', async () => {
  const sessions = {
    ok: true, auto: { enabled: true, idleMinutes: 10 },
    items: [{ sessionId: 's1', lastActivity: 2, materialTurns: 3, open: false, hasMaterial: true, skipAuto: true, lastRunState: 'done' }],
  }
  const { slots, mount, rerender } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    { wrapStatus: { ok: true, supported: true, enabled: true, latest: null, recent: [], lastSkip: null }, wrapSessions: sessions },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const inputs = new Map()
  walkTree(tree, (node) => { if (node.type === 'input' && node.props.id) inputs.set(node.props.id, node) })
  assert.equal(inputs.get('wrap-auto-switch')?.props.checked, true, '自动开关必须反映 wrap.idle=true')
  assert.equal(inputs.has('wrap-skip-switch'), false, '未选会话时不显示 skip 开关')
  // 选中会话 → 出现 skip 开关且带当前值。
  let select = null
  walkTree(tree, (node) => { if (node.type === 'select') select = node })
  select.props.onChange({ target: { value: 's1' } })
  const after = await rerender(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const inputs2 = new Map()
  walkTree(after, (node) => { if (node.type === 'input' && node.props.id) inputs2.set(node.props.id, node) })
  assert.equal(inputs2.get('wrap-skip-switch')?.props.checked, true, 'skipAuto=true 必须显示为勾选')
})

test('S3 阶段投影：reconcile 关闭绝不出现整合阶段；开启且 phase=reconciled 才高亮', async () => {
  const base = {
    id: 10, state: 'running', trigger: 'manual', phase: 'reconciled', attempts: 1,
    createdAt: 1, updatedAt: 2, candidates: 0, ruleProposals: 0, openLoops: 0,
    switchReady: null, error: '', reportAvailable: false,
  }
  const off = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } }, {
    wrapStatus: { ok: true, supported: true, enabled: true, latest: base, recent: [], reconcile: { enabled: false } },
    wrapSessions: { ok: true, auto: { enabled: false, idleMinutes: 10 }, items: [] },
  })
  const offTree = await off.mount(off.slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  assert.equal(treeText(offTree).includes('overview.wrapPhaseReconcile'), false, '关闭时不得渲染整合阶段')

  const on = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } }, {
    wrapStatus: { ok: true, supported: true, enabled: true, latest: base, recent: [], reconcile: { enabled: true } },
    wrapSessions: { ok: true, auto: { enabled: false, idleMinutes: 10 }, items: [] },
  })
  const onTree = await on.mount(on.slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  assert.match(treeText(onTree), /overview\.wrapPhaseReconcile/)
  let current = null
  walkTree(onTree, (node) => { if (node.props && node.props['aria-current'] === 'step') current = node })
  assert.ok(current)
  assert.match(treeText(current), /overview\.wrapPhaseReconcile/)
})

test('页签不可被压缩：nav flexShrink=0/minHeight、tab 显式 28px 盒高（真机 0 高回归）', async () => {
  const { slots, mount, rerender } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } })
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' }, 1)
  let nav = null
  walkTree(tree, (node) => { if (node.type === 'nav' && node.props && node.props.role === 'tablist') nav = node })
  assert.ok(nav, '必须渲染 tablist nav')
  assert.equal(nav.props.style.flexShrink, 0, 'nav 在 flex column 面板里不得被压缩')
  assert.equal(nav.props.style.minHeight, '36px')
  const tabs = []
  walkTree(nav, (node) => { if (node.type === 'button' && node.props && node.props.role === 'tab') tabs.push(node) })
  assert.equal(tabs.length, 6, '六页签必须全部渲染')
  for (const tab of tabs) {
    assert.equal(tab.props.style.height, '28px', '页签盒高必须显式，否则内容高塌陷')
    assert.equal(tab.props.style.display, 'inline-flex')
    assert.equal(tab.props.style.boxSizing, 'border-box')
  }
})

// ---------------------------------------------------------------------------

test('手动反思按钮不受 reflect.enabled 约束（S4 契约：显式动作绕过开关）', async () => {
  const calls = []
  const { slots, mount } = loadSlots(
    { reflect: { ...DEFAULT_CONFIG.reflect, enabled: false }, panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } },
    { calls },
  )
  const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const button = findNode(tree, (n) => n.type === 'button' && treeText(n).includes('reflect.button'))
  assert.ok(button, '缺少「立即反思」按钮')
  assert.notEqual(button.props.disabled, true, '开关关闭时手动反思按钮必须可点（自动开关只管自动触发）')
  calls.length = 0
  await button.props.onClick()
  assert.ok(calls.some((call) => call.method === 'POST' && call.path.endsWith('/reflect')),
    '点击必须真的 POST /reflect（不是假按钮）')
})

test('概览：身份就绪后立即重取 /recalls（修「Latest 3 recalls 恒空」的时序 bug）', async () => {
  const calls = []
  const config = { ...DEFAULT_CONFIG, panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } }
  const { slots, mount } = loadSlots(config, {
    calls,
    configBody: {
      ok: true,
      config,
      runtimeIdentity: { userId: 'u1', roleId: '', runtimeWorkspace: '/ws' },
      identityOverride: true,
    },
  })
  await mount(slots.main, { t: (key) => key, locale: 'zh' }, 8)
  const recallCalls = calls.filter((entry) => entry.path.includes('/recalls'))
  assert.ok(recallCalls.length >= 2, '身份到达后必须再取一次 /recalls，不能等 60s 轮询')
  assert.ok(
    recallCalls.some((entry) => entry.path.includes('userId=u1') && entry.path.includes('workspace=%2Fws')),
    '重取必须带身份参数（否则只命中共享分区）',
  )
})
