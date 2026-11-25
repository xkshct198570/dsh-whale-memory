// 职责：rules 新建/删除组——新建、停用/恢复/彻底删除（purge + 墓碑）及其 2 条路由。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, sendJson } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { createRule, isValidRuleKey, normalizeRuleDoc, parseRuleDocument, purgeRule, reactivateRule, readManifest, readRule, readRuleSource, retireRule } from '../../core/rule-store.js'
import { RULES_PREFIX, applyPostSteps, auditRuleChange, identityOf, postView, resolveRulesRoot, ruleView, sendMethodNotAllowed, statusForError, textOf, writeGuard } from './shared.js'

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

// ---------------------------------------------------------------------------
// 路由：新建/删除组（2 条精确路径）。与兜底无路径交叉；/rules/:key 兜底仍由 router 末位调用。
// ---------------------------------------------------------------------------

/**
 * 新建 / 停用-恢复-删除两条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,backend?:any,detect?:Function,
 *   log?:Function,git?:boolean,afterWrite?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleCreateDelete({
  req, res, path, config = {}, backend = null, detect = detectGit, log = () => {}, git = true,
  afterWrite = (payload) => payload,
} = {}) {
  const p = textOf(path)
  const createPath = `${RULES_PREFIX}/rules/create`
  const deletePath = `${RULES_PREFIX}/rules/delete`

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

  return false
}
