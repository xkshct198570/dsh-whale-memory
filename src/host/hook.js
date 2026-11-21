/**
 * 记忆召回注入（fail-open）。
 *
 * 时序（别改回 section）：pre-step 写缓存 → systemPrompt.context 在 step() 的
 * refreshContext 阶段再求值 → 本轮请求就能带上召回文本；人设由独立插件用 section 注入，
 * 记忆用 context（本包），两者职责不混。
 *
 * 生命周期硬线（P-4）：整个安装包在 ctx.effect 内；每次请求带 AbortController；
 * dispose 时中止在途、清缓存、返回空文本；任何失败只记日志，绝不抛。
 */
import { resolveIdentity } from './identity.js'

export const CONTEXT_NAME = 'whale-memory:recall'
export const CONTEXT_ORDER = 100
const CACHE_TTL_MS = 120_000
const MAX_QUERY_CHARS = 2000

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
 * @param {{ backend: any, config: any, log?: (s:string)=>void }} deps
 * @returns {{ cache: Map<string,{text:string,exp:number}>, dispose: () => void }}
 */
export function installHook(ctx, { backend, config, getIdentityCfg = () => config?.identity, log = () => {} }) {
  const cache = new Map()
  const inflight = new Set()
  let disposed = false

  const timeoutMs = Number(config?.recall?.timeoutMs || 2000)

  const onPreStep = async (payload, next) => {
    const decision = await next()
    try {
      if (disposed) return decision
      if (!decision || decision.kind !== 'enter') return decision
      if (config?.recall?.enabled === false) return decision
      const agent = payload?.agent
      const sessionId = agent?.session?.id
      if (!sessionId) return decision
      if (agent?.session?.header?.origin === 'subagent') return decision
      if (payload?.signal?.aborted) return decision

      const query = extractQuery(payload.messages)
      if (!query) return decision

      cache.delete(String(sessionId))
      const ident = resolveIdentity(getIdentityCfg())
      if (!ident.ok) return decision

      const ac = new AbortController()
      inflight.add(ac)
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const started = Date.now()
        const result = await backend.recall({
          query,
          maxHits: Number(config?.recall?.maxHits ?? 5),
          identity: ident.identity,
        }, ac.signal)
        if (result && typeof result.prefix === 'string' && result.prefix) {
          cache.set(String(sessionId), { text: result.prefix, exp: Date.now() + CACHE_TTL_MS })
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

  const offPre = ctx.on('agent/pre-step', onPreStep)
  const offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => {
    const sid = agent?.session?.id
    if (sid) cache.delete(String(sid))
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
    for (const ac of inflight) { try { ac.abort() } catch { /* noop */ } }
    inflight.clear()
    cache.clear()
  }
  return { cache, dispose }
}
