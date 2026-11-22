/**
 * 规则提案的「结构化编译 + 关系判定 + 改写守卫」（R3b，纯函数、零 I/O）。
 *
 * 职责：
 * - `compileStructured`：把一句 owner 文本编译成可落盘的规则草案（front matter 字段 + 正文），
 *   并对正文做**主句完整性守卫**——编译模板剥噪时若把原句的动作/对象剥掉了，整条拒绝
 *   （`partial_compile`），不允许"半句规则"进候选；
 * - `classifyRelation`：对草案与既有规则做确定性配对（同 key / 重复 / 冲突 / 合并 / 独立），
 *   先规则后模型：这里只出结论，不做改写；
 * - `guardRewrite`：合并/冲突/改写的**唯一放行闸**（旧例外不丢、模态不弱化、铁律无模糊词、
 *   作用域不变、长度/隐私合规），失败即拒绝；
 * - `buildMergePrompt` / `parseMergeReply`：交给 LLM 的"只改措辞"提示词与容错解析。
 *
 * 边界：
 * - 只 import `./rules.js` 与 `./rule-store.js` 的纯常量函数；不读写文件、不调模型、不碰 DB；
 * - LLM 调用在 rule-proposal.js；本模块只产 prompt、只解析回包；
 * - 不把 `similarity`(0.4) 当冲突结论：0.4 只是配对快筛，0.9 才是重复阈值（架构书 §4.3）。
 *
 * Why 单独成文件：关系判定与守卫是"规则能不能自动落盘"的唯一判据，必须能脱宿主/脱文件
 * 单测；一旦混进提案编排（rule-proposal）或路由，就再也无法用黄金样例锁住判定口径。
 */
import {
  compileRule,
  dedupeKey,
  detectSignals,
  normalizeRuleText,
  ruleKeyOf,
  similarity,
} from './rules.js'
import { RESERVED_NUMBERS, RULE_BODY_MAX, RULE_MODALITIES, isValidRuleKey } from './rule-store.js'

/** 重复阈值（架构书 §4.3）：归一化正文相似度 ≥0.9 视为同一条规则。 */
export const DUPLICATE_SIMILARITY = 0.9

/** 强定规口径与 rules.js 的 EXPLICIT_STRONG_RE 一致。rules.js 未导出该常量且不在 R3b 写域，
 * 这里复制一份；两处口径必须同改（有黄金样例 `compileStructured：强定规→铁律` 盯着）。 */
const IRON_STRONG_RE = /(记成铁律|铁律|以后都|以后一律|以后不要|以后别|从此以后|从此|永久|永远|一律|任何情况下|任何时候|每次都要|永远不要|always|forever|permanently)/i
const IRON_REF_RE = /铁律\s*(?:#|No\.?|编号)?\s*([0-9]{1,3})/i
const RULE_KEY_REF_RE = /rule:([a-z0-9][a-z0-9._-]{0,63})/i

/** 模糊词（架构书 §4.5）：铁律一律不得出现。 */
const VAGUE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|可能|也许|方便的时候|maybe|probably)/i

/** 对冲词（弱化模态的判据；比 VAGUE_RE 窄：不含「可能/也许」这类纯推测）。 */
const HEDGE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|方便的时候|maybe|probably|try to|if possible)/i

/** 条件/例外从句：抽槽位前整段剥掉（它们只进 conditions/exceptions）。 */
const SLOT_CONDITION_STRIP_RE = /[；;，,]?\s*例外\s*[：:][^。；;\n]+|[；;，,]?\s*除非[^。；;，,\n]{1,60}|[；;，,]?\s*当(?!前|初|时)[^。；;\n]{1,60}?时/g

/** 定规前缀（「以后都」「必须」「禁止」…）：不是动作/对象本体，抽槽位前逐层剥掉。 */
const LEAD_PREFIX_RE = /^[\s，,。；;、]*(?:记成铁律\s*\d*|铁律\s*\d*|规则|请记住|请|否则|不然|以后一律|以后都|以后不要|以后别|以后|从此以后|从此|永久|永远|一律|任何情况下|任何时候|每次都要|必须|务必|切记|严禁|禁止|不得|不许|不准|只能|仅能|只允许|不要|别再|别|记得|记住|注意|先)[\s，,：:]*/

/** 动作词表：长词优先（「只允许」不能被「允许」抢先切走）。 */
const ACTION_VERBS = [
  '只允许', '只保留', '不保留', '删掉', '删除', '备份', '保留', '写入', '运行', '执行',
  '提交', '推送', '拉取', '重启', '停止', '启动', '开启', '关闭', '注入', '召回', '归档',
  '移动', '创建', '新建', '导出', '导入', '同步', '检查', '校验', '验证', '测试', '安装',
  '卸载', '记录', '记住', '确认', '询问', '回复', '调用', '查询', '清理', '覆盖', '替换',
  '合并', '拆分', '改造', '改成', '改为', '禁止', '允许', '使用', '采用', '保持', '留',
  '删', '写', '跑', '用', '开', '关', '停', '查', '改',
]
const ACTION_VERBS_SORTED = [...ACTION_VERBS].sort((a, b) => b.length - a.length)

/** 否定/限定词：决定 modality。与 rules.js 的极性表同口径（那份未导出）。 */
const NEG_RE = /(禁止|不得|不许|不准|不能|不要|别再|别用|别把|别删|别改|严禁|无需|避免|never|must not|do not|don't)/i
const ONLY_RE = /(只能|只允许|仅能|仅允许|\bonly\b)/i

/** 例外/条件抽取（与 rules.js 的 extractConditions 同源形态；这份额外区分槽位）。 */
const EXCEPTION_CLAUSE_RE = /[；;，,]?\s*例外\s*[：:]\s*([^。；;\n]+)/g
const CONDITION_CLAUSE_RE = /(除非[^。；;\n]{1,60})|(当(?!前|初|时)[^。；;\n]{1,60}?时)/g

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
  must_not: /(禁止|不得|不许|不准|不要|别|严禁|never|must not|forbidden|do not)/i,
  only: /(只能|只允许|仅能|仅允许|\bonly\b)/i,
  except: /(除了|除[^。；;\n]{1,30}以外|除外|except)/i,
})

/** 反向模态（架构书 §4.3 冲突判定）：must↔must_not、only↔except。 */
export const REVERSE_MODALITY = Object.freeze({ must: 'must_not', must_not: 'must', only: 'except', except: 'only' })

/** @param {any} value @returns {string} */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {any} value @returns {string} */
function trimmed(value) {
  return textOf(value).trim()
}

/** 字符数（按码点，不用 .length：emoji/代理对会让预算算错）。 */
function chars(text) {
  return Array.from(textOf(text)).length
}

/**
 * 从文本里取显式身份：`铁律17` 优先于 `rule:<key>`。
 * @param {string} text
 * @returns {{key:string, number:number|null}|null}
 */
export function extractExplicitRef(text) {
  const raw = textOf(text)
  const iron = raw.match(IRON_REF_RE)
  if (iron) {
    const number = Number(iron[1])
    if (Number.isInteger(number) && number > 0) return { key: `iron-rule-${number}`, number }
  }
  const keyRef = raw.match(RULE_KEY_REF_RE)
  if (keyRef && isValidRuleKey(keyRef[1])) return { key: keyRef[1], number: null }
  return null
}

/**
 * 域的确定性推断：复用 rules.js 的 ruleKeyOf（`rule:<domain>-<hash8>`），只解析前缀。
 * 为什么不自己维护关键词表：一份域表已经够，第二份必然漂移。
 * @param {string} text
 * @returns {string}
 */
export function domainOfText(text) {
  const key = ruleKeyOf(textOf(text))
  const rest = key.slice('rule:'.length)
  const cut = rest.lastIndexOf('-')
  return cut > 0 ? rest.slice(0, cut) : 'general'
}

/** @param {any} doc @returns {{front:object,text:string}} */
function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return { front: {}, text: '' }
  if (doc.front && typeof doc.front === 'object') {
    return { front: doc.front, text: textOf(doc.text ?? doc.body) }
  }
  return { front: doc, text: textOf(doc.text ?? doc.body) }
}

/** 编号占用表：既有规则 + 保留空号。 */
function takenNumbers(rules) {
  const taken = new Set(RESERVED_NUMBERS)
  for (const doc of rules) {
    const n = Number(normalizeDoc(doc).front.number)
    if (Number.isInteger(n) && n > 0) taken.add(n)
  }
  return taken
}

/**
 * 找一条空闲编号：从候选起点开始单调递增，跳过占号与保留空号（6 永不复用）。
 * @param {number} start @param {Set<number>} taken @returns {number}
 */
function freeNumber(start, taken) {
  let n = Number.isInteger(start) && start > 0 ? start : 1
  while (taken.has(n)) n += 1
  return n
}

/**
 * 动作/对象抽槽位：剥定规前缀 → 找动作词 → 余下为对象。
 * 只做"截取"，不改写、不补词（补词会造出原文没有的规则）。
 * @param {string} raw
 * @returns {{action:string, object:string}}
 */
export function extractSlots(raw) {
  // 条件/例外单独进槽位，不混进 object：否则 object 会把「例外：…」一起带上，
  // 同槽位比较永远不相等，冲突/合并判定直接失效。
  let rest = textOf(raw).replace(SLOT_CONDITION_STRIP_RE, '').trim()
  for (let i = 0; i < 8; i += 1) {
    const next = rest.replace(LEAD_PREFIX_RE, '')
    if (next === rest) break
    rest = next
  }
  let action = ''
  let cutAt = -1
  // 取**出现位置最靠前**的动词（同位置取更长者）：动作是句子的谓语中心，
  // 按词表顺序取第一个命中的词会把后面从句里的动词误当主句动作（"禁止归档"→"归档"）。
  for (const verb of ACTION_VERBS_SORTED) {
    const idx = rest.indexOf(verb)
    if (idx < 0) continue
    if (cutAt < 0 || idx < cutAt || (idx === cutAt && verb.length > action.length)) {
      action = verb
      cutAt = idx
    }
  }
  if (!action) return { action: '', object: rest.slice(0, 200) }
  const object = `${rest.slice(0, cutAt)}${rest.slice(cutAt + action.length)}`
    .replace(/^[\s，,。；;、]+/, '')
    .replace(/[；;，,\s]+$/, '')
  return { action: action.slice(0, 64), object: object.slice(0, 200) }
}

/**
 * 条件/例外分槽：`例外：` 后面的进 exceptions（每个分项一条），`除非/当…时` 进 conditions。
 * 为什么不直接用 detectSignals.conditions：那份把两类合并了，落盘字段需要分开。
 * @param {string} raw
 * @returns {{conditions:string[], exceptions:string[]}}
 */
export function splitConditions(raw) {
  const text = textOf(raw)
  const conditions = []
  const exceptions = []
  const seen = new Set()
  EXCEPTION_CLAUSE_RE.lastIndex = 0
  let m
  while ((m = EXCEPTION_CLAUSE_RE.exec(text)) !== null) {
    for (const part of textOf(m[1]).split(/[、,，]/)) {
      const item = part.trim().replace(/[。；;\s]+$/g, '')
      if (!item || seen.has(`x:${item}`)) continue
      seen.add(`x:${item}`)
      exceptions.push(item.slice(0, 120))
      if (exceptions.length >= 12) break
    }
  }
  CONDITION_CLAUSE_RE.lastIndex = 0
  while ((m = CONDITION_CLAUSE_RE.exec(text)) !== null) {
    const item = textOf(m[1] || m[2]).trim().replace(/[。；;，,、\s]+$/g, '')
    if (!item || seen.has(`c:${item}`)) continue
    seen.add(`c:${item}`)
    conditions.push(item.slice(0, 200))
    if (conditions.length >= 4) break
  }
  return { conditions, exceptions }
}

/** 模态推断：只允许/仅能 → only；否定 → must_not；其余 must。 */
function modalityOf(raw) {
  const text = textOf(raw)
  if (ONLY_RE.test(text) && !NEG_RE.test(text)) return 'only'
  if (NEG_RE.test(text)) return 'must_not'
  return 'must'
}

/** 定规/顺序停顿词：抽关键片段时再切一刀（不切「重要」这类实词，只切虚词）。 */
const FILLER_SPLIT_RE = /(?:一律|必须|务必|都要|都|先|再|然后|最后|而且|并且|就|才)/

/**
 * 主句完整性守卫：编译后正文必须覆盖原句的动作与对象关键片段（命中 ≥2）。
 * 为什么不比整句：compileRule 会剥理由/链接/口水，整句相等条件永远不成立；
 * 但"动作 + 对象"都必须还在——少一个就是半句规则（P0-4）。
 * @param {{action:string,object:string}} slots @param {string} body
 * @returns {{ok:boolean, hits:number, required:number, fragments:string[], missing:string[]}}
 */
export function mainClauseIntact(slots, body) {
  // object 里残留的定规/顺序词（「过程稿一律到临时目录」）会把一个完整片段切成两半，
  // 直接做子串判定会假失败；先按停顿词再切一刀，判定的是"关键片段在不在"，不是整句复制。
  const pieces = []
  for (const piece of textOf(slots.object).split(/[、,，;；\s和与及]+/)) {
    for (const sub of piece.split(FILLER_SPLIT_RE)) if (sub.trim()) pieces.push(sub.trim())
  }
  const fragments = [slots.action, ...pieces]
    .map((f) => normalizeRuleText(f))
    .filter((f) => f.length > 0)
  const normBody = normalizeRuleText(body)
  const missing = []
  let hits = 0
  for (const fragment of fragments) {
    if (normBody.includes(fragment)) hits += 1
    else missing.push(fragment)
  }
  const required = Math.min(2, fragments.length)
  return { ok: fragments.length === 0 ? true : hits >= required, hits, required, fragments, missing }
}

/**
 * 结构化编译（架构书 §4.2）：一句话 → 规则草案。
 *
 * @param {string} text 原文
 * @param {object} [signals] detectSignals 的返回值（缺字段会用原文重算）
 * @param {{existingRules?:Array<any>, nextNumber?:number, source?:string,
 *   workspace?:string, role?:string, scope?:string}} [opts]
 * @returns {{ok:true, draft:object} | {ok:false, error:string, detail?:object}}
 */
export function compileStructured(text, signals = {}, opts = {}) {
  const raw = trimmed(text)
  if (!raw) return { ok: false, error: 'empty' }
  const sig = signals && typeof signals === 'object'
    ? { ...detectSignals(raw, { source: signals.source, workspace: signals.workspace }), ...signals }
    : detectSignals(raw, { source: opts.source })

  if (sig.rejectReason === 'privacy') return { ok: false, error: 'privacy' }
  if (sig.rejectReason === 'preference') return { ok: false, error: 'preference' }
  if (!sig.ruleLike) return { ok: false, error: sig.rejectReason || 'not_rule' }

  const source = trimmed(opts.source ?? sig.source ?? 'unknown').toLowerCase() || 'unknown'
  const explicitRef = extractExplicitRef(raw)
  const strong = IRON_STRONG_RE.test(raw)
  // owner 显式 + 强定规（或显式点名铁律N）才配 iron-rule；其他来源最高 rule（架构书 §4.1）。
  const isIron = source === 'owner' && sig.explicit && (strong || Boolean(explicitRef?.number))

  const compiled = compileRule(raw, sig)
  if (!compiled.ok) {
    return { ok: false, error: String(compiled.error || 'compile_failed'), detail: { chars: compiled.chars } }
  }

  const slots = extractSlots(raw)
  const intact = mainClauseIntact(slots, compiled.text)
  if (!intact.ok) {
    return {
      ok: false,
      error: 'partial_compile',
      detail: { hits: intact.hits, required: intact.required, missing: intact.missing },
    }
  }

  const { conditions, exceptions } = splitConditions(raw)
  const workspace = trimmed(opts.workspace ?? sig.workspace)
  const scope = trimmed(opts.scope) || (workspace ? `workspace:${workspace}` : 'global')
  const role = trimmed(opts.role)
  const existingRules = Array.isArray(opts.existingRules) ? opts.existingRules : []
  const existingKeys = new Map()
  for (const doc of existingRules) {
    const { front } = normalizeDoc(doc)
    const key = trimmed(front.key)
    if (key) existingKeys.set(key, normalizeDoc(doc))
  }

  const key = explicitRef?.key || `rule-${domainOfText(raw)}-${dedupeKey(raw).slice(0, 8)}`
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key', detail: { key } }

  // 编号：显式铁律N > refine 沿用旧号 > 新建取 nextNumber（跳过占号与空号 6）。
  const sameKey = existingKeys.get(key)
  const taken = takenNumbers(existingRules)
  let number
  if (explicitRef?.number) {
    if (RESERVED_NUMBERS.includes(explicitRef.number)) {
      return { ok: false, error: 'number_reserved', detail: { number: explicitRef.number } }
    }
    const ownerKey = Array.from(existingKeys.entries()).find(([, doc]) => Number(doc.front.number) === explicitRef.number)
    if (ownerKey && ownerKey[0] !== key) {
      return { ok: false, error: 'number_conflict', detail: { number: explicitRef.number, key: ownerKey[0] } }
    }
    number = explicitRef.number
  } else if (sameKey && Number.isInteger(Number(sameKey.front.number)) && Number(sameKey.front.number) > 0) {
    number = Number(sameKey.front.number)
  } else {
    const start = Number(opts.nextNumber)
    number = freeNumber(Number.isInteger(start) && start > 0 ? start : 1, taken)
  }

  const draft = {
    key,
    type: isIron ? 'iron-rule' : 'rule',
    number,
    priority: isIron ? 'P0' : (Number(sig.score) >= 0.85 ? 'P1' : 'P2'),
    scope,
    role,
    modality: RULE_MODALITIES.includes(modalityOf(raw)) ? modalityOf(raw) : 'must',
    action: slots.action,
    object: slots.object,
    conditions,
    exceptions,
    text: compiled.text,
    chars: chars(compiled.text),
    // 域不是 front matter 字段，但关系判定/面板需要它；放在草案上仅作运行时视图。
    domain: domainOfText(raw),
  }
  return { ok: true, draft }
}

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

/** 槽位相等：归一化后相等或互相包含（「源文件」vs「源文件与文档」算同槽位）。 */
function sameSlot(a, b) {
  const na = normalizeRuleText(a)
  const nb = normalizeRuleText(b)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

/** 条件/例外"互补"：任一方为空，或两方没有重叠条目（重叠=同一条件重复，不是补充）。 */
function complementary(a, b) {
  const left = [...a.conditions, ...a.exceptions].map(normalizeRuleText).filter(Boolean)
  const right = [...b.conditions, ...b.exceptions].map(normalizeRuleText).filter(Boolean)
  if (!left.length || !right.length) return true
  for (const l of left) if (right.some((r) => r === l || r.includes(l) || l.includes(r))) return false
  return true
}

/**
 * 关系判定（架构书 §4.3）：先规则、后模型；本函数是**唯一**确定性判据。
 *
 * 判定顺序（先到先得，避免一条草案同时挂多个关系）：
 * 1. 同 key → refine（沿用旧编号）；
 * 2. dedupeKey 相同或正文相似度 ≥0.9 → duplicate；
 * 3. 同域 + 同对象 + 反向模态 → conflict；
 * 4. 同域 + 同对象 + 模态兼容 + 条件/例外互补 → merge；
 * 5. 其余：有既有规则 → 'unrelated'（比对过、无关系）；没有既有规则 → 'new'。
 *    两者下游动作相同（可直接提案），分开只为面板能显示"已比对 N 条、无冲突"。
 *
 * @param {object} draft compileStructured 的草案
 * @param {Array<any>} [existingRules] 真实规则（`{front,text}` 或扁平 front）
 * @returns {{relation:'new'|'duplicate'|'refine'|'merge'|'conflict'|'unrelated',
 *   targets:Array<{key:string,number:number|null,text:string,reason:string}>}}
 */
export function classifyRelation(draft, existingRules = []) {
  const rules = (Array.isArray(existingRules) ? existingRules : []).map(relationTarget)
  const empty = { relation: rules.length ? 'unrelated' : 'new', targets: [] }
  if (!draft || !textOf(draft.text).trim()) return empty
  const draftKey = trimmed(draft.key)
  const draftText = textOf(draft.text)
  const draftDomain = trimmed(draft.domain) || domainOfText(draftText)
  const draftObject = trimmed(draft.object)
  const draftModality = trimmed(draft.modality) || 'must'
  const draftConditions = {
    conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
    exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
  }

  const refine = rules.find((rule) => rule.key && rule.key === draftKey)
  if (refine) {
    return { relation: 'refine', targets: [{ key: refine.key, number: refine.number, text: refine.text, reason: 'same_key' }] }
  }

  const draftHash = dedupeKey(draftText)
  const duplicates = rules.filter((rule) => rule.key !== draftKey && rule.text && (
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

  const domainMates = rules.filter((rule) => rule.key !== draftKey
    && rule.text
    && (trimmed(rule.front.domain) || domainOfText(rule.text)) === draftDomain)

  const conflicts = []
  const merges = []
  for (const rule of domainMates) {
    const ruleObject = trimmed(rule.front.object)
    if (draftObject && ruleObject && !sameSlot(draftObject, ruleObject)) continue
    if (!draftObject || !ruleObject) continue
    const ruleModality = trimmed(rule.front.modality) || 'must'
    if (REVERSE_MODALITY[draftModality] === ruleModality) {
      conflicts.push({ rule, reason: 'modality_flip' })
      continue
    }
    const ruleConditions = {
      conditions: Array.isArray(rule.front.conditions) ? rule.front.conditions : [],
      exceptions: Array.isArray(rule.front.exceptions) ? rule.front.exceptions : [],
    }
    if (complementary(draftConditions, ruleConditions)) {
      merges.push({ rule, reason: 'complementary_conditions' })
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
 * 改写守卫（架构书 §4.5）：逐条核对受影响旧规则，全过才允许落盘。
 *
 * @param {{affected?:Array<any>, mergedText?:string, draft?:object|null,
 *   strict?:boolean, acknowledgeDropped?:string[]}} args
 *   affected: 旧规则（`{front,text}` 或扁平 front）；acknowledgeDropped: 非 strict 时 owner
 *   显式确认丢弃的规则 key 列表——这是**唯一**能放行"丢例外"的通道。
 * @returns {{ok:boolean, failures:Array<{code:string,key:string,detail:string}>}}
 */
export function guardRewrite({
  affected = [], mergedText = '', draft = null, strict = true, acknowledgeDropped = [],
} = {}) {
  const failures = []
  const merged = textOf(mergedText)
  const mergedNorm = normalizeForGuard(merged)
  const acknowledged = new Set((Array.isArray(acknowledgeDropped) ? acknowledgeDropped : []).map((k) => trimmed(k)))
  const draftScope = trimmed(draft?.scope)
  const draftIsIron = trimmed(draft?.type) === 'iron-rule'

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
    const droppedOk = !strict && acknowledged.has(key)

    if ((oldIron || draftIsIron) && VAGUE_RE.test(merged)) {
      failures.push({ code: 'vague_word', key, detail: '铁律不得含模糊词（尽量/最好/尽可能…）' })
    }

    const exceptions = Array.isArray(front.exceptions) ? front.exceptions : []
    for (const exception of exceptions) {
      if (retainsClause(mergedNorm, exception)) continue
      if (droppedOk) continue
      failures.push({ code: 'dropped_exception', key, detail: `旧例外未保留：${trimmed(exception)}` })
    }

    const modality = trimmed(front.modality) || 'must'
    const words = MODALITY_WORDS[modality]
    if (words && !words.test(merged)) {
      failures.push({ code: 'modality_weakened', key, detail: `模态 ${modality} 在改写后消失` })
    } else if (HEDGE_RE.test(merged) && ['must', 'must_not', 'only'].includes(modality)) {
      // 「禁止→尽量别」「必须→最好」是典型弱化：模态词还在，但强度被对冲词拉低了。
      failures.push({ code: 'modality_weakened', key, detail: `模态 ${modality} 被模糊词弱化` })
    }

    const oldScope = trimmed(front.scope)
    if (draftScope && oldScope && draftScope !== oldScope) {
      failures.push({ code: 'scope_changed', key, detail: `${oldScope} → ${draftScope}` })
    }
  }

  return { ok: failures.length === 0, failures }
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
