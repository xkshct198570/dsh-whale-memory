/**
 * 规则 HTTP 路由（R3a 只读/管理 + R3b 提案制写入口）。
 *
 * 职责：
 * - `GET  /whale-memory/api/rules`                 列表 + manifest + git 状态
 * - `GET  /whale-memory/api/rules/git-status`      强制刷新 git 探测
 * - `GET  /whale-memory/api/rules/proposals?status=` 待确认候选（JSON 提案 + 旧 .md 候选）
 * - `GET  /whale-memory/api/rules/:key`            单条详情 + 历史
 * - `POST /whale-memory/api/rules/propose`         面板手动提案（owner 起草）
 * - `POST /whale-memory/api/rules/apply`           应用候选（唯一事务入口）
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
 * - 任何失败都返回 `{ok:false,error,detail?}`，不抛；git 缺失时读接口照常可用。
 *
 * Why 单独成文件：路由文件已 35K，再塞规则读写会继续膨胀；把 payload 纯函数独立出来
 * 还能脱 HTTP 做契约测试（不起真服务器）。
 */
import { readJson, sendJson } from './http-kit.js'
import { value } from './config-values.js'
import { detectGit, gitRequired, refreshGit } from './git-detector.js'
import {
  computeManifest, defaultRuleRoot, listRules, readHistory, readRule,
} from '../core/rule-store.js'
import { importLegacyRule, mirrorRules, mirrorStatus } from '../core/rule-mirror.js'
import {
  applyProposal, createProposal, listProposals, rejectProposal, setSessionPending,
} from '../core/rule-proposal.js'
import { agentsPathOf, renderAgentsDigest, titleOfRule } from '../core/rule-render.js'

/** 与 routes.js 同一个前缀；写死字面量避免 routes ↔ rules-routes 循环 import。 */
export const RULES_PREFIX = '/whale-memory/api'

function textOf(value) {
  return String(value ?? '')
}

/** 配置 `rules.dir` 优先，空则 `$DSH_HOME/rules`。 */
export function resolveRulesRoot(config) {
  const raw = textOf(config?.rules?.dir).trim()
  return raw || defaultRuleRoot()
}

function gitView({ config, detect = detectGit, force = false } = {}) {
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
function titleOf(front, body) {
  return titleOfRule(front, body)
}

/**
 * 列表 payload（纯函数）。
 * @param {{root?:string,config?:any,detect?:Function,forceGit?:boolean}} [args]
 * @returns {object}
 */
export function rulesListPayload({ root = '', config = {}, detect = detectGit, forceGit = false } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const manifest = computeManifest(list.rules)
  const rules = list.rules.map((doc) => ({
    key: textOf(doc.front.key),
    type: textOf(doc.front.type),
    number: Number(doc.front.number),
    priority: textOf(doc.front.priority),
    scope: textOf(doc.front.scope),
    role: textOf(doc.front.role),
    status: textOf(doc.front.status),
    updated: textOf(doc.front.updated),
    title: titleOf(doc.front, doc.text),
    excerpt: textOf(doc.text).slice(0, 80),
    chars: Array.from(textOf(doc.text)).length,
  }))
  const payload = {
    ok: true,
    dir,
    git: gitView({ config, detect, force: forceGit }),
    rules,
    manifest,
  }
  if (list.errors.length) {
    payload.errors = list.errors.map((item) => ({ file: item.file, error: item.error, detail: item.detail }))
  }
  return payload
}

/**
 * 详情 payload（纯函数）。
 * @param {{root?:string,config?:any,key:string,detect?:Function}} args
 * @returns {object}
 */
export function ruleDetailPayload({ root = '', config = {}, key, detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const history = readHistory(dir, key)
  // `front` 保留规范嵌套；同一层再铺开 front 字段，供面板直接读 rule.number/rule.origin
  // （客户端已按扁平结构渲染；两套并存不冲突，避免为一个展示层改动破坏契约）。
  const rule = {
    ...got.rule.front,
    front: got.rule.front,
    text: got.rule.text,
    bodyStart: got.rule.bodyStart,
    path: got.rule.file,
    title: titleOf(got.rule.front, got.rule.text),
  }
  return {
    ok: true,
    rule,
    history: history.ok ? history.entries : [],
    git: gitView({ config, detect }),
    ...(history.ok ? {} : { historyError: history.error }),
  }
}

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
      ? { code: textOf(item.needsManual.code), at: textOf(item.needsManual.at) }
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
  const jsonItems = listProposals({ rulesDir: dir, config }).proposals.map(proposalView)
  const mdItems = listRules(dir).rules
    .filter((doc) => doc.front.type === 'rule-candidate' || doc.front.status === 'proposal')
    .map(legacyCandidateView)
  let items = [...jsonItems, ...mdItems]
  if (wanted.length) items = items.filter((item) => wanted.includes(item.status))
  return { ok: true, dir, proposals: items, items }
}

/**
 * git-status payload：**强制刷新**（不吃 60s 缓存）。
 * @param {{config?:any,detect?:Function}} [args]
 * @returns {object}
 */
export function gitStatusPayload({ config = {}, detect = detectGit } = {}) {
  const view = typeof detect === 'function' ? detect({ force: true }) : detect
  return {
    ok: true,
    git: {
      available: Boolean(view?.available),
      version: textOf(view?.version),
      required: Boolean(config?.rules?.requireGit),
      checkedAt: Number(view?.checkedAt) || Date.now(),
      ...(view?.error ? { error: String(view.error) } : {}),
    },
  }
}

function writeGuard(config, detect) {
  // enabled 是 volatile（Ref）；不能拿 Ref 对象直接和 false 比。
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  return gitRequired(config, detect)
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
  })
  if (result.ok) return { ok: true, dir, applied: result.applied, proposal: proposalView(result.proposal) }
  return {
    ok: false,
    error: textOf(result.code || result.error) || 'apply_failed',
    failures: result.failures,
    status: result.status,
    detail: result.detail,
    rolledBack: result.rolledBack,
    proposal: result.proposal ? proposalView(result.proposal) : undefined,
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

/**
 * 手动重渲染 AGENTS 摘要块（幂等；缺标记返回 no_markers，绝不追加）。
 * @param {{root?:string,config?:any,log?:Function}} args
 * @returns {object}
 */
export function renderAgentsPayload({ root = '', config = {}, log = () => {} } = {}) {
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  const dir = root || resolveRulesRoot(config)
  const result = renderAgentsDigest({ rules: dir, agentsPath: agentsPathOf(dir), log })
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

/**
 * 迁移旧铁律（管理动作，幂等）。
 * @param {{root?:string,config?:any,backend?:any,key?:string,number?:number,
 *   detect?:Function,log?:Function}} args
 * @returns {object}
 */
export function importLegacyPayload({
  root = '', config = {}, backend, key = '', number = null, detect = detectGit, log = () => {},
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const imported = importLegacyRule({ backend, key, number, root: dir })
  if (!imported.ok) return imported
  let mirror = null
  if (config?.rules?.mirrorAuto !== false && imported.skipped === false) {
    const list = listRules(dir)
    mirror = mirrorRules({ backend, rules: list.rules, log })
  }
  // count/imported 供面板显示「导入 N 条 / 已存在跳过」；0/1 是本次动作的真实增量。
  return {
    ...imported,
    count: imported.skipped ? 0 : 1,
    imported: imported.skipped ? 0 : 1,
    ...(mirror ? { mirror } : {}),
  }
}

function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}

function decodeKey(rest) {
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

/** `?status=` 读取（handleRules 只拿 pathname，query 必须自己从 req.url 取）。 */
function statusQuery(req) {
  try {
    return new URL(textOf(req?.url || '/'), 'http://127.0.0.1').searchParams.get('status') || ''
  } catch {
    return ''
  }
}

/**
 * 错误码 → HTTP 状态（面板按 status/error 决定文案；语义化而不是一律 500）。
 * @param {string} code
 * @returns {number}
 */
function statusForError(code) {
  if (code === 'proposal_not_found' || code === 'rule_not_found') return 404
  if (code === 'rules_disabled' || code === 'git_required') return 403
  if (code === 'proposal_not_pending') return 409
  if (code === 'rule_guard_failed' || code === 'needs_manual' || code === 'llm_unavailable'
    || code === 'llm_unparseable' || code === 'llm_error' || code === 'commit_failed'
    || code === 'write_failed' || code === 'affected_write_failed') return 422
  if (code === 'invalid_json' || code === 'payload_too_large') return 400
  return 400
}

/**
 * 规则路由入口：命中返回 true，未命中返回 false（交给 routes.js 继续/404）。
 *
 * @param {{req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse,
 *   path:string,config?:any,backend?:any,detect?:Function,log?:Function,
 *   getLlm?:Function,navigate?:Function}} args
 *   getLlm/navigate 可选：路由默认拿不到宿主 ctx，传了就用（聊天/测试可注入）。
 * @returns {Promise<boolean>}
 */
export async function handleRules({
  req, res, path, config, backend, detect = detectGit, log = () => {}, getLlm = () => null, git = true,
}) {
  const p = textOf(path)
  const listPath = `${RULES_PREFIX}/rules`
  const gitPath = `${RULES_PREFIX}/rules/git-status`
  const rebuildPath = `${RULES_PREFIX}/rules/rebuild-mirror`
  const importPath = `${RULES_PREFIX}/rules/import-legacy`
  const proposePath = `${RULES_PREFIX}/rules/propose`
  const applyPath = `${RULES_PREFIX}/rules/apply`
  const rejectPath = `${RULES_PREFIX}/rules/reject`
  const renderPath = `${RULES_PREFIX}/rules/render-agents`
  const proposalsPath = `${RULES_PREFIX}/rules/proposals`

  if (p === listPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    sendJson(res, 200, rulesListPayload({ config, detect }))
    return true
  }

  if (p === gitPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 路由层强制刷新：面板点「重新检测」必须绕过 60s 缓存。
    const fresh = detect === detectGit ? refreshGit() : detect({ force: true })
    sendJson(res, 200, gitStatusPayload({ config, detect: () => fresh }))
    return true
  }

  if (p === proposalsPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    sendJson(res, 200, rulesProposalsPayload({ config, status: statusQuery(req) }))
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
    const payload = await applyPayload({
      config,
      backend,
      body: body.value,
      detect,
      getLlm,
      git,
      log,
    })
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

  if (p === renderPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    await readJson(req)
    sendJson(res, 200, renderAgentsPayload({ config, log }))
    return true
  }

  if (p === rebuildPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    // 无载荷动作：仍要排空 body，避免 keep-alive 连接残留请求体；空 body 不算错误。
    await readJson(req)
    const payload = rebuildMirrorPayload({ config, backend, detect, log })
    sendJson(res, payload.ok ? 200 : 403, payload)
    return true
  }

  if (p === importPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) {
      sendJson(res, body.status, { ok: false, error: body.error })
      return true
    }
    const key = textOf(body.value?.key).trim().slice(0, 64)
    const rawNumber = Number(body.value?.number)
    const payload = importLegacyPayload({
      config,
      backend,
      key,
      number: Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : null,
      detect,
      log,
    })
    sendJson(res, payload.ok ? 200 : 403, payload)
    return true
  }

  if (p.startsWith(`${listPath}/`)) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    const rest = p.slice(listPath.length + 1)
    if (!rest || rest.includes('/')) return false
    const key = decodeKey(rest)
    if (key === null) {
      sendJson(res, 400, { ok: false, error: 'invalid_key' })
      return true
    }
    const payload = ruleDetailPayload({ config, key, detect })
    sendJson(res, payload.ok ? 200 : 404, payload)
    return true
  }

  return false
}
