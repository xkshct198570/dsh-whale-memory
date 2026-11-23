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
import { existsSync } from 'node:fs'
import { readJson, sendJson, isWriteMethod, writeRequestProblem } from './http-kit.js'
import { value } from './config-values.js'
import { detectGit, gitRequired, refreshGit } from './git-detector.js'
import {
  DIFF_LINE_LIMIT, computeManifest, createRule, defaultRuleRoot, diffLines, ensureRuleRepo, fileRuleNumbers, gitLog,
  isValidRuleKey, listRules, purgeRule, reactivateRule, readHistory, readManifest, readRule,
  readTombstones, resolveRevision, retireRule, revertRule, updateRule,
} from '../core/rule-store.js'
import { importLegacyRule, mirrorRules, mirrorStatus } from '../core/rule-mirror.js'
import { chainIssues, resolveChain } from '../core/rule-reconcile.js'
import {
  applyProposal, createProposal, listProposals, readProposal, rejectProposal, setSessionPending,
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
  // 墓碑必须参与列表的 nextNumber：purge 过的编号不复用，列表页的"下一个编号"不能回落。
  const manifest = computeManifest(list.rules, readManifest(dir)?.retired, fileRuleNumbers(dir))
  const rules = list.rules.map((doc) => ({
    key: textOf(doc.front.key),
    type: textOf(doc.front.type),
    number: Number(doc.front.number),
    priority: textOf(doc.front.priority),
    scope: textOf(doc.front.scope),
    role: textOf(doc.front.role),
    status: textOf(doc.front.status),
    // `origin` 是「默认铁律」徽标的唯一判据（default:<key>）；列表不带它，面板只能瞎猜。
    origin: textOf(doc.front.origin),
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
  const rule = ruleView(got.rule)
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

/**
 * 规则库健康检查（只读，不写盘、不修自愈）：文件 ↔ manifest ↔ retired 墓碑 ↔ 编号/key 一致性。
 *
 * Why 200+ok:false：这是监控探针，调用方要能一次拿到全部 failures 做巡检图表；
 * HTTP 层失败只留给「接口不存在/未授权」，业务不一致用 body 表达（与 render no_markers 同口径）。
 *
 * @param {{root?:string,config?:any,detect?:Function}} [args]
 * @returns {object}
 */
export function rulesHealthPayload({ root = '', config = {}, detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const manifest = readManifest(dir)
  const tombstones = readTombstones(dir)
  const failures = []
  const push = (code, extra = {}) => failures.push({ code, ...extra })

  // ① 文件层：解析/校验失败、key≠文件名、编号重复都由 listRules 归到 errors。
  // validateRule 的具体原因在 detail[].code（duplicate_number/number_reserved/…），必须摊平，
  // 否则巡检只能看到笼统的 invalid_rule，等于没报出到底是撞号还是保留号。
  for (const item of list.errors) {
    push(textOf(item.error) || 'invalid_rule', { file: textOf(item.file), detail: item.detail })
    if (Array.isArray(item.detail)) {
      for (const error of item.detail) {
        const code = textOf(error?.code)
        if (code && code !== textOf(item.error)) {
          push(code, { file: textOf(item.file), field: textOf(error?.field), detail: error?.message })
        }
      }
    }
  }

  // ② manifest 与磁盘文件对账（manifest 是墓碑唯一真源，内容漂移必须报）。
  if (!manifest) {
    push('manifest_missing', { file: `${dir}/manifest.json` })
  } else {
    const computed = computeManifest(list.rules, manifest.retired, fileRuleNumbers(dir))
    if (Number(manifest.total) !== computed.total) {
      push('manifest_total_mismatch', { expected: computed.total, actual: Number(manifest.total) })
    }
    if (Number(manifest.nextNumber) !== computed.nextNumber) {
      push('manifest_next_number_mismatch', { expected: computed.nextNumber, actual: Number(manifest.nextNumber) })
    }
    const liveKeys = list.rules.map((doc) => textOf(doc.front.key)).sort()
    const manifestKeys = (Array.isArray(manifest.keys) ? manifest.keys : []).map((key) => textOf(key)).sort()
    if (liveKeys.join('\n') !== manifestKeys.join('\n')) {
      push('manifest_keys_mismatch', {
        missing: liveKeys.filter((key) => !manifestKeys.includes(key)),
        extra: manifestKeys.filter((key) => !liveKeys.includes(key)),
      })
    }
    const manifestRetired = (Array.isArray(manifest.retired) ? manifest.retired : [])
      .map((item) => ({ key: textOf(item?.key), number: Number(item?.number) }))
      .sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
    const diskRetired = tombstones.map((item) => ({ key: item.key, number: item.number }))
    if (manifestRetired.length !== diskRetired.length
      || manifestRetired.some((item, index) => item.number !== diskRetired[index].number || item.key !== diskRetired[index].key)) {
      push('retired_mismatch', { manifest: manifestRetired, retiredDir: diskRetired })
    }
  }

  // ③ 合并/取代链：断链、环、链终点非 active 都必须报（注入/摘要只该用 terminal+active）。
  const chains = chainIssues(list.rules)
  for (const item of chains.broken) {
    push('chain_broken', { key: textOf(item.key), missingKey: textOf(item.missingKey), chain: item.chain })
  }
  for (const item of chains.cycles) {
    push('chain_cycle', { key: textOf(item.key), chain: item.chain })
  }
  for (const doc of list.rules) {
    const key = textOf(doc.front.key)
    const pointer = textOf(doc.front.merged_into) || textOf(doc.front.superseded_by)
    if (!pointer) continue
    const resolved = resolveChain(list.rules, key)
    // 断链/环已在上面报过，这里只报「链能走通但终点不是 active」。
    if (resolved.ok && resolved.status !== 'active') {
      push('chain_target_inactive', { key, chain: resolved.chain, status: resolved.status })
    }
  }

  // ④ 墓碑编号不得被现存铁律复活（writeRule 不拦恢复默认，必须在巡检里红）。
  const retiredNumbers = new Set(tombstones.map((item) => item.number))
  for (const doc of list.rules) {
    const n = Number(doc.front.number)
    if (doc.front.type === 'iron-rule' && Number.isInteger(n) && n > 0 && retiredNumbers.has(n)) {
      push('retired_number_reused', { key: textOf(doc.front.key), number: n })
    }
  }

  return {
    ok: failures.length === 0,
    dir,
    failures,
    counts: {
      rules: list.rules.length,
      errors: list.errors.length,
      tombstones: tombstones.length,
      nextNumber: manifest ? Number(manifest.nextNumber) : null,
    },
    git: gitView({ config, detect }),
    checkedAt: Date.now(),
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

// ---------------------------------------------------------------------------
// R8-09：plan 预览 / 恢复默认 / 能力探测（契约保留，core 未上线时显式降级）
// ---------------------------------------------------------------------------

/** 规则 plan 模块（task-2 新增 `src/core/rule-plan.js`）；未上线返回 null，不抛。 */
async function loadRulePlan() {
  try {
    const mod = await import('../core/rule-plan.js')
    return mod && typeof mod.buildApplyPlan === 'function' ? mod : null
  } catch {
    return null
  }
}

/** 默认规则恢复函数（task-1 可能提供）；按常见命名探测，未提供返回 null。 */
async function loadDefaultRestore() {
  try {
    const mod = await import('../core/rule-defaults.js')
    for (const name of ['restoreDefaultRule', 'restoreRuleDefault', 'restoreDefault']) {
      if (typeof mod?.[name] === 'function') return mod[name]
    }
  } catch { /* 模块不可用按「未提供」处理 */ }
  return null
}

/**
 * 面板能力探测：`GET /rules` 带 capabilities，客户端据此**隐藏**尚未上线能力的入口
 * （恢复默认按钮、plan 预览），而不是点了才报 501。
 * @returns {Promise<{plan:boolean,restoreDefault:boolean}>}
 */
export async function rulesCapabilities() {
  const plan = existsSync(new URL('../core/rule-plan.js', import.meta.url))
  const restore = await loadDefaultRestore()
  return { plan, restoreDefault: Boolean(restore) }
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

// ---------------------------------------------------------------------------
// R5：编辑 / 版本 diff / 回滚（文件+git 在 rule-store，镜像/渲染/审计在本层编排）
// ---------------------------------------------------------------------------

/** 规则视图：规范嵌套 front + 扁平字段（与详情接口同形状，面板只写一套渲染）。 */
function ruleView(doc) {
  return {
    ...doc.front,
    front: doc.front,
    text: textOf(doc.text),
    bodyStart: doc.bodyStart,
    path: doc.file,
    title: titleOf(doc.front, doc.text),
  }
}

/**
 * 后处理：镜像（rules.mirrorAuto）→ AGENTS 摘要（rules.renderAgents）。
 * 失败只记录并回给面板，不回滚规则文件：它们可重试，回滚反而丢掉已经写好的真源。
 * @returns {{mirror:object|null,agents:object|null}}
 */
function applyPostSteps({ dir, config, backend, mirror, renderAgents, log }) {
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
      agentsResult = agentsFn({ rules: postRules, agentsPath: agentsPathOf(dir), rulesDir: dir, log })
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
function auditRuleChange({
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

/**
 * 版本列表 payload：当前版本 + 历史快照 + 触及该 key 文件的 git 提交。
 *
 * 两条时间线合成一个 `versions` 数组是刻意的：面板"选一版看 diff/revert"不需要知道
 * 那是文件快照还是 git 提交，只需要一个能原样传给 `/rules/diff?rev=` 的 rev。
 * @param {{root?:string,config?:any,key:string,detect?:Function}} args
 * @returns {object}
 */
export function ruleVersionsPayload({ root = '', config = {}, key = '', detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const history = readHistory(dir, key)
  const versions = [{
    kind: 'current',
    rev: '',
    version: Number(got.rule.front.version) || null,
    ts: textOf(got.rule.front.updated),
    source: 'file',
    commit: '',
    subject: '当前版本',
  }]
  if (history.ok) {
    for (const entry of history.entries) {
      versions.push({
        kind: 'history',
        rev: entry.rev,
        version: entry.version ?? null,
        ts: entry.ts,
        source: entry.source,
        commit: '',
        subject: '',
      })
    }
  }
  // git 是可选增强：仓库缺失/无提交时版本列表照常返回（不把 git 缺失变成读失败）。
  const seen = new Set()
  for (const rel of [`${key}.md`, `proposals/${key}.md`]) {
    const log = gitLog(dir, 30, { withTime: true, path: rel })
    if (!log.ok) continue
    for (const entry of log.entries) {
      if (seen.has(entry.hash)) continue
      seen.add(entry.hash)
      const m = String(entry.subject).match(/v(\d+)\s*$/)
      versions.push({
        kind: 'git',
        rev: entry.hash,
        version: m ? Number(m[1]) : null,
        ts: entry.ts ? new Date(entry.ts * 1000).toISOString() : '',
        source: 'git',
        commit: entry.hash,
        subject: entry.subject,
      })
    }
  }
  return {
    ok: true,
    dir,
    key,
    current: {
      version: Number(got.rule.front.version) || null,
      updated: textOf(got.rule.front.updated),
      status: textOf(got.rule.front.status),
      chars: Array.from(textOf(got.rule.text)).length,
    },
    versions,
    git: gitView({ config, detect }),
    ...(history.ok ? {} : { historyError: history.error }),
  }
}

/**
 * 版本 diff payload（纯函数 + 行 diff，不引库）。
 * @param {{root?:string,config?:any,key:string,rev:string,detect?:Function,maxLines?:number}} args
 * @returns {object}
 */
export function ruleDiffPayload({
  root = '', config = {}, key = '', rev = '', detect = detectGit, maxLines = DIFF_LINE_LIMIT,
} = {}) {
  const dir = root || resolveRulesRoot(config)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const resolved = resolveRevision({ root: dir, key, rev })
  if (!resolved.ok) return { ok: false, error: resolved.error, detail: resolved.detail }
  const oldText = textOf(resolved.rule.text)
  const newText = textOf(got.rule.text)
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : DIFF_LINE_LIMIT
  const lineCount = (text) => (text === '' ? 0 : text.split('\n').length)
  const oldLines = lineCount(oldText)
  const newLines = lineCount(newText)
  if (oldLines > limit || newLines > limit) {
    return { ok: false, error: 'diff_too_large', detail: { limit, oldLines, newLines } }
  }
  return {
    ok: true,
    dir,
    key,
    rev: resolved.rev,
    source: resolved.source,
    oldText,
    newText,
    diff: diffLines(oldText, newText),
    git: gitView({ config, detect }),
  }
}

/**
 * 直接编辑规则（R5）：与 apply 同一写闸门（rules_disabled / git_required）。
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function updatePayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const before = readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  // 与 apply 同口径：首次写前把规则仓/首个 commit 建好，否则新目录的编辑永远提交不上。
  // 放在读规则之后：打错 key 不该顺手建出一个空规则仓。
  const ensured = ensureRuleRepo({ root: dir, git: git !== false, ...(exec ? { exec } : {}) })
  if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
  const patch = body?.patch
  const updated = updateRule({
    root: dir,
    key,
    patch,
    identity: body?.identity,
    traceId: textOf(body?.traceId),
    now,
  }, { git, exec })
  if (!updated.ok) {
    return { ok: false, error: updated.error, detail: updated.detail, rolledBack: updated.rolledBack }
  }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: 'rule_edit',
    key,
    beforeText: before.rule.text,
    afterText: textOf(updated.rule.text),
    commit: updated.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: body?.identity,
    log,
    extra: {
      fields: Object.keys(patch && typeof patch === 'object' ? patch : {}),
      fromVersion: updated.previousVersion,
      toVersion: updated.version,
      changed: updated.changed,
    },
  })
  return {
    ok: true,
    dir,
    key,
    changed: Boolean(updated.changed),
    rule: ruleView(updated.rule),
    // 与 apply 契约一致：`commit` 是提交消息字符串（面板直接展示）；
    // 结构化细节（ok/committed/error）放 commitInfo，避免客户端把对象 String 成 [object Object]。
    commit: textOf(updated.commit?.message),
    commitInfo: updated.commit,
    version: updated.version,
    previousVersion: updated.previousVersion,
    mirror: post.mirror ? { ok: Boolean(post.mirror.ok), mirrored: post.mirror.mirrored ?? null } : null,
    agents: post.agents
      ? {
        ok: Boolean(post.agents.ok),
        code: textOf(post.agents.code),
        changed: post.agents.changed ?? null,
        count: Number(post.agents.count) || 0,
      }
      : null,
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * 回滚到指定版本（作为新版本写回，不删历史）。
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function revertPayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const rev = textOf(body?.rev).trim()
  if (!rev) return { ok: false, error: 'invalid_rev' }
  const before = readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  const ensured = ensureRuleRepo({ root: dir, git: git !== false, ...(exec ? { exec } : {}) })
  if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
  const reverted = revertRule({
    root: dir,
    key,
    rev,
    identity: body?.identity,
    traceId: textOf(body?.traceId),
    now,
  }, { git, exec })
  if (!reverted.ok) {
    return {
      ok: false,
      error: reverted.error === 'snapshot_not_found' ? 'rev_not_found' : reverted.error,
      detail: reverted.detail,
      rolledBack: reverted.rolledBack,
    }
  }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: 'rule_revert',
    key,
    beforeText: before.rule.text,
    afterText: textOf(reverted.rule.text),
    commit: reverted.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: body?.identity,
    log,
    extra: {
      revertTo: reverted.revertedTo,
      source: reverted.source,
      fromVersion: reverted.previousVersion,
      toVersion: reverted.version,
    },
  })
  return {
    ok: true,
    dir,
    key,
    revertedTo: reverted.revertedTo,
    source: reverted.source,
    changed: true,
    rule: ruleView(reverted.rule),
    commit: textOf(reverted.commit?.message),
    commitInfo: reverted.commit,
    version: reverted.version,
    previousVersion: reverted.previousVersion,
    mirror: post.mirror ? { ok: Boolean(post.mirror.ok), mirrored: post.mirror.mirrored ?? null } : null,
    agents: post.agents
      ? {
        ok: Boolean(post.agents.ok),
        code: textOf(post.agents.code),
        changed: post.agents.changed ?? null,
        count: Number(post.agents.count) || 0,
      }
      : null,
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * 请求体身份归一（面板显式给了 identity 就用它，否则读扁平 userId/roleId/workspace）。
 * 只做截断，不做身份推导：面板没有会话 header，推导在 identity-source。
 * @param {object} body
 * @returns {{userId:string,roleId:string,workspace:string}}
 */
function identityOf(body) {
  const src = body?.identity && typeof body.identity === 'object' ? body.identity : body
  return {
    userId: textOf(src?.userId).slice(0, 128),
    roleId: textOf(src?.roleId).slice(0, 64),
    workspace: textOf(src?.workspace).slice(0, 64),
  }
}

/** 写后处理视图（与 update/revert 同形状：面板只写一套渲染）。 */
function postView(post) {
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
 * 新建规则（面板直写）：与 apply/update 同一写闸门（rules_disabled / git_required）。
 *
 * 二次确认由 client 负责——服务端只执行守卫，不弹窗。写后照例镜像/渲染/审计
 * （writes.reason=rule_create），失败不回滚文件：它们可重试，回滚反而丢掉已写好的真源。
 *
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function createPayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const draft = body?.draft && typeof body.draft === 'object' && !Array.isArray(body.draft) ? body.draft : null
  if (!draft) return { ok: false, error: 'invalid_draft', detail: { reason: 'draft_must_be_object' } }
  const identity = identityOf(body)
  const created = createRule({
    root: dir,
    draft,
    identity,
    traceId: textOf(body?.traceId),
    now,
  }, { git, exec })
  if (!created.ok) {
    return { ok: false, error: textOf(created.error) || 'invalid_rule', detail: created.detail }
  }
  const key = textOf(created.key)
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: 'rule_create',
    key,
    beforeText: '',
    afterText: textOf(created.rule.text),
    commit: created.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity,
    log,
    extra: {
      number: created.number,
      type: created.type,
      origin: created.origin,
      created: created.rule?.front?.created,
    },
  })
  return {
    ok: true,
    dir,
    key,
    number: created.number,
    type: created.type,
    rule: ruleView(created.rule),
    // 与 update/revert 契约一致：`commit` 是提交消息字符串，结构化细节在 commitInfo。
    commit: textOf(created.commit?.message),
    commitInfo: created.commit,
    version: Number(created.version) || 1,
    ...postView(post),
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * 停用/恢复/彻底删除规则（`mode:'retire'|'reactivate'|'purge'`，默认 retire）。
 *
 * 停用只改 status（文件/编号/正文/历史全保留）：编号永不复用，所以 manifest 的 nextNumber 不因
 * 停用回退；镜像侧 pinned 归 0 由 rule-mirror 按 status 投影，本层只负责触发。
 * 已 retired 再停用 → `already_retired`；未 retired 恢复 → `not_retired`（幂等动作要显式报"没动"）。
 *
 * purge 是**删除**而不是停用：文件物理删除、编号进 manifest 墓碑后作废永不复用，见 `purgePayload`。
 *
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function deletePayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const allowedModes = ['retire', 'reactivate', 'purge']
  const mode = textOf(body?.mode).trim() || 'retire'
  if (!allowedModes.includes(mode)) {
    return { ok: false, error: 'invalid_mode', detail: { mode, allowed: allowedModes } }
  }
  const before = readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  // 与 update 同口径：首次写前建好规则仓/首个 commit（新目录否则提交不上）。
  const ensured = ensureRuleRepo({ root: dir, git: git !== false, ...(exec ? { exec } : {}) })
  if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
  if (mode === 'purge') {
    return purgePayload({
      dir, key, config, backend, before, body, mirror, renderAgents, git, exec, log, now,
    })
  }
  const changed = mode === 'retire'
    ? retireRule({ root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now }, { git, exec })
    : reactivateRule({ root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now }, { git, exec })
  if (!changed.ok) {
    return { ok: false, error: changed.error, detail: changed.detail, status: textOf(changed.status) }
  }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: mode === 'retire' ? 'rule_retire' : 'rule_reactivate',
    key,
    beforeText: textOf(before.rule.text),
    afterText: textOf(changed.rule.text),
    commit: changed.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: identityOf(body),
    log,
    extra: {
      mode,
      fromVersion: changed.previousVersion,
      toVersion: changed.version,
      changed: changed.changed,
    },
  })
  return {
    ok: true,
    dir,
    key,
    mode,
    status: textOf(changed.status || changed.rule?.front?.status),
    changed: changed.changed !== false,
    rule: ruleView(changed.rule),
    commit: textOf(changed.commit?.message),
    commitInfo: changed.commit,
    version: changed.version,
    previousVersion: changed.previousVersion,
    ...postView(post),
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * purge 分支（deletePayload 内部）：彻底删除 + 镜像/AGENTS/审计。
 *
 * Why 后处理照旧走 `applyPostSteps`：文件没了，`mirrorRules` 会把孤儿镜像行归档为
 * archived/pinned=0（不物理删，保留审计），AGENTS 摘要也随之不再列出该规则。
 * 审计特殊在 `afterText=null`：规则不存在了，写 null 比空串诚实；evolution 记
 * `status: 旧状态 → deleted`，别拿空正文冒充"改成了空规则"。
 *
 * @returns {object}
 */
function purgePayload({
  dir, key, config, backend, before, body, mirror, renderAgents, git, exec, log, now,
}) {
  const purged = purgeRule({
    root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now,
  }, { git, exec })
  if (!purged.ok) return { ok: false, error: purged.error, detail: purged.detail }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const manifest = readManifest(dir) || {}
  const retiredNumbers = (Array.isArray(manifest.retired) ? manifest.retired : [])
    .map((item) => Number(item?.number))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  const nextNumber = Number(manifest.nextNumber) || 1
  const audit = auditRuleChange({
    backend,
    reason: 'rule_purge',
    key,
    beforeText: textOf(before.rule.text),
    afterText: null,
    commit: purged.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: identityOf(body),
    log,
    evolutionField: 'status',
    evolutionOld: textOf(before.rule.front.status),
    evolutionNew: 'deleted',
    extra: {
      mode: 'purge',
      number: purged.number,
      version: purged.version,
      retiredNumbers,
      nextNumber,
      purged: true,
      deleted: true,
    },
  })
  return {
    ok: true,
    dir,
    key,
    mode: 'purge',
    status: 'deleted',
    purged: true,
    deleted: true,
    number: purged.number,
    version: purged.version,
    historySnapshot: purged.historySnapshot,
    commit: textOf(purged.commit?.message),
    commitInfo: purged.commit,
    retiredNumbers,
    nextNumber,
    ...postView(post),
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
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
  // 架构书 §4.1：rules.renderAgents=false 时自愈与手动渲染都跳过（手动重渲染不得绕过开关）。
  if (value(config?.rules?.renderAgents, true) === false) return { ok: false, error: 'render_disabled' }
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

/** query 读取（handleRules 只拿 pathname，query 必须自己从 req.url 取）。 */
function queryOf(req) {
  try {
    return new URL(textOf(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** `?status=` 读取。 */
function statusQuery(req) {
  return textOf(queryOf(req).get('status'))
}

/**
 * 错误码 → HTTP 状态（面板按 status/error 决定文案；语义化而不是一律 500）。
 * @param {string} code
 * @returns {number}
 */
function statusForError(code) {
  if (code === 'proposal_not_found' || code === 'rule_not_found' || code === 'rev_not_found') return 404
  if (code === 'rules_disabled' || code === 'render_disabled' || code === 'git_required'
    || code === 'cross_origin_denied') return 403
  if (code === 'plan_unavailable' || code === 'restore_unavailable') return 501
  if (code === 'proposal_not_pending' || code === 'rule_locked') return 409
  // 计划 CAS/墓碑/目标冲突都是并发语义：面板重试前必须先重新 plan。
  if (code === 'plan_hash_mismatch' || code === 'plan_stale' || code === 'number_retired'
    || code === 'target_conflict' || code === 'target_missing' || code === 'affected_missing') return 409
  if (code === 'lock_failed') return 503
  if (code === 'number_exhausted' || code === 'txn_failed') return 422
  // 幂等动作的"没动"是冲突语义：已停用再停用 / 未停用却恢复 / 同 key 重建，都不该按 400 报。
  if (code === 'already_retired' || code === 'not_retired' || code === 'duplicate_rule') return 409
  if (code === 'diff_too_large') return 413
  if (code === 'unsupported_media_type') return 415
  if (code === 'rule_guard_failed' || code === 'needs_manual' || code === 'llm_unavailable'
    || code === 'llm_unparseable' || code === 'llm_error' || code === 'commit_failed'
    || code === 'write_failed' || code === 'affected_write_failed' || code === 'invalid_rule'
    || code === 'invalid_draft') return 422
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
  const listPath = `${RULES_PREFIX}/rules`
  const gitPath = `${RULES_PREFIX}/rules/git-status`
  const healthPath = `${RULES_PREFIX}/rules/health`
  const rebuildPath = `${RULES_PREFIX}/rules/rebuild-mirror`
  const importPath = `${RULES_PREFIX}/rules/import-legacy`
  const proposePath = `${RULES_PREFIX}/rules/propose`
  const applyPath = `${RULES_PREFIX}/rules/apply`
  const rejectPath = `${RULES_PREFIX}/rules/reject`
  const renderPath = `${RULES_PREFIX}/rules/render-agents`
  const proposalsPath = `${RULES_PREFIX}/rules/proposals`
  const planPath = `${RULES_PREFIX}/rules/plan`
  const restorePath = `${RULES_PREFIX}/rules/restore-default`
  const diffPath = `${RULES_PREFIX}/rules/diff`
  const versionsPath = `${RULES_PREFIX}/rules/versions`
  const updatePath = `${RULES_PREFIX}/rules/update`
  const revertPath = `${RULES_PREFIX}/rules/revert`
  const createPath = `${RULES_PREFIX}/rules/create`
  const deletePath = `${RULES_PREFIX}/rules/delete`

  if (p === listPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // capabilities 让客户端**隐藏**还没上线的入口（恢复默认/plan），而不是点了才 501。
    const capabilities = await rulesCapabilities()
    sendJson(res, 200, { ...rulesListPayload({ config, detect }), capabilities })
    return true
  }

  if (p === gitPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 路由层强制刷新：面板点「重新检测」必须绕过 60s 缓存。
    const fresh = detect === detectGit ? refreshGit() : detect({ force: true })
    sendJson(res, 200, gitStatusPayload({ config, detect: () => fresh }))
    return true
  }

  if (p === healthPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 巡检探针：业务不一致也回 200，ok:false + failures[] 交给调用方（文档口径一致）。
    sendJson(res, 200, rulesHealthPayload({ config, detect }))
    return true
  }

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

  if (p === diffPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    const query = queryOf(req)
    const payload = ruleDiffPayload({
      config,
      key: textOf(query.get('key')).trim(),
      rev: textOf(query.get('rev')).trim(),
      detect,
    })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === versionsPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    const query = queryOf(req)
    const payload = ruleVersionsPayload({
      config,
      key: textOf(query.get('key')).trim(),
      detect,
    })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === updatePath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(updatePayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === revertPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(revertPayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === createPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(createPayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === deletePath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(deletePayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
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

  if (p === renderPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    await readJson(req)
    const payload = afterWrite(renderAgentsPayload({ config, log }))
    // no_markers/duplicate_markers 是幂等「没动」，200 带 ok:false；闸门类错误才按 403。
    sendJson(res, payload.error ? statusForError(textOf(payload.error)) : 200, payload)
    return true
  }

  if (p === rebuildPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    // 无载荷动作：仍要排空 body，避免 keep-alive 连接残留请求体；空 body 不算错误。
    await readJson(req)
    const payload = rebuildMirrorPayload({ config, backend, detect, log })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === importPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) {
      sendJson(res, body.status, { ok: false, error: body.error })
      return true
    }
    const rawKey = textOf(body.value?.key).trim()
    // 非法 key 不再静默截断：422 让调用方知道是参数问题；未给 key 时按旧铁律节点推导。
    if (rawKey && !isValidRuleKey(rawKey.slice(0, 64))) {
      sendJson(res, 422, { ok: false, error: 'invalid_key' })
      return true
    }
    const key = rawKey.slice(0, 64)
    const rawNumber = Number(body.value?.number)
    const payload = afterWrite(importLegacyPayload({
      config,
      backend,
      key,
      number: Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : null,
      detect,
      log,
    }))
    // 404=节点不存在、409=重复、422=未通过校验；不再把管理动作一律按 403 报。
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
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
