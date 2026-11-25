// 职责：rules-routes 共同底座——前缀常量、错误→状态码、query/key 解码、写闸、payload 共用 view/审计工具。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；被各组与 router 引用，不反向 import 组或门面。

import { sendJson } from '../http-kit.js'
import { statusOf } from '../../shared/error-table.mjs'
import { value } from '../../shared/config-values.js'
import { detectGit, gitRequired } from '../git-detector.js'
import { defaultRuleRoot, listRules } from '../../core/rule-store.js'
import { mirrorRules } from '../../core/rule-mirror.js'
import { agentsPathOf, renderAgentsDigest, titleOfRule } from '../../core/rule-render.js'


/** 与 routes.js 同一个前缀；写死字面量避免 routes ↔ rules-routes 循环 import。 */
export const RULES_PREFIX = '/whale-memory/api'


export function textOf(value) {
  return String(value ?? '')
}


/**
 * 摘要总预算（码点）：`rules.summaryBudgetChars` 默认 6000；0/非法回落默认值（0 不是「无限」）。
 * @param {any} config @returns {number}
 */
export function summaryBudgetOf(config) {
  const n = Number(value(config?.rules?.summaryBudgetChars, 6000))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6000
}


/** 配置 `rules.dir` 优先，空则 `$DSH_HOME/rules`。 */
export function resolveRulesRoot(config) {
  const raw = textOf(config?.rules?.dir).trim()
  return raw || defaultRuleRoot()
}


export function gitView({ config, detect = detectGit, force = false } = {}) {
  const info = typeof detect === 'function' ? detect({ force }) : detect
  const view = {
    available: Boolean(info?.available),
    version: textOf(info?.version),
    required: Boolean(config?.rules?.requireGit),
    checkedAt: Number(info?.checkedAt) || Date.now(),
  }
  if (info?.error) view.error = String(info.error)
  return view
}


/** 规则标题：结构化 action 优先，否则正文首句（只展示，不改正文）。 */
export function titleOf(front, body) {
  return titleOfRule(front, body)
}


// ---------------------------------------------------------------------------
// R5：编辑 / 版本 diff / 回滚（文件+git 在 rule-store，镜像/渲染/审计在本层编排）
// ---------------------------------------------------------------------------

/** 规则视图：规范嵌套 front + 扁平字段（与详情接口同形状，面板只写一套渲染）。 */
export function ruleView(doc) {
  return {
    ...doc.front,
    front: doc.front,
    text: textOf(doc.text),
    bodyStart: doc.bodyStart,
    path: doc.file,
    title: titleOf(doc.front, doc.text),
  }
}


/** 写后处理视图（与 update/revert 同形状：面板只写一套渲染）。 */
export function postView(post) {
  return {
    mirror: post.mirror ? { ok: Boolean(post.mirror.ok), mirrored: post.mirror.mirrored ?? null } : null,
    agents: post.agents
      ? {
        ok: Boolean(post.agents.ok),
        code: textOf(post.agents.code),
        changed: post.agents.changed ?? null,
        count: Number(post.agents.count) || 0,
      }
      : null,
  }
}


/**
 * 请求体身份归一（面板显式给了 identity 就用它，否则读扁平 userId/roleId/workspace）。
 * 只做截断，不做身份推导：面板没有会话 header，推导在 identity-source。
 * @param {object} body
 * @returns {{userId:string,roleId:string,workspace:string}}
 */
export function identityOf(body) {
  const src = body?.identity && typeof body.identity === 'object' ? body.identity : body
  return {
    userId: textOf(src?.userId).slice(0, 128),
    roleId: textOf(src?.roleId).slice(0, 64),
    workspace: textOf(src?.workspace).slice(0, 64),
  }
}


export function writeGuard(config, detect) {
  // enabled 是 volatile（Ref）；不能拿 Ref 对象直接和 false 比。
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  return gitRequired(config, detect)
}


/**
 * 后处理：镜像（rules.mirrorAuto）→ AGENTS 摘要（rules.renderAgents）。
 * 失败只记录并回给面板，不回滚规则文件：它们可重试，回滚反而丢掉已经写好的真源。
 * @returns {{mirror:object|null,agents:object|null}}
 */
export function applyPostSteps({ dir, config, backend, mirror, renderAgents, log }) {
  const postRules = listRules(dir).rules
  let mirrorResult = null
  if (value(config?.rules?.mirrorAuto, true) !== false && backend) {
    try {
      const mirrorFn = typeof mirror === 'function' ? mirror : mirrorRules
      mirrorResult = mirrorFn({ backend, rules: postRules, log })
    } catch (err) {
      mirrorResult = { ok: false, error: String(err?.message || err) }
    }
  }
  let agentsResult = null
  if (value(config?.rules?.renderAgents, true) !== false) {
    try {
      const agentsFn = typeof renderAgents === 'function' ? renderAgents : renderAgentsDigest
      agentsResult = agentsFn({
        rules: postRules, agentsPath: agentsPathOf(dir), rulesDir: dir, log,
        budgetChars: summaryBudgetOf(config),
      })
    } catch (err) {
      agentsResult = { ok: false, code: 'render_failed', error: String(err?.message || err) }
    }
  }
  return { mirror: mirrorResult, agents: agentsResult }
}


/**
 * 审计一次规则编辑/回滚/删除：writes(reason=rule_edit|rule_revert|rule_purge) + evolution 变更。
 *
 * before/after 在 writes 里是**摘要**（截 200 字，面板列表够用），全文进 evolution——
 * 两个表各有用途，别把 500 字正文塞两遍。
 *
 * purge 例外：`afterText === null` 表示规则已被物理删除——writes.after_text 就存 null
 * （不是空串，空串会与"删空正文"混淆）；evolution 记 `status: <旧状态> → deleted`，
 * 让审计可答"这条规则什么时候消失、编号作废"。
 *
 * @returns {{ok:boolean,error?:string}}
 */
export function auditRuleChange({
  backend, reason, key, beforeText, afterText, commit, mirrorResult, agentsResult,
  traceId, identity, log, extra = {}, evolutionField = 'text', evolutionOld = '', evolutionNew = '',
}) {
  if (!backend || typeof backend.withDb !== 'function') return { ok: false, error: 'backend_unavailable' }
  const ident = identity && typeof identity === 'object' ? identity : {}
  try {
    backend.withDb((db) => {
      const nodeRow = db.prepare('SELECT id FROM nodes WHERE origin = ? LIMIT 1').get(`rule:${key}`)
      const nodeId = nodeRow?.id || `rule:${key}`
      const at = Date.now() / 1000
      db.prepare(`INSERT INTO writes (ts, trace_id, action, node_id, reason, before_text, after_text,
        mode, payload, user_id, role_id, workspace) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        at, textOf(traceId), 'MERGE', nodeId, reason,
        beforeText ? textOf(beforeText).slice(0, 200) : null,
        afterText === null ? null : textOf(afterText).slice(0, 200), 'auto',
        JSON.stringify({
          key,
          commit: textOf(commit?.message || ''),
          mirror: Boolean(mirrorResult?.ok),
          agents: Boolean(agentsResult?.ok),
          ...extra,
        }),
        textOf(ident.userId), textOf(ident.roleId), textOf(ident.workspace),
      )
      const oldValue = evolutionField === 'text' ? textOf(beforeText) : textOf(evolutionOld)
      const newValue = evolutionField === 'text' ? textOf(afterText) : textOf(evolutionNew)
      if (oldValue !== newValue) {
        db.prepare(`INSERT INTO evolution (ts, from_id, to_id, field, old_value, new_value, trace_id)
          VALUES (?,?,?,?,?,?,?)`).run(at, nodeId, nodeId, evolutionField, oldValue, newValue, textOf(traceId))
      }
      return true
    })
    return { ok: true }
  } catch (err) {
    log(`[whale-memory] rules audit failed: ${err?.message || err}`)
    return { ok: false, error: String(err?.message || err) }
  }
}


/** 默认规则恢复函数（task-1 可能提供）；按常见命名探测，未提供返回 null。 */
export async function loadDefaultRestore() {
  try {
    const mod = await import('../../core/rule-defaults.js')
    for (const name of ['restoreDefaultRule', 'restoreRuleDefault', 'restoreDefault']) {
      if (typeof mod?.[name] === 'function') return mod[name]
    }
  } catch { /* 模块不可用按「未提供」处理 */ }
  return null
}


export function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}


/**
 * 错误码 → HTTP 状态：单一真源在 `src/shared/error-table.mjs`。
 *
 * 为什么去掉本地 if 链：状态码曾在路由与 client 各存一份，422/500 被折叠成
 * unknown_error、payload_too_large 落 400。查表 + 未登记码回退 400（原码仍透出）。
 *
 * @param {string} code
 * @returns {number}
 */
export function statusForError(code) {
  return statusOf(code)
}


/** query 读取（handleRules 只拿 pathname，query 必须自己从 req.url 取）。 */
export function queryOf(req) {
  try {
    return new URL(textOf(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}


/** `?status=` 读取。 */
export function statusQuery(req) {
  return textOf(queryOf(req).get('status'))
}


export function decodeKey(rest) {
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}
