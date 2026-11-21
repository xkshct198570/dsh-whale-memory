/**
 * dsh-whale-memory Host 入口（S1）。
 *
 * 职责边界（厂长令）：只做记忆的记与查；角色/对话属于独立插件，本包零引用。
 * S1 已接线：Config + 只读路由（stats/recent/search/recall-test）+ 召回注入 hook；
 * 本地记忆核心在 S2，面板五页签在 S3。
 */
import { createRoutes, PREFIX } from './src/host/routes.js'
import { installHook } from './src/host/hook.js'
import { createBackend } from './src/core/backend.js'
import { Config } from './src/host/config.js'
import { installSearchFeed } from './src/host/search-feed.js'
import { installReflectScheduler } from './src/core/reflect.js'
import { installKeeper } from './src/core/keeper.js'
import { bool, num } from './src/host/config-values.js'

export { Config }
export const inject = ['webServer', 'systemPrompt']

const log = (line) => { try { console.log(line) } catch { /* log 永远不是故障点 */ } }

export function apply(ctx, config) {
  const backend = createBackend(config?.backend, {
    log,
    dataDir: config?.dataDir || '',
    useWorker: bool(config?.advanced?.worker, true),
    config: () => config,
  })

  // 外部角色插件可选的"身份提示"：A 只存 role_id/workspace/user_id，不理解角色语义。
  let identityHint = null
  const getIdentityCfg = () => (identityHint ? { ...config?.identity, ...identityHint } : config?.identity)
  ctx.provide('whaleMemory', {
    setIdentityHint(hint) { identityHint = hint && typeof hint === 'object' ? hint : null },
    clearIdentityHint() { identityHint = null },
  })

  // S4 后台调度：jobs 状态机 + 单飞 + 启动补偿 + 水位闸门；反思/巩固/日报都走它。
  const keeper = installKeeper(ctx, { store: backend, config, log })
  keeper.register('write', async () => {
    if (typeof backend.drainWrites !== 'function') return { skipped: 'writer_unavailable' }
    return await backend.drainWrites()
  })

  const reflect = installReflectScheduler(ctx, {
    backend, config, keeper,
    getLlm: () => ctx.get('llm'),
    getSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
    log,
  })

  // 定时入队（真实执行仍由 keeper 的 10min tick + 水位闸门决定，不在这抢并发）。
  const nowSec = () => Date.now() / 1000
  ctx.effect(() => {
    const timers = []
    if (bool(config?.consolidate?.enabled, true)) {
      keeper.enqueue('consolidate', {}, { nextAt: nowSec() + 600 })
      const hours = num(config?.consolidate?.intervalHours, 6)
      const t = setInterval(() => keeper.enqueue('consolidate', {}), Math.max(1, hours) * 3600_000)
      if (typeof t.unref === 'function') t.unref()
      timers.push(t)
    }
    keeper.enqueue('report', {}, { nextAt: nowSec() + 900 })
    const daily = setInterval(() => { keeper.enqueue('report', {}); keeper.enqueue('archive', {}) }, 24 * 3600_000)
    if (typeof daily.unref === 'function') daily.unref()
    timers.push(daily)
    return () => { for (const t of timers) clearInterval(t) }
  }, 'whale-memory: keeper schedule')

  installSearchFeed(ctx, { backend, config, log })

  const handler = createRoutes({ config, backend, getIdentityCfg, ctx, reflect, log })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'whale-memory: routes')

  // backend 生命周期：worker 线程与 SQLite 连接随插件 dispose 收尾。
  ctx.effect(() => () => { reflect.dispose(); backend.dispose?.() }, 'whale-memory: backend')

  let hook = null
  ctx.effect(() => {
    hook = installHook(ctx, { backend, config, getIdentityCfg, log })
    return () => hook?.dispose()
  }, 'whale-memory: recall hook')

  log(`[whale-memory] armed mode=${config?.backend?.mode || 'local'} backendReady=${Boolean(backend.ready)} hook=on`)
}
