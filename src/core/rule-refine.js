/**
 * 候选语义提炼（R9-22）：把候选正文从“带模板的散文”收敛成一条可执行规则。
 *
 * 默认路径是**确定性**的：`compileStructured` 已经抽出 action/object/条件/例外并生成短正文，
 * 本模块的 `rule` 路径只负责把这条正文作为候选的规范文本（不额外调模型、不花钱）。
 * 可选路径是**模型润色**：仅当 `rules.llm=true` 且宿主给了 llm/selection 时，在候选创建后
 * 后台跑一次；模型只允许改措辞、补标题/条件/例外，不得改 key/number/scope，不得新增事实；
 * 输出必须过与写入闸同口径的校验，失败则保留确定性稿并记 `refine.state='failed'`。
 *
 * 边界：只读写候选 JSON（`proposals/<id>.json`），不碰规则文件、不 commit、不镜像/摘要；
 * 原始来源（`proposal.text`）永不改写——面板「来源片段」必须始终是用户原话。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectSignals } from './rules.js'
import { classifyRelation, normalizeForGuard, retainsClause } from './rule-reconcile.js'
import { callLlmMerge, proposalsDirOf, readProposal, resolveRuleRoot } from './rule-proposal.js'
import { RULE_BODY_MAX, atomicWriteFile, listRules, validateRule } from './rule-store.js'

/** @param {any} value @returns {string} */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {any} value @returns {string} */
function trimmed(value) {
  return textOf(value).trim()
}

/** @param {string} text @returns {number} */
function charsOf(text) {
  return Array.from(textOf(text)).length
}

/**
 * 构造提炼 prompt：原文与既有同 scope 规则都用分隔符包住，防正文里的指令污染。
 * @param {{source:string, draft:object, rules:Array<object>}} args
 * @returns {{system:string, user:string}}
 */
export function buildRefinePrompt({ source, draft, rules = [] }) {
  const existing = rules.slice(0, 12).map((doc) => `- ${textOf(doc.front?.key)}：${textOf(doc.text)}`)
  const system = [
    '你是规则编译器。把用户原话改写成一条可执行、可机检的中文规则。',
    '只输出 JSON 对象，字段：text（正文，1–500 码点，单条祈使/约束句）、conditions（字符串数组）、exceptions（字符串数组）、summary（≤120 字单行标题）。',
    '硬约束：不得改变原意；不得新增原文没有的事实、路径、阈值；保留全部显式条件与例外；不写理由句、不写链接、不写“以后/记住/请你”等口语前缀；不写作用域后缀。',
    'text 必须能独立读懂：以 必须/禁止/只能/不得/先…再… 等可执行形态开头或包含明确约束。',
    '既有规则只用于避免重复措辞，不得合并/删除它们。',
  ].join('\n')
  const user = [
    '<<<原文>>>',
    source,
    '<<<原文结束>>>',
    '<<<确定性草稿>>>',
    textOf(draft?.text),
    '<<<草稿结束>>>',
    existing.length ? `<<<同作用域既有规则>>>\n${existing.join('\n')}\n<<<结束>>>` : '',
  ].filter(Boolean).join('\n')
  return { system, user }
}

/** 从模型回包里取 JSON（容忍 ```json 围栏与前后闲话）。 @param {string} raw @returns {object|null} */
export function parseRefineReply(raw) {
  const text = textOf(raw).trim()
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const item of candidates) {
    if (!item) continue
    try {
      const parsed = JSON.parse(item.trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 继续试下一个 */ }
  }
  // 最后尝试截取第一个 { 到最后一个 }
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const parsed = JSON.parse(text.slice(a, b + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 不可解析 */ }
  }
  return null
}

/**
 * 校验模型提炼稿：正文形态/长度/隐私/模糊词走仓储同一个 validateRule；条件/例外必须仍在正文里。
 * key/number/scope/type 以候选草案为准，模型给什么都不采纳。
 * @param {object} proposal @param {object} parsed
 * @returns {{ok:true, patch:object}|{ok:false, code:string, detail?:any}}
 */
export function validateRefine(proposal, parsed, { root = '' } = {}) {
  const draft = proposal?.draft && typeof proposal.draft === 'object' ? proposal.draft : null
  if (!draft) return { ok: false, code: 'proposal_corrupt' }
  const text = trimmed(parsed?.text)
  if (!text) return { ok: false, code: 'refine_empty' }
  if (charsOf(text) > RULE_BODY_MAX) return { ok: false, code: 'refine_too_long' }
  const conditions = Array.isArray(parsed?.conditions)
    ? parsed.conditions.map((item) => trimmed(item)).filter(Boolean) : draft.conditions || []
  const exceptions = Array.isArray(parsed?.exceptions)
    ? parsed.exceptions.map((item) => trimmed(item)).filter(Boolean) : draft.exceptions || []
  const norm = normalizeForGuard(text)
  for (const clause of [...conditions, ...exceptions]) {
    if (!retainsClause(norm, clause)) return { ok: false, code: 'refine_clause_missing', detail: { clause } }
  }
  // validateRule 吃的是完整 front（不是候选 draft）：这里补齐生命周期字段，key/number/scope
  // 仍取候选，模型给的任何身份字段都不采纳。
  const day = new Date().toISOString().slice(0, 10)
  const front = {
    key: textOf(draft.key),
    type: textOf(draft.type),
    // 与 normalizeRuleDoc 同口径：编号只属于 iron-rule 且必须正整数；Number(null)===0
    // 会被 validateRule 判成 number_not_allowed/invalid_number，让普通候选的润色恒失败。
    number: textOf(draft.type) === 'iron-rule' && Number.isInteger(Number(draft.number)) && Number(draft.number) > 0
      ? Number(draft.number) : null,
    priority: textOf(draft.priority) || 'P1',
    scope: textOf(draft.scope) || 'global',
    role: textOf(draft.role),
    modality: textOf(draft.modality) || 'must',
    action: textOf(draft.action),
    object: textOf(draft.object),
    conditions,
    exceptions,
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: day,
    updated: day,
    version: 1,
    origin: 'proposal:refine',
    ...(trimmed(parsed?.summary) ? { summary: trimmed(parsed.summary).slice(0, 120) } : {}),
  }
  const check = validateRule(front, text, { numbers: new Map() })
  if (!check.ok) return { ok: false, code: 'refine_invalid', detail: check.errors }
  // 指令形态：规则正文必须可执行；模型输出纯描述句一律拒绝。
  if (!detectSignals(text).imperative) return { ok: false, code: 'refine_not_imperative' }
  // 语义关系不得被润色改掉：润色稿若让“new”变成 duplicate/merge/conflict/refine，
  // 说明模型改动了语义；丢弃润色稿，保留确定性稿（避免绕过创建期的去重/冲突判定）。
  const active = listRules(root).rules.filter((doc) => trimmed(doc.front.status) === 'active'
    && trimmed(doc.front.type) !== 'rule-candidate')
  const relation = classifyRelation({ ...draft, text, conditions, exceptions }, active)
  if (trimmed(proposal.relation?.relation) !== trimmed(relation.relation)
    && relation.relation !== 'unrelated') {
    return { ok: false, code: 'refine_relation_changed', detail: { from: proposal.relation?.relation, to: relation.relation } }
  }
  return {
    ok: true,
    patch: {
      text,
      conditions,
      exceptions,
      title: trimmed(parsed?.title).slice(0, 80) || trimmed(parsed?.summary).slice(0, 80) || draft.title || '',
      summary: trimmed(parsed?.summary).slice(0, 120),
    },
  }
}

/**
 * 失败留痕：把 refine.state 写成 failed（不覆盖已裁定候选；CAS 只写 updated 未变的 pending）。
 * @returns {Promise<{ok:false,state:string,code:string,proposal?:object}>}
 */
async function markRefineFailure({ proposal, rulesDir, config, code, detail, now, log }) {
  try {
    const fresh = readProposal({ rulesDir, config, id: proposal.id })
    if (!fresh.ok
      || !['pending', 'needs_manual'].includes(trimmed(fresh.proposal.status))
      || trimmed(fresh.proposal.updated) !== trimmed(proposal.updated)) {
      return { ok: false, state: 'skipped', code, proposal: fresh.ok ? fresh.proposal : proposal }
    }
    const next = {
      ...fresh.proposal,
      refine: {
        state: 'failed', by: 'llm', code: textOf(code),
        ...(detail ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300) } : {}),
        at: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
      },
      updated: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
    }
    const written = atomicWriteFile(fresh.proposal.file || join(proposalsDirOf(rulesDir, config), `${fresh.proposal.id}.json`), `${JSON.stringify(next, null, 2)}\n`)
    if (!written.ok) log?.(`[whale-memory] rules refine failure mark failed id=${proposal.id} code=write_failed`)
    return { ok: false, state: 'failed', code, proposal: next }
  } catch {
    return { ok: false, state: 'failed', code }
  }
}

/**
 * 提炼一个候选：读候选 → 调模型 → 校验 → 只更新候选 JSON 的措辞字段；原文永不改。
 *
 * @param {{id:string, rulesDir?:string, config?:any, getLlm?:Function,
 *   getSelection?:Function, log?:Function, now?:number}} args
 * @returns {Promise<{ok:boolean, state:string, code?:string, proposal?:object}>}
 */
export async function refineProposal({
  id, rulesDir, config = {}, getLlm = () => null, getSelection = () => null,
  log = () => {}, now = Date.now(),
} = {}) {
  const got = readProposal({ rulesDir, config, id })
  if (!got.ok) return { ok: false, state: 'failed', code: 'proposal_not_found' }
  const proposal = got.proposal
  if (!['pending', 'needs_manual'].includes(trimmed(proposal.status))) {
    return { ok: false, state: 'skipped', code: 'proposal_not_pending', proposal }
  }
  const llm = typeof getLlm === 'function' ? getLlm() : null
  if (!llm) return markRefineFailure({ proposal, rulesDir, config, code: 'llm_unavailable', now, log })
  let selection = null
  try { selection = typeof getSelection === 'function' ? getSelection() : null } catch { selection = null }
  const root = resolveRuleRoot(rulesDir, config)
  const sameScopeRules = listRules(root)
    .rules.filter((doc) => textOf(doc.front?.scope) === textOf(proposal.draft?.scope)
      && textOf(doc.front?.status) === 'active')
  const prompt = buildRefinePrompt({ source: proposal.text, draft: proposal.draft, rules: sameScopeRules })
  const out = await callLlmMerge({ llm, prompt, selection, log })
  if (!out.ok) {
    return markRefineFailure({ proposal, rulesDir, config, code: out.error, now, log })
  }
  const parsed = parseRefineReply(out.text)
  if (!parsed) return markRefineFailure({ proposal, rulesDir, config, code: 'refine_unparseable', now, log })
  // CAS：模型调用期间用户可能已收录/拒绝/改写；状态或更新时间变了就放弃写入，
  // 否则会把 accepted 的候选覆盖回 pending（两套事实）。
  const fresh = readProposal({ rulesDir, config, id })
  if (!fresh.ok
    || !['pending', 'needs_manual'].includes(trimmed(fresh.proposal.status))
    || trimmed(fresh.proposal.updated) !== trimmed(proposal.updated)) {
    return { ok: false, state: 'skipped', code: 'proposal_changed', proposal: fresh.ok ? fresh.proposal : proposal }
  }
  const checked = validateRefine(proposal, parsed, { root })
  if (!checked.ok) return markRefineFailure({ proposal, rulesDir, config, code: checked.code, detail: checked.detail, now, log })
  const patch = checked.patch
  const next = {
    ...proposal,
    draft: {
      ...proposal.draft,
      text: patch.text,
      chars: charsOf(patch.text),
      conditions: patch.conditions,
      exceptions: patch.exceptions,
      title: patch.title || proposal.draft.title,
    },
    summary: {
      ...(proposal.summary || {}),
      label: proposal.summary?.label || proposal.draft?.key,
      title: patch.title || proposal.summary?.title || '',
    },
    refine: {
      state: 'ready',
      by: 'llm',
      at: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
      model: trimmed(selection?.model),
    },
    updated: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString(),
  }
  const file = proposal.file || join(proposalsDirOf(rulesDir, config), `${proposal.id}.json`)
  try {
    const body = `${JSON.stringify(next, null, 2)}\n`
    // 候选是草稿目录内的本机文件：原子写即可（不进 git），不抢规则仓锁。
    const written = atomicWriteFile(file, body)
    if (!written.ok) return { ok: false, state: 'failed', code: 'write_failed', detail: written.error, proposal }
  } catch (err) {
    return { ok: false, state: 'failed', code: 'write_failed', detail: String(err?.message || err), proposal }
  }
  log(`[whale-memory] rules proposal refined id=${proposal.id} chars=${charsOf(patch.text)} model=${trimmed(selection?.model) || '-'}`)
  return { ok: true, state: 'ready', proposal: next }
}
