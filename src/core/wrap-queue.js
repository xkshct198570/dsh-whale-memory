// 职责：收尾“点击即排队”的进程内队列（顺序/位次/上限/超时清理）；依赖：零 import。
//
// 为什么是内存队列而不是 DB 队列（总纲 §5.1，厂长已拍板）：排队项如果落 DB 并由 keeper 续跑，
// 插件重启后会静默继续烧模型。这里把顺序放内存，业务状态行仍在 wrap_runs（可对账）；
// 重启后残留 queued run 由启动清扫标 failed/queue_cleared 并在 UI 明示“队列已清理”，
// 不静默、不续跑。铁律 3 的“落库并挂守护”由 wrap_runs + keeper + 启动清扫共同满足。
//
// 边界：本模块只做队列代数，不建 run/不写 spool/不碰 keeper；由 session-wrap 组装。

/** 排队超时：超过 30 分钟仍未开跑 → 出队并记 queue_timeout（总纲 §5.1）。 */
export const WRAP_QUEUE_TIMEOUT_MS = 30 * 60 * 1000
/** 全局排队上限默认值（不同会话；同会话恒 ≤1）。 */
export const WRAP_QUEUE_MAX_DEFAULT = 8

/**
 * @param {{ maxQueued?: number, timeoutMs?: number }} [opts]
 * @returns {{
 *   canAccept: (sessionId:string) => {ok:boolean, reason?:string},
 *   enqueue: (entry:{sessionId:string, runId:number, materialHash:string, at?:number}) => {ok:boolean, position?:number, reason?:string},
 *   hasSession: (sessionId:string) => boolean,
 *   positionOf: (runId:number) => number|null,
 *   head: () => object|null,
 *   size: () => number,
 *   removeByRun: (runId:number) => boolean,
 *   removeBySession: (sessionId:string) => boolean,
 *   sweep: (opts:{now?:number, disposed?:(sessionId:string)=>boolean}) => Array<object>,
 *   clear: () => void,
 *   snapshot: () => {count:number, sessions:string[]},
 * }}
 */
export function createWrapQueue({ maxQueued = WRAP_QUEUE_MAX_DEFAULT, timeoutMs = WRAP_QUEUE_TIMEOUT_MS } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxQueued) || WRAP_QUEUE_MAX_DEFAULT))
  const maxAge = Math.max(1000, Number(timeoutMs) || WRAP_QUEUE_TIMEOUT_MS)
  /** @type {Map<string, {sessionId:string, runId:number, materialHash:string, enqueuedAt:number}>} */
  const bySession = new Map()
  /** FIFO 顺序（runId 数组）；位次=下标+1。 */
  let order = []

  const positionOf = (runId) => {
    const index = order.indexOf(Number(runId))
    return index < 0 ? null : index + 1
  }

  const canAccept = (sessionId) => {
    if (bySession.has(String(sessionId))) return { ok: false, reason: 'session_queue_full' }
    if (order.length >= limit) return { ok: false, reason: 'busy_queue_full' }
    return { ok: true }
  }

  const enqueue = ({ sessionId, runId, materialHash, at = Date.now() } = {}) => {
    const sid = String(sessionId || '')
    const rid = Number(runId)
    if (!sid || !Number.isInteger(rid) || rid <= 0) return { ok: false, reason: 'invalid_entry' }
    const gate = canAccept(sid)
    if (!gate.ok) return gate
    const stamp = Number(at)
    const entry = { sessionId: sid, runId: rid, materialHash: String(materialHash || ''), enqueuedAt: Number.isFinite(stamp) ? stamp : Date.now() }
    bySession.set(sid, entry)
    order.push(rid)
    return { ok: true, position: order.length }
  }

  const head = () => {
    for (const rid of order) {
      for (const entry of bySession.values()) if (entry.runId === rid) return entry
    }
    return null
  }

  const removeByRun = (runId) => {
    const rid = Number(runId)
    const index = order.indexOf(rid)
    if (index < 0) return false
    order = order.slice(0, index).concat(order.slice(index + 1))
    for (const [sid, entry] of bySession) if (entry.runId === rid) bySession.delete(sid)
    return true
  }

  const removeBySession = (sessionId) => {
    const entry = bySession.get(String(sessionId))
    return entry ? removeByRun(entry.runId) : false
  }

  /**
   * 清理超时/会话已销毁的排队项。
   * @returns {Array<{sessionId:string, runId:number, reason:'queue_timeout'|'session_disposed'}>}
   */
  const sweep = ({ now = Date.now(), disposed = () => false } = {}) => {
    const removed = []
    for (const [sid, entry] of [...bySession]) {
      const reason = (now - entry.enqueuedAt) > maxAge ? 'queue_timeout'
        : (typeof disposed === 'function' && disposed(sid) ? 'session_disposed' : '')
      if (!reason) continue
      removeByRun(entry.runId)
      removed.push({ sessionId: sid, runId: entry.runId, reason })
    }
    return removed
  }

  const clear = () => { bySession.clear(); order = [] }
  const snapshot = () => ({ count: order.length, sessions: [...bySession.keys()] })

  return {
    canAccept, enqueue, hasSession: (sid) => bySession.has(String(sid)),
    positionOf, head, size: () => order.length, removeByRun, removeBySession, sweep, clear, snapshot,
    get limit() { return limit },
  }
}
