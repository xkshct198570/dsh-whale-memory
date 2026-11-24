/**
 * 节点分页与详情/编辑：/nodes、/nodes/:id。
 * 拆分（P2d）：节点读写端点；详情不属本身份按 404，错误码经 error-table 映射。
 * 依赖方向：host → host/http-kit + shared/error-table。
 */
import { clamp, readJson } from '../http-kit.js'
import { statusOf } from '../../shared/error-table.mjs'
import { PREFIX } from './prefix.js'

export async function handleNodesReview({
  req, res, path, backend, traceId, log, sendJson, sendMethodNotAllowed,
  requestIdentity, identityParams,
}) {
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


    if (path.startsWith(`${PREFIX}/nodes/`)) {
      let id = ''
      try { id = decodeURIComponent(path.slice(`${PREFIX}/nodes/`.length)) } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid_id' })
      }
      if (!id) return sendJson(res, 400, { ok: false, error: 'invalid_id' })
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
          { identity: idn.identity, traceId, expectedUpdatedAt: body.value?.expectedUpdatedAt },
        )
        // 错误码 → 状态由单一真源表决定（node_changed=409，不再一律 400）。
        return sendJson(res, got?.ok === false ? statusOf(got.error, 400) : 200, got)
      }
      return sendMethodNotAllowed(res, 'GET, PATCH')
    }

  return false
}
