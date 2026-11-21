/**
 * 搜索反哺：DSH 联网搜索工具一返回，就把「查询 + 前两条摘要」写成 episodic 记忆。
 *
 * 入口是 DSH 公共事件 `tools/result`（exec.name + result.value），不是任何私有搜索实现。
 * 开关：Config.write.searchFeed；TTL：searchTtlHours（过期只 stale，不物理删）。
 * 失败/超时/内存告急一律跳过，不阻断工具结果。
 */
import { bool, num } from './config-values.js'
import { resolveIdentity } from './identity.js'
import { memoryPressure } from './memory-guard.js'

const SEARCH_TOOL_RE = /(^|_)(web_search|websearch|free_search|search_web)$/i
const MAX_CHARS = 200

function queryOf(exec) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return ''
  const q = args.query ?? args.q ?? args.text ?? ''
  return typeof q === 'string' ? q.trim().slice(0, 120) : ''
}

function summaryOf(value) {
  if (!value || typeof value !== 'object') return ''
  const parts = []
  const answer = typeof value.answer === 'string' ? value.answer.trim() : ''
  if (answer) parts.push(answer)
  const sources = Array.isArray(value.sources) ? value.sources : Array.isArray(value.items) ? value.items : []
  for (const s of sources.slice(0, 2)) {
    if (!s || typeof s !== 'object') continue
    const t = String(s.title || '').trim()
    const sn = String(s.snippet || s.summary || '').trim()
    if (t || sn) parts.push(`${t}${t && sn ? '：' : ''}${sn}`)
  }
  return parts.join('；')
}

/**
 * @param {any} ctx
 * @param {{ backend:any, config:any, log?:Function }} deps
 */
export function installSearchFeed(ctx, { backend, config, log = () => {} }) {
  const handler = (exec, result) => {
    try {
      if (!bool(config?.write?.enabled, true) || !bool(config?.write?.searchFeed, false)) return
      const name = String(exec?.name || '')
      if (!SEARCH_TOOL_RE.test(name)) return
      if (memoryPressure().stress) { log('[whale-memory] searchFeed skip: memory pressure'); return }
      const query = queryOf(exec)
      const summary = summaryOf(result?.value)
      if (!query || !summary) return
      let text = `搜索「${query}」：${summary}`
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + '…'
      const ttl = num(config?.write?.searchTtlHours, 24)
      const ident = resolveIdentity(config?.identity)
      if (!ident.ok) return
      backend.write({
        text, level: 'normal', memory_type: 'episodic', source: 'web',
        tags: ['web_search', query], origin: 'tool:web_search',
        expired_at: Date.now() / 1000 + ttl * 3600,
        traceId: String(exec?.callId || ''), identity: ident.identity,
      }).then((r) => {
        if (r?.ok && !r.duplicate) log(`[whale-memory] searchFeed added id=${r.id}`)
      }).catch((err) => log(`[whale-memory] searchFeed write fail-open: ${err?.message || err}`))
    } catch (err) {
      log(`[whale-memory] searchFeed fail-open: ${err?.message || err}`)
    }
  }
  ctx.effect(() => ctx.on('tools/result', handler), 'whale-memory: search feed')
  return { handler }
}
