// 职责：rules 提案组——候选视图/列表、提案、应用、计划预览、恢复默认、拒绝，及其 6 条路由。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { readJson, sendJson } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { value } from '../../shared/config-values.js'
import { applyProposal, createProposal, listProposals, readProposal, rejectProposal, setSessionPending } from '../../core/rule-proposal.js'
import { isValidRuleKey, listRules } from '../../core/rule-store.js'
import { RULES_PREFIX, loadDefaultRestore, resolveRulesRoot, ruleView, sendMethodNotAllowed, statusForError, statusQuery, textOf, writeGuard } from './shared.js'

/**
 * 候选视图（客户端 R3a 已按这个形状渲染：relation/status/candidate/affected/source/guard）。
 * 服务端只做**归一**：字段缺失给中性值，不把内部结构（draft/relation 对象）直接抛给面板。
 *
 * @param {object} item rule-proposal 的候选 JSON
 * @returns {object}
 */
export function proposalView(item) {
  const draft = item?.draft && typeof item.draft === 'object' ? item.draft : {}
  const relation = textOf(item?.relation?.relation) || 'new'
  const targets = Array.isArray(item?.relation?.targets) ? item.relation.targets : []
  const affected = Array.isArray(item?.affected) ? item.affected : []
  const failures = Array.isArray(item?.needsManual?.failures) ? item.needsManual.failures : []
  return {
    id: textOf(item?.id),
    status: textOf(item?.status) || 'pending',
    relation,
    targets: targets.map((target) => ({ key: textOf(target?.key), number: Number(target?.number) || null, reason: textOf(target?.reason) })),
    cooling: Boolean(item?.cooling),
    needsRewrite: Boolean(item?.needsRewrite),
    createdAt: textOf(item?.created),
    updated: textOf(item?.updated),
    hits: Number(item?.hits) || 1,
    summary: item?.summary && typeof item.summary === 'object'
      ? { label: textOf(item.summary.label), title: textOf(item.summary.title), relation: textOf(item.summary.relation) }
      : null,
    candidate: {
      text: textOf(draft.text),
      key: textOf(draft.key) || null,
      type: textOf(draft.type) || null,
      number: Number.isFinite(Number(draft.number)) ? Number(draft.number) : null,
      priority: textOf(draft.priority) || null,
      scope: textOf(draft.scope) || null,
      role: textOf(draft.role),
      modality: textOf(draft.modality) || null,
      title: textOf(draft.title),
      action: textOf(draft.action),
      object: textOf(draft.object),
      conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
      exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
      chars: Number.isFinite(Number(draft.chars)) ? Number(draft.chars) : Array.from(textOf(draft.text)).length,
    },
    affected: affected.map((row) => ({
      key: textOf(row?.key),
      number: Number.isFinite(Number(row?.number)) ? Number(row.number) : null,
      oldText: textOf(row?.text),
      newText: textOf(row?.text),
      preserved: [],
      dropped: [],
      changed: false,
    })),
    source: {
      text: textOf(item?.text),
      source: textOf(item?.source) || 'owner',
      sessionId: textOf(item?.sessionId),
      traceId: textOf(item?.traceId),
    },
    guard: { ok: failures.length === 0, failures },
    needsManual: item?.needsManual && typeof item.needsManual === 'object'
      ? {
        code: textOf(item.needsManual.code),
        at: textOf(item.needsManual.at),
        failures,
        ...(item.needsManual.detail ? { detail: textOf(item.needsManual.detail) } : {}),
      }
      : null,
    applied: item?.applied && typeof item.applied === 'object' ? item.applied : null,
  }
}

/** 旧 `.md` 候选（`type=rule-candidate`）也归一成同一视图，避免面板两套渲染。 */
function legacyCandidateView(doc) {
  return proposalView({
    id: `md:${textOf(doc.front.key)}`,
    status: 'pending',
    relation: { relation: 'new', targets: [] },
    draft: {
      text: textOf(doc.text),
      key: textOf(doc.front.key),
      type: 'rule',
      number: doc.front.number,
      priority: textOf(doc.front.priority),
      scope: textOf(doc.front.scope),
      role: textOf(doc.front.role),
      modality: textOf(doc.front.modality),
      conditions: doc.front.conditions,
      exceptions: doc.front.exceptions,
      chars: Array.from(textOf(doc.text)).length,
    },
    text: textOf(doc.text),
    source: textOf(doc.front.origin) || 'file',
    updated: textOf(doc.front.updated),
  })
}

/**
 * 提案列表 payload（只读）：JSON 候选 + 旧 `.md` 候选，按 `status` 过滤。
 * @param {{root?:string,config?:any,status?:string}} [args]
 * @returns {object}
 */
export function rulesProposalsPayload({ root = '', config = {}, status = '' } = {}) {
  const dir = root || resolveRulesRoot(config)
  const wanted = textOf(status).split(',').map((s) => s.trim()).filter(Boolean)
  // `status=pending,needs_manual` 必须同时出现在面板：失败候选不是死数据，用户要能改写重试。
  const jsonItems = listProposals({ rulesDir: dir, config, status: wanted.join(',') }).proposals.map(proposalView)
  const mdItems = listRules(dir).rules
    .filter((doc) => doc.front.type === 'rule-candidate' || doc.front.status === 'proposal')
    .map(legacyCandidateView)
  let items = [...jsonItems, ...mdItems]
  if (wanted.length) items = items.filter((item) => wanted.includes(item.status))
  return { ok: true, dir, proposals: items, items }
}

/**
 * 面板手动提案。
 * @param {{root?:string,config?:any,body?:object,detect?:Function,log?:Function,now?:number}} args
 * @returns {object}
 */
export function proposePayload({ root = '', config = {}, body = {}, log = () => {}, now = Date.now() } = {}) {
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  const text = textOf(body?.text).trim()
  if (!text) return { ok: false, error: 'empty_text' }
  if (Array.from(text).length > 2000) return { ok: false, error: 'text_too_long' }
  const dir = root || resolveRulesRoot(config)
  // 面板没有会话 header/hint：身份取调用方显式给的 identity，否则按 Config 推导（空 workspace 即 global）。
  const identity = body?.identity && typeof body.identity === 'object'
    ? {
      userId: textOf(body.identity.userId).slice(0, 128),
      roleId: textOf(body.identity.roleId).slice(0, 64),
      workspace: textOf(body.identity.workspace).slice(0, 64),
    }
    : {
      userId: textOf(body?.userId).slice(0, 128),
      roleId: textOf(body?.roleId).slice(0, 64),
      workspace: textOf(body?.workspace).slice(0, 64),
    }
  const created = createProposal({
    text,
    source: textOf(body?.source) || 'owner',
    identity,
    traceId: textOf(body?.traceId),
    sessionId: textOf(body?.sessionId),
    rulesDir: dir,
    config,
    log,
    now,
  })
  if (!created.ok) return { ok: false, error: created.code, detail: created.detail }
  if (created.proposal?.sessionId && !created.cooling && !created.existing) {
    setSessionPending(created.proposal.sessionId, created.proposal.id, now)
  }
  return {
    ok: true,
    dir,
    cooling: Boolean(created.cooling),
    existing: Boolean(created.existing),
    proposal: proposalView(created.proposal),
  }
}

/**
 * 应用候选（唯一事务入口；面板 decisions 与聊天确认共用）。
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   getLlm?:Function,getSelection?:Function,mirror?:Function,renderAgents?:Function,
 *   git?:boolean,exec?:Function,log?:Function,now?:number}} args
 * @returns {Promise<object>}
 */
export async function applyPayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  getLlm = () => null, getSelection = () => null, mirror = null, renderAgents = null,
  git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const id = textOf(body?.id).trim()
  if (!id) return { ok: false, error: 'proposal_not_found' }
  const decisions = body?.decisions && typeof body.decisions === 'object' ? body.decisions : {}
  const result = await applyProposal({
    id,
    decisions,
    // 面板先调 /rules/plan 拿 planHash，apply 只认指纹：不一致由 core 返回 plan_hash_mismatch（409）。
    planHash: textOf(body?.planHash),
    identity: body?.identity && typeof body.identity === 'object' ? body.identity : {},
    traceId: textOf(body?.traceId),
    rulesDir: dir,
    config,
    getLlm,
    getSelection,
    backend,
    mirror,
    renderAgents,
    git,
    exec,
    log,
    now,
    // requireGit 闸门下沉（R9-05）：路由快速失败之外，store 拿到显式布尔再复核一次。
    gitRequired: guard.required,
  })
  if (result.ok) {
    return {
      ok: true,
      dir,
      applied: result.applied,
      proposal: proposalView(result.proposal),
      ...(result.commitState ? { commitState: result.commitState } : {}),
    }
  }
  return {
    ok: false,
    error: textOf(result.code || result.error) || 'apply_failed',
    failures: result.failures,
    status: result.status,
    detail: result.detail,
    rolledBack: result.rolledBack,
    ...(result.commitState ? { commitState: result.commitState } : {}),
    proposal: result.proposal ? proposalView(result.proposal) : undefined,
  }
}

/** 规则 plan 模块（task-2 新增 `src/core/rule-plan.js`）；未上线返回 null，不抛。 */
async function loadRulePlan() {
  try {
    const mod = await import('../../core/rule-plan.js')
    return mod && typeof mod.buildApplyPlan === 'function' ? mod : null
  } catch {
    return null
  }
}

/**
 * 应用计划预览：调 task-2 的纯函数 buildApplyPlan，不写盘。
 * core 未导出时返回 `plan_unavailable`（路由 501），接口契约保持不变。
 *
 * @param {{root?:string,config?:any,body?:object,detect?:Function,log?:Function,now?:number}} args
 * @returns {Promise<object>}
 */
export async function planPayload({
  root = '', config = {}, body = {}, detect = detectGit, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const id = textOf(body?.id).trim()
  if (!id) return { ok: false, error: 'proposal_not_found' }
  const got = readProposal({ rulesDir: dir, config, id })
  if (!got.ok) return { ok: false, error: 'proposal_not_found' }
  const planMod = await loadRulePlan()
  if (!planMod) return { ok: false, error: 'plan_unavailable', degraded: true }
  const decisions = body?.decisions && typeof body.decisions === 'object' ? body.decisions : {}
  try {
    const out = planMod.buildApplyPlan({
      proposal: got.proposal, rulesDir: dir, config, decisions, now, log,
    })
    if (out && out.ok) return { ok: true, dir, id, plan: out.plan }
    return {
      ok: false,
      error: textOf(out?.error) || 'rule_guard_failed',
      failures: Array.isArray(out?.failures) ? out.failures : undefined,
      needsManual: out?.needsManual,
    }
  } catch (err) {
    log(`[whale-memory] rules plan failed: ${err?.message || err}`)
    return { ok: false, error: 'plan_failed', detail: String(err?.message || err) }
  }
}

/**
 * 单条规则从包内默认恢复（task-1 的 default 播种能力）；未提供时 501 降级。
 * @param {{root?:string,config?:any,body?:object,detect?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {Promise<object>}
 */
export async function restoreDefaultPayload({
  root = '', config = {}, body = {}, detect = detectGit, git = true, exec = null,
  log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const restore = await loadDefaultRestore()
  if (!restore) return { ok: false, error: 'restore_unavailable', degraded: true }
  const dir = root || resolveRulesRoot(config)
  try {
    const out = await restore({ root: dir, key, git, exec, now, log, config })
    if (out && out.ok === false) return { ok: false, error: textOf(out.error) || 'restore_failed', detail: out.detail }
    return { ok: true, dir, key, restored: out?.rule ? ruleView(out.rule) : undefined, ...(out || {}) }
  } catch (err) {
    log(`[whale-memory] rules restore-default failed: ${err?.message || err}`)
    return { ok: false, error: 'restore_failed', detail: String(err?.message || err) }
  }
}

/**
 * 拒绝候选（写冷却 + status=rejected）。
 * @param {{root?:string,config?:any,body?:object,log?:Function,now?:number}} args
 * @returns {object}
 */
export function rejectPayload({ root = '', config = {}, body = {}, now = Date.now() } = {}) {
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  const dir = root || resolveRulesRoot(config)
  const id = textOf(body?.id).trim()
  const rejected = rejectProposal({
    id,
    reason: textOf(body?.reason),
    identity: body?.identity && typeof body.identity === 'object' ? body.identity : {},
    rulesDir: dir,
    config,
    now,
  })
  if (!rejected.ok) return { ok: false, error: rejected.error }
  return { ok: true, dir, proposal: proposalView(rejected.proposal) }
}

// ---------------------------------------------------------------------------
// 路由：提议组（6 条精确路径）。与具体端点/兜底无路径交叉；/rules/:key 兜底仍由 router 末位调用。
// ---------------------------------------------------------------------------

/**
 * 提案列表 / 计划预览 / 恢复默认 / 提案 / 应用 / 拒绝六条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,backend?:any,detect?:Function,
 *   log?:Function,getLlm?:Function,getSelection?:Function,git?:boolean,
 *   afterWrite?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleProposal({
  req, res, path, config = {}, backend = null, detect = detectGit, log = () => {},
  getLlm = () => null, getSelection = () => null, git = true, afterWrite = (payload) => payload,
} = {}) {
  const p = textOf(path)
  const proposalsPath = `${RULES_PREFIX}/rules/proposals`
  const planPath = `${RULES_PREFIX}/rules/plan`
  const restorePath = `${RULES_PREFIX}/rules/restore-default`
  const proposePath = `${RULES_PREFIX}/rules/propose`
  const applyPath = `${RULES_PREFIX}/rules/apply`
  const rejectPath = `${RULES_PREFIX}/rules/reject`

  if (p === proposalsPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    sendJson(res, 200, rulesProposalsPayload({ config, status: statusQuery(req) }))
    return true
  }

  if (p === planPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = await planPayload({ config, body: body.value, detect, log })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === restorePath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(await restoreDefaultPayload({ config, backend, body: body.value, detect, git, log }))
    // 恢复默认的 key 是入参：非法 key 属于参数问题（422），不是「未知错误」的 400。
    const status = payload.ok ? 200 : (payload.error === 'invalid_key' ? 422 : statusForError(textOf(payload.error)))
    sendJson(res, status, payload)
    return true
  }

  if (p === proposePath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = proposePayload({ config, body: body.value, log })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === applyPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(await applyPayload({
      config,
      backend,
      body: body.value,
      detect,
      getLlm,
      // R9-10：面板 apply 的模型改写必须拿到 provider/model，缺选择由 core 转 needs_manual。
      getSelection,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === rejectPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = rejectPayload({ config, body: body.value })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  return false
}
