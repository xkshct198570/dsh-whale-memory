/**
 * 规则提案的「结构化编译 + 关系判定 + 改写守卫」（R3b，纯函数、零 I/O）。
 *
 * 职责：
 * - `compileStructured`：把一句 owner 文本编译成可落盘的规则草案（front matter 字段 + 正文）：
 *   剥口语前缀（以后都/之后/记住…）→ 抽动作/对象/例外/条件 → 生成祈使正文 → 主句完整性守卫；
 * - `classifyRelation`：确定性配对（同 key / 重复 / 冲突 / 合并 / 独立）：冲突/合并不看整句相似度，
 *   而看**动词族 + 对象核心词**的槽位重叠与模态关系；
 * - `guardRewrite`：合并/冲突/改写的**唯一放行闸**（旧例外不丢、模态不弱化、铁律无模糊词、
 *   作用域不变、长度/隐私合规），失败即拒绝；
 * - `buildMergePrompt` / `parseMergeReply`：交给 LLM 的"只改措辞"提示词与容错解析。
 *
 * 边界：
 * - 只 import `./rules.js` 与 `./rule-store.js` 的纯常量函数；不读写文件、不调模型、不碰 DB；
 * - LLM 调用在 rule-proposal.js；本模块只产 prompt、只解析回包；
 * - 不把 `similarity`(0.4) 当冲突结论：0.9 才是重复阈值（架构书 §4.3）；0.4 只做候选配对快筛。
 *
 * Why 单独成文件：关系判定与守卫是"规则能不能自动落盘"的唯一判据，必须能脱宿主/脱文件
 * 单测；一旦混进提案编排（rule-proposal）或路由，就再也无法用黄金样例锁住判定口径。
 *
 * 抽取口径（真机实测驱动，2026-11-22 返工）：
 * - 正文**不再**沿用 compileRule 的原句拼接：原句里的「以后都：」这类口语前缀会被带进候选，
 *   所以正文由"剥前缀 + 去例外尾"后的主句 + 统一模板生成；
 * - 时间/顺序从句（「在…前」「读完后」「先…再…」「默认…」）进 conditions，**不进 object**；
 * - object 只取动词后的名词短语（把/将 结构取中间），动词在时间从句里时不算主句动作；
 * - 「例外/除外」出现却抽不出条目 → 整条拒绝 `exceptions_missing`（例外绝不能被吞）。
 */
import {
  dedupeKey,
  detectSignals,
  normalizeRuleText,
  ruleKeyOf,
  similarity,
} from './rules.js'
import { RESERVED_NUMBERS, RULE_BODY_MAX, RULE_MODALITIES, isValidRuleKey } from './rule-store.js'

/** 重复阈值（架构书 §4.3）：归一化正文相似度 ≥0.9 视为同一条规则。 */
export const DUPLICATE_SIMILARITY = 0.9

/** 槽位（对象核心词）重叠阈值：低于它视为不同对象，不判冲突/合并。 */
export const SLOT_OVERLAP_MIN = 0.3

/** 强定规口径与 rules.js 的 EXPLICIT_STRONG_RE 一致。rules.js 未导出该常量且不在 R3b 写域，
 * 这里复制一份；两处口径必须同改（有黄金样例 `compileStructured：强定规→铁律` 盯着）。 */
const IRON_STRONG_RE = /(记成铁律|铁律|以后都|以后一律|以后不要|以后别|从此以后|从此|永久|永远|一律|任何情况下|任何时候|每次都要|永远不要|always|forever|permanently)/i
const IRON_REF_RE = /铁律\s*(?:#|No\.?|编号)?\s*([0-9]{1,3})/i
/** 明确"改/更新/新建/设为/收进…铁律N"的指令：只有这种句才把铁律号当身份（否则只是引用）。 */
const IRON_DIRECTIVE_RE = /(?:记成|记入|记录为|改成|改为|改到|更新|修改|新建|设为|设置为|收进|收录|收为)[^。！!？?\n]{0,16}?铁律\s*(?:#|No\.?|编号)?\s*([0-9]{1,3})/i
/** 句首"铁律N："是规则本体的标题（历史/默认播种件），算显式身份；句中引用不算。 */
const IRON_LABEL_RE = /^\s*铁律\s*(?:#|No\.?|编号)?\s*([0-9]{1,3})\s*[：:]/
const RULE_KEY_REF_RE = /rule:([a-z0-9][a-z0-9._-]{0,63})/i

/** 模糊词（架构书 §4.5）：铁律一律不得出现。 */
const VAGUE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|可能|也许|方便的时候|maybe|probably)/i

/** 对冲词（弱化模态的判据；比 VAGUE_RE 窄：不含「可能/也许」这类纯推测）。 */
const HEDGE_RE = /(尽量|最好|尽可能|酌情|适当|看情况|注意点|大概|差不多|有空|方便的时候|maybe|probably|try to|if possible)/i

// ---------------------------------------------------------------------------
// 口语前缀 / 模态前缀 / 从句
// ---------------------------------------------------------------------------

/**
 * 正文要剥的口语前缀：只剥"说话方式"，**不剥模态词**（禁止/必须/只 留在正文里才有约束力）。
 * 尾部 `[\s，,：:、]*` 吃掉「以后都：」的冒号——真机实测的候选正文就是被这个冒号带脏的。
 */
const BODY_PREFIX_RE = /^[\s，,。；;、]*(?:记成铁律\s*\d+|铁律\s*\d+|规则|请记住|请|以后都要|以后都|以后一律|以后不要|以后别|以后|之后|从此以后|从此|永久|永远|每次都要|都要|注意|记得|记住)[\s，,：:、]*/g

/**
 * 抽槽位时额外剥掉的模态/语气前缀：动词与对象不是模态词本身。
 * 只剥"纯模态"（禁止/必须/别…）——「只能/只允许/只准」保留给动作词表，
 * 否则「只允许本地模型」会被剥成裸名词、抽不出动作。
 */
const MODALITY_PREFIX_RE = /^[\s，,。；;、]*(?:必须|务必|切记|严禁|禁止|不得|不许|不准|不能|不要|别再|别|一律|统一|都要|都|先|否则|不然|请)[\s，,：:、]*/g

/** 时间从句（「在…前」「读完后」「删除时」）：进 conditions、不进 object，也不当主句动作。 */
const TIME_CLAUSE_RE = /(?:在)?[^，,。；;、\s]{1,24}?(?:之前|前|之后|后|时候|时)/g
/** 时间从句的假阳性词（语气/连接词，以及「临时/及时/同时/小时/准时」这类词里的「时」）。 */
const TIME_CLAUSE_SKIP = Object.freeze(['以前', '之前', '以后', '之后', '最后', '然后', '目前', '当前', '从前', '前面', '后面', '平时', '当时'])
const TIME_CLAUSE_SKIP_SUFFIX = Object.freeze(['临时', '及时', '同时', '小时', '准时', '届时', '定时', '暂时'])

/** 理由句：整句丢弃（理由不进正文，正文里有理由会诱发模型自行推翻规则）。 */
const REASON_SENTENCE_RE = /^\s*(?:因为|由于|原因是|理由是|毕竟|主要是|考虑到|之所以|所以|这是为了|免得|不然)/

/** 例外：三种口语形态。 */
const EXCEPTION_TEXT_RE = /[；;，,]?\s*例外\s*[：:]\s*([^。；;\n]+)/g
const EXCEPTION_TAIL_RE = /[，,；;]\s*([^，,；;。]+?)\s*例外\s*[。！!]?\s*$/
const EXCEPTION_CHU_RE = /除(?:了)?([^，,；;。]+?)外/g

/** 附加条件形态：除非/当…时。 */
const CONDITION_CLAUSE_RE = /(除非[^。；;，,\n]{1,60})|(当(?!前|初|时)[^。；;\n]{1,60}?时)/g
/** 顺序/默认条件：「先…再…」「默认…」只作条件片段，保留原文关键部分。 */
const SEQUENCE_CONDITION_RE = /先[^。；;]{1,50}?(?=再|然后|，|,|。|；|;)/
const DEFAULT_CONDITION_RE = /默认[^。；;，,]{1,24}/

/**
 * 动作词表（长词优先）。只收**可执行动作**；纯模态词（禁止/必须/别…）不进候选，
 * 否则「禁止删除」会被抽成 action=禁止、object=删除。
 */
const ACTION_VERBS = [
  '删除', '删掉', '提炼', '归档', '保留', '留下', '记录', '注入', '读取', '上传', '下载',
  '提交', '修改', '覆盖', '重启', '停止', '启动', '发送', '同步', '推送', '拉取', '校验',
  '核对', '检查', '验证', '运行', '执行', '使用', '采用', '备份', '恢复', '导出', '导入',
  '合并', '拆分', '设置', '配置', '安装', '卸载', '开启', '关闭', '允许', '禁止', '调用',
  '访问', '部署', '发布', '清理', '移动', '创建', '新建', '查询', '只允许', '只准', '只能',
  '仅允许', '仅能', '删', '写', '跑', '用', '留', '存', '放', '读', '发', '查', '改', '核',
  '看', '加', '开', '关', '停', '记',
]
const ACTION_VERBS_SORTED = [...ACTION_VERBS].sort((a, b) => b.length - a.length)

/**
 * 单字动词的"构词护栏"：中文没有词边界，「用户」里的「用」、「记住」里的「记」都会被当成动词。
 * 多字动词优先匹配；单字动词只在后续字符不构成常见词时才算动作（用户/写法/查询/关键…）。
 */
const VERB_FOLLOW_GUARD = Object.freeze({
  用: /^(?!户|法|途|力|心|意|品|工|处|于|语|例|地)/,
  写: /^(?!法|作|真|入)/,
  查: /^(?!询|看|找)/,
  改: /^(?!成|为|变|善)/,
  留: /^(?!意|下|住)/,
  存: /^(?!在|储|款)/,
  放: /^(?!在|心|弃|大)/,
  读: /^(?!者|书|法)/,
  发: /^(?!布|送|现|展|生|起)/,
  开: /^(?!启|始|关|发|会|展|放)/,
  关: /^(?!闭|键|于|注|心)/,
  看: /^(?!法|到|起|来)/,
  加: /^(?!入|载|强|速|工)/,
  核: /^(?!对|查|实)/,
  记: /^(?!录|住|忆|得)/,
  跑: /^(?!步)/,
  停: /^(?!止|靠|留)/,
  走: /^(?!向|路|访)/,
  拿: /^(?!到|走)/,
  装: /^(?!载|置|配)/,
})

/**
 * 动词族：关系判定用"族"而不是原词（删/删除/删掉 是同一槽位动作）。
 * 族内互斥对（删除↔保留、开启↔关闭、允许↔禁止）用于"同对象、模态相同也算冲突"的情形。
 */
export const VERB_FAMILIES = Object.freeze({
  delete: Object.freeze(['删除', '删掉', '删', '清理', '清空', '移除', '销毁']),
  keep: Object.freeze(['保留', '留下', '留着', '留', '备份', '存档']),
  archive: Object.freeze(['归档']),
  extract: Object.freeze(['提炼', '汇总', '总结', '整理']),
  record: Object.freeze(['记录', '记', '写入', '写']),
  move: Object.freeze(['移动', '迁移']),
  enable: Object.freeze(['开启', '启动', '开']),
  disable: Object.freeze(['关闭', '停止', '停', '关']),
  allow: Object.freeze(['允许', '只允许', '只准', '可以']),
  forbid: Object.freeze(['禁止', '严禁', '不许', '不准']),
  use: Object.freeze(['用', '使用', '采用']),
  read: Object.freeze(['读', '读取']),
  sync: Object.freeze(['同步', '拉取', '推送']),
  submit: Object.freeze(['提交', '发布', '部署']),
  modify: Object.freeze(['修改', '覆盖', '改', '替换']),
  check: Object.freeze(['校验', '核对', '检查', '验证', '查']),
  run: Object.freeze(['跑', '运行', '执行']),
  transfer: Object.freeze(['上传', '下载', '导出', '导入', '发送', '发']),
  restart: Object.freeze(['重启']),
})

/** 互斥动词族对：同对象 + 相同模态也会冲突（「报告默认删除」vs「报告默认保留」）。 */
export const OPPOSITE_FAMILIES = Object.freeze([
  Object.freeze(['delete', 'keep']),
  Object.freeze(['enable', 'disable']),
  Object.freeze(['allow', 'forbid']),
  Object.freeze(['delete', 'archive']),
])

/** 例外条目数硬顶（架构书 §3.2）。 */
const EXCEPTIONS_MAX = 12

/** 否定/限定/例外词：决定 modality。与 rules.js 的极性表同口径（那份未导出）。
 * 单字「别」同样要挡词内出现（区别/特别/个别/分别/类别/性别/级别）。 */
const NEG_RE = /(禁止|不得|不许|不准|不能|不必|无需|不用|毋须|切勿|勿|不要|别再|别用|别把|别删|别改|(?<![区特个分类型级性离别])别|严禁|避免|never|must not|do not|don't)/i
const ONLY_RE = /(只能|只准|只允许|仅能|仅允许|只用|只保留|只读|只做|只接受|只支持|只(?:用|留|存|删|选|取|做|算|跑|走|看|读|写|发|收|要|能|须|需|有|是|可|会|应|得|让|把|给|对|向|从|在|为|于))/
const EXCEPT_RE = /除(?:了)?[^，,。；;]{1,40}外/

/** 副词/铺垫词：抽 object 时剥掉（不是对象本体）。 */
const ADVERB_RE = /^(?:自动|手动|直接|一律|统一|都|先|再|立即|立刻|马上|默认|尽量|务必|请|要|就|才|一定|全部|所有|逐步|优先|否则|不然|然后)+/
/** 对象尾部语气词。 */
const TRAILING_PARTICLE_RE = /[了吧呢啊哦呀的。，,；;、\s]+$/
/** 对象尾部的副词（「报告默认」→「报告」）。 */
const TRAILING_ADVERB_RE = /(?:自动|手动|直接|一律|统一|默认|尽量|优先|逐步)+$/

/** 正文缺指令形态时的补齐前缀（只补模态词，不改原句语义）。 */
const IMPERATIVE_MIRROR_RE = /(以后|必须|禁止|不得|不许|不准|只能|只允许|只准|仅能|一律|永远|务必|不要|别再|别用|别把|别|勿|不必|无需|切勿|不用|改成|改为|应该|切记|严禁|都要|默认|把|将|只|仅|除|例外|除外)/
const DIRECTIVE_HEAD_MIRROR_RE = /^\s*(?:请|用|改|删|写|跑|走|开|关|停|把|将|先|别|不要|必须|禁止|以后|记得|记住|注意|保留|只)/

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
  // R9-19：`铁律N` 默认只当引用（「务必做到铁律10」不得生成 iron-rule-10）。
  // 只有明确指令（改/更新/新建/设为/收进…铁律N）或句首「铁律N：」标题才返回身份。
  const directive = raw.match(IRON_DIRECTIVE_RE) || raw.match(IRON_LABEL_RE)
  if (directive) {
    const number = Number(directive[1])
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
  const key = ruleKeyOf(text)
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

// ---------------------------------------------------------------------------
// 从句 / 例外 / 条件抽取
// ---------------------------------------------------------------------------

/** 反复剥前缀直到稳定（「以后都要必须…」这类叠词）。 */
function stripRepeated(text, re, rounds = 8) {
  let out = textOf(text).trim()
  for (let i = 0; i < rounds; i += 1) {
    const next = out.replace(re, '')
    if (next === out) break
    out = next
  }
  return out
}

/** 时间/顺序从句位置（用于排除从句内的动词、切断 object）。 */
function timeClauseSpans(text) {
  const spans = []
  TIME_CLAUSE_RE.lastIndex = 0
  let m
  while ((m = TIME_CLAUSE_RE.exec(text)) !== null) {
    const clause = m[0]
    if (TIME_CLAUSE_SKIP.includes(clause)) continue
    // 「先…」不是时间从句；「再…」之类也不收（避免把连接词当条件）。
    if (clause.startsWith('先') || clause.startsWith('再')) continue
    // 「文件卫生与阅后」是标题短语不是时间条件：带连接词/破折号的一律不收。
    if (/[与和及——]/.test(clause)) continue
    if (TIME_CLAUSE_SKIP_SUFFIX.some((word) => clause.endsWith(word))) continue
    spans.push({ start: m.index, end: m.index + clause.length, text: clause })
  }
  return spans
}

/** 触发条件从句位置（通常/除非/当…时）：从句里的动词是条件事件，不是主句动作。 */
function conditionSpans(text) {
  const spans = []
  CONDITION_CLAUSE_RE.lastIndex = 0
  let m
  while ((m = CONDITION_CLAUSE_RE.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return spans
}

/** 理由句位置（「因为…」到句尾整句丢弃）。 */
function reasonSpans(text) {
  const spans = []
  const parts = textOf(text).split(/([。；;\n])/)
  let offset = 0
  for (const part of parts) {
    if (REASON_SENTENCE_RE.test(part)) spans.push({ start: offset, end: offset + part.length, text: part })
    offset += part.length
  }
  return spans
}

/** 位置是否落在任一区间内。 */
function covered(index, spans) {
  return spans.some((span) => index >= span.start && index < span.end)
}

/** 删除给定区间（保留其余原文）。 */
function removeSpans(text, spans) {
  if (!spans.length) return text
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const span of sorted) {
    const start = Math.max(cursor, span.start)
    if (start > cursor) out += text.slice(cursor, start)
    cursor = Math.max(cursor, span.end)
  }
  return out + text.slice(cursor)
}

/** 例外条目切分：、，,/ 都算分隔；去空、去重、限长。 */
function splitExceptionItems(raw) {
  const out = []
  const seen = new Set()
  for (const part of textOf(raw).split(/[、,，/;；]+/)) {
    let item = part.trim().replace(/^[和与及\s]+/, '').replace(/[。；;，,\s]+$/g, '')
    item = item.replace(/例外$/, '').trim()
    if (!item) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item.slice(0, 120))
    if (out.length >= EXCEPTIONS_MAX) break
  }
  return out
}

/**
 * 例外抽取（三种口语形态都认）：
 * - `例外：A、B、C`
 * - `除A、B外`
 * - `…，A、B 例外。`
 *
 * 返回条目 + 需要从正文/分析文本里剔掉的区间，保证「例外：…」不会同时出现在正文里。
 *
 * @param {string} raw
 * @returns {{exceptions:string[], spans:Array<{start:number,end:number,text:string}>}}
 */
export function extractExceptions(raw) {
  const text = textOf(raw)
  const exceptions = []
  const spans = []
  const push = (items) => {
    for (const item of items) if (!exceptions.includes(item)) exceptions.push(item)
  }

  EXCEPTION_TEXT_RE.lastIndex = 0
  let m
  while ((m = EXCEPTION_TEXT_RE.exec(text)) !== null) {
    push(splitExceptionItems(m[1]))
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  const tail = text.match(EXCEPTION_TAIL_RE)
  if (tail) {
    push(splitExceptionItems(tail[1]))
    const start = tail.index
    if (!spans.some((span) => start >= span.start && start < span.end)) {
      spans.push({ start, end: start + tail[0].length, text: tail[0] })
    }
  }
  EXCEPTION_CHU_RE.lastIndex = 0
  while ((m = EXCEPTION_CHU_RE.exec(text)) !== null) {
    push(splitExceptionItems(m[1]))
    if (!spans.some((span) => m.index >= span.start && m.index < span.end)) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    }
  }
  return { exceptions: exceptions.slice(0, EXCEPTIONS_MAX), spans }
}

/**
 * 条件抽取：除非/当…时（触发条件）+ 在…前/后、读完后（时间从句）+ 先…再…（顺序）+ 默认…
 * 只保留原文关键片段，不改写、不补词。
 * @param {string} raw
 * @returns {string[]}
 */
export function extractConditionPhrases(raw) {
  const text = textOf(raw)
  const out = []
  const seen = new Set()
  const push = (fragment) => {
    const item = trimmed(fragment).replace(/[，,。；;、\s]+$/g, '')
    if (!item || seen.has(item)) return
    seen.add(item)
    out.push(item.slice(0, 200))
  }

  CONDITION_CLAUSE_RE.lastIndex = 0
  let m
  while ((m = CONDITION_CLAUSE_RE.exec(text)) !== null) push(m[1] || m[2])
  for (const span of timeClauseSpans(text)) push(span.text)
  const seq = text.match(SEQUENCE_CONDITION_RE)
  if (seq) push(seq[0])
  const fallback = text.match(DEFAULT_CONDITION_RE)
  if (fallback) push(fallback[0])
  return out.slice(0, 6)
}

/**
 * 模态推断：
 * - 禁止/不得/不准/不许/不必/切勿/不要/别 → must_not
 * - 除…外 → except（保留例外语义）
 * - 只能/只准/只允许/仅…/只用/只保留 → only
 * - 其余显式 → must
 * @param {string} raw @returns {'must'|'must_not'|'only'|'except'}
 */
export function modalityOf(raw) {
  const text = textOf(raw)
  if (NEG_RE.test(text)) return 'must_not'
  if (EXCEPT_RE.test(text)) return 'except'
  if (ONLY_RE.test(text)) return 'only'
  return 'must'
}

/** 条件/例外分槽（对外 API 与拆分口径保持不变）。 */
export function splitConditions(raw) {
  return { conditions: extractConditionPhrases(raw), exceptions: extractExceptions(raw).exceptions }
}

// ---------------------------------------------------------------------------
// 动作 / 对象 / 标题
// ---------------------------------------------------------------------------

const FAMILY_OF_VERB = new Map()
for (const [family, verbs] of Object.entries(VERB_FAMILIES)) {
  for (const verb of verbs) if (!FAMILY_OF_VERB.has(verb)) FAMILY_OF_VERB.set(verb, family)
}

/** @param {string} verb @returns {string} 动词族（未知词给自身） */
export function verbFamilyOf(verb) {
  return FAMILY_OF_VERB.get(trimmed(verb)) || trimmed(verb)
}

/** 文本里出现的动作词（最长匹配，左→右）。 */
function verbsIn(text) {
  const raw = textOf(text)
  const hits = []
  let i = 0
  while (i < raw.length) {
    const verb = ACTION_VERBS_SORTED.find((word) => {
      if (!raw.startsWith(word, i)) return false
      if (word.length > 1) return true
      const guard = VERB_FOLLOW_GUARD[word]
      // 单字动词要做构词护栏；否则「用户」「写法」会被当成动作。
      return guard ? guard.test(raw.slice(i + 1)) : true
    })
    if (verb) { hits.push({ verb, index: i }); i += verb.length; continue }
    i += 1
  }
  return hits
}

/**
 * 选主句动作：从句外的动词里——有「先…再…」顺序时取最后一个（最终目的动作），
 * 否则取最早出现的（谓语中心）。
 * @param {string} text @param {Array<{start:number,end:number}>} excluded
 * @returns {{verb:string,index:number}|null}
 */
function pickVerb(text, excluded) {
  const free = verbsIn(text).filter((hit) => !covered(hit.index, excluded))
  if (!free.length) return null
  const sequenced = /先[^。；;]{1,60}?再/.test(text) || /然后/.test(text) || /之后/.test(text)
  return sequenced ? free[free.length - 1] : free[0]
}

/** 去掉副词/语气尾巴（object 本体）。 */
function cleanObject(text) {
  let out = textOf(text).trim()
  out = out.replace(/^[\s，,。；;、：:（(]+/, '').replace(/[（(][^）)]*[）)]$/, '')
  out = out.replace(ADVERB_RE, '')
  out = out.replace(TRAILING_PARTICLE_RE, '')
  out = out.replace(TRAILING_ADVERB_RE, '').trim()
  out = out.replace(/\s{2,}/g, ' ')
  return out.slice(0, 200)
}

/** 从动词位置向前找最近的名词短语（topic-first 句式：「报告默认删除」）。 */
function precedingNoun(text, index, excluded) {
  let i = index - 1
  // 先跳过从句、填充词与副词
  for (let guard = 0; guard < 40 && i >= 0; guard += 1) {
    const span = excluded.find((item) => i >= item.start && i < item.end)
    if (span) { i = span.start - 1; continue }
    const ch = text[i]
    if (/[\s，,。；;、：:（）()]/.test(ch)) { i -= 1; continue }
    const filler = ADVERB_RE.exec(text.slice(Math.max(0, i - 3), i + 1))
    if (filler && filler.index === 0 && filler[0]) { i -= Array.from(filler[0]).length - 1; continue }
    break
  }
  let start = i
  while (start >= 0) {
    if (covered(start, excluded)) break
    if (/[\s，,。；;、：:（）()]/.test(text[start])) break
    start -= 1
  }
  const run = text.slice(start + 1, i + 1).trim()
  if (!run) return ''
  // 兜底出来的若是动作词本身（「先提炼再删」→ 提炼），不是对象，宁可留空。
  if (ACTION_VERBS.includes(run)) return ''
  return cleanObject(run)
}

/**
 * 抽 object：动词后的名词短语（把/将 结构取中间）。
 * 若动词后紧跟目的地（到/进/入/给/向/至），对象是动词前的名词（「源文件归档到临时目录」）。
 * @param {string} text @param {{verb:string,index:number}} hit
 * @param {Array<{start:number,end:number}>} excluded
 * @returns {string}
 */
function pickObject(text, hit, excluded) {
  const afterStart = hit.index + hit.verb.length
  // 把/将结构：对象在把/将 与动词之间
  const baIndex = Math.max(text.lastIndexOf('把', hit.index - 1), text.lastIndexOf('将', hit.index - 1))
  if (baIndex >= 0 && !covered(baIndex, excluded)) {
    const between = cleanObject(text.slice(baIndex + 1, hit.index))
    if (between) return between
  }
  let end = afterStart
  while (end < text.length) {
    if (covered(end, excluded)) break
    if (/[，,。；;、！!？?\n]/.test(text[end])) break
    end += 1
  }
  let after = text.slice(afterStart, end).trim()
  // 切掉连接词后的附加成分（结论进记忆 → 结论）
  const connector = after.search(/(?:到|进|入|给|向|至|成|为|并|然后|再|以)/)
  if (connector >= 0) after = after.slice(0, connector)
  after = cleanObject(after)
  if (after && !/^(?:到|进|入|给|向|至|成|为)/.test(after)) return after
  const before = precedingNoun(text, hit.index, excluded)
  return before || ''
}

/**
 * 抽槽位（对外 API 保留）：剥口语+模态前缀 → 去掉例外/时间/理由片段 → 动作 + 对象。
 * @param {string} raw
 * @returns {{action:string, object:string}}
 */
export function extractSlots(raw) {
  const analysis = analyzeClause(raw)
  return { action: analysis.action, object: analysis.object }
}

/** 内部：一次分析拿全部槽位与片段（compile 与测试共用）。 */
function analyzeClause(raw) {
  const bodyBase = stripRepeated(raw, BODY_PREFIX_RE)
  const ext = stripRepeated(bodyBase, MODALITY_PREFIX_RE)
  const ex = extractExceptions(ext)
  const timeSpans = timeClauseSpans(ext)
  const rSpans = reasonSpans(ext)
  const cSpans = conditionSpans(ext)
  const excluded = [...ex.spans, ...timeSpans, ...rSpans, ...cSpans]
  const hit = pickVerb(ext, excluded)
  if (!hit) return { action: '', object: '', verb: null, exceptions: ex.exceptions, ext, excluded }
  const object = pickObject(ext, hit, excluded)
  return { action: hit.verb, object, verb: hit, exceptions: ex.exceptions, ext, excluded }
}

/**
 * 标题：动作+对象 拼成 ≤12 字的短名（不能只给「删」这种动词）。
 * 只用于面板展示，不写进规则 front matter。
 * @param {string} action @param {string} object @param {string} body
 * @returns {string}
 */
export function titleOfRuleDraft(action, object, body) {
  const act = trimmed(action)
  const obj = trimmed(object)
  const fallback = (textOf(body).split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean)[0] || '')
    .replace(/^(?:必须|禁止|只能|除例外外)\s+/, '')
    .replace(/[，,；;。]+/g, '')
  const join = act && obj && /^[A-Za-z0-9]/.test(obj) ? ' ' : ''
  const combined = act && obj ? `${act}${join}${obj}` : (obj || act || fallback)
  const cleaned = combined.replace(/[，,；;。、]+/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 12)
  // 抽不出对象时，纯动词标题（「删」）不合格：退正文首片段。
  if (!obj && act && cleaned === act.replace(/[，,；;。、\s]+/g, '')) {
    return (fallback || cleaned).slice(0, 12)
  }
  return cleaned || fallback.slice(0, 12)
}

/**
 * 主句完整性守卫：编译后正文必须覆盖原句的动作与对象关键片段（命中 ≥2）。
 * @param {{action:string,object:string}} slots @param {string} body
 * @returns {{ok:boolean, hits:number, required:number, fragments:string[], missing:string[]}}
 */
export function mainClauseIntact(slots, body) {
  // object 里残留的定规/顺序词（「过程稿一律到临时目录」）会把完整片段切成两半，
  // 先按停顿词再切一刀，判定的是"关键片段在不在"，不是整句复制。
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

/** 定规/顺序停顿词：抽关键片段时再切一刀（不切「重要」这类实词，只切虚词）。 */
const FILLER_SPLIT_RE = /(?:一律|必须|务必|都要|都|先|再|然后|最后|而且|并且|就|才)/

/**
 * 正文构建：剥口语前缀 → 去掉例外尾/理由句/链接 → 保证指令形态 → 套统一模板。
 * Why 不复用 compileRule：它按原句拼接，「以后都：」这类口语前缀会被带进候选正文。
 */
function buildBody(raw, exceptions, modality) {
  let core = stripRepeated(raw, BODY_PREFIX_RE)
  const ex = extractExceptions(core)
  core = removeSpans(core, ex.spans)
  core = removeSpans(core, reasonSpans(core))
  // 链接/出处不属于规则正文（与 compileRule 同口径，防 URL 进规则）。
  core = core.replace(/\[([^\]]{1,60})\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s）)\]]+/gi, '')
    .replace(/[（(]\s*(?:参考|详见|链接|出处|来源)\s*[：:][^）)]*[）)]/g, '')
  core = core.replace(/^[\s，,。；;、：:]+/, '').replace(/[，,。；;、\s]+$/, '').trim()
  // 口语里常带一句标题（「文件卫生与阅后即焚——…」），标题不是规则本体。
  core = core.replace(/^[^——]{1,24}——/, '').trim()
  if (!core) return { ok: false, error: 'partial_compile', detail: { reason: 'no_body' } }

  // 指令形态：正文没有任何模态/祈使标记时补一个（只补模态词，不改原句）。
  // 规则的"指令形态"由 rules.js 判定，它认 只能/仅能/只允许，但不认裸「只」：
  // 「只用本地模型」这种 only 句要落成「只能用本地模型」，否则仓储校验会判 not_imperative。
  if (modality === 'only' && /^只(?!能|准|允许)/.test(core)) core = core.replace(/^只/, '只能')
  // rules.js 的显式约束词表里没有裸「别」（只有 不要/别再/别用/别把）：句首「别」在模板正文里
  // 会被仓储判 not_imperative，落成「禁止」既合规又不改语义。
  if (modality === 'must_not' && /^别(?![的处致样])/.test(core)) core = core.replace(/^别/, '禁止')
  // 用仓储同一个判定器（detectSignals）验指令形态：自己维护一份"祈使词表"必然与 rules.js 漂移。
  if (!detectSignals(core).imperative) {
    const prefix = modality === 'must_not' ? '禁止' : (modality === 'only' ? '只能' : (modality === 'except' ? '除例外外' : '必须'))
    core = `${prefix} ${core}`.trim()
  }
  const bodyClause = core.replace(/[。；;]+$/, '').trim()
  const exceptionPart = exceptions.length ? `；例外：${exceptions.join('、')}` : ''
  return { ok: true, body: bodyClause, exceptionPart }
}

/**
 * 指令形状判据（补 rules.js 信号门槛的保守面）：
 * 有可执行动作 + 任一约束形态（非 must 模态 / 显性强定规 / 顺序与默认 / 把字句 / 例外 / 句首祈使）。
 * 纯描述句（无动作）与模糊偏好（preference）仍被拒——这两类是提案噪音的大头。
 * @param {string} raw @param {{action:string, ext:string}} analysis
 * @returns {boolean}
 */
function hasDirectiveShape(raw, analysis) {
  if (!analysis?.action) return false
  if (modalityOf(raw) !== 'must') return true
  if (IRON_STRONG_RE.test(raw)) return true
  if (/(以后|默认|一律|统一|只|仅|把|将|先|例外|除外|铁律|规则|记得|记住)/.test(raw)) return true
  if (/(?:前|后|时|完)[^，。；]{0,6}(?:要|必须|需|应|留|提炼|删除|归档|备份|记录|校验|核对)/.test(raw)) return true
  return DIRECTIVE_HEAD_MIRROR_RE.test(textOf(analysis.ext))
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
  const analysis = analyzeClause(raw)
  // rules.js 的规则信号偏保守（只认 必须/禁止/只能…），会把「报告默认删除」「删除前不必核路径」
  // 「只用本地模型」这类明确的 owner 约束判成描述句；这里补一层"指令形状"判据：
  // 有可执行动作 + 模态/顺序/默认/把字句等约束形态，仍然算规则；纯描述（无动作）继续拒绝。
  if (!sig.ruleLike && !hasDirectiveShape(raw, analysis)) {
    return { ok: false, error: sig.rejectReason || 'not_rule' }
  }

  const source = trimmed(opts.source ?? sig.source ?? 'unknown').toLowerCase() || 'unknown'
  const explicitRef = extractExplicitRef(raw)
  // 纯引用（命中 `铁律N` 但没有明确"改/更新/新建…"指令）不得当强定规：
  // 否则一句「务必做到铁律10」会被收成新铁律、还按引用号造 key（R9-19）。
  const bareIronRef = IRON_REF_RE.test(raw) && !explicitRef
  const strong = IRON_STRONG_RE.test(raw) && !bareIronRef
  // owner 显式 + 强定规（或显式点名铁律N）才配 iron-rule；其他来源最高 rule（架构书 §4.1）。
  const isIron = source === 'owner' && sig.explicit && (strong || Boolean(explicitRef?.number))

  const workspace = trimmed(opts.workspace ?? sig.workspace)
  const scope = trimmed(opts.scope) || (workspace ? `workspace:${workspace}` : 'global')
  const role = trimmed(opts.role)
  const domain = domainOfText(raw)
  const modality = modalityOf(raw)
  // 条件从句基于"剥过前缀"的文本抽：否则「以后禁止在提炼结论前…」会把「禁止」带进条件。
  const conditions = extractConditionPhrases(analysis.ext)
  const exceptions = analysis.exceptions
  // 原文出现「例外/除外」却抽不出条目 = 例外被吞，整条拒绝（绝不让守卫视而不见）。
  if (/例外|除外/.test(raw) && exceptions.length === 0) {
    return { ok: false, error: 'exceptions_missing', detail: { reason: 'exception_word_without_items' } }
  }
  if (!analysis.action) {
    return { ok: false, error: 'partial_compile', detail: { reason: 'no_action', object: analysis.object } }
  }

  const built = buildBody(raw, exceptions, modality)
  if (!built.ok) return built
  // 规则正文只放可执行语义：不加「【规则·域】」前缀、不写「作用域：…」后缀（scope 在 front/注入前缀里）。
  // 旧模板会把候选正文变成“带户口本的散文”，既难读也让守卫/摘要多一层噪声。
  const ruleText = `${built.body}${built.exceptionPart}`.trim()
  if (chars(ruleText) > RULE_BODY_MAX) {
    return { ok: false, error: 'too_long', detail: { chars: chars(ruleText) } }
  }
  if (isIron && VAGUE_RE.test(built.body)) return { ok: false, error: 'vague_word', detail: { body: built.body } }
  const bodySignals = detectSignals(built.body)
  if (bodySignals.rejectReason === 'privacy') return { ok: false, error: 'privacy' }
  if (!bodySignals.imperative) {
    return { ok: false, error: 'not_imperative', detail: { body: built.body } }
  }

  const slots = { action: analysis.action, object: analysis.object }
  const intact = mainClauseIntact(slots, ruleText)
  if (!intact.ok) {
    return {
      ok: false,
      error: 'partial_compile',
      detail: { reason: 'main_clause', hits: intact.hits, required: intact.required, missing: intact.missing },
    }
  }

  const existingRules = Array.isArray(opts.existingRules) ? opts.existingRules : []
  const existingKeys = new Map()
  for (const doc of existingRules) {
    const { front } = normalizeDoc(doc)
    const key = trimmed(front.key)
    if (key) existingKeys.set(key, normalizeDoc(doc))
  }

  const key = explicitRef?.key || `rule-${domain}-${dedupeKey(raw).slice(0, 8)}`
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key', detail: { key } }

  // 编号：只有 iron-rule 占号（R8-01）；普通规则/候选 number 必须 null。
  // 显式铁律N > refine 沿用旧号 > 新建取 nextNumber（跳过占号与空号 6）。
  const sameKey = existingKeys.get(key)
  // R9-20：取号单一真源——调用方传 occupancy（文件名∪front∪墓碑）时以它为准；
  // 只有纯函数单测/脱仓储调用才退回"既有规则"集合。
  const taken = opts.occupancy
    ? new Set(Array.from(opts.occupancy).filter((n) => Number.isInteger(Number(n)) && Number(n) > 0).map(Number))
    : takenNumbers(existingRules)
  let number = null
  if (!isIron) {
    number = null
  } else if (explicitRef?.number) {
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
    modality: RULE_MODALITIES.includes(modality) ? modality : 'must',
    action: slots.action,
    object: slots.object,
    title: titleOfRuleDraft(slots.action, slots.object, built.body),
    conditions,
    exceptions,
    text: ruleText,
    chars: chars(ruleText),
    // 域不是 front matter 字段，但关系判定/面板需要它；放在草案上仅作运行时视图。
    domain,
  }
  return { ok: true, draft }
}

// ---------------------------------------------------------------------------
// 关系判定：动词族 + 对象核心词
// ---------------------------------------------------------------------------

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

/**
 * 对象核心词集：ASCII 词 + 中文 bigram（与 similarity 同一套 token 口径，
 * 但只看对象，避免整句里的域词/模板词污染槽位）。
 * @param {string} text @returns {Set<string>}
 */
export function objectWords(text) {
  const s = textOf(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
  const set = new Set()
  for (const word of s.match(/[a-z0-9_]+/g) || []) set.add(word)
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) set.add(run)
    for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2))
  }
  return set
}

/** 两个词集的 Jaccard（空集 → 0，不把「没有对象」当同槽位）。 */
function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** 两个词集是否有交集（判"共享动作"用）。 */
function intersects(a, b) {
  if (!a.size || !b.size) return false
  for (const token of a) if (b.has(token)) return true
  return false
}

/** 动作词集（含条件从句里的动词，便于识别「删除前/删除后」这类同一事件）。 */
function verbSetOf(docText, conditions) {
  const set = new Set()
  for (const hit of verbsIn(textOf(docText))) set.add(hit.verb)
  for (const clause of Array.isArray(conditions) ? conditions : []) {
    for (const hit of verbsIn(clause)) set.add(hit.verb)
  }
  return set
}

/** 动词族集合。 */
function familySetOf(verbs) {
  const set = new Set()
  for (const verb of verbs) set.add(verbFamilyOf(verb))
  return set
}

/** 是否互斥动词族对。 */
function familiesOpposite(a, b) {
  for (const [left, right] of OPPOSITE_FAMILIES) {
    if ((a.has(left) && b.has(right)) || (a.has(right) && b.has(left))) return true
  }
  return false
}

/**
 * 模态是否互斥（架构书 §3.3）：严格按反转表 must↔must_not、only↔except。
 *
 * Why 不再把 `only` 与任何非 only 都当反转：`only` vs `must` 是**收窄**不是反转，
 * 应走 merge/refine；v3.7 把它判冲突会让「只用本地模型」永远打不掉「必须用模型」。
 */
function modalityReversed(a, b) {
  if (a === b) return false
  return REVERSE_MODALITY[a] === b
}

/** 条件/例外"互补"：任一方为空，或两方没有重叠条目（重叠=同一条件重复，不是补充）。 */
function complementary(a, b) {
  const left = [...a.conditions, ...a.exceptions].map(normalizeRuleText).filter(Boolean)
  const right = [...b.conditions, ...b.exceptions].map(normalizeRuleText).filter(Boolean)
  if (!left.length || !right.length) return true
  for (const l of left) if (right.some((r) => r === l || r.includes(l) || l.includes(r))) return false
  return true
}

/** @typedef {{key:string,number:number|null,text:string,object:string,modality:string,
 *   conditions:string[],exceptions:Array<any>,family:Set<string>,verbs:Set<string>}} SlotView */

/** @param {{front:object,text:string}} doc @returns {SlotView} */
function slotViewOf(doc) {
  const front = doc.front || {}
  const actions = new Set()
  const action = trimmed(front.action)
  // 有结构化 action 就只信它：正文/条件里的动词（「删除前/删除后」）是条件事件，
  // 把它们当动作族会把「删除前要提炼」和「删除后要留审计」误判成互斥冲突。
  if (action) actions.add(action)
  else for (const hit of verbsIn(textOf(doc.text))) actions.add(hit.verb)
  return {
    key: trimmed(front.key),
    number: Number.isInteger(Number(front.number)) && Number(front.number) > 0 ? Number(front.number) : null,
    text: textOf(doc.text),
    object: trimmed(front.object),
    modality: trimmed(front.modality) || 'must',
    conditions: Array.isArray(front.conditions) ? front.conditions : [],
    exceptions: Array.isArray(front.exceptions) ? front.exceptions : [],
    family: familySetOf(actions),
    verbs: verbSetOf(doc.text, front.conditions),
  }
}

/** @param {object} draft @returns {SlotView} */
function draftViewOf(draft) {
  const actions = new Set()
  const action = trimmed(draft.action)
  if (action) actions.add(action)
  return {
    key: trimmed(draft.key),
    number: Number.isInteger(Number(draft.number)) && Number(draft.number) > 0 ? Number(draft.number) : null,
    text: textOf(draft.text),
    object: trimmed(draft.object),
    modality: trimmed(draft.modality) || 'must',
    conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
    exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
    family: familySetOf(actions),
    verbs: verbSetOf(draft.text, draft.conditions),
  }
}

/** 槽位重叠：对象核心词 Jaccard ≥ 0.3；对象缺失时退化为"共享动作族/动作词"。 */
function slotOverlap(draft, rule) {
  const objJ = jaccardOf(objectWords(draft.object), objectWords(rule.object))
  if (objJ >= SLOT_OVERLAP_MIN) return { overlap: true, kind: 'object', jaccard: objJ }
  // 条件引用同一事件动作（删除前/删除后）：同一槽位事件，允许合并/冲突判定。
  const draftCondVerbs = verbSetOf('', draft.conditions)
  const ruleCondVerbs = verbSetOf('', rule.conditions)
  if (intersects(draftCondVerbs, ruleCondVerbs)) {
    return { overlap: true, kind: 'shared_event', jaccard: objJ }
  }
  if (!draft.object || !rule.object) {
    const shareFamily = intersects(draft.family, rule.family)
    const shareVerb = intersects(draft.verbs, rule.verbs)
    if (shareFamily || shareVerb) return { overlap: true, kind: 'verb_only', jaccard: objJ }
  }
  return { overlap: false, kind: 'none', jaccard: objJ }
}

/**
 * 作用域归一（架构书 §3.3）：`global` / `workspace:<绝对路径>` / `role:<id>` **精确**比较。
 *
 * 只做纯字符串归一（分隔符统一 + 去尾斜杠），不 realpath：本模块是纯函数，不碰文件系统；
 * 路径真实化由 host 层在传入前完成。缺省 scope 视为 `global`（与 rule-store 归一化一致）。
 * @param {any} value 扁平 front、`{front,text}` 文档或草案
 * @returns {string}
 */
export function scopeKeyOf(value) {
  const front = value && typeof value === 'object'
    ? (value.front && typeof value.front === 'object' ? value.front : value)
    : {}
  const raw = trimmed(front.scope) || 'global'
  if (raw.startsWith('workspace:')) {
    const path = raw.slice('workspace:'.length).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    return `workspace:${path}`
  }
  if (raw.startsWith('role:')) return `role:${raw.slice('role:'.length).trim()}`
  return raw
}

/**
 * 角色闸：两侧 role 都非空且不同 → 不同作用域（role A↔B 不得 merge/conflict）。
 *
 * 允许一侧为空：历史规则 role 为空表示"不绑定角色"（默认铁律/导入件都是空 role），
 * 否则聊天候选（带会话 role）会永远配不上任何既有规则，跨角色提示会淹没真关系。
 * @param {{role?:string}} a @param {{role?:string}} b @returns {boolean}
 */
function rolesCompatible(a, b) {
  const left = trimmed(a?.role)
  const right = trimmed(b?.role)
  if (!left || !right) return true
  return left === right
}

/**
 * 关系判定（架构书 §3.3）：先规则、后模型；本函数是**唯一**确定性判据。
 *
 * 判定顺序（先到先得）：
 * 1. 同 scope + 同 key → refine（沿用旧编号）；
 * 2. 同 scope + dedupeKey 相同或正文相似度 ≥0.9 → duplicate；
 * 3. 同 scope + 槽位重叠（对象词 Jaccard≥0.3 / 共享动作 / 共享条件事件）
 *    + 模态反转（must↔must_not / only↔except）或动词族互斥 → conflict；
 * 4. 同 scope + 槽位重叠 + 模态兼容 + 条件/例外互补 + 动词族不互斥 → merge；
 * 5. 其余：有同 scope 既有规则 → 'unrelated'；没有 → 'new'（两者下游动作相同）。
 *
 * 作用域闸（R8-04）：跨 scope（global↔workspace、workspace A↔B、role A↔B）一律 unrelated，
 * 不得 supersede/merge 他区规则；跨区命中放进 `crossScope` 供面板提示（只提示不改状态）。
 *
 * @param {object} draft compileStructured 的草案
 * @param {Array<any>} [existingRules] 真实规则（`{front,text}` 或扁平 front）
 * @returns {{relation:'new'|'duplicate'|'refine'|'merge'|'conflict'|'unrelated',
 *   targets:Array<{key:string,number:number|null,text:string,reason:string}>,
 *   crossScope?:Array<{key:string,scope:string,reason:string}>}}
 */
export function classifyRelation(draft, existingRules = []) {
  const rules = (Array.isArray(existingRules) ? existingRules : []).map(relationTarget)
  const draftScope = scopeKeyOf(draft)
  const scoped = rules.filter((rule) => scopeKeyOf(rule.front) === draftScope && rolesCompatible(draft, rule.front))
  const crossScope = rules
    .filter((rule) => scopeKeyOf(rule.front) !== draftScope)
    .map((rule) => ({ key: rule.key, scope: scopeKeyOf(rule.front), reason: 'cross_scope' }))
  const empty = {
    relation: scoped.length ? 'unrelated' : 'new',
    targets: [],
    ...(crossScope.length ? { crossScope } : {}),
  }
  if (!draft || !textOf(draft.text).trim()) return empty
  const draftKey = trimmed(draft.key)
  const draftText = textOf(draft.text)
  const view = draftViewOf(draft)

  const refine = scoped.find((rule) => rule.key && rule.key === draftKey)
  if (refine) {
    return { relation: 'refine', targets: [{ key: refine.key, number: refine.number, text: refine.text, reason: 'same_key' }] }
  }

  const draftHash = dedupeKey(draftText)
  const duplicates = scoped.filter((rule) => rule.key !== draftKey && rule.text && (
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

  // 不再用"推断域相等"做前置过滤：域是从关键词猜的（「以后都先提炼再删」会被猜成 general，
  // 而「禁止删源文件」是 file-hygiene，真正的槽位冲突就被域过滤吃掉了）。
  // 槽位判定（对象词 Jaccard / 共享动作 / 共享条件事件）足够具体，域只做展示。
  const candidates = scoped.filter((rule) => rule.key !== draftKey && rule.text)

  const conflicts = []
  const merges = []
  for (const rule of candidates) {
    const other = slotViewOf(rule)
    const overlap = slotOverlap(view, other)
    if (!overlap.overlap) continue
    const reversed = modalityReversed(view.modality, other.modality)
    const opposite = familiesOpposite(view.family, other.family)
    const compatible = view.modality === other.modality
      || (!reversed && !opposite)
    if (reversed || opposite) {
      conflicts.push({ rule, reason: opposite && !reversed ? 'verb_family_flip' : 'modality_flip' })
      continue
    }
    if (compatible && complementary(
      { conditions: view.conditions, exceptions: view.exceptions },
      { conditions: other.conditions, exceptions: other.exceptions },
    )) {
      merges.push({
        rule,
        reason: overlap.kind === 'shared_event' ? 'shared_event_conditions' : 'complementary_conditions',
      })
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
 * 改写守卫（架构书 §3.6）：逐条核对受影响旧规则，全过才允许落盘。
 *
 * 逐文件调用：`newText` 对**它替换的旧规则**校验；调用方把一批旧规则 + 该文件新正文传进来。
 *
 * @param {{affected?:Array<any>, mergedText?:string, draft?:object|null,
 *   strict?:boolean, acknowledgeDropped?:string[], relation?:string}} args
 *   affected: 旧规则（`{front,text}` 或扁平 front）；acknowledgeDropped: 非 strict 时 owner
 *   显式确认丢弃的规则 key 列表——这是**唯一**能放行"丢例外/丢条件"的通道；
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
  const acknowledged = new Set((Array.isArray(acknowledgeDropped) ? acknowledgeDropped : []).map((k) => trimmed(k)))
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
    const droppedOk = !strict && acknowledged.has(key)

    if ((oldIron || draftIsIron) && VAGUE_RE.test(merged)) {
      failures.push({ code: 'vague_word', key, detail: '铁律不得含模糊词（尽量/最好/尽可能…）' })
    }

    // 例外与条件同权（架构书 §3.6）：旧 conditions 丢了与丢例外一样必须拒绝，
    // 只留结构化字段而正文不写＝正文与 front 漂移，注入读到的就是没有条件的规则。
    for (const [code, field] of [['dropped_exception', 'exceptions'], ['dropped_condition', 'conditions']]) {
      const clauses = Array.isArray(front[field]) ? front[field] : []
      for (const clause of clauses) {
        if (retainsClause(mergedNorm, clause)) continue
        if (droppedOk) continue
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
