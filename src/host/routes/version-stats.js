/**
 * 只读版本/统计/最近节点：/version、/stats、/recent。
 * 拆分（P2d）：端点分支从 routes.js 原样搬出，router 只做分派。
 * 依赖方向：host → host/http-kit + 参数注入的 backend/视图函数。
 */
import { clamp } from '../http-kit.js'
import { PREFIX } from './prefix.js'

export async function handleVersionStats({
  req, res, path, backend, sendJson,
  requestIdentity, identityParams, identityView, migrationView, backendView, backendOutbox,
}) {
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
      let data
      try {
        data = await backend.stats()
      } catch (err) {
        // 迁移快照 fail-closed：没有库可读，但原因必须可见（统一 502 backend_error 会把它吞成
        // 不可行动的"后端错误"）；error 带完整 `migration_backup_failed:<reason>`，
        // 面板离线卡按 errText 原样显示，health 区就是这条。
        if (err?.code !== 'migration_backup_failed') throw err
        return sendJson(res, 502, {
          ok: false, offline: true, error: String(err.message || err).slice(0, 200),
          identity: identityView(), migration: migrationView(), backend: backendView(), reason: String(err.reason || ''),
        })
      }
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

  return false
}
