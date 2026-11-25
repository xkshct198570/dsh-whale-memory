/**
 * Session Wrap 面板端点：/wrap、/wrap/status、/wrap/report。
 * 拆分（P2d）：一个动作入口 + 只读状态/报告；材料必须来自宿主会话缓冲。
 * 依赖方向：host → host/http-kit + shared/error-table。
 */
import { readJson } from '../http-kit.js'
import { statusOf } from '../../shared/error-table.mjs'
import { PREFIX } from './prefix.js'

export async function handleWrap({
  req, res, path, wrap, sendJson, sendMethodNotAllowed, requestIdentity, identityParams,
}) {
    if (path === `${PREFIX}/wrap` && req.method === 'POST') {
      if (!wrap || typeof wrap.manual !== 'function') return sendJson(res, 502, { ok: false, error: 'wrap_unavailable' })
      const body = await readJson(req)
      if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error })
      const sessionId = typeof body.value?.sessionId === 'string' ? body.value.sessionId.trim() : ''
      const got = await wrap.manual({ sessionId })
      if (!got || got.ok !== true) {
        const reason = String(got?.reason || 'wrap_failed')
        const status = reason === 'unsupported_backend' ? 501
          : reason === 'wrap_disabled' || reason === 'no_material' || reason === 'turn_in_progress'
            || reason === 'busy' || reason === 'busy_wrap' || reason === 'same_material'
            || reason === 'no_session' ? 409
            : reason === 'identity_required' || reason === 'invalid_session' ? 400
              : reason === 'db_error' ? 502 : 500
        return sendJson(res, status, { ok: false, error: reason })
      }
      return sendJson(res, 200, got)
    }


    if (path === `${PREFIX}/wrap/sessions` && req.method === 'GET') {
      if (!wrap || typeof wrap.sessions !== 'function') return sendJson(res, 502, { ok: false, error: 'wrap_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const hasOverride = ['userId', 'roleId', 'workspace'].some((key) => params.get(key) !== null)
      const idn = hasOverride ? requestIdentity(identityParams(params)) : { ok: true, identity: null }
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = wrap.sessions({ identity: idn.identity })
      return sendJson(res, data?.ok === false ? statusOf(data.error, 502) : 200, data)
    }

    if (path === `${PREFIX}/wrap/status` && req.method === 'GET') {
      if (!wrap || typeof wrap.status !== 'function') return sendJson(res, 502, { ok: false, error: 'wrap_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      // 面板默认看“本机最近一次”；只有显式带身份参数才按分区过滤（远端已在上面被拒）。
      const hasOverride = ['userId', 'roleId', 'workspace'].some((key) => params.get(key) !== null)
      const idn = hasOverride ? requestIdentity(identityParams(params)) : { ok: true, identity: null }
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const data = wrap.status({ identity: idn.identity })
      return sendJson(res, data?.ok === false ? statusOf(data.error, 502) : 200, data)
    }


    if (path === `${PREFIX}/wrap/report` && req.method === 'GET') {
      if (!wrap || typeof wrap.report !== 'function') return sendJson(res, 502, { ok: false, error: 'wrap_unavailable' })
      const params = new URL(req.url, 'http://127.0.0.1').searchParams
      const id = Number(params.get('id'))
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { ok: false, error: 'invalid_id' })
      // 显式身份参数必须参与作用域（审计 P1-03）：默认面板保持“本机最近一次”，
      // 但调用方一旦声明 userId/roleId/workspace，就不能按 id 跨分区直读报告。
      const hasOverride = ['userId', 'roleId', 'workspace'].some((key) => params.get(key) !== null)
      const idn = hasOverride ? requestIdentity(identityParams(params)) : { ok: true, identity: null }
      if (!idn.ok) return sendJson(res, 400, { ok: false, error: idn.error })
      const got = wrap.report(id, { identity: idn.identity })
      if (!got?.ok) {
        const error = String(got?.error || 'report_unavailable')
        const status = error === 'report_missing' ? 404 : error === 'report_path_outside' ? 403 : 502
        return sendJson(res, status, { ok: false, error })
      }
      return sendJson(res, 200, { ok: true, runId: got.runId, text: String(got.text || '') })
    }
  return false
}
