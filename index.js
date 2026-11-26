/**
 * dsh-whale-memory Host 入口（S1）。
 *
 * 职责边界（厂长令）：只做记忆的记与查；角色/对话属于独立插件，本包零引用。
 * S1 已接线：Config + 只读路由（stats/recent/search/recall-test）+ 召回注入 hook；
 * 本地记忆核心在 S2，面板五页签在 S3。
 */
import { createRoutes, PREFIX } from './src/host/routes.js'
import { installHook } from './src/host/hook.js'
import { installProfileContext } from './src/host/profile-context.js'
import { createBackend } from './src/core/backend.js'
import { Config } from './src/host/config.js'
import { installSearchFeed } from './src/host/search-feed.js'
import { installMemoryTools } from './src/host/tools.js'
import { installIdentitySource } from './src/host/identity-source.js'
import { deriveWorkspace, resolveIdentity } from './src/host/identity.js'
import { installConfigMigration } from './src/host/config-migration.js'
import { installReflectScheduler } from './src/core/reflect.js'
import { installKeeper } from './src/core/keeper.js'
import { installSessionCapture } from './src/host/session-capture.js'
import { installSessionWrap } from './src/host/session-wrap.js'
import { installOutboxWatchdog } from './src/core/hybrid.js'
import { defaultRuleRoot, listRules } from './src/core/rule-store.js'
// 命名空间导入：仓库锁/事务恢复按 R8 契约在 task-1 落地，插件必须在已落地/未落地两种
// 安装状态下都能加载（命名导入缺失会在 ESM link 阶段直接抛，插件起不来）。
import * as ruleStore from './src/core/rule-store.js'
import { seedDefaultRules } from './src/core/rule-defaults.js'
import { mirrorRules } from './src/core/rule-mirror.js'
import { agentsPathOf, renderAgentsDigest } from './src/core/rule-render.js'
import { bool, num } from './src/shared/config-values.js'

export { Config }
export const inject = ['webServer', 'systemPrompt', 'tools']

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

/**
 * 规则启动自愈（R8-06/R8-10）：崩溃恢复 → 默认播种 → 镜像 → AGENTS 摘要。
 *
 * - 镜像只受 `rules.mirrorAuto` 控制，摘要只受 `rules.renderAgents` 控制，互不绑定；
 * - 每一步独立 fail-open：某步失败只记日志，不影响后续步骤（启动不能被规则仓拖死）；
 * - `recoverPendingTxn` 由 task-1 按契约落地，未落地时静默跳过（命名空间属性探测，不抛）；
 * - 播种在后台（init 不再同步写 16 个文件 + git），marker 是判据，用户删/停用后不重播。
 *
 * @param {{config:any, backend:any, log?:Function, store?:any}} [deps]
 *   store 默认真实 rule-store；测试注入 fake 以断言 recoverPendingTxn 接线。
 *   `rules.createAgentsIfMissing`（默认 true）控制「宿主无 AGENTS.md 时创建最小管理块」。
 * @returns {Promise<{skipped?:string, dir:string, rules:number, recovered?:object|null,
 *   seeded?:object|null, mirror?:object|null, agents?:object|null}>}
 *   async 原因：播种逐文件让出事件循环（R9-21b），调用方必须接住 Promise（启动处已 catch）。
 */
export async function runRulesSelfHeal({ config, backend, log = () => {}, store = ruleStore } = {}) {
  const dir = String(config?.rules?.dir || '').trim() || defaultRuleRoot()
  const result = { dir, rules: 0, recovered: null, seeded: null, mirror: null, agents: null }
  if (bool(config?.rules?.enabled, true) === false) return { ...result, skipped: 'rules_disabled' }

  // 0) 崩溃恢复：未完成事务先恢复旧文件，后面的镜像/摘要才看到真源。
  if (typeof store.recoverPendingTxn === 'function') {
    try {
      result.recovered = store.recoverPendingTxn(dir, { log })
      if (result.recovered?.skipped === 'repo_locked') {
        // 另一个进程正在写规则仓：不抢着播种/镜像/渲染，避免把在飞事务的状态固化。
        log('[whale-memory] rules txn recovery skipped: repo locked by another process')
        return { ...result, skipped: 'repo_locked' }
      }
      if (result.recovered && result.recovered.recovered) {
        log(`[whale-memory] rules txn recovered id=${result.recovered.id || '-'}`)
      }
      if (result.recovered && result.recovered.failed) {
        // 恢复失败：.txn 已保留，health 会红；此时继续播种/镜像/摘要会把混合态固化，
        // 必须停在恢复前状态，等下一次启动或人工处置。
        log('[whale-memory] rules txn recovery failed：跳过播种/镜像/摘要（health 红）')
        return { ...result, skipped: 'txn_recovery_failed' }
      }
    } catch (err) {
      log(`[whale-memory] rules txn recover fail-open: ${err?.message || err}`)
    }
  }

  // 0.5) 恢复后无条件重建 manifest：它是生成物，幂等；purge 的“文件已删/manifest 未重建”
  //      崩溃窗口靠这一步收敛（health 不再永久红，下一次写入也不用先踩一次 ensure）。
  try {
    const rebuilt = store.regenerateManifest(dir)
    if (!rebuilt.ok) log(`[whale-memory] rules manifest rebuild failed: ${rebuilt.error || 'unknown'}`)
  } catch (err) {
    log(`[whale-memory] rules manifest rebuild fail-open: ${err?.message || err}`)
  }

  // 1) 默认铁律播种（后台；播种本身不阻塞 init）。
  try {
    result.seeded = await seedDefaultRules({ root: dir, log }, {
      // 播种与面板/提案同口径（R9-05）：requireGit=true 且缺 git 时不播、不写 marker。
      gitRequired: Boolean(config?.rules?.requireGit),
    })
    if (result.seeded && result.seeded.ok === false) {
      log(`[whale-memory] rules seed skipped: ${result.seeded.error || 'error'}${result.seeded.skippedInvalid ? ` (invalid=${result.seeded.skippedInvalid})` : ''}`)
    } else if (result.seeded && result.seeded.seeded) {
      log(`[whale-memory] rules seeded defaults: ${result.seeded.seeded} (invalid=${result.seeded.skippedInvalid || 0})`)
    }
  } catch (err) {
    log(`[whale-memory] rules seed fail-open: ${err?.message || err}`)
  }

  // 2) 一次读盘，镜像与摘要共用同一批规则（避免两次 listRules 读到不同快照）。
  let listed = null
  try {
    listed = listRules(dir)
  } catch (err) {
    log(`[whale-memory] rules list fail-open: ${err?.message || err}`)
  }
  // list 失败 ≠ 空仓：失败时不能把“读不到”当“没有规则”去归档镜像（会误归档全部）。
  if (!listed?.ok || !Array.isArray(listed.rules)) return result
  result.rules = listed.rules.length

  // 3) 镜像自愈：只看 rules.mirrorAuto。空列表也要跑——purge/删光规则后镜像必须归档孤儿，
  //    否则 DB 里会留下“文件已不存在但还能被统计/召回”的幽灵规则。
  //    注意：以上分流靠 list.ok；list 失败已在上一行 return。
  if (bool(config?.rules?.mirrorAuto, true)) {
    try {
      result.mirror = mirrorRules({ backend, rules: listed.rules, log })
      if (result.mirror && result.mirror.ok === false) {
        log(`[whale-memory] rules mirror self-heal skipped: ${result.mirror.error || result.mirror.code || 'error'}`)
      }
    } catch (err) {
      log(`[whale-memory] rules mirror fail-open: ${err?.message || err}`)
    }
  }

  // 4) AGENTS 摘要自愈：只看 rules.renderAgents（无标记时 render 返回 no_markers，静默跳过）。
  // 干净安装：宿主还没有 AGENTS.md 时创建最小管理块（否则默认铁律在 AGENTS 里完全不可见）。
  // 开关 `rules.createAgentsIfMissing`（默认开）：只在启动自愈里生效，面板手动渲染不创建。
  if (bool(config?.rules?.renderAgents, true) && listed.rules.length > 0) {
    try {
      result.agents = renderAgentsDigest({
        rules: listed.rules,
        agentsPath: agentsPathOf(dir),
        rulesDir: dir,
        createIfMissing: bool(config?.rules?.createAgentsIfMissing, true),
        budgetChars: Number(config?.rules?.summaryBudgetChars) > 0
          ? Math.floor(Number(config.rules.summaryBudgetChars))
          : 6000,
        log,
      })
      if (result.agents && result.agents.ok === false && result.agents.code !== 'no_markers') {
        log(`[whale-memory] rules agents self-heal skipped: ${result.agents.code || result.agents.error || 'error'}`)
      }
    } catch (err) {
      log(`[whale-memory] rules agents fail-open: ${err?.message || err}`)
    }
  }
  return result
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
  // write job 的唯一消费者是写队列（构造/重试都在 writer 内）；keeper 只做启动补偿：
  // 进程重启后遗留的 queued 写 job 要被续跑，不能等下一次用户写入才处理。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const task = backendProxy.drainWrites?.()
        if (task && typeof task.then === 'function') {
          task.catch((err) => log(`[whale-memory] write queue startup drain fail-open: ${err?.message || err}`))
        }
      } catch (err) {
        log(`[whale-memory] write queue startup drain fail-open: ${err?.message || err}`)
      }
    }, 800)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'whale-memory: write queue recovery')
  // 大导入的崩溃续跑：jobs 里 cursor 已 durable，恢复器把 running 复位 queued 后由这里接着跑。
  keeper.register('import', async (payload, api) => {
    if (typeof backendProxy.resumeImportJob !== 'function') return { skipped: 'import_unavailable' }
    const out = await backendProxy.resumeImportJob(api?.jobId)
    // ok:false 必须抛出，让 keeper 走退避重试（cursor 已回退到失败批首），不能当成功标 done。
    if (out && out.ok === false) throw new Error(String(out.error || 'import_failed'))
    return out
  })

  const reflect = installReflectScheduler(ctx, {
    backend: backendProxy, config, keeper,
    getLlm: () => ctx.get('llm'),
    getSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
    // 后台反思没有会话 cwd；用当前登录/角色 hint 的分区，绝不写回共享 '' 洗白私有事实。
    getIdentity: () => resolveIdentity(getIdentityCfg(), getIdentityHint(), getHostUserId(), ''),
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

  installSearchFeed(ctx, {
    backend: backendProxy, config, log,
    getIdentityCfg, getIdentityHint, getHostUserId,
  })

  // 模型侧记忆工具面（S2）：五工具注册 + 每回合写限次；身份与收尾/召回同一套 getter。
  // 注册在 ctx.effect 里：插件卸载时逐个反注册并清 pre-step 监听。
  ctx.effect(() => {
    const tools = installMemoryTools({
      ctx, backend: backendProxy, config, log,
      getIdentityCfg, getIdentityHint, getHostUserId,
    })
    return () => tools.dispose()
  }, 'whale-memory: memory tools')

  // 会话收尾（Session Wrap）：采集器 → 服务编排（keeper `wrap` job）。
  // captureRef 是回指：服务成功后要推进采集缓冲；采集器触发时调用服务 onTrigger。
  const captureRef = { current: null }
  const wrap = installSessionWrap(ctx, {
    backend: backendProxy, config, keeper, log, captureRef,
    getLlm: () => ctx.get('llm'),
    getSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
  })
  // http 后端没有本地 run 台账：不装采集器，避免把会话正文留在内存（面板仍会显示不支持）。
  if (wrap.supported) {
    captureRef.current = installSessionCapture(ctx, {
      config, log,
      getIdentity: (header) => resolveIdentity(
        getIdentityCfg(), getIdentityHint(), getHostUserId(), deriveWorkspace(header),
      ),
      onTrigger: wrap.onTrigger,
      canTriggerAuto: wrap.canAutoTrigger,
    })
  }
  const handler = createRoutes({
    config, backend: backendProxy, getIdentityCfg, getIdentityHint, getHostUserId, identityState,
    migration, ctx, reflect, wrap, log,
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'whale-memory: routes')

  // backend 生命周期：worker 线程与 SQLite 连接随插件 dispose 收尾。
  // 只销毁本插件自己建的 backend；registerBackend 换进来的外部实现归注入方管。
  ctx.effect(() => () => { reflect.dispose(); backend.dispose?.() }, 'whale-memory: backend')

  ctx.effect(() => {
    hook = installHook(ctx, { backend: backendProxy, config, getIdentityCfg, getIdentityHint, getHostUserId, identityState, log })
    return () => hook?.dispose()
  }, 'whale-memory: recall hook')

  // 首轮画像（S3）：每会话一次、装配零 IO；与召回各用各的 context 名（129 < 130）。
  ctx.effect(() => {
    const profile = installProfileContext({ ctx, backend: backendProxy, getIdentityCfg, getIdentityHint, getHostUserId, log })
    return () => profile.dispose()
  }, 'whale-memory: profile context')

  // 规则文件启动自愈（R7/R8）：规则真源在文件仓，DB 镜像/AGENTS 摘要只是投影。
  // init 只建定时器；恢复/播种/镜像/摘要全部放到后台执行（不阻塞 DSH 启动）。
  ctx.effect(() => {
    if (bool(config?.rules?.enabled, true) === false) return () => {}
    const timer = setTimeout(() => {
      try {
        // 自愈本身 async（播种逐文件让出事件循环）：拒绝必须显式接住，不能留 unhandledRejection。
        const task = runRulesSelfHeal({ config, backend: backendProxy, log })
        if (task && typeof task.then === 'function') {
          task.catch((err) => log(`[whale-memory] rules self-heal fail-open: ${err?.message || err}`))
        }
      } catch (err) {
        log(`[whale-memory] rules self-heal fail-open: ${err?.message || err}`)
      }
    }, 1200)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'whale-memory: rules self-heal')

  log(`[whale-memory] armed mode=${config?.backend?.mode || 'local'} backendReady=${Boolean(backend.ready)} hook=on`)
}
