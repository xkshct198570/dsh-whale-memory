// 职责：模型写工具的每回合尝试次数闸（turn 键来自 agent/pre-step；进程内存态，随会话释放）。
// 依赖方向：只 import 宿主事件（注入的 ctx）与日志；由 host/tools.js 安装/查询；不 import DB/路由。

/**
 * 每个会话的 turn 计数槽；turn 变化即清零（不用 turn-stopping：abort/error 时不派发）。
 * @typedef {{ turn: number, count: number }} TurnSlot
 */

/**
 * 安装每回合写限次器。
 *
 * 判据（架构书 §5.2）：写工具每次进入写路径前 +1；计数 > 上限的那次抛 RATE_LIMITED。
 * 键取会话 id + `agent/pre-step` 的 turn：同一 turn 多 step 累计，下一 turn 自然清零。
 *
 * @param {{ ctx: any, log?: (line: string) => void }} deps ctx 只用于监听宿主事件；缺 on 时降级为"不清零"并留日志
 * @returns {{ attempt: (sessionId: string, max: number) => { allowed: boolean, count: number, max: number }, size: () => number, dispose: () => void }}
 */
export function createWriteRateLimiter({ ctx, log = () => {} } = {}) {
  /** @type {Map<string, TurnSlot>} */
  const slots = new Map()
  let disposed = false

  /**
   * 记录 step 所属 turn；turn 变了就从 0 开始。
   * @param {any} payload
   */
  const seed = (payload) => {
    const sessionId = payload?.agent?.session?.id
    if (!sessionId) return
    const turn = Number(payload?.turn)
    if (!Number.isFinite(turn)) return
    const key = String(sessionId)
    const prev = slots.get(key)
    if (!prev || prev.turn !== turn) slots.set(key, { turn, count: 0 })
  }

  let offPre = null
  let offDisposed = null
  if (typeof ctx?.on === 'function') {
    offPre = ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (!disposed) seed(payload)
      } catch (err) {
        // 计数失败不能拦断回合：只是这一轮可能少算一次写，必须留痕而不是静默。
        log(`[whale-memory] tool write limit seed fail-open: ${err?.message || err}`)
      }
      return next()
    })
    offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => {
      const sessionId = agent?.session?.id
      if (sessionId) slots.delete(String(sessionId))
    })
  } else {
    log('[whale-memory] no agent/pre-step listener: tool write limit will not reset per turn')
  }

  return {
    /**
     * 记一次写尝试。
     * @param {string} sessionId
     * @param {number} max 每回合上限（≥1）
     * @returns {{ allowed: boolean, count: number, max: number }} allowed=false 表示这次已超限
     */
    attempt(sessionId, max) {
      const cap = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.trunc(Number(max)) : 5
      const key = String(sessionId || '')
      const slot = slots.get(key) || { turn: -1, count: 0 }
      slot.count += 1
      slots.set(key, slot)
      return { allowed: slot.count <= cap, count: slot.count, max: cap }
    },

    /** 当前跟踪的会话数（测试/诊断用）。 */
    size() {
      return slots.size
    },

    dispose() {
      if (disposed) return
      disposed = true
      slots.clear()
      try { offPre?.() } catch { /* 宿主已卸载：忽略 */ }
      try { offDisposed?.() } catch { /* 同上 */ }
    },
  }
}
