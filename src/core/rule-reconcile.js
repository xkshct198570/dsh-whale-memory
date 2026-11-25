/**
 * 规则提案的「关系判定 + 改写守卫 + 合并提示词」门面（R3b，纯函数、零 I/O）。
 *
 * compile 底座（文本工具/抽取/结构化编译）已拆到 `rule-reconcile/compile.js`；
 * 本文件保留 relation / guards / merge-prompt 三段，待 P3b2/P3b3 继续拆分。
 *
 * 边界：
 * - 只 import `./rules.js`、`./rule-store.js` 的纯常量函数与 `./rule-reconcile/compile.js`；
 *   不读写文件、不调模型、不碰 DB；LLM 调用在 rule-proposal.js。
 * - 关系判定与守卫是"规则能不能自动落盘"的唯一判据，必须能脱宿主/脱文件单测。
 */
import { dedupeKey, detectSignals, normalizeRuleText, similarity } from './rules.js'
import { RULE_BODY_MAX } from './rule-store.js'
import {
  VERB_FAMILIES, extractExplicitRef, domainOfText, extractExceptions,
  extractConditionPhrases, modalityOf, splitConditions, verbFamilyOf,
  extractSlots, titleOfRuleDraft, mainClauseIntact, compileStructured,
  textOf, trimmed, chars, normalizeDoc, verbsIn, VAGUE_RE,
} from './rule-reconcile/compile.js'

// compile 的公开符号原样再导出：门面路径与导出名保持不变，调用方无需改动。
export {
  VERB_FAMILIES, extractExplicitRef, domainOfText, extractExceptions,
  extractConditionPhrases, modalityOf, splitConditions, verbFamilyOf,
  extractSlots, titleOfRuleDraft, mainClauseIntact, compileStructured,
}

/** 重复阈值（架构书 §4.3）：归一化正文相似度 ≥0.9 视为同一条规则。 */
export const DUPLICATE_SIMILARITY = 0.9

/** 槽位（对象核心词）重叠阈值：低于它视为不同对象，不判冲突/合并。 */
export const SLOT_OVERLAP_MIN = 0.3

/** 对冲词（弱化模态的判据；比 VAGUE_RE 窄：不含「可能/也许」这类纯推测）。 */
const HEDGE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|方便的时候|maybe|probably|try to|if possible)/i

/** 互斥动词族对：同对象 + 相同模态也会冲突（「报告默认删除」vs「报告默认保留」）。 */
export const OPPOSITE_FAMILIES = Object.freeze([
  Object.freeze(['delete', 'keep']),
  Object.freeze(['enable', 'disable']),
  Object.freeze(['allow', 'forbid']),
  Object.freeze(['delete', 'archive']),
])

/**
 * 同义表（守卫的"例外未丢"判定用）：只收**语义等价**的词，不收近义/上下位，
 * 否则守卫会放行真正的丢失。每组内任意成员可互相替换。
 */
export const SYNONYM_GROUPS = Object.freeze([
  Object.freeze(['禁止', '不得', '不许', '不准', '严禁', '不要']),
  Object.freeze(['必须', '务必', '一律', '始终', '必须都']),
  Object.freeze(['删除', '删掉', '删']),
  Object.freeze(['文件', '文档']),
  Object.freeze(['保留', '留下', '留着']),
  Object.freeze(['备份', '存档']),
  Object.freeze(['例外', '除外', '除非']),
  Object.freeze(['只能', '只允许', '仅能', '仅允许']),
  Object.freeze(['本地', '本机']),
  Object.freeze(['提交', 'commit']),
  Object.freeze(['测试', '回归']),
  Object.freeze(['报告', '过程稿', '中间产物']),
])

/** 模态词表：守卫据此判断"模态被弱化"（never→尽量、must→建议 一律算弱化）。 */
export const MODALITY_WORDS = Object.freeze({
  must: /(必须|务必|一律|始终|每次都要|都要|每次|must|always|shall|required)/i,
  // 「别」是单字模态词，必须挡掉「区别/特别/个别/分别/类别/性别/级别」这类词内出现：
  // 否则一条只说「区别对待」的规则会被判成 must_not，进而与「必须」误判反转（R8-03 口径）。
  must_not: /(禁止|不得|不许|不准|不要|(?<![区特个分类型级性离别])别|严禁|never|must not|forbidden|do not)/i,
  only: /(只能|只允许|仅能|仅允许|\bonly\b)/i,
  except: /(除了|除[^。；;\n]{1,30}以外|除外|except)/i,
})

/** 反向模态（架构书 §4.3 冲突判定）：must↔must_not、only↔except。 */
export const REVERSE_MODALITY = Object.freeze({ must: 'must_not', must_not: 'must', only: 'except', except: 'only' })

// ---------------------------------------------------------------------------
// 关系判定：动词族 + 对象核心词
// ---------------------------------------------------------------------------

/** @param {any} doc @returns {{key:string,number:number|null,text:string,front:object}} */
function relationTarget(doc) {
  const { front, text } = normalizeDoc(doc)
  return {
    key: trimmed(front.key),
    number: Number.isInteger(Number(front.number)) && Number(front.number) > 0 ? Number(front.number) : null,
    text: textOf(text),
    front,
  }
}

/**
 * 对象核心词集：ASCII 词 + 中文 bigram（与 similarity 同一套 token 口径，
 * 但只看对象，避免整句里的域词/模板词污染槽位）。
 * @param {string} text @returns {Set<string>}
 */
export function objectWords(text) {
  const s = textOf(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
  const set = new Set()
  for (const word of s.match(/[a-z0-9_]+/g) || []) set.add(word)
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) set.add(run)
    for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2))
  }
  return set
}

/** 两个词集的 Jaccard（空集 → 0，不把「没有对象」当同槽位）。 */
function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 两个词集是否有交集（判"共享动作"用）。 */
function intersects(a, b) {
  if (!a.size || !b.size) return false
  for (const token of a) if (b.has(token)) return true
  return false
}

/** 动作词集（含条件从句里的动词，便于识别「删除前/删除后」这类同一事件）。 */
function verbSetOf(docText, conditions) {
  const set = new Set()
  for (const hit of verbsIn(textOf(docText))) set.add(hit.verb)
  for (const clause of Array.isArray(conditions) ? conditions : []) {
    for (const hit of verbsIn(clause)) set.add(hit.verb)
  }
  return set
}

/** 动词族集合。 */
function familySetOf(verbs) {
  const set = new Set()
  for (const verb of verbs) set.add(verbFamilyOf(verb))
  return set
}

/** 是否互斥动词族对。 */
function familiesOpposite(a, b) {
  for (const [left, right] of OPPOSITE_FAMILIES) {
    if ((a.has(left) && b.has(right)) || (a.has(right) && b.has(left))) return true
  }
  return false
}

/**
 * 模态是否互斥（架构书 §3.3）：严格按反转表 must↔must_not、only↔except。
 *
 * Why 不再把 `only` 与任何非 only 都当反转：`only` vs `must` 是**收窄**不是反转，
 * 应走 merge/refine；v3.7 把它判冲突会让「只用本地模型」永远打不掉「必须用模型」。
 */
function modalityReversed(a, b) {
  if (a === b) return false
  return REVERSE_MODALITY[a] === b
}

/** 条件/例外"互补"：任一方为空，或两方没有重叠条目（重叠=同一条件重复，不是补充）。 */
function complementary(a, b) {
  const left = [...a.conditions, ...a.exceptions].map(normalizeRuleText).filter(Boolean)
  const right = [...b.conditions, ...b.exceptions].map(normalizeRuleText).filter(Boolean)
  if (!left.length || !right.length) return true
  for (const l of left) if (right.some((r) => r === l || r.includes(l) || l.includes(r))) return false
  return true
}

/** @typedef {{key:string,number:number|null,text:string,object:string,modality:string,
 *   conditions:string[],exceptions:Array<any>,family:Set<string>,verbs:Set<string>}} SlotView */

/** @param {{front:object,text:string}} doc @returns {SlotView} */
function slotViewOf(doc) {
  const front = doc.front || {}
  const actions = new Set()
  const action = trimmed(front.action)
  // 有结构化 action 就只信它：正文/条件里的动词（「删除前/删除后」）是条件事件，
  // 把它们当动作族会把「删除前要提炼」和「删除后要留审计」误判成互斥冲突。
  if (action) actions.add(action)
  else for (const hit of verbsIn(textOf(doc.text))) actions.add(hit.verb)
  return {
    key: trimmed(front.key),
    number: Number.isInteger(Number(front.number)) && Number(front.number) > 0 ? Number(front.number) : null,
    text: textOf(doc.text),
    object: trimmed(front.object),
    modality: trimmed(front.modality) || 'must',
    conditions: Array.isArray(front.conditions) ? front.conditions : [],
    exceptions: Array.isArray(front.exceptions) ? front.exceptions : [],
    family: familySetOf(actions),
    verbs: verbSetOf(doc.text, front.conditions),
  }
}

/** @param {object} draft @returns {SlotView} */
function draftViewOf(draft) {
  const actions = new Set()
  const action = trimmed(draft.action)
  if (action) actions.add(action)
  return {
    key: trimmed(draft.key),
    number: Number.isInteger(Number(draft.number)) && Number(draft.number) > 0 ? Number(draft.number) : null,
    text: textOf(draft.text),
    object: trimmed(draft.object),
    modality: trimmed(draft.modality) || 'must',
    conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
    exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
    family: familySetOf(actions),
    verbs: verbSetOf(draft.text, draft.conditions),
  }
}

/** 槽位重叠：对象核心词 Jaccard ≥ 0.3；对象缺失时退化为"共享动作族/动作词"。 */
function slotOverlap(draft, rule) {
  const objJ = jaccardOf(objectWords(draft.object), objectWords(rule.object))
  if (objJ >= SLOT_OVERLAP_MIN) return { overlap: true, kind: 'object', jaccard: objJ }
  // 条件引用同一事件动作（删除前/删除后）：同一槽位事件，允许合并/冲突判定。
  const draftCondVerbs = verbSetOf('', draft.conditions)
  const ruleCondVerbs = verbSetOf('', rule.conditions)
  if (intersects(draftCondVerbs, ruleCondVerbs)) {
    return { overlap: true, kind: 'shared_event', jaccard: objJ }
  }
  if (!draft.object || !rule.object) {
    const shareFamily = intersects(draft.family, rule.family)
    const shareVerb = intersects(draft.verbs, rule.verbs)
    if (shareFamily || shareVerb) return { overlap: true, kind: 'verb_only', jaccard: objJ }
  }
  return { overlap: false, kind: 'none', jaccard: objJ }
}

/**
 * 作用域归一（架构书 §3.3）：`global` / `workspace:<绝对路径>` / `role:<id>` **精确**比较。
 *
 * 只做纯字符串归一（分隔符统一 + 去尾斜杠），不 realpath：本模块是纯函数，不碰文件系统；
 * 路径真实化由 host 层在传入前完成。缺省 scope 视为 `global`（与 rule-store 归一化一致）。
 * @param {any} value 扁平 front、`{front,text}` 文档或草案
 * @returns {string}
 */
export function scopeKeyOf(value) {
  const front = value && typeof value === 'object'
    ? (value.front && typeof value.front === 'object' ? value.front : value)
    : {}
  const raw = trimmed(front.scope) || 'global'
  if (raw.startsWith('workspace:')) {
    const path = raw.slice('workspace:'.length).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    return `workspace:${path}`
  }
  if (raw.startsWith('role:')) return `role:${raw.slice('role:'.length).trim()}`
  return raw
}

/**
 * 角色闸：两侧 role 都非空且不同 → 不同作用域（role A↔B 不得 merge/conflict）。
 *
 * 允许一侧为空：历史规则 role 为空表示"不绑定角色"（默认铁律/导入件都是空 role），
 * 否则聊天候选（带会话 role）会永远配不上任何既有规则，跨角色提示会淹没真关系。
 * @param {{role?:string}} a @param {{role?:string}} b @returns {boolean}
 */
function rolesCompatible(a, b) {
  const left = trimmed(a?.role)
  const right = trimmed(b?.role)
  if (!left || !right) return true
  return left === right
}

/**
 * 关系判定（架构书 §3.3）：先规则、后模型；本函数是**唯一**确定性判据。
 *
 * 判定顺序（先到先得）：
 * 1. 同 scope + 同 key → refine（沿用旧编号）；
 * 2. 同 scope + dedupeKey 相同或正文相似度 ≥0.9 → duplicate；
 * 3. 同 scope + 槽位重叠（对象词 Jaccard≥0.3 / 共享动作 / 共享条件事件）
 *    + 模态反转（must↔must_not / only↔except）或动词族互斥 → conflict；
 * 4. 同 scope + 槽位重叠 + 模态兼容 + 条件/例外互补 + 动词族不互斥 → merge；
 * 5. 其余：有同 scope 既有规则 → 'unrelated'；没有 → 'new'（两者下游动作相同）。
 *
 * 作用域闸（R8-04）：跨 scope（global↔workspace、workspace A↔B、role A↔B）一律 unrelated，
 * 不得 supersede/merge 他区规则；跨区命中放进 `crossScope` 供面板提示（只提示不改状态）。
 *
 * @param {object} draft compileStructured 的草案
 * @param {Array<any>} [existingRules] 真实规则（`{front,text}` 或扁平 front）
 * @returns {{relation:'new'|'duplicate'|'refine'|'merge'|'conflict'|'unrelated',
 *   targets:Array<{key:string,number:number|null,text:string,reason:string}>,
 *   crossScope?:Array<{key:string,scope:string,reason:string}>}}
 */
export function classifyRelation(draft, existingRules = []) {
  const rules = (Array.isArray(existingRules) ? existingRules : []).map(relationTarget)
  const draftScope = scopeKeyOf(draft)
  const scoped = rules.filter((rule) => scopeKeyOf(rule.front) === draftScope && rolesCompatible(draft, rule.front))
  const crossScope = rules
    .filter((rule) => scopeKeyOf(rule.front) !== draftScope)
    .map((rule) => ({ key: rule.key, scope: scopeKeyOf(rule.front), reason: 'cross_scope' }))
  const empty = {
    relation: scoped.length ? 'unrelated' : 'new',
    targets: [],
    ...(crossScope.length ? { crossScope } : {}),
  }
  if (!draft || !textOf(draft.text).trim()) return empty
  const draftKey = trimmed(draft.key)
  const draftText = textOf(draft.text)
  const view = draftViewOf(draft)

  const refine = scoped.find((rule) => rule.key && rule.key === draftKey)
  if (refine) {
    return { relation: 'refine', targets: [{ key: refine.key, number: refine.number, text: refine.text, reason: 'same_key' }] }
  }

  const draftHash = dedupeKey(draftText)
  const duplicates = scoped.filter((rule) => rule.key !== draftKey && rule.text && (
    dedupeKey(rule.text) === draftHash || similarity(draftText, rule.text) >= DUPLICATE_SIMILARITY
  ))
  if (duplicates.length) {
    return {
      relation: 'duplicate',
      targets: duplicates.map((rule) => ({
        key: rule.key,
        number: rule.number,
        text: rule.text,
        reason: dedupeKey(rule.text) === draftHash ? 'same_dedupe_key' : 'similarity>=0.9',
      })),
    }
  }

  // 不再用"推断域相等"做前置过滤：域是从关键词猜的（「以后都先提炼再删」会被猜成 general，
  // 而「禁止删源文件」是 file-hygiene，真正的槽位冲突就被域过滤吃掉了）。
  // 槽位判定（对象词 Jaccard / 共享动作 / 共享条件事件）足够具体，域只做展示。
  const candidates = scoped.filter((rule) => rule.key !== draftKey && rule.text)

  const conflicts = []
  const merges = []
  for (const rule of candidates) {
    const other = slotViewOf(rule)
    const overlap = slotOverlap(view, other)
    if (!overlap.overlap) continue
    const reversed = modalityReversed(view.modality, other.modality)
    const opposite = familiesOpposite(view.family, other.family)
    const compatible = view.modality === other.modality
      || (!reversed && !opposite)
    if (reversed || opposite) {
      conflicts.push({ rule, reason: opposite && !reversed ? 'verb_family_flip' : 'modality_flip' })
      continue
    }
    if (compatible && complementary(
      { conditions: view.conditions, exceptions: view.exceptions },
      { conditions: other.conditions, exceptions: other.exceptions },
    )) {
      merges.push({
        rule,
        reason: overlap.kind === 'shared_event' ? 'shared_event_conditions' : 'complementary_conditions',
      })
    }
  }
  if (conflicts.length) {
    return {
      relation: 'conflict',
      targets: conflicts.map(({ rule, reason }) => ({ key: rule.key, number: rule.number, text: rule.text, reason })),
    }
  }
  if (merges.length) {
    return {
      relation: 'merge',
      targets: merges.map(({ rule, reason }) => ({ key: rule.key, number: rule.number, text: rule.text, reason })),
    }
  }
  return empty
}

// ---------------------------------------------------------------------------
// 规范化 + 同义表（守卫与测试共用）
// ---------------------------------------------------------------------------

/**
 * 守卫用的规范化：NFKC + 去空白与标点（保留字母数字），与 dedupeKey 同一口径，
 * 但**保留中文原字**（不做 bigram），子串判定才有意义。
 * @param {string} text @returns {string}
 */
export function normalizeForGuard(text) {
  return textOf(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\ufeff]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 同义变体：把文本里的同义组成员逐个替换成组内其它成员，供"例外仍在"的容错匹配。
 * 只做单次全量替换（不做指数组合）：例外通常是短句，单层替换已覆盖真实改写。
 * @param {string} text @returns {Set<string>}
 */
export function guardVariants(text) {
  const base = normalizeForGuard(text)
  const out = new Set([base])
  if (!base) return out
  for (const group of SYNONYM_GROUPS) {
    for (const member of group) {
      const norm = normalizeForGuard(member)
      if (!norm || !base.includes(norm)) continue
      for (const other of group) {
        const replacement = normalizeForGuard(other)
        if (!replacement || replacement === norm) continue
        out.add(base.split(norm).join(replacement))
      }
    }
  }
  return out
}

/** 文本是否"仍然包含"某条旧子句（含同义变体）。 */
export function retainsClause(mergedNorm, clause) {
  for (const variant of guardVariants(clause)) {
    if (variant && mergedNorm.includes(variant)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

/**
 * acknowledgeDropped 归一为 `key → Set(规范化子句)`。
 *
 * 只收 `[{key, clauses[]}]`（子句粒度）；裸字符串/布尔一律忽略（不再有 key 粒度通道）。
 *
 * @param {unknown} value @returns {Map<string, Set<string>>}
 */
function ackMapOf(value) {
  const map = new Map()
  for (const item of Array.isArray(value) ? value : []) {
    const key = trimmed(item?.key)
    if (!key) continue
    const clauses = Array.isArray(item?.clauses)
      ? item.clauses
      : (typeof item?.clauses === 'string' ? [item.clauses] : [])
    const set = map.get(key) || new Set()
    for (const clause of clauses) {
      const norm = normalizeForGuard(clause)
      if (norm) set.add(norm)
    }
    map.set(key, set)
  }
  return map
}

/**
 * 某条旧子句是否被 owner 明确确认丢弃：子句规范化后相等，或互相包含（标点/同义变体）。
 * @param {Map<string, Set<string>>} ack @param {string} key @param {string} clause
 * @returns {boolean}
 */
function ackCovers(ack, key, clause) {
  const set = ack.get(trimmed(key))
  if (!set || !set.size) return false
  const norm = normalizeForGuard(clause)
  if (!norm) return false
  for (const agreed of set) {
    if (agreed === norm || norm.includes(agreed) || agreed.includes(norm)) return true
  }
  return false
}

/**
 * 改写守卫（架构书 §3.6）：逐条核对受影响旧规则，全过才允许落盘。
 *
 * 逐文件调用：`newText` 对**它替换的旧规则**校验；调用方把一批旧规则 + 该文件新正文传进来。
 *
 * @param {{affected?:Array<any>, mergedText?:string, draft?:object|null,
 *   strict?:boolean, acknowledgeDropped?:Array<{key:string,clauses:string[]}>, relation?:string}} args
 *   affected: 旧规则（`{front,text}` 或扁平 front）；acknowledgeDropped: 非 strict 时 owner
 *   显式确认丢弃的**子句**清单（`[{key, clauses[]}]`）——这是**唯一**能放行"丢例外/丢条件"的通道。
 *   只认子句粒度：key 粒度一键放弃整条规则的全部条款会让「勾选一次」变成安全洞（架构书 §3.6）。
 *   relation: `conflict` 时按冲突口径判模态（新正文表达**新模态**，旧模态允许被取代），
 *   其余关系（refine/merge/编辑）仍要求旧模态保留。
 * @returns {{ok:boolean, failures:Array<{code:string,key:string,detail:string}>}}
 */
export function guardRewrite({
  affected = [], mergedText = '', draft = null, strict = true, acknowledgeDropped = [], relation = '',
} = {}) {
  const failures = []
  const merged = textOf(mergedText)
  const mergedNorm = normalizeForGuard(merged)
  const acknowledged = ackMapOf(acknowledgeDropped)
  const draftScope = trimmed(draft?.scope)
  const draftIsIron = trimmed(draft?.type) === 'iron-rule'
  const conflict = trimmed(relation) === 'conflict'
  const draftModality = trimmed(draft?.modality) || 'must'

  if (!mergedNorm) failures.push({ code: 'body_empty', key: '', detail: '改写后正文为空' })
  const length = chars(merged)
  if (length > RULE_BODY_MAX) failures.push({ code: 'body_too_long', key: '', detail: `${length} > ${RULE_BODY_MAX}` })

  const signals = merged ? detectSignals(merged) : { rejectReason: null }
  if (signals.rejectReason === 'privacy') {
    failures.push({ code: 'privacy', key: '', detail: '改写后正文含密钥/手机号/身份证等敏感信息' })
  }

  for (const doc of Array.isArray(affected) ? affected : []) {
    const { front } = normalizeDoc(doc)
    const key = trimmed(front.key) || '<unknown>'
    const oldIron = trimmed(front.type) === 'iron-rule'
    const droppedOk = !strict

    if ((oldIron || draftIsIron) && VAGUE_RE.test(merged)) {
      failures.push({ code: 'vague_word', key, detail: '铁律不得含模糊词（尽量/最好/尽可能…）' })
    }

    // 例外与条件同权（架构书 §3.6）：旧 conditions 丢了与丢例外一样必须拒绝，
    // 只留结构化字段而正文不写＝正文与 front 漂移，注入读到的就是没有条件的规则。
    for (const [code, field] of [['dropped_exception', 'exceptions'], ['dropped_condition', 'conditions']]) {
      const clauses = Array.isArray(front[field]) ? front[field] : []
      for (const clause of clauses) {
        if (retainsClause(mergedNorm, clause)) continue
        // 逐子句放行：这条子句必须出现在该 key 的 acknowledgeDropped.clauses 里才算确认。
        if (droppedOk && ackCovers(acknowledged, key, clause)) continue
        failures.push({ code, key, detail: `旧${field === 'exceptions' ? '例外' : '条件'}未保留：${trimmed(clause)}` })
      }
    }

    const modality = trimmed(front.modality) || 'must'
    if (conflict) {
      // v3.7 让冲突永远过不了守卫（旧模态必须保留），冲突态等于死路：冲突的定义就是新口
      // 径取代旧口径，所以这里只要求**新正文**把新模态表达清楚。
      const need = MODALITY_WORDS[draftModality]
      if (need && !need.test(merged)) {
        failures.push({ code: 'modality_missing', key, detail: `冲突新正文未表达模态 ${draftModality}` })
      } else if (HEDGE_RE.test(merged) && ['must', 'must_not', 'only'].includes(draftModality)) {
        failures.push({ code: 'modality_weakened', key, detail: `模态 ${draftModality} 被模糊词弱化` })
      }
    } else {
      const words = MODALITY_WORDS[modality]
      if (words && !words.test(merged)) {
        failures.push({ code: 'modality_weakened', key, detail: `模态 ${modality} 在改写后消失` })
      } else if (HEDGE_RE.test(merged) && ['must', 'must_not', 'only'].includes(modality)) {
        // 「禁止→尽量别」「必须→最好」是典型弱化：模态词还在，但强度被对冲词拉低了。
        failures.push({ code: 'modality_weakened', key, detail: `模态 ${modality} 被模糊词弱化` })
      }
    }

    const oldScope = trimmed(front.scope)
    if (draftScope && oldScope && draftScope !== oldScope) {
      failures.push({ code: 'scope_changed', key, detail: `${oldScope} → ${draftScope}` })
    }
  }

  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// 链解析（merged_into / superseded_by）
// ---------------------------------------------------------------------------

/**
 * 取一条规则的链指针（`merged_into` 优先于 `superseded_by`；两者互斥落盘）。
 * @param {any} doc `{front,text}` 或扁平 front
 * @returns {string} 目标 key，空串=链终点
 */
export function chainPointerOf(doc) {
  const { front } = normalizeDoc(doc)
  return trimmed(front.merged_into) || trimmed(front.superseded_by)
}

/**
 * 传递解析链：沿 `merged_into`/`superseded_by` 追到终点（架构书 §3.3）。
 *
 * 三种结局：`terminal`（无链指针的当前规则）、`broken`（指向的 key 不存在）、
 * `cycle`（A→B→A 这类环）。注入/摘要只该用 `terminal` 且 status=active 的规则；
 * 环/断链由 `/rules/health` 报红（`chainIssues`）。
 *
 * @param {Array<any>} rules 全量规则（含 superseded）
 * @param {string} key 起点 key
 * @returns {{ok:boolean, chain:string[], rule:object|null, status:string,
 *   broken:boolean, cycle:boolean, missingKey:string}}
 */
export function resolveChain(rules, key) {
  const byKey = new Map()
  for (const doc of Array.isArray(rules) ? rules : []) {
    const { front } = normalizeDoc(doc)
    const k = trimmed(front.key)
    if (k && !byKey.has(k)) byKey.set(k, { front, text: normalizeDoc(doc).text })
  }
  const start = trimmed(key)
  const chain = [start]
  const seen = new Set([start])
  let current = start
  // 上限 = 规则数 + 1：`seen` 已经保证有界，这里只是防御性硬顶（坏数据里 key 可能超长）。
  for (let step = 0; step <= byKey.size; step += 1) {
    const doc = byKey.get(current)
    if (!doc) {
      return { ok: false, chain, rule: null, status: '', broken: true, cycle: false, missingKey: current }
    }
    const pointer = chainPointerOf(doc)
    if (!pointer) {
      return {
        ok: true,
        chain,
        rule: doc,
        status: trimmed(doc.front.status),
        broken: false,
        cycle: false,
        missingKey: '',
      }
    }
    if (seen.has(pointer)) {
      return { ok: false, chain: [...chain, pointer], rule: null, status: '', broken: false, cycle: true, missingKey: '' }
    }
    seen.add(pointer)
    chain.push(pointer)
    current = pointer
  }
  return { ok: false, chain, rule: null, status: '', broken: false, cycle: true, missingKey: '' }
}

/**
 * 全仓链体检（`/rules/health` 用）：列出所有环与断链。
 * @param {Array<any>} rules @returns {{cycles:Array<object>, broken:Array<object>, ok:boolean}}
 */
export function chainIssues(rules) {
  const cycles = []
  const broken = []
  const seenCycle = new Set()
  for (const doc of Array.isArray(rules) ? rules : []) {
    const { front } = normalizeDoc(doc)
    const key = trimmed(front.key)
    if (!key || !chainPointerOf(doc)) continue
    const got = resolveChain(rules, key)
    if (got.cycle) {
      // 同一环从不同起点会被各报一次：用环内 key 集合去重（A→B→A 与 B→A→B 是同一个环）。
      const signature = [...new Set(got.chain)].sort().join('|')
      if (seenCycle.has(signature)) continue
      seenCycle.add(signature)
      cycles.push({ key, chain: got.chain })
    } else if (got.broken) {
      broken.push({ key, missingKey: got.missingKey, chain: got.chain })
    }
  }
  return { cycles, broken, ok: cycles.length === 0 && broken.length === 0 }
}

// ---------------------------------------------------------------------------
// 合并提示词 / 回包解析
// ---------------------------------------------------------------------------

/** 规则要点摘要（prompt 用；不塞整份文件，省 token 也避免模型抄格式）。 */
function ruleBrief(doc) {
  const { front, text } = normalizeDoc(doc)
  return {
    key: trimmed(front.key),
    number: front.number ?? null,
    type: trimmed(front.type),
    scope: trimmed(front.scope),
    modality: trimmed(front.modality),
    conditions: Array.isArray(front.conditions) ? front.conditions : [],
    exceptions: Array.isArray(front.exceptions) ? front.exceptions : [],
    text: textOf(text),
  }
}

/**
 * 合并/改写提示词（架构书 §4.4）：模型只改措辞，不改结构、不扩权。
 * @param {{draft:object, affected?:Array<any>}} args
 * @returns {{system:string, user:string}}
 */
export function buildMergePrompt({ draft = null, affected = [] } = {}) {
  const system = [
    '你是规则文本编辑器，只做措辞合并，不做规则判定。',
    '硬约束：',
    '1. 不得新增原文没有的义务，不得删除任何旧「例外」条目；',
    '2. 不得弱化模态（禁止/不得 不得改成 尽量/建议；必须 不得改成 建议）；',
    '3. 不得改变作用域 scope、编号 number、类型 type；',
    '4. 正文 1–500 字、指令形态、无理由句、无链接、无模糊词（尽量/最好/尽可能/酌情）；',
    '5. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  ].join('\n')
  const payload = {
    draft: draft ? {
      key: trimmed(draft.key),
      type: trimmed(draft.type),
      scope: trimmed(draft.scope),
      modality: trimmed(draft.modality),
      action: trimmed(draft.action),
      object: trimmed(draft.object),
      conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
      exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
      text: textOf(draft.text),
    } : null,
    affected: (Array.isArray(affected) ? affected : []).map(ruleBrief),
  }
  const user = [
    '把下面的新草案与受影响旧规则合并成一条正文（只改措辞）。',
    '输入：',
    JSON.stringify(payload, null, 2),
    '输出 JSON 结构：',
    '{"merged_text":"合并后的规则正文","affected":[{"key":"旧规则 key","new_text":"该旧规则改写后的正文"}],"preserved":["保留的子句"],"dropped":["丢弃的子句"]}',
    'affected 只列出确实需要改写的旧规则；无需改写时给 []。',
  ].join('\n')
  return { system, user }
}

/** 从模型回包里抠出第一个 JSON 对象（容忍 ```json 围栏与前后解释文字）。 */
function firstJsonObject(raw) {
  const text = textOf(raw).replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')
  const start = text.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 容错解析 LLM 合并回包。
 * 只信 `merged_text`（也容忍 `merged`/`body` 这类漂移字段名）；结构不对就报错，
 * 绝不"猜"正文——猜出来的规则会绕过守卫的语义校验。
 *
 * @param {string} text
 * @returns {{ok:true, value:{merged_text:string, affected:Array<{key:string,new_text:string}>,
 *   preserved:string[], dropped:string[]}} | {ok:false, error:string}}
 */
export function parseMergeReply(text) {
  const json = firstJsonObject(text)
  if (!json) return { ok: false, error: 'no_json' }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'bad_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'not_object' }
  const mergedText = trimmed(parsed.merged_text ?? parsed.merged ?? parsed.body)
  if (!mergedText) return { ok: false, error: 'merged_text_missing' }
  const affected = []
  for (const item of Array.isArray(parsed.affected) ? parsed.affected : []) {
    const key = trimmed(item?.key)
    const newText = trimmed(item?.new_text ?? item?.text)
    if (!key || !newText) continue
    affected.push({ key, new_text: newText })
  }
  const listOf = (value) => (Array.isArray(value) ? value.map((x) => trimmed(x)).filter(Boolean) : [])
  return {
    ok: true,
    value: { merged_text: mergedText, affected, preserved: listOf(parsed.preserved), dropped: listOf(parsed.dropped) },
  }
}
