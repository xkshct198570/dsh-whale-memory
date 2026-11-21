/**
 * 记忆身份推导：把 Config 的 identity 收敛成查询/写入都用的三元组。
 *
 * hint 来自外部插件（如角色切换器）的"身份提示"：A 只认 role_id/workspace/user_id，
 * 不认识"角色"是什么；没有 hint 时完全按本包 Config 走（保持纯粹）。
 */
/** @typedef {{ userId?: string, roleId?: string, workspace?: string }} IdentityHint */
/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

/**
 * @param {{ mode: 'auto'|'fixed', userId: string, roleId: string, workspace: string }} cfg
 * @param {IdentityHint | null} [hint]
 * @returns {{ ok: true, identity: Identity } | { ok: false, error: 'identity_required' }}
 */
export function resolveIdentity(cfg, hint = null) {
  if (!cfg) return { ok: false, error: 'identity_required' }
  const merged = {
    ...cfg,
    ...(hint?.userId ? { userId: hint.userId } : {}),
    ...(hint?.roleId !== undefined ? { roleId: hint.roleId } : {}),
    ...(hint?.workspace !== undefined ? { workspace: hint.workspace } : {}),
  }
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
