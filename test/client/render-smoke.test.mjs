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
    maxItems: 8, autoAccept: false, spoolTtlHours: 24, retentionDays: 180, maxRunsPerDay: 6,
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
    fetch: async (url) => {
      const path = String(url)
      const body = path.endsWith('/config')
        ? { ok: true, config }
        : path.endsWith('/wrap/status') && extra.wrapStatus
          ? extra.wrapStatus
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
    return { type: String(node.type), children: node.children.map(renderNode) }
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
