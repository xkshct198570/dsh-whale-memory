/**
 * 记忆身份推导：把 Config 的 identity 收敛成查询/写入都用的三元组。
 *
 * 注意：identity 四字段都是 schemastery `.volatile()`，运行时是 Ref；
 * 这里必须先解 Ref 再比较 mode/拼接 hint，否则 `mode === 'fixed'` 恒 false、
 * userId 会把 Ref 对象当字符串传进后端。
 *
 * hint 来自外部插件（如角色切换器）的"身份提示"：A 只认 role_id/workspace/user_id，
 * 不认识"角色"是什么；没有 hint 时完全按本包 Config 走（保持纯粹）。
 */
import { value } from './config-values.js'

/** @typedef {{ userId?: string, roleId?: string, workspace?: string }} IdentityHint */
/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

/** @param {any} cfg @param {string} key @returns {string} */
const text = (cfg, key) => {
  const raw = value(cfg?.[key], '')
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * @param {any} cfg identity 组（字段可能是 Ref）
 * @param {IdentityHint | null} [hint]
 * @returns {{ ok: true, identity: Identity } | { ok: false, error: 'identity_required' }}
 */
export function resolveIdentity(cfg, hint = null) {
  if (!cfg) return { ok: false, error: 'identity_required' }
  const merged = {
    mode: value(cfg.mode, 'auto'),
    userId: text(cfg, 'userId'),
    roleId: text(cfg, 'roleId'),
    workspace: text(cfg, 'workspace'),
  }
  if (hint?.userId) merged.userId = text(hint, 'userId')
  if (hint?.roleId !== undefined) merged.roleId = text(hint, 'roleId')
  if (hint?.workspace !== undefined) merged.workspace = text(hint, 'workspace')

  if (merged.mode === 'fixed') {
    if (!merged.userId) return { ok: false, error: 'identity_required' }
    return { ok: true, identity: { userId: merged.userId, roleId: merged.roleId || '', workspace: merged.workspace || '' } }
  }
  // auto：S1 还没有 DSH 会话用户可读，退化为配置/hint；S2 再接会话上下文。
  return {
    ok: true,
    identity: { userId: merged.userId || 'local', roleId: merged.roleId || '', workspace: merged.workspace || '' },
  }
}
