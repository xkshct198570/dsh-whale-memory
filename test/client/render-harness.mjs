/**
 * 面板渲染冒烟测试双件（无浏览器）：最小 React/hooks 运行时 + fetch/localStorage 桩。
 *
 * 为什么单独成文件：render-smoke 与设置页定向用例共用同一双件；双件留在某个 .test.mjs 里
 * 会让新增用例只能往同一文件追加（铁律 23 体量闸「存量只减不增」+ 测试文件职责分裂）。
 * 扩展名不是 .test.mjs：run-tests 的 glob 只收 *.test.mjs，本文件不会被当测试执行。
 *
 * 边界：只覆盖纯 React 渲染（fetch/timer 都打桩）；不替代真实浏览器像素验收。
 * 双件保真要求（踩过的坑）：①props.children 是函数（FieldCard 渲染函数）时不得被空 variadic 覆盖；
 * ②useEffect 必须遵守 deps，否则每次 mount 重跑只该跑一次的加载 effect（会把 draft 覆盖回服务端值）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLIENT = path.join(ROOT, 'lib/client.js')
export const DEFAULT_CONFIG = {
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
  tools: { enabled: true, maxWritesPerTurn: 5 },
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
  privacy: { redact: true, retentionDays: 0, jobPayloadTtlDays: 0 },
  edges: { diffusion: true, minConf: 0.6 },
  sync: {
    enabled: false, mode: 'off', intervalMin: 15, httpTimeoutMs: 800, batch: 100,
    bridgeUrl: '', dryRun: true,
  },
  panel: { allowRemote: false, pollMs: 60000, tab: 'overview' },
  advanced: { traceId: '', logLevel: 'warn', worker: true },
}

export function loadSlots(configOverride = null, extra = {}) {
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
      // 记录请求（S5 起断言保存 payload 用）：只在显式传 extra.calls 时累积，避免测试间共享状态。
      if (extra.calls) {
        extra.calls.push({
          path,
          method: String((opts && opts.method) || 'GET').toUpperCase(),
          body: opts && typeof opts.body === 'string' ? opts.body : null,
        })
      }
      const isPost = Boolean(opts && String(opts.method || '').toUpperCase() === 'POST')
      // 写接口用 extra.wrapPost 提供状态码/体；读接口按路径分发，未知路径回空壳（与旧行为一致）。
      // 手动反思（0.8.1-10）：400/200 形状由用例给，默认成功。
      if (isPost && path.endsWith('/reflect')) {
        const spec = extra.reflectPost || { status: 200, body: { ok: true, started: true, result: { added: 1, material: 2 } } }
        return { ok: spec.status >= 200 && spec.status < 300, status: spec.status, json: async () => spec.body }
      }
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
  const effectDeps = []
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
    useEffect(fn, deps) {
      // 忠实一点：React 的 deps 语义必须被双件遵守，否则每次 mount 都会重跑“只该跑一次”的
      // 加载 effect（例如设置页 reload 会把用户改了一半的 draft 覆盖回服务端值 → 冒烟假绿）。
      const i = cursor++
      const prev = effectDeps[i]
      const changed = !deps || !prev || deps.length !== prev.length
        || deps.some((dep, index) => !Object.is(dep, prev[index]))
      effectDeps[i] = deps
      if (changed) effects.push({ i, fn })
    },
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
    if (typeof node.type === 'function') {
      // 为什么不能一律用 node.children 覆盖：React 允许 children 走 props（FieldCard 的 children
      // 是渲染函数），也允许走可变参数；测试双件把空 variadic 当权威会让 FieldCard 类卡片恒渲染成空
      // 子节点（假绿——组件没白屏，但输入控件根本没被跑到）。有 variadic 用它，否则保留 props.children。
      const children = node.children.length > 0 ? node.children : (node.props ? node.props.children : undefined)
      return renderNode(node.type({ ...node.props, children }))
    }
    // 保留 props：S1 起断言 select/option/button 的可访问性与事件要读真实属性（不只是文本）。
    return { type: String(node.type), props: node.props || {}, children: node.children.map(renderNode) }
  }
  /** 跑若干轮渲染直到稳定：effect 里的异步加载/轮询落地后才返回最后一棵树。 */
  const renderRounds = async (Component, props, rounds) => {
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

  /**
   * 新挂载：清空 hooks 状态/ref/deps 再渲染（等价 React 的新组件实例）。
   * 为什么必须清：states/refs/effectDeps 按 hook 序号存，不清就会让「同一个 loadSlots 里先挂 A 再挂 B」
   * 的 B 继承 A 的 state（例如设置页的 load 顶掉 Panel 的 useVisible）——冒烟会假绿。
   */
  const mount = async (Component, props, rounds = 8) => {
    states.length = 0
    refs.length = 0
    effectDeps.length = 0
    return renderRounds(Component, props, rounds)
  }

  /** 重渲染同一实例：保留 hooks 状态（用于模拟用户操作后的下一帧）。 */
  const rerender = async (Component, props, rounds = 8) => renderRounds(Component, props, rounds)

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
  return { slots, mount, rerender }
}

/** 渲染树 → 纯文本（只用于断言关键文案是否真的出现）。 */
export function treeText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join('')
  if (node.text !== undefined) return String(node.text)
  return (node.children || []).map(treeText).join('')
}

/** 渲染树遍历：找满足条件的节点（用于点按钮、断言 select/option 真实存在）。 */
export function walkTree(node, visit) {
  if (!node) return
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walkTree(child, visit)
}

// 渲染树查找：按元素类型 + 谓词取第一个节点（只读断言，不改 props）。
export function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findNode(item, pred)
      if (hit) return hit
    }
    return null
  }
  if (pred(node)) return node
  return findNode(node.children, pred)
}
