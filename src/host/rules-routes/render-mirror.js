// 职责：rules 镜像/渲染组——手动重渲染 AGENTS 摘要、文件→DB 重建镜像及其 2 条路由。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { readJson, sendJson } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { value } from '../../shared/config-values.js'
import { mirrorRules, mirrorStatus } from '../../core/rule-mirror.js'
import { agentsPathOf, renderAgentsDigest } from '../../core/rule-render.js'
import { listRules } from '../../core/rule-store.js'
import { RULES_PREFIX, resolveRulesRoot, sendMethodNotAllowed, statusForError, summaryBudgetOf, textOf, writeGuard } from './shared.js'

/**
 * 手动重渲染 AGENTS 摘要块（幂等；缺标记返回 no_markers，绝不追加）。
 * @param {{root?:string,config?:any,log?:Function}} args
 * @returns {object}
 */
export function renderAgentsPayload({ root = '', config = {}, log = () => {} } = {}) {
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  // 架构书 §4.1：rules.renderAgents=false 时自愈与手动渲染都跳过（手动重渲染不得绕过开关）。
  if (value(config?.rules?.renderAgents, true) === false) return { ok: false, error: 'render_disabled' }
  const dir = root || resolveRulesRoot(config)
  const result = renderAgentsDigest({ rules: dir, agentsPath: agentsPathOf(dir), log, budgetChars: summaryBudgetOf(config) })
  return { ok: Boolean(result.ok), dir, code: textOf(result.code), changed: Boolean(result.changed), count: Number(result.count) || 0 }
}

/**
 * 重建镜像（管理动作）。
 * @param {{root?:string,config?:any,backend?:any,detect?:Function,log?:Function}} args
 * @returns {object}
 */
export function rebuildMirrorPayload({ root = '', config = {}, backend, detect = detectGit, log = () => {} } = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const mirror = mirrorRules({ backend, rules: list.rules, log })
  if (!mirror.ok) return { ok: false, error: mirror.error }
  const status = mirrorStatus({ backend, rules: list.rules })
  return { ok: true, dir, mirror, status }
}

// ---------------------------------------------------------------------------
// 路由：镜像/渲染组（2 条精确路径）。/rules/:key 兜底仍由 router 末位调用。
// ---------------------------------------------------------------------------

/**
 * render-agents / rebuild-mirror 两条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,backend?:any,detect?:Function,
 *   log?:Function,afterWrite?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleRenderMirror({
  req, res, path, config = {}, backend = null, detect = detectGit, log = () => {},
  afterWrite = (payload) => payload,
} = {}) {
  const p = textOf(path)
  const renderPath = `${RULES_PREFIX}/rules/render-agents`
  const rebuildPath = `${RULES_PREFIX}/rules/rebuild-mirror`

  if (p === renderPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req, 64 * 1024, { allowEmpty: true })
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(renderAgentsPayload({ config, log }))
    // no_markers/duplicate_markers 是幂等「没动」，200 带 ok:false；闸门类错误才按 403。
    sendJson(res, payload.error ? statusForError(textOf(payload.error)) : 200, payload)
    return true
  }

  if (p === rebuildPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    // 无载荷动作：空 body 合法（allowEmpty），但 413/坏 JSON 必须当场拒绝，不能静默继续。
    const body = await readJson(req, 64 * 1024, { allowEmpty: true })
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = rebuildMirrorPayload({ config, backend, detect, log })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  return false
}
