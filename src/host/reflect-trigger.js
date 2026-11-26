/**
 * 反思触发（S4）：按「一个 turn 内有非 memory 工具活动的 distinct step 数 ≥7」触发反思。
 *
 * 依赖方向：host → host/identity（会话身份唯一判据）＋宿主事件；不 import core（reflect 由 index 注入）。
 * 状态只在进程内（每会话 turn/step 计数），不是排队动作；真正的反思任务由 keeper 持久化入队。
 *
 * 事件语义（rc.5 实测）：
 * - `agent/pre-step`（waterfall）每步一次，payload 带 `{turn, step, agent, signal}`；
 * - `tools/result`（emit）根工具调用带 `exec.agent`；PTC 子派发带 `exec.parent`（run_code 的子调用，
 *   不计入活动）；并行调用同一 step 只算一次；
 * - `agent/turn-stopping`（serial）turn 结束时派发；abort/error 时不派发，由下一次 pre-step 的
 *   turn 变化评估上一 turn（S4 契约）。
 */
import { isDelegatedHeader, sessionIdentityOf } from './identity.js'

/** 触发阈值：一个 turn 内 ≥7 个有工具活动的 distinct step。 */
export const MIN_TOOL_STEPS = 7

/** 不计入“工具活动”的工具名：元工具/委派本身不算干活（memory_* 另按前缀排除）。 */
const EXCLUDED_TOOLS = new Set(['run_code', 'subagent', 'subagent_fork'])

/**
 * 安装触发监听。
 *
 * @param {{
 *   ctx:any, getIdentityCfg:Function, getIdentityHint:Function, getHostUserId:Function,
 *   getHostIdentityState?:Function, reflect:{ scheduleAuto:(opts:object)=>object },
 *   log?:(line:string)=>void, maxSessions?:number,
 * }} deps
 * @returns {{ dispose: () => void, size: () => number }}
 */
export function installReflectTrigger({
  ctx, getIdentityCfg, getIdentityHint, getHostUserId, getHostIdentityState,
  reflect, log = () => {}, maxSessions = 128,
}) {
  const limit = Math.max(8, Math.floor(Number(maxSessions) || 128))
  /** @type {Map<string, { turn:number, step:number, steps:Set<number>, header:any, lastEvaluated:number|null }>} */
  const states = new Map()
  let disposed = false

  const identityOf = (header) => sessionIdentityOf({
    header, getIdentityCfg, getIdentityHint, getHostUserId, getHostIdentityState,
  })

  /**
   * 评估一个 turn（触发后锁存）：distinct step 数 ≥7 且身份可判定才交给单一自动闸。
   * 不足 7 **不锁存**：turn-stopping 可被 steer 后续同一 turn 继续（rc.5 serial 语义），
   * 若过早锁存，6 步时停止一次后同 turn 再走 4 步也会被吞掉。锁存只发生在"达到阈值并尝试派发"后。
   */
  const evaluate = (sid, state, turn, header) => {
    if (!state || !Number.isFinite(turn) || state.lastEvaluated === turn) return
    const steps = state.steps.size
    if (steps < MIN_TOOL_STEPS) return
    state.lastEvaluated = turn
    const ident = identityOf(header)
    if (!ident.ok) {
      log(`[whale-memory] reflect trigger turn=${turn} steps=${steps} skip=identity_required`)
      return
    }
    let out
    try {
      out = reflect.scheduleAuto({ identity: ident.identity, sessionId: sid, reason: 'turn_steps' })
    } catch (err) {
      log(`[whale-memory] reflect trigger fail-open: ${err?.message || err}`)
      return
    }
    const verdict = out?.ok ? (out.scheduled ? 'scheduled' : 'ran') : String(out?.reason || 'skipped')
    log(`[whale-memory] reflect trigger turn=${turn} steps=${steps} result=${verdict}`)
  }

  /** pre-step：维护当前 (turn,step)；turn 变化先评估上一 turn（含 abort/error 的补评估）。 */
  const onStep = (payload) => {
    const session = payload?.agent?.session
    const sid = String(session?.id || '')
    if (!sid) return
    const header = session?.header
    if (isDelegatedHeader(header)) return
    const turn = Number(payload?.turn)
    const step = Number(payload?.step)
    if (!Number.isFinite(turn) || !Number.isFinite(step)) return
    let state = states.get(sid)
    if (!state) {
      if (states.size >= limit) {
        // 有界兜底：淘汰最早的会话状态（不涉及材料，只是计数器；下次 pre-step 重建）。
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
      state = { turn, step, steps: new Set(), header, lastEvaluated: null }
      states.set(sid, state)
      return
    }
    if (turn !== state.turn) {
      evaluate(sid, state, state.turn, state.header)
      state.turn = turn
      state.steps.clear()
    }
    state.step = step
    state.header = header
  }

  /** tools/result：根调用才标记；memory_* 与 run_code、委派、PTC 子调用不计。 */
  const onToolResult = (exec) => {
    if (!exec || typeof exec !== 'object') return
    if (exec.parent) return
    const name = String(exec.name || '')
    if (!name || name.startsWith('memory_') || EXCLUDED_TOOLS.has(name)) return
    const session = exec.agent?.session
    const sid = String(session?.id || '')
    if (!sid) return
    if (isDelegatedHeader(session?.header)) return
    const state = states.get(sid)
    if (!state) return
    state.steps.add(state.step)
  }

  /** turn-stopping：正常收尾即评估；abort/error 不走这里，由下一次 pre-step 的 turn 变化补评估。 */
  const onTurnStopping = (payload) => {
    const session = payload?.agent?.session
    const sid = String(session?.id || '')
    if (!sid) return
    const state = states.get(sid)
    if (!state) return
    const turn = Number(payload?.turn)
    evaluate(sid, state, Number.isFinite(turn) ? turn : state.turn, session?.header || state.header)
  }

  const safe = (fn, label) => (arg) => {
    if (disposed) return
    try { fn(arg) } catch (err) { log(`[whale-memory] reflect trigger ${label} fail-open: ${err?.message || err}`) }
  }

  const offPre = ctx.on('agent/pre-step', async (payload, next) => {
    safe(onStep, 'pre-step')(payload)
    return next()
  })
  const offResult = ctx.on('tools/result', safe(onToolResult, 'tools/result'))
  const offStopping = ctx.on('agent/turn-stopping', safe(onTurnStopping, 'turn-stopping'))
  const offDisposed = typeof ctx.on === 'function'
    ? ctx.on('agent/disposed', ({ agent } = {}) => {
      const sid = String(agent?.session?.id || '')
      if (sid) states.delete(sid)
    })
    : null

  const dispose = () => {
    disposed = true
    offPre?.()
    offResult?.()
    offStopping?.()
    offDisposed?.()
    states.clear()
  }

  return { dispose, size: () => states.size }
}
