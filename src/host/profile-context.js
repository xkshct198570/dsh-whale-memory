/**
 * 首轮画像注入（v7 §5.7.3）：会话首轮把同身份的长期偏好/教训/事实做成一段 ≤800 码点的
 * runtime context；同一 session 只出现一次（第二轮起不再注入）。
 *
 * 边界：只读 `backend.profileLayers`（core 读 API）+ `identity.sessionIdentityOf`；
 * 不写库、不调模型、不 import 路由/worker；装配阶段零 IO（只读进程内缓存）。
 */
import { isDelegatedHeader, sessionIdentityOf } from './identity.js'
import { LAYERS } from '../shared/layers.js'

/** 宿主把 context order=100 保留给 WORKING_DIRECTORY；129 紧在召回（130）之前。 */
export const PROFILE_CONTEXT_NAME = 'whale-memory:profile'
export const PROFILE_CONTEXT_ORDER = 129
/** 整段画像预算（码点）：超出预算的条目整条跳过，不截半句（保证格式与语义完整）。 */
export const PROFILE_CHAR_BUDGET = 800
/** 进程内会话缓存上限：只记住"本会话是否已判定过"，超限淘汰最早。 */
const CACHE_LIMIT = 200
const TITLE = '【长期画像】'

/** 分类 → 标题与条数（顺序即渲染顺序：偏好、教训、事实；值必须来自 shared 的分层词汇）。 */
const GROUP_SPEC = [
  { layer: 'user', title: '偏好', limit: 5 },
  { layer: 'lesson', title: '教训', limit: 5 },
  { layer: 'fact', title: '事实', limit: 3 },
]
const GROUPS = GROUP_SPEC.filter((group) => LAYERS.includes(group.layer))

/** 码点计数（预算按字符，不按 UTF-16 长度）。 */
function chars(text) {
  return Array.from(String(text ?? '')).length
}

/** 单条正文压成一行：画像按行渲染，条目内换行会破坏格式并浪费预算。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 渲染画像块（纯函数）：逐条累加，超出预算的条目整条跳过；三类都空返回 ''（不注入空块）。
 *
 * 为什么不截半句：半句记忆会改变原意（"必须先备份"截成"必须先"），宁可不注入也不能给错事实。
 * 为什么不带时间戳/得分：同身份多次会话的文本应稳定，避免因时间变化改变注入前缀。
 *
 * @param {Record<string, Array<{id:string,text:string,layer:string}>>} groups layer → 条目
 * @param {number} [budget] 码点预算（含标题）
 * @returns {string}
 */
export function renderProfile(groups, budget = PROFILE_CHAR_BUDGET) {
  const raw = Number(budget)
  const cap = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : PROFILE_CHAR_BUDGET
  const fits = (body) => chars(`${TITLE}\n${body}`) <= cap
  let bodyOut = ''
  for (const group of GROUPS) {
    const items = Array.isArray(groups?.[group.layer]) ? groups[group.layer] : []
    const prefix = `${group.title}：`
    let body = ''
    for (const item of items) {
      const text = oneLine(item?.text)
      if (!text) continue
      const next = body ? `${body}；${text}` : text
      const candidate = bodyOut ? `${bodyOut}\n${prefix}${next}` : `${prefix}${next}`
      if (!fits(candidate)) continue
      body = next
    }
    if (body) bodyOut = bodyOut ? `${bodyOut}\n${prefix}${body}` : `${prefix}${body}`
  }
  return bodyOut ? `${TITLE}\n${bodyOut}` : ''
}

/**
 * 安装首轮画像：pre-step 里每会话查一次库，context 装配只读缓存。
 *
 * @param {{
 *   ctx: any,
 *   backend: any,
 *   getIdentityCfg: () => any,
 *   getIdentityHint: () => object|null|undefined,
 *   getHostUserId: () => string,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {{ size: () => number, textOf: (context:any) => string, dispose: () => void }}
 */
export function installProfileContext({
  ctx, backend, getIdentityCfg, getIdentityHint, getHostUserId, getHostIdentityState, log = () => {},
}) {
  // 后端没有画像读能力（http/纯远端）：画像无处取数，直接不装——不查、不刷失败日志。
  if (typeof backend?.profileLayers !== 'function') {
    log('[whale-memory] profile unavailable: backend has no profileLayers (profile disabled)')
    return { size: () => 0, textOf: () => '', dispose: () => {} }
  }

  /** @type {Map<string, { text: string, active: boolean }>} 文本留着表示"已判定过"（含空结果）。 */
  const cache = new Map()
  let disposed = false

  const remember = (key, text) => {
    cache.set(key, { text, active: true })
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /**
   * 摘掉 active（文本保留=本会话已判定，不再查库）。
   *
   * 为什么还要在 turn/end（`session/event`）摘：rc.5 的 `assemble()` 发生在 pre-step **之前**，
   * 装配期 provider 看到的仍是上一轮的值；若只靠 pre-step 摘，第二轮首个请求的 assembly 已把
   * 画像烘进 sections，默认处理器很可能把它投影成一条 stale runtime-context（召回缓存过期时
   * 尤其必现）。turn/end 在下一轮 assemble 之前落盘，能保证第二轮从装配期就不带画像；
   * pre-step 的摘除保留为兜底（如异常导致的 turn/end 缺失）。
   *
   * @param {any} payload pre-step 载荷
   */
  const retire = (payload) => {
    const sid = payload?.agent?.session?.id
    const turn = Number(payload?.turn)
    if (!sid || !Number.isFinite(turn) || turn === 1) return
    const key = String(sid)
    const entry = cache.get(key)
    if (entry?.active) cache.set(key, { text: entry.text, active: false })
  }

  /**
   * 首轮取数（每会话一次）：失败只记日志并缓存空串——同会话不重试，避免每 step 重扫库。
   * @param {any} payload pre-step 载荷（turn/signal/agent）
   * @param {any} decision waterfall 决策（非 enter 不计）
   */
  const seed = async (payload, decision) => {
    if (!decision || decision.kind !== 'enter') return
    const agent = payload?.agent
    const sid = agent?.session?.id
    if (!sid || Number(payload?.turn) !== 1) return
    const key = String(sid)
    if (cache.has(key)) return
    if (isDelegatedHeader(agent?.session?.header)) return
    if (payload?.signal?.aborted) return
    const ident = sessionIdentityOf({
      header: agent?.session?.header, getIdentityCfg, getIdentityHint, getHostUserId, getHostIdentityState,
    })
    if (!ident.ok) return
    let text = ''
    let failed = false
    try {
      const limits = Object.fromEntries(GROUPS.map((group) => [group.layer, group.limit]))
      const groups = await backend.profileLayers(limits, { identity: ident.identity })
      text = renderProfile(groups)
    } catch (err) {
      log(`[whale-memory] profile query fail-open: ${err?.name || err?.message || err}`)
      text = ''
      failed = true
    }
    // 查询期间被中止/卸载：不写缓存——该会话下一轮仍可重新取数，不能一次瞬时中止就永久丢画像。
    if (disposed || payload?.signal?.aborted) return
    remember(key, text)
    if (!failed) log(`[whale-memory] profile injected chars=${chars(text)}`)
  }

  const textOf = (context) => {
    if (disposed) return ''
    const sid = context?.scope?.session?.id ?? context?.agent?.session?.id
    const entry = sid ? cache.get(String(sid)) : null
    return entry && entry.active ? entry.text : ''
  }

  // 先注册 context 再装监听器：没有可注入的面就干脆不查库（否则每轮白扫一次画像）。
  let offContext = null
  try {
    offContext = ctx.systemPrompt.context({
      name: PROFILE_CONTEXT_NAME,
      order: PROFILE_CONTEXT_ORDER,
      interpolate: false,
      text: textOf,
    })
  } catch (err) {
    // 宿主没装 systemPrompt（老宿主/纯后端）：画像注入无处落地，但必须留痕而不是假装装了。
    log(`[whale-memory] profile context unavailable: ${err?.name || err?.message || err}`)
  }
  if (!offContext) return { size: () => 0, textOf: () => '', dispose: () => {} }

  const offPre = typeof ctx?.on === 'function'
    ? ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (!disposed) retire(payload)
      } catch (err) {
        log(`[whale-memory] profile retire fail-open: ${err?.name || err?.message || err}`)
      }
      const decision = await next()
      try {
        if (!disposed) await seed(payload, decision)
      } catch (err) {
        log(`[whale-memory] profile seed fail-open: ${err?.name || err?.message || err}`)
      }
      return decision
    })
    : null
  if (!offPre) log('[whale-memory] no agent/pre-step listener: first-turn profile disabled')

  // turn/end：下一轮 assemble 之前把画像摘掉（见 retire 的说明）。
  const offTurnEnd = typeof ctx?.on === 'function'
    ? ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      const sid = session?.id ?? session?.session?.id
      if (!sid) return
      const entry = cache.get(String(sid))
      if (entry?.active) cache.set(String(sid), { text: entry.text, active: false })
    })
    : null

  const offDisposed = typeof ctx?.on === 'function'
    ? ctx.on('agent/disposed', ({ agent } = {}) => {
      const sid = agent?.session?.id
      if (sid) cache.delete(String(sid))
    })
    : null

  const dispose = () => {
    if (disposed) return
    disposed = true
    cache.clear()
    try { offPre?.() } catch { /* 宿主已卸载 */ }
    try { offTurnEnd?.() } catch { /* 同上 */ }
    try { offDisposed?.() } catch { /* 同上 */ }
    try { offContext?.() } catch { /* 同上 */ }
  }
  return { size: () => cache.size, textOf, dispose }
}
