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
import { installIdentitySource } from './src/host/identity-source.js'
import { installConfigMigration } from './src/host/config-migration.js'
import { installReflectScheduler } from './src/core/reflect.js'
import { installKeeper } from './src/core/keeper.js'
import { installOutboxWatchdog } from './src/core/hybrid.js'
import { defaultRuleRoot, listRules } from './src/core/rule-store.js'
import { seedDefaultRules } from './src/core/rule-defaults.js'
import { mirrorRules } from './src/core/rule-mirror.js'
import { agentsPathOf, renderAgentsDigest } from './src/core/rule-render.js'
import { bool, num } from './src/host/config-values.js'

export { Config }
export const inject = ['webServer', 'systemPrompt']

const log = (line) => { try { console.log(line) } catch { /* log 永远不是故障点 */ } }

/** 外部服务凭证的环境变量名（密钥只走 credentials/env，不进 Config）。 */
const BACKEND_TOKEN_ENV = 'WHALE_MEMORY_TOKEN'

/**
 * backend 代理：registerBackend() 换实现后，路由/keeper/hook 立刻取到 current，
 * 不再各自持有建库时的旧引用。所有已用方法（含 withDb/dbFile 等）原样转发。
 * @param {{ current: any }} ref
 */
export function createBackendProxy(ref) {
  return new Proxy({}, {
    get(_target, prop) {
      const current = ref?.current
      if (!current) return undefined
      const member = current[prop]
      return typeof member === 'function' ? member.bind(current) : member
    },
    has(_target, prop) {
      return Boolean(ref?.current) && prop in ref.current
    },
  })
}

/**
 * 对外 `whaleMemory` service（架构书 §12.2）：记忆统计、分区、后端注册、缓存失效、身份提示。
 * @param {{ ctx: any, backendRef: { current: any }, getHook?: () => any, identityState?: { hint: any }, log?: (line:string)=>void }} deps
 */
export function createWhaleMemoryService({ ctx, backendRef, getHook = () => null, identityState = { hint: null }, log = () => {} }) {
  const service = {
    /** stats 失败一律 fail-open 返回 null，绝不把异常抛给调用方插件。 */
    async stats() {
      try {
        const current = backendRef?.current
        if (!current || typeof current.stats !== 'function') return null
        return await current.stats()
      } catch (err) {
        log(`[whale-memory] service stats fail-open: ${err?.message || err}`)
        return null
      }
    },

    /** 当前库里的身份分区摘要（最多 20 条）；读不到就返回空数组。 */
    listPartitions() {
      try {
        const current = backendRef?.current
        if (!current || typeof current.withDb !== 'function') return []
        const rows = current.withDb((db) => db.prepare(
          'SELECT user_id AS userId, role_id AS roleId, workspace, count(*) AS nodes '
          + 'FROM nodes GROUP BY user_id, role_id, workspace ORDER BY nodes DESC LIMIT 20',
        ).all())
        return Array.isArray(rows) ? rows.slice(0, 20) : []
      } catch (err) {
        log(`[whale-memory] service listPartitions fail-open: ${err?.message || err}`)
        return []
      }
    },

    /** 替换后端实现；只接受具备 stats/search/recall 的对象。 */
    registerBackend(next) {
      const valid = Boolean(next)
        && typeof next.stats === 'function'
        && typeof next.search === 'function'
        && typeof next.recall === 'function'
      if (!valid) return { ok: false, error: 'invalid_backend' }
      backendRef.current = next
      log(`[whale-memory] backend registered mode=${next?.mode || 'custom'}`)
      return { ok: true }
    },

    /** 清召回缓存（hook 的 pre-step 缓存）；hook 未安装也算成功。 */
    invalidateCache() {
      try {
        const hook = getHook?.()
        const cache = hook?.cache
        const cleared = cache && typeof cache.size === 'number' ? cache.size : 0
        if (cache && typeof cache.clear === 'function') cache.clear()
        return { ok: true, cleared }
      } catch (err) {
        log(`[whale-memory] service invalidateCache fail-open: ${err?.message || err}`)
        return { ok: false, error: 'cache_unavailable' }
      }
    },

    setIdentityHint(hint) {
      identityState.hint = hint && typeof hint === 'object' ? hint : null
    },
    clearIdentityHint() {
      identityState.hint = null
    },
  }

  if (ctx && typeof ctx.provide === 'function') ctx.provide('whaleMemory', service)
  return service
}

export function apply(ctx, config) {
  const backend = createBackend(config?.backend, {
    log,
    dataDir: config?.dataDir || '',
    useWorker: bool(config?.advanced?.worker, true),
    config: () => config,
    // 判定器（write.judge='llm'）取模型：延迟到每条事件才调 getter，缺省时队列按 rules 跑。
    getLlm: () => ctx.get('llm'),
    getSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
  })
  const backendRef = { current: backend }
  const backendProxy = createBackendProxy(backendRef)

  // 外部服务 Bearer：凭证服务异步解析（密钥不进 Config），失败静默回落 env。
  ctx.effect(() => {
    let disposed = false
    const load = async () => {
      let token = ''
      try {
        const credentials = ctx.get?.('credentials')
        if (credentials && typeof credentials.resolve === 'function') {
          const resolved = await credentials.resolve(BACKEND_TOKEN_ENV)
          token = String(resolved?.value || '')
        }
      } catch { /* 凭证服务是可选依赖：读不到就回落 env */ }
      if (!token) token = String(process.env[BACKEND_TOKEN_ENV] || '')
      if (disposed || !token) return
      const applied = typeof backendRef.current?.setToken === 'function' ? backendRef.current.setToken(token) : { ok: false }
      log(`[whale-memory] backend token ${applied?.ok ? 'applied' : 'ignored'}`)
    }
    load().catch(() => { /* 不阻断插件启动 */ })
    return () => { disposed = true }
  }, 'whale-memory: backend token')

  // hybrid 双轨：本地真源 + 远端副本；outbox 由看门狗续跑（进程重启后从 queued 继续）。
  if (config?.backend?.mode === 'hybrid') {
    installOutboxWatchdog({ backend: backendProxy, config, ctx, log })
  }

  // 外部角色插件可选的"身份提示"：A 只存 role_id/workspace/user_id，不理解角色语义。
  const identityState = { hint: null }
  const getIdentityCfg = () => (identityState.hint ? { ...config?.identity, ...identityState.hint } : config?.identity)
  const getIdentityHint = () => identityState.hint

  // 身份 auto：宿主登录态 userId（5min TTL，getter 同步返回，永不阻塞召回）。
  const identitySource = installIdentitySource(ctx, { log })
  const getHostUserId = () => identitySource.getUserId()

  // 首启旧配置迁移（架构书 §10.3）：后台跑，失败只记日志；状态给 /stats 只读展示。
  const migration = installConfigMigration(ctx, { backend: backendProxy, log })

  let hook = null
  createWhaleMemoryService({ ctx, backendRef, getHook: () => hook, identityState, log })

  // S4 后台调度：jobs 状态机 + 单飞 + 启动补偿 + 水位闸门；反思/巩固/日报都走它。
  const keeper = installKeeper(ctx, { store: backendProxy, config, log })
  keeper.register('write', async () => {
    if (typeof backendProxy.drainWrites !== 'function') return { skipped: 'writer_unavailable' }
    return await backendProxy.drainWrites()
  })

  const reflect = installReflectScheduler(ctx, {
    backend: backendProxy, config, keeper,
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

  installSearchFeed(ctx, { backend: backendProxy, config, log })

  const handler = createRoutes({ config, backend: backendProxy, getIdentityCfg, getIdentityHint, getHostUserId, identityState, migration, ctx, reflect, log })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'whale-memory: routes')

  // backend 生命周期：worker 线程与 SQLite 连接随插件 dispose 收尾。
  // 只销毁本插件自己建的 backend；registerBackend 换进来的外部实现归注入方管。
  ctx.effect(() => () => { reflect.dispose(); backend.dispose?.() }, 'whale-memory: backend')

  ctx.effect(() => {
    hook = installHook(ctx, { backend: backendProxy, config, getIdentityCfg, getIdentityHint, getHostUserId, identityState, log })
    return () => hook?.dispose()
  }, 'whale-memory: recall hook')

  // 规则文件启动自愈（R7）：规则真源在文件仓，DB 镜像/AGENTS 摘要是投影。
  // 插件重启或换机后，文件还在但镜像可能为空/过期，这里异步补一次（fail-open，不阻塞启动）。
  ctx.effect(() => {
    if (bool(config?.rules?.enabled, true) === false) return () => {}
    if (bool(config?.rules?.mirrorAuto, true) === false) return () => {}
    const dir = String(config?.rules?.dir || '').trim() || defaultRuleRoot()
    // 首次播种默认铁律放在定时器**之前**：面板第一屏就要看到默认铁律（1.2s 后播种会让首开空列表）。
    // marker 是判据，用户删/停用后重启不会重播；失败只记日志，不挡镜像/摘要自愈。
    try {
      const seeded = seedDefaultRules({ root: dir, log })
      if (seeded && seeded.ok === false) {
        log(`[whale-memory] rules seed skipped: ${seeded.error || 'error'}${seeded.skippedInvalid ? ` (invalid=${seeded.skippedInvalid})` : ''}`)
      } else if (seeded && seeded.seeded) {
        log(`[whale-memory] rules seeded defaults: ${seeded.seeded} (invalid=${seeded.skippedInvalid || 0})`)
      }
    } catch (err) {
      log(`[whale-memory] rules seed fail-open: ${err?.message || err}`)
    }
    const timer = setTimeout(() => {
      try {
        const listed = listRules(dir)
        if (!listed?.ok || !Array.isArray(listed.rules) || listed.rules.length === 0) return
        const mirror = mirrorRules({ backend: backendProxy, rules: listed.rules, log })
        if (mirror && mirror.ok === false) log(`[whale-memory] rules mirror self-heal skipped: ${mirror.error || mirror.code || 'error'}`)
        // 文件真源有变而 AGENTS 管理块存在 → 顺手校准摘要（无标记时 render 会返回 no_markers，静默跳过）。
        const agents = renderAgentsDigest({ rules: listed.rules, agentsPath: agentsPathOf(dir), rulesDir: dir, log })
        if (agents && agents.ok === false && agents.code !== 'no_markers') log(`[whale-memory] rules agents self-heal skipped: ${agents.code || agents.error || 'error'}`)
      } catch (err) {
        log(`[whale-memory] rules self-heal fail-open: ${err?.message || err}`)
      }
    }, 1200)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'whale-memory: rules self-heal')

  log(`[whale-memory] armed mode=${config?.backend?.mode || 'local'} backendReady=${Boolean(backend.ready)} hook=on`)
}
