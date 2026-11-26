/**
 * 写/审/改路由的身份覆盖闸：只回环、且必须等于 Config 或最近会话身份。
 *
 * 读面的覆盖（浏览其他分区）仍由 router 的 requestIdentity 承担；本模块只服务写面，
 * 避免把“能看”误当成“能写”。依赖方向：host 内部纯装配，不 import core。
 */

/** 最近一次会话身份（面板只读回显/写面同源校验）；没有会话历史时为 null。 */
export function runtimeIdentityOf(identityState) {
  const last = identityState && typeof identityState === 'object' ? identityState.lastRecall : null
  if (!last || typeof last !== 'object') return null
  return {
    userId: String(last.userId ?? ''),
    roleId: String(last.roleId ?? ''),
    workspace: String(last.workspace ?? ''),
    // 反思空闲/手动触发要把会话 id 一起带给 job payload（分区身份仍由三元组决定）。
    sessionId: String(last.sessionId ?? ''),
  }
}

/** 三元组严格相等（两边都已是归一后的值）。 */
export function sameIdentity(a, b) {
  return Boolean(a && b
    && String(a.userId) === String(b.userId)
    && String(a.roleId) === String(b.roleId)
    && String(a.workspace) === String(b.workspace))
}

/**
 * 生成写面身份闸。
 * @param {{ identity:object, canOverrideIdentity:boolean,
 *   requestIdentity:(source:object)=>{ok:boolean,identity?:object,error?:string},
 *   identityState:object|null }} deps
 * @returns {(source:object|null|undefined)=>{ok:true,identity:object}|{ok:false,error:string,status?:number}}
 */
export function createValidatedIdentityOverride({ identity, canOverrideIdentity, requestIdentity, identityState }) {
  const runtime = runtimeIdentityOf(identityState)
  return (source) => {
    if (!source || typeof source !== 'object') return { ok: true, identity }
    if (!canOverrideIdentity) return { ok: false, error: 'not_loopback', status: 403 }
    const got = requestIdentity(source)
    if (!got.ok) return got
    const wanted = {
      userId: String(got.identity.userId ?? identity.userId ?? ''),
      roleId: String(got.identity.roleId ?? identity.roleId ?? ''),
      workspace: String(got.identity.workspace ?? identity.workspace ?? ''),
    }
    if (!sameIdentity(wanted, identity) && !(runtime && sameIdentity(wanted, runtime))) {
      return { ok: false, error: 'identity_mismatch', status: 403 }
    }
    return { ok: true, identity: wanted }
  }
}
