// 职责：隐私体检与脱敏、命中区间/同句端口提示工具；依赖：无 import（纯正则/字符串）。

/** 脱敏占位符（隐私命中一律替换成它，长度稳定、可被检索到"这里被脱敏过"）。 */
const MASK = '[已脱敏]'

/**
 * 隐私规则：只认"明显是凭证/个人身份"的样式，宁可多脱敏也不漏。
 * 顺序有意义：先长样式（Bearer/sk）、再赋值型（密码）、最后短数字（手机号/身份证）。
 * @type {RegExp[]}
 */
const PRIVACY_RULES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:password|passwd|密码)\s*[:=：]\s*\S+/gi,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g,
]

/** 句界（端口要求"同句"）。
 * @param {string} text */
const SENTENCE_MARK = /[。！？!?；;\n]/

/** 端口语境提示词。 */
const PORT_HINT = /端口|port|回调|webhook/i

/**
 * 隐私体检：密钥样式 / 赋值型密码 / 手机号 / 邮箱 / 身份证。
 *
 * 为什么默认脱敏而不是拒绝：长期记忆的价值在上下文，直接拒会丢掉整句；
 * 把命中片段替换成占位符，既保住语义又不把凭证写进库。redact=false 用于严格入口（导入/面板原文）。
 *
 * @param {unknown} text 原文
 * @param {{ redact?: boolean }} [opts] redact=false 时命中即判不合格（不再改写文本）
 * @returns {{ ok: boolean, text: string, reason?: string }}
 *   ok=false 仅在 redact=false 且有命中时出现（reason='privacy'）；
 *   redact=true 且有命中时 ok=true、text 为脱敏后文本、reason='privacy_redacted'。
 */
export function privacyCheck(text, { redact = true } = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  let out = source
  let hits = 0
  for (const re of PRIVACY_RULES) {
    out = out.replace(re, () => {
      hits += 1
      return MASK
    })
  }
  if (hits === 0) return { ok: true, text: out }
  if (!redact) return { ok: false, text: source, reason: 'privacy' }
  return { ok: true, text: out, reason: 'privacy_redacted' }
}

/**
 * 收集正则命中区间（供端口剔除"日期/版本/路径里的数字"）。
 * @param {string} text @param {RegExp} re
 * @returns {Array<{ at: number, end: number, raw: string, match: RegExpMatchArray }>}
 */
export function spansOf(text, re) {
  const out = []
  for (const match of text.matchAll(re)) {
    const at = Number(match.index ?? 0)
    out.push({ at, end: at + match[0].length, raw: match[0], match })
  }
  return out
}

/** 命中是否落在保留区间内（区间半开 [at,end)）。 */
export function insideSpans(span, spans) {
  for (const s of spans) {
    if (span.at < s.end && span.end > s.at) return true
  }
  return false
}

/** 位置所在句子是否含端口语境词（"同句"的判定口径）。 */
export function sentenceHasPortHint(text, at) {
  let start = at
  let end = at
  while (start > 0 && !SENTENCE_MARK.test(text[start - 1])) start -= 1
  while (end < text.length && !SENTENCE_MARK.test(text[end])) end += 1
  return PORT_HINT.test(text.slice(start, end))
}
