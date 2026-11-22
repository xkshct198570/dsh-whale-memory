/**
 * Host 路由：S1 只读（stats / recent / search / recall-test）+ S2 写入路径
 * （write / import / export / nodes）。
 *
 * 边界（厂长令）：本包只做"记与查"，不扮演角色、不调大模型。
 * recall-test 只是"输入词 -> 返回命中条目"的纯检索，绝不调用任何生成模型。
 * 本层不 import core：存储能力全部经注入的 backend 接口调用。
 */
import { Buffer } from 'node:buffer'
import { clamp, isLoopback, readJson, sendJson } from './http-kit.js'
import { resolveIdentity } from './identity.js'
import { bool, value } from './config-values.js'
import { Config } from './config.js'
import { HttpSyncTransport, pullFromGateway, pushToGateway } from '../core/sync.js'
import { WHALE_PROTOCOL } from '../core/backend.js'
import { handleRules } from './rules-routes.js'

const PREFIX = '/whale-memory/api'

/**
 * 面板可读写的配置组：GET 回显与 POST 保存共用同一份清单，
 * 避免"回显 23 字段、保存手抄 6 组"导致组内叶子被整组覆盖回落默认。
 */
export const CONFIG_GROUPS = [
  'backend', 'identity', 'recall', 'write', 'reflect', 'consolidate',
  'embed', 'privacy', 'edges', 'sync', 'rules', 'panel', 'advanced',
]
export const CONFIG_KEYS = ['dataDir', ...CONFIG_GROUPS]

/** schemastery 默认值（空配置即开箱值），作为回显/深合并的基线。 */
const CONFIG_DEFAULTS = Config({})

/** schemastery 的 `.volatile()` 字段是 Ref；回显一律先解 Ref。 */
export function resolveTree(input) {
  if (input && typeof input === 'object' && typeof input.get === 'function' && !Array.isArray(input)) {
    return resolveTree(input.get())
  }
  if (Array.isArray(input)) return input.map((item) => resolveTree(item))
  if (input && typeof input === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(input)) out[key] = resolveTree(val)
    return out
  }
  return input
}

/**
 * 按叶子字段深合并：对象递归合并，数组/标量直接替换。
 * 只有提交的叶子会被覆盖；未提交的叶子（含组内默认值）保持原样。
 */
export function deepMergeLeaf(current, patch) {
  const out = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const base = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}
      out[key] = deepMergeLeaf(base, val)
    } else {
      out[key] = Array.isArray(val) ? val.slice() : val
    }
  }
  return out
}

/** 全部组回显：默认值打底 + 运行时实值覆盖（值一律解 Ref）。 */
export function echoConfig(config) {
  return deepMergeLeaf(resolveTree(CONFIG_DEFAULTS), resolveTree(config || {}))
}

/** 统一 trace_id：`x-trace-id` 头（≤64）优先，否则 `panel:<ms>`。 */
export function traceIdOf(req) {
  const raw = req?.headers?.['x-trace-id']
  const text = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return (trimmed || `panel:${Date.now()}`).slice(0, 64)
}

/** 只看 GET 回显集合内的顶层键（白名单与 echoConfig 同源）。 */
function pickConfigKeys(next) {
  const patch = {}
  for (const key of CONFIG_KEYS) {
    if (!(key in next)) continue
    const val = next[key]
    if (key === 'dataDir') {
      if (typeof val === 'string') patch.dataDir = val
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      patch[key] = val
    }
  }
  return patch
}

/** 保存后回读：编辑器支持 configuration() 时以加载器层为准。 */
function readBackConfig(editor, entry, fallback) {
  try {
    if (typeof editor.configuration !== 'function') return fallback
    const rows = editor.configuration()
    const row = Array.isArray(rows) ? rows.find((item) => item && item.entry === entry) : null
    const override = row?.override
    if (override && typeof override === 'object' && !Array.isArray(override)) {
      return deepMergeLeaf(fallback || {}, resolveTree(override))
    }
  } catch { /* 回读失败不阻塞保存：以 editor.edit 回调结果为准 */ }
  return fallback
}

/** 把保存结果按叶子合并进运行时 config（同一 deepMergeLeaf，不整组替换）。 */
function syncRuntimeConfig(config, saved) {
  if (!config || typeof config !== 'object' || !saved || typeof saved !== 'object') return
  for (const key of CONFIG_GROUPS) {
    if (!(key in saved)) continue
    const current = resolveTree(config[key] ?? {})
    config[key] = deepMergeLeaf(current && typeof current === 'object' && !Array.isArray(current) ? current : {}, saved[key])
  }
  if (typeof saved.dataDir === 'string') config.dataDir = saved.dataDir
}


/** 写入文本上限（与 Config.write.maxChars 默认值一致，路由侧再做硬顶）。 */
const MAX_WRITE_CHARS = 500
/** import 的 jsonl 正文上限 4 MiB；外层 JSON 信封留 1 MiB 余量。 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024
const MAX_IMPORT_ENVELOPE = MAX_IMPORT_BYTES + 1024 * 1024

/** 后端写入错误码白名单：命中则按客户端错误 400 透传，未命中一律 502（不泄漏内部码）。 */
const WRITE_ERROR_CODES = new Set([
  'invalid_text',
  'invalid_level',
  'invalid_memory_type',
  'invalid_tags',
  'identity_required',
  'write_disabled',
  'duplicate',
  'text_too_long',
  'privacy',
  'daily_cap',
])

/** @param {import('node:http').ServerResponse} res @param {string} allow */
function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}

/** @param {{ config: any, backend: any, getIdentityCfg?: () => any, getIdentityHint?: () => any,
 *   getHostUserId?: () => string, migration?: { state?: any }, log?: (s:string)=>void }} deps */
export function createRoutes({
  config, backend,
  getIdentityCfg = () => config?.identity,
  getIdentityHint = () => null,
  getHostUserId = () => '',
  identityState = null,
  migration = null,
  ctx, reflect, log = () => {},
}) {
  /** 迁移只读视图（/stats）：没有安装迁移时给空值，键始终存在。 */
  const migrationView = () => {
    const state = migration?.state || null
    return {
      migratedFrom: state?.migratedFrom ?? null,
      migratedAt: state?.migratedAt ?? null,
      pending: Boolean(state?.pending),
    }
  }

  /** 主分发（内部）：抛错由下面的 handle 统一兜底成 502 JSON。 */
  const dispatch = async (req, res) => {
    // 每次请求读实时配置：面板改了 allowRemote 必须立刻生效，不能闭包快照。
    const addr = req.socket?.remoteAddress
    if (!bool(config?.panel?.allowRemote, false) && !isLoopback(addr)) {
      return sendJson(res, 403, { ok: false, error: 'not_loopback' })
    }

    const traceId = traceIdOf(req)

    let path = ''
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '' }

    const ident = resolveIdentity(
      getIdentityCfg(),
      typeof getIdentityHint === 'function' ? getIdentityHint() : null,
      typeof getHostUserId === 'function' ? String(getHostUserId() || '') : '',
      // 路由没有会话 header ⇒ 会话 workspace 维度只在 hook（pre-step）启用。
      '',
    )
    if (!ident.ok) return sendJson(res, 400, { ok: false, error: ident.error })
    const identity = ident.identity
    /** 面板要的只读身份视图（不泄漏正文）：来源逐字段可查。 */
    const identityView = () => ({
      mode: String(value(config?.identity?.mode, 'auto')),
      userId: identity.userId,
      roleId: identity.roleId,
      workspace: identity.workspace,
      source: ident.source,
      workspaceSource: ident.sources?.workspace || 'default',
      // 路由没有会话 header，identity.workspace 只是 Config/hint 的值；真正生效的会话
      // workspace 由 hook 在最近一次召回时写进 identityState，这里只读展示（面板据此显示）。
      runtimeWorkspace: identityState?.lastRecall?.workspace || null,
      runtimeWorkspaceSource: identityState?.lastRecall?.workspaceSource || null,
    })

    /** 请求显式带 workspace（string，含空串）时覆盖 Config；不带就沿用 handle 顶部身份。 */
    const withRequestWorkspace = (workspace) => {
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

    /** GET 查询串里的身份覆盖参数（不带的键为 undefined ⇒ 不覆盖）。 */
    const identityParams = (params) => ({
      userId: params.get('userId') ?? undefined,
      roleId: params.get('roleId') ?? undefined,
      workspace: params.get('workspace') ?? undefined,
    })

    /** 后端状态视图（/stats 与 /version 同源）：local 恒 match，http/hybrid 读 protocolStatus。 */
    const backendView = () => {
      const status = backend?.protocolStatus || null
      const mode = String(backend?.mode || value(config?.backend?.mode, 'local'))
      return {
        mode,
        ready: backend?.ready === undefined ? true : Boolean(backend.ready),
        protocol: status ? (status.protocol ?? null) : WHALE_PROTOCOL,
        expected: String(status?.expected || WHALE_PROTOCOL),
        match: status ? Boolean(status.ok) : true,
      }
    }
    /** outbox 只读出口：只有 hybrid 有（local/http 为 null，键仍存在）。 */
    const backendOutbox = () => {
      const outbox = backend?.outbox
      return outbox && typeof outbox === 'object' ? outbox : null
    }

    // 后端状态出口（审计 P0-7）：面板页头据此显示「local/http/hybrid · 协议 OK/不兼容 · outbox n」。
    if (path === `${PREFIX}/version` && req.method === 'GET') {
      const view = backendView()
      const status = backend?.protocolStatus || null
      return sendJson(res, 200, {
        ok: true,
        protocol: view.protocol,
        expected: view.expected,
        match: view.match,
        mode: view.mode,
        baseUrl: String(status?.baseUrl || backend?.baseUrl || ''),
        protocolStatus: status,
        outbox: backendOutbox(),
      })
    }

    if (path === `${PREFIX}/stats` && req.method === 'GET') {
      const data = await backend.stats()
      const outbox = backendOutbox()
      return sendJson(res, 200, data
        ? {
          ok: true, offline: false, stats: data, identity: identityView(), migration: migrationView(),
          backend: backendView(), ...(outbox ? { outbox } : {}),
        }
        : {
          ok: false, offline: true, error: 'backend_unreachable', identity: identityView(),
          migration: migrationView(), backend: backendView(), ...(outbox ? { outbox } : {}),
        })
    }

    if (path === `${PREFIX}/recent` && req.method === 'GET') {
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const limit = clamp(params.get('limit'), 1, 10, 3)
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = await backend.recent(limit, { identity: idn.identity })
      return sendJson(res, data ? 200 : 502, data
        ? { ok: true, items: data.items || data || [] }
        : { ok: false, error: 'backend_unreachable' })
    }

    if (path === `${PREFIX}/search` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const query = typeof body.value?.query === 'string' ? body.value.query.trim().slice(0, 200) : ''
      if (!query) return sendJson(res, 400, { ok: false, error: 'invalid_query' })
      const limit = clamp(body.value?.limit, 1, 20, 5)
      // 请求显式带 workspace 时优先用请求值（面板/外部调用方可指定分区）；
      // 不带则保持 Config（路由无会话 header）。
      const identForRequest = withRequestWorkspace(body.value?.workspace)
      if (!identForRequest.ok) return sendJson(res, 400, { ok: false, error: identForRequest.error })
      const started = Date.now()
      const data = await backend.search({ query, limit, identity: identForRequest.identity, traceId })
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      return sendJson(res, 200, {
        ok: true,
        count: Number(data.count ?? (Array.isArray(data.hits) ? data.hits.length : 0)),
        hits: Array.isArray(data.hits) ? data.hits : [],
        below_min_n: Number(data.below_min_n ?? 0),
        elapsed_ms: Date.now() - started,
        trace_id: traceId,
      })
    }

    // 纯检索测试：只走 search（无生成模型、无写库、无 trace 副作用）。
    if (path === `${PREFIX}/recall-test` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const query = typeof body.value?.query === 'string' ? body.value.query.trim().slice(0, 200) : ''
      if (!query) return sendJson(res, 400, { ok: false, error: 'invalid_query' })
      const maxHits = clamp(body.value?.maxHits, 1, 10, 5)
      const identForRequest = withRequestWorkspace(body.value?.workspace)
      if (!identForRequest.ok) return sendJson(res, 400, { ok: false, error: identForRequest.error })
      const started = Date.now()
      const data = await backend.search({ query, limit: maxHits, identity: identForRequest.identity, traceId })
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      return sendJson(res, 200, {
        ok: true,
        mode: 'search-only',
        count: Number(data.count ?? (Array.isArray(data.hits) ? data.hits.length : 0)),
        hits: Array.isArray(data.hits) ? data.hits : [],
        elapsed_ms: Date.now() - started,
        trace_id: traceId,
      })
    }

    // 写入（S2）：文本硬顶 500 字符，level/memory_type 只认契约枚举，tag 收敛成字符串数组。
    if (path === `${PREFIX}/write`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const text = typeof body.value?.text === 'string' ? body.value.text.trim() : ''
      if (!text || text.length > MAX_WRITE_CHARS) return sendJson(res, 400, { ok: false, error: 'invalid_text' })

      const rawLevel = body.value?.level
      if (rawLevel !== undefined && !['core', 'important', 'normal'].includes(rawLevel)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_level' })
      }
      const rawType = body.value?.memory_type
      if (rawType !== undefined && !['semantic', 'procedural', 'episodic', 'mixed'].includes(rawType)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_memory_type' })
      }
      const rawTags = body.value?.tags
      if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string'))) {
        return sendJson(res, 400, { ok: false, error: 'invalid_tags' })
      }
      const tags = [...new Set((rawTags || []).map((t) => t.trim()).filter(Boolean))].slice(0, 32)

      if (typeof backend.write !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })

      let result
      try {
        result = await backend.write({
          text,
          level: rawLevel || 'normal',
          memory_type: rawType || 'semantic',
          tags,
          identity,
          traceId,
        })
      } catch (err) {
        log(`[whale-memory] write fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (!result) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      if (result.ok === false) {
        const whitelisted = WRITE_ERROR_CODES.has(result.error)
        return sendJson(res, whitelisted ? 400 : 502, {
          ok: false,
          error: whitelisted ? result.error : 'backend_error',
        })
      }
      if (result.id === undefined || result.id === null) {
        if (result.candidate || result.action === 'CANDIDATE') {
          return sendJson(res, 200, { ok: true, id: null, candidate: true })
        }
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      return sendJson(res, 200, { ok: true, id: String(result.id) })
    }

    // 批量导入（S2）：只收 JSONL 字符串，默认 dryRun=false；统计由 backend 给出。
    if (path === `${PREFIX}/import`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req, MAX_IMPORT_ENVELOPE)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const jsonl = body.value?.jsonl
      if (typeof jsonl !== 'string') return sendJson(res, 400, { ok: false, error: 'invalid_jsonl' })
      if (Buffer.byteLength(jsonl, 'utf8') > MAX_IMPORT_BYTES) {
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' })
      }
      const dryRun = body.value?.dryRun === true
      const lineCount = jsonl.split('\n').filter((s) => s.trim()).length

      // 大导入不占主线程：>50 行走 202 + jobId，后台每批 50 条。
      if (!dryRun && lineCount > 50 && typeof backend.startImport === 'function') {
        try {
          const started = await backend.startImport({ jsonl, identity })
          res.statusCode = 202
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          return res.end(JSON.stringify({ ok: true, async: true, jobId: started.jobId, total: started.total }))
        } catch (err) {
          log(`[whale-memory] import start fail: ${err?.message || 'error'}`)
          return sendJson(res, 502, { ok: false, error: 'backend_error' })
        }
      }

      if (typeof backend.importJsonl !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let result
      try {
        result = await backend.importJsonl({ jsonl, identity, dryRun })
      } catch (err) {
        log(`[whale-memory] import fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (!result) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      if (result.ok === false) return sendJson(res, 502, { ok: false, error: 'backend_error' })
      const resultBody = {
        ok: true,
        added: Number(result.added ?? 0),
        skipped: Number(result.skipped ?? 0),
        errors: Number(result.errors ?? 0),
        dryRun: result.dryRun === undefined ? dryRun : Boolean(result.dryRun),
      }
      // 计划书 §8.3 的「保留/拆分/拒绝」三计数：只有 backend 真返回时才透传（旧/假后端保持原契约）。
      if (result.kept !== undefined) resultBody.kept = Number(result.kept)
      if (result.split !== undefined) resultBody.split = Number(result.split)
      if (result.rejected !== undefined) resultBody.rejected = Number(result.rejected)
      if (result.reasons && typeof result.reasons === 'object') resultBody.reasons = result.reasons
      if (Array.isArray(result.error_details)) resultBody.error_details = result.error_details.slice(0, 20)
      return sendJson(res, 200, resultBody)
    }

    // 导出（S2）：直接回 JSONL 正文，不再套 JSON 信封；固定下载文件名。
    if (path === `${PREFIX}/export`) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      if (typeof backend.exportJsonl !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let jsonl
      try {
        jsonl = await backend.exportJsonl({ identity })
      } catch (err) {
        log(`[whale-memory] export fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (typeof jsonl !== 'string') return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('content-disposition', 'attachment; filename="whale-memory.jsonl"')
      res.setHeader('cache-control', 'no-store')
      return res.end(jsonl)
    }

    // 节点分页（S2）：limit 夹到 1..100，offset 从 0 起；total 由 backend 给。
    if (path === `${PREFIX}/nodes`) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const limit = clamp(params.get('limit'), 1, 100, 20)
      const offset = clamp(params.get('offset'), 0, 1_000_000, 0)
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      if (typeof backend.nodes !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let data
      try {
        data = await backend.nodes({ identity: idn.identity, limit, offset })
      } catch (err) {
        log(`[whale-memory] nodes fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      const items = Array.isArray(data.items) ? data.items : []
      const total = Number(data.total)
      return sendJson(res, 200, { ok: true, items, total: Number.isFinite(total) ? total : items.length })
    }

    // 双轨同步（S4）：dryRun 预演差异；真跑必须 confirm=true。bridge 不在→502。
    if (path === `${PREFIX}/sync`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      if (!bool(config?.sync?.enabled, false)) return sendJson(res, 501, { ok: false, error: 'sync_disabled' })
      const direction = String(body.value?.direction || 'pull')
      if (!['pull', 'push', 'both'].includes(direction)) return sendJson(res, 400, { ok: false, error: 'invalid_direction' })
      const dryRun = body.value?.dryRun !== false
      if (!dryRun && body.value?.confirm !== true) return sendJson(res, 400, { ok: false, error: 'confirm_required' })
      const transport = new HttpSyncTransport({ baseUrl: value(config?.sync?.bridgeUrl, ''), log })
      if (!transport.baseUrl) return sendJson(res, 501, { ok: false, error: 'sync_bridge_unset' })
      const ident = resolveIdentity(getIdentityCfg())
      if (!ident.ok) return sendJson(res, 400, { ok: false, error: ident.error })
      const out = {}
      if (direction === 'pull' || direction === 'both') out.pull = await pullFromGateway({ backend, transport, identity: ident.identity, dryRun, traceId })
      if (direction === 'push' || direction === 'both') out.push = await pushToGateway({ backend, transport, identity: ident.identity, dryRun, traceId })
      return sendJson(res, 200, { ok: true, dryRun, trace_id: traceId, ...out })
    }

    // 手动反思（S4）：不阻塞；返回 started，结果由 stats/日志观察。
    if (path === `${PREFIX}/reflect`) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      if (!reflect || typeof reflect.trigger !== 'function') {
        return sendJson(res, 501, { ok: false, error: 'reflect_unavailable' })
      }
      const result = await reflect.trigger()
      if (result?.ok === false && result.reason === 'busy') return sendJson(res, 409, { ok: false, error: 'busy' })
      return sendJson(res, 200, { ok: true, started: true, result })
    }

    // 导入进度：202 后 UI 轮询这里。
    if (path === `${PREFIX}/import/status`) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || ''
      if (!id || typeof backend.importStatus !== 'function') return sendJson(res, 400, { ok: false, error: 'invalid_job_id' })
      const st = await backend.importStatus(id)
      return sendJson(res, st?.ok === false ? 404 : 200, st?.ok === false ? st : { ok: true, ...st.job })
    }

    // 单节点详情 / 编辑归档
    if (path.startsWith(`${PREFIX}/nodes/`)) {
      const id = decodeURIComponent(path.slice(`${PREFIX}/nodes/`.length))
      if (req.method === 'GET') {
        if (typeof backend.getNode !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
        const params = new URL(req.url, 'http://127.0.0.1').searchParams
        const idn = requestIdentity(identityParams(params))
        if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
        // 不属本身份的节点按 404 处理：存在性本身不该跨身份可探测。
        const got = await backend.getNode(id, { identity: idn.identity })
        if (got?.ok === false) return sendJson(res, 404, got)
        // edges 可选：旧后端不返回时保持 null 语义，面板据此显示“未提供”。
        const edges = Array.isArray(got.edges) ? got.edges : null
        return sendJson(res, 200, { ok: true, node: got.node, edges })
      }
      if (req.method === 'PATCH') {
        if (typeof backend.updateNode !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
        const body = await readJson(req)
        if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
        const idn = requestIdentity(body.value)
        if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
        const got = await backend.updateNode(
          id,
          body.value?.patch || body.value || {},
          { identity: idn.identity, traceId },
        )
        return sendJson(res, got?.ok === false ? 400 : 200, got)
      }
      return sendMethodNotAllowed(res, 'GET, PATCH')
    }

    if (path === `${PREFIX}/writes` && req.method === 'GET') {
      if (typeof backend.writes !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const limit = clamp(params.get('limit'), 1, 100, 20)
      const action = String(params.get('action') || '').trim().slice(0, 32)
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = await backend.writes(limit, action, { identity: idn.identity })
      return sendJson(res, 200, { ok: true, items: data.items || [] })
    }

    if (path === `${PREFIX}/recalls` && req.method === 'GET') {
      if (typeof backend.recalls !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      // 缺省 limit 走真默认 20（clamp 收到 null 会当成 0 夹到 1，fallback 就成了死代码）。
      const limitRaw = params.get('limit')
      const limit = limitRaw === null || limitRaw.trim() === '' ? 20 : clamp(limitRaw, 1, 100, 20)
      // 过滤参数：source 截 32；since 只认数字秒（非数字忽略，不 400——面板旧版可能带脏值）；
      // filter 只认白名单，未知值按不过滤处理。
      const source = String(params.get('source') || '').trim().slice(0, 32)
      const sinceRaw = params.get('since')
      const sinceNum = sinceRaw === null || sinceRaw.trim() === '' ? NaN : Number(sinceRaw)
      const since = Number.isFinite(sinceNum) ? sinceNum : null
      const filterRaw = String(params.get('filter') || '').trim()
      const filter = filterRaw === 'zero' || filterRaw === 'unused' ? filterRaw : ''
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = await backend.recalls(limit, { source, since, filter, identity: idn.identity })
      return sendJson(res, 200, { ok: true, items: data.items || [] })
    }

    if (path === `${PREFIX}/edges` && req.method === 'GET') {
      if (typeof backend.edges !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const limit = clamp(params.get('limit'), 1, 100, 50)
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = await backend.edges(limit, { identity: idn.identity })
      return sendJson(res, 200, { ok: true, ...data })
    }

    if (path === `${PREFIX}/evolution` && req.method === 'GET') {
      if (typeof backend.evolution !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const limit = clamp(params.get('limit'), 1, 100, 50)
      const idn = requestIdentity(identityParams(params))
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = await backend.evolution(limit, { identity: idn.identity })
      return sendJson(res, 200, { ok: true, items: data.items || [] })
    }

    // shadow 候选审核：accept → 落节点；reject → 留理由（架构书 §6.2）。
    if (path === `${PREFIX}/write/review` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const id = Number(body.value?.id)
      const decision = String(body.value?.decision || '')
      if (!Number.isFinite(id) || !['accept', 'reject'].includes(decision)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_review' })
      }
      if (typeof backend.reviewWrite !== 'function') return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      const got = await backend.reviewWrite(id, decision, String(body.value?.reason || '').slice(0, 200))
      if (!got?.ok) return sendJson(res, got?.error === 'candidate_not_found' ? 404 : 400, got)
      return sendJson(res, 200, got)
    }

    if (path === `${PREFIX}/config` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const next = body.value?.config
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_config' })
      }
      const patch = pickConfigKeys(next)
      if (Object.keys(patch).length === 0) {
        return sendJson(res, 400, { ok: false, error: 'invalid_config' })
      }
      try {
        const editor = ctx?.get?.('configEditor')
        if (!editor || typeof editor.edit !== 'function' || !ctx?.fiber?.entry) {
          return sendJson(res, 501, { ok: false, error: 'config_save_unavailable' })
        }
        let saved = null
        // 只按提交的叶子深合并；current 里的未提交字段原样保留。
        await editor.edit(ctx.fiber.entry, (current) => {
          saved = deepMergeLeaf(resolveTree(current || {}), patch)
          return saved
        })
        saved = readBackConfig(editor, ctx.fiber.entry, saved)
          || deepMergeLeaf(echoConfig(config), patch)
        syncRuntimeConfig(config, saved)
        return sendJson(res, 200, { ok: true })
      } catch (err) {
        log(`[whale-memory] config save fail: ${err?.message || err}`)
        return sendJson(res, 501, { ok: false, error: 'config_save_failed' })
      }
    }

    if (path === `${PREFIX}/config` && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        config: echoConfig(config),
        runtimeIdentity: identityView(),
        // 文档 §4 S11 写 0=不限制，代码里 0=关闭注入；以代码为准，冲突待文档侧修正。
        notes: { recall_charBudget: '0 = 关闭注入（与文档 §4 S11 的 0=不限制 冲突，以代码为准）' },
      })
    }

    // 规则只读/管理端点（R3a）：命中即返回 true，未命中继续走 404。
    if (await handleRules({ req, res, path, config, backend, log })) return undefined

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

export { PREFIX }
