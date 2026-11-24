// 职责：规则文档解析/归一/校验/序列化与只读装载；依赖：node 内置 + ../rules.js（校验口径）+ ./paths.js（根归一）。
import { existsSync, readdirSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { detectSignals } from '../rules.js'
import { baseDir } from './paths.js'

/** 已知 front matter 字段（顺序即序列化顺序）。未知字段一律报错，不静默丢弃。 */
export const RULE_FIELDS = Object.freeze([
  'key', 'type', 'number', 'priority', 'scope', 'role', 'modality', 'action', 'object',
  'conditions', 'exceptions', 'status', 'merged_into', 'superseded_by', 'created',
  'updated', 'version', 'origin', 'summary',
])

export const RULE_TYPES = Object.freeze(['iron-rule', 'rule', 'rule-candidate'])
export const RULE_MODALITIES = Object.freeze(['must', 'must_not', 'only', 'except'])
export const RULE_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3'])
export const RULE_STATUSES = Object.freeze(['active', 'retired', 'superseded', 'proposal'])
/** 空号永不复用：6 是历史保留号，任何类型都不得占用。 */
export const RESERVED_NUMBERS = Object.freeze([6])
/**
 * 无编号铁律（台账「安全·密钥纪律」行）：它不属于 1–17 编号体系，key 固定、number=0。
 * 只放行这一个 key——number=0 一旦泛化，编号唯一性/nextNumber 就会失去"正整数"这个判据。
 */
export const UNNUMBERED_RULE_KEYS = Object.freeze(['iron-rule-safety'])

/**
 * 是否是无编号规则（key 在放行名单内**且** number 恰为 0）。
 * 编号相关逻辑（numbers Map/manifest/nextNumber）都靠它跳过：无编号不占号、不参与唯一性冲突。
 * @param {object} front @returns {boolean}
 */
export function isUnnumberedRule(front) {
  const f = front && typeof front === 'object' ? front : {}
  return UNNUMBERED_RULE_KEYS.includes(String(f.key ?? '').trim()) && Number(f.number) === 0
}

export const RULE_BODY_MAX = 500
/** 单条规则文件硬顶：超过即拒绝解析（含 front matter + 正文），防止一次误粘贴拖垮面板/注入。 */
export const RULE_FILE_MAX = 64 * 1024
/** AGENTS 摘要字段上限（码点）：只用于展示，正文仍是唯一规范文本。 */
export const SUMMARY_MAX = 120
/** 编号上限：iron-rule 只占 1–999；超出返回 number_exhausted，不静默写 1000。 */
export const RULE_NUMBER_MAX = 999
/**
 * 可编辑字段白名单：owner 只能改正文/条件/例外/作用域/角色/优先级/状态。
 * key/type/number/created 是身份与历史引用锚点，改了会让历史快照/镜像/引用全部指向错的东西，
 * 因此不在白名单里，且必须在**写入前**返回 `immutable_field`，不能靠 validate 兜。
 */
export const RULE_PATCH_FIELDS = Object.freeze(['text', 'conditions', 'exceptions', 'scope', 'role', 'priority', 'status'])
export const IMMUTABLE_RULE_FIELDS = Object.freeze(['key', 'type', 'number', 'created'])
/** status 变更只允许 active↔retired；superseded 只由合并链路写，proposal 只由提案链路写。 */
export const RULE_STATUS_TRANSITIONS = Object.freeze({
  active: Object.freeze(['retired']),
  retired: Object.freeze(['active']),
})
export const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** key 白名单（同时充当文件/锁路径安全闸；对外导出供路由/镜像复用）。 */
export function isValidRuleKey(key) {
  return KEY_RE.test(String(key ?? ''))
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]+)?$/
const VAGUE_RE = /(尽量|最好|尽可能|大概|也许|可能)/
const REASON_RE = /(因为|由于|理由是)/
const EXCEPTION_RE = /[；;，,]?\s*例外\s*[：:]\s*([^。；;\n]+)/
// ---------------------------------------------------------------------------
// YAML 子集：解析
// ---------------------------------------------------------------------------

/** @param {string} raw @param {number} lineNo @returns {{ok:boolean,value?:any,error?:string}} */
function parseValue(raw, lineNo) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: null }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) return { ok: false, error: `unclosed_array:${lineNo}` }
    const inner = s.slice(1, -1).trim()
    if (!inner) return { ok: true, value: [] }
    const parts = splitTopLevel(inner)
    const out = []
    for (const part of parts) {
      const got = parseValue(part, lineNo)
      if (!got.ok) return got
      out.push(got.value)
    }
    return { ok: true, value: out }
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) return { ok: false, error: `unclosed_quote:${lineNo}` }
    try {
      return { ok: true, value: JSON.parse(s) }
    } catch {
      return { ok: false, error: `bad_quote:${lineNo}` }
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return { ok: false, error: `unclosed_quote:${lineNo}` }
    return { ok: true, value: s.slice(1, -1).replace(/''/g, "'") }
  }
  const lower = s.toLowerCase()
  if (lower === 'null' || s === '~') return { ok: true, value: null }
  if (lower === 'true') return { ok: true, value: true }
  if (lower === 'false') return { ok: true, value: false }
  if (/^-?\d+$/.test(s)) return { ok: true, value: Number(s) }
  if (/^-?\d+\.\d+$/.test(s)) return { ok: true, value: Number(s) }
  return { ok: true, value: s }
}

/** 行内数组按顶层逗号切（引号里的逗号不切）。 */
function splitTopLevel(inner) {
  const out = []
  let buf = ''
  let quote = ''
  let escapes = 0
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      buf += ch
      if (quote === '"' && ch === '\\') { escapes += 1; continue }
      if (ch === quote && escapes % 2 === 0) quote = ''
      escapes = 0
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; escapes = 0; continue }
    if (ch === ',') { out.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/**
 * 解析规则文件（front matter + 正文）。
 * 失败返回 `{ok:false,error}`，不抛；错误带行号/字段名，便于面板直接展示。
 *
 * @param {string} source 文件全文
 * @returns {{ok:boolean,front?:object,text?:string,bodyStart?:number,error?:string}}
 */
export function parseRuleDocument(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { ok: false, error: 'front_matter_missing' }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end < 0) return { ok: false, error: 'front_matter_unclosed' }

  /** @type {Record<string, any>} */
  const front = {}
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue // 注释不是字段，避免手写文件被误判未知字段
    const m = raw.match(/^([a-z][a-z0-9_]*):(?:\s*(.*))?$/)
    if (!m) return { ok: false, error: `invalid_line:${i + 1}` }
    const field = m[1]
    if (Object.prototype.hasOwnProperty.call(front, field)) return { ok: false, error: `duplicate_field:${field}` }
    const valueRaw = String(m[2] ?? '').trim()
    // 严格子集只吃单行标量/行内数组：块标量（| / >）与锚点/标签一律拒绝并给行号，
    // 不能让"看起来像 YAML"的多行写法被解析成半个字段。
    if (/^[|>][+-]?\s*$/.test(valueRaw)) return { ok: false, error: `block_scalar_unsupported:${i + 1}` }
    if (/^[&*!]/.test(valueRaw)) return { ok: false, error: `unsupported_value:${i + 1}` }
    const got = parseValue(m[2], i + 1)
    if (!got.ok) return { ok: false, error: got.error }
    front[field] = got.value
  }

  let bodyLines = lines.slice(end + 1)
  let skippedBlank = 0
  // 规范格式是 `---` 后空一行；手写文件可能没有空行，两种都吃。
  while (bodyLines.length > 1 && bodyLines[0].trim() === '') {
    bodyLines = bodyLines.slice(1)
    skippedBlank += 1
  }
  const body = bodyLines.join('\n').replace(/\n+$/, '')
  const headerLen = lines.slice(0, end + 1).reduce((sum, line) => sum + line.length + 1, 0)
  return { ok: true, front, text: body, bodyStart: headerLen + skippedBlank }
}
// ---------------------------------------------------------------------------
// 文件读取闸（大小 / UTF-8 fatal）
// ---------------------------------------------------------------------------

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true })

/** 文件名 → key（去掉 `.md`；路径由调用方保证已安全）。 */
export function ruleKeyOfFile(file) {
  return String(file ?? '').replace(/^.*[\\/]/, '').replace(/\.md$/i, '')
}

/**
 * 读一个规则文件源文本，带上限与编码闸。
 *
 * 为什么不用 `readFileSync(path,'utf8')`：node 会把非法字节静默替换成 U+FFFD，
 * 于是坏文件变成"正文里多几个问号"，规则被改写而不自知。这里 fatal 解码 + 64KB 上限，
 * 失败即 `invalid_encoding` / `file_too_large`，由调用方标红。
 *
 * @param {string} file @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,text?:string,error?:string}}
 */
export function readRuleSource(file, opts = {}) {
  const fs = opts.fs || nodeFs
  let buf
  try { buf = fs.readFileSync(file) } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'rule_not_found' : 'read_failed' }
  }
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8')
  if (bytes.length > RULE_FILE_MAX) return { ok: false, error: 'file_too_large' }
  try {
    return { ok: true, text: UTF8_FATAL.decode(bytes) }
  } catch {
    return { ok: false, error: 'invalid_encoding' }
  }
}
// ---------------------------------------------------------------------------
// YAML 子集：序列化
// ---------------------------------------------------------------------------

/** 简单标量不加引号（可读性）；其余走 JSON 双引号，保证可逆。 */
function encodeScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number')
    return String(value)
  }
  const s = String(value)
  if (!s) return '""'
  const lower = s.toLowerCase()
  if (lower === 'null' || lower === 'true' || lower === 'false' || lower === '~') return JSON.stringify(s)
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return JSON.stringify(s)
  if (/^[\p{L}\p{N}][\p{L}\p{N}._@:/\\-]*$/u.test(s)) return s
  return JSON.stringify(s)
}

function encodeValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => encodeScalar(item)).join(', ')}]`
  return encodeScalar(value)
}

/**
 * 序列化规则文件。未知字段直接报错（与解析/校验同一白名单）。
 * @param {{front:object,text?:string,body?:string}} doc
 * @returns {{ok:boolean,text?:string,error?:string}}
 */
export function serializeRuleDocument(doc) {
  const front = doc?.front && typeof doc.front === 'object' ? doc.front : doc
  if (!front || typeof front !== 'object') return { ok: false, error: 'invalid_front' }
  const body = String(doc?.text ?? doc?.body ?? '')
  const unknown = Object.keys(front).filter((key) => !RULE_FIELDS.includes(key))
  if (unknown.length) return { ok: false, error: `unknown_field:${unknown.join(',')}` }
  const lines = ['---']
  for (const field of RULE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(front, field)) continue
    let encoded
    try {
      encoded = encodeValue(front[field])
    } catch (err) {
      return { ok: false, error: `bad_value:${field}:${err?.message || err}` }
    }
    lines.push(`${field}: ${encoded}`)
  }
  lines.push('---', '')
  return { ok: true, text: `${lines.join('\n')}\n${body}\n` }
}
// ---------------------------------------------------------------------------
// 归一化与校验
// ---------------------------------------------------------------------------

/** 本机时区取日（YYYY-MM-DD）：规则 created/updated 是"人看的日期"，不是 UTC 时间戳。 */
function today() {
  return dateOf(Date.now())
}

/** 补默认值（不改入参）；序列化前必须调用，避免文件里少字段导致每处各猜一遍。 */
export function normalizeRuleDoc(front, text) {
  // 刻意保留未知字段：normalize 不能当白名单（否则 validate 永远看不到拼错的字段）。
  // 序列化与校验各自拒绝未知字段，形成两道闸。
  const f = front && typeof front === 'object' ? { ...front } : {}
  const out = { ...f }
  const type = String(out.type ?? '').trim()
  out.key = String(out.key ?? '').trim()
  out.type = type
  // 编号只属于 iron-rule：普通规则/候选的 number 归一为 null（不占号、不参与唯一性）。
  // 手写文件若给 rule 带了 number，这里静默丢弃而不是报错——它从来不占用编号，报错只会
  // 让一份历史文件从列表消失；编号语义由 validateRule 对 iron-rule 严格校验。
  out.number = type !== 'iron-rule'
    ? null
    : (out.number === undefined || out.number === null || out.number === '' ? null : Number(out.number))
  out.priority = String(out.priority ?? 'P1').trim().toUpperCase()
  out.scope = String(out.scope ?? 'global').trim() || 'global'
  out.role = String(out.role ?? '').trim()
  out.modality = String(out.modality ?? 'must').trim()
  out.action = String(out.action ?? '').trim()
  out.object = String(out.object ?? '').trim()
  out.conditions = Array.isArray(out.conditions) ? out.conditions.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  out.exceptions = Array.isArray(out.exceptions) ? out.exceptions.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  out.status = String(out.status ?? (type === 'rule-candidate' ? 'proposal' : 'active')).trim()
  out.merged_into = String(out.merged_into ?? '').trim()
  out.superseded_by = String(out.superseded_by ?? '').trim()
  out.created = String(out.created ?? today()).trim()
  out.updated = String(out.updated ?? today()).trim()
  out.version = out.version === undefined || out.version === null || out.version === '' ? 1 : Number(out.version)
  out.origin = String(out.origin ?? '').trim()
  // summary 只用于 AGENTS 摘要/列表：空值直接省略（不留一行空字段污染 diff），
  // 换行压成单行——摘要渲染要求每条规则一行，这里先归一，validateRule 再判长度。
  if (out.summary !== undefined && out.summary !== null) {
    const summary = String(out.summary).replace(/[\r\n]+/g, ' ').trim()
    if (summary) out.summary = summary
    else delete out.summary
  }
  return { front: out, text: String(text ?? '') }
}

/** @param {string} scope @returns {string|null} 错误码，null=合法。 */
function scopeError(scope) {
  const s = String(scope ?? '')
  if (s === 'global') return null
  if (s.startsWith('workspace:')) {
    const p = s.slice('workspace:'.length).trim()
    if (!p) return 'scope_workspace_empty'
    if (!(p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))) return 'scope_workspace_relative'
    return null
  }
  if (s.startsWith('role:')) {
    const role = s.slice('role:'.length).trim()
    if (!role || /\s/.test(role) || role.length > 64) return 'scope_role_invalid'
    return null
  }
  return 'scope_invalid'
}

function charsOf(text) {
  return Array.from(String(text ?? '')).length
}

/**
 * 校验一条规则（front + 正文）。
 *
 * 失败返回错误数组而不是第一条：面板要一次展示所有问题，避免"改一个再报下一个"。
 * numbers 传入 `Map<number,key>`，用于跨文件编号唯一性；更新自身文件时调用方须先剔除自己。
 *
 * @param {object} front 已归一化 front
 * @param {string} text 正文
 * @param {{numbers?: Map<number,string>}} [opts]
 * @returns {{ok:boolean,errors:Array<{code:string,field:string|null,message:string}>}}
 */
export function validateRule(front, text, opts = {}) {
  const errors = []
  const push = (code, field, message) => errors.push({ code, field, message })
  const f = front && typeof front === 'object' ? front : {}

  const unknown = Object.keys(f).filter((key) => !RULE_FIELDS.includes(key))
  for (const field of unknown) push('unknown_field', field, `未知字段：${field}`)

  if (!KEY_RE.test(String(f.key ?? ''))) push('invalid_key', 'key', 'key 必须是 1–64 位小写字母/数字/._-')
  if (!RULE_TYPES.includes(f.type)) push('invalid_type', 'type', `type 必须是 ${RULE_TYPES.join('|')}`)
  // 编号只属于 iron-rule（1–999，跳过空号 6）；安全行 number=0 是唯一例外。
  // 普通规则/候选必须 number=null——它们不占号，也不参与唯一性/nextNumber。
  if (f.type !== 'iron-rule') {
    if (!(f.number === null || f.number === undefined)) {
      push('number_not_allowed', 'number', '只有 iron-rule 允许编号；rule/rule-candidate 的 number 必须为 null')
    }
  } else if (isUnnumberedRule(f)) {
    // number=0 合法：不占号、不参与唯一性（numbers Map 里也不会出现 0）。
  } else if (!Number.isInteger(f.number) || f.number <= 0) {
    push('invalid_number', 'number', 'number 必须是正整数（仅允许 iron-rule-safety 为 0）')
  } else if (RESERVED_NUMBERS.includes(f.number)) push('number_reserved', 'number', `编号 ${f.number} 是保留空号，永不复用`)
  else if (f.number > RULE_NUMBER_MAX) {
    push('number_too_large', 'number', `编号 ${f.number} 超过上限 ${RULE_NUMBER_MAX}`)
  }
  if (!RULE_PRIORITIES.includes(String(f.priority ?? '').toUpperCase())) {
    push('invalid_priority', 'priority', `priority 必须是 ${RULE_PRIORITIES.join('|')}`)
  }
  const scopeErr = scopeError(f.scope)
  if (scopeErr) push(scopeErr, 'scope', 'scope 必须是 global|workspace:<绝对路径>|role:<id>')
  if (!RULE_MODALITIES.includes(f.modality)) push('invalid_modality', 'modality', `modality 必须是 ${RULE_MODALITIES.join('|')}`)
  if (!RULE_STATUSES.includes(f.status)) push('invalid_status', 'status', `status 必须是 ${RULE_STATUSES.join('|')}`)
  if (!DATE_RE.test(String(f.created ?? ''))) push('invalid_created', 'created', 'created 必须是 YYYY-MM-DD')
  if (!DATE_RE.test(String(f.updated ?? ''))) push('invalid_updated', 'updated', 'updated 必须是 YYYY-MM-DD')
  if (!Number.isInteger(f.version) || f.version < 1) push('invalid_version', 'version', 'version 必须是正整数')

  for (const field of ['conditions', 'exceptions']) {
    if (!Array.isArray(f[field])) { push(`invalid_${field}`, field, `${field} 必须是字符串数组`); continue }
    if (f[field].some((item) => typeof item !== 'string' || !item.trim())) {
      push(`invalid_${field}`, field, `${field} 不允许空项/非字符串`)
    }
  }

  const body = String(text ?? '')
  const chars = charsOf(body)
  if (chars === 0) push('body_empty', null, '正文不能为空')
  if (chars > RULE_BODY_MAX) push('body_too_long', null, `正文 ${chars} 字，超过硬顶 ${RULE_BODY_MAX}`)
  // R8-06 写入闸：正文不得含 HTML 注释标记字面量——规则正文会进 AGENTS 摘要，一条 `<!--...-->`
  // 就能把管理块撕开，让后续摘要渲染落在标记外（注入/渲染侧另有防御，但入口必须拒）。
  if (/<!--|-->/.test(body)) push('html_comment_marker', null, '正文不得含 HTML 注释标记（<!-- / -->）')

  const numbers = opts.numbers instanceof Map ? opts.numbers : new Map()
  if (Number.isInteger(f.number) && numbers.has(f.number)) {
    const owner = numbers.get(f.number)
    // 墓碑号永不复用：map 里以 `retired:<key>` 标记，命中即 number_retired（即使 key 相同）。
    if (typeof owner === 'string' && owner.startsWith('retired:')) {
      push('number_retired', 'number', `编号 ${f.number} 已写墓碑（永不复用）`)
    } else if (owner !== f.key) {
      push('duplicate_number', 'number', `编号 ${f.number} 已被 ${owner} 占用`)
    }
  }

  // summary：可选；只用于摘要展示，因此强制单行 + 硬顶 120 码点（超了就是把正文塞进摘要）。
  if (f.summary !== undefined && f.summary !== null) {
    if (typeof f.summary !== 'string') {
      push('invalid_summary', 'summary', 'summary 必须是字符串')
    } else if (/[\r\n]/.test(f.summary)) {
      push('invalid_summary', 'summary', 'summary 必须是单行文本')
    } else if (charsOf(f.summary) > SUMMARY_MAX) {
      push('summary_too_long', 'summary', `summary ${charsOf(f.summary)} 字，超过上限 ${SUMMARY_MAX}`)
    }
  }

  // 隐私口径复用 rules.js：密钥/手机号/身份证/口令命中即拒绝（所有类型）。
  const signals = detectSignals(body)
  if (signals.rejectReason === 'privacy') push('privacy', null, '正文含密钥/手机号/身份证等敏感信息')
  if (!signals.imperative) push('not_imperative', null, '正文必须是指令形态（祈使/显式约束）')

  if (f.type === 'iron-rule') {
    if (VAGUE_RE.test(body)) push('vague_word', null, '铁律不得含模糊词（尽量/最好/尽可能/大概/也许/可能）')
    if (REASON_RE.test(body)) push('reason_sentence', null, '铁律不得含理由句（因为/由于/理由是）')
  }

  return { ok: errors.length === 0, errors }
}
/** `now`（毫秒/Date）→ 本机时区 `YYYY-MM-DD`；非法输入退回今天，不因时间戳造假日期。 */
export function dateOf(now) {
  const d = now instanceof Date ? now : new Date(Number.isFinite(now) ? Number(now) : Date.now())
  const at = Number.isNaN(d.getTime()) ? new Date() : d
  const p = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}
// ---------------------------------------------------------------------------
// 读写规则
// ---------------------------------------------------------------------------

export function findRuleFile(root, key) {
  for (const file of [join(root, `${key}.md`), join(root, 'proposals', `${key}.md`)]) {
    if (existsSync(file)) return file
  }
  return ''
}

/**
 * 读单条规则（含 front 默认值 + 正文 + 正文起始偏移）。
 * @param {string} root @param {string} key
 * @returns {{ok:boolean,rule?:{front:object,text:string,bodyStart:number,file:string},error?:string,detail?:any}}
 */
export function readRule(root, key) {
  const base = baseDir(root)
  if (!KEY_RE.test(String(key ?? ''))) return { ok: false, error: 'invalid_key' }
  const file = findRuleFile(base, key)
  if (!file) return { ok: false, error: 'rule_not_found' }
  const read = readRuleSource(file)
  if (!read.ok) return { ok: false, error: read.error }
  const parsed = parseRuleDocument(read.text)
  if (!parsed.ok) return { ok: false, error: 'invalid_rule', detail: { parse: parsed.error } }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  // key 必须等于文件名：手改文件名会造成「列表可见、readRule 找不到、再写一份就丢原条」。
  if (normalized.front.key !== String(key)) {
    return { ok: false, error: 'key_mismatch', detail: { key: String(key), frontKey: normalized.front.key, file } }
  }
  const check = validateRule(normalized.front, normalized.text, { numbers: new Map() })
  if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }
  return {
    ok: true,
    rule: { front: normalized.front, text: normalized.text, bodyStart: parsed.bodyStart, file },
  }
}

/**
 * 宽松读：只解析 front/正文，不跑内容守卫。purge 专用——手改写坏的规则也必须删得掉。
 * key≠文件名仍然拒绝（路径安全与「删错文件」防护），其余内容问题交给快照留证。
 * @param {string} root @param {string} key @returns {{ok:boolean,rule?:object,error?:string,detail?:any}}
 */
export function readRuleLax(root, key) {
  const base = baseDir(root)
  if (!KEY_RE.test(String(key ?? ''))) return { ok: false, error: 'invalid_key' }
  const file = findRuleFile(base, key)
  if (!file) return { ok: false, error: 'rule_not_found' }
  const read = readRuleSource(file)
  if (!read.ok) return { ok: false, error: read.error }
  const parsed = parseRuleDocument(read.text)
  if (!parsed.ok) return { ok: false, error: 'invalid_rule', detail: { parse: parsed.error } }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  if (normalized.front.key !== String(key)) {
    return { ok: false, error: 'key_mismatch', detail: { key: String(key), frontKey: normalized.front.key, file } }
  }
  return {
    ok: true,
    rule: { front: normalized.front, text: normalized.text, bodyStart: parsed.bodyStart, file },
  }
}

/**
 * 列出全部规则（根目录 + proposals/）。
 * 解析失败的条目进 errors（不吞、不覆盖），合法条目才参与编号/manifest。
 *
 * @param {string} root
 * @returns {{ok:boolean,rules:Array<object>,errors:Array<{file:string,error:string}>}}
 */
export function listRules(root) {
  const base = baseDir(root)
  const rules = []
  const errors = []
  const files = []
  for (const dir of [base, join(base, 'proposals')]) {
    let names
    try { names = readdirSync(dir).filter((n) => n.endsWith('.md')) } catch { continue }
    files.push(...names.sort().map((name) => ({ dir, name })))
  }
  const numbers = new Map()
  const seenKeys = new Map()
  for (const { dir, name } of files) {
    const file = join(dir, name)
    if (name.toUpperCase() === 'README.MD') continue
    const read = readRuleSource(file)
    if (!read.ok) { errors.push({ file, error: read.error }); continue }
    const parsed = parseRuleDocument(read.text)
    if (!parsed.ok) { errors.push({ file, error: parsed.error }); continue }
    const normalized = normalizeRuleDoc(parsed.front, parsed.text)
    // key=文件名闸：文件名被手改的规则跳过并标 key_mismatch（列表/详情都不再假装它叫新名字）。
    const fileKey = ruleKeyOfFile(name)
    if (normalized.front.key !== fileKey) {
      errors.push({ file, error: 'key_mismatch', detail: { key: fileKey, frontKey: normalized.front.key } })
      continue
    }
    // key 唯一（跨根目录与 proposals/）：同名两份会让列表/摘要重复、purge 只删一份。
    // 根目录先列（files 顺序）→ 根优先；第二份记 duplicate_key 红项，不参与列表。
    const priorFile = seenKeys.get(normalized.front.key)
    if (priorFile) {
      errors.push({ file, error: 'duplicate_key', detail: { key: normalized.front.key, first: priorFile } })
      continue
    }
    seenKeys.set(normalized.front.key, file)
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) { errors.push({ file, error: 'invalid_rule', detail: check.errors }); continue }
    // 只有 iron-rule 的正整数编号占号；普通规则/候选 number=null，永不参与撞号。
    if (normalized.front.type === 'iron-rule'
      && Number.isInteger(normalized.front.number) && normalized.front.number > 0
      && numbers.has(normalized.front.number)) {
      errors.push({ file, error: 'duplicate_number', detail: { number: normalized.front.number } })
      continue
    }
    // 无编号规则（number=0）不占号：不进 numbers，也就不会与任何规则撞号。
    if (normalized.front.type === 'iron-rule'
      && Number.isInteger(normalized.front.number) && normalized.front.number > 0) {
      numbers.set(normalized.front.number, normalized.front.key)
    }
    rules.push({ ...normalized, bodyStart: parsed.bodyStart, file })
  }
  // 编号优先（只有铁律有号），无号规则按 key；number=null 不能参与减法（会得 NaN 打乱顺序）。
  rules.sort((a, b) => {
    const na = Number.isInteger(a.front.number) ? a.front.number : Number.POSITIVE_INFINITY
    const nb = Number.isInteger(b.front.number) ? b.front.number : Number.POSITIVE_INFINITY
    return na - nb || a.front.key.localeCompare(b.front.key)
  })
  return { ok: true, rules, errors }
}
