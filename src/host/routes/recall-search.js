/**
 * 检索与观测读：/search、/recall-test、/writes、/recalls、/edges、/evolution。
 * 拆分（P2d）：纯检索与只读列表端点；不写库、不调模型。
 * 依赖方向：host → host/http-kit + 参数注入的 backend/身份函数。
 */
import { clamp, readJson } from '../http-kit.js'
import { PREFIX } from './prefix.js'

export async function handleRecallSearch({
  req, res, path, backend, traceId, sendJson,
  withRequestWorkspace, requestIdentity, identityParams,
}) {
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
  return false
}
