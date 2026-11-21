/**
 * 只读路由（S1）：stats / recent / search / recall-test。
 *
 * 边界（厂长令）：本包只做"记与查"，不扮演角色、不调大模型。
 * recall-test 只是"输入词 -> 返回命中条目"的纯检索，绝不调用任何生成模型。
 */
import { clamp, isLoopback, readJson, sendJson } from './http-kit.js'
import { resolveIdentity } from './identity.js'

const PREFIX = '/whale-memory/api'

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
