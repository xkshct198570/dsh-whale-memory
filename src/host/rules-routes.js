/**
 * 规则 HTTP 路由（R3a 只读/管理 + R3b 提案制写入口 + R5 编辑/版本/回滚）。
 *
 * 职责：
 * - `GET  /whale-memory/api/rules`                 列表 + manifest + git 状态
 * - `GET  /whale-memory/api/rules/git-status`      强制刷新 git 探测
 * - `GET  /whale-memory/api/rules/proposals?status=` 待确认候选（JSON 提案 + 旧 .md 候选）
 * - `GET  /whale-memory/api/rules/diff?key=&rev=`  版本正文行 diff（rev=快照戳/ISO/git sha）
 * - `GET  /whale-memory/api/rules/versions?key=`   版本/提交列表（供面板选 diff/revert）
 * - `GET  /whale-memory/api/rules/:key`            单条详情 + 历史
 * - `POST /whale-memory/api/rules/propose`         面板手动提案（owner 起草）
 * - `POST /whale-memory/api/rules/apply`           应用候选（唯一事务入口）
 * - `POST /whale-memory/api/rules/update`          直接编辑规则（白名单字段）
 * - `POST /whale-memory/api/rules/revert`          把指定版本写回成新版本
 * - `POST /whale-memory/api/rules/reject`          拒绝候选（写冷却）
 * - `POST /whale-memory/api/rules/render-agents`   手动重渲染 AGENTS 摘要块
 * - `POST /whale-memory/api/rules/rebuild-mirror`  文件→DB 镜像
 * - `POST /whale-memory/api/rules/import-legacy`   旧铁律节点→文件
 *
 * 边界：
 * - 规则默认共享，不按 user 过滤；本层不做授权（回环闸门由 routes.js 统一处理）。
 * - 服务端不弹二次确认；`guardStrict`/确认交互由 client 面板负责（这里只执行守卫）。
 * - 本层拿不到宿主 `ctx`（routes.js 只传 config/backend），因此**面板 apply 不带 LLM**：
 *   需要措辞改写且未提供 `decisions.text` 时返回 `llm_unavailable` + needs_manual；
 *   聊天路径（hook）有 ctx，可走模型。这是刻意的边界，不是漏接。
 * - edit/revert 的**后处理**（镜像/AGENTS/审计）在本层编排而不是 rule-store：
 *   仓储只管文件+git，依赖 backend/config 的副作用留在路由层，避免 core 反向依赖 host。
 * - 任何失败都返回 `{ok:false,error,detail?}`，不抛；git 缺失时读接口照常可用。
 *
 * Why 单独成文件：路由文件已 35K，再塞规则读写会继续膨胀；把 payload 纯函数独立出来
 * 还能脱 HTTP 做契约测试（不起真服务器）。
 */
import { textOf } from './rules-routes/shared.js'
import { sendJson, isWriteMethod, writeRequestProblem } from './http-kit.js'
import { detectGit } from './git-detector.js'
export { RULES_PREFIX, resolveRulesRoot } from './rules-routes/shared.js'
import { handleListHealth, handleRuleDetail } from './rules-routes/list-health.js'
export { gitStatusPayload, ruleDetailPayload, rulesCapabilities, rulesHealthPayload, rulesListPayload } from './rules-routes/list-health.js'
import { handleProposal } from './rules-routes/proposal.js'
export { applyPayload, planPayload, proposalView, proposePayload, rejectPayload, restoreDefaultPayload, rulesProposalsPayload } from './rules-routes/proposal.js'
import { handleEditRevert } from './rules-routes/edit-revert.js'
export { revertPayload, ruleDiffPayload, ruleVersionsPayload, updatePayload } from './rules-routes/edit-revert.js'
import { handleCreateDelete } from './rules-routes/create-delete.js'
export { createPayload, deletePayload } from './rules-routes/create-delete.js'
import { handleImportLegacy } from './rules-routes/import-legacy.js'
export { importLegacyPayload } from './rules-routes/import-legacy.js'
import { handleRenderMirror } from './rules-routes/render-mirror.js'
export { rebuildMirrorPayload, renderAgentsPayload } from './rules-routes/render-mirror.js'

/**
 * 规则路由入口：命中返回 true，未命中返回 false（交给 routes.js 继续/404）。
 *
 * @param {{req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse,
 *   path:string,config?:any,backend?:any,detect?:Function,log?:Function,
 *   getLlm?:Function,getSelection?:Function,navigate?:Function}} args
 *   getLlm/getSelection/navigate 可选：路由默认拿不到宿主 ctx，传了就用（聊天/测试可注入）。
 * @returns {Promise<boolean>}
 */
export async function handleRules({
  req, res, path, config, backend, detect = detectGit, log = () => {}, getLlm = () => null, git = true,
  getSelection = () => null,
  invalidateCache = () => {},
}) {
  const p = textOf(path)
  // 规则端点自带一次写闸：即使被独立挂载（不经 routes.js dispatch），跨源 text/plain 也进不来。
  if (isWriteMethod(req.method)) {
    const problem = writeRequestProblem(req)
    if (problem) { sendJson(res, problem.status, { ok: false, error: problem.error }); return true }
  }
  /** 写成功后清召回缓存：面板写完，下一步注入必须看到新规则（不新鲜 30s 缓存）。 */
  const afterWrite = (payload) => {
    if (payload && payload.ok) {
      try { invalidateCache() } catch { /* 缓存清理失败不回滚已落盘的规则 */ }
    }
    return payload
  }

  if (await handleListHealth({ req, res, path: p, config, detect })) return true

  if (await handleProposal({
    req, res, path: p, config, backend, detect, log, getLlm, getSelection, git, afterWrite,
  })) return true

  if (await handleEditRevert({
    req, res, path: p, config, backend, detect, log, git, afterWrite,
  })) return true

  if (await handleCreateDelete({ req, res, path: p, config, backend, detect, log, git, afterWrite })) return true

  if (await handleRenderMirror({ req, res, path: p, config, backend, detect, log, afterWrite })) return true

  if (await handleImportLegacy({ req, res, path: p, config, backend, detect, log, afterWrite })) return true

  if (handleRuleDetail({ req, res, path: p, config, detect })) return true
  return false
}
