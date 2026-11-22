/**
 * 采纳信号判定（L2 机制层，无 IO）：回复文本是否真的「用上」了注入的记忆节点。
 *
 * 为什么需要弱信号：注入只是"把旧事放进上下文"，不等于模型采纳了它。没有回复侧的
 * 引用证据时，adoptionRate 恒 0、未采纳 Top10 等同全部已注入查询——观测闭环自欺。
 * 这里只看字面可复核的证据（原文窗口 / 中文 bigram 覆盖），不猜语义、不调模型：
 * 判错可解释、可复现，代价是改写幅度大的回复可能漏判（宁可漏判，也不伪造采纳）。
 */
import { normalize } from './tokenize.js'

/** 节点正文短于该长度不产生采纳证据（短句几乎必然与回复撞词）。 */
export const MIN_NODE_CHARS = 8
/** 原文窗口长度：归一化后任一该长度连续片段出现在回复里即视为引用。 */
export const WINDOW_CHARS = 10
/** bigram 覆盖判据：节点中文 bigram 数下限与覆盖率下限（改写型回复的弱证据）。 */
export const BIGRAM_MIN = 5
export const BIGRAM_RATIO = 0.6

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g

/**
 * 抽取节点文本的可复核证据片段。
 * @param {unknown} text 节点正文
 * @returns {{ chars: number, windows: string[], bigrams: string[] }}
 *   chars: 归一化后字符数；windows: 去重后的滑动窗口；bigrams: 去重后的中文 2 字窗口
 */
export function nodeEvidence(text) {
  const s = normalize(text)
  const chars = s.length
  /** @type {string[]} */
  const windows = []
  if (chars >= WINDOW_CHARS) {
    const seen = new Set()
    for (let i = 0; i + WINDOW_CHARS <= chars; i += 1) {
      const w = s.slice(i, i + WINDOW_CHARS)
      if (seen.has(w)) continue
      seen.add(w)
      windows.push(w)
    }
  }
  /** @type {string[]} */
  const bigrams = []
  const seenGram = new Set()
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0]
    for (let i = 0; i + 1 < run.length; i += 1) {
      const g = run.slice(i, i + 2)
      if (seenGram.has(g)) continue
      seenGram.add(g)
      bigrams.push(g)
    }
  }
  return { chars, windows, bigrams }
}

/**
 * 判定一条回复是否引用了某个记忆节点。
 *
 * 命中条件（任一）：
 * 1. 强证据——节点归一化后的某个 10 字连续窗口原样出现在回复里；
 * 2. 弱证据——节点中文 bigram ≥ `BIGRAM_MIN` 且有 ≥ `BIGRAM_RATIO` 的比例出现在回复里。
 * 节点正文 < `MIN_NODE_CHARS` 时恒不采纳（证据太弱，任何命中都是巧合）。
 *
 * @param {unknown} replyText 模型回复文本（单步内文本增量拼接结果）
 * @param {unknown} nodeText 注入的记忆节点正文
 * @returns {{ adopted: boolean, reason: 'window' | 'bigram' | 'too_short' | 'no_evidence', matched?: string }}
 */
export function judgeAdoption(replyText, nodeText) {
  const reply = normalize(replyText)
  const evidence = nodeEvidence(nodeText)
  if (evidence.chars < MIN_NODE_CHARS || !reply) {
    return { adopted: false, reason: evidence.chars < MIN_NODE_CHARS ? 'too_short' : 'no_evidence' }
  }
  for (const w of evidence.windows) {
    if (reply.includes(w)) return { adopted: true, reason: 'window', matched: w }
  }
  if (evidence.bigrams.length >= BIGRAM_MIN) {
    let hit = 0
    for (const g of evidence.bigrams) if (reply.includes(g)) hit += 1
    if (hit / evidence.bigrams.length >= BIGRAM_RATIO) {
      return { adopted: true, reason: 'bigram' }
    }
  }
  return { adopted: false, reason: 'no_evidence' }
}

/**
 * 批量判定一次召回注入的节点集合。
 * @param {unknown} replyText
 * @param {Array<{ id?: string, text?: string }>} nodes 本次注入的节点（id/text）
 * @returns {{ adopted: boolean, nodeIds: string[], reason: string }}
 */
export function judgeReply(replyText, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  /** @type {string[]} */
  const nodeIds = []
  for (const node of list) {
    const verdict = judgeAdoption(replyText, node?.text)
    if (verdict.adopted) nodeIds.push(String(node?.id ?? ''))
  }
  return { adopted: nodeIds.length > 0, nodeIds, reason: nodeIds.length > 0 ? 'cited' : 'no_citation' }
}
