/**
 * 记忆身份推导：把 Config 的 identity 收敛成查询/写入都用的三元组。
 *
 * 注意：identity 四字段都是 schemastery `.volatile()`，运行时是 Ref；
 * 这里必须先解 Ref 再比较 mode/拼接 hint，否则 `mode === 'fixed'` 恒 false、
 * userId 会把 Ref 对象当字符串传进后端。
 *
 * hint 来自外部插件（如角色切换器）的"身份提示"：A 只认 role_id/workspace/user_id，
 * 不认识"角色"是什么；没有 hint 时完全按本包 Config 走（保持纯粹）。
 *
 * 来源优先级（审计 §4 P1 · 身份 auto）：
 * - auto：userId = hint.userId > 宿主 userId（identity-source）> cfg.userId > 'local'；
 * - fixed：**行为不变**，userId 只认 hint/Config（宿主身份不参与），缺失仍报 identity_required；
 * - workspace：hint.workspace > 会话 cwd 派生（仅当 cfg.workspace 为空）> cfg.workspace > ''。
 *   现网 Config workspace='web' 非空 ⇒ 行为不变；清空后才启用会话维度。
 *
 * 返回 `source`（汇总标记）与 `sources`（逐字段标记）供面板显示：
 * 'hint' | 'host' | 'session' | 'config' | 'default'。
 */
import { value } from '../shared/config-values.js'

import { deriveWorkspace } from './identity-source.js'
export { deriveWorkspace }

/** @typedef {{ userId?: string, roleId?: string, workspace?: string }} IdentityHint */
/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */
/** @typedef {'hint' | 'host' | 'session' | 'config' | 'default'} IdentitySource */

/** @param {any} cfg @param {string} key @returns {string} */
const text = (cfg, key) => {
  const raw = value(cfg?.[key], '')
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * 汇总 source 的优先级：hint（显式覆盖）> session（会话 workspace 维度）> host（宿主 userId）
 * > config > default。
 *
 * 为什么 session 排 host 前：记忆分区由 workspace 决定，会话维度是最能区分"这次召回落在
 * 哪个工作区"的来源；userId 的来源仍在 `sources.userId` 逐字段可查，面板可平铺显示。
 */
const SOURCE_RANK = { hint: 4, session: 3, host: 2, config: 1, default: 0 }

/**
 * @param {IdentitySource} a
 * @param {IdentitySource} b
 * @returns {IdentitySource}
 */
const stronger = (a, b) => (SOURCE_RANK[a] >= SOURCE_RANK[b] ? a : b)

/**
 * workspace 优先级：hint > 会话（仅 cfg 为空）> cfg > ''。
 * @param {string} cfgWorkspace
 * @param {IdentityHint | null} hint
 * @param {string} sessionWorkspace
 * @returns {{ value: string, source: IdentitySource }}
 */
function resolveWorkspace(cfgWorkspace, hint, sessionWorkspace) {
  if (hint && hint.workspace !== undefined) return { value: text(hint, 'workspace'), source: 'hint' }
  if (!cfgWorkspace && sessionWorkspace) {
    return { value: String(sessionWorkspace).slice(0, 64), source: 'session' }
  }
  if (cfgWorkspace) return { value: cfgWorkspace, source: 'config' }
  return { value: '', source: 'default' }
}

/**
 * @param {any} cfg identity 组（字段可能是 Ref）
 * @param {IdentityHint | null} [hint]
 * @param {string} [hostUserId] 宿主会话身份（identity-source 缓存值；可空）
 * @param {string} [sessionWorkspace] 会话 header.cwd 派生值（仅 cfg.workspace 为空时生效）
 * @returns {{ ok: true, identity: Identity, source: IdentitySource, sources: { userId: IdentitySource, roleId: IdentitySource, workspace: IdentitySource } }
 *   | { ok: false, error: 'identity_required' }}
 */
export function resolveIdentity(cfg, hint = null, hostUserId = '', sessionWorkspace = '') {
  if (!cfg) return { ok: false, error: 'identity_required' }
  const mode = value(cfg.mode, 'auto')
  const cfgUserId = text(cfg, 'userId')
  const cfgRoleId = text(cfg, 'roleId')
  const cfgWorkspace = text(cfg, 'workspace')
  const hintedUserId = hint && hint.userId ? text(hint, 'userId') : ''
  const hintedRoleId = hint && hint.roleId !== undefined ? text(hint, 'roleId') : ''
  const hostId = typeof hostUserId === 'string' ? hostUserId.trim().slice(0, 128) : ''

  const ws = resolveWorkspace(cfgWorkspace, hint, sessionWorkspace)

  /** roleId：hint 显式给值（含空串）优先，其次 Config。 */
  const role = hint && hint.roleId !== undefined
    ? { value: hintedRoleId, source: /** @type {IdentitySource} */ ('hint') }
    : cfgRoleId
      ? { value: cfgRoleId, source: /** @type {IdentitySource} */ ('config') }
      : { value: '', source: /** @type {IdentitySource} */ ('default') }

  if (mode === 'fixed') {
    // fixed 行为不变：userId 只认 hint/Config，宿主 userId 不参与。
    const userId = hintedUserId || cfgUserId
    if (!userId) return { ok: false, error: 'identity_required' }
    const userIdSource = hintedUserId
      ? /** @type {IdentitySource} */ ('hint')
      : /** @type {IdentitySource} */ ('config')
    return {
      ok: true,
      identity: { userId, roleId: role.value, workspace: ws.value },
      source: stronger(stronger(userIdSource, role.source), ws.source),
      sources: { userId: userIdSource, roleId: role.source, workspace: ws.source },
    }
  }

  // auto：hint > 宿主会话 > Config > 'local'。
  /** @type {{ value: string, source: IdentitySource }} */
  let user
  if (hintedUserId) user = { value: hintedUserId, source: 'hint' }
  else if (hostId) user = { value: hostId, source: 'host' }
  else if (cfgUserId) user = { value: cfgUserId, source: 'config' }
  else user = { value: 'local', source: 'default' }

  return {
    ok: true,
    identity: { userId: user.value, roleId: role.value, workspace: ws.value },
    source: stronger(stronger(user.source, role.source), ws.source),
    sources: { userId: user.source, roleId: role.source, workspace: ws.source },
  }
}

/**
 * 子代理会话判据（唯一实现）：`origin==='subagent'` 或持久化 `delegationDepth>0`。
 *
 * 为什么两条都认：header 在恢复会话/不同宿主版本里的字段形态不一致，漏判会让子代理
 * 拿到写工具或首轮画像（都按"有人类可裁定"的前提设计）。
 *
 * @param {{ origin?: unknown, delegationDepth?: unknown } | null | undefined} header
 * @returns {boolean}
 */
export function isDelegatedHeader(header) {
  return header?.origin === 'subagent' || Number(header?.delegationDepth) > 0
}

/**
 * 会话身份（唯一判据）：会话 header 派生 workspace → resolveIdentity；不可判定返回失败。
 *
 * 为什么必须要求 `header.cwd`：auto 模式缺 cwd 时会回落到 Config 分区（如 'web'），
 * 把不同工作区混成同一分区。工具/画像/收尾都只接受"可判定"的会话身份，判据只此一处。
 *
 * @param {{
 *   header: object|null|undefined,
 *   getIdentityCfg: () => any,
 *   getIdentityHint: () => object|null|undefined,
 *   getHostUserId: () => string,
 * }} deps
 * @returns {{ ok: true, identity: Identity, sources?: object } | { ok: false, error: 'identity_required' }}
 */
export function sessionIdentityOf({ header, getIdentityCfg, getIdentityHint, getHostUserId }) {
  const sessionWorkspace = header ? deriveWorkspace(header) : ''
  if (!header || !sessionWorkspace) return { ok: false, error: 'identity_required' }
  const resolved = resolveIdentity(
    typeof getIdentityCfg === 'function' ? getIdentityCfg() : undefined,
    typeof getIdentityHint === 'function' ? getIdentityHint() : null,
    typeof getHostUserId === 'function' ? String(getHostUserId() || '') : '',
    sessionWorkspace,
  )
  if (!resolved?.ok || !resolved.identity?.userId || !resolved.identity?.workspace) {
    return { ok: false, error: 'identity_required' }
  }
  return { ok: true, identity: resolved.identity, sources: resolved.sources }
}
