/**
 * 记忆召回注入（fail-open）。
 *
 * 时序（别改回 section）：pre-step 写缓存 → systemPrompt.context 在 step() 的
 * refreshContext 阶段再求值 → 本轮请求就能带上召回文本；角色展示由独立插件用 section 注入，
 * 记忆用 context（本包），两者职责不混。
 *
 * 生命周期硬线（P-4）：整个安装包在 ctx.effect 内；每次请求带 AbortController；
 * dispose 时中止在途、清缓存、返回空文本；任何失败只记日志，绝不抛。
 */
import { deriveWorkspace, resolveIdentity } from './identity.js'
import { bool, num, value } from './config-values.js'
import { judgeReply } from '../core/adoption.js'

export const CONTEXT_NAME = 'whale-memory:recall'
export const CONTEXT_ORDER = 100
const CACHE_TTL_MS = 120_000
const MAX_QUERY_CHARS = 2000
/** 单步回复累积上限：只用于采纳判定，超出部分不影响回复本身。 */
const REPLY_BUF_MAX = 16_384

/**
 * 取最后一条用户消息的文本块。
 * @param {Array<any>} messages
 * @param {number} [maxChars]
 * @returns {string}
 */
export function extractQuery(messages, maxChars = MAX_QUERY_CHARS) {
  if (!Array.isArray(messages)) return ''
  let last = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.source && m.source.kind === 'user') { last = m; break }
  }
  if (!last) return ''
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim()
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** @param {Map<string,{text:string,exp:number}>} cache @param {unknown} sessionId */
function readCached(cache, sessionId) {
  if (!sessionId) return ''
  const key = String(sessionId)
  const entry = cache.get(key)
  if (!entry) return ''
  if (!entry.text || Date.now() >= entry.exp) { cache.delete(key); return '' }
  return entry.text
}

/**
 * @param {any} ctx
 * @param {{ backend: any, config: any, getIdentityCfg?: () => any, getIdentityHint?: () => any,
 *   getHostUserId?: () => string, log?: (s:string)=>void }} deps
 * @returns {{ cache: Map<string,{text:string,exp:number}>, dispose: () => void }}
 */
export function installHook(ctx, {
  backend, config,
  getIdentityCfg = () => config?.identity,
  getIdentityHint = () => null,
  getHostUserId = () => '',
  log = () => {},
}) {
  const cache = new Map()
  const inflight = new Set()
  /**
   * 待判定的注入与回复文本，**按会话单槽**而不是 (turn,step) 复合键。
   * why：pre-step 的 turn/step 与 assistant-stream 帧的编号不保证同源同偏移，
   * 用复合键错位就会静默结算不到（证据在，但永远判不出来）。每步 pre-step 都会
   * 重置文本并重新登记，粒度仍是「一步」，但不再赌两个字段的编号一致。
   */
  const pending = new Map()
  const replyBuf = new Map()
  let disposed = false

  const timeoutMs = num(config?.recall?.timeoutMs, 2000)
  /**
   * 注入层级（volatile 数组 ⇒ Ref，必须每次现取）：undefined 表示"配置里没有这一项"，
   * 交给 backend 不过滤（旧调用方兼容）；数组就原样下传（空数组=不注入）。
   */
  const injectLevels = () => {
    const raw = value(config?.recall?.injectLevels, undefined)
    return Array.isArray(raw) ? raw.map((x) => String(x)) : undefined
  }

  /** 结算一次待判定注入：有引用证据才回写 used，无证据保持 0（未采纳）。 */
  const settle = (sid) => {
    const key = String(sid)
    const entry = pending.get(key)
    pending.delete(key)
    const text = replyBuf.get(key) || ''
    replyBuf.delete(key)
    if (!entry || !entry.recallId) return
    if (!text) {
      log(`[whale-memory] adoption settle recall=${entry.recallId} skipped=no_reply_text`)
      return
    }
    try {
      const verdict = judgeReply(text, entry.nodes)
      log(`[whale-memory] adoption settle recall=${entry.recallId} chars=${text.length} adopted=${verdict.adopted}`)
      if (!verdict.adopted) return
      const res = backend.markRecallUsed?.(entry.recallId, true)
      if (res && res.ok) {
        log(`[whale-memory] adoption recall=${entry.recallId} cited=${verdict.nodeIds.length} chars=${text.length}`)
      }
    } catch (err) {
      log(`[whale-memory] adoption fail-open: ${err?.name || err?.message || 'error'}`)
    }
  }

  const onPreStep = async (payload, next) => {
    const decision = await next()
    try {
      if (disposed) return decision
      if (!decision || decision.kind !== 'enter') return decision
      if (!bool(config?.recall?.enabled, true)) return decision
      const agent = payload?.agent
      const sessionId = agent?.session?.id
      if (!sessionId) return decision
      if (agent?.session?.header?.origin === 'subagent') return decision
      if (payload?.signal?.aborted) return decision

      const query = extractQuery(payload.messages)
      if (!query) return decision

      cache.delete(String(sessionId))
      // 身份 auto：宿主 userId（5min 缓存，getter 同步返回）+ 会话 cwd 派生的 workspace。
      // workspace 只在 Config 为空时生效（现网 'web' 非空 ⇒ 召回结果不变）。
      const hostUserId = typeof getHostUserId === 'function' ? String(getHostUserId() || '') : ''
      const sessionWorkspace = deriveWorkspace(agent?.session?.header)
      const ident = resolveIdentity(getIdentityCfg(), getIdentityHint(), hostUserId, sessionWorkspace)
      if (!ident.ok) return decision

      // 上一步的回复已完整落进 assistant-stream：进入新步前先结算，别让证据过期被下一轮覆盖。
      settle(sessionId)

      const ac = new AbortController()
      inflight.add(ac)
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const started = Date.now()
        // trace_id 贯穿 hook -> backend：sessionId 前缀保证能追到具体会话。
        const traceId = `${sessionId}:${Date.now()}`
        const result = await backend.recall({
          query,
          maxHits: num(config?.recall?.maxHits, 5),
          charBudget: num(config?.recall?.charBudget, 1500),
          intentBudget: bool(config?.recall?.intentBudget, true),
          minRel: num(config?.recall?.minRel, 0.34),
          // 注入开关（审计 P1-1 假开关）：面板里的 injectLevels/showSources 必须真传到 backend，
          // 只在面板改字而 backend 不接，就是"写着能调、实际没实现"。
          injectLevels: injectLevels(),
          showSources: bool(config?.recall?.showSources, true),
          diffusion: bool(config?.edges?.diffusion, true),
          minConf: num(config?.edges?.minConf, 0.6),
          identity: ident.identity,
          traceId,
        }, ac.signal)
        if (result && typeof result.prefix === 'string' && result.prefix) {
          cache.set(String(sessionId), { text: result.prefix, exp: Date.now() + CACHE_TTL_MS })
          // 只有真正注入的召回才登记采纳待判（预算裁掉/零命中的行没有可采纳对象）。
          if (result.recallId) {
            pending.set(String(sessionId), { recallId: Number(result.recallId), nodes: result.injectedNodes || [] })
          }
          log(`[whale-memory] recall ok hits=${Number(result.hits || 0)} chars=${result.prefix.length} ms=${Date.now() - started}`)
        }
      } finally {
        clearTimeout(timer)
        inflight.delete(ac)
      }
    } catch (err) {
      log(`[whale-memory] recall fail-open: ${err?.name || err?.message || 'error'}`)
    }
    return decision
  }

  /** 回复侧文本增量：按 (turn, step) 累积，供结算时判「是否引用了注入节点」。 */
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (disposed) return
      const frame = payload?.frame
      const agent = payload?.agent
      if (!frame || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const sid = agent?.session?.id ?? agent?.id
      if (!sid) return
      const key = String(sid)
      const prev = replyBuf.get(key) || ''
      if (prev.length >= REPLY_BUF_MAX) return
      if (!prev) log(`[whale-memory] stream first delta turn=${frame.turn ?? '-'} step=${frame.step ?? '-'}`)
      replyBuf.set(key, (prev + chunk.text).slice(0, REPLY_BUF_MAX))
    } catch { /* 观测信号 fail-open，不影响流式回复 */ }
  })

  /** 回合关闭：结算该会话所有剩余待判条目，避免跨回合残留。 */
  const offStopping = ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      const sid = agent?.session?.id ?? agent?.id
      if (sid) settle(sid)
    } catch (err) {
      log(`[whale-memory] adoption settle fail-open: ${err?.name || err?.message || 'error'}`)
    }
  })

  const offPre = ctx.on('agent/pre-step', onPreStep)
  const offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => {
    const sid = agent?.session?.id ?? agent?.id
    if (!sid) return
    cache.delete(String(sid))
    settle(sid)
  })

  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        if (disposed) return ''
        const sid = context?.scope?.session?.id ?? context?.agent?.session?.id
        return readCached(cache, sid)
      } catch { return '' }
    },
  }), 'whale-memory: recall context')

  const dispose = () => {
    disposed = true
    offPre?.()
    offDisposed?.()
    offStream?.()
    offStopping?.()
    for (const ac of inflight) { try { ac.abort() } catch { /* noop */ } }
    inflight.clear()
    cache.clear()
    pending.clear()
    replyBuf.clear()
  }
  return { cache, dispose }
}
