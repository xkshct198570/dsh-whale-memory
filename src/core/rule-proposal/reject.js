// 职责：拒绝候选（冷却日志 + status=rejected + 清会话 pending）；依赖：../../shared/config-values.js + ./store.js + ./session.js；不 import 门面。
import { join } from 'node:path'
import { num } from '../../shared/config-values.js'
import {
  textOf, trimmed, isoNow, proposalsDirOf, readProposal, mkdirIfNeeded,
  appendRejected, writeProposalFile,
} from './store.js'
import { clearSessionPending } from './session.js'

/**
 * 拒绝候选：写冷却日志 + status=rejected。
 * @param {{id:string, reason?:string, identity?:object, rulesDir?:string, config?:any, now?:number}} args
 * @returns {{ok:boolean, proposal?:object, error?:string}}
 */
export function rejectProposal({ id, reason = '', identity = {}, rulesDir, config, now = Date.now() } = {}) {
  const got = readProposal({ rulesDir, config, id })
  if (!got.ok) return { ok: false, error: got.error }
  const proposal = got.proposal
  // 只有未裁定的候选能被拒绝：已收录的候选再拒绝会写出矛盾的冷却记录。
  if (!['pending', 'needs_manual'].includes(textOf(proposal.status))) {
    return { ok: false, error: 'proposal_not_pending' }
  }
  const dir = proposalsDirOf(rulesDir, config)
  const ident = identity && typeof identity === 'object' ? identity : {}
  const entry = {
    hash: textOf(proposal.hash),
    ts: now,
    // 绝对到期时间：时钟回拨不会让冷却永久冻结（isCooling 只比 now < expiresAt）。
    expiresAt: now + Math.max(0, num(config?.rules?.askCooldownDays, 30)) * 24 * 3600 * 1000,
    id: textOf(proposal.id),
    reason: trimmed(reason).slice(0, 200),
    userId: trimmed(ident.userId),
    roleId: trimmed(ident.roleId),
  }
  try {
    mkdirIfNeeded(dir)
  } catch { /* 冷却写失败不阻止状态更新；面板仍能看到 rejected */ }
  const logged = appendRejected(dir, entry, now)
  const next = {
    ...proposal,
    status: 'rejected',
    updated: isoNow(now),
    rejected: { at: isoNow(now), reason: entry.reason, cooling: logged.ok },
  }
  const written = writeProposalFile(proposal.file || join(dir, `${proposal.id}.json`), next)
  if (!written.ok) return { ok: false, error: 'write_failed' }
  clearSessionPending(proposal.sessionId || '')
  return { ok: true, proposal: next }
}
