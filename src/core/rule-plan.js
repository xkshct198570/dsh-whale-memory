/**
 * 应用计划（R8-03）：`buildApplyPlan` 是规则落盘的**唯一预演**——纯函数、不写盘、不 commit。
 *
 * 职责：
 * - 把候选（proposal）+ 磁盘真源 + 面板 decisions 编成一份可执行计划：target / files / affected /
 *   planHash / commitMessage；`/rules/plan` 直接把这份计划吐给面板，`applyProposal` 只认 planHash；
 * - **逐文件守卫**（架构书 §3.6）：每条 `newText` 对它替换的旧规则校验例外/条件/模态/作用域，
 *   front 的 conditions/exceptions 与正文并集一致；strict 下白名单不解锁丢条款；
 * - 冲突语义：`conflict` 只要求新正文表达**新模态**（旧模态允许被取代），refine/merge 仍要求旧模态保留；
 * - TOCTOU 防具：每个文件带 `oldHash`（磁盘内容 sha256），apply 在仓库锁内逐文件复核。
 *
 * 边界：
 * - 不 import `rule-proposal.js`（会被 proposal import，形成环）：根目录解析只做最小复用，
 *   真正的根目录由调用方（host/apply）传已解析的 `rulesDir`；
 * - 不调模型：LLM 改写由 `applyProposal` 在进入本函数**之前**完成，结果作为 `decisions.text` /
 *   `decisions.affected[].new_text` 传进来，一律在这里过守卫——模型永远拿不到直写文件的能力；
 * - 不碰 DB / 镜像 / AGENTS / 审计（后处理在 applyProposal 里）。
 *
 * Why 单独成文件：守卫与 planHash 必须能在脱宿主、脱 git 的条件下被单测锁住；混进 apply
 * 就又会回到「守卫只看合并正文、affected[].new_text 直写」的 v3.7 缺口。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeRuleText } from './rules.js'
import {
  RESERVED_NUMBERS,
  defaultRuleRoot,
  listRules,
  nextRuleNumber,
  normalizeRuleDoc,
  occupancy,
  readTombstones,
  serializeRuleDocument,
} from './rule-store.js'
import {
  guardRewrite,
  normalizeForGuard,
  retainsClause,
  scopeKeyOf,
} from './rule-reconcile.js'

/** 铁律编号硬顶（R8-01：1–999，跳过空号 6）；超出即 number_exhausted。 */
const RULE_NUMBER_MAX_TENTH = 999

/** 需要措辞改写（不能直接落盘）的关系；与 rule-proposal 的 REWRITE_RELATIONS 同口径。 */
export const REWRITE_RELATIONS = Object.freeze(['merge', 'conflict', 'refine'])
/** 会 supersede 旧规则的关系（refine 是同一文件升版本，不 supersede 别的文件）。 */
const SUPERSEDE_RELATIONS = Object.freeze(['merge', 'conflict'])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** @param {any} value @returns {string} */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {any} value @returns {string} */
function trimmed(value) {
  return textOf(value).trim()
}

/** @param {any} input @param {any} fallback @returns {any} */
function cfgValue(input, fallback) {
  const raw = input && typeof input.get === 'function' ? input.get() : input
  return raw === undefined ? fallback : raw
}

/** @param {string} text @returns {string} sha256 hex（全量，不做前缀）；空串有稳定值。 */
function sha256(text) {
  return createHash('sha256').update(textOf(text), 'utf8').digest('hex')
}

/** 文件当前内容：不存在返回 null（新文件），读失败抛给调用方（不能让坏盘当空文件）。 */
function readIfExists(file) {
  if (!file) return null
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

/** 日期（YYYY-MM-DD）：用传入的 now 而不是全局时钟，计划才可重放。 */
function dayOf(now) {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * 规则根：显式参数优先；否则 `config.rules.dir`；再退化 `$DSH_HOME/rules`。
 * 与 `rule-proposal.resolveRuleRoot` 同口径（不 import 以避免循环依赖）。
 * @param {string} [rulesDir] @param {any} [config] @returns {string}
 */
function rootOf(rulesDir, config) {
  const explicit = trimmed(rulesDir)
  if (explicit) return resolve(explicit)
  const configured = trimmed(cfgValue(config?.rules?.dir, ''))
  return configured ? resolve(configured) : defaultRuleRoot()
}

/** 子句并集（归一化去重；保留原文形态）：只收**正文里确实还在**的子句，front 不许偷偷留旧条款。 */
function unionClauses(base, extra, mergedText) {
  const mergedNorm = normalizeForGuard(mergedText)
  const out = []
  const seen = new Set()
  for (const item of [...base, ...extra]) {
    const text = trimmed(item)
    if (!text) continue
    if (mergedNorm && !retainsClause(mergedNorm, text)) continue
    const key = normalizeRuleText(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/**
 * front/正文一致性（架构书 §3.6）：front 的 conditions/exceptions 必须都在正文里。
 *
 * 反向漂移（正文有、字段无）由调用方拿「被替换旧规则」的条款再核一遍（见 buildApplyPlan），
 * 这里只做不依赖上下文的半边：结构化字段写了却不在正文，等于注入读到的规则没有该条款。
 * @param {{front?:object, text?:string}} doc
 * @returns {{ok:boolean, failures:Array<{code:string, field:string, clause:string}>}}
 */
export function checkFrontConsistency({ front, text } = {}) {
  const norm = normalizeForGuard(textOf(text))
  const failures = []
  for (const field of ['conditions', 'exceptions']) {
    for (const clause of Array.isArray(front?.[field]) ? front[field] : []) {
      const trimmedClause = trimmed(clause)
      if (!trimmedClause) continue
      if (retainsClause(norm, trimmedClause)) continue
      failures.push({ code: 'front_body_drift', field, clause: trimmedClause })
    }
  }
  return { ok: failures.length === 0, failures }
}

/** 面板 decisions.affected 归一：只留「有 key 且有正文」的改写条目，同 key 后者覆盖前者。 */
function rewriteMapOf(decisions) {
  const out = new Map()
  for (const item of Array.isArray(decisions?.affected) ? decisions.affected : []) {
    const key = trimmed(item?.key)
    const next = trimmed(item?.new_text ?? item?.text)
    if (!key || !next) continue
    out.set(key, next)
  }
  return out
}

/** 失败返回（守卫/一致性失败都走这里：候选转 needs_manual 用同一形状）。 */
function failed(error, failures = [], detail = '') {
  return {
    ok: false,
    error,
    code: error,
    failures,
    needsManual: true,
    ...(detail ? { detail } : {}),
  }
}

// ---------------------------------------------------------------------------
// 计划哈希 / 执行计划
// ---------------------------------------------------------------------------

/** 计划指纹：覆盖将要写的每个文件（旧 hash + 新正文 hash）与受影响状态。 */
function hashPlanOf(plan) {
  const files = (Array.isArray(plan.files) ? plan.files : []).map((file) => ({
    key: file.key,
    path: file.path,
    oldHash: file.oldHash,
    // 新内容指纹必须**排除日期派生字段**（created/updated 由 now 派生）：否则隔夜重算同一份计划
    // 会得到不同 hash，面板预览与 apply 永远对不上。语义=front（去日期）+ 正文。
    newHash: file.front && typeof file.front === 'object'
      ? sha256(`${JSON.stringify({ ...file.front, created: '', updated: '' })}\n${textOf(file.text)}`)
      : sha256(file.newText),
    guards: (Array.isArray(file.guards) ? file.guards : []).map((guard) => [guard.code, guard.ok]),
  }))
  const affected = (Array.isArray(plan.affected) ? plan.affected : []).map((item) => ({
    key: item.key,
    oldHash: item.oldHash,
    newHash: sha256(item.newText),
    status: item.status,
  }))
  // 只散列「执行真正依赖」的字段（R9-14）：target 里带 created/updated/dayOf(now) 这类日期派生值，
  // 把整个 target 塞进来会让同一份计划隔夜变成不同指纹（面板 hash 对不上、apply 误报 plan_hash_mismatch）。
  const target = plan.target && typeof plan.target === 'object' ? plan.target : {}
  return sha256(JSON.stringify({
    proposalId: plan.proposalId,
    relation: plan.relation,
    target: { key: target.key, type: target.type, number: target.number, version: target.version },
    files,
    affected,
    commitMessage: plan.commitMessage,
  }))
}

/** 逐文件守卫结果条目（plan 里可见，面板能显示是哪条被拒）。 */
function guardEntry(code, ok, detail = '') {
  return { code, ok, detail }
}

/**
 * 构造应用计划（纯函数：只读磁盘，不写、不 commit、不镜像）。
 *
 * @param {{proposal:object, rulesDir?:string, config?:any, decisions?:object,
 *   now?:number, log?:Function, exec?:Function}} args
 *   proposal: 候选 JSON（含 draft/relation/affected 快照）
 *   decisions: `{text?, affected?:[{key,new_text}], acceptAffected?:string[],
 *     acknowledgeDropped?:Array<{key:string,clauses:string[]}>}`（面板/LLM 结果，必须过守卫；
 *     只认子句粒度，裸 key/布尔不再作为放行通道——架构书 §3.6）
 * @returns {{ok:true, plan:object} | {ok:false, error:string, code:string,
 *   failures:Array<object>, needsManual?:boolean, detail?:string}}
 */
export function buildApplyPlan({
  proposal, rulesDir, config = {}, decisions = {}, now = Date.now(), log = () => {}, exec = null,
  listed = null,
} = {}) {
  void exec // 契约占位：本函数不跑 git
  const base = rootOf(rulesDir, config)
  const proposalId = trimmed(proposal?.id)
  if (!proposalId || !proposal || typeof proposal !== 'object') return failed('proposal_corrupt')
  const draft = proposal.draft && typeof proposal.draft === 'object' ? proposal.draft : null
  if (!draft || !trimmed(draft.key)) return failed('proposal_corrupt')
  const relation = trimmed(proposal.relation?.relation) || 'new'
  const decided = decisions && typeof decisions === 'object' ? decisions : {}

  // 磁盘真源：只与 active 正式规则比对（superseded/candidate 不是落盘目标）。
  // 全量规则（含 retired/superseded）：它们仍占号——只按 active 算 nextNumber 会在停用/取代
  // 最高号后把该号重新发出去，写盘时撞 duplicate_number（R8-01 不变式）。
  // 快照可复用（R9-14）：apply 锁内已经读过一次 listRules，再内部扫一遍就是重复 I/O；
  // 调用方不给时仍然自己读（面板 plan 预览/单测路径不变）。
  const allRules = Array.isArray(listed) ? listed : listRules(base).rules
  const currentRules = allRules.filter((doc) => trimmed(doc.front.status) === 'active'
    && trimmed(doc.front.type) !== 'rule-candidate')
  const byKey = new Map(currentRules.map((doc) => [trimmed(doc.front.key), doc]))

  // duplicate：不新建/不改写任何文件，只标候选 accepted（apply 在锁内做状态 CAS）。
  if (relation === 'duplicate') {
    const targetKey = trimmed(proposal.relation?.targets?.[0]?.key)
    const doc = byKey.get(targetKey)
    if (!doc) return failed('affected_missing', [{ code: 'affected_missing', key: targetKey, detail: '重复目标规则已不在磁盘' }])
    const plan = {
      proposalId,
      relation,
      duplicate: true,
      target: {
        key: targetKey,
        type: trimmed(doc.front.type),
        number: Number.isInteger(Number(doc.front.number)) && Number(doc.front.number) > 0 ? Number(doc.front.number) : null,
        version: Number(doc.front.version) || 1,
        created: trimmed(doc.front.created),
        front: { ...doc.front },
      },
      files: [],
      affected: [{
        key: targetKey,
        oldText: textOf(doc.text),
        oldHash: sha256(readIfExists(doc.file) || ''),
        newText: textOf(doc.text),
        status: trimmed(doc.front.status),
      }],
      commitMessage: '',
    }
    plan.planHash = hashPlanOf(plan)
    return { ok: true, plan }
  }

  // 受影响旧规则查**全量**规则（R9-20）：文件还在盘上但 status≠active 是"停用"不是"已删除"，
  // 必须报 affected_inactive（附 status/path）；只有文件真不存在才 affected_missing。
  const allByKey = new Map(allRules.map((doc) => [trimmed(doc.front.key), doc]))
  const affectedDocs = []
  for (const snap of Array.isArray(proposal.affected) ? proposal.affected : []) {
    const key = trimmed(snap?.key)
    if (!key) continue
    const live = allByKey.get(key)
    if (!live) {
      return failed('affected_missing', [{ code: 'affected_missing', key, detail: '受影响规则已不在磁盘（可能已彻底删除）' }])
    }
    const status = trimmed(live.front.status)
    if (status !== 'active') {
      return failed('affected_inactive', [{
        code: 'affected_inactive',
        key,
        status,
        path: live.file,
        detail: `受影响规则已停用（status=${status}），文件仍在 ${live.file}；先启用或改选受影响规则`,
      }])
    }
    affectedDocs.push({ key, front: live.front, text: textOf(live.text), file: live.file })
  }
  affectedDocs.sort((a, b) => a.key.localeCompare(b.key))

  // 目标 key：refine 必须命中同 key；其它关系若已存在同 key 则拒绝覆盖（改 key 走单独动作）。
  let targetKey = trimmed(draft.key)
  const existingTarget = byKey.get(targetKey)
  if (existingTarget && relation !== 'refine') {
    return failed('target_conflict', [{
      code: 'target_conflict', key: targetKey, detail: `key 已存在（${relation} 不能覆盖既有规则，请走 refine/单独编辑）`,
    }])
  }
  if (relation === 'refine' && !existingTarget) {
    return failed('target_missing', [{ code: 'target_missing', key: targetKey, detail: 'refine 目标规则已不在磁盘' }])
  }
  // key 全仓唯一（跨 scope 也不得同名）：同 key 的文件存在但不是 active 时，新建会覆盖旧文件/撞号。
  if (!existingTarget && allByKey.has(targetKey)) {
    const clash = allByKey.get(targetKey)
    return failed('target_conflict', [{
      code: 'target_conflict',
      key: targetKey,
      detail: `key 已存在（status=${trimmed(clash.front.status)}），不得覆盖；请走 refine/单独编辑`,
    }])
  }

  // 面板白名单：只处理列出的受影响规则（不在白名单里的保持原样，不 supersede、不改写）。
  const acceptRaw = Array.isArray(decided.acceptAffected) && decided.acceptAffected.length
    ? new Set(decided.acceptAffected.map((key) => trimmed(key)).filter(Boolean))
    : null
  const acceptedAffected = acceptRaw ? affectedDocs.filter((doc) => acceptRaw.has(doc.key)) : affectedDocs

  // 改写正文：面板 decisions.text 优先，否则草案正文（LLM 结果由 apply 在进本函数前写进 decisions）。
  const mergedText = trimmed(decided.text) || trimmed(draft.text)
  if (!mergedText) return failed('empty_rewrite')

  const strict = cfgBoolGuard(config)
  // acknowledgeDropped 只收子句粒度 `[{key, clauses[]}]`（R9-14 / 架构书 §3.6）：
  // 旧布尔/裸 key 会让"勾选一次"放弃整条规则的全部条款，是安全洞，直接拒绝而不是静默忽略。
  const ackRaw = decided.acknowledgeDropped
  let acknowledgeDropped = []
  if (ackRaw !== undefined && ackRaw !== null && ackRaw !== false) {
    const bad = !Array.isArray(ackRaw) || ackRaw.some((item) => !item || typeof item !== 'object'
      || !trimmed(item.key) || !Array.isArray(item.clauses))
    if (bad) {
      return failed('invalid_acknowledge', [{
        code: 'invalid_acknowledge',
        key: '',
        detail: 'acknowledgeDropped 必须是 [{key, clauses:[...]}]（子句粒度，不接受布尔/裸 key）',
      }])
    }
    acknowledgeDropped = ackRaw.map((item) => ({ key: trimmed(item.key), clauses: item.clauses.map((c) => trimmed(c)).filter(Boolean) }))
  }
  const rewrites = rewriteMapOf(decided)

  // 目标 front：refine 沿用旧编号/created；新建取号只走 occupancy()（R9-20 单一真源）。
  // 编号只属于 iron-rule（R8-01）：普通规则/候选一律 number=null（store 校验会拒非 null）。
  const targetType = trimmed(draft.type) || 'rule'
  const targetIsIron = targetType === 'iron-rule'
  // 墓碑是独立真源：occupancy() 已含墓碑，但重分配每一步还要单独查墓碑，
  // 命中即 number_retired（不得顺延到墓碑号，架构书 §2.5.2）。
  const tombstoneNumbers = new Set(readTombstones(base)
    .map((item) => Number(item?.number))
    .filter((n) => Number.isInteger(n) && n > 0))
  const occupiedNumbers = occupancy(base, { listed: { rules: allRules } })
  /** 顺延到第一个合法空号；墓碑命中立即失败（不跳过），硬顶 1–999。 */
  const nextFreeNumber = (start) => {
    let n = Number.isInteger(start) && start > 0 ? start : 1
    for (; n <= RULE_NUMBER_MAX_TENTH; n += 1) {
      if (tombstoneNumbers.has(n)) return { ok: false, code: 'number_retired', number: n }
      if (RESERVED_NUMBERS.includes(n)) continue
      if (occupiedNumbers.has(n)) continue
      return { ok: true, number: n }
    }
    return { ok: false, code: 'number_exhausted', number: null }
  }
  let targetNumber = null
  let numberAdjusted = null
  if (targetIsIron) {
    if (existingTarget) {
      targetNumber = Number.isInteger(Number(existingTarget.front.number)) && Number(existingTarget.front.number) > 0
        ? Number(existingTarget.front.number) : null
    } else {
      // 不能只信提案时的号：保留号/已被占/墓碑都必须在此复核（提案后可能又被别人写走）。
      const proposed = Number(draft.number)
      let reason = ''
      if (!Number.isInteger(proposed) || proposed <= 0) reason = 'missing'
      else if (reservedNumber(proposed)) reason = 'reserved'
      else if (tombstoneNumbers.has(proposed)) reason = 'retired'
      else if (occupiedNumbers.has(proposed)) reason = 'occupied'
      if (reason === 'retired') {
        return failed('number_retired', [{
          code: 'number_retired', key: targetKey, detail: `编号 ${proposed} 已被墓碑占位（永不复用）`,
        }])
      }
      if (reason) {
        const reallocated = nextFreeNumber(nextRuleNumber(occupiedNumbers))
        if (!reallocated.ok) {
          return failed(reallocated.code, [{
            code: reallocated.code,
            key: targetKey,
            detail: reallocated.code === 'number_retired'
              ? `编号 ${reallocated.number} 已被墓碑占位（永不复用）`
              : '1–999 没有可用铁律编号',
          }])
        }
        numberAdjusted = { from: Number.isInteger(proposed) ? proposed : null, to: reallocated.number, reason }
        targetNumber = reallocated.number
      } else {
        targetNumber = proposed
      }
    }
  }
  // R9-20 ④：机器起草的 iron-rule，落盘 key 由仓储/plan 按最终编号盖成 iron-rule-<n>，
  // 草案里的临时 key 只用于关系判定。refine 沿用既有 key（兼容非标准文件名的历史铁律）。
  if (targetIsIron && !existingTarget && Number.isInteger(targetNumber) && targetNumber > 0) {
    targetKey = `iron-rule-${targetNumber}`
    const clash = allByKey.get(targetKey)
    if (clash) {
      return failed('target_conflict', [{
        code: 'target_conflict',
        key: targetKey,
        detail: `目标 key ${targetKey} 已被占用（status=${trimmed(clash.front.status)}），不得覆盖`,
      }])
    }
  }
  const created = existingTarget ? (trimmed(existingTarget.front.created) || dayOf(now)) : dayOf(now)
  const version = existingTarget ? Number(existingTarget.front.version || 1) + 1 : 1
  const supersedable = SUPERSEDE_RELATIONS.includes(relation) || relation === 'refine'
  const front = {
    key: targetKey,
    type: targetType,
    number: targetNumber,
    priority: trimmed(draft.priority) || 'P1',
    scope: trimmed(draft.scope) || 'global',
    role: trimmed(draft.role),
    modality: trimmed(draft.modality) || 'must',
    action: trimmed(draft.action),
    object: trimmed(draft.object),
    // 合并/冲突/改写时例外与条件必须取并集：守卫已要求旧条款留在正文里，
    // front 里若只留草案的条款，就会出现"正文有、结构化字段没有"的漂移。
    conditions: unionClauses(
      Array.isArray(draft.conditions) ? draft.conditions : [],
      supersedable ? affectedDocs.flatMap((doc) => (Array.isArray(doc.front.conditions) ? doc.front.conditions : [])) : [],
      mergedText,
    ),
    exceptions: unionClauses(
      Array.isArray(draft.exceptions) ? draft.exceptions : [],
      supersedable ? affectedDocs.flatMap((doc) => (Array.isArray(doc.front.exceptions) ? doc.front.exceptions : [])) : [],
      mergedText,
    ),
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created,
    updated: dayOf(now),
    version,
    origin: `proposal:${proposalId}`,
  }
  const targetNormalized = normalizeRuleDoc(front, mergedText)
  const targetSerialized = serializeRuleDocument(targetNormalized)
  if (!targetSerialized.ok) {
    return failed('invalid_rule', [{ code: 'invalid_rule', key: targetKey, detail: targetSerialized.error }])
  }

  // ---- 目标文件守卫：newText 对"它替换的旧规则"逐条校验 ----
  const replacedDocs = acceptedAffected
  const targetGuards = []
  const scopeTarget = scopeKeyOf(front)
  for (const doc of replacedDocs) {
    const scopeOld = scopeKeyOf(doc.front)
    if (scopeOld !== scopeTarget) {
      targetGuards.push(guardEntry('scope_changed', false, `${doc.key}: ${scopeOld} → ${scopeTarget}`))
    }
  }
  const guardArgs = {
    affected: replacedDocs,
    mergedText,
    draft: { ...draft, scope: scopeTarget },
    strict,
    acknowledgeDropped,
    relation,
  }
  const guard = guardRewrite(guardArgs)
  for (const failure of guard.failures) targetGuards.push(guardEntry(failure.code, false, `${failure.key ? `${failure.key}: ` : ''}${failure.detail}`))
  // 正文/front 一致性（架构书 §3.6）：front 的条款必须在正文里；旧规则里仍在正文的条款必须进 front。
  const mergedNorm = normalizeForGuard(mergedText)
  const consistent = checkFrontConsistency({ front, text: mergedText })
  for (const failure of consistent.failures) {
    targetGuards.push(guardEntry(failure.code, false, `${failure.field} 字段有、正文无：${failure.clause}`))
  }
  for (const field of ['conditions', 'exceptions']) {
    const frontNorm = new Set((Array.isArray(front[field]) ? front[field] : []).map((clause) => normalizeRuleText(clause)))
    for (const doc of affectedDocs) {
      for (const clause of Array.isArray(doc.front[field]) ? doc.front[field] : []) {
        if (!retainsClause(mergedNorm, clause)) continue
        if (frontNorm.has(normalizeRuleText(clause))) continue
        targetGuards.push(guardEntry('front_missing_clause', false, `${doc.key} 的 ${field} 仍在正文却未进 front：${clause}`))
      }
    }
  }

  const targetOldText = readIfExists(existingTarget?.file || join(base, `${targetKey}.md`))
  const files = [{
    key: targetKey,
    path: existingTarget?.file || join(base, `${targetKey}.md`),
    role: 'target',
    oldText: targetOldText,
    // oldBody = 磁盘上的旧**正文**（不含 front）；oldText 是整文件、给回滚还原用。
    // 审计/差异展示要的是正文，两者不能混用（R9-14）。
    oldBody: existingTarget ? textOf(existingTarget.text) : '',
    oldHash: targetOldText === null ? null : sha256(targetOldText),
    newText: targetSerialized.text,
    front: targetNormalized.front,
    text: targetNormalized.text,
    replaces: replacedDocs.map((doc) => doc.key),
    guards: targetGuards,
  }]
  const failures = targetGuards.filter((item) => !item.ok).map((item) => ({
    code: item.code, key: targetKey, detail: item.detail,
  }))
  if (failures.length) return failed('rule_guard_failed', failures)

  // ---- 受影响旧文件：只有正文真被改写才进 files；状态/链指针变化也随文件写 ----
  const affected = []
  for (const doc of acceptedAffected) {
    if (doc.key === targetKey) continue
    const rewrite = rewrites.get(doc.key)
    const changedBody = rewrite !== undefined && rewrite !== textOf(doc.text)
    const nextFront = {
      ...doc.front,
      updated: dayOf(now),
      version: Number(doc.front.version || 1) + 1,
    }
    if (SUPERSEDE_RELATIONS.includes(relation)) {
      nextFront.status = 'superseded'
      if (relation === 'merge') nextFront.merged_into = targetKey
      else nextFront.superseded_by = targetKey
    }
    const nextBody = changedBody ? rewrite : textOf(doc.text)
    const guards = []
    if (changedBody) {
      // 面板/LLM 给的 affected[].new_text 也过同一把守卫：不许靠改写受影响规则绕过例外/条件/模态。
      const ownGuard = guardRewrite({
        affected: [{ front: doc.front, text: doc.text }],
        mergedText: nextBody,
        draft: { scope: trimmed(doc.front.scope), type: trimmed(doc.front.type), modality: trimmed(doc.front.modality) },
        strict,
        acknowledgeDropped,
      })
      for (const failure of ownGuard.failures) guards.push(guardEntry(failure.code, false, failure.detail))
      const own = checkFrontConsistency({ front: nextFront, text: nextBody })
      for (const failure of own.failures) {
        guards.push(guardEntry(failure.code, false, `${failure.field} 字段有、正文无：${failure.clause}`))
      }
    }
    const nextNormalized = normalizeRuleDoc(nextFront, nextBody)
    const nextSerialized = serializeRuleDocument(nextNormalized)
    if (!nextSerialized.ok) {
      guards.push(guardEntry('invalid_rule', false, nextSerialized.error))
    }
    const nextFailures = guards.filter((item) => !item.ok)
    if (nextFailures.length) {
      return failed('rule_guard_failed', nextFailures.map((item) => ({
        code: item.code, key: doc.key, detail: item.detail,
      })))
    }
    const oldText = readIfExists(doc.file)
    affected.push({
      key: doc.key,
      oldText: textOf(doc.text),
      oldHash: oldText === null ? null : sha256(oldText),
      newText: nextBody,
      status: trimmed(nextFront.status),
    })
    // 正文没变时只有 status/链指针/version 变：也必须落盘，否则旧规则不会被标 superseded。
    if (doc.file) {
      files.push({
        key: doc.key,
        path: doc.file,
        role: 'affected',
        oldText,
        oldHash: oldText === null ? null : sha256(oldText),
        newText: nextSerialized.text,
        front: nextNormalized.front,
        text: nextNormalized.text,
        replaces: changedBody ? [doc.key] : [],
        guards,
      })
    }
  }

  const commitMessage = `rule: apply ${proposalId} ${targetKey} (#${targetNumber ?? '-'})`
  const plan = {
    proposalId,
    relation,
    duplicate: false,
    target: {
      key: targetKey,
      type: targetNormalized.front.type,
      number: targetNormalized.front.number,
      version: targetNormalized.front.version,
      created: targetNormalized.front.created,
      front: targetNormalized.front,
      text: targetNormalized.text,
    },
    files,
    affected,
    commitMessage,
    ...(numberAdjusted ? { numberAdjusted } : {}),
    planHash: '',
  }
  plan.planHash = hashPlanOf(plan)
  return { ok: true, plan }
}

/** @param {number} number @returns {boolean} 保留空号（6 永不复用）。 */
function reservedNumber(number) {
  return RESERVED_NUMBERS.includes(Number(number))
}

/** guardStrict 读法：布尔/字符串两种配置都要吃（与 rule-proposal 同口径）。 */
function cfgBoolGuard(config) {
  const raw = cfgValue(config?.rules?.guardStrict, true)
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
  return Boolean(raw)
}


