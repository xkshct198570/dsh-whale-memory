/**
 * 规则仓储（R3a）：文件是真源，DB 只是镜像。
 *
 * 职责：
 * - 规则目录（默认 `$DSH_HOME/rules`，可参数覆盖）的初始化、规则文件读写、manifest 生成；
 * - 严格 YAML 子集 front matter 的解析/序列化与 schema 校验（不引依赖、不猜格式）；
 * - 原子写 + 写入前历史快照（每 key 保留 20 份）+ 回滚；
 * - R5：`updateRule`（白名单字段编辑，version+1）、`revertRule`（旧版本正文/front 写回成新版本）、
 *   `resolveRevision`（history 时间戳/ISO/git 短 sha → 某个版本）+ `diffLines`（纯函数行 diff）；
 * - git 只做本地 add/commit/log/show/revert，**绝不联网**（不 fetch/push/pull）。
 *
 * 边界：
 * - 本模块不认识 DB、不认识 HTTP、不调模型；镜像在 rule-mirror.js，路由在 rules-routes.js。
 * - 只允许 node 内置模块。校验口径复用 rules.js 的 detectSignals（隐私/模糊/祈使判定），
 *   避免"规则引擎一套口径、仓储又一套"。
 * - `updateRule`/`revertRule` 只负责"文件 + git + 历史"；镜像/AGENTS 渲染/审计由路由层编排，
 *   因为那三件事依赖 backend/config，仓储层不该反向 import host。
 *
 * Why 文件优先：规则需要人可读、可 diff、可回滚；数据库列改一次就要迁移，规则正文却要
 * 被 owner 反复手改。文件 + git 才是可审计的真源，manifest/history 都是生成物。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { detectSignals, normalizeRuleText, ruleKeyOf } from './rules.js'

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
export const HISTORY_KEEP = 20
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
/** 单次 diff 的行数硬顶（5000 行 ≈ 面板可读上限，超出直接报错而不是卡死浏览器）。 */
export const DIFF_LINE_LIMIT = 5000
export const MANIFEST_FILE = 'manifest.json'
export const RULE_DIRS = Object.freeze(['proposals', 'history', 'retired', '.txn'])
/** 墓碑目录：已彻底删除规则的 `{key,number,at,reason}` 台账，append-only，可重建 manifest。 */
export const RETIRED_DIR = 'retired'
/** 应用事务日志目录（短命；启动恢复后删除；不进 git）。 */
export const TXN_DIR = '.txn'
/** 跨进程仓库级写锁目录（生成物，不进 git）。 */
export const LOCK_DIR = '.locks'
/** 仓库级锁名：manifest/commit/编号都是全仓资源，一把锁避免假并发。 */
export const REPO_LOCK = 'repo.lock'
/** 锁失效阈值（不续租）：覆盖最长 git 操作；接口冻结为 120s。 */
export const REPO_LOCK_STALE_MS = 120000
/** 规则仓 `.gitignore` 必须包含的条目（候选/快照/事务/锁/播种 marker 都是本机生成物）。 */
export const GITIGNORE_LINES = Object.freeze([
  '*.tmp-*', '.locks/', '.txn/', '.seeded.json', 'proposals/', 'history/',
])
const GIT_TIMEOUT_MS = 5000
const GIT_IDENT = Object.freeze(['-c', 'user.name=dsh-whale-memory', '-c', 'user.email=rules@local'])

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** key 白名单（同时充当文件/锁路径安全闸；对外导出供路由/镜像复用）。 */
export function isValidRuleKey(key) {
  return KEY_RE.test(String(key ?? ''))
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]+)?$/
const VAGUE_RE = /(尽量|最好|尽可能|大概|也许|可能)/
const REASON_RE = /(因为|由于|理由是)/
const EXCEPTION_RE = /[；;，,]?\s*例外\s*[：:]\s*([^。；;\n]+)/

// ---------------------------------------------------------------------------
// 路径与默认根
// ---------------------------------------------------------------------------

/**
 * 默认规则根：`$DSH_HOME/rules`，未设 DSH_HOME 时 `~/.dsh/rules`。
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function defaultRuleRoot(opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || homedir()
  const dshHome = String(env.DSH_HOME || '').trim()
  return dshHome ? join(resolve(dshHome), 'rules') : join(home, '.dsh', 'rules')
}

/**
 * 规则根归一：空 → 默认根；字符串 → 绝对路径。
 *
 * 非字符串（对象/数组/数字）**抛 TypeError**：`resolve({})` 曾把对象静默转成 `"[object Object]"`
 * 目录，规则被写到垃圾路径且无人报错。宁可当场红，也不接受"猜一个根"。
 *
 * @param {string} [root] @returns {string}
 * @throws {TypeError} root 既不是字符串也不是 null/undefined
 */
function baseDir(root) {
  if (root !== undefined && root !== null && typeof root !== 'string') {
    throw new TypeError('rules root must be a string')
  }
  const raw = String(root ?? '').trim()
  return raw ? resolve(raw) : defaultRuleRoot()
}

/** 规则文件落点：候选进 proposals/，正式规则在根目录。 */
function rulePath(root, front) {
  const dir = front?.type === 'rule-candidate' ? join(root, 'proposals') : root
  return join(dir, `${front.key}.md`)
}

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
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      buf += ch
      if (ch === quote && inner[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }
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
  if (Number.isInteger(f.number) && numbers.has(f.number) && numbers.get(f.number) !== f.key) {
    push('duplicate_number', 'number', `编号 ${f.number} 已被 ${numbers.get(f.number)} 占用`)
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

// ---------------------------------------------------------------------------
// 原子写 / 历史
// ---------------------------------------------------------------------------

/**
 * 原子写：同目录 tmp + rename；失败清理 tmp，旧文件保持原样。
 * @param {string} file @param {string} text @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,error?:string}}
 */
export function atomicWriteFile(file, text, opts = {}) {
  const fs = opts.fs || nodeFs
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    fs.writeFileSync(tmp, String(text), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* tmp 可能没建出来；清理失败不掩盖原始错误 */ }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 文本 sha256（事务恢复用：判断文件是否仍是本事务写下的中间态）。 */
function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 同步等待（主线程无 await 可用；锁只持有毫秒级，阻塞可接受）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
}

/**
 * 落盘到磁盘（tmp + fsync + rename + fsync 目录）：墓碑必须先于删文件真正持久化。
 *
 * 为什么不用 atomicWriteFile：rename 只保证"要么旧要么新"，不保证内容到盘。断电后
 * 「文件已删、墓碑没落盘」会让编号被复用——这是 R8 的核心不变式，必须 fsync。
 *
 * @param {string} file @param {string} text @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,error?:string}}
 */
export function durableWriteFile(file, text, opts = {}) {
  const fs = opts.fs || nodeFs
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  let fd = null
  try {
    const handle = fs.openSync(tmp, 'w')
    fd = handle
    fs.writeFileSync(handle, String(text), 'utf8')
    try { fs.fsyncSync(handle) } catch { /* 部分文件系统/假 fs 不支持 fsync：尽力而为，不掩盖写入 */ }
    fs.closeSync(handle)
    fd = null
    fs.renameSync(tmp, file)
    fsyncDir(dirnameOf(file), fs)
    return { ok: true }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 句柄可能已关 */ } }
    try { fs.unlinkSync(tmp) } catch { /* tmp 可能没建出来 */ }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 目录 fsync（best effort）：rename 的目录项也要到盘，否则崩溃后墓碑文件名可能丢。 */
function fsyncDir(dir, fs = nodeFs) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch { /* 目录 fsync 在部分平台不支持，尽力而为 */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
}

/** @param {string} file @returns {string} */
function dirnameOf(file) {
  return dirname(String(file))
}

/**
 * 仓库级写锁：`.locks/repo.lock`（mkdir 原子），`owner.json` 记 pid/ts。
 *
 * 为什么一把锁而不是每 key 一把：manifest/commit/编号都是**全仓**资源，多把锁只会制造
 * "看起来能并发、实际互相覆盖"的假并发。锁不续租（接口冻结 staleMs=120s）：持锁期间的
 * git commit 最长也就秒级，用一个大阈值覆盖整个临界区，比每 2s touch 更简单可靠。
 *
 * @param {string} root
 * @param {{fs?: typeof nodeFs, timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {{ok:boolean, release?:Function, owner?:object, error?:string}}
 */
export function acquireRepoLock(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const lockRoot = join(base, LOCK_DIR)
  const lock = join(lockRoot, REPO_LOCK)
  const ownerFile = join(lock, 'owner.json')
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : REPO_LOCK_STALE_MS
  const started = Date.now()
  try { fs.mkdirSync(lockRoot, { recursive: true }) } catch (err) {
    return { ok: false, error: `lock_dir_failed:${err?.message || err}` }
  }
  for (;;) {
    const owner = { pid: process.pid, ts: Date.now(), nonce: randomBytes(8).toString('hex') }
    try {
      fs.mkdirSync(lock)
      try { fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8') } catch (err) {
        try { fs.rmdirSync(lock) } catch { /* 清不掉也继续报错，不吞 */ }
        return { ok: false, error: `lock_owner_failed:${err?.message || err}` }
      }
      return {
        ok: true,
        owner,
        /**
         * 只删"自己那一把"：stale 接管后旧持有者的 release 晚到，若直接 rmdir 会把
         * 新持有者的锁删掉（两个进程同时进临界区）。nonce 不匹配即视为已被接管，不删。
         */
        release() {
          let held = null
          try { held = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) } catch { held = null }
          if (!held || held.nonce !== owner.nonce) return false
          try { fs.unlinkSync(ownerFile) } catch { /* owner 可能已被接管 */ }
          try { fs.rmdirSync(lock) } catch { /* 已被清理/权限变化：不应掩盖写入结果 */ }
          return true
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, error: `lock_failed:${err?.message || err}` }
      let held = null
      try {
        held = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      } catch { held = null }
      let heldAt = Number(held?.ts)
      if (!Number.isFinite(heldAt)) {
        // owner.json 没写成（持锁进程刚 mkdir 就崩）：退回目录 mtime 判活。
        try { heldAt = fs.statSync(lock).mtimeMs } catch { heldAt = 0 }
      }
      if (Number.isFinite(heldAt) && Date.now() - heldAt > staleMs) {
        try {
          if (typeof fs.rmSync === 'function') fs.rmSync(lock, { recursive: true, force: true })
          else fs.rmdirSync(lock)
        } catch { /* 被别的进程刚接管/清理：回到循环重抢 */ }
        continue
      }
      if (Date.now() - started > timeoutMs) return { ok: false, error: 'repo_locked', owner: held }
      sleepSync(10)
    }
  }
}

/**
 * 在仓库级锁内执行同步函数；抛错也释放。
 *
 * @template T
 * @param {string} root @param {() => T} fn
 * @param {{fs?: typeof nodeFs, timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {T | {ok:false, error:string}}
 */
export function withRepoLock(root, fn, opts = {}) {
  const lock = acquireRepoLock(root, opts)
  if (!lock.ok) return { ok: false, error: lock.error, lock: lock.owner || null }
  try {
    return fn()
  } finally {
    lock.release()
  }
}

/**
 * 同 key 跨进程互斥：mkdir 是原子的，抢不到就等；崩溃遗留锁超过 staleMs 视为失效。
 * 为什么必须跨进程：规则目录可能被编辑器/脚本/面板同时写；仅靠 tmp+rename 能保证
 * 文件不半截，但编号校验、历史快照仍会交错。锁范围只覆盖准备→落盘→manifest。
 *
 * @param {string} root @param {string} key
 * @param {{fs?: typeof nodeFs, timeoutMs?: number, staleMs?: number}} [opts]
 * @returns {{ok:boolean,release?:Function,error?:string}}
 */
export function acquireRuleLock(root, key, opts = {}) {
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const fs = opts.fs || nodeFs
  const lockRoot = join(baseDir(root), LOCK_DIR)
  const lock = join(lockRoot, `${key}.lock`)
  const ownerFile = join(lock, 'owner.json')
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 10000
  const started = Date.now()
  try { fs.mkdirSync(lockRoot, { recursive: true }) } catch (err) {
    return { ok: false, error: `lock_dir_failed:${err?.message || err}` }
  }
  for (;;) {
    const owner = { pid: process.pid, key, ts: Date.now(), nonce: randomBytes(8).toString('hex') }
    try {
      fs.mkdirSync(lock)
      try { fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8') } catch (err) {
        try { fs.rmdirSync(lock) } catch { /* 清不掉也继续报错 */ }
        return { ok: false, error: `lock_owner_failed:${err?.message || err}` }
      }
      return {
        ok: true,
        owner,
        release() {
          // nonce 不匹配 = 锁已被 stale 接管，不能删别人的锁（见 repo lock 同注释）。
          let held = null
          try { held = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) } catch { held = null }
          if (!held || held.nonce !== owner.nonce) return false
          try { fs.unlinkSync(ownerFile) } catch { /* owner 可能已被接管 */ }
          try { fs.rmdirSync(lock) } catch { /* 已被清理/权限变化：不应掩盖写入结果 */ }
          return true
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, error: `lock_failed:${err?.message || err}` }
      let heldAt = 0
      try { heldAt = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).ts } catch {
        try { heldAt = fs.statSync(lock).mtimeMs } catch { heldAt = 0 }
      }
      if (Number.isFinite(heldAt) && Date.now() - heldAt > staleMs) {
        try {
          // 锁目录里现在有 owner.json，rmdir 会 ENOTEMPTY → 必须递归删。
          if (typeof fs.rmSync === 'function') fs.rmSync(lock, { recursive: true, force: true })
          else { try { fs.unlinkSync(ownerFile) } catch { /* 无 owner */ }; fs.rmdirSync(lock) }
        } catch { /* 刚被接管/清理：回到循环重抢 */ }
        continue
      }
      if (Date.now() - started > timeoutMs) return { ok: false, error: 'rule_locked' }
      sleepSync(10)
    }
  }
}

/** 17 位时间戳（YYYYMMDDHHmmssSSS），与 DB 快照命名口径一致。 */
function stampNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/** 同一毫秒内多次写入时追加序号，保证快照不互相覆盖。 */
function uniqueStamp(dir, fs) {
  const base = stampNow()
  let stamp = base
  for (let i = 2; existsSyncSafe(join(dir, `${stamp}.md`), fs); i += 1) stamp = `${base}-${i}`
  return stamp
}

function existsSyncSafe(path, fs = nodeFs) {
  try { return fs.existsSync(path) } catch { return false }
}

/**
 * 快照名排序键：`(17 位戳, 同毫秒序号)`，序号缺省=1。
 *
 * 为什么不能用字典序：`...000-10.md` 字典序小于 `...000-2.md`，pruneHistory 会把"最新"
 * 当"最旧"删掉、历史列表顺序也会错。数值比较才不会把同毫秒的第 10 份当第 2 份。
 * @param {string} name @returns {number[]|null}
 */
function revSortKey(name) {
  const m = String(name).replace(/\.md$/i, '').match(/^(\d{17})(?:-(\d+))?$/)
  if (!m) return null
  return [Number(m[1]), m[2] ? Number(m[2]) : 1]
}

/** 快照名比较：合法戳按数值，非法名退回字典序（不把坏名混进数值序列）。 */
function compareRevs(a, b) {
  const ka = revSortKey(a)
  const kb = revSortKey(b)
  if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1]
  if (ka) return 1
  if (kb) return -1
  return String(a).localeCompare(String(b))
}

function pruneHistory(dir, fs) {
  let names
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(compareRevs) } catch { return [] }
  const removed = []
  for (const name of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) {
    try { fs.unlinkSync(join(dir, name)); removed.push(name) } catch { /* 删不掉就留着，历史多一份比丢一份安全 */ }
  }
  return removed
}

/**
 * 写入前把旧文件全文快照到 `history/<key>/<ts>.md`，只保留 20 份。
 * @param {string} root @param {string} key @param {string} content @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,rev?:string,error?:string}}
 */
export function writeHistorySnapshot(root, key, content, opts = {}) {
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const fs = opts.fs || nodeFs
  const dir = join(baseDir(root), 'history', key)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const rev = uniqueStamp(dir, fs)
    // 快照也要 fsync：断电后「正文已新、旧版本没落盘」等于丢了可回滚的上一版。
    const written = durableWriteFile(join(dir, `${rev}.md`), String(content), { fs })
    if (!written.ok) return { ok: false, error: `snapshot_write_failed:${written.error}` }
    pruneHistory(dir, fs)
    return { ok: true, rev }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 历史列表（新→旧）。source 取快照 front.origin；解析失败也给空 front，不丢文件记录。
 * `version` 供 `/rules/versions` 面板直读（解析失败给 null，不猜）。
 * @param {string} root @param {string} key
 * @returns {{ok:boolean,entries?:Array<{rev:string,ts:string,version:number|null,source:string,text:string}>,error?:string}}
 */
export function readHistory(root, key) {
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const base = baseDir(root)
  const dir = join(base, 'history', key)
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort(compareRevs).reverse() } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, entries: [] }
    return { ok: false, error: String(err?.message || err) }
  }
  const entries = []
  for (const name of names) {
    const rev = name.replace(/\.md$/, '')
    const parsed = readSnapshotFile(base, key, rev)
    entries.push({
      rev,
      ts: isoOfRev(rev),
      version: parsed.ok && Number.isInteger(parsed.rule.front.version) ? parsed.rule.front.version : null,
      source: parsed.ok ? String(parsed.rule.front.origin || 'file') : 'file',
      text: parsed.ok ? parsed.rule.text : '',
    })
  }
  return { ok: true, entries }
}

function readSnapshotFile(base, key, rev) {
  const file = join(base, 'history', key, `${rev}.md`)
  // 快照与规则同一个读取闸：坏 UTF-8 的旧快照不能靠 U+FFFD 混成"看起来正常的旧版"。
  const read = readRuleSource(file)
  if (!read.ok) return { ok: false, error: read.error === 'rule_not_found' ? 'snapshot_not_found' : read.error }
  const parsed = parseRuleDocument(read.text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  return { ok: true, rule: { ...normalized, bodyStart: parsed.bodyStart, file } }
}

/** 17 位戳 → ISO（失败给空串，历史列表不该因命名异常整列失败）。 */
function isoOfRev(rev) {
  const m = String(rev).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/)
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}`
}

/**
 * 读某个历史快照（不写盘）。
 * @param {string} root @param {string} key @param {string} rev
 * @returns {{ok:boolean,rule?:object,error?:string}}
 */
export function readSnapshot(root, key, rev) {
  if (!KEY_RE.test(String(key ?? ''))) return { ok: false, error: 'invalid_key' }
  if (!/^[0-9-]+$/.test(String(rev ?? ''))) return { ok: false, error: 'invalid_rev' }
  return readSnapshotFile(baseDir(root), key, rev)
}

// ---------------------------------------------------------------------------
// 读写规则
// ---------------------------------------------------------------------------

function findRuleFile(root, key) {
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

/**
 * 写一条规则：归一化 → 校验 → 历史快照 → 原子写 → manifest → git commit。
 *
 * 并发：同 key 的两个同步写入天然串行（Node 单线程 + 唯一 tmp 名）；跨进程 rename 原子，
 * 最后写入者胜出，但不会出现半文件。
 *
 * @param {string} root
 * @param {{front?:object,text?:string,body?:string}|object} input 可传 `{front,text}` 或扁平 front
 * @param {{fs?: typeof nodeFs, git?: boolean, exec?: Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,git?:object,error?:string,detail?:any}}
 */
export function writeRule(root, input, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const rawFront = input?.front && typeof input.front === 'object' ? input.front : input
  const rawText = input?.text ?? input?.body ?? ''
  const normalized = normalizeRuleDoc(rawFront, rawText)
  // 先挡住路径：key 会进目录名/文件名，后面的 ensure（建目录）与锁都不能拿到越界 key。
  if (!isValidRuleKey(normalized.front.key)) {
    return { ok: false, error: 'invalid_rule', detail: [{ code: 'invalid_key', field: 'key', message: 'key 非法' }] }
  }

  const run = () => {
    // 首次写规则时初始化 git 仓库；git 缺失只降级（ensureRuleRepo 不抛），文件仍可写。
    const ensured = ensureRuleRepo({ root: base, git: opts.git !== false, fs, exec: opts.exec })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }

    const existing = listRules(base)
    // 编号唯一性用占用集合（文件名 ∪ front ∪ 墓碑）而不是"解析成功的规则"：
    // 手改坏的 iron-rule-N.md 解析失败也必须挡住新建/改写撞号（R9-02）。
    // 自己那条要剔出去（改自己的正文/版本不能被自己判成撞号）。
    const numbers = new Map()
    for (const doc of existing.rules) {
      if (doc.front.key === normalized.front.key) continue
      if (doc.front.type !== 'iron-rule') continue
      if (!(Number.isInteger(doc.front.number) && doc.front.number > 0)) continue
      numbers.set(doc.front.number, doc.front.key)
    }
    for (const n of fileRuleNumbers(base, { fs })) {
      if (n === normalized.front.number) continue
      if (!numbers.has(n)) numbers.set(n, `iron-rule-${n}.md`)
    }
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

    const serialized = serializeRuleDocument(normalized)
    if (!serialized.ok) return { ok: false, error: 'serialize_failed', detail: serialized.error }

    const target = rulePath(base, normalized.front)
    const oldFile = findRuleFile(base, normalized.front.key)
    let snapshot = null
    let oldSource = null
    if (oldFile) {
      const old = readRuleSource(oldFile, { fs })
      if (!old.ok) return { ok: false, error: 'snapshot_read_failed', detail: old.error }
      oldSource = old.text
      snapshot = writeHistorySnapshot(base, normalized.front.key, oldSource, { fs })
      if (!snapshot.ok) return { ok: false, error: 'snapshot_failed', detail: snapshot.error }
    }
    // 显式路径：本文件 + manifest（+ 旧文件若被移走）；不用 add -A，避免把候选/快照带进提交。
    const paths = Array.isArray(opts.commitPaths)
      ? [...new Set([...opts.commitPaths, relative(base, target), MANIFEST_FILE, ...(oldFile && oldFile !== target ? [relative(base, oldFile)] : [])])]
      : [relative(base, target), MANIFEST_FILE, ...(oldFile && oldFile !== target ? [relative(base, oldFile)] : [])]
    const rollback = () => rollbackWriteAttempt(base, {
      target, oldFile, oldSource, key: normalized.front.key, historyRev: snapshot?.rev || '', paths, fs, exec: opts.exec,
    })

    // 正文与 history 都走 durableWriteFile（tmp+fsync+rename+fsync dir）：R9-03 起"原子"升级为"持久"。
    const written = durableWriteFile(target, serialized.text, { fs })
    if (!written.ok) {
      const cleanup = snapshot?.rev ? removeHistoryEntry(base, normalized.front.key, snapshot.rev, fs) : null
      return { ok: false, error: 'write_failed', detail: written.error, rollbackFailures: cleanup ? [cleanup] : [] }
    }
    if (oldFile && oldFile !== target) {
      try { fs.unlinkSync(oldFile) } catch (err) {
        // 两份文件同时存在会让 listRules 报编号冲突；回滚新文件，保持旧状态。
        const rolled = rollback()
        return {
          ok: false, error: 'move_failed', detail: String(err?.message || err),
          rolledBack: rolled.ok, rollbackFailures: rolled.failures,
        }
      }
    }

    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) {
      const rolled = rollback()
      return {
        ok: false, error: 'manifest_failed', detail: manifest.error,
        rolledBack: rolled.ok, rollbackFailures: rolled.failures,
      }
    }

    let git = null
    if (opts.git !== false) {
      const done = commitRuleChanges(base, `rules: ${normalized.front.key} v${normalized.front.version}`, {
        exec: opts.exec,
        paths,
      })
      if (!done.ok && !isGitDegraded(done.error)) {
        // 非降级提交失败：真源必须回到写前（文件/manifest/history/index 四处），不得 ok:true 丢提交。
        const rolled = rollback()
        return {
          ok: false, error: 'commit_failed', detail: { stage: 'commit', error: done.error || 'git_failed' },
          rolledBack: rolled.ok, rollbackFailures: rolled.failures,
        }
      }
      git = done.ok
        ? { ok: true, committed: Boolean(done.committed), message: done.message }
        : { ok: false, committed: false, degraded: true, message: done.message, error: done.error || 'git_failed' }
    }
    return {
      ok: true,
      rule: {
        front: normalized.front,
        text: normalized.text,
        bodyStart: parseRuleDocument(serialized.text).bodyStart,
        file: target,
      },
      path: target,
      history: snapshot?.rev || '',
      manifest: manifest.manifest,
      git,
    }
  }

  // 锁外默认自己拿仓库级锁；锁内调用方传 lockHeld:true（create/update/apply/seed）。
  if (opts.lockHeld === true) return run()
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return run()
  } finally {
    lock.release()
  }
}

/**
 * 删除规则：默认 status=retired 留文件；只有 rule-candidate + force=true 才物理删。
 * @param {string} root @param {string} key
 * @param {{force?:boolean,fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,deleted?:boolean,retired?:boolean,rule?:object,error?:string,detail?:any}}
 */
export function deleteRule(root, key, opts = {}) {
  const base = baseDir(root)
  const fs = opts.fs || nodeFs
  const got = readRule(base, key)
  if (!got.ok) return got
  const doc = got.rule
  if (opts.force === true && doc.front.type === 'rule-candidate') {
    const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
    if (!lock.ok) return { ok: false, error: lock.error }
    try {
      const old = readRuleSource(doc.file, { fs })
      if (!old.ok) return { ok: false, error: old.error }
      const snap = writeHistorySnapshot(base, key, old.text, { fs })
      if (!snap.ok) return { ok: false, error: 'snapshot_failed', detail: snap.error }
      try { fs.unlinkSync(doc.file) } catch (err) { return { ok: false, error: 'delete_failed', detail: String(err?.message || err) } }
      regenerateManifest(base, { fs })
      if (opts.git !== false) {
        commitRuleChanges(base, `rules: delete candidate ${key}`, {
          exec: opts.exec,
          paths: [relative(base, doc.file), MANIFEST_FILE],
        })
      }
      return { ok: true, deleted: true }
    } finally {
      lock.release()
    }
  }
  const next = normalizeRuleDoc({
    ...doc.front,
    status: 'retired',
    updated: today(),
    version: Number(doc.front.version) + 1,
  }, doc.text)
  const saved = writeRule(base, next, opts)
  if (!saved.ok) return saved
  return { ok: true, retired: true, rule: saved.rule }
}

// ---------------------------------------------------------------------------
// 新建 / 停用 / 恢复（面板直写，不经提案决策流水线）
// ---------------------------------------------------------------------------

/**
 * 新建规则可接受的 draft 字段白名单。
 *
 * 刻意**不含** key/type 之外的元数据（number/created/version/origin/status）：编号是"永不复用"的
 * 全局资源、created 是历史锚点、origin 是归属审计，都必须由仓储分配/盖章，不能由面板随便写。
 * 也不含 modality——模态从正文推断，避免"正文说禁止、front 写 must"的自相矛盾。
 */
export const CREATE_DRAFT_FIELDS = Object.freeze([
  'text', 'type', 'priority', 'scope', 'role', 'conditions', 'exceptions', 'action', 'object',
])
export const CREATE_RULE_TYPES = Object.freeze(['iron-rule', 'rule'])

/**
 * 模态推断（新建规则用）：与 rule-reconcile.js 的 `modalityOf` 同一口径。
 *
 * 为什么不 import：rule-reconcile 反向 import 本模块的常量（RESERVED_NUMBERS/RULE_BODY_MAX 等），
 * 再互相 import 就成环。这里复制三条正则，**两处必须同改**（有单测 `createRule：模态从正文推断` 盯着）。
 */
const MANUAL_NEG_RE = /(禁止|不得|不许|不准|不能|不必|无需|不用|毋须|切勿|勿|不要|别再|别用|别把|别删|别改|别(?!人|的|处|致|样)|严禁|避免|never|must not|do not|don't)/i
const MANUAL_ONLY_RE = /(只能|只准|只允许|仅能|仅允许|只用|只保留|只读|只做|只接受|只支持|只(?:用|留|存|删|选|取|做|算|跑|走|看|读|写|发|收|要|能|须|需|有|是|可|会|应|得|让|把|给|对|向|从|在|为|于))/
const MANUAL_EXCEPT_RE = /除(?:了)?[^，,。；;]{1,40}外/

/** @param {string} text @returns {'must'|'must_not'|'only'|'except'} */
function manualModalityOf(text) {
  const s = String(text ?? '')
  if (MANUAL_NEG_RE.test(s)) return 'must_not'
  if (MANUAL_EXCEPT_RE.test(s)) return 'except'
  if (MANUAL_ONLY_RE.test(s)) return 'only'
  return 'must'
}

/**
 * 旧编号永不回收：所有规则（含 retired/archived）的编号都算占用；已彻底删除的编号
 * 只剩 manifest 墓碑，也必须继续占位——否则删掉最高号后新规则会回收该号，违反"编号稳定。
 * @param {Array<object>} rules @param {Array<{number:number}>} [retired] manifest.retired 墓碑
 * @returns {Set<number>}
 */
function occupiedNumbers(rules, retired = []) {
  const numbers = new Set()
  for (const doc of Array.isArray(rules) ? rules : []) {
    // 只有 iron-rule 占号；普通规则/候选带 number（历史手写文件）也不得压高 nextNumber。
    const front = doc?.front && typeof doc.front === 'object' ? doc.front : doc
    if (String(front?.type ?? '') !== 'iron-rule') continue
    const n = Number(front?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  for (const item of Array.isArray(retired) ? retired : []) {
    const n = Number(item?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  return numbers
}

const IRON_RULE_FILE_RE = /^iron-rule-(\d+)\.md$/i

/**
 * 目录内 `iron-rule-<n>.md` 的文件名编号集合（parse-only：只看文件名，不读 front、不跑校验）。
 *
 * 为什么必须单独存在：手改成非法 front 的规则文件解析失败，不会进 `listRules().rules`；
 * 若编号占用只看"解析成功的规则"，分配器会把这个号再发一次并覆盖原文件（R9-02 复现过）。
 * 文件名是磁盘上"这个号已被占"的最后证据，崩溃/手改都不能让它消失。
 *
 * @param {string} root @param {{fs?: typeof nodeFs}} [opts] @returns {Set<number>}
 */
export function fileRuleNumbers(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const numbers = new Set()
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch { /* 目录不存在/不可读：没有文件名证据，交给调用方的其它校验报错 */ }
  for (const entry of entries) {
    if (!entry || (!entry.isFile?.() && !entry.isSymbolicLink?.())) continue
    const match = IRON_RULE_FILE_RE.exec(String(entry.name))
    if (!match) continue
    const n = Number(match[1])
    // >999 的文件名不是合法铁律编号（validate 会拒绝），不得让它把 nextNumber 顶到 1000+ 锁死新建。
    if (Number.isInteger(n) && n > 0 && n <= RULE_NUMBER_MAX) numbers.add(n)
  }
  return numbers
}

/**
 * 编号占用唯一真源 = 文件名编号 ∪ 解析成功的铁律 front 编号 ∪ 墓碑编号。
 *
 * - 文件名：非法 front 的文件也占号，分配器不得复用（R9-02 不变式）；
 * - front：兼容"文件名不规整但 front 有号"的历史文件；
 * - 墓碑：purge 后编号作废、永不复用。
 *
 * @param {string} root @param {{fs?: typeof nodeFs, listed?: {rules?: Array<object>}}} [opts]
 *   `listed` 可传已解析的 listRules 结果，避免一次分配重复解析全部规则。
 * @returns {Set<number>}
 */
export function occupancy(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const numbers = fileRuleNumbers(base, { fs })
  const rules = Array.isArray(opts.listed?.rules) ? opts.listed.rules : listRules(base).rules
  for (const doc of rules) {
    if (String(doc?.front?.type ?? '') !== 'iron-rule') continue
    const n = Number(doc?.front?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  for (const item of readTombstones(base, { fs })) {
    const n = Number(item?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  return numbers
}

/**
 * 新建一条规则（面板直写路径，**不经过** writer 决策/提案流水线）。
 *
 * 身份分配（仓储盖章，面板不可指定）：
 * - `number = nextRuleNumber(已有编号)`：空号 6 不复用，已有 1–17 时从 18 起；
 * - `key`：iron-rule → `iron-rule-<number>`；rule → `rule-<domain>-<hash8>`（domain 从正文推断，
 *   hash8 = 归一化正文 sha256 前 8 位）；
 * - `origin = manual:<userId|''>`、`version = 1`、`created/updated = 今天`、`status = active`。
 *
 * 失败语义：形状问题 → `invalid_draft`（未知字段/空正文/类型非法/数组非法）；内容问题 →
 * `invalid_rule` + validateRule 的错误数组（正文超 500/非祈使/隐私/铁律模糊词…）；撞已有 key →
 * `duplicate_rule`（同 key 覆盖会吞掉别人的规则正文，必须显式拒绝，改用 update/revert 通道）。
 * 以上全部在**写文件之前**判定，失败不留半成品、不烧编号。
 *
 * 单 commit：先写文件（`git:false`）再一次性 `rule: create <key> (#n)`，与默认播种同理——
 * 一条规则的落盘应当只有一个提交点。
 *
 * @param {{root?:string, draft?:object, identity?:object, traceId?:string, now?:number}} args
 *   identity/traceId 只为与路由/审计同签名（本模块不写 DB）。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, path?:string, key?:string, number?:number,
 *   type?:string, version?:number, commit?:object|null, error?:string, detail?:any}}
 */
export function createRule({ root = '', draft = {}, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'draft_must_be_object' } }
  }
  const unknown = Object.keys(draft).filter((field) => !CREATE_DRAFT_FIELDS.includes(field))
  if (unknown.length) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'unknown_field', fields: unknown } }
  }
  const type = String(draft.type ?? 'rule').trim() || 'rule'
  if (!CREATE_RULE_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'invalid_type', type, allowed: CREATE_RULE_TYPES } }
  }
  const text = String(draft.text ?? '').trim()
  if (!text || !normalizeRuleText(text)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'empty_text' } }
  }
  const chars = Array.from(text).length
  if (chars > RULE_BODY_MAX) {
    return {
      ok: false,
      error: 'invalid_rule',
      detail: [{ code: 'body_too_long', field: null, message: `正文 ${chars} 字，超过硬顶 ${RULE_BODY_MAX}` }],
    }
  }
  for (const field of ['conditions', 'exceptions']) {
    if (draft[field] === undefined) continue
    if (!Array.isArray(draft[field])) {
      return { ok: false, error: 'invalid_draft', detail: { reason: `${field}_must_be_array`, field } }
    }
  }

  // 仓库锁内：重读磁盘 → 分配号 → 落盘 → manifest → 单次提交。锁外算号会被并发抢号/复活墓碑号。
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error, detail: { root: base } }
  try {
    if (opts.git !== false) {
      // 仓就绪（含 git init）：单 commit 需要一个已存在的仓库；缺 git 只降级（ensureRuleRepo 不抛）。
      const ensured = ensureRuleRepo({ root: base, git: true, fs, ...(opts.exec ? { exec: opts.exec } : {}) })
      if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }
    }

    const listed = listRules(base)
    // 编号只属于 iron-rule：普通规则 number=null（不占号、不压 nextNumber）。
    // 占用 = 文件名编号 ∪ 解析成功编号 ∪ 墓碑：非法 front 的文件也占号，绝不复用（R9-02）。
    const number = type === 'iron-rule'
      ? nextRuleNumber(occupancy(base, { fs, listed }))
      : null
    if (type === 'iron-rule' && number > RULE_NUMBER_MAX) {
      return { ok: false, error: 'number_exhausted', detail: { max: RULE_NUMBER_MAX } }
    }
    // `rule:<domain>-<hash8>` → `rule-<domain>-<hash8>`（面板/文件里的 key 形状）。
    const key = type === 'iron-rule' ? `iron-rule-${number}` : ruleKeyOf(text).replace(/^rule:/, 'rule-')
    if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_draft', detail: { reason: 'invalid_key', key } }
    if (listed.rules.some((doc) => String(doc.front.key) === key) || existsSync(join(base, `${key}.md`))) {
      return { ok: false, error: 'duplicate_rule', detail: { key, reason: 'key_exists' } }
    }

    const userId = String(identity?.userId ?? '').slice(0, 128)
    const conditions = Array.isArray(draft.conditions)
      ? draft.conditions.map((item) => String(item ?? '').trim()).filter(Boolean)
      : []
    const exceptions = Array.isArray(draft.exceptions)
      ? draft.exceptions.map((item) => String(item ?? '').trim()).filter(Boolean)
      : []
    const date = dateOf(now)
    const front = {
      key,
      type,
      number,
      priority: String(draft.priority ?? (type === 'iron-rule' ? 'P0' : 'P1')).trim().toUpperCase(),
      scope: String(draft.scope ?? 'global').trim() || 'global',
      role: String(draft.role ?? '').trim(),
      modality: manualModalityOf(text),
      action: String(draft.action ?? '').trim(),
      object: String(draft.object ?? '').trim(),
      conditions,
      exceptions,
      status: 'active',
      merged_into: '',
      superseded_by: '',
      created: date,
      updated: date,
      version: 1,
      origin: `manual:${userId}`,
    }

    // git:false：文件 + manifest 由 writeRule 一次做完，提交由下面这一条统一出。
    const written = writeRule(base, { front, text }, { git: false, fs, lockHeld: true })
    if (!written.ok) {
      // 回滚证据必须原样上抛：调用方/测试要能区分"没写"与"写了又回滚干净"（R9-03）。
      return {
        ok: false, error: written.error || 'write_failed', detail: written.detail,
        ...(written.rolledBack !== undefined ? { rolledBack: written.rolledBack } : {}),
        ...(written.rollbackFailures ? { rollbackFailures: written.rollbackFailures } : {}),
      }
    }

    const message = `rule: create ${key} (#${number})`
    const commitPaths = [relative(base, written.path), MANIFEST_FILE]
    let commit = null
    if (opts.git !== false) {
      commit = commitRuleChanges(base, message, { exec: opts.exec, paths: commitPaths })
      if (!commit.ok && isGitDegraded(commit.error)) {
        // 降级：文件/manifest 已落盘，只是没有版本记录（架构书 §6「git 不可用」语义）。
        return {
          ok: true, rule: written.rule, path: written.path, key, number, type, version: 1,
          origin: front.origin, commit, manifest: written.manifest || null,
        }
      }
      if (!commit.ok) {
        // commit 失败必须回滚：删新文件 + 重建 manifest + 清 git index，不留"幻影规则/幻影版本"。
        const rolled = rollbackCreatedFile(base, written.path, commitPaths, { fs, exec: opts.exec })
        return {
          ok: false,
          error: 'commit_failed',
          detail: { stage: 'commit', error: commit.error },
          rolledBack: rolled.ok,
          rollbackFailures: rolled.failures,
          key,
          number,
          type,
        }
      }
    }
    return {
      ok: true,
      rule: written.rule,
      path: written.path,
      key,
      number,
      type,
      version: 1,
      origin: front.origin,
      commit,
      manifest: written.manifest || null,
    }
  } finally {
    lock.release()
  }
}

/**
 * 停用一条规则（复用 R5 `updateRule`，patch `{status:'retired'}`）。
 *
 * 停用 = 保留文件/编号/正文/历史，只把 status 置 retired：pinned 镜像因此归 0（rule-mirror 按
 * status 投影），但编号继续占位——**编号永不复用**，manifest 的 nextNumber 不因停用回退。
 *
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, status?:string, retired?:boolean, changed?:boolean,
 *   commit?:object|null, version?:number, previousVersion?:number, error?:string, detail?:any}}
 */
export function retireRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const got = readRule(baseDir(root), key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  if (String(got.rule.front.status) === 'retired') {
    return { ok: false, error: 'already_retired', rule: got.rule, status: 'retired' }
  }
  const updated = updateRule({ root, key, patch: { status: 'retired' }, identity, traceId, now }, opts)
  if (!updated.ok) return updated
  return { ...updated, status: 'retired', retired: true }
}

/**
 * 恢复一条已停用规则（patch `{status:'active'}`；不新建文件、不改编号/正文/版本历史）。
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, status?:string, reactivated?:boolean, changed?:boolean,
 *   commit?:object|null, version?:number, previousVersion?:number, error?:string, detail?:any}}
 */
export function reactivateRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const got = readRule(baseDir(root), key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  if (String(got.rule.front.status) !== 'retired') {
    return { ok: false, error: 'not_retired', rule: got.rule, status: String(got.rule.front.status) }
  }
  const updated = updateRule({ root, key, patch: { status: 'active' }, identity, traceId, now }, opts)
  if (!updated.ok) return updated
  return { ...updated, status: 'active', reactivated: true }
}

/**
 * 物理删除规则文件：优先 `git rm`（删除与暂存一体，随后一次 commit 就是一次删除记录），
 * git 不可用/不是仓库/文件未跟踪时降级 `fs.unlinkSync`——删除动作本身不能因 git 缺失失败。
 * @param {string} base @param {string} file
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean,viaGit?:boolean,error?:string,detail?:any}}
 */
function removeRuleFile(base, file, opts = {}) {
  const fs = opts.fs || nodeFs
  if (opts.git !== false) {
    const repo = isGitRepo(base, { exec: opts.exec })
    if (repo.ok) {
      const rel = relative(base, file)
      // 只允许仓库内相对路径；越界路径说明文件不该在这里，直接走 unlink，不喂给 git。
      if (rel && !rel.startsWith('..')) {
        const rm = runGit(base, ['rm', '-q', '-f', '--', rel], { exec: opts.exec })
        if (rm.ok) return { ok: true, viaGit: true }
      }
    }
  }
  try {
    fs.unlinkSync(file)
    return { ok: true, viaGit: false }
  } catch (err) {
    return { ok: false, error: 'delete_failed', detail: String(err?.message || err) }
  }
}

/**
 * 彻底删除一条规则（purge）：文件物理删除 + manifest 墓碑 + history 快照 + 单 commit。
 *
 * 与 `retireRule` 的区别：停用只切 status，文件/编号/正文/历史全保留，可随时重新启用；
 * purge 让规则从列表、提案与镜像召回里彻底消失，但**编号永不复用**——编号写进
 * `manifest.json#retired` 墓碑，未来自动编号把它算作已占用（删 17 → 新建 18；删 18 → 新建 19）。
 *
 * 顺序刻意是"快照 → **写墓碑并 fsync** → 删文件 → 重建 manifest → 单 commit"：
 * - 先写快照：最后一版正文必须留在 `history/<key>/`，删除后仍可追溯；
 * - 墓碑先落盘：任何后续失败都不得留下"文件已删、墓碑没写"（否则编号会被回收）；
 * - 墓碑进 `retired/<key>.json`（append-only 真源），manifest.retired 只是可重建的汇总；
 * - 安全行（number=0）只删文件、不写墓碑：它不占编号，墓碑会把 nextNumber 压回 1。
 *
 * 回滚：删文件失败 → 删本次新建的墓碑；manifest 失败/commit 失败 → 恢复文件 + 删墓碑 +
 * 重建 manifest + `git reset -- <paths>`，逐项失败都记进 rollbackFailures，不静默。
 *
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 *   identity/traceId 只为与路由/审计同签名（本模块不写 DB）。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean,key?:string,number?:number,version?:number,historySnapshot?:string,
 *   tombstone?:string,commit?:object|null,error?:string,detail?:any,rolledBack?:boolean,
 *   rollbackFailures?:string[]}}
 */
export function purgeRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    const got = readRule(base, key)
    if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
    const doc = got.rule
    const old = readRuleSource(doc.file, { fs })
    if (!old.ok) return { ok: false, error: old.error }
    const oldText = old.text
    const snap = writeHistorySnapshot(base, key, oldText, { fs })
    if (!snap.ok) return { ok: false, error: 'snapshot_failed', detail: snap.error }

    const number = Number(doc.front.number)
    const tombstone = doc.front.type === 'iron-rule' && Number.isInteger(number) && number > 0
    const at = new Date(Number.isFinite(now) ? Number(now) : Date.now()).toISOString()
    let tomb = null
    if (tombstone) {
      tomb = writeTombstone(base, { key: String(doc.front.key), number, at, reason: 'purge' }, { fs })
      if (!tomb.ok) return { ok: false, error: 'tombstone_failed', detail: tomb.error }
    }

    const restoreFile = () => {
      const restored = durableWriteFile(doc.file, oldText, { fs })
      return restored.ok ? null : `restore:${restored.error}`
    }
    const dropTombstone = () => {
      if (!tomb) return null
      try { fs.unlinkSync(tomb.path); fsyncDir(dirnameOf(tomb.path), fs); return null } catch (err) {
        return `tombstone:${err?.message || err}`
      }
    }

    const removed = removeRuleFile(base, doc.file, { ...opts, fs })
    if (!removed.ok) {
      const failures = [dropTombstone()].filter(Boolean)
      return { ...removed, rolledBack: failures.length === 0, rollbackFailures: failures }
    }

    // 显式路径：被删文件（git rm 已暂存，git add 也能记录删除）+ manifest + 墓碑。
    const paths = [relative(base, doc.file), MANIFEST_FILE, ...(tomb ? [relative(base, tomb.path)] : [])]
    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) {
      const failures = [restoreFile(), dropTombstone()].filter(Boolean)
      const rebuilt = regenerateManifest(base, { fs, allowShrink: true })
      if (!rebuilt.ok) failures.push(`manifest:${rebuilt.error}`)
      // 失败也要清 index：`git rm` 的删除已暂存，文件却已还原，留着就是幻影删除（R9-03）。
      const reset = resetIndexPaths(base, paths, { exec: opts.exec })
      if (!reset.ok) failures.push(`index:${reset.error}`)
      return { ok: false, error: 'manifest_failed', detail: manifest.error, rolledBack: failures.length === 0, rollbackFailures: failures }
    }

    if (opts.git === false) {
      return {
        ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
        historySnapshot: snap.rev, tombstone: tomb?.path || '', commit: null,
      }
    }

    const commit = commitRuleChanges(base, `rule: purge ${key} (#${number})`, { exec: opts.exec, paths })
    if (!commit.ok) {
      // git 不可用是降级（文件已删、commit 跳过）；只有真的提交失败才回滚。
      if (isGitDegraded(commit.error)) {
        return {
          ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
          historySnapshot: snap.rev, tombstone: tomb?.path || '', commit,
        }
      }
      const failures = [restoreFile(), dropTombstone()].filter(Boolean)
      const rebuilt = regenerateManifest(base, { fs, allowShrink: true })
      if (!rebuilt.ok) failures.push(`manifest:${rebuilt.error}`)
      const reset = resetIndexPaths(base, paths, { exec: opts.exec })
      if (!reset.ok) failures.push(`index:${reset.error}`)
      return {
        ok: false, error: 'commit_failed', detail: { stage: 'commit', error: commit.error },
        rolledBack: failures.length === 0, rollbackFailures: failures,
      }
    }
    return {
      ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
      historySnapshot: snap.rev, tombstone: tomb?.path || '', commit,
    }
  } finally {
    lock.release()
  }
}

/**
 * 按正常写流程回滚到某个历史快照（先校验，再快照当前版本，再落盘）。
 * @param {string} root @param {string} key @param {string} rev
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,rule?:object,rolledBackTo?:string,error?:string,detail?:any}}
 */
export function rollbackTo(root, key, rev, opts = {}) {
  const snap = readSnapshot(root, key, rev)
  if (!snap.ok) return snap
  const saved = writeRule(root, snap.rule, opts)
  if (!saved.ok) return saved
  return { ...saved, rolledBackTo: rev }
}

// ---------------------------------------------------------------------------
// 编辑 / 版本 diff / 按版本回写（R5）
// ---------------------------------------------------------------------------

/** `now`（毫秒/Date）→ 本机时区 `YYYY-MM-DD`；非法输入退回今天，不因时间戳造假日期。 */
function dateOf(now) {
  const d = now instanceof Date ? now : new Date(Number.isFinite(now) ? Number(now) : Date.now())
  const at = Number.isNaN(d.getTime()) ? new Date() : d
  const p = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/**
 * revision 归一成 history 快照文件名（17 位戳，含同毫秒 `-N` 后缀）。
 * 支持三种写法：`20261122191022000`、`20261122191022000.md`、ISO `2026-11-22T19:10:22.000`。
 * 不匹配返回空串（由调用方继续尝试 git sha）。
 * @param {string} rev @returns {string}
 */
function historyRevOf(rev) {
  const s = String(rev ?? '').trim().replace(/\.md$/i, '')
  if (/^\d{17}(?:-\d+)?$/.test(s)) return s
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
  if (!m) return ''
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}${(m[7] || '').padEnd(3, '0')}`
}

/** 正文按行切（空串是 0 行；末尾换行不制造幽灵空行）。 */
function splitDiffLines(text) {
  const s = String(text ?? '')
  return s === '' ? [] : s.split('\n')
}

/**
 * 纯函数行 diff（不引库）：`[{type:'same'|'add'|'del',text}]`，顺序即面板渲染顺序。
 *
 * 算法：先剥公共前缀/后缀（手改规则文件时 90% 只有一小段变化，剥完中间通常只剩几行），
 * 中间段用 LCS 动态规划回溯；中间段超过约 2000×2000 时退化为"整段删+整段加"，
 * 这条降级只影响展示粒度，不会给出错误结论（也不会 OOM 把面板拖死）。
 *
 * @param {string} oldText @param {string} newText
 * @returns {Array<{type:'same'|'add'|'del',text:string}>}
 */
export function diffLines(oldText, newText) {
  const a = splitDiffLines(oldText)
  const b = splitDiffLines(newText)
  const out = []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push({ type: 'same', text: a[start] })
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length === 0) {
    for (const line of midB) out.push({ type: 'add', text: line })
  } else if (midB.length === 0) {
    for (const line of midA) out.push({ type: 'del', text: line })
  } else if ((midA.length + 1) * (midB.length + 1) > 4_000_000) {
    for (const line of midA) out.push({ type: 'del', text: line })
    for (const line of midB) out.push({ type: 'add', text: line })
  } else {
    const width = midB.length + 1
    const dp = new Uint32Array((midA.length + 1) * width)
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i * width + j] = midA[i] === midB[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ type: 'same', text: midA[i] })
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        out.push({ type: 'del', text: midA[i] })
        i += 1
      } else {
        out.push({ type: 'add', text: midB[j] })
        j += 1
      }
    }
    while (i < midA.length) { out.push({ type: 'del', text: midA[i] }); i += 1 }
    while (j < midB.length) { out.push({ type: 'add', text: midB[j] }); j += 1 }
  }

  for (let k = endA; k < a.length; k += 1) out.push({ type: 'same', text: a[k] })
  return out
}

/**
 * 把 `rev` 解析成某个版本的规则文档（只读，不写盘）。
 *
 * rev 的解析顺序**先 history 再 git**：17 位数字/ISO 是快照命名，纯 4–40 位十六进制才是 git
 * 短 sha（两者偶尔重叠的极端情况优先本地快照，因为它更贴"面板选中的那一版"）。
 *
 * @param {{root?:string,key:string,rev:string}} args
 * @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean,rev?:string,source?:'history'|'git',rule?:object,raw?:string,
 *   error?:string,detail?:any}}
 */
export function resolveRevision({ root = '', key, rev } = {}, opts = {}) {
  const base = baseDir(root)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const raw = String(rev ?? '').trim().replace(/\.md$/i, '')
  if (!raw) return { ok: false, error: 'invalid_rev', detail: { rev: '' } }

  const historyRev = historyRevOf(raw)
  if (historyRev) {
    const snap = readSnapshot(base, key, historyRev)
    if (!snap.ok) {
      return {
        ok: false,
        error: snap.error === 'snapshot_not_found' ? 'rev_not_found' : snap.error,
        detail: { rev: raw, kind: 'history' },
      }
    }
    return { ok: true, rev: historyRev, source: 'history', rule: snap.rule }
  }

  if (/^[0-9a-f]{4,40}$/i.test(raw)) {
    const sha = raw.toLowerCase()
    // 正式规则与候选落在不同目录，同一 sha 下要两个路径都试；都不在才算 rev_not_found。
    for (const rel of [`${key}.md`, `proposals/${key}.md`]) {
      const shown = gitShow(base, `${sha}:${rel}`, { exec: opts.exec })
      if (!shown.ok) continue
      const parsed = parseRuleDocument(shown.text)
      if (!parsed.ok) continue
      const normalized = normalizeRuleDoc(parsed.front, parsed.text)
      return {
        ok: true,
        rev: sha,
        source: 'git',
        file: rel,
        raw: shown.text,
        rule: { ...normalized, bodyStart: parsed.bodyStart, file: join(base, rel) },
      }
    }
    const repo = isGitRepo(base, { exec: opts.exec })
    // git 没装才报 git_unavailable；装了但当前目录不是仓库 → 这个 sha 不可能存在。
    if (!repo.ok && repo.error && repo.error !== 'not_a_git_repo') {
      return { ok: false, error: repo.error, detail: { rev: raw, kind: 'git' } }
    }
    return { ok: false, error: 'rev_not_found', detail: { rev: raw, kind: 'git' } }
  }

  return { ok: false, error: 'invalid_rev', detail: { rev: raw } }
}

/**
 * 白名单补丁 → 新 front + 新正文（纯函数；不改入参、不写盘）。
 * 条件/例外**不做过滤**（空项/非字符串原样交给 validateRule 报错），否则"空项"会被悄悄吃掉。
 * @param {object} front 当前已归一化 front
 * @param {object} patch 已确认字段合法的补丁
 * @param {number} version @param {string} updated @param {string} text
 * @returns {{front:object,text:string}}
 */
function applyPatch(front, patch, version, updated, text) {
  const next = { ...front }
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) next.priority = String(patch.priority ?? '').trim().toUpperCase()
  if (Object.prototype.hasOwnProperty.call(patch, 'scope')) next.scope = String(patch.scope ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'role')) next.role = String(patch.role ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) next.status = String(patch.status ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'conditions')) {
    next.conditions = Array.isArray(patch.conditions)
      ? patch.conditions.map((item) => (typeof item === 'string' ? item.trim() : item))
      : patch.conditions
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'exceptions')) {
    next.exceptions = Array.isArray(patch.exceptions)
      ? patch.exceptions.map((item) => (typeof item === 'string' ? item.trim() : item))
      : patch.exceptions
  }
  next.version = version
  next.updated = updated
  return { front: next, text }
}

/** 编辑是否真的改了东西（version/updated 是流程字段，不算"用户改了内容"）。 */
function patchChanged(front, text, nextFront, nextText) {
  if (String(text) !== String(nextText)) return true
  for (const field of ['priority', 'scope', 'role', 'status']) {
    if (String(front[field] ?? '') !== String(nextFront[field] ?? '')) return true
  }
  for (const field of ['conditions', 'exceptions']) {
    if (JSON.stringify(front[field] || []) !== JSON.stringify(nextFront[field] || [])) return true
  }
  return false
}

/**
 * 编辑一条规则（R5）：白名单字段 → 同一 validateRule → version+1 → 历史快照 → 原子写 → git。
 *
 * 失败语义：写入前失败什么都不动；`writeRule` 中途失败（manifest/git 等后段）时用**写入前快照**
 * 把旧文件恢复回去，并返回 `rolledBack:true` —— 面板看到"没改成功"时文件也必须真的是旧版。
 *
 * 并发：本函数是同步的，同进程多次调用天然串行；跨进程由 writeRule 内部的同 key 锁保证
 * 落盘/快照不交错。version 来自调用开始时的磁盘真源，所以串行编辑得到 2,3,4… 不会覆盖。
 *
 * @param {{root?:string,key:string,patch:object,identity?:object,traceId?:string,now?:number}} args
 *   identity/traceId 只为与路由/审计同签名，本模块不写 DB。
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,changed?:boolean,
 *   commit?:object|null,version?:number,previousVersion?:number,error?:string,detail?:any,
 *   rolledBack?:boolean}}
 */
export function updateRule({ root = '', key, patch, now = Date.now() } = {}, opts = {}) {
  const base = baseDir(root)
  const fs = opts.fs || nodeFs
  // 锁外先拿仓库级锁：重读磁盘 → 校验 → 落盘 → manifest → 提交 全在同一临界区。
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return updateRuleLocked({ root: base, key, patch, now }, { ...opts, fs, lockHeld: true })
  } finally {
    lock.release()
  }
}

/**
 * `updateRule` 的锁内实现（调用方必须已持仓库锁）。
 * @param {{root?:string,key:string,patch:object,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} opts
 * @returns {object}
 */
function updateRuleLocked({ root = '', key, patch, now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const got = readRule(base, key)
  if (!got.ok) return got
  const doc = got.rule

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid_patch', detail: { reason: 'patch_must_be_object' } }
  }
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE_RULE_FIELDS.includes(field)) {
      return { ok: false, error: 'immutable_field', detail: { field } }
    }
    if (!RULE_PATCH_FIELDS.includes(field)) {
      return { ok: false, error: 'invalid_patch', detail: { field, reason: 'field_not_patchable' } }
    }
  }

  const current = doc.front
  const currentStatus = String(current.status ?? '')
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const target = String(patch.status ?? '').trim()
    if (target !== currentStatus && !(RULE_STATUS_TRANSITIONS[currentStatus] || []).includes(target)) {
      return {
        ok: false,
        error: 'invalid_patch',
        detail: {
          field: 'status',
          reason: 'invalid_status_transition',
          from: currentStatus,
          to: target,
          allowed: RULE_STATUS_TRANSITIONS[currentStatus] || [],
        },
      }
    }
  }

  const text = Object.prototype.hasOwnProperty.call(patch, 'text') ? String(patch.text ?? '') : doc.text
  const version = Number(current.version) + 1
  const nextDoc = applyPatch(current, patch, version, dateOf(now), text)

  // 编号唯一性：把自己剔出去，否则"改内容"会被自己那条规则判成撞号。
  const numbers = new Map()
  for (const other of listRules(base).rules) {
    if (String(other.front.key) === String(key)) continue
    if (!(Number.isInteger(other.front.number) && other.front.number > 0)) continue
    numbers.set(other.front.number, other.front.key)
  }
  const check = validateRule(nextDoc.front, nextDoc.text, { numbers })
  if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

  if (!patchChanged(current, doc.text, nextDoc.front, nextDoc.text)) {
    return {
      ok: true,
      changed: false,
      rule: doc,
      path: doc.file,
      history: '',
      commit: null,
      version: Number(current.version),
      previousVersion: Number(current.version),
    }
  }

  let oldSource
  try { oldSource = fs.readFileSync(doc.file, 'utf8') } catch (err) {
    return { ok: false, error: 'snapshot_read_failed', detail: String(err?.message || err) }
  }

  // git:false 由本函数自己控制 commit 文案；若让 writeRule 提交，消息会是 `rules: <key> v<n>`，
  // 面板/审计需要的是 `rule: update ...`，所以这里统一由 updateRule 提交一次。
  const saved = writeRule(base, nextDoc, { fs, git: false, lockHeld: true })
  // writeRule 的失败路径已自带四处回滚（R9-03），这里不再补第二次 restore：
  // 二次 restore 用真 fs、且会掩盖 history/manifest/index 是否真的回滚干净（旧测试假绿成因）。
  if (!saved.ok) return saved

  const paths = [relative(base, saved.path), MANIFEST_FILE, ...(saved.path !== doc.file ? [relative(base, doc.file)] : [])]
  let commit = null
  if (opts.git !== false) {
    commit = commitRuleChanges(base, `rule: update ${key} v${version}`, { exec: opts.exec, paths })
    if (!commit.ok && isGitDegraded(commit.error)) {
      // 降级：文件/manifest/history 都已落盘，仅无版本记录（git 不可用 ≠ 提交失败）。
      return {
        ok: true, changed: true, rule: saved.rule, path: saved.path, history: saved.history || '',
        commit, version, previousVersion: Number(current.version),
      }
    }
    if (!commit.ok) {
      // commit 失败必须回滚：文件/manifest/本事务新增 history 条目/git index 四处一起回。
      const rolled = rollbackRuleWrite(base, {
        file: doc.file, oldSource, key, historyRev: saved.history, paths, fs, exec: opts.exec,
      })
      return {
        ok: false,
        error: 'commit_failed',
        detail: { stage: 'commit', error: commit.error },
        rolledBack: rolled.ok,
        rollbackFailures: rolled.failures,
        version: Number(current.version),
        previousVersion: Number(current.version),
      }
    }
  }
  return {
    ok: true,
    changed: true,
    rule: saved.rule,
    path: saved.path,
    history: saved.history || '',
    commit,
    version,
    previousVersion: Number(current.version),
  }
}

/**
 * 把指定版本（history 快照或 git 版本）的正文/front **作为新版本**写回。
 *
 * 不物理回退历史：旧版本仍在 history/ 里，新版本 version+1 并产生新快照，因此"回滚"本身
 * 也可再被回滚——这是审计链能自证的前提。
 *
 * @param {{root?:string,key:string,rev:string,identity?:object,traceId?:string,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,commit?:object|null,
 *   version?:number,previousVersion?:number,revertedTo?:string,source?:string,
 *   changed?:boolean,error?:string,detail?:any,rolledBack?:boolean}}
 */
export function revertRule({ root = '', key, rev, now = Date.now() } = {}, opts = {}) {
  const base = baseDir(root)
  const fs = opts.fs || nodeFs
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return revertRuleLocked({ root: base, key, rev, now }, { ...opts, fs, lockHeld: true })
  } finally {
    lock.release()
  }
}

/**
 * `revertRule` 的锁内实现（调用方必须已持仓库锁）。
 * @param {{root?:string,key:string,rev:string,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} opts
 * @returns {object}
 */
function revertRuleLocked({ root = '', key, rev, now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const got = readRule(base, key)
  if (!got.ok) return got
  const doc = got.rule
  const resolved = resolveRevision({ root: base, key, rev }, opts)
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error === 'snapshot_not_found' ? 'rev_not_found' : resolved.error,
      detail: resolved.detail,
    }
  }

  const snap = resolved.rule
  const version = Number(doc.front.version) + 1
  // 身份字段永远取**当前文件**：快照里的 key/number/created 可能来自 rename 前的旧世界，
  // 真按快照覆盖会把规则改成另一条。内容字段（含 status/priority/scope）按快照还原文。
  const nextFront = {
    ...snap.front,
    key: doc.front.key,
    type: doc.front.type,
    number: doc.front.number,
    created: doc.front.created,
    origin: doc.front.origin,
    version,
    updated: dateOf(now),
  }
  const nextDoc = { front: nextFront, text: snap.text }

  const numbers = new Map()
  for (const other of listRules(base).rules) {
    if (String(other.front.key) === String(key)) continue
    if (!(Number.isInteger(other.front.number) && other.front.number > 0)) continue
    numbers.set(other.front.number, other.front.key)
  }
  const check = validateRule(nextFront, snap.text, { numbers })
  if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

  let oldSource
  try { oldSource = fs.readFileSync(doc.file, 'utf8') } catch (err) {
    return { ok: false, error: 'snapshot_read_failed', detail: String(err?.message || err) }
  }
  const saved = writeRule(base, nextDoc, { fs, git: false, lockHeld: true })
  // writeRule 的失败路径已自带四处回滚（R9-03），这里不再补第二次 restore：
  // 二次 restore 用真 fs、且会掩盖 history/manifest/index 是否真的回滚干净（旧测试假绿成因）。
  if (!saved.ok) return saved

  const paths = [relative(base, saved.path), MANIFEST_FILE, ...(saved.path !== doc.file ? [relative(base, doc.file)] : [])]
  let commit = null
  if (opts.git !== false) {
    commit = commitRuleChanges(base, `rule: revert ${key} to ${resolved.rev}`, { exec: opts.exec, paths })
    if (!commit.ok && isGitDegraded(commit.error)) {
      return {
        ok: true, changed: true, rule: saved.rule, path: saved.path, history: saved.history || '',
        commit, version, previousVersion: Number(doc.front.version),
        revertedTo: resolved.rev, source: resolved.source,
      }
    }
    if (!commit.ok) {
      // commit 失败必须回滚：文件/manifest/本事务新增 history 条目/git index 四处一起回。
      const rolled = rollbackRuleWrite(base, {
        file: doc.file, oldSource, key, historyRev: saved.history, paths, fs, exec: opts.exec,
      })
      return {
        ok: false,
        error: 'commit_failed',
        detail: { stage: 'commit', error: commit.error },
        rolledBack: rolled.ok,
        rollbackFailures: rolled.failures,
        version: Number(doc.front.version),
        previousVersion: Number(doc.front.version),
        revertedTo: resolved.rev,
      }
    }
  }
  return {
    ok: true,
    changed: true,
    rule: saved.rule,
    path: saved.path,
    history: saved.history || '',
    commit,
    version,
    previousVersion: Number(doc.front.version),
    revertedTo: resolved.rev,
    source: resolved.source,
  }
}

// ---------------------------------------------------------------------------
// 提交（显式路径） / 回滚
// ---------------------------------------------------------------------------

/** 提交路径归一：去空、转仓库内相对路径、去重；越界路径直接拒绝（不喂给 git）。 */
function normalizeCommitPaths(base, paths) {
  const out = []
  for (const item of Array.isArray(paths) ? paths : []) {
    const raw = String(item ?? '').trim()
    if (!raw) continue
    const rel = isAbsolute(raw) ? relative(base, raw) : raw
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!clean || clean.startsWith('..') || isAbsolute(clean)) continue
    if (!out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * 单次提交：**显式路径**（规则文件 + manifest + 墓碑），不用 `git add -A`。
 *
 * 为什么必须显式：规则仓里还躺着 `proposals/`、`history/`、`.txn/`；`add -A` 会把候选草稿
 * 和快照一起固化进历史（双份噪音，回滚也不再干净）。paths 为空 → 不提交，返回 committed:false。
 *
 * @param {string} root @param {string} message
 * @param {{paths?:string[], exec?:Function}} [opts]
 * @returns {{ok:boolean, committed:boolean, message:string, error?:string}}
 */
/**
 * git 不可用是**降级**而不是提交失败：文件/manifest 已落盘，只是没有版本记录。
 * 只有真的 `git commit` 失败（index/权限/钩子）才算失败并回滚。
 * @param {string} [error] @returns {boolean}
 */
function isGitDegraded(error) {
  return error === 'git_unavailable' || error === 'not_a_git_repo'
}

export function commitRuleChanges(root, message, opts = {}) {
  const base = baseDir(root)
  const text = String(message || 'rules: update')
  const paths = normalizeCommitPaths(base, opts.paths)
  if (paths.length === 0) return { ok: true, committed: false, message: text }
  const done = gitCommit(base, text, { exec: opts.exec, paths })
  if (!done.ok) return { ok: false, committed: false, message: text, error: done.error || 'git_failed' }
  return { ok: true, committed: Boolean(done.committed), message: text }
}

/**
 * 显式清理 git index 的暂存：`git reset -- <paths>`（不 `reset --hard`、不动工作树）。
 *
 * 供 apply 的 rollbackPlan 在 commit 失败后清掉本笔已 `git add`/`git rm` 的暂存，
 * 避免下一笔提交把失败事务的文件带进历史（"幻影版本"）。路径先归一：越界/空路径丢弃；
 * paths 为空时**不调用 git**，返回 ok（幂等）。
 *
 * @param {string} root @param {string[]} paths @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean, paths:string[], error?:string}}
 */
export function resetGitIndex(root, paths, opts = {}) {
  const base = baseDir(root)
  const clean = normalizeCommitPaths(base, paths)
  if (!clean.length) return { ok: true, paths: clean }
  // git 不可用 / 未建仓：没有 index 可清，这是"无需回滚"不是回滚失败。
  // （R9-03：回滚失败清单只该记真失败，否则 git:false 的临时仓会被误判成半写。）
  const repo = isGitRepo(base, { exec: opts.exec })
  if (!repo.ok) return { ok: true, paths: clean, skipped: 'no_repo' }
  const reset = runGit(base, ['reset', '-q', '--', ...clean], { exec: opts.exec })
  return reset.ok ? { ok: true, paths: clean } : { ok: false, paths: clean, error: reset.error }
}

/** 内部别名（回滚路径沿用旧名，行为即 resetGitIndex）。 */
function resetIndexPaths(root, paths, opts = {}) {
  return resetGitIndex(root, paths, opts)
}

/** 删除本事务新增的 history 快照；返回失败描述或 null（幂等：没 rev 时不动）。 */
function removeHistoryEntry(base, key, rev, fs = nodeFs) {
  if (!rev) return null
  try {
    fs.unlinkSync(join(base, 'history', key, `${rev}.md`))
    return null
  } catch (err) {
    // ENOENT = 快照本来就不存在（重复回滚/写失败前未落盘）：视为已回滚，不制造假半写。
    if (err?.code === 'ENOENT') return null
    return `history:${err?.message || err}`
  }
}

/**
 * 回滚一次写尝试：新建（删新文件）、更新（写回旧正文）、搬迁（删新路径 + 还原旧路径）
 * 三种形态统一走这里，回滚覆盖文件/manifest/history/git index 四处（R9-03 不变式③）。
 *
 * @param {string} base 规则仓根
 * @param {{target:string, oldFile?:string|null, oldSource?:string|null, key:string,
 *   historyRev?:string, paths?:string[], fs?:typeof nodeFs, exec?:Function}} [ctx]
 * @returns {{ok:boolean, failures:string[]}}
 */
function rollbackWriteAttempt(base, { target, oldFile = null, oldSource = null, key, historyRev = '', paths = [], fs = nodeFs, exec } = {}) {
  const failures = []
  if (oldFile && oldSource !== null && oldSource !== undefined) {
    if (target && target !== oldFile) {
      try { fs.unlinkSync(target) } catch (err) {
        if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
      }
    }
    const restored = durableWriteFile(oldFile, oldSource, { fs })
    if (!restored.ok) failures.push(`file:${restored.error}`)
  } else if (target) {
    try { fs.unlinkSync(target) } catch (err) {
      if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
    }
  }
  const historyFailure = removeHistoryEntry(base, key, historyRev, fs)
  if (historyFailure) failures.push(historyFailure)
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
  const reset = resetIndexPaths(base, paths, { exec })
  if (!reset.ok) failures.push(`index:${reset.error}`)
  return { ok: failures.length === 0, failures }
}

/** 兼容旧调用签名（同路径更新/回滚）：行为即 rollbackWriteAttempt。 */
function rollbackRuleWrite(base, { file, oldSource, key, historyRev, paths, fs, exec }) {
  return rollbackWriteAttempt(base, {
    target: file, oldFile: file, oldSource, key, historyRev, paths, fs, exec,
  })
}

/** 回滚"新建文件"：删文件 + 重建 manifest + 清 index（create 的 commit 失败路径）。 */
function rollbackCreatedFile(base, file, paths, { fs, exec }) {
  const failures = []
  try { fs.unlinkSync(file) } catch (err) {
    // 文件可能已被 git rm/失败删除；只有 ENOENT 才算已回滚，其他错误如实记。
    if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
  }
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
  const reset = resetIndexPaths(base, paths, { exec })
  if (!reset.ok) failures.push(`index:${reset.error}`)
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// 墓碑（retired/<key>.json）：编号永不复用的真源
// ---------------------------------------------------------------------------

/** `retired/<key>.json` 路径（key 必须已过白名单，否则不能拼路径）。 */
function tombstonePath(base, key) {
  return join(base, RETIRED_DIR, `${key}.json`)
}

/**
 * 写墓碑（append-only）：先 fsync 落盘，再由调用方删规则文件。
 *
 * 为什么不只写 manifest：manifest 是生成物，删掉/并发 purge 都会让它回退，已删编号被复用。
 * 墓碑是独立文件，`regenerateManifest` 取「旧 manifest.retired ∪ retired/ 目录」并集，删
 * manifest 也重建得回来。同一 key 第二次 purge 时 `numbers` 累积、`number` 留最早的那个，
 * `at` 留最早时间（append-only = 不删/不覆盖已作废编号）。
 *
 * @param {string} root
 * @param {{key:string, number:number, at?:string, reason?:string}} tool
 * @param {{fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeTombstone(root, tool = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const key = String(tool?.key ?? '').trim()
  const number = Number(tool?.number)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: 'invalid_number' }
  const dir = join(base, RETIRED_DIR)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {
    return { ok: false, error: `retired_dir_failed:${err?.message || err}` }
  }
  const path = tombstonePath(base, key)
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(path, 'utf8')) } catch { prev = null }
  const prevAt = String(prev?.at ?? '').trim()
  const at = String(tool?.at ?? '').trim() || new Date().toISOString()
  // 同一 key 二次彻底删除（重建后又 purge）：墓碑不覆盖旧编号，`numbers` 累积、`number` 留最早。
  // 覆盖会把旧编号放回池子（nextNumber 回落、编号复用），这是编号不变式的直接破口。
  const prevNumbers = Array.isArray(prev?.numbers)
    ? prev.numbers.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : (Number.isInteger(Number(prev?.number)) && Number(prev?.number) > 0 ? [Number(prev.number)] : [])
  const numbers = [...new Set([...prevNumbers, number])].sort((a, b) => a - b)
  // 同一墓碑重写保留更早的 `at`：墓碑记录"何时作废"，后写的一律不掩盖第一次。
  const payload = {
    key,
    number: numbers[0],
    numbers,
    at: prevAt && prevAt < at ? prevAt : at,
    reason: String(tool?.reason ?? prev?.reason ?? 'purge').trim() || 'purge',
  }
  const written = durableWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, { fs })
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, path }
}

/**
 * 读全部墓碑（`retired/*.json`），坏文件跳过（不因一条坏墓碑丢掉整个占用集合）。
 * 一个文件里的 `numbers` 会展开成多条（同 key 多次 purge），占用/manifest 都按编号逐条算。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts]
 * @returns {Array<{key:string, number:number, at:string, reason:string}>}
 */
export function readTombstones(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const dir = join(base, RETIRED_DIR)
  let names
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(join(dir, name), 'utf8')) } catch { continue }
    const key = String(parsed?.key ?? ruleKeyOfFile(name)).trim()
    if (!isValidRuleKey(key)) continue
    // 一个墓碑文件可累积多个编号（同 key 二次 purge）：展开成多条，占用集合/manifest 都算全。
    const numbers = Array.isArray(parsed?.numbers)
      ? parsed.numbers.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [Number(parsed?.number)]
    const at = String(parsed?.at ?? '').trim()
    const reason = String(parsed?.reason ?? 'purge').trim()
    for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
      out.push({ key, number, at, reason })
    }
  }
  // 排序与 manifest 同口径（number → key）：目录里按文件名排序会让 10 排在 9 前面，manifest 抖动。
  return out.sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
}

/** 该编号是否已进墓碑（apply/import 写目标前复核用：命中即拒绝，不得复活）。 */
export function isRetiredNumber(root, number, opts = {}) {
  const n = Number(number)
  if (!Number.isInteger(n) || n <= 0) return false
  return readTombstones(root, opts).some((item) => Number(item.number) === n)
}

/**
 * 可分配的下一个铁律编号 = max(现存铁律编号 ∪ 墓碑)+1，跳过保留空号。
 * 供 legacy 导入等"没有可靠编号"的入口取号（锁内调用；本函数不自己加锁）。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts] @returns {number}
 */
export function allocatableRuleNumber(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  return nextRuleNumber(occupancy(base, { fs }))
}

// ---------------------------------------------------------------------------
// 事务日志（.txn/<id>.json）：多文件写前的崩溃恢复锚点
// ---------------------------------------------------------------------------

const TXN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** `.txn/<id>.json` 路径；id 白名单外返回 null（防止越界写）。 */
function txnPathOf(base, id) {
  const text = String(id ?? '').trim()
  return TXN_ID_RE.test(text) ? join(base, TXN_DIR, `${text}.json`) : null
}

/**
 * 落一个事务日志（fsync）：apply 在写第一个文件之前调用。
 *
 * `files[].oldText` 是崩溃恢复的判据：无 commit 时按它原样写回；`oldText === null` 表示
 * 该文件是本事务新建的，恢复即删除。
 *
 * @param {string} root
 * @param {{id:string, planHash?:string, proposalId?:string, createdAt?:string,
 *   files?:Array<{key:string,path:string,oldText:string|null,newText?:string}>}} txn
 * @param {{fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeTxn(root, txn = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, txn?.id)
  if (!path) return { ok: false, error: 'invalid_txn_id' }
  const files = []
  for (const item of Array.isArray(txn?.files) ? txn.files : []) {
    const filePath = String(item?.path ?? '').trim()
    if (!filePath) return { ok: false, error: 'invalid_txn_file' }
    files.push({
      key: String(item?.key ?? ruleKeyOfFile(filePath)).trim(),
      path: filePath,
      oldText: item?.oldText === null || item?.oldText === undefined ? null : String(item.oldText),
      ...(item?.newText === undefined ? {} : { newText: String(item.newText) }),
    })
  }
  if (!files.length) return { ok: false, error: 'invalid_txn_files' }
  const payload = {
    id: String(txn.id).trim(),
    planHash: String(txn?.planHash ?? ''),
    proposalId: String(txn?.proposalId ?? ''),
    createdAt: String(txn?.createdAt ?? new Date().toISOString()),
    files,
  }
  try { fs.mkdirSync(join(base, TXN_DIR), { recursive: true }) } catch (err) {
    return { ok: false, error: `txn_dir_failed:${err?.message || err}` }
  }
  const written = durableWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, { fs })
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, path }
}

/** 读一个事务日志；缺失/坏 JSON 返回 null（恢复流程按"没有待恢复项"处理）。 */
export function readTxn(root, id, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, id)
  if (!path) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 清一个事务日志；不存在视为已清（幂等）。 */
export function clearTxn(root, id, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, id)
  if (!path) return { ok: false, error: 'invalid_txn_id' }
  try { fs.unlinkSync(path); return { ok: true } } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 列出待恢复事务 id（按文件名排序；目录不存在返回空）。 */
export function listTxns(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  try {
    return fs.readdirSync(join(base, TXN_DIR))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
      .filter((id) => TXN_ID_RE.test(id))
      .sort()
  } catch {
    return []
  }
}

/**
 * 探"这个事务是否已提交"：`git log --fixed-strings --grep=<proposalId>` 精确到提交说明，
 * 不扫最近 N 条 subject 猜（猜错会把已发布的新规则回滚掉）。失败一律按"未提交"处理。
 * @param {string} base @param {object} txn @param {{exec?:Function}} opts
 * @returns {boolean}
 */
function txnHasCommit(base, txn, opts = {}) {
  const marker = String(txn?.proposalId ?? '').trim() || String(txn?.id ?? '').trim()
  if (!marker) return false
  const out = runGit(base, [
    'log', '-n1', '--fixed-strings', `--grep=${marker}`, '--pretty=format:%h',
  ], { exec: opts.exec })
  return out.ok && String(out.out ?? '').trim() !== ''
}

/**
 * 启动恢复：把**全部**未完成事务收敛到一致状态（循环处理，不只第一条）。
 *
 * 判据分两层：
 * 1. git 里已有本事务的提交（精确 grep proposalId）→ 事务已发布，只清日志，绝不回滚；
 * 2. 无提交 → 逐文件按 `newText` 的 sha256 复核：**只有当前内容仍等于本事务写下的 newText**
 *    才按 `oldText` 恢复（`oldText=null` 则删除）；内容已变 = 之后有合法写入，只清日志不动文件。
 *
 * 为什么必须有 hash 闸：apply 失败回滚后若 `.txn` 没清（或崩溃在 clearTxn 前），旧实现会把
 * 之后所有合法写入一律按 oldText 覆盖回去。hash 不等即视为"不是本事务的中间态"，只清账。
 *
 * @param {string} root
 * @param {{exec?:Function, log?:Function, fs?:typeof nodeFs}} [opts]
 * @returns {{recovered:boolean, id?:string, ids:string[],
 *   processed:Array<{id:string, committed:boolean, restored:number, deleted:number,
 *   skipped:number, failures:string[]}>}}
 */
export function recoverPendingTxn(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const base = baseDir(root)
  const ids = listTxns(base, { fs })
  if (!ids.length) return { recovered: false, ids: [], processed: [] }
  const processed = []
  let recovered = false
  for (const id of ids) {
    const txn = readTxn(base, id, { fs })
    if (!txn) {
      clearTxn(base, id, { fs })
      processed.push({ id, committed: false, restored: 0, deleted: 0, skipped: 0, failures: ['unreadable'] })
      continue
    }
    const committed = txnHasCommit(base, txn, opts)
    let restored = 0
    let deleted = 0
    let skipped = 0
    const failures = []
    if (!committed) {
      for (const item of Array.isArray(txn.files) ? txn.files : []) {
        const raw = String(item?.path ?? '').trim()
        if (!raw) continue
        const file = isAbsolute(raw) ? raw : join(base, raw)
        const expected = item?.newText === undefined || item?.newText === null ? null : hashText(item.newText)
        // 无法验证（老 txn 没记 newText）→ 不动文件，只清账：安全优先于"尽量回滚"。
        if (!expected) { skipped += 1; continue }
        const current = readRuleSource(file, { fs })
        if (item?.oldText === null || item?.oldText === undefined) {
          if (!current.ok) continue
          if (hashText(current.text) !== expected) { skipped += 1; continue }
          try { fs.unlinkSync(file); deleted += 1 } catch (err) {
            if (err?.code !== 'ENOENT') failures.push(`${raw}:${err?.message || err}`)
          }
          continue
        }
        if (!current.ok) { skipped += 1; continue }
        if (hashText(current.text) !== expected) { skipped += 1; continue }
        const wrote = durableWriteFile(file, String(item.oldText), { fs })
        if (wrote.ok) restored += 1
        else failures.push(`${raw}:${wrote.error}`)
      }
      if (restored || deleted) recovered = true
      const manifest = regenerateManifest(base, { fs })
      if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
    }
    clearTxn(base, id, { fs })
    if (restored || deleted) {
      log(`[whale-memory] txn recovered id=${id} restored=${restored} deleted=${deleted} skipped=${skipped}`)
    } else if (committed) {
      log(`[whale-memory] txn already committed, cleared id=${id}`)
    } else if (skipped) {
      log(`[whale-memory] txn stale (files changed since), cleared id=${id} skipped=${skipped}`)
    }
    if (failures.length) log(`[whale-memory] txn recovery partial id=${id} failures=${failures.join(';')}`)
    processed.push({
      id, committed, restored, deleted, skipped,
      failures: failures.length ? failures : [],
    })
  }
  return { recovered, id: processed[0]?.id, ids: processed.map((item) => item.id), processed }
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/**
 * 补规则仓 `.gitignore` 条目（幂等，只追加缺失行）：候选/快照/事务/锁/播种 marker 全是
 * 本机生成物，不该进 git。返回是否真的改了文件。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts]
 * @returns {boolean}
 */
export function ensureRuleGitignore(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const file = join(base, '.gitignore')
  let content = ''
  try { content = String(fs.readFileSync(file, 'utf8')) } catch { content = '' }
  const lines = content.split('\n').map((line) => line.trim())
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line))
  if (!missing.length) return false
  const head = content.replace(/\n*$/, '')
  const next = `${head ? `${head}\n` : ''}${missing.join('\n')}\n`
  const written = atomicWriteFile(file, next, { fs })
  return Boolean(written.ok)
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

/** 有规则时的下一个编号：max+1，跳过保留空号（6）。 */
export function nextRuleNumber(numbers) {
  const list = Array.from(numbers || []).filter((n) => Number.isInteger(n) && n > 0)
  let next = list.length ? Math.max(...list) + 1 : 1
  while (RESERVED_NUMBERS.includes(next)) next += 1
  return next
}

/**
 * 墓碑归一：`manifest.retired` 是"已彻底删除、编号作废"的编号台账（rule-store 的唯一删除记录）。
 *
 * 只保留合法正整数的编号；同一 `{key,number}` 只留最新 `at`（重复记录不堆垃圾）。
 * 排序固定（number → key），保证 manifest 在 git diff 里稳定、不因对象顺序抖动。
 *
 * @param {Array<{key:string,number:number,at:string}>} retired
 * @returns {Array<{key:string,number:number,at:string}>}
 */
function normalizeRetired(retired) {
  const seen = new Map()
  for (const item of Array.isArray(retired) ? retired : []) {
    const key = String(item?.key ?? '').trim()
    const number = Number(item?.number)
    if (!key || !Number.isInteger(number) || number <= 0) continue
    const at = String(item?.at ?? '').trim()
    const id = `${key}#${number}`
    const prev = seen.get(id)
    if (!prev || String(prev.at) < at) seen.set(id, { key, number, at })
  }
  return [...seen.values()].sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
}

/**
 * 由规则列表计算 manifest 视图（纯函数，GET 列表用；不写盘）。
 *
 * 编号口径：只有正整数编号参与 `nextNumber`/`total`；无编号铁律（安全行，number=0）单列
 * `unnumbered` 计数——它存在、要被列表/镜像渲染，但**不占号**，否则 nextNumber 会被压回 1。
 * 已 purge 的编号只剩墓碑：`nextNumber` 把它算作占用（删最高号也不回落），但 `total`
 * 只数现存编号规则——墓碑不是规则，不能虚增列表条数。
 *
 * @param {Array<object>} rules listRules 的 rules
 * @param {Array<{key:string,number:number,at:string}>} [retired] manifest.retired 墓碑
 * @param {Iterable<number>} [extraNumbers] 解析失败的 `iron-rule-<n>.md` 文件名编号（仍占号）
 * @returns {{nextNumber:number,total:number,unnumbered:number,byStatus:Record<string,number>,
 *   retired:Array<{key:string,number:number,at:string}>}}
 */
export function computeManifest(rules, retired = [], extraNumbers = []) {
  const tombstones = normalizeRetired(retired)
  const byStatus = {}
  const numbers = []
  let unnumbered = 0
  for (const doc of Array.isArray(rules) ? rules : []) {
    const status = String(doc?.front?.status || 'unknown')
    byStatus[status] = (byStatus[status] || 0) + 1
    // 只有 iron-rule 的正整数编号进 total/nextNumber；普通规则带 number 也不占号。
    const n = String(doc?.front?.type ?? '') === 'iron-rule' ? Number(doc?.front?.number) : null
    if (Number.isInteger(n) && n > 0) numbers.push(n)
    else if (isUnnumberedRule(doc?.front)) unnumbered += 1
  }
  const extra = Array.from(extraNumbers || []).filter((n) => Number.isInteger(n) && n > 0)
  const occupied = numbers.concat(tombstones.map((item) => item.number), extra)
  return {
    nextNumber: nextRuleNumber(occupied),
    total: numbers.length,
    unnumbered,
    byStatus,
    retired: tombstones,
  }
}

/**
 * 重建 manifest.json（生成物，勿手改）；内容稳定排序，便于 git diff。
 *
 * 墓碑真源 = 「旧 manifest.retired ∪ retired/*.json ∪ opts.retired」，**只增不减**：
 * - 删掉 manifest.json 也能由规则文件 + 墓碑目录重建出同样的 nextNumber（编号不回落）；
 * - 新的占用集合必须是旧墓碑集合的超集，否则拒绝写并报 `retired_shrink`——
 *   防止一份旧 manifest 覆盖掉刚写下的新墓碑，把已删编号放回池子。
 *
 * @param {string} root
 * @param {{fs?:typeof nodeFs, retired?:Array<{key:string,number:number,at:string}>}} [opts]
 * @returns {{ok:boolean,manifest?:object,error?:string,detail?:any}}
 */
export function regenerateManifest(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const existing = readManifest(base)
  // 回滚事务允许"撤销刚落下的墓碑"：忽略旧 manifest.retired，只用磁盘墓碑 + 本次追加重建。
  // 正常写入永远走并集，保证旧墓碑不凭空消失、编号不被回收。
  const rollbackMode = opts.allowShrink === true
  const rawOld = rollbackMode ? [] : (Array.isArray(existing?.retired) ? existing.retired : [])
    .filter((item) => Number.isInteger(Number(item?.number)) && Number(item?.number) > 0)
  const oldRetired = rollbackMode ? [] : normalizeRetired(existing?.retired)
  const fromDisk = readTombstones(base, { fs })
  const retired = normalizeRetired(oldRetired.concat(fromDisk, Array.isArray(opts.retired) ? opts.retired : []))
  // 只增不减：旧 manifest 里出现过的编号必须仍在新集合里。按编号比对（不按 key），
  // 因为墓碑的 key 可能被手工改坏；编号一旦消失，就意味着"已删编号被放回池子"。
  const presentNumbers = new Set(retired.map((item) => item.number))
  const missing = rawOld.filter((item) => !presentNumbers.has(Number(item.number)))
  // `allowShrink` 只给本事务的回滚用（purge 的 commit 失败要撤销刚落下的墓碑）：
  // 正常写入路径永远不带它，保证"旧墓碑不会凭空消失、编号不被回收"。
  if (missing.length && opts.allowShrink !== true) {
    return { ok: false, error: 'retired_shrink', detail: { missing } }
  }
  const list = listRules(base)
  // 非法 front 的 `iron-rule-<n>.md` 仍占号：manifest.nextNumber 必须与分配器同口径，
  // 否则面板显示"下一个 18"而 create 实际给 19（R9-02）。
  const view = computeManifest(list.rules, retired, fileRuleNumbers(base, { fs }))
  const manifest = {
    ...view,
    keys: list.rules.map((doc) => doc.front.key),
    updatedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(base, { recursive: true })
    const written = atomicWriteFile(join(base, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { fs })
    if (!written.ok) return { ok: false, error: written.error }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
  return { ok: true, manifest }
}

/** 只读 manifest（缺失/坏 JSON 返回 null，调用方可回退到 computeManifest）。 */
export function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(baseDir(root), MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// git（本地 only）
// ---------------------------------------------------------------------------

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** 统一执行入口：`-C dir` + 固定身份 + `--no-optional-locks` + 5s 超时；不联网。 */
function runGit(dir, args, opts = {}) {
  const exec = opts.exec || execFileSync
  try {
    const out = exec('git', ['-C', dir, ...GIT_IDENT, '--no-optional-locks', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs || GIT_TIMEOUT_MS,
      env: gitEnv(),
    })
    return { ok: true, out: String(out ?? '') }
  } catch (err) {
    const code = err?.code || err?.status || ''
    const stderr = String(err?.stderr ?? '')
    const message = stderr.trim() || String(err?.message || err)
    if (code === 'ENOENT') return { ok: false, error: 'git_unavailable' }
    return { ok: false, error: message || 'git_failed', code }
  }
}

/** @param {string} dir @returns {{ok:boolean,error?:string}} */
export function isGitRepo(dir, opts = {}) {
  const r = runGit(dir, ['rev-parse', '--is-inside-work-tree'], opts)
  if (!r.ok) return r
  return { ok: r.out.trim() === 'true' }
}

/**
 * 只建仓（`git init -q`），**不提交**。
 *
 * 为什么需要它：默认播种要"整批默认规则只出一个 commit"，但 `ensureRuleRepo` 建仓时会顺手
 * 提交一次 `rules: init repository`（里面只有 README/manifest），history 会多一条噪音。
 * 先 init、再写文件、最后统一 commit，首启就是**一个**提交且包含全部默认规则。
 *
 * @param {string} dir
 * @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean, initialized?:boolean, error?:string}} initialized=false 表示本来就有仓库
 */
export function initRuleRepo(dir, opts = {}) {
  const repo = isGitRepo(dir, opts)
  if (repo.ok) return { ok: true, initialized: false }
  const init = runGit(dir, ['init', '-q'], opts)
  if (!init.ok) return { ok: false, error: init.error }
  return { ok: true, initialized: true }
}

/**
 * 提交（**只接受显式路径**）：`git add -- <paths>` → 无改动视为成功但不提交。
 *
 * R8-13：禁止 `add -A`——候选/快照/事务日志即使被 .gitignore 挡住，`add -A` 也会把
 * "未预期的新文件"一并固化进历史，回滚不再干净。`opts.paths` 缺省/为空 → 不提交，
 * 不猜、不兜底（调用方必须自己给出本笔涉及的文件与 manifest）。提交用
 * `commit -- <已进 index 的 paths>`：预暂存的他笔文件不会被带进提交。
 *
 * @param {string} dir @param {string} message
 * @param {{exec?:Function, paths?:string[]}} [opts]
 * @returns {{ok:boolean,committed?:boolean,out?:string,error?:string,code?:string}}
 */
export function gitCommit(dir, message, opts = {}) {
  const paths = Array.isArray(opts.paths) ? opts.paths : []
  if (paths.length === 0) return { ok: true, committed: false }
  // 路径分两类：仍在盘上的 `git add --`；已被删除的用 `git rm --ignore-unmatch` 把删除记进 index。
  // 直接 `git add -- 已删路径` 会报 "pathspec ... did not match"（purge 的删除路径就是这种）。
  const existing = paths.filter((rel) => existsSync(join(dir, rel)))
  const removed = paths.filter((rel) => !existing.includes(rel))
  if (existing.length) {
    const added = runGit(dir, ['add', '--', ...existing], opts)
    if (!added.ok) return added
  }
  if (removed.length) {
    // 失败不致命：文件可能未跟踪/已被 `git rm` 暂存过；由下面 diff 判空。
    runGit(dir, ['rm', '--ignore-unmatch', '-q', '-f', '--', ...removed], opts)
  }
  const staged = runGit(dir, ['diff', '--cached', '--quiet', '--', ...paths], opts)
  // diff --quiet 有差异时退出码 1；runGit 把非 0 当失败，这里按"有差异"解释。
  if (!staged.ok && staged.code === 1) {
    // `commit -- <paths>`：只提交本笔路径。index 里可能已有别的暂存（面板/git add 预暂存、
    // 上一笔失败残留），无 pathspec 的 commit 会把它们一起带进提交（幻影版本）。
    // 还要把 pathspec 收窄到"真的进了 index 的路径"：未跟踪且从未 add 过的路径（例如
    // git:false 写入后又被 purge 的规则）喂给 `git commit -- <path>` 会报
    // "pathspec ... did not match any file(s) known to git"，整笔提交失败。
    const names = runGit(dir, ['diff', '--cached', '--name-only', '--', ...paths], opts)
    const effective = names.ok
      ? names.out.split('\n').map((line) => line.trim()).filter(Boolean)
      : []
    const commitPaths = effective.length ? effective : paths
    const committed = runGit(dir, ['commit', '-m', String(message || 'rules: update'), '--no-gpg-sign', '--', ...commitPaths], opts)
    if (!committed.ok) return committed
    return { ok: true, committed: true, out: committed.out }
  }
  return { ok: true, committed: false }
}

/**
 * 本地 git 日志。`opts.path` 只列该路径的提交（`/rules/versions` 用），
 * `opts.withTime` 追加 unix 秒时间戳（面板按时间排序/展示，不靠猜提交顺序）。
 * @param {string} dir @param {number} [limit]
 * @param {{exec?:Function,path?:string,withTime?:boolean}} [opts]
 * @returns {{ok:boolean,entries?:Array<{hash:string,subject:string,ts?:number}>,error?:string}}
 */
export function gitLog(dir, limit = 20, opts = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  const format = opts.withTime ? '%h%x09%at%x09%s' : '%h%x09%s'
  const args = ['log', `-n${n}`, `--pretty=format:${format}`]
  if (opts.path) args.push('--', String(opts.path))
  const r = runGit(dir, args, opts)
  if (!r.ok) return r
  const entries = r.out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('\t')
    if (opts.withTime) return { hash: parts[0], ts: Number(parts[1]) || 0, subject: parts.slice(2).join('\t') }
    return { hash: parts[0], subject: parts.slice(1).join('\t') }
  })
  return { ok: true, entries }
}

/**
 * 展示某个 revision：file 给定时返回该文件在该版本的内容，否则返回 --stat 摘要。
 * @param {string} dir @param {string} rev @param {{file?:string}} [opts]
 * @returns {{ok:boolean,text?:string,error?:string}}
 */
export function gitShow(dir, rev, opts = {}) {
  const revision = String(rev ?? '').trim()
  if (!revision || revision.startsWith('-')) return { ok: false, error: 'invalid_rev' }
  const args = opts.file
    ? ['show', `${revision}:${opts.file}`]
    : ['show', '--stat', '--no-color', '--no-renames', revision]
  const r = runGit(dir, args, opts)
  return r.ok ? { ok: true, text: r.out } : r
}

/** revert --no-edit（冲突时返回错误，不自动解冲突、不联网）。 */
export function gitRevert(dir, rev, opts = {}) {
  const revision = String(rev ?? '').trim()
  if (!revision || revision.startsWith('-')) return { ok: false, error: 'invalid_rev' }
  const r = runGit(dir, ['revert', '--no-edit', revision], opts)
  return r.ok ? { ok: true, text: r.out } : r
}

// ---------------------------------------------------------------------------
// 仓库初始化
// ---------------------------------------------------------------------------

/**
 * 建目录 + README + .gitignore + manifest + git init/首次 commit。
 * git 缺失/失败只降级返回 `{git:{available:false}}`，不抛——规则文件仍可读写。
 *
 * @param {{root?:string,git?:boolean,exec?:Function,fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean,root?:string,git?:{available:boolean,version?:string,initialized?:boolean,committed?:boolean,error?:string},error?:string}}
 */
export function ensureRuleRepo(opts = {}) {
  const fs = opts.fs || nodeFs
  const root = baseDir(opts.root)
  try {
    fs.mkdirSync(root, { recursive: true })
    for (const dir of RULE_DIRS) fs.mkdirSync(join(root, dir), { recursive: true })
    const readme = join(root, 'README.md')
    if (!existsSyncSafe(readme, fs)) {
      fs.writeFileSync(readme, [
        '# 规则目录',
        '',
        '规则文件是真源；manifest.json 与 history/ 是生成物。',
        '- 规则：`<key>.md`（front matter + 正文）',
        '- 候选：`proposals/<key>.md`',
        '- 历史：`history/<key>/<YYYYMMDDHHmmssSSS>.md`（每个 key 保留 20 份）',
        '',
        '只允许本地 git 操作；本目录不联网。',
        '',
      ].join('\n'), 'utf8')
    }
    // `.gitignore` 逐行补齐（老仓库也要迁移一次）：`.seeded.json` 是本机状态，proposals/history/.txn
    // 是待裁定草稿/快照/短命事务——进 git 会让规则仓的历史变成双份噪音。
    ensureRuleGitignore(root, { fs })
    regenerateManifest(root, { fs })
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }

  if (opts.git === false) {
    return { ok: true, root, git: { available: false, error: 'git_disabled' } }
  }

  const exec = opts.exec || execFileSync
  let version = ''
  try {
    const out = exec('git', ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: gitEnv(),
    })
    version = String(out ?? '').trim()
  } catch (err) {
    return {
      ok: true,
      root,
      git: { available: false, error: err?.code === 'ENOENT' ? 'git_unavailable' : String(err?.message || err) },
    }
  }

  let initialized = false
  const repo = isGitRepo(root, { exec })
  if (!repo.ok) {
    const init = runGit(root, ['init', '-q'], { exec })
    if (!init.ok) return { ok: true, root, git: { available: true, version, initialized: false, error: init.error } }
    initialized = true
  }
  // 只在本次新建仓库时做首次 commit；已有仓库的日常改动由 writeRule 提交，
  // 避免每次 ensure 都插一个空 commit 把规则历史的 diff 打乱。
  // 显式路径：README/.gitignore/manifest + 已存在的规则文件（新建仓库时可能有默认种子在盘上）。
  const committed = initialized
    ? gitCommit(root, 'rules: init repository', {
      exec,
      paths: [
        'README.md', '.gitignore', MANIFEST_FILE,
        ...listRules(root).rules.map((doc) => relative(root, doc.file)),
      ].filter((rel, index, arr) => arr.indexOf(rel) === index),
    })
    : { ok: true, committed: false }
  return {
    ok: true,
    root,
    git: {
      available: true,
      version,
      initialized,
      committed: committed.ok ? Boolean(committed.committed) : false,
      ...(committed.ok ? {} : { error: committed.error }),
    },
  }
}

