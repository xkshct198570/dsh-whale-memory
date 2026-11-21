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

const PREFIX = '/whale-memory/api'

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
])

/** @param {import('node:http').ServerResponse} res @param {string} allow */
function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}

/** @param {{ config: any, backend: any, log?: (s:string)=>void }} deps */
export function createRoutes({ config, backend, getIdentityCfg = () => config?.identity, log = () => {} }) {
  const allowRemote = Boolean(config?.panel?.allowRemote)

  return async function handle(req, res) {
    const addr = req.socket?.remoteAddress
    if (!allowRemote && !isLoopback(addr)) return sendJson(res, 403, { ok: false, error: 'not_loopback' })

    let path = ''
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '' }

    const ident = resolveIdentity(getIdentityCfg())
    if (!ident.ok) return sendJson(res, 400, { ok: false, error: ident.error })
    const identity = ident.identity

    if (path === `${PREFIX}/stats` && req.method === 'GET') {
      const data = await backend.stats()
      return sendJson(res, 200, data
        ? { ok: true, offline: false, stats: data }
        : { ok: false, offline: true, error: 'backend_unreachable', identity })
    }

    if (path === `${PREFIX}/recent` && req.method === 'GET') {
      const limit = clamp(new URL(req.url, 'http://127.0.0.1').searchParams.get('limit'), 1, 10, 3)
      const data = await backend.recent(limit)
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
      const started = Date.now()
      const data = await backend.search({ query, limit, identity })
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      return sendJson(res, 200, {
        ok: true,
        count: Number(data.count ?? (Array.isArray(data.hits) ? data.hits.length : 0)),
        hits: Array.isArray(data.hits) ? data.hits : [],
        below_min_n: Number(data.below_min_n ?? 0),
        elapsed_ms: Date.now() - started,
      })
    }

    // 纯检索测试：只走 search（无生成模型、无写库、无 trace 副作用）。
    if (path === `${PREFIX}/recall-test` && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const query = typeof body.value?.query === 'string' ? body.value.query.trim().slice(0, 200) : ''
      if (!query) return sendJson(res, 400, { ok: false, error: 'invalid_query' })
      const maxHits = clamp(body.value?.maxHits, 1, 10, 5)
      const started = Date.now()
      const data = await backend.search({ query, limit: maxHits, identity })
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      return sendJson(res, 200, {
        ok: true,
        mode: 'search-only',
        count: Number(data.count ?? (Array.isArray(data.hits) ? data.hits.length : 0)),
        hits: Array.isArray(data.hits) ? data.hits : [],
        elapsed_ms: Date.now() - started,
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
      if (result.id === undefined || result.id === null) return sendJson(res, 502, { ok: false, error: 'backend_error' })
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
      return sendJson(res, 200, {
        ok: true,
        added: Number(result.added ?? 0),
        skipped: Number(result.skipped ?? 0),
        errors: Number(result.errors ?? 0),
        dryRun: result.dryRun === undefined ? dryRun : Boolean(result.dryRun),
      })
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
      if (typeof backend.nodes !== 'function') {
        return sendJson(res, 502, { ok: false, error: 'backend_unavailable' })
      }
      let data
      try {
        data = await backend.nodes({ identity, limit, offset })
      } catch (err) {
        log(`[whale-memory] nodes fail: ${err?.message || 'error'}`)
        return sendJson(res, 502, { ok: false, error: 'backend_error' })
      }
      if (!data) return sendJson(res, 502, { ok: false, error: 'backend_unreachable' })
      const items = Array.isArray(data.items) ? data.items : []
      const total = Number(data.total)
      return sendJson(res, 200, { ok: true, items, total: Number.isFinite(total) ? total : items.length })
    }

    if (path === `${PREFIX}/config` && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, config: redact(config) })
    }

    log(`[whale-memory] 404 ${req.method} ${path}`)
    return sendJson(res, 404, { ok: false, error: 'not_found' })
  }
}

/** 配置回显只给面板需要的字段，不把内部对象原样吐出。 */
function redact(config) {
  return {
    backend: { mode: config?.backend?.mode, url: config?.backend?.url, timeoutMs: config?.backend?.timeoutMs },
    identity: { ...config?.identity },
    recall: { ...config?.recall },
    panel: { allowRemote: config?.panel?.allowRemote, pollMs: config?.panel?.pollMs },
    advanced: { logLevel: config?.advanced?.logLevel },
  }
}

export { PREFIX }
