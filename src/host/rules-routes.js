/**
 * 规则 HTTP 路由门面：对外 import 路径保持不变，本文件只做 re-export。
 * 路由装配与 dispatch 在 `rules-routes/router.js`；各业务组按职责分目录，组间只走 shared。
 */
export { RULES_PREFIX, resolveRulesRoot } from './rules-routes/shared.js'
export { gitStatusPayload, ruleDetailPayload, rulesCapabilities, rulesHealthPayload, rulesListPayload } from './rules-routes/list-health.js'
export { applyPayload, planPayload, proposalView, proposePayload, rejectPayload, restoreDefaultPayload, rulesProposalsPayload } from './rules-routes/proposal.js'
export { revertPayload, ruleDiffPayload, ruleVersionsPayload, updatePayload } from './rules-routes/edit-revert.js'
export { createPayload, deletePayload } from './rules-routes/create-delete.js'
export { rebuildMirrorPayload, renderAgentsPayload } from './rules-routes/render-mirror.js'
export { importLegacyPayload } from './rules-routes/import-legacy.js'
export { handleRules } from './rules-routes/router.js'
