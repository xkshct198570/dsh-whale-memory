/**
 * Host 路由装配：前缀/安全闸/身份解析统一在这里，端点分支在 routes/*.js。
 *
 * 拆分（P2d）：createRoutes 只做装配与分发；各端点组返回 true 表示已处理。
 * 边界（厂长令）：本包只做“记与查”，不扮演角色、不调大模型；recall-test 是纯检索。
 * 本层不 import core 业务模块：存储能力全部经注入的 backend；sync 只用 core/sync 传输。
 *
 * 错误出口：任何端点抛错一律 502 backend_error JSON，不穿出 webServer。
 */
import { isAllowedHostName, isLoopback, isWriteMethod, sendJson, writeRequestProblem } from '../http-kit.js'
import { bool } from '../../shared/config-values.js'
import { resolveIdentity } from '../identity.js'
import { handleRules } from '../rules-routes.js'
import { createHostAdapter } from '../ctx-adapter.js'
import { PREFIX } from './prefix.js'
import {
  makeBackendOutbox, makeBackendView, makeIdentityView, makeMigrationView, sendMethodNotAllowed, traceIdOf,
} from './common.js'
import { handleVersionStats } from './version-stats.js'
import { handleRecallSearch } from './recall-search.js'
import { handleWriteImport } from './write-import.js'
import { handleNodesReview } from './nodes-review.js'
import { handleConfigSync } from './config-sync.js'
import { handleWrap } from './wrap.js'

const REMOTE_READ_POST = new Set([`${PREFIX}/search`, `${PREFIX}/recall-test`])
// 远端（allowRemote）放开的只有"面板浏览"语义：search/recall 与列表。
// 以下 GET 虽只读也不给远端（审计 P1）：整库导出、收尾报告/状态（owner 摘要）、
// 配置（identity/dataDir/bridgeUrl）、写入审计（before_text 正文）、导入 job 状态（可枚举他 job）。
// 判据：单个响应里出现"整库/他身份正文/内部运行参数"就不该进 LAN 面板。
const REMOTE_READ_DENY_GET = new Set([
  `${PREFIX}/export`, `${PREFIX}/wrap/status`, `${PREFIX}/wrap/report`,
  `${PREFIX}/config`, `${PREFIX}/writes`, `${PREFIX}/import/status`,
])
const remoteReadable = (method, path) => {
  const m = String(method || '').toUpperCase()
  if (m === 'GET') return !REMOTE_READ_DENY_GET.has(path)
  if (m === 'POST') return REMOTE_READ_POST.has(path)
  return false
}
export { REMOTE_READ_DENY_GET, REMOTE_READ_POST, remoteReadable }

export function createRoutes({
  config, backend,
  getIdentityCfg = () => config?.identity,
  getIdentityHint = () => null,
  getHostUserId = () => '',
  identityState = null,
  migration = null,
  ctx, reflect, wrap = null, log = () => {},
}) {
  // 宿主能力只经 adapter（R9-09）：LLM/默认模型选择缺失时降级 null + 一次 domain=host 日志。
  const host = createHostAdapter(ctx, { log })
  /**
   * 面板写入口写后立即清召回缓存：规则正文/AGENTS 摘要已变，下一步注入不能吃 30s 旧前缀。
   * 走 service.invalidateCache（清整表，含规则前缀与会话条目），与 hook 的 invalidateRulesCache 等价。
   */
  const invalidateRulesCache = () => {
    try {
      const service = typeof ctx?.get === 'function' ? ctx.get('whaleMemory') : null
      if (service && typeof service.invalidateCache === 'function') service.invalidateCache()
    } catch (err) {
      log(`[whale-memory] rules cache invalidate fail-open: ${err?.message || err}`)
    }
  }


  const boundHosts = () => {
    if (!bool(config?.panel?.allowRemote, false)) return []
    try {
      const host = ctx?.webServer?.host
      return typeof host === 'string' && host.trim() ? [host.trim()] : []
    } catch { return [] }
  }

  /** 主分发（内部）：抛错由下面的 handle 统一兜底成 502 JSON。 */
  const dispatch = async (req, res) => {
    const addr = req.socket?.remoteAddress
    // 每次请求读实时配置：面板改了 allowRemote 必须立刻生效，不能闭包快照。
    const allowRemote = bool(config?.panel?.allowRemote, false)
    const peerLoopback = isLoopback(addr)

    // Host 闸覆盖所有方法（含 GET）：DNS rebinding 页面可带畸形/外部 Host 同源 GET
    // 走规则全文、整库导出与详情正文，必须在任何路由/身份解析之前拒绝。
    // allowRemote 时额外放行 webServer 绑定地址（审计 P1-13：旧实现 Host 闸先于
    // allowRemote 且白名单仅回环，导致开关是死的）。
    if (!isAllowedHostName(req.headers?.host, boundHosts())) {
      return sendJson(res, 403, { ok: false, error: 'cross_origin_denied' })
    }

    // peer 是硬闸，Host 只是附加校验：Host 头由客户端填写，伪造 127.0.0.1 不能换来写权限。
    if (!peerLoopback && !allowRemote) {
      return sendJson(res, 403, { ok: false, error: 'not_loopback' })
    }

    const traceId = traceIdOf(req)

    let path = ''
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '' }

    // allowRemote 只放开读语义端点；写/管理端点（config/import/sync/reflect/rules 写）
    // 一律要求回环 peer。远端即使伪造 Host 也过不了这一关。
    if (!peerLoopback && !remoteReadable(req.method, path)) {
      return sendJson(res, 403, { ok: false, error: 'read_only_remote' })
    }

    // 写接口安全闸（R8-09）：在所有端点分发之前拦下跨源/非 JSON 简单请求，
    // 保证拒绝发生在读 body、建规则仓、写库等任何副作用之前。
    // 远端只可能走 /search 这类只读 POST；Host/Origin 白名单允许绑定地址，
    // 但仍要求 JSON（text/plain 简单请求进不来）。
    if (isWriteMethod(req.method)) {
      const problem = writeRequestProblem(req, { boundHosts: peerLoopback ? [] : boundHosts() })
      if (problem) return sendJson(res, problem.status, { ok: false, error: problem.error })
    }

    const ident = resolveIdentity(
      getIdentityCfg(),
      typeof getIdentityHint === 'function' ? getIdentityHint() : null,
      typeof getHostUserId === 'function' ? String(getHostUserId() || '') : '',
      // 路由没有会话 header ⇒ 会话 workspace 维度只在 hook（pre-step）启用。
      '',
    )
    if (!ident.ok) return sendJson(res, 400, { ok: false, error: ident.error })
    const identity = ident.identity
    /** 面板要的只读身份视图（不泄漏正文）：来源逐字段可查（实现见 common.js）。 */
    const identityView = makeIdentityView({ config, identity, ident, identityState })

    /**
     * 身份覆盖只对回环 peer 开放：allowRemote 下同网段客户端不能按 userId/workspace
     * 翻别人的分区，也不能通过 POST body 绕开 GET 参数的限制。
     */
    const canOverrideIdentity = peerLoopback

    /** 请求显式带 workspace（string，含空串）时覆盖 Config；不带就沿用 handle 顶部身份。 */
    const withRequestWorkspace = (workspace) => {
      if (!canOverrideIdentity) return ident
      if (typeof workspace !== 'string') return ident
      const baseHint = typeof getIdentityHint === 'function' ? (getIdentityHint() || {}) : {}
      const hint = { ...baseHint, workspace: workspace.trim().slice(0, 64) }
      return resolveIdentity(
        getIdentityCfg(),
        hint,
        typeof getHostUserId === 'function' ? String(getHostUserId() || '') : '',
        '',
      )
    }

    /**
     * 身份覆盖：请求显式带 userId/roleId/workspace（任一字符串）时优先用请求值，
     * 未带就沿用 handle 顶部按 getIdentityCfg() 推导的身份。
     *
     * why 需要它：列表/详情端点必须传身份（跨身份泄漏是 P0），而面板/外部调用方
     * 有时要"看另一个分区"；这里只做覆盖，不做授权判断——回环闸门已经在上面拦过。
     */
    const requestIdentity = (source) => {
      if (!canOverrideIdentity) return { ok: true, identity }
      if (!source || typeof source !== 'object') return { ok: true, identity }
      const override = {}
      for (const [key, max] of [['userId', 128], ['roleId', 64], ['workspace', 64]]) {
        const raw = source[key]
        if (typeof raw !== 'string') continue
        override[key] = raw.trim().slice(0, max)
      }
      if (Object.keys(override).length === 0) return { ok: true, identity }
      const baseHint = typeof getIdentityHint === 'function' ? (getIdentityHint() || {}) : {}
      const got = resolveIdentity(
        getIdentityCfg(),
        { ...baseHint, ...override },
        typeof getHostUserId === 'function' ? String(getHostUserId() || '') : '',
        '',
      )
      return got.ok ? { ok: true, identity: got.identity } : { ok: false, error: got.error }
    }

    /**
     * GET 查询串里的身份覆盖参数（不带的键为 undefined ⇒ 不覆盖）。
     * 非回环请求一律不允许覆盖身份：allowRemote 只暴露“当前身份视图”，
     * 否则同网段任何客户端都能按 userId/workspace 翻别人的分区。
     */
    const identityParams = (params) => (canOverrideIdentity ? {
      userId: params.get('userId') ?? undefined,
      roleId: params.get('roleId') ?? undefined,
      workspace: params.get('workspace') ?? undefined,
    } : { userId: undefined, roleId: undefined, workspace: undefined })

    /** 后端状态视图（/stats 与 /version 同源）：local 恒 match，http/hybrid 读 protocolStatus。 */

    // 端点组：返回 true 表示已写响应；组内分支保持原顺序与语义。
    const backendView = makeBackendView({ backend, config })
    const backendOutbox = makeBackendOutbox({ backend })
    const migrationView = makeMigrationView({ migration })
    const groupCtx = {
      req, res, path, method: req.method, config, backend, identity, traceId, log, ctx, wrap, reflect,
      identityView, requestIdentity, identityParams, withRequestWorkspace,
      backendView, backendOutbox, migrationView,
      sendJson: (r, status, payload) => { sendJson(r, status, payload); return true },
      sendMethodNotAllowed: (r, allow) => { sendMethodNotAllowed(r, allow); return true },
    }
    if (await handleVersionStats(groupCtx)) return undefined
    if (await handleRecallSearch(groupCtx)) return undefined
    if (await handleWriteImport(groupCtx)) return undefined
    if (await handleNodesReview(groupCtx)) return undefined
    if (await handleConfigSync(groupCtx)) return undefined
    if (await handleWrap(groupCtx)) return undefined

    // 规则只读/管理端点（R3a）：命中即返回 true，未命中继续走 404。
    // getLlm 透传给规则 apply：面板手改合并/冲突时需要模型只改措辞（R3b）。
    if (await handleRules({
      req, res, path, config, backend, log,
      // 宿主能力只经 adapter（R9-09）：缺失降级 null + 一次 domain=host 日志。
      getLlm: () => host.llm(),
      // R9-10：面板 apply/改写需要 provider/model 才能调模型；缺选择由 core 转 needs_manual。
      getSelection: () => host.selection(),
      invalidateCache: invalidateRulesCache,
    })) return undefined

    log(`[whale-memory] 404 ${req.method} ${path}`)
    return sendJson(res, 404, { ok: false, error: 'not_found' })
  }

  /**
   * 统一错误出口（审计 P2-1）：任何端点里 backend 抛错一律 502 `backend_error` 的 JSON，
   * 不再让异常穿出 webServer（那会变成空响应/断连，面板只看到"加载失败"没有原因）。
   * 已经写出响应头时（导出/分片写）只收尾，不二次写头——二次 sendJson 会抛 ERR_HTTP_HEADERS_SENT。
   */
  return async function handle(req, res) {
    try {
      return await dispatch(req, res)
    } catch (err) {
      log(`[whale-memory] route error -> 502 backend_error: ${err?.name || ''} ${err?.message || err}`)
      if (res.headersSent || res.writableEnded) {
        try { if (!res.writableEnded) res.end() } catch { /* 收尾失败没有可上报的通道 */ }
        return undefined
      }
      return sendJson(res, 502, { ok: false, error: 'backend_error' })
    }
  }
}
