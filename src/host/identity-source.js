/**
 * 宿主身份来源（审计 §4 P1：身份 auto）。
 *
 * 两条独立能力，都是**只读、fail-open、不阻塞**：
 * 1. `deepseekAccount.getDeviceIdentity()` → `{ deviceId, userId, osVersion }`：
 *    只取 userId，5 分钟 TTL 缓存（避免每次召回都读本机登录态）；未登录/服务缺失/抛错
 *    一律回落空串，由 identity.js 按 Config/`local` 兜底。
 * 2. `deriveWorkspace(session.header)`：把会话工作目录规范化为记忆 `workspace` 维度。
 *    identity 的 workspace 以前只能来自 Config（现网恒 'web'），导致不同工作区共享分区；
 *    空 workspace 时改由会话 cwd 派生（同一工作区稳定、不同工作区不撞名）。
 *
 * 为什么用 `ctx.get('deepseekAccount')` 而不是写进 `inject`：
 * 本包要能在没有账号服务的老宿主上完整 apply；`inject` 会让插件一直等依赖而完全不加载，
 * 丢掉的不是"身份 auto"而是整个记忆插件。缺服务时这里返回空串，行为等同旧版。
 */
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'

/** 宿主 userId 缓存 TTL：5 分钟（登录/退登最多延迟一个 TTL 生效）。 */
export const DEFAULT_IDENTITY_TTL_MS = 300_000
/** workspace 长度上限（与 Config.identity.workspace 的 max(64) 同值）。 */
export const WORKSPACE_MAX = 64
const USER_ID_MAX = 128
/** 超长 workspace 的稳定压缩形式：`h:<sha256 前 16 位>:<尾部>`。 */
const HASH_PREFIX = 'h:'
const HASH_HEX = 16

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
 * @param {any} ctx cordis ctx（只用到可选 service 读取与 effect）
 * @param {{ log?: (line: string) => void, ttlMs?: number, now?: () => number }} [opts]
 * @returns {{ getUserId: () => string, refresh: () => Promise<string>, dispose: () => void }}
 *   `getUserId` 同步返回缓存值（可能为空），过期时在后台刷新，**绝不阻塞调用方**。
 */
export function installIdentitySource(ctx, { log = () => {}, ttlMs = DEFAULT_IDENTITY_TTL_MS, now = () => Date.now() } = {}) {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_IDENTITY_TTL_MS
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** @type {{ userId: string, at: number }} */
  let cached = { userId: '', at: -Infinity }
  /** @type {Promise<string> | null} */
  let inflight = null
  let disposed = false

  /** 取账号服务；老宿主没有这个服务（get 返回 undefined），一律当不可用。 */
  const account = () => {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      return ctx.get('deepseekAccount') || null
    } catch {
      return null
    }
  }

  /** 读一次宿主 userId；任何失败都回落 ''（未登录也是 ''）。 */
  const readOnce = async () => {
    const service = account()
    if (!service || typeof service.getDeviceIdentity !== 'function') return ''
    try {
      const info = await service.getDeviceIdentity()
      const userId = info && typeof info.userId === 'string' ? info.userId.trim() : ''
      return userId.slice(0, USER_ID_MAX)
    } catch (err) {
      log(`[whale-memory] identity source fail-open: ${err?.message || err?.name || 'error'}`)
      return ''
    }
  }

  /** 单飞刷新：并发调用共享同一个 in-flight promise，不叠读。 */
  const refresh = () => {
    if (disposed) return Promise.resolve('')
    if (inflight) return inflight
    inflight = readOnce()
      .then((userId) => {
        if (!disposed) cached = { userId: userId || '', at: clock() }
        return cached.userId
      })
      .catch((err) => {
        // readOnce 已吞业务错误；这里只兜未知异常，且不把缓存留在半更新态。
        log(`[whale-memory] identity source refresh fail-open: ${err?.message || err?.name || 'error'}`)
        return cached.userId
      })
      .finally(() => { inflight = null })
    return inflight
  }

  /** 同步读取（召回/hook 路径）：过期只触发后台刷新，本步用旧值/空值。 */
  const getUserId = () => {
    try {
      if (disposed) return ''
      if (clock() - cached.at >= ttl) void refresh().catch(() => {})
      return cached.userId || ''
    } catch {
      return ''
    }
  }

  const dispose = () => { disposed = true }

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

  return { getUserId, refresh, dispose }
}
