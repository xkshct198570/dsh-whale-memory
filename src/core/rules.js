/**
 * 规则引擎（架构书 §3.2 / §4.2 / §4.3 / §5.1）：纯函数、零宿主/DB import。
 *
 * 为什么单独成文件而不塞进 writer/backend：规则识别要在 pre-step 快筛、面板手动升格、
 * 反思 job 三处复用；一旦带上 DB/宿主依赖，就只能整库跑，无法脱库单测，也没法在
 * 失败开放路径里安全调用。这里只允许 `node:crypto`（dedupeKey 的稳定 hash）。
 *
 * 信号权重（§4.2，确定性优先）：
 * - owner 显式定规 0.85（普通必须/禁止）～0.95（记成铁律/以后都/永远/一律）
 * - 纠正既有行为 0.65（不对/改成/别再）～0.80（带明确替代）
 * - 可机检 +0.05（端口/路径/命令/数字阈值/流程词）
 * - 隐私/密钥/身份证/手机号 → rejectReason='privacy'，一律不升格
 * - 纯描述句（端口固定为某值）→ ruleLike=false；模糊偏好（尽量/最好/注意点）→ 'preference'
 *
 * **重复出现 +0.10 由调用方加权**（本函数固定返回 repeat=0）：同一条消息里自重复几乎
 * 只出现在粘贴日志里，文本内计数会误把噪声当证据；跨会话/跨轮次重复必须查库，
 * 只有 R3 编排层（rule-engine.js）知道上一版候选的 hits，权重在那边叠加更准。
 * 所以 detectSignals 只负责单条文本的静态信号 + score，repeat 字段留给调用方改写。
 *
 * 返回值约定：会失败的一律返回对象，不返回 undefined；compileRule 为
 * `{ ok, text, error, chars, warn }`，error 为 null 表示成功。
 */

import { createHash } from 'node:crypto'

/** 规则正文推荐长度（§3.1）：超过只告警，不拒绝。 */
export const RULE_RECOMMENDED_CHARS = 200
/** 规则正文硬顶（§3.1）：超过直接拒绝，避免注入预算被单条撑爆。 */
export const RULE_HARD_CHARS = 500
/** 自动置顶默认分数门槛（§5.1）。 */
export const DEFAULT_MIN_SCORE = 0.82
/** 默认模式（§5.1）：shadow=只产候选，最保守。 */
export const DEFAULT_MODE = 'shadow'

/** 域枚举（顺序即同分时的优先级）。 */
export const DOMAINS = ['file-hygiene', 'memory', 'network', 'ui', 'process', 'general']

// ---------------------------------------------------------------------------
// 关键词表：全部小写；中文不受大小写影响，英文词用于英文祈使句。
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = {
  'file-hygiene': [
    '文件', '文档', '报告', '过程稿', '中间产物', '归档', '删除', '删源', '阅后即焚',
    '备份', '临时件', '目录', '路径', '清理', 'trash', 'sha256', '落点', '源文件', '附件',
  ],
  memory: [
    '记忆', '召回', '注入', '规则', '铁律', '台账', '记录', '置顶', '候选', '知识库',
    'memory', 'pin', 'pinned', '上下文',
  ],
  network: [
    '端口', '网关', '代理', '网络', '防火墙', '域名', '隧道', 'websocket', 'http', 'https',
    'api', 'url', 'dns', 'host', '3002', '8080', '3001', 'ssrf', '反连',
  ],
  ui: [
    '面板', '界面', '按钮', '卡片', '前端', '样式', '客户端', '弹窗', '文案', 'ui',
    'locale', 'gui', '设置', '抽屉', '三语', 'i18n',
  ],
  process: [
    '流程', '步骤', '收尾', '交接', '提交', 'commit', '测试', '回归', '施工', '开工',
    '验收', '部署', 'pipeline', 'workflow', '排障', '四件套', '基线', '重构',
  ],
}

// 显式定规标记。强标记决定 0.95（「记成铁律」这类不可误读的定规语境）。
const EXPLICIT_STRONG_RE = /(记成铁律|铁律|以后都|以后一律|以后不要|以后别|从此以后|从此|永久|永远|一律|任何情况下|任何时候|每次都要|永远不要|always|forever|permanently)/i
// 普通显式约束：必须/禁止/不得/只能，以及英文 must/never/only。
const EXPLICIT_RE = /(必须|务必|禁止|不得|不许|不准|只能|仅能|只允许|切记|严禁|不要|别再|别用|别把|\bnever\b|\bmust\b|\bonly\b|\bshall\b|\brequired?\b|\bforbidden\b)/i
// 纠正既有行为（§4.2 0.65–0.80）。
const CORRECTION_RE = /(不对|错了|不是这样|不应该|应该|改成|改为|纠正|别再|而不是|其实应该|\binstead\b|\bshould be\b|\bnot .{0,8}but\b)/i
// 强纠正：带明确替代动作，抬到 0.80。
const CORRECTION_STRONG_RE = /(改成|改为|应该|别再|以后不要|而不是|\binstead\b|\bshould be\b)/i
// 句首祈使（无定规标记时仍算祈使句，供 imperative 字段使用）。
const DIRECTIVE_HEAD_RE = /^\s*(?:请|用|改|删|写|跑|走|开|关|停|把|将|先|别|不要|必须|禁止|以后|记得|记住|注意|保留)/
// 任何指令/约束味（用于判断一句话是不是可抽的祈使句）。
const IMPERATIVE_RE = /(以后|必须|禁止|不得|不许|不准|只能|只允许|一律|永远|务必|不要|别再|别用|别把|改成|改为|应该|切记|严禁|\bnever\b|\bmust\b|\balways\b|\bonly\b|\bshall\b)/i
// 可机检/可执行：端口、路径、命令、数字阈值、流程词（§4.2 +0.05）。
const MACHINE_RE = /(\/[\w.\-/]*[\w]|\\[\w.\\-]+|\b\d{2,5}\b|端口|命令|脚本|阈值|流程|步骤|\b(?:npm|pnpm|git|node|curl|bash|docker|sql|sqlite3|rm|mv|cp)\b|\.(?:js|mjs|cjs|json|md|py|sh|db)\b|https?:\/\/)/i
// 隐私/密钥：命中即拒绝。刻意不收裸 `token`——「token 成本优先」是正常规则。
const PRIVACY_RE = /(api[_-]?key|secret[_-]?key|access[_-]?key|私钥|密钥|密码|口令|身份证|银行卡|信用卡|passport|\bsk-[A-Za-z0-9_-]{4,}|\bBearer\s+[A-Za-z0-9._-]{10,}|1[3-9]\d{9}|\b\d{17}[\dXx]\b)/i
// 模糊偏好：降级为偏好，不置顶（§4.3 禁止模棱两可）。强显式标记在场时不降级。
const VAGUE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|方便的时候|maybe|probably)/i
// 理由句：整句丢弃（理由进 context_note/审计，不进正文）。
const REASON_HEAD_RE = /^\s*(?:因为|由于|原因是|理由是|毕竟|主要是|考虑到|之所以|所以|这是为了|免得|不然)/

// 冲突判定用到的互相排斥值对（异值冲突，§4.2）。
const VALUE_PAIRS = [
  ['中文', '英文'], ['开启', '关闭'], ['保留', '删除'], ['自动', '手动'],
  ['本地', '云端'], ['置顶', '不置顶'], ['允许', '禁止'],
]

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function asText(text) {
  return String(text ?? '')
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** 归一化：NFKC + 小写 + 去空白/标点/符号，只留字母与数字（dedupe/similarity 共用）。 */
export function normalizeRuleText(text) {
  return asText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u200b-\u200d\ufeff]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 去重键：归一化文本的 sha256 前 16 hex（稳定、与 locale/标点无关）。 */
export function dedupeKey(text) {
  return createHash('sha256').update(normalizeRuleText(text), 'utf8').digest('hex').slice(0, 16)
}

function normalizeDomain(domain) {
  const v = asText(domain).trim().toLowerCase()
  if (DOMAINS.includes(v)) return v
  const sanitized = v.replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return sanitized || 'general'
}

function scopeOf(workspace) {
  return workspace === null || workspace === undefined ? '' : asText(workspace).trim()
}

function countHits(text, words) {
  let n = 0
  for (const w of words) {
    let idx = 0
    while ((idx = text.indexOf(w, idx)) !== -1) {
      n += 1
      idx += w.length
    }
  }
  return n
}

/** 域推断：按关键词命中数取最大，同分按 DOMAINS 顺序（确定性，无模型）。 */
function inferDomain(text) {
  if (!text) return 'general'
  const lower = text.toLowerCase()
  let best = 'general'
  let bestScore = 0
  for (const domain of DOMAINS) {
    if (domain === 'general') continue
    const score = countHits(lower, DOMAIN_KEYWORDS[domain])
    if (score > bestScore) {
      best = domain
      bestScore = score
    }
  }
  return best
}

// 条件抽取：只保留原文片段，不补写、不推理。
// 组合成单条交替正则，按出现顺序返回，避免分组重排。
const CONDITION_RE = /例外\s*[：:]\s*([^。；;\n]+)|(除非[^。；;\n]{1,60})|(当(?!前|初|时)[^。；;\n]{1,60}?时)/g

function extractConditions(text) {
  const out = []
  const seen = new Set()
  CONDITION_RE.lastIndex = 0
  let m
  while ((m = CONDITION_RE.exec(text)) !== null) {
    // m[1] 是「例外：」后面的条件本体（去掉标记），其余保留原短语（除非/当…时）。
    const raw = (m[1] || m[2] || m[3] || '').trim()
    if (!raw) continue
    const cond = raw.replace(/[，,；;、\s]+$/, '')
    if (!cond || seen.has(cond)) continue
    seen.add(cond)
    out.push(cond)
    // 例外/除非/当…时 三类共留 4 条即可；再多说明规则本身已经不可机读。
    if (out.length >= 4) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 提案闸：只有"单句、短、陈述"的文本才进入信号检测
// ---------------------------------------------------------------------------

/** 提案闸硬顶：超过 120 码点的句子一律不是规则陈述（任务书/长文不进候选）。 */
export const RULE_STATEMENT_MAX_CHARS = 120
/** 请求/任务动词：出现即说明用户在提问或派活，不是在下规则。 */
const REQUEST_VERB_RE = /(?:请|帮我|帮忙|对比|审查|分析|解释|查一下|总结|告诉我|看看)/
/** 代码块/行内代码/Markdown 链接/裸 URL：规则陈述不带这些（带出处/片段的都是转述）。 */
const CODE_OR_LINK_RE = /(?:```|`[^`]*`|https?:\/\/|www\.|!?\[[^\]]*\]\([^)]*\))/

/**
 * 判断一句话是不是"可以进入提案闸的规则陈述"（架构书 §3.1）。
 *
 * 判据：单句、≤120 码点、无问号、无换行、无请求动词、无代码块/链接。
 * 这是**前置闸**（hook 在 createProposal 之前调用）：任务书、提问、多句长文一律不产候选，
 * 避免"用户贴一段施工任务 → 机器把任务描述收成铁律"的误触发（R9-19）。
 *
 * @param {string} text 用户原句
 * @returns {boolean}
 */
export function isRuleStatement(text) {
  const raw = asText(text)
  if (!raw.trim()) return false
  if (Array.from(raw).length > RULE_STATEMENT_MAX_CHARS) return false
  if (/[\r\n]/.test(raw)) return false
  if (/[?？]/.test(raw)) return false
  if (CODE_OR_LINK_RE.test(raw)) return false
  if (REQUEST_VERB_RE.test(raw)) return false
  // 单句：句末标点只允许出现在结尾；中间再有句末标点就是多句（「因为…。所以…」）。
  const body = raw.trim().replace(/[。！!]+$/, '')
  if (/[。！!]/.test(body)) return false
  return true
}

// ---------------------------------------------------------------------------
// 信号检测
// ---------------------------------------------------------------------------

/**
 * 从单条文本抽规则信号（确定性；不查库、不调模型）。
 *
 * @param {string} text 用户/owner 原文
 * @param {{ source?: string, workspace?: string }} [opts]
 *   source: owner|self|group|web|tool|unknown；workspace 透传给 compileRule 的作用域段。
 * @returns {{
 *   explicit: boolean, correction: boolean, imperative: boolean,
 *   domain: string, conditions: string[], score: number,
 *   ruleLike: boolean, rejectReason: string|null,
 *   repeat: number, source: string, workspace: string
 * }}
 */
export function detectSignals(text, opts = {}) {
  const raw = asText(text).trim()
  const source = asText(opts.source || 'unknown').trim().toLowerCase() || 'unknown'
  const workspace = scopeOf(opts.workspace)
  const conditions = raw ? extractConditions(raw) : []
  const domain = inferDomain(raw)

  const explicitStrong = EXPLICIT_STRONG_RE.test(raw)
  const explicit = explicitStrong || EXPLICIT_RE.test(raw)
  const correction = CORRECTION_RE.test(raw)
  const correctionStrong = CORRECTION_STRONG_RE.test(raw)

  // 祈使：显式/纠正本身即祈使；否则看句首祈使动词（「写报告前先备份」）。
  const imperative = explicit || correction || DIRECTIVE_HEAD_RE.test(raw)

  let rejectReason = null
  if (PRIVACY_RE.test(raw)) {
    // 隐私优先：即使句子是「记成铁律」，带密钥也不能进库/注入。
    rejectReason = 'privacy'
  } else if (VAGUE_RE.test(raw) && !explicitStrong) {
    // 「以后尽量…」不是规则；强定规（铁律/永远）在场则不降级。
    rejectReason = 'preference'
  } else if (!explicit && !correction) {
    rejectReason = 'descriptive'
  }

  let score = 0
  if (explicit) score = explicitStrong ? 0.95 : 0.85
  else if (correction) score = correctionStrong ? 0.8 : 0.65
  // 可机检加成：有阈值/路径/命令/端口才加；没有规则信号时不要靠它把描述句抬成正分。
  if (score > 0 && MACHINE_RE.test(raw)) score += 0.05
  score = Math.min(1, round2(score))

  const ruleLike = Boolean((explicit || correction)
    && rejectReason !== 'descriptive'
    && rejectReason !== 'preference')

  return {
    explicit,
    correction,
    imperative,
    domain,
    conditions,
    score,
    ruleLike,
    rejectReason,
    // 文本内不自增；跨会话重复由 R3 查 hits 后加权（文件头已说明）。
    repeat: 0,
    source,
    workspace,
  }
}

// ---------------------------------------------------------------------------
// 文本编译
// ---------------------------------------------------------------------------

function stripNoise(text) {
  let s = text

  // Markdown 链接留标签、去 url；裸链接整段删。
  s = s.replace(/\[([^\]]{1,60})\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
  s = s.replace(/https?:\/\/[^\s）)\]]+/gi, '')
  // 链接删掉后残留的「（参考 ）」「，详见」直接丢弃（出处不属于规则正文）。
  s = s.replace(/[（(]\s*(?:参考|详见|链接|出处|来源)\s*[）)]?/g, '')
  s = s.replace(/[，,；;]\s*(?:参考|详见|链接|出处|来源)\s*[：:]?/g, '')
  // 出处/来源括注（理由与证据不进正文）。
  s = s.replace(/[（(]\s*(?:来源|出处|参考|链接|详见)\s*[：:][^）)]*[）)]/g, '')
  // URL 被删后留下的空括号。
  s = s.replace(/[（(]\s*[）)]/g, '')

  // 编号：1. / 2、 / （1） / ① / 一、 —— 逐行去掉，避免正文带序号。
  s = s.replace(/^[ \t]*(?:\d{1,2}[.、)）]|[（(]\d{1,2}[）)]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]{1,3}[、.])[ \t]*/gm, '')
  // 定规前缀（「记成铁律：」「规则：」）不是指令本体。
  s = s.replace(/^[ \t]*(?:记成铁律|铁律|规则|请记住|记住|注意)\s*[：:，,][ \t]*/, '')

  // 口水词：只在句首或标点后删，避免误伤正文（「别用」不能被当成「别」口水）。
  s = s.replace(/(^|[。；;！!？?\n，,])\s*(?:嗯+|啊+|那个|这个嘛|就是|其实|对了|顺便说一句|好吧|行吧|我觉得|我感觉|说实话|说白了|然后呢|呃+)[，,、\s]*/g, '$1')
  // 句尾征询/客套。
  s = s.replace(/[，,\s]*(?:好吗|可以吗|行吗|谢谢|辛苦了)[。！!？?]?$/g, '')

  return s.trim()
}

function splitSentences(text) {
  return text.split(/[。！？!?；;\n]+/).map((s) => s.trim()).filter(Boolean)
}

function stripInlineReason(sentence) {
  // 只删「，因为…」这种尾随理由；「不要因为忙就不备份」是规则本体，必须留。
  const m = sentence.match(/(?:，|,|；|;)\s*(?:因为|由于|原因是|理由是|之所以)[\s\S]*$/)
  if (!m) return sentence
  const head = sentence.slice(0, m.index).trim()
  return head && IMPERATIVE_RE.test(head) ? head : sentence
}

// 条件片段要从正文剥掉（条件只进「例外」槽），但不能把整句丢弃：
// 「以后都别删源文件，除非我明确要求保留」剥掉除非从句后仍是完整命令。
const CONDITION_STRIP_RE = /[；;，,]?\s*例外\s*[：:][^。；;\n]+|[；;，,]?\s*除非[^。；;\n]{1,60}|[；;，,]?\s*当(?!前|初|时)[^。；;\n]{1,60}?时/g

function stripConditions(sentence) {
  return sentence.replace(CONDITION_STRIP_RE, '').trim()
}

function isReasonSentence(sentence) {
  return REASON_HEAD_RE.test(sentence)
}

function isImperativeSentence(sentence) {
  return IMPERATIVE_RE.test(sentence) || DIRECTIVE_HEAD_RE.test(sentence)
}

/**
 * 把口语原文编译成指令文本（§4.3 模板）。
 *
 * 模板：`【规则·<域>】<祈使句>；例外：<条件>；作用域：<workspace|共享>。`
 * - 剥理由/链接/口水/编号；条件句不混进正文（否则「例外」出现两遍）。
 * - 无明确条件时省略「例外」段（不写空槽，避免「例外：」悬空）。
 * - 推荐 ≤200 字（只 warn）；硬顶 500 字（超限拒绝，正文不回显，防止半句被截断）。
 * - 理由只该进 context_note/审计，正文出现理由会诱发模型自行推翻规则（§3.1）。
 *
 * @param {string} text
 * @param {object} [signals] detectSignals 的返回值；缺字段会用文本重算补齐
 * @returns {{ ok: boolean, text: string, error: string|null, chars: number, warn: string|null }}
 */
export function compileRule(text, signals) {
  const raw = asText(text).trim()
  if (!raw) return { ok: false, text: '', error: 'empty', chars: 0, warn: null }

  // 调用方只给部分字段时，用文本重算兜底（domain/conditions 必须完整才不生成畸形模板）。
  const sig = signals && typeof signals === 'object'
    ? { ...detectSignals(raw, { source: signals.source, workspace: signals.workspace }), ...signals }
    : detectSignals(raw)

  if (sig.rejectReason) {
    return { ok: false, text: '', error: String(sig.rejectReason), chars: 0, warn: null }
  }
  if (!sig.ruleLike) {
    return { ok: false, text: '', error: 'not_rule', chars: 0, warn: null }
  }

  const cleaned = stripNoise(raw)
  const bodyParts = []
  for (const sentence of splitSentences(cleaned)) {
    const trimmed = stripInlineReason(stripConditions(sentence)).trim()
    if (!trimmed || isReasonSentence(trimmed)) continue
    if (!bodyParts.includes(trimmed)) bodyParts.push(trimmed)
  }
  // 优先只留祈使句；若整段都是「以后…」之外的陈述，则退回全部非理由句（仍必须有指令味）。
  const imperativeParts = bodyParts.filter(isImperativeSentence)
  const chosen = (imperativeParts.length ? imperativeParts : bodyParts)
    .map((s) => s.replace(/[，,、\s]+$/, '').trim())
    .filter(Boolean)
  if (!chosen.length) return { ok: false, text: '', error: 'not_rule', chars: 0, warn: null }

  const domain = normalizeDomain(sig.domain || inferDomain(raw))
  const scope = scopeOf(sig.workspace) || '共享'
  const conditions = Array.isArray(sig.conditions)
    ? sig.conditions.map((c) => asText(c).trim()).filter(Boolean)
    : extractConditions(raw)

  const pieces = [`【规则·${domain}】${chosen.join('；')}`]
  if (conditions.length) pieces.push(`例外：${conditions.join('、')}`)
  pieces.push(`作用域：${scope}`)
  const compiled = `${pieces.join('；')}。`

  const chars = compiled.length
  if (chars > RULE_HARD_CHARS) {
    // 不返回被截断的正文：半句规则比没有规则更危险。
    return { ok: false, text: '', error: 'too_long', chars, warn: null }
  }
  return {
    ok: true,
    text: compiled,
    error: null,
    chars,
    warn: chars > RULE_RECOMMENDED_CHARS ? 'long' : null,
  }
}

// ---------------------------------------------------------------------------
// 升格判定
// ---------------------------------------------------------------------------

/**
 * 是否自动置顶（§4.2 / §5.1）。
 *
 * 规则：mode=off 或 rules.enabled=false → reject；隐私/偏好/非规则 → reject；
 * 只有 mode=auto + source=owner + 显式 + score≥minScore(默认0.82) 才 auto；
 * 其余（self/group/web、纠正、分数不够、shadow 模式）最高 shadow（只产候选）。
 *
 * @param {object} signals detectSignals 返回值
 * @param {{ rules?: { enabled?: boolean, mode?: string, minScore?: number }, enabled?: boolean, mode?: string, minScore?: number }} [config]
 *   同时接受宿主配置组（config.rules）与扁平测试配置。
 * @returns {'auto'|'shadow'|'reject'}
 */
export function shouldPromote(signals, config = {}) {
  if (!signals || typeof signals !== 'object') return 'reject'
  const cfg = config && typeof config === 'object' ? config : {}
  const rules = cfg.rules && typeof cfg.rules === 'object' ? cfg.rules : cfg

  if (rules.enabled === false) return 'reject'
  const mode = asText(rules.mode ?? DEFAULT_MODE).trim().toLowerCase()
  if (mode === 'off') return 'reject'
  if (signals.rejectReason) return 'reject'
  if (!signals.ruleLike) return 'reject'
  // 未知 mode 也走 shadow：宁可只产候选，不可误自动置顶。
  if (mode !== 'auto') return 'shadow'
  if (asText(signals.source || 'unknown').trim().toLowerCase() !== 'owner') return 'shadow'
  if (!signals.explicit) return 'shadow'

  const rawMin = Number(rules.minScore)
  const minScore = Number.isFinite(rawMin) ? rawMin : DEFAULT_MIN_SCORE
  const score = Number(signals.score)
  if (!Number.isFinite(score) || score < minScore) return 'shadow'
  return 'auto'
}

// ---------------------------------------------------------------------------
// 相似度 / 冲突
// ---------------------------------------------------------------------------

function tokenSet(text) {
  const s = asText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
  const set = new Set()
  for (const w of s.match(/[a-z0-9_]+/g) || []) set.add(w)
  // 中文按 bigram 切：单字歧义太大，整句又无法重合。
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) set.add(run)
    for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2))
  }
  return set
}

/**
 * 规则相似度 0..1（token 集合 Jaccard，确定性）。
 * 归一化后完全相同 → 1；任一侧为空 → 0（空文本不该和任何规则「相似」）。
 */
export function similarity(a, b) {
  const na = normalizeRuleText(a)
  const nb = normalizeRuleText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = tokenSet(a)
  const tb = tokenSet(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const union = ta.size + tb.size - inter
  return union ? inter / union : 0
}

// 否定/肯定极性：用于检测「同一槽位被翻转」。
const NEG_POLARITY_RE = /(禁止|不得|不许|不准|不能|不要|别再|别用|别把|别删|别改|无需|避免|\bnever\b|\bmust not\b|\bdo not\b|\bdon't\b)/i
const POS_POLARITY_RE = /(必须|务必|只能|一律|都要|以后都要|始终|保留|开启|允许|\balways\b|\bmust\b|\bshall\b|\bonly\b)/i

function polarityOf(text) {
  const neg = NEG_POLARITY_RE.test(text)
  const pos = POS_POLARITY_RE.test(text)
  if (neg && !pos) return 'negative'
  if (pos && !neg) return 'positive'
  return 'neutral' // 两者都有 = 句子内已自洽，不做翻转判断
}

/** 抽可比较的「值」：数字、路径、英文标识符 + 互斥词对。 */
function valuesOf(text) {
  const s = asText(text).normalize('NFKC')
  const values = new Set()
  for (const m of s.match(/\d+(?:\.\d+)?/g) || []) values.add(m)
  for (const m of s.match(/\/[a-z0-9_\-.]+/gi) || []) values.add(m.toLowerCase())
  for (const m of s.match(/\b[a-z][a-z0-9_-]{2,}\b/gi) || []) values.add(m.toLowerCase())
  for (const pair of VALUE_PAIRS) {
    const left = s.includes(pair[0])
    const right = s.includes(pair[1])
    if (left && !right) values.add(pair[0])
    else if (right && !left) values.add(pair[1])
  }
  return values
}

function valuesMismatch(a, b) {
  const va = valuesOf(a)
  const vb = valuesOf(b)
  if (!va.size || !vb.size) return false
  // 只有双方各有独占值时，才说明同槽位被赋了不同值（端口 8000 vs 3002）。
  let onlyA = 0
  for (const v of va) if (!vb.has(v)) onlyA += 1
  let onlyB = 0
  for (const v of vb) if (!va.has(v)) onlyB += 1
  // 必须各有一方独占的值（端口 8000 vs 3002）；若只是 b 多了个修饰词，是补充而非冲突。
  return onlyA > 0 && onlyB > 0
}

/** 相似度达到此值才可能同槽位；低于它视为两条无关规则，不同槽位不冲突。
 * 取 0.4 而不是 0.5：中文同槽位只差一个词（中文/英文、端口 8000/3002）时 bigram 重合约 0.42，
 * 0.5 会把真正的翻转漏掉；域+极性/异值两道闸门已足够挡住无关规则。 */
export const CONFLICT_SIMILARITY = 0.4

/**
 * 冲突检测（§4.2）：同作用域 + 同域 + 相似度够高 + 否定翻转或异值。
 *
 * existingRules 元素形如 `{ id, text, workspace, origin }`（可带 domain）；
 * rule 形如 `{ id?, text, domain?, workspace?, origin? }`。
 * 不同 workspace（一个共享一个限定）不算冲突：那是两条并行规则。
 *
 * @returns {{ conflict: boolean, ids: string[], reason: string }}
 *   reason: 'negation_flip' | 'value_mismatch' | 'negation_flip+value_mismatch' | 'none'
 */
export function conflictWith(existingRules, rule) {
  const empty = { conflict: false, ids: [], reason: 'none' }
  if (!rule || !asText(rule.text).trim()) return empty
  const ruleText = asText(rule.text)
  const ruleDomain = normalizeDomain(rule.domain || inferDomain(ruleText))
  const ruleScope = scopeOf(rule.workspace)
  const rulePolarity = polarityOf(ruleText)

  const ids = []
  const reasons = new Set()
  for (const ex of Array.isArray(existingRules) ? existingRules : []) {
    if (!ex || !asText(ex.text).trim()) continue
    if (scopeOf(ex.workspace) !== ruleScope) continue
    const exDomain = normalizeDomain(ex.domain || inferDomain(ex.text))
    if (exDomain !== ruleDomain) continue
    const sim = similarity(ruleText, ex.text)
    if (sim < CONFLICT_SIMILARITY) continue

    const exPolarity = polarityOf(ex.text)
    const flip = rulePolarity !== 'neutral' && exPolarity !== 'neutral' && rulePolarity !== exPolarity
    const mismatch = valuesMismatch(ruleText, ex.text)
    if (!flip && !mismatch) continue

    if (flip) reasons.add('negation_flip')
    if (mismatch) reasons.add('value_mismatch')
    const id = asText(ex.id ?? ex.origin ?? '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }

  if (!ids.length) return empty
  return { conflict: true, ids, reason: [...reasons].join('+') || 'none' }
}

/**
 * 规则稳定身份：`rule:<domain>-<hash8>`（§3.2 origin 复用此值）。
 * domain 未给时从文本推断；显式 key 由调用方传 domain 指定。
 */
export function ruleKeyOf(text, opts = {}) {
  const domain = normalizeDomain(opts.domain || inferDomain(asText(text)))
  const hash8 = dedupeKey(text).slice(0, 8)
  return `rule:${domain}-${hash8}`
}
