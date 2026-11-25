// 职责：候选生成（检测/编译/关系/候选 JSON）；依赖：../../shared/config-values.js + ../rules.js + ../rule-reconcile.js + ../rule-store.js + ../rule-render.js + ./store.js；不 import 门面。
import { join } from 'node:path'
import { bool, num } from '../../shared/config-values.js'
import { detectSignals } from '../rules.js'
import { classifyRelation, compileStructured } from '../rule-reconcile.js'
import { listRules, nextRuleNumber, occupancy, readTombstones } from '../rule-store.js'
import { titleOfRule } from '../rule-render.js'
import {
  textOf, trimmed, isoNow, PROPOSAL_ID_RE, proposalHashOf, resolveRuleRoot,
  listProposals, enforceProposalCap, writeProposalFile, mkdirIfNeeded, isCooling,
  REWRITE_RELATIONS,
} from './store.js'

// ---------------------------------------------------------------------------
// 候选生成
// ---------------------------------------------------------------------------

/** 候选摘要（面板/聊天提示共用；不塞正文，避免把候选读成规则本体）。 */
function summaryOf(draft, relation) {
  const label = trimmed(draft?.type) === 'iron-rule' ? `铁律${draft.number}` : trimmed(draft?.key)
  // 优先用结构化编译出的短标题（“删源文件”），退化才用渲染层启发式。
  const title = textOf(draft?.title) || titleOfRule({ action: draft?.action, number: draft?.number }, draft?.text)
  return { label, title, relation }
}

/** 快照受影响旧规则（apply 时若文件已变，以磁盘为准；这份是兜底证据）。 */
function snapshotAffected(rules, targets) {
  const byKey = new Map(rules.map((doc) => [textOf(doc.front?.key), doc]))
  const out = []
  for (const target of targets) {
    const doc = byKey.get(target.key)
    if (!doc) continue
    out.push({
      key: textOf(doc.front.key),
      number: Number(doc.front.number),
      file: doc.file,
      front: { ...doc.front },
      text: textOf(doc.text),
      reason: textOf(target.reason),
    })
  }
  return out
}

/**
 * 生成候选（架构书 §4.1）。
 *
 * @param {{text:string, source?:string, identity?:object, traceId?:string, sessionId?:string,
 *   rulesDir?:string, config?:any, log?:Function, now?:number}} args
 * @returns {{ok:true, proposal:object, cooling:boolean, existing?:boolean} | {ok:false, code:string}}
 *   code: rules_disabled|privacy|preference|descriptive|not_rule|<compile 错误码>
 */
export function createProposal({
  text, source = 'owner', identity = {}, traceId = '', sessionId = '',
  rulesDir, config = {}, log = () => {}, now = Date.now(),
} = {}) {
  const raw = trimmed(text)
  if (!bool(config?.rules?.enabled, true)) return { ok: false, code: 'rules_disabled' }
  if (!raw) return { ok: false, code: 'empty' }

  const base = resolveRuleRoot(rulesDir, config)
  const ident = identity && typeof identity === 'object' ? identity : {}
  const signals = detectSignals(raw, { source, workspace: trimmed(ident.workspace) })
  if (signals.rejectReason) return { ok: false, code: signals.rejectReason }
  if (!signals.ruleLike) return { ok: false, code: 'not_rule' }

  const listed = listRules(base)
  // 只与 active 正式规则比对：superseded/retired 已经失效，候选里的 `rule-candidate` 不是同层级。
  const activeRules = listed.rules.filter((doc) => textOf(doc.front.status) === 'active'
    && textOf(doc.front.type) !== 'rule-candidate')
  // 编号口径必须与 manifest/create/health 同源：用全量规则（含 inactive/候选外的历史文件）
  // ＋文件名＋墓碑算 nextNumber；关系判定仍只看 activeRules。
  // （非 `iron-rule-<n>.md` 文件名的 inactive 铁律，只能靠全量 rules 的 front 号占位。）
  // R9-20：提案期取号与 plan/create/health 同口径——occupancy() 是唯一入口
  // （文件名编号 ∪ 解析成功 front 编号 ∪ 墓碑）；manifest.retired 不再参与取号。
  const occupiedNumbers = occupancy(base, { listed })
  const nextNumber = nextRuleNumber(occupiedNumbers)

  const compiled = compileStructured(raw, signals, {
    existingRules: activeRules,
    nextNumber,
    occupancy: occupiedNumbers,
    source,
    workspace: trimmed(ident.workspace),
    // role 必须进草案：候选 hash 含 role（架构书 §3.2），否则跨角色会共用命中去重/冷却。
    role: trimmed(ident.roleId),
  })
  if (!compiled.ok) return { ok: false, code: compiled.error, detail: compiled.detail }
  const draft = compiled.draft
  const relation = classifyRelation(draft, activeRules)
  // R9-19 ④：候选创建前先查 key 全仓唯一（跨 scope 也不得同名）与编号占用。
  // 注定 target_conflict/number_conflict/number_retired 的候选不创建（也不追加提示行），
  // 否则用户看到的"待确认"到了 apply 才失败（假承诺）。同 scope 同 key 走 refine 语义。
  const allByKey = new Map(listed.rules.map((doc) => [trimmed(doc.front.key), doc]))
  const sameKeyDoc = allByKey.get(draft.key)
  if (sameKeyDoc && relation.relation !== 'refine') {
    return {
      ok: false,
      code: 'target_conflict',
      detail: {
        key: draft.key,
        scope: trimmed(sameKeyDoc.front.scope),
        status: trimmed(sameKeyDoc.front.status),
        reason: 'key_exists_outside_refine',
      },
    }
  }
  if (draft.type === 'iron-rule' && Number.isInteger(Number(draft.number)) && Number(draft.number) > 0) {
    const number = Number(draft.number)
    const refineDoc = relation.relation === 'refine' ? sameKeyDoc : null
    const ownsNumber = Boolean(refineDoc) && Number(refineDoc.front.number) === number
    if (!ownsNumber) {
      if (readTombstones(base).some((item) => Number(item.number) === number)) {
        return { ok: false, code: 'number_retired', detail: { number, key: draft.key } }
      }
      if (occupiedNumbers.has(number)) {
        return { ok: false, code: 'number_conflict', detail: { number, key: draft.key } }
      }
    }
  }
  const affected = snapshotAffected(activeRules, relation.targets)

  const hash = proposalHashOf(raw, draft)
  const hash8 = hash.slice(0, 8)
  const dir = join(base, 'proposals')
  const cooling = isCooling(dir, hash, num(config?.rules?.askCooldownDays, 30), now)

  const existing = listProposals({ rulesDir: base, config, status: 'pending,needs_manual' }).proposals
    .find((item) => textOf(item.hash) === hash)
  if (existing) {
    // 同 hash 只留一条候选（架构书 §4.1）：重复命中只累加计数，不新建文件。
    const bumped = {
      ...existing,
      hits: Number(existing.hits || 1) + 1,
      updated: isoNow(now),
      // 冷却态按当前时间重算：冷却期过的候选要能重新被问，不能被旧标记永久冻住。
      cooling,
    }
    writeProposalFile(existing.file || join(dir, `${existing.id}.json`), bumped)
    return { ok: true, proposal: bumped, cooling: Boolean(bumped.cooling), existing: true }
  }

  const id = `p${now}_${hash8}`
  if (!PROPOSAL_ID_RE.test(id)) return { ok: false, code: 'invalid_id' }
  const proposal = {
    id,
    status: 'pending',
    hash,
    hash8,
    created: isoNow(now),
    updated: isoNow(now),
    hits: 1,
    source: trimmed(source) || 'owner',
    sessionId: trimmed(sessionId),
    traceId: trimmed(traceId),
    identity: {
      userId: trimmed(ident.userId),
      roleId: trimmed(ident.roleId),
      workspace: trimmed(ident.workspace),
    },
    text: raw,
    draft,
    relation,
    affected,
    affectedKeys: affected.map((item) => item.key),
    needsRewrite: REWRITE_RELATIONS.includes(relation.relation),
    cooling,
    summary: summaryOf(draft, relation.relation),
    // 语义提炼状态：默认规则路径已在编译期完成；rules.llm=true 时候选创建后后台再润色一次。
    refine: {
      state: bool(config?.rules?.llm, false) ? 'pending' : 'rule',
      by: 'rule',
      at: isoNow(now),
    },
    applied: null,
    needsManual: null,
  }

  try {
    mkdirIfNeeded(dir)
  } catch (err) {
    return { ok: false, code: 'dir_failed', detail: String(err?.message || err) }
  }
  const written = writeProposalFile(join(dir, `${id}.json`), proposal)
  if (!written.ok) return { ok: false, code: 'write_failed', detail: written.error }

  const expired = enforceProposalCap({ rulesDir: base, config, now, log })
  return { ok: true, proposal, cooling, ...(expired.length ? { expired } : {}) }
}
