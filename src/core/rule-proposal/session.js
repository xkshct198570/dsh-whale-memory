// 职责：会话候选待确认映射（TTL/确认意图/提示行/nonce）；依赖：./store.js（trimmed/chars/PROPOSAL_ID_RE）；不 import 门面/apply/create/reject。
import { chars, trimmed, PROPOSAL_ID_RE } from './store.js'

/** 会话候选映射 TTL：用户隔了半小时才回「确认」就不要再猜是哪条。 */
export const SESSION_PENDING_TTL_MS = 30 * 60 * 1000
/** 会话候选映射：只存最新一条（一屏只问一条，避免"确认"指代不明）。 */
const sessionPending = new Map()

// ---------------------------------------------------------------------------
// 会话候选映射
// ---------------------------------------------------------------------------

/** @param {string} sessionId @param {string} proposalId @param {number} [now] */
export function setSessionPending(sessionId, proposalId, now = Date.now()) {
  const sid = trimmed(sessionId)
  if (!sid || !PROPOSAL_ID_RE.test(trimmed(proposalId))) return false
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  // 绝对到期时间（R9-14）：时钟回拨时 `now - at` 会变负、TTL 被永久冻结；落 expAt 只延长到原点。
  sessionPending.set(sid, { proposalId: trimmed(proposalId), at, expAt: at + SESSION_PENDING_TTL_MS })
  return true
}

/** @returns {{proposalId:string, at:number, expAt:number}|null} */
export function getSessionPending(sessionId, now = Date.now()) {
  const sid = trimmed(sessionId)
  if (!sid) return null
  const entry = sessionPending.get(sid)
  if (!entry) return null
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const at = Number(entry.at) || 0
  // 兼容旧内存形状（只有 at）：缺失 expAt 时按 at+TTL 推导，不因升级丢 pending。
  const expAt = Number.isFinite(Number(entry.expAt)) ? Number(entry.expAt) : at + SESSION_PENDING_TTL_MS
  if (nowMs >= expAt) {
    sessionPending.delete(sid)
    return null
  }
  return { proposalId: entry.proposalId, at, expAt }
}

export function clearSessionPending(sessionId) {
  const sid = trimmed(sessionId)
  if (sid) sessionPending.delete(sid)
}

/** 测试/dispose 用：清空全部映射。 */
export function resetSessionPending() {
  sessionPending.clear()
}

/** 确认词头（架构书 §4.6 的裁定词表；只认句首，避免「对/好」这类口头词误判）。 */
const CONFIRM_HEAD_RE = /^(确认|确认一下|收录|收进铁律|加入铁律|加入|可以|好)/

/**
 * 确认意图识别：**只认短、明确、无问号的句子**。
 * 含糊回复（「看看」「那个呢」「好不好？」）一律不动状态——裁定必须有确定性。
 * @param {string} query
 * @returns {'confirm'|'none'}
 */
export function detectConfirmIntent(query) {
  const raw = trimmed(query)
  if (!raw) return 'none'
  if (chars(raw) > 12) return 'none'
  if (/[？?]/.test(raw) || /(吗|呢|吧？)\s*$/.test(raw)) return 'none'
  // 否定优先：「先不确认」包含「确认」，必须先挡住。
  if (/(不确认|先不|不要|不用|别|算了|取消|拒绝)/.test(raw)) return 'none'
  const compact = raw.replace(/[。！!，,、\s]+/g, '')
  if (!compact) return 'none'
  // 允许「我确认一下」「这条收进铁律」「那就收录」这类带主语/指代的短句，
  // 但确认词必须落在句首（去掉主语后）：句中偶然出现「对/好」不算裁定。
  const head = compact.replace(/^(我|这条|这个|那就|就|都|先)+/, '')
  return CONFIRM_HEAD_RE.test(head) ? 'confirm' : 'none'
}

// ---------------------------------------------------------------------------
// 确认提示行（nonce）
// ---------------------------------------------------------------------------

/**
 * 候选 nonce：`p` + hash8（面板/聊天同一枚，8 位足够短且与候选 id 同源）。
 * @param {object} proposal @returns {string} 无 hash8 时返回空串（退化到面板处理）。
 */
export function proposalNonce(proposal) {
  const hash8 = trimmed(proposal?.hash8)
    || (trimmed(proposal?.id).match(/_([0-9a-z]{8})$/)?.[1] || '')
  return hash8 ? `p${hash8.toLowerCase()}` : ''
}

/**
 * 候选提示行（聊天用）：必须带 `收录 <id8>`，不要让用户猜「确认」指哪条。
 * @param {object} proposal @returns {string}
 */
export function buildProposalAskLine(proposal = {}) {
  const nonce = proposalNonce(proposal)
  const summary = proposal.summary && typeof proposal.summary === 'object' ? proposal.summary : {}
  const label = trimmed(summary.label) || trimmed(proposal.draft?.key)
  const title = trimmed(summary.title)
  const relation = trimmed(proposal.relation?.relation) || 'new'
  const count = Array.isArray(proposal.relation?.targets) ? proposal.relation.targets.length : 0
  const kind = relation === 'new' ? '草稿' : `${relation}/${count} 条既有规则`
  const head = `【规则候选】${label}${title ? ` · ${title}` : ''}（${kind}）`
  if (!nonce) return `${head}——请在规则页签「待确认」面板处理。`
  return `${head}——回复「收录 ${nonce}」确认收进铁律，或到规则页签「待确认」面板处理。`
}

/**
 * 聊天确认的唯一合法形态：**整句** `[确认]收录 <p + 8 位 hex>`（架构书 §3.4）。
 * 正则锚定整句：句中转述、引用提示行、带问号/否定/额外文字一律不算确认。
 */
const CONFIRM_NONCE_RE = /^\s*(?:确认)?收录\s*[pP]([0-9a-fA-F]{8})\s*[。！!]?\s*$/

/**
 * 从一句话里取确认 nonce（带 `p` 前缀，小写）。
 * @param {string} query @returns {string} 空串=不是合法确认句
 */
export function confirmNonceOf(query) {
  const raw = trimmed(query)
  if (!raw) return ''
  const match = raw.match(CONFIRM_NONCE_RE)
  return match ? `p${match[1].toLowerCase()}` : ''
}
