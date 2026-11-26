/**
 * 搜索反哺：DSH 联网搜索工具一返回，就把「查询 + 前两条摘要」写成 episodic 记忆。
 *
 * 入口是 DSH 公共事件 `tools/result`（exec.name + result.value），不是任何私有搜索实现。
 * 开关：Config.write.searchFeed；TTL：searchTtlHours（过期只 stale，不物理删）。
 * 去重：origin = tool:web_search#sha256(查询+本地日期)[0..16]，同 key 重复事件交给 backend 按 origin 复用。
 * 失败/超时/内存告急一律跳过，不阻断工具结果。
 */
import { createHash } from 'node:crypto'
import { bool, num } from '../shared/config-values.js'
import { isDelegatedHeader, sessionIdentityOf } from './identity.js'
import { memoryPressure } from '../shared/memory-guard.js'

// 工具名白名单覆盖 DSH 常见检索工具；只认"词边界在开头/下划线"且整体收尾的写法。
const SEARCH_TOOL_RE = /(^|_)(web_search|websearch|free_search|search_web|advanced_search|multi_search|platform_search|domain_search|video_search|research)$/i
const MAX_CHARS = 200
/** 摘要单条上限（answer 一条、每个 source 一条）：超长摘要只截本条，不挤掉其它条。 */
const PART_MAX = 80

/**
 * 单条摘要截断：硬顶 80 字（含省略号），避免一条长 answer 吃掉全部预算。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clipPart(value, max = PART_MAX) {
  const s = String(value ?? '').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** 本地日期 YYYY-MM-DD（去重 key 只按"同一天"收敛，跨天允许重新落库）。 */
function localDay(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 查询去重键：sha256(归一化查询 + 本地日期) 前 16 位。
 * @param {string} query
 * @param {number} [ts]
 * @returns {string}
 */
function originKeyOf(query, ts = Date.now()) {
  const normalized = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(`${normalized}|${localDay(ts)}`, 'utf8').digest('hex').slice(0, 16)
}

function queryOf(exec) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return ''
  const q = args.query ?? args.q ?? args.text ?? ''
  return typeof q === 'string' ? q.trim().slice(0, 120) : ''
}

/**
 * 摘要拼装：answer 一条 + 最多两条 source（title：snippet）；每条都按 PART_MAX 截断。
 * @param {{ answer?: unknown, sources?: unknown, items?: unknown } | null | undefined} value
 * @returns {string}
 */
function summaryOf(value) {
  if (!value || typeof value !== 'object') return ''
  const parts = []
  const answer = typeof value.answer === 'string' ? value.answer.trim() : ''
  if (answer) parts.push(clipPart(answer))
  const sources = Array.isArray(value.sources) ? value.sources : Array.isArray(value.items) ? value.items : []
  for (const s of sources.slice(0, 2)) {
    if (!s || typeof s !== 'object') continue
    const t = String(s.title || '').trim()
    const sn = String(s.snippet || s.summary || '').trim()
    if (t || sn) parts.push(clipPart(`${t}${t && sn ? '：' : ''}${sn}`))
  }
  return parts.join('；')
}

/**
 * @param {any} ctx
 * @param {{ backend:any, config:any, getIdentityCfg?:Function, getIdentityHint?:Function,
 *   getHostUserId?:Function, getHostIdentityState?:Function, log?:Function }} deps
 *   身份只走 `sessionIdentityOf`（架构书 §5.5.1）：搜索反哺是写路径，必须落会话分区；
 *   无 agent/header、子代理或身份不可判定一律跳过并留一次可见日志，绝不写 `workspace=''`。
 */
export function installSearchFeed(ctx, {
  backend, config,
  getIdentityCfg = () => config?.identity,
  getIdentityHint = () => null,
  getHostUserId = () => '',
  getHostIdentityState = undefined,
  log = () => {},
}) {
  /** 身份跳过只记一次：每个搜索事件都打会刷屏，但静默跳过不可观测。 */
  let skippedIdentity = false
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
      const header = exec?.agent?.session?.header
      if (isDelegatedHeader(header)) return
      const ident = sessionIdentityOf({ header, getIdentityCfg, getIdentityHint, getHostUserId, getHostIdentityState })
      if (!ident.ok) {
        if (!skippedIdentity) {
          skippedIdentity = true
          log('[whale-memory] searchFeed skip identity_required (no session partition)')
        }
        return
      }
      // 同查询 + 本地日期 → 同一个带 #key 的 origin（跨进程稳定）。
      // 去重依赖后端契约（backend/writer 侧，不在本文件）：同身份已有相同 origin 的 active 节点时
      // 走 MERGE 更新摘要，而不是新增一条记忆。本文件只保证 key 稳定、重复事件撞同一个 origin。
      const origin = `tool:web_search#${originKeyOf(query)}`
      backend.write({
        text, level: 'normal', memory_type: 'episodic', source: 'web',
        tags: ['web_search', query], origin,
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
