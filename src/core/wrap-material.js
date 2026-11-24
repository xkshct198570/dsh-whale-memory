/**
 * 会话收尾素材层：turn 归一 → 纯文本渲染 → 指纹 → 预算裁剪。
 *
 * 为什么全部是纯函数、零 I/O：
 * - 收尾链路里「素材怎么变短」最容易被怀疑丢信息，纯函数才能对拍——同一份 turns
 *   在单测、面板预演、生产落盘三处得到同一份文本与同一个 hash。
 * - 裁剪必须按「整条消息」丢：半条消息会让 evidence 校验失败、也会让摘要引用不存在的句子；
 *   因此这里只做整条裁剪，不做字符截断。
 * - chars 按码点而不是 String.length 计：emoji/生僻字是代理对，按 UTF-16 长度会虚高一倍，
 *   预算判据会提前丢消息。
 */
import { createHash } from 'node:crypto'

/** 合法发言角色（其余一律当噪声丢掉，避免 system/tool 块混进蒸馏素材）。 */
const ROLES = new Set(['user', 'assistant'])

/** 码点长度：裁预算的唯一口径（Array.from 按码点切，不拆代理对）。 */
function charCount(text) {
  return Array.from(text).length
}

/**
 * 归一素材：过滤非法 role / 非字符串 / 空文本，text 去首尾空白，turn/seq 缺省 0。
 *
 * 为什么要在这里兜底而不是信任调用方：会话捕获层可能把工具结果、系统提示、空 delta
 * 一起塞进来；蒸馏提示词只接受「谁说了什么」，脏输入会直接变成模型幻觉的温床。
 *
 * @param {{turns?: Array<{role?: string, text?: string, turn?: number, seq?: number}>,
 *   summary?: string}} [material] 原始素材（缺省当空材料）
 * @returns {{turns: Array<{role: 'user'|'assistant', text: string, turn: number, seq: number}>,
 *   chars: number}} 归一后的 turn 列表与码点总数
 */
export function normalizeMaterial(material) {
  const source = material && typeof material === 'object' ? material : {}
  const raw = Array.isArray(source.turns) ? source.turns : []
  const turns = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const role = typeof item.role === 'string' ? item.role.trim() : ''
    if (!ROLES.has(role)) continue
    if (typeof item.text !== 'string') continue
    const text = item.text.trim()
    if (!text) continue
    turns.push({
      role,
      text,
      // 只认有限数字：捕获层偶尔把 turn 写成字符串或 undefined，统一落 0 更可预测。
      turn: Number.isFinite(item.turn) ? item.turn : 0,
      seq: Number.isFinite(item.seq) ? item.seq : 0,
    })
  }
  let chars = 0
  for (const turn of turns) chars += charCount(turn.text)
  return { turns, chars }
}

/**
 * 渲染素材纯文本：每行 `[uN] 文本` / `[aN] 文本`，N 为同角色的第几条。
 *
 * 为什么带序号：蒸馏要求 evidence 逐字照抄原文片段，序号让「第几句、谁说的」可回溯；
 * 同一角色跨轮编号（u1/u2…）而不是按 turn 号，是因为 turn 号可能缺省或重复。
 *
 * @param {{turns?: Array<object>}|object} [material] 原始或已归一的素材
 * @returns {string} 以 '\n' 连接的素材文本；空材料返回 ''
 */
export function materialText(material) {
  const { turns } = normalizeMaterial(material)
  const counters = { user: 0, assistant: 0 }
  const lines = turns.map((turn) => {
    counters[turn.role] += 1
    const tag = turn.role === 'user' ? 'u' : 'a'
    return `[${tag}${counters[turn.role]}] ${turn.text}`
  })
  return lines.join('\n')
}

/**
 * 素材指纹：对 materialText 的 UTF-8 字节做 sha256，取前 16 位小写 hex。
 *
 * 用途是「同一段会话只蒸馏一次」的幂等键；空材料返回 ''（不产出假指纹，
 * 否则空会话会被当成重复素材而静默跳过）。
 *
 * @param {{turns?: Array<object>}|object} [material]
 * @returns {string} 16 位小写 hex；空材料 ''
 */
export function materialHash(material) {
  const text = materialText(material)
  if (!text) return ''
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 预算裁剪：先按整轮留最近 maxTurns 条，再从最旧整条丢弃直到码点总数 ≤ maxChars。
 *
 * 两条硬约束：
 * - 绝不切半条消息（半条消息会让 evidence 校验必然失败，也会让摘要引用不存在的句子）。
 * - 至少保留最后一条：即使单条自身就超 maxChars 也不清空——清空等于把「最近一句」
 *   丢给模型当空素材，收尾报告会变成「无可用素材」，比超预算更糟。
 *
 * @param {Array<{text?: string}>} [turns] 任意 turn 数组（不修改入参）
 * @param {{maxTurns?: number, maxChars?: number}} [options] 预算（缺省 20 条 / 12000 码点）
 * @returns {Array<object>} 裁剪后的新数组（元素为浅拷贝，防止调用方回写）
 */
export function trimMaterial(turns, { maxTurns = 20, maxChars = 12000 } = {}) {
  const source = Array.isArray(turns) ? turns : []
  const turnLimit = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 20
  const charLimit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 12000
  const kept = source.slice(Math.max(0, source.length - turnLimit)).map((turn) => (
    turn && typeof turn === 'object' ? { ...turn } : turn
  ))
  const totalChars = () => kept.reduce((sum, turn) => (
    sum + charCount(String(turn && typeof turn === 'object' ? (turn.text ?? '') : ''))
  ), 0)
  while (kept.length > 1 && totalChars() > charLimit) kept.shift()
  return kept
}
