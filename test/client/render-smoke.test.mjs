/**
 * 面板渲染冒烟（无浏览器）：用最小 hooks 运行时执行 client bundle 的
 * `settings.section` 与 `main` 两个 slot，捕获渲染期异常。
 *
 * 为什么需要：静态契约测试只能证明“源码里出现了某段字符串”，证明不了组件真的能渲染。
 * R11 实测踩坑——危险区分组卡只传 title 没传 titleKey，`alwaysOpen` 判定失败后走折叠
 * 分支调用未注入的 `t`，设置页整页空白且页签失效。本用例直接跑组件函数，白屏类错误会红。
 *
 * 边界：只覆盖纯 React 渲染（fetch/timer 都打桩）；不替代真实浏览器像素验收。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT = path.join(ROOT, 'lib/client.js')
const DEFAULT_CONFIG = {
  dataDir: '',
  backend: { id: '', mode: 'local', url: '', timeoutMs: 3000 },
  identity: { mode: 'auto', userId: '', roleId: '', workspace: '' },
  recall: {
    enabled: true, maxHits: 5, charBudget: 1500, intentBudget: true, minRel: 0.34,
    timeoutMs: 2000, injectLevels: ['core', 'important'], showSources: true,
  },
  write: {
    enabled: true, reviewMode: 'shadow', maxChars: 500, dailyCap: 200, judge: 'rules',
    searchFeed: false, searchTtlHours: 24, model: '', ignorePatterns: [],
  },
  rules: {
    enabled: true, dir: '', requireGit: false, askMode: 'panel+chat', llm: false,
    maxProposals: 20, guardStrict: true, mirrorAuto: true, askCooldownDays: 30,
  },
  reflect: { enabled: false, model: '', idleMinutes: 30, maxItems: 8, maxRunsPerDay: 24 },
  wrap: {
    enabled: true, explicit: true, idle: false, disposed: false, idleMinutes: 10,
    maxItems: 8, spoolTtlHours: 24, retentionDays: 180, maxRunsPerDay: 6,
    ingest: { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true },
    report: true, model: '', maxMaterialChars: 12000, timeoutMs: 60000,
  },
  consolidate: { enabled: true, intervalHours: 6 },
  embed: { enabled: false, endpoint: '', model: '', batch: 16 },
  privacy: { redact: true, retentionDays: 0 },
  edges: { diffusion: true, minConf: 0.6 },
  sync: {
    enabled: false, mode: 'off', intervalMin: 15, httpTimeoutMs: 800, batch: 100,
    bridgeUrl: '', dryRun: true,
  },
  panel: { allowRemote: false, pollMs: 60000, tab: 'overview' },
  advanced: { traceId: '', logLevel: 'warn', worker: true },
}

/** 载入 client bundle，返回 apply() 后注册的两个 slot 组件。 */
function loadSlots(configOverride = null, extra = {}) {
  const config = configOverride ? { ...DEFAULT_CONFIG, ...configOverride } : DEFAULT_CONFIG
  let factory = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    queueMicrotask,
    URL,
    fetch: async (url, opts) => {
      const path = String(url)
      const isPost = Boolean(opts && String(opts.method || '').toUpperCase() === 'POST')
      // 写接口用 extra.wrapPost 提供状态码/体；读接口按路径分发，未知路径回空壳（与旧行为一致）。
      if (isPost && path.endsWith('/wrap')) {
        const spec = extra.wrapPost || { status: 200, body: { ok: true, runId: 9, state: 'queued' } }
        return { ok: spec.status >= 200 && spec.status < 300, status: spec.status, json: async () => spec.body }
      }
      const body = path.endsWith('/config')
        ? { ok: true, config }
        : path.endsWith('/wrap/status') && extra.wrapStatus
          ? extra.wrapStatus
          : path.includes('/wrap/sessions')
            ? (extra.wrapSessions || { ok: true, items: [], auto: { enabled: false, idleMinutes: 10 } })
            : path.includes('/wrap/report') && extra.wrapReport
              ? extra.wrapReport
              : { ok: true, items: [], series: [], stats: {} }
      return { ok: true, status: 200, json: async () => body }
    },
    document: undefined,
    window: {},
    localStorage: {
      store: new Map(
        Object.entries(extra.openGroups || {}).map(([key, value]) => ['wm.settings.open.v1', JSON.stringify({ [key]: value })]),
      ),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
    },
  }
  sandbox.window.__ModuleLoader__ = { load({ factory: fn }) { factory = fn } }
  sandbox.window.confirm = () => true
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })
  assert.ok(factory, 'client bundle 未注册 factory')

  // 最小 React：函数组件 + hooks；只执行组件函数，不产生 DOM。
  const states = []
  const refs = []
  let cursor = 0
  let dirty = false
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: 'Fragment',
    useState(init) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
      return [states[i], (next) => {
        states[i] = typeof next === 'function' ? next(states[i]) : next
        dirty = true
      }]
    },
    useEffect(fn) { const i = cursor++; effects.push({ i, fn }) },
    useMemo(fn) { cursor++; return fn() },
    useRef(init) {
      const i = cursor++
      if (!(i in refs)) refs[i] = { current: init }
      return refs[i]
    },
    useCallback(fn) { cursor++; return fn },
    createContext(value) { return { _default: value } },
    useContext(ctx) { cursor++; return ctx && ctx._default },
  }
  const renderNode = (node) => {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map(renderNode)
    if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }))
    // 保留 props：S1 起断言 select/option/button 的可访问性与事件要读真实属性（不只是文本）。
    return { type: String(node.type), props: node.props || {}, children: node.children.map(renderNode) }
  }
  const mount = async (Component, props, rounds = 8) => {
    // 固定跑几轮让 effect 里的异步加载/轮询落地；返回最后一轮渲染树，
    // 供测试断言"页签真的渲染出内容"而不是只断言源码字符串。
    let tree = null
    for (let round = 0; round < rounds; round += 1) {
      cursor = 0
      dirty = false
      effects = []
      tree = renderNode(React.createElement(Component, props))
      for (const { fn } of effects) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) return tree
    }
    return tree
  }

  const slots = {}
  const ctx = {
    locale: { register() {}, bind() { return (key) => key }, current() { return 'zh' } },
    slots: {
      inject(name, fn) { fn() },
      register(meta, component) { slots[meta.name] = component },
    },
    effect(fn) { try { fn() } catch { /* <style> 注入与渲染无关 */ } },
  }
  factory((name) => (name === 'react' ? React : {}))
    .apply(ctx)
  return { slots, mount }
}

/** 渲染树 → 纯文本（只用于断言关键文案是否真的出现）。 */
function treeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  if (node.text !== undefined) return String(node.text)
  return (node.children || []).map(treeText).join('')
}

test('面板渲染冒烟：settings.section 与 main 都能无异常渲染（防白屏）', async () => {
  const { slots, mount } = loadSlots()
  assert.equal(typeof slots['settings.section'], 'function', '缺少 settings.section 组件')
  assert.equal(typeof slots.main, 'function', '缺少 main 面板组件')
  await mount(slots['settings.section'], { t: (key) => key })
  await mount(slots.main, { t: (key) => key, locale: 'zh' })
})

test('六页签逐个执行组件函数：任一页签白屏/ReferenceError 都会红', async () => {
  const tabs = ['overview', 'memory', 'rules', 'recall', 'writes', 'settings']
  for (const tab of tabs) {
    const { slots, mount } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab } })
    const tree = await mount(slots.main, { t: (key) => key, locale: 'zh' }, 1)
    assert.ok(tree, `${tab} 页签未产出渲染树`)
    const text = treeText(tree)
    assert.ok(text.length > 0, `${tab} 页签渲染为空`)
  }
})

test('全默认配置下首启推荐卡真实出现（configIsDefaults 回归）', async () => {
  const { slots, mount } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } })
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
  const { slots, mount } = loadSlots(
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
  const { slots, mount } = loadSlots(
    { panel: { ...DEFAULT_CONFIG.panel, tab: 'settings' } },
    { openGroups: { 'settings.groupWrap': true } },
  )
  const settings = await mount(slots.main, { t: (key) => key, locale: 'zh' })
  const settingsText = treeText(settings)
  assert.match(settingsText, /settings\.groupWrap/, '设置页必须有收尾组')
  assert.match(settingsText, /settings\.wrapEnabled/, '必须有启用开关')
  assert.match(settingsText, /settings\.wrapCostNote/, '必须明确会花模型 token')
})

/** 渲染树遍历：找满足条件的节点（用于点按钮、断言 select/option 真实存在）。 */
function walkTree(node, visit) {
  if (!node) return
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walkTree(child, visit)
}

test('S1 空态：没有收尾记录也有引导，且 409 点击失败可见（不再“什么都没发生”）', async () => {
  const { slots, mount } = loadSlots(
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
  const after = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
  const text = treeText(after)
  assert.match(text, /overview\.wrapFailed/, '409 必须出现失败行')
  assert.match(text, /overview\.wrapErrorTurn/, '错误码必须映射成中文一句话')
})

test('S1 会话下拉：列出采集会话（轮数/状态），选中项提交 sessionId', async () => {
  const { slots, mount } = loadSlots(
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
  const { slots, mount } = loadSlots(
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
  const { slots, mount } = loadSlots(
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
  const { slots, mount } = loadSlots(
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
  const after = await mount(slots.main, { t: (key) => key, locale: 'zh', pollMs: 1 })
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
  const { slots, mount } = loadSlots({ panel: { ...DEFAULT_CONFIG.panel, tab: 'overview' } })
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
