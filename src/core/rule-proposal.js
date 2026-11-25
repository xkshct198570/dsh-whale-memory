/**
 * 门面：规则提案公开 API 唯一出口；只 re-export，不承载业务分支。
 *
 * 依赖方向（单向，无环）：create/reject/apply → store/session；apply → rule-store/rule-plan/render/mirror。
 * 候选文件是待裁定草稿；规则真源在 rule-store.js，镜像在 rule-mirror.js。
 */
import {
  REJECTED_FILE, REJECTED_KEEP_DAYS, REJECTED_KEEP_LAST, PROPOSALS_ARCHIVE_DIR,
  proposalHashOf, resolveRuleRoot, proposalsDirOf, readProposal, listProposals,
  enforceProposalCap,
} from './rule-proposal/store.js'
import {
  SESSION_PENDING_TTL_MS, setSessionPending, getSessionPending, clearSessionPending,
  resetSessionPending, detectConfirmIntent, proposalNonce, buildProposalAskLine, confirmNonceOf,
} from './rule-proposal/session.js'
import { createProposal } from './rule-proposal/create.js'
import { rejectProposal } from './rule-proposal/reject.js'
import { applyProposal, confirmPendingForSession, callLlmMerge } from './rule-proposal/apply.js'

// 公开符号原样再导出：路径与导出名保持不变，调用方无需改动。
export {
  REJECTED_FILE, REJECTED_KEEP_DAYS, REJECTED_KEEP_LAST, PROPOSALS_ARCHIVE_DIR,
  proposalHashOf, resolveRuleRoot, proposalsDirOf, readProposal, listProposals,
  enforceProposalCap,
  SESSION_PENDING_TTL_MS, setSessionPending, getSessionPending, clearSessionPending,
  resetSessionPending, detectConfirmIntent, proposalNonce, buildProposalAskLine, confirmNonceOf,
  createProposal, rejectProposal,
  applyProposal, confirmPendingForSession, callLlmMerge,
}
