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

export { Config }
export const inject = ['webServer', 'systemPrompt']

const log = (line) => { try { console.log(line) } catch { /* log 永远不是故障点 */ } }

export function apply(ctx, config) {
  const backend = createBackend(config?.backend, {
    log,
    dataDir: config?.dataDir || '',
    useWorker: config?.advanced?.worker !== false,
  })

  // 外部角色插件可选的"身份提示"：A 只存 role_id/workspace/user_id，不理解角色语义。
  let identityHint = null
  const getIdentityCfg = () => (identityHint ? { ...config?.identity, ...identityHint } : config?.identity)
  ctx.provide('whaleMemory', {
    setIdentityHint(hint) { identityHint = hint && typeof hint === 'object' ? hint : null },
    clearIdentityHint() { identityHint = null },
  })

  const handler = createRoutes({ config, backend, getIdentityCfg, log })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'whale-memory: routes')

  // backend 生命周期：worker 线程与 SQLite 连接随插件 dispose 收尾。
  ctx.effect(() => () => backend.dispose?.(), 'whale-memory: backend')

  let hook = null
  ctx.effect(() => {
    hook = installHook(ctx, { backend, config, getIdentityCfg, log })
    return () => hook?.dispose()
  }, 'whale-memory: recall hook')

  log(`[whale-memory] armed mode=${config?.backend?.mode || 'local'} backendReady=${Boolean(backend.ready)} hook=on`)
}
