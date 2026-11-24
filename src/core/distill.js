/**
 * 会话蒸馏（Session Wrap 的模型侧）：提示词 → 容错解析 → 硬判据校验。
 *
 * 为什么拆三段而不是一个大函数：
 * - buildDistillPrompt 是纯字符串拼装，模型换谁来都能复用；
 * - parseDistillOutput 只负责「把模型输出变成形状」，不判断真假——形状错就整条弃；
 * - validateDistillItems 只负责「能不能信」：evidence 必须是素材里的连续原文片段，
 *   这是唯一能机械证伪「模型编了一条看起来很对的结论」的判据。编造的条目再像也不能入库。
 * 顺序不能换：先形状后内容，校验函数才能假设 items 是对象数组。
 *
 * 为什么 rule 没有证据时降级为 lesson 而不是丢弃：条目本身可能对（比如「端口是 3080」），
 * 只是被模型贴错标签；降级保留信息，丢标签比丢事实代价小。
 */
import { materialText } from './wrap-material.js'

/** 允许的条目类型（与记忆层的 semantic/procedural 不一一对应，落库时由调用方映射）。 */
export const DISTILL_KINDS = Object.freeze(['lesson', 'decision', 'preference', 'fact', 'open_loop', 'rule'])

const KIND_SET = new Set(DISTILL_KINDS)
const TAG_LIMIT = 5
const TAG_MAX_CHARS = 24
const SUMMARY_DEFAULT = 200
/** 剥离主观前缀：蒸馏条目要是可执行的断言，带「我觉得/可能」会让人以为这是猜测。 */
const HEDGE_PREFIXES = Object.freeze(['我觉得', '我感觉', '可能', '大概', '或许', '似乎', '应该是'])
/** rule 的规范句标记：evidence 原文必须出现其一，否则只是贴错标签。 */
const RULE_MARKERS = /以后都|必须|禁止|不得|别再|一定要|记成铁律|当作规则|定为规则/
/** 代码围栏（模型很爱加，直接判坏 JSON 会让整轮白跑）。 */
const FENCE_HEAD = /^```(?:json)?\s*/i
const FENCE_TAIL = /\s*```$/

/**
 * 构造蒸馏提示词。
 *
 * 素材按码点截断（素材是纯文本行，直接切字符不会破坏 JSON 结构——被切的是输入而不是输出）。
 * 提示词不要求模型「补全」任何缺失信息：没有就输出空 items。
 *
 * @param {{turns?: Array<object>}|object} material 会话素材
 * @param {{maxItems?: number, maxChars?: number}} [options] 条数上限与素材码点上限
 * @returns {string} 中文提示词
 */
export function buildDistillPrompt(material, { maxItems = 8, maxChars = 12000 } = {}) {
  const itemLimit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 8
  const charLimit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 12000
  const body = Array.from(materialText(material)).slice(0, charLimit).join('')
  return [
    '你是会话收尾的记忆蒸馏器。把下面的会话素材提炼成可长期复用的结构化条目。',
    '',
    '只输出一个 JSON 对象，不要输出解释、不要用代码围栏：',
    '{"summary":"一句话工程结论（≤200字）","items":[{"kind":"lesson","text":"可执行短语义（≤200字）",'
      + '"evidence":"素材里的连续原文片段","confidence":0.8,"tags":["标签"]}]}',
    `items 最多 ${itemLimit} 条；没有可提炼的内容就输出 {"summary":"","items":[]}。`,
    `kind 只能是 ${DISTILL_KINDS.join(' / ')} 之一。`,
    'confidence 取 0~1 的小数；tags 最多 5 个、每个不超过 24 字。',
    '',
    '硬规则：',
    '1. evidence 必须是素材里出现过的连续原文片段，逐字照抄，不得改写、拼接、翻译或概括。',
    '2. text 每条不超过 200 字，只写能回答「做什么·何时·怎么判」的短语义。',
    '3. 不要寒暄、不要复述工具输出、不要写思考过程、不要编造素材里没有的事实。',
    '4. 素材不足以支撑某条结论时，宁可少写一条，也不要补假设。',
    '',
    '素材（每行以 [uN]/[aN] 标明发言角色）：',
    body || '（无素材）',
  ].join('\n')
}

/**
 * 容错解析模型输出：剥代码围栏，取第一个 `{` 到最后一个 `}`；顶层是数组时整体视为 items。
 *
 * @param {unknown} raw 模型原始输出
 * @returns {{ok: boolean, summary: string, items: Array<object>, error?: string}}
 *   ok=false 只代表「拿不到合法 JSON」，error 固定为 'bad_json'
 */
export function parseDistillOutput(raw) {
  const text = String(raw ?? '').trim().replace(FENCE_HEAD, '').replace(FENCE_TAIL, '').trim()
  // 顶层是数组时先按数组解析：否则「[{...}]」会先命中内部的 { }，把一个数组误解成单个对象。
  const startsArray = text.startsWith('[')
  const order = startsArray ? ['array', 'object'] : ['object', 'array']
  let parsed
  for (const shape of order) {
    if (parsed !== undefined) break
    if (shape === 'object') {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start !== -1 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { parsed = undefined }
      }
    } else {
      const start = text.indexOf('[')
      const end = text.lastIndexOf(']')
      if (start !== -1 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { parsed = undefined }
      }
    }
  }
  if (parsed === undefined) return { ok: false, summary: '', items: [], error: 'bad_json' }
  let summary = ''
  let list = []
  if (Array.isArray(parsed)) {
    list = parsed
  } else if (parsed && typeof parsed === 'object') {
    summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    list = Array.isArray(parsed.items) ? parsed.items : []
  } else {
    return { ok: false, summary: '', items: [], error: 'bad_json' }
  }
  const items = list
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
    .map((item) => ({
      kind: normalizeKind(item.kind),
      text: String(item.text).trim(),
      evidence: typeof item.evidence === 'string' ? item.evidence.trim() : '',
      confidence: clampConfidence(item.confidence),
      tags: sanitizeTags(item.tags),
    }))
    // 空 text 不构成条目：留着只会让下游 validate 的 dropped 全是噪声。
    .filter((item) => item.text !== '')
  return { ok: true, summary, items }
}

/**
 * 归一证据文本：NFKC（全角→半角）→ 空白折叠为单空格 → 小写 → 去首尾空白。
 *
 * 不删标点/汉字：删掉标点会让「禁止用 npm install」与「禁止用 npm」互相命中，
 * 编造的片段就可能借标点差异混过 includes 检查。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeEvidence(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, ' ')
    .toLowerCase()
    .trim()
}

/**
 * 逐条硬判据校验：形状合法还不够，证据必须能在素材里逐字找到。
 *
 * 判据顺序（前面的便宜、后面的贵）：text 非空且不超长 → evidence 非空且够长 →
 * evidence 在素材内 → 不是纯链接堆 → rule 标签有规范句支撑 → 去重 → 条数上限。
 *
 * @param {Array<object>} items parseDistillOutput 的 items（也可直接吃模型原文里的对象）
 * @param {{turns?: Array<object>}|object} material 本次蒸馏的素材
 * @param {{maxItems?: number, maxItemChars?: number, evidenceMinChars?: number, summary?: string}} [options]
 * @returns {{items: Array<{kind: string, text: string, evidence: string, confidence: number,
 *   tags: string[], evidenceNorm: string}>, dropped: Array<{text: string, reason: string}>, summary: string}}
 */
export function validateDistillItems(items, material, {
  maxItems = 8, maxItemChars = 200, evidenceMinChars = 4, summary = '',
} = {}) {
  const list = Array.isArray(items) ? items : []
  const itemLimit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 8
  const textLimit = Number.isFinite(maxItemChars) && maxItemChars > 0 ? Math.floor(maxItemChars) : 200
  const evidenceLimit = Number.isFinite(evidenceMinChars) && evidenceMinChars > 0
    ? Math.floor(evidenceMinChars)
    : 4
  const materialNorm = normalizeEvidence(materialText(material))
  const kept = []
  const keptNorms = []
  const dropped = []

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const text = cleanItemText(item.text)
    const textChars = Array.from(text).length
    if (textChars === 0) {
      // 剥离主观前缀后为空：dropped 里保留原始文本，否则「为什么丢了」无从追溯。
      const original = String(item.text ?? '').replace(/[\s\u3000]+/gu, ' ').trim()
      dropped.push({ text: original, reason: 'empty_text' })
      continue
    }
    if (textChars > textLimit) { dropped.push({ text, reason: 'too_long' }); continue }

    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
    const evidenceNorm = normalizeEvidence(evidence)
    if (!evidenceNorm) { dropped.push({ text, reason: 'evidence_missing' }); continue }
    if (Array.from(evidenceNorm).length < evidenceLimit) {
      dropped.push({ text, reason: 'evidence_too_short' })
      continue
    }
    if (!materialNorm.includes(evidenceNorm)) {
      dropped.push({ text, reason: 'evidence_not_found' })
      continue
    }
    if (isLinkOnly(text)) { dropped.push({ text, reason: 'link_only' }); continue }

    let kind = normalizeKind(item.kind)
    if (kind === 'rule' && !RULE_MARKERS.test(evidence)) kind = 'lesson'

    const norm = normalizeText(text)
    const duplicated = keptNorms.some((previous) => (
      previous.norm === norm || containmentRatio(previous.norm, norm) >= 0.8
    ))
    if (duplicated) { dropped.push({ text, reason: 'duplicate' }); continue }
    if (kept.length >= itemLimit) { dropped.push({ text, reason: 'over_limit' }); continue }

    kept.push({
      kind,
      text,
      evidence,
      confidence: clampConfidence(item.confidence),
      tags: sanitizeTags(item.tags),
      evidenceNorm,
    })
    keptNorms.push({ norm })
  }
  return { items: kept, dropped, summary: typeof summary === 'string' ? summary : '' }
}

/**
 * 摘要压平：换行/连续空白折叠成单空格，超长按码点截断并补 `…`（只加一个省略号，不重复截）。
 *
 * @param {unknown} text
 * @param {number} [maxChars] 码点上限（缺省 200）
 * @returns {string}
 */
export function clampSummary(text, maxChars = 200) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : SUMMARY_DEFAULT
  const flat = String(text ?? '').replace(/[\s\u3000]+/gu, ' ').trim()
  const chars = Array.from(flat)
  if (chars.length <= limit) return flat
  return `${chars.slice(0, limit).join('')}…`
}

/** 非法 kind 归一为 'fact'：宁可当事实存，也不要让脏标签污染检索过滤。 */
function normalizeKind(kind) {
  const value = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  return KIND_SET.has(value) ? value : 'fact'
}

/** confidence：非数字缺省 0.5，数字夹到 0..1（NaN/Infinity 也落缺省）。 */
function clampConfidence(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0.5
  return Math.min(1, Math.max(0, n))
}

/** tags：只留字符串、去重、每项按码点截到 24、最多 5 个。 */
function sanitizeTags(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (!tag) continue
    const cut = Array.from(tag).slice(0, TAG_MAX_CHARS).join('')
    if (!out.includes(cut)) out.push(cut)
    if (out.length >= TAG_LIMIT) break
  }
  return out
}

/** 条目文本：空白折叠 + 去首尾 + 反复剥离主观前缀（「我觉得可能」叠两层也要剥干净）。 */
function cleanItemText(input) {
  let text = String(input ?? '').replace(/[\s\u3000]+/gu, ' ').trim()
  for (let pass = 0; pass < HEDGE_PREFIXES.length; pass += 1) {
    const prefix = HEDGE_PREFIXES.find((candidate) => text.startsWith(candidate))
    if (!prefix) break
    text = text.slice(prefix.length).replace(/^[\s，,：:、]+/u, '').trim()
  }
  return text
}

/** 纯链接堆：去掉 URL 与所有标点/符号/空白后什么都不剩（说明正文只有链接）。 */
function isLinkOnly(text) {
  const raw = String(text)
  const hasUrl = /(https?:\/\/|www\.)/i.test(raw)
  if (!hasUrl) return false
  const leftover = raw
    .replace(/https?:\/\/\S+|www\.\S+|mailto:\S+/gi, '')
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, '')
  return leftover === ''
}

/** 归一文本（去重口径）：已折叠空白，只需小写。 */
function normalizeText(text) {
  return String(text).replace(/[\s\u3000]+/gu, ' ').toLowerCase().trim()
}

/**
 * 包含比：一条包含另一条时返回「短/长」的码点比，不包含返回 0。
 * 为什么用 0.8：只差几个字的两条结论（「装依赖用 pnpm」/「装依赖用 pnpm 吧」）是同一条，
 * 而「用 pnpm」被「不要用 pnpm」包含时比值也高但语义相反——那类应由 model 判 kind=rule 表达，
 * 这里不做语义推断，宁可留下两条也不误删。
 */
function containmentRatio(a, b) {
  if (a === b) return 1
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (!long.includes(short)) return 0
  return Array.from(short).length / Array.from(long).length
}
