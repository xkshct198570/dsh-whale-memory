// 职责：改写守卫（例外/条件/模态/作用域/长度/隐私）与 merged_into 链校验；依赖：../rules.js（信号）+ ../rule-store.js（正文上限）+ ./compile.js（文本/文档/VAGUE_RE）；不 import 门面/relation。
import { detectSignals } from '../rules.js'
import { RULE_BODY_MAX } from '../rule-store.js'
import { VAGUE_RE, chars, normalizeDoc, textOf, trimmed } from './compile.js'

/** 对冲词（弱化模态的判据；比 VAGUE_RE 窄：不含「可能/也许」这类纯推测）。 */
const HEDGE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|方便的时候|maybe|probably|try to|if possible)/i

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
