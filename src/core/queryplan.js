/**
 * QueryPlan（L2 机制层，纯函数：无 IO、无 SQL）。
 *
 * 检索/打分/面板"为什么命中"三处共用这一份切词口径，禁止各自再写一套。
 * 规则（架构书 §5.1）：
 * - 中文：不做词典分词；先删虚词/疑问词，再对剩余连续片段取 2 字窗口（bigram 兜底），
 *   片段本身作为 cjkTerm（≥3 字时走 trigram 短语）。
 * - 英文/数字：整词小写；含 ._:/\\- 或小写接大写（驼峰）视为标识符，另出子词。
 * - IPv4（校验 0..255）/IPv6 原样进 ips，不进子词、不进 asciiTerms。
 * - 否定词单独收集（打分 1.2 权重）。
 * - 意图：procedural（怎么/如何/规则/步骤/排障…）优先；否则 episodic（上次/之前/记得…）；否则 null。
 * - 去空白后 <2 字符 → minLenOk=false（上层直接空结果，绝不扫表）。
 *
 * 所有数组都去重并有硬上限，保证 FTS 查询串可控（上限不是业务语义，是查询成本闸门）。
 */

import { normalize, subwords } from './tokenize.js'

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// 保守 IPv6：至少两个冒号、只含十六进制/冒号；避免把 host:port、a:b 误判成地址。
const IPV6 = /(?<![\w.:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}(?![\w.:])/gi
const ASCII_TOKEN = /[a-z0-9][a-z0-9._:/\\-]*/g
const TOKEN_CASED = /[A-Za-z0-9][A-Za-z0-9._:/\\-]*/g

const STUB = '\u0001'

// 多字虚词/疑问词先删（长度降序，避免"怎么"先吃掉"怎么样"）。
const STOP_PHRASES = [
  '为什么', '怎么样', '怎么办', '怎么', '怎样', '如何', '哪些', '哪个', '什么',
  '是否', '可以', '能不能', '有没有', '我们', '你们', '他们', '她们', '它们',
  '这个', '那个', '这些', '那些', '一下', '一些', '一个', '现在', '这么', '那么', '多么',
].sort((a, b) => b.length - a.length)

// 单字虚词（同时作为断点）：疑问/语气/代词/常见连词。刻意不收录 从/向/对/给/被/把/都/又/其/之/过 这类
// 高频构词字（"方向""对象""供给""过程"会被切坏），宁可留噪声也不破坏词形。
const STOP_CHARS = new Set(Array.from('的了吗呢啊吧就也还和与及或是这那我你他她它么怎什哪啥嘛呀啦在不没未别禁勿'))

const NEGATION_CHARS = ['不', '别', '禁', '勿', '没', '未']
const NEGATION_WORDS = ['never', 'without', 'not', 'no']

const PROCEDURAL_WORDS = ['怎么', '如何', '怎样', '规则', '步骤', '排障', '流程', '方法']
const EPISODIC_WORDS = ['上次', '之前', '那天', '记得', '当时', '昨天', '刚才', '那次', '上回']

const CAP = { cjkTerms: 12, cjkGrams: 24, asciiTerms: 24, idents: 24, ips: 8, negations: 8 }

/** @param {string[]} list @param {string} value @param {number} cap */
function pushUnique(list, value, cap) {
  if (!value || value.length === 0) return
  if (list.length >= cap) return
  if (!list.includes(value)) list.push(value)
}

/** @param {string} octet */
function validV4(addr) {
  return addr.split('.').every((part) => {
    if (part.length === 0 || part.length > 3) return false
    const n = Number(part)
    return Number.isInteger(n) && n >= 0 && n <= 255
  })
}

/** 驼峰检测用原始大小写：小写字母后紧跟大写字母（全大写缩写不算）。 */
function camelTokens(raw) {
  const set = new Set()
  if (typeof raw !== 'string') return set
  const cased = raw.normalize('NFKC')
  for (const m of cased.matchAll(TOKEN_CASED)) {
    const token = m[0].replace(/[._:/\\-]+$/, '')
    if (/[a-z][A-Z]/.test(token)) set.add(normalize(token))
  }
  return set
}

/**
 * @param {unknown} query
 * @returns {{
 *   raw: string, cjkTerms: string[], cjkGrams: string[], asciiTerms: string[],
 *   idents: string[], ips: string[], negations: string[],
 *   intent: 'procedural'|'episodic'|null, minLenOk: boolean
 * }}
 */
export function buildPlan(query) {
  const raw = typeof query === 'string' ? query : String(query ?? '')
  const s = normalize(raw)
  const minLenOk = s.replace(/\s+/g, '').length >= 2

  const ips = []
  // IPv4 先判并校验，避免 999.1.1.1 被当 IP。
  for (const m of s.matchAll(IPV4)) {
    if (validV4(m[0])) pushUnique(ips, m[0], CAP.ips)
  }
  for (const m of s.matchAll(IPV6)) pushUnique(ips, m[0].toLowerCase(), CAP.ips)

  // 地址从余下文本剔除：不进子词、不进 asciiTerms，也不参与中文片段。
  let rest = s
  for (const ip of ips) rest = rest.split(ip).join(' ')

  // 英文/数字整词（含标识符整词）——对汉字片段挖空后再切。
  const cased = camelTokens(raw)
  const asciiTerms = []
  const idents = []
  const asciiSrc = rest.replace(CJK_RUN, ' ')
  for (const m of asciiSrc.matchAll(ASCII_TOKEN)) {
    const token = m[0].replace(/[._:/\\-]+$/, '')
    if (!token) continue
    pushUnique(asciiTerms, token, CAP.asciiTerms)
    const isIdent = /[._:/\\-]/.test(token) || cased.has(token)
    if (!isIdent) continue
    // 标识符：整词 + 各子词都进 idents（打分时按文本去重取最大权重，不会重复计分）。
    for (const part of subwords(token)) {
      if (part.length >= 2) pushUnique(idents, part, CAP.idents)
    }
  }

  // 中文片段：先删多字虚词，再按单字虚词断开。
  const cjkTerms = []
  const cjkGrams = []
  for (const m of rest.matchAll(CJK_RUN)) {
    let run = m[0]
    for (const phrase of STOP_PHRASES) if (run.includes(phrase)) run = run.split(phrase).join(STUB)
    let seg = ''
    for (const ch of run) {
      if (ch === STUB || STOP_CHARS.has(ch)) {
        flushSegment(seg, cjkTerms, cjkGrams)
        seg = ''
        continue
      }
      seg += ch
    }
    flushSegment(seg, cjkTerms, cjkGrams)
  }

  const negations = []
  for (const ch of NEGATION_CHARS) if (s.includes(ch)) pushUnique(negations, ch, CAP.negations)
  for (const w of NEGATION_WORDS) if (asciiTerms.includes(w)) pushUnique(negations, w, CAP.negations)

  let intent = null
  if (PROCEDURAL_WORDS.some((w) => s.includes(w))) intent = 'procedural'
  else if (EPISODIC_WORDS.some((w) => s.includes(w))) intent = 'episodic'

  return { raw, cjkTerms, cjkGrams, asciiTerms, idents, ips, negations, intent, minLenOk }
}

/**
 * @param {string} seg @param {string[]} terms @param {string[]} grams
 */
function flushSegment(seg, terms, grams) {
  if (seg.length >= 2) pushUnique(terms, seg, CAP.cjkTerms)
  for (let i = 0; i + 1 < seg.length; i++) pushUnique(grams, seg.slice(i, i + 2), CAP.cjkGrams)
}
