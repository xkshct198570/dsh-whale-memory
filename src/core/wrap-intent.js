/**
 * 收尾意图判定：纯确定性规则，不调模型。
 *
 * 为什么不用模型：这是「每一轮都可能跑」的判定，模型调用会让每条消息多一次网络往返与
 * 成本；规则命中的场景（收尾/收工/换会话）语义非常固定，误判代价也只是多问用户一句。
 * 判定顺序即优先级，顺序不能换：
 *   问句排除必须在强词之前——「怎么开新会话？」含「新会话」强词，但它是提问不是命令；
 *   否定排除必须在强词之前——「先别收尾」含「收尾」，照强词走会当场把会话切掉。
 *
 * 已知误伤与处置：弱词（总结一下/沉淀一下/记一下）只有在带上下文词（这次/这轮/会话…）时
 * 才算收尾；但「这次总结一下这篇文章」也带「这次」，那是让人总结一篇外部内容而不是收尾。
 * 因此弱词命中且文本还含内容指代（文章/代码/文件/文档/这段/这篇）时判 `weak_about_content`；
 * 唯一的例外是同时提到「会话」——「这次总结一下会话里的东西」确实是收尾诉求。
 * 强词里只有「收尾/收工」本身歧义（也能指把一段代码/文档做完）：带内容指代且没有
 * 会话上下文词时判 `strong_about_content`，避免「把这段代码收尾」触发模型调用。
 * 其余强词（换会话/记一下这次/结束这轮…）语义只可能指向会话，不受内容指代影响。
 */

/** 强意图词：命中即视为收尾诉求（顺序即优先级）。 */
export const WRAP_INTENT_STRONG = Object.freeze([
  '收尾', '收工', '先到这', '今天到这', '结束这轮', '换会话', '新会话', '下次再聊',
  '下次再说', '记一下这次', '把教训记下', '记录这次', '沉淀一下这次', '总结一下这次',
  '这轮就到这',
])

/** 弱意图词：只有同时出现上下文词才算收尾（避免「总结一下这篇文章」误伤）。 */
export const WRAP_INTENT_WEAK = Object.freeze(['总结一下', '沉淀一下', '记一下'])

/** 上下文词：把弱词锚定到「本次会话」。 */
const CONTEXT_WORDS = Object.freeze(['这次', '这轮', '本轮', '今天', '刚才', '本次', '会话'])

/** 内容指代：出现即说明弱词指向外部内容（文章/代码/文件…），不是收尾。 */
const CONTENT_WORDS = Object.freeze(['文章', '代码', '文件', '文档', '这段', '这篇'])

/** 否定词：显式说了不要记/不要收尾，必须整条否决（优先于强词）。 */
const NEGATED_WORDS = Object.freeze([
  '不要记', '别记', '不用记', '别收尾', '不要收尾', '先别收尾', '别总结',
])

/** 尾随装饰符（不含问号——问号单独判）。 */
const TRAILING_DECOR = /[\s\u3000。！!，,、~～…·\.]+$/u

/**
 * 问句判定：去尾随标点空白后，以 `?`/`？` 结尾，或以「吗」「呢」「么」结尾。
 *
 * @param {string} text 已 trim 的非空文本
 * @returns {boolean}
 */
function isQuestion(text) {
  const stripped = text.replace(TRAILING_DECOR, '')
  if (stripped.endsWith('?') || stripped.endsWith('？')) return true
  return stripped.endsWith('吗') || stripped.endsWith('呢') || stripped.endsWith('么')
}

/**
 * 检测收尾意图。
 *
 * @param {string} text 用户输入原文（非字符串/空白 → empty）
 * @param {{maxChars?: number}} [opts] maxChars 为长文本阈值（缺省 80 码点）
 * @returns {{match: boolean, reason: string, phrase?: string}} reason 取值：
 *   empty / too_long / question / negated / quoted / strong / weak / weak_without_context /
 *   weak_about_content / no_signal；phrase 为命中的意图词（诊断/面板展示用）
 */
export function detectWrapIntent(text, opts = {}) {
  const maxChars = Number.isFinite(opts && opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : 80
  if (typeof text !== 'string') return { match: false, reason: 'empty' }
  const raw = text.trim()
  if (!raw) return { match: false, reason: 'empty' }
  if (Array.from(raw).length > maxChars) return { match: false, reason: 'too_long' }
  if (isQuestion(raw)) return { match: false, reason: 'question' }
  if (NEGATED_WORDS.some((word) => raw.includes(word))) return { match: false, reason: 'negated' }
  // 引用块里的「收尾」多半是转述别人的话（贴了一段文档/聊天记录），不能当命令执行。
  const quoted = raw.split(/\r?\n/).some((line) => line.trimStart().startsWith('>'))
  if (quoted) return { match: false, reason: 'quoted' }

  const strong = WRAP_INTENT_STRONG.find((word) => raw.includes(word))
  if (strong) {
    const ambiguous = strong === '收尾' || strong === '收工'
    const content = CONTENT_WORDS.some((word) => raw.includes(word))
    const anchored = CONTEXT_WORDS.some((word) => raw.includes(word)) || raw.includes('会话')
    if (ambiguous && content && !anchored) {
      return { match: false, reason: 'strong_about_content', phrase: strong }
    }
    return { match: true, reason: 'strong', phrase: strong }
  }

  const weak = WRAP_INTENT_WEAK.find((word) => raw.includes(word))
  if (!weak) return { match: false, reason: 'no_signal' }
  const anchored = CONTEXT_WORDS.some((word) => raw.includes(word))
  if (!anchored) return { match: false, reason: 'weak_without_context', phrase: weak }
  const aboutContent = CONTENT_WORDS.some((word) => raw.includes(word)) && !raw.includes('会话')
  if (aboutContent) return { match: false, reason: 'weak_about_content', phrase: weak }
  return { match: true, reason: 'weak', phrase: weak }
}
