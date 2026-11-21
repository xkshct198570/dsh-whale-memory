/**
 * 文本口径（L2 机制层，无 IO）：归一化、中文 bigram、内容哈希、标识符子词、相似度。
 *
 * 与 queryplan/search 共用同一套口径，避免"入库切法"和"查询切法"不一致：
 * - normalize：NFKC（全角→半角）→ 压缩空白 → trim → 仅 ASCII 小写（中文保持原样）。
 * - bigrams：每个连续汉字片段取 2 字窗口，去重后空格连接（写入 nodes.text_bigrams）。
 * - contentHash：normalize 后 sha256 hex（跨身份去重、双轨同步的幂等键）。
 * - subwords：按 [._:/\-] 切分，并保留原词（子词用于标识符检索）。
 * - similarity：bigram Jaccard（0..1，稳定，不依赖随机/模型）。
 */
import { createHash } from 'node:crypto'

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g
const WORD_SPLIT = /[^\p{L}\p{N}]+/u

/**
 * 归一化：NFKC、空白压缩、trim、ASCII 小写；中文不做大小写转换。
 * @param {unknown} text
 * @returns {string}
 */
export function normalize(text) {
  if (typeof text !== 'string') return ''
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * 中文 2 字窗口（含扩展区），空空格连接；混合文本里只取汉字片段，英文由 trigram 负责。
 * @param {unknown} text
 * @returns {string} 例：`中华 华人`
 */
export function bigrams(text) {
  const s = normalize(text)
  if (!s) return ''
  const seen = new Set()
  const out = []
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0]
    for (let i = 0; i + 1 < run.length; i++) {
      const gram = run.slice(i, i + 2)
      if (seen.has(gram)) continue
      seen.add(gram)
      out.push(gram)
    }
  }
  return out.join(' ')
}

/**
 * 内容哈希：normalize 后 sha256 hex（大小写/全半角/多余空白不产生新哈希）。
 * @param {unknown} text
 * @returns {string}
 */
export function contentHash(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex')
}

/**
 * 标识符按 [._:/\-] 切子词，并保留原词（原词在前）。
 * 例：`whale.db` -> `['whale.db','whale','db']`
 * @param {unknown} token
 * @returns {string[]}
 */
export function subwords(token) {
  const t = normalize(token)
  if (!t) return []
  const out = [t]
  for (const part of t.split(/[._:/\\-]+/)) {
    if (part && part !== t && !out.includes(part)) out.push(part)
  }
  return out
}

/** @param {string} text @returns {Set<string>} */
function bag(text) {
  const s = normalize(text)
  const set = new Set()
  for (const gram of s.matchAll(CJK_RUN)) {
    const run = gram[0]
    for (let i = 0; i + 1 < run.length; i++) set.add('g:' + run.slice(i, i + 2))
  }
  for (const word of s.split(WORD_SPLIT)) if (word) set.add('w:' + word)
  return set
}

/**
 * bigram Jaccard 相似度（0..1）；两边全空视为 0（无证据），完全相同文本为 1。
 * @param {unknown} a @param {unknown} b
 * @returns {number}
 */
export function similarity(a, b) {
  const A = bag(a)
  const B = bag(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  const union = A.size + B.size - inter
  return union > 0 ? inter / union : 0
}
