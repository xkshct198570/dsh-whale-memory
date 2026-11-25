// 职责：rules 路由唯一入口 handleRules——写闸、写后缓存失效、按组 dispatch、详情兜底与未命中返回。
// 依赖方向：各业务组 handler + shared/http-kit/git-detector ← 本文件；不承载任何业务分支或路径常量。

import { sendJson, isWriteMethod, writeRequestProblem } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { textOf } from './shared.js'
import { handleListHealth, handleRuleDetail } from './list-health.js'
import { handleProposal } from './proposal.js'
import { handleEditRevert } from './edit-revert.js'
import { handleCreateDelete } from './create-delete.js'
import { handleRenderMirror } from './render-mirror.js'
import { handleImportLegacy } from './import-legacy.js'

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
