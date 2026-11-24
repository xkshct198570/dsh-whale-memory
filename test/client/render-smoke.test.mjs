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
function loadSlots() {
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
      const body = String(url).endsWith('/config')
        ? { ok: true, config: DEFAULT_CONFIG }
        : { ok: true, items: [], series: [], stats: {} }
      return { ok: true, status: 200, json: async () => body }
    },
    document: undefined,
    window: {},
    localStorage: {
      store: new Map(),
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
  const mount = async (Component, props) => {
    // 固定跑几轮让 effect 里的异步加载/轮询落地；本用例只关心"渲染是否抛错"，
    // 不追求 React 的真实收敛语义（面板有轮询，天然会反复 setState）。
    for (let round = 0; round < 8; round += 1) {
      cursor = 0
      dirty = false
      effects = []
      renderNode(React.createElement(Component, props))
      for (const { fn } of effects) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) return
    }
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

test('面板渲染冒烟：settings.section 与 main 都能无异常渲染（防白屏）', async () => {
  const { slots, mount } = loadSlots()
  assert.equal(typeof slots['settings.section'], 'function', '缺少 settings.section 组件')
  assert.equal(typeof slots.main, 'function', '缺少 main 面板组件')
  await mount(slots['settings.section'], { t: (key) => key })
  await mount(slots.main, { t: (key) => key, locale: 'zh' })
})
