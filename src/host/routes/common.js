/**
 * 路由通用 helper：身份/后端视图、405 出口。
 *
 * 拆分（P2d）：这些值只由 router 装配、供各端点组读取；不含端点分支。
 * 依赖方向：host → shared + host 内部。
 */
import { sendJson } from '../http-kit.js'
import { value } from '../../shared/config-values.js'
import { WHALE_PROTOCOL } from '../../core/backend.js'

/** 405 统一出口：带 allow 头。 */
export function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}

/** 身份只读视图（不泄漏正文）：来源逐字段可查。 */
export function makeIdentityView({ config, identity, ident, identityState }) {
  return () => ({
    mode: String(value(config?.identity?.mode, 'auto')),
    userId: identity.userId,
    roleId: identity.roleId,
    workspace: identity.workspace,
    source: ident.source,
    workspaceSource: ident.sources?.workspace || 'default',
    runtimeWorkspace: identityState?.lastRecall?.workspace || null,
    runtimeWorkspaceSource: identityState?.lastRecall?.workspaceSource || null,
  })
}

/** 后端状态视图（/stats 与 /version 同源）：local 恒 match，http/hybrid 读 protocolStatus。 */
export function makeBackendView({ backend, config }) {
  return () => {
    const status = backend?.protocolStatus || null
    const mode = String(backend?.mode || value(config?.backend?.mode, 'local'))
    return {
      mode,
      ready: backend?.ready === undefined ? true : Boolean(backend.ready),
      protocol: status ? (status.protocol ?? null) : WHALE_PROTOCOL,
      expected: String(status?.expected || WHALE_PROTOCOL),
      match: status ? Boolean(status.ok) : true,
      // 迁移 fail-closed 原因（未阻断时省略该键）：面板离线卡要能说出"为什么打不开"，而不是只说不可用。
      ...(backend?.openError ? { reason: String(backend.openError) } : {}),
    }
  }
}

/** outbox 只读出口：只有 hybrid 有（local/http 为 null，键仍存在）。 */
export function makeBackendOutbox({ backend }) {
  return () => {
    const outbox = backend?.outbox
    return outbox && typeof outbox === 'object' ? outbox : null
  }
}

/** 迁移只读视图（/stats）：没有安装迁移时给空值，键始终存在。 */
export function makeMigrationView({ migration }) {
  return () => {
    const state = migration?.state || null
    return {
      migratedFrom: state?.migratedFrom ?? null,
      migratedAt: state?.migratedAt ?? null,
      pending: Boolean(state?.pending),
    }
  }
}

/** 统一 trace_id：`x-trace-id` 头（≤64）优先，否则 `panel:<ms>`。 */
export function traceIdOf(req) {
  const raw = req?.headers?.['x-trace-id']
  const text = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return (trimmed || `panel:${Date.now()}`).slice(0, 64)
}
