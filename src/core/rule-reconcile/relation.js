// 职责：规则关系判定（同 key/重复/冲突/合并/独立）的确定性判据；依赖：../rules.js（去重/相似/归一）+ ./compile.js（文本/文档/动词族工具）；不 import 门面。
import { dedupeKey, normalizeRuleText, similarity } from '../rules.js'
import { normalizeDoc, textOf, trimmed, verbFamilyOf, verbsIn } from './compile.js'


/** 重复阈值（架构书 §4.3）：归一化正文相似度 ≥0.9 视为同一条规则。 */
export const DUPLICATE_SIMILARITY = 0.9

/** 槽位（对象核心词）重叠阈值：低于它视为不同对象，不判冲突/合并。 */
export const SLOT_OVERLAP_MIN = 0.3

/** 互斥动词族对：同对象 + 相同模态也会冲突（「报告默认删除」vs「报告默认保留」）。 */
export const OPPOSITE_FAMILIES = Object.freeze([
  Object.freeze(['delete', 'keep']),
  Object.freeze(['enable', 'disable']),
  Object.freeze(['allow', 'forbid']),
  Object.freeze(['delete', 'archive']),
])

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
