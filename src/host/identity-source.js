/**
 * 宿主身份来源（审计 §4 P1：身份 auto）。
 *
 * 两条独立能力，都是**只读、fail-open、不阻塞**：
 * 1. `deepseekAccount.getDeviceIdentity()` → `{ deviceId, userId, osVersion }`：
 *    只取 userId，5 分钟 TTL 缓存（避免每次召回都读本机登录态）；未登录/服务缺失/抛错
 *    回落空串。**四态显式**（S4 架构书 §5.5.1）：`absent`（无服务）/`pending`（首次读取未落定，
 *    或读取异常待重试）/`empty`（已落定无 id）/`ready`（有 id）。`auto` 只在 `absent` 允许
 *    Config/hint 回落；`pending/empty` 一律 `identity_required`，禁止写临时分区。
 * 2. `deriveWorkspace(session.header)`：把会话工作目录规范化为记忆 `workspace` 维度。
 *    identity 的 workspace 以前只能来自 Config（现网恒 'web'），导致不同工作区共享分区；
 *    空 workspace 时改由会话 cwd 派生（同一工作区稳定、不同工作区不撞名）。
 *
 * 为什么用 `ctx.get('deepseekAccount')` 而不是写进 `inject`：
 * 本包要能在没有账号服务的老宿主上完整 apply；`inject` 会让插件一直等依赖而完全不加载，
 * 丢掉的不是"身份 auto"而是整个记忆插件。缺服务时 `absent`，行为等同旧版。
 */
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'

/** 宿主 userId 缓存 TTL：5 分钟（重新探测账号态；分区稳定性由 `pending/empty` 拒绝保证）。 */
export const DEFAULT_IDENTITY_TTL_MS = 300_000
/** 单次宿主身份读取超时（ms）：无超时会让 pending 永久（TTL 重试无法结算）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000
/** workspace 长度上限（与 Config.identity.workspace 的 max(64) 同值）。 */
export const WORKSPACE_MAX = 64
const USER_ID_MAX = 128
/** 超长 workspace 的稳定压缩形式：`h:<sha256 前 16 位>:<尾部>`。 */
const HASH_PREFIX = 'h:'
const HASH_HEX = 16

/** 宿主身份四态（架构书 §5.5.1）：auto 只在 absent 允许 Config/hint 回落。 */
export const HOST_STATES = Object.freeze(['absent', 'pending', 'empty', 'ready'])

/**
 * 从会话 header 派生记忆 workspace。
 *
 * 不用 basename：`/work` 与 `/work/sub` 会撞成同一个分区。这里保留**规范化绝对路径**
 * 作为分区键（现网 Config workspace 是 'web'，语义由用户自定，路径同样只是字符串）。
 * 超长路径压缩成 `h:<sha256(abs)[0:16]>:<尾部>`，同一路径永远得到同一串。
 *
 * @param {{ cwd?: unknown } | null | undefined} header 会话 header（hook 的 `agent.session.header`）
 * @param {{ maxLen?: number }} [opts]
 * @returns {string} 绝对路径 / 压缩形式 / ''（无 cwd 或异常）
 */
export function deriveWorkspace(header, { maxLen = WORKSPACE_MAX } = {}) {
  try {
    const cwd = header && typeof header === 'object' ? header.cwd : undefined
    if (typeof cwd !== 'string') return ''
    const raw = cwd.trim()
    if (!raw) return ''
    let abs = resolve(raw)
    // 根目录保留 '/'，其余去掉尾部多余分隔符（resolve 已归一，这里只防病态输入）。
    if (abs.length > 1) abs = abs.replace(/[\\/]+$/, '') || sep
    const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) >= 8 ? Number(maxLen) : WORKSPACE_MAX
    if (abs.length <= limit) return abs
    const hash = createHash('sha256').update(abs).digest('hex').slice(0, HASH_HEX)
    const prefix = `${HASH_PREFIX}${hash}:`
    const tailLen = Math.max(1, limit - prefix.length)
    return (prefix + abs.slice(-tailLen)).slice(0, limit)
  } catch {
    return ''
  }
}

/**
 * 安装宿主身份来源（只读；随 ctx.effect 生命周期收尾）。
 *
 * 状态机（唯一实现，供 identity.js 判定分区可用性）：
 * - `absent`：没有 `deepseekAccount` / 没有 `getDeviceIdentity`；`getUserId()` 返回缓存（通常空），
 *   身份链允许落到 Config/`local`（稳定身份，不会中途变成宿主 id）。
 * - `pending`：服务在、首次读取未落定；读异常回 `pending`（下一 TTL 重试）而不是冒充 `empty`。
 * - `empty`：读取成功但没有 userId（未登录）；**已落定**，不得回落出临时分区。
 * - `ready`：有 userId；TTL 刷新期间沿用旧值，账号切换时更新并记一条无正文日志。
 *
 * @param {any} ctx cordis ctx（只用到可选 service 读取与 effect）
 * @param {{ log?: (line: string) => void, ttlMs?: number, now?: () => number }} [opts]
 * @returns {{ getUserId: () => string, getState: () => 'absent'|'pending'|'empty'|'ready',
 *   refresh: () => Promise<string>, dispose: () => void }}
 *   `getUserId` 同步返回当前值（未就绪为空），过期时在后台刷新，**绝不阻塞调用方**。
 */
export function installIdentitySource(ctx, {
  log = () => {}, ttlMs = DEFAULT_IDENTITY_TTL_MS, now = () => Date.now(), probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_IDENTITY_TTL_MS
  const probeTimeout = Number(probeTimeoutMs) >= 0 ? Number(probeTimeoutMs) : DEFAULT_PROBE_TIMEOUT_MS
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** 是否见过账号服务：区分"从未有服务（absent，可稳定回落）"与"曾有服务后消失（不得回落出第二分区）"。 */
  let everHadService = false
  let serviceLostLogged = false
  /** @type {{ phase: 'absent'|'pending'|'empty'|'ready', userId: string, at: number }} */
  let state = { phase: 'absent', userId: '', at: -Infinity }
  /** @type {Promise<string> | null} */
  let inflight = null
  let disposed = false

  /** 取账号服务；老宿主没有这个服务（get 返回 undefined），一律当不可用。 */
  const account = () => {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const service = ctx.get('deepseekAccount') || null
      return service && typeof service.getDeviceIdentity === 'function' ? service : null
    } catch {
      return null
    }
  }

  /**
   * 带超时的读取：账号服务可能挂在 credentials/平台会话 IO 上；无超时会让 `inflight`
   * 永不 settle、`pending` 永久，TTL 重试形同虚设（全插件记忆面 fail-closed）。
   * @param {Promise<any>} promise
   * @param {number} ms 0/负数 = 不设超时
   * @returns {Promise<any>}
   */
  const withTimeout = async (promise, ms) => {
    if (!(ms > 0)) return promise
    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    // 定时器必须保持引用：超时是这个 race 唯一的结算者，unref 会让「宿主 promise 永不 resolve」
    // 时事件循环直接排空（Node 22 的 test runner 会判 cancelledByParent，生产里退出阶段也可能
    // 让 pending 永远不结算）。代价只是进程退出时最多多等一个 probeTimeout（4s），且仅在探测在途时。
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('identity_probe_timeout'), { name: 'TimeoutError' })), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 读一次宿主 userId。返回三态：service 缺失 / 读取异常（含超时）/ 成功（userId 可空）。
   * 异常必须与"未登录"分开：前者留 `pending` 待重试，后者是已落定的 `empty`。
   */
  const readOnce = async () => {
    const service = account()
    if (!service) return { kind: 'absent' }
    everHadService = true
    try {
      const info = await withTimeout(Promise.resolve(service.getDeviceIdentity()), probeTimeout)
      const userId = info && typeof info.userId === 'string' ? info.userId.trim() : ''
      return { kind: 'ok', userId: userId.slice(0, USER_ID_MAX) }
    } catch (err) {
      log(`[whale-memory] identity source fail-open: ${err?.message || err?.name || 'error'}`)
      return { kind: 'error' }
    }
  }

  /** 服务在"曾就绪"后消失：这是来源变化，留在原已落定态（ready 用缓存 id / empty 继续拒），不回落 Config。 */
  const markServiceLost = () => {
    if (!everHadService || serviceLostLogged) return
    serviceLostLogged = true
    log(`[whale-memory] identity source disappeared: keep phase=${state.phase} (no Config fallback for this process)`)
  }

  /** 单飞刷新：并发调用共享同一个 in-flight promise，不叠读。 */
  const refresh = () => {
    if (disposed) return Promise.resolve('')
    if (inflight) return inflight
    inflight = readOnce()
      .then((got) => {
        if (disposed) return state.userId
        if (got.kind === 'absent') {
          // 服务从未出现过 → absent（Config 是稳定身份）；曾就绪后消失 → 保留已落定态，绝不产出第二分区。
          if (!everHadService) state = { phase: 'absent', userId: '', at: clock() }
          else markServiceLost()
        } else if (got.kind === 'error') {
          // 读取异常：已有可用值继续用；从未落定时保持 pending（下一 TTL 重试），不得冒充 empty。
          state = state.phase === 'ready'
            ? { ...state, at: clock() }
            : { phase: 'pending', userId: '', at: clock() }
        } else {
          const prevPhase = state.phase
          const prev = state.phase === 'ready' ? state.userId : ''
          state = { phase: got.userId ? 'ready' : 'empty', userId: got.userId, at: clock() }
          // 来源状态迁移（含登出 ready→empty、登录 empty→ready）必须可见：它改变"能不能写记忆"。
          if (prevPhase !== state.phase && (prevPhase === 'ready' || prevPhase === 'empty' || state.phase === 'empty')) {
            log(`[whale-memory] identity source state=${prevPhase}->${state.phase}`)
          }
          // 账号切换是显式事件：分区会随之变化，必须留可见证据（无正文）。
          if (prev && state.userId && prev !== state.userId) {
            log('[whale-memory] identity source changed: host userId switched (new partition for subsequent writes)')
          }
        }
        return state.userId
      })
      .catch((err) => {
        // readOnce 已吞业务错误；这里只兜未知异常，且不把缓存留在半更新态。
        log(`[whale-memory] identity source refresh fail-open: ${err?.message || err?.name || 'error'}`)
        return state.userId
      })
      .finally(() => { inflight = null })
    return inflight
  }

  /** 同步读取（召回/hook 路径）：过期只触发后台刷新，本步用旧值/空值。 */
  const getUserId = () => {
    try {
      if (disposed) return ''
      if (clock() - state.at >= ttl) void refresh().catch(() => {})
      return state.phase === 'ready' ? state.userId : ''
    } catch {
      return ''
    }
  }

  /** 四态同步读取：identity.js 据此决定 auto 是否允许回落。 */
  const getState = () => {
    if (disposed) return /** @type {'absent'} */ ('absent')
    if (!account()) {
      // 从未有过服务 → absent（可稳定回落）；曾有服务后消失 → 保留已落定态（ready 缓存 id / empty 继续拒）。
      if (!everHadService) return /** @type {'absent'} */ ('absent')
      markServiceLost()
      return state.phase
    }
    everHadService = true
    serviceLostLogged = false
    // 服务在启动后出现（插件热装/加载顺序）：从 absent 升为 pending 并触发一次读取，绝不直接当 ready。
    // 留一条无正文日志：这是"分区来源变化"这类必须可见的事件。
    if (state.phase === 'absent') {
      state = { phase: 'pending', userId: '', at: -Infinity }
      log('[whale-memory] identity source appeared: host identity pending (no provisional partition)')
      void refresh().catch(() => {})
    }
    return state.phase
  }

  const dispose = () => {
    disposed = true
    state = { phase: 'absent', userId: '', at: -Infinity }
  }

  const initial = account()
  if (initial) {
    everHadService = true
    state = { phase: 'pending', userId: '', at: -Infinity }
    if (ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => {
          void refresh().catch(() => {})
          return () => dispose()
        }, 'whale-memory: identity source')
      } catch (err) {
        log(`[whale-memory] identity source install fail-open: ${err?.message || err?.name || 'error'}`)
      }
    } else {
      void refresh().catch(() => {})
    }
  }

  return { getUserId, getState, refresh, dispose }
}
