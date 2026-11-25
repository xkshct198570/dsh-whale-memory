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
import { RULES_PREFIX, textOf, summaryBudgetOf, resolveRulesRoot, ruleView, postView, identityOf, writeGuard, applyPostSteps, auditRuleChange, sendMethodNotAllowed, statusForError } from './rules-routes/shared.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, sendJson, isWriteMethod, writeRequestProblem } from './http-kit.js'
import { value } from '../shared/config-values.js'
import { detectGit } from './git-detector.js'
export { RULES_PREFIX, resolveRulesRoot } from './rules-routes/shared.js'
import { handleListHealth, handleRuleDetail } from './rules-routes/list-health.js'
export { gitStatusPayload, ruleDetailPayload, rulesCapabilities, rulesHealthPayload, rulesListPayload } from './rules-routes/list-health.js'
import { handleProposal } from './rules-routes/proposal.js'
export { applyPayload, planPayload, proposalView, proposePayload, rejectPayload, restoreDefaultPayload, rulesProposalsPayload } from './rules-routes/proposal.js'
import { handleEditRevert } from './rules-routes/edit-revert.js'
export { revertPayload, ruleDiffPayload, ruleVersionsPayload, updatePayload } from './rules-routes/edit-revert.js'
import { createRule, isValidRuleKey, listRules, normalizeRuleDoc, parseRuleDocument, purgeRule, reactivateRule, readManifest, readRule, readRuleSource, retireRule } from '../core/rule-store.js'
import { importLegacyRule, mirrorRules, mirrorStatus } from '../core/rule-mirror.js'
import { agentsPathOf, renderAgentsDigest } from '../core/rule-render.js'



















// ---------------------------------------------------------------------------
// R8-09：plan 预览 / 恢复默认 / 能力探测（契约保留，core 未上线时显式降级）
// ---------------------------------------------------------------------------














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
  }, { git, exec, gitRequired: guard.required })
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
    commitState: created.commitState ?? null,
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
  // purge 是「删除」而不是写：缺/错 confirmKey 必须在任何落盘动作（建仓/墓碑/删文件）之前拒绝。
  // 只认整句 key（body.confirmKey === key），面板的 DangerButton 也按同一口径判。
  if (mode === 'purge' && textOf(body?.confirmKey) !== key) {
    return { ok: false, error: 'confirm_required', detail: { mode, key } }
  }
  // purge 只做 readRuleSource + 解析/快照，不跑写入守卫：手改写坏的规则（正文非指令形态、
  // 超长、带 HTML 注释标记）仍必须能删，否则脏文件永远删不掉。停用/恢复仍走全量校验。
  const before = mode === 'purge' ? readRuleForPurge(dir, key) : readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  // 建仓由 store 写入口自己负责（purgeRule/updateRule 均 ensure），路由只做闸门与后处理。
  if (mode === 'purge') {
    return purgePayload({
      dir, key, config, backend, before, body, mirror, renderAgents, git, exec, log, now,
      gitRequired: guard.required,
    })
  }
  const changed = mode === 'retire'
    ? retireRule({ root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now }, { git, exec, gitRequired: guard.required })
    : reactivateRule({ root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now }, { git, exec, gitRequired: guard.required })
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
    commitState: changed.commitState ?? null,
    version: changed.version,
    previousVersion: changed.previousVersion,
    ...postView(post),
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * 规则文件落点（purge 前宽松读取用）：正式规则在根目录，候选在 proposals/。
 * @param {string} dir @param {string} key
 * @returns {string} 文件路径；不存在返回 ''
 */
function ruleFileFor(dir, key) {
  for (const file of [join(dir, `${key}.md`), join(dir, 'proposals', `${key}.md`)]) {
    if (existsSync(file)) return file
  }
  return ''
}

/**
 * purge 前的宽松读取：`readRuleSource` + 解析 + key 对齐，不做正文/写入守卫校验。
 *
 * Why 与 `readRule` 分开：删除动作面对的是"已经被手改写坏、正需要删掉"的文件；
 * 用写路径的校验当读取闸，会让坏文件永久占号且删不掉（架构书 §7.1 实测 invalid_rule 422）。
 *
 * @param {string} dir @param {string} key
 * @returns {{ok:boolean,rule?:object,error?:string,detail?:any}}
 */
function readRuleForPurge(dir, key) {
  const file = ruleFileFor(dir, key)
  if (!file) return { ok: false, error: 'rule_not_found' }
  const source = readRuleSource(file)
  if (!source.ok) return { ok: false, error: source.error }
  const parsed = parseRuleDocument(source.text)
  if (!parsed.ok) return { ok: false, error: 'invalid_rule', detail: { parse: parsed.error } }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  if (normalized.front.key !== String(key)) {
    return { ok: false, error: 'key_mismatch', detail: { key: String(key), frontKey: normalized.front.key, file } }
  }
  return {
    ok: true,
    rule: { front: normalized.front, text: normalized.text, bodyStart: parsed.bodyStart, file },
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
  dir, key, config, backend, before, body, mirror, renderAgents, git, exec, log, now, gitRequired = false,
}) {
  // purge 是删除不是写入：不跑正文守卫（手改写坏的规则也必须删得掉），只做宽松解析。
  let purged = purgeRule({
    root: dir, key, identity: identityOf(body), traceId: textOf(body?.traceId), now,
  }, { git, exec, skipValidation: true, gitRequired })
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
  const imported = importLegacyRule({ backend, key, number, root: dir, gitRequired: guard.required })
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
  const rebuildPath = `${RULES_PREFIX}/rules/rebuild-mirror`
  const importPath = `${RULES_PREFIX}/rules/import-legacy`
  const renderPath = `${RULES_PREFIX}/rules/render-agents`
  const createPath = `${RULES_PREFIX}/rules/create`
  const deletePath = `${RULES_PREFIX}/rules/delete`

  if (await handleListHealth({ req, res, path: p, config, detect })) return true

  if (await handleProposal({
    req, res, path: p, config, backend, detect, log, getLlm, getSelection, git, afterWrite,
  })) return true

  if (await handleEditRevert({
    req, res, path: p, config, backend, detect, log, git, afterWrite,
  })) return true

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

  if (handleRuleDetail({ req, res, path: p, config, detect })) return true
  return false
}
