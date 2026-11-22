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
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { detectSignals, normalizeRuleText, ruleKeyOf } from './rules.js'

/** 已知 front matter 字段（顺序即序列化顺序）。未知字段一律报错，不静默丢弃。 */
export const RULE_FIELDS = Object.freeze([
  'key', 'type', 'number', 'priority', 'scope', 'role', 'modality', 'action', 'object',
  'conditions', 'exceptions', 'status', 'merged_into', 'superseded_by', 'created',
  'updated', 'version', 'origin',
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
export const RULE_DIRS = Object.freeze(['proposals', 'history'])
/** 跨进程同 key 串行锁目录（生成物，不进 git）。 */
export const LOCK_DIR = '.locks'
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

/** @param {string} [root] @returns {string} */
function baseDir(root) {
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

function today() {
  return new Date().toISOString().slice(0, 10)
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
  out.number = out.number === undefined || out.number === null || out.number === '' ? null : Number(out.number)
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
  // 无编号铁律（安全行）是唯一允许 number=0 的规则；其余任何 key 都必须是正整数。
  if (isUnnumberedRule(f)) {
    // number=0 合法：不占号、不参与唯一性（numbers Map 里也不会出现 0）。
  } else if (!Number.isInteger(f.number) || f.number <= 0) {
    push('invalid_number', 'number', 'number 必须是正整数（仅允许 iron-rule-safety 为 0）')
  } else if (RESERVED_NUMBERS.includes(f.number)) push('number_reserved', 'number', `编号 ${f.number} 是保留空号，永不复用`)
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

  const numbers = opts.numbers instanceof Map ? opts.numbers : new Map()
  if (Number.isInteger(f.number) && numbers.has(f.number) && numbers.get(f.number) !== f.key) {
    push('duplicate_number', 'number', `编号 ${f.number} 已被 ${numbers.get(f.number)} 占用`)
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

/** 同步等待（主线程无 await 可用；锁只持有毫秒级，阻塞可接受）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
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
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 10000
  const started = Date.now()
  try { fs.mkdirSync(lockRoot, { recursive: true }) } catch (err) {
    return { ok: false, error: `lock_dir_failed:${err?.message || err}` }
  }
  for (;;) {
    try {
      fs.mkdirSync(lock)
      return {
        ok: true,
        release() {
          try { fs.rmdirSync(lock) } catch { /* 已被清理/权限变化：不应掩盖写入结果 */ }
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, error: `lock_failed:${err?.message || err}` }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmdirSync(lock); continue }
      } catch { continue } // 锁刚被释放/stat 失败：立刻重试
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

function pruneHistory(dir, fs) {
  let names
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() } catch { return [] }
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
    fs.writeFileSync(join(dir, `${rev}.md`), String(content), 'utf8')
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
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort().reverse() } catch (err) {
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
  let source
  try { source = readFileSync(file, 'utf8') } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'snapshot_not_found' : String(err?.message || err) }
  }
  const parsed = parseRuleDocument(source)
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
  let source
  try { source = readFileSync(file, 'utf8') } catch (err) { return { ok: false, error: String(err?.message || err) } }
  const parsed = parseRuleDocument(source)
  if (!parsed.ok) return { ok: false, error: 'invalid_rule', detail: { parse: parsed.error } }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
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
    let source
    try { source = readFileSync(file, 'utf8') } catch (err) { errors.push({ file, error: String(err?.message || err) }); continue }
    const parsed = parseRuleDocument(source)
    if (!parsed.ok) { errors.push({ file, error: parsed.error }); continue }
    const normalized = normalizeRuleDoc(parsed.front, parsed.text)
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) { errors.push({ file, error: 'invalid_rule', detail: check.errors }); continue }
    if (Number.isInteger(normalized.front.number) && normalized.front.number > 0 && numbers.has(normalized.front.number)) {
      errors.push({ file, error: 'duplicate_number', detail: { number: normalized.front.number } })
      continue
    }
    // 无编号规则（number=0）不占号：不进 numbers，也就不会与任何规则撞号。
    if (Number.isInteger(normalized.front.number) && normalized.front.number > 0) {
      numbers.set(normalized.front.number, normalized.front.key)
    }
    rules.push({ ...normalized, bodyStart: parsed.bodyStart, file })
  }
  rules.sort((a, b) => a.front.number - b.front.number || a.front.key.localeCompare(b.front.key))
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

  // 首次写规则时初始化 git 仓库；git 缺失只降级（ensureRuleRepo 不抛），文件仍可写。
  const ensured = ensureRuleRepo({ root: base, git: opts.git !== false, fs, exec: opts.exec })
  if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }

  // 编号校验、历史快照、落盘、manifest 必须在同一把同 key 锁内，否则并发写会撞号/丢快照。
  const lock = acquireRuleLock(base, normalized.front.key, { fs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    const existing = listRules(base)
    const numbers = new Map()
    for (const doc of existing.rules) {
      if (doc.front.key === normalized.front.key) continue
      if (!(Number.isInteger(doc.front.number) && doc.front.number > 0)) continue
      numbers.set(doc.front.number, doc.front.key)
    }
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

    const serialized = serializeRuleDocument(normalized)
    if (!serialized.ok) return { ok: false, error: 'serialize_failed', detail: serialized.error }

    const target = rulePath(base, normalized.front)
    const oldFile = findRuleFile(base, normalized.front.key)
    let snapshot = null
    if (oldFile) {
      let oldText
      try { oldText = fs.readFileSync(oldFile, 'utf8') } catch (err) {
        return { ok: false, error: 'snapshot_read_failed', detail: String(err?.message || err) }
      }
      snapshot = writeHistorySnapshot(base, normalized.front.key, oldText, { fs })
      if (!snapshot.ok) return { ok: false, error: 'snapshot_failed', detail: snapshot.error }
    }

    const written = atomicWriteFile(target, serialized.text, { fs })
    if (!written.ok) return { ok: false, error: 'write_failed', detail: written.error }
    if (oldFile && oldFile !== target) {
      try { fs.unlinkSync(oldFile) } catch (err) {
        // 两份文件同时存在会让 listRules 报编号冲突；回滚新文件，保持旧状态。
        try { fs.unlinkSync(target) } catch { /* best effort */ }
        return { ok: false, error: 'move_failed', detail: String(err?.message || err) }
      }
    }

    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) return { ok: false, error: 'manifest_failed', detail: manifest.error }

    let git = null
    if (opts.git !== false) {
      git = gitCommit(base, `rules: ${normalized.front.key} v${normalized.front.version}`, { exec: opts.exec })
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
    let oldText
    try { oldText = fs.readFileSync(doc.file, 'utf8') } catch (err) { return { ok: false, error: String(err?.message || err) } }
    const snap = writeHistorySnapshot(base, key, oldText, { fs })
    if (!snap.ok) return { ok: false, error: 'snapshot_failed', detail: snap.error }
    try { fs.unlinkSync(doc.file) } catch (err) { return { ok: false, error: 'delete_failed', detail: String(err?.message || err) } }
    regenerateManifest(base, { fs })
    if (opts.git !== false) gitCommit(base, `rules: delete candidate ${key}`, { exec: opts.exec })
    return { ok: true, deleted: true }
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
    const n = doc?.front ? Number(doc.front.number) : Number(doc?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  for (const item of Array.isArray(retired) ? retired : []) {
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

  const listed = listRules(base)
  // 墓碑也占号：彻底删除后编号作废、永不复用（删 17 后新建仍 18；删 18 后新建仍 19）。
  const number = nextRuleNumber(occupiedNumbers(listed.rules, readManifest(base)?.retired))
  // `rule:<domain>-<hash8>` → `rule-<domain>-<hash8>`（面板/文件里的 key 形状）。
  const key = type === 'iron-rule' ? `iron-rule-${number}` : ruleKeyOf(text).replace(/^rule:/, 'rule-')
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_draft', detail: { reason: 'invalid_key', key } }
  if (listed.rules.some((doc) => String(doc.front.key) === key)) {
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

  // 仓就绪（含 git init）：单 commit 需要一个已存在的仓库；缺 git 只降级（ensureRuleRepo 不抛）。
  if (opts.git !== false) {
    const ensured = ensureRuleRepo({ root: base, git: true, fs, ...(opts.exec ? { exec: opts.exec } : {}) })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }
  }

  // git:false：文件 + manifest 由 writeRule 一次做完，提交由下面这一条统一出。
  const written = writeRule(base, { front, text }, { git: false, fs })
  if (!written.ok) return { ok: false, error: written.error || 'write_failed', detail: written.detail }

  const commit = commitRuleChange(base, `rule: create ${key} (#${number})`, opts)
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
 * 顺序刻意是"快照 → 删文件 → 墓碑随 manifest 落盘 → 单 commit"：
 * - 先写快照：最后一版正文必须留在 `history/<key>/`，删除后仍可追溯；
 * - 快照失败立即中止，不出现"文件没了、历史也没了"的不可追溯状态；
 * - 安全行（number=0）只删文件、不写墓碑：它不占编号，墓碑会把 nextNumber 压回 1。
 *
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 *   identity/traceId 只为与路由/审计同签名（本模块不写 DB）。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean,key?:string,number?:number,version?:number,historySnapshot?:string,
 *   commit?:object|null,error?:string,detail?:any}}
 */
export function purgeRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const got = readRule(base, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const doc = got.rule
  let oldText
  try { oldText = fs.readFileSync(doc.file, 'utf8') } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
  const snap = writeHistorySnapshot(base, key, oldText, { fs })
  if (!snap.ok) return { ok: false, error: 'snapshot_failed', detail: snap.error }

  const number = Number(doc.front.number)
  const tombstone = Number.isInteger(number) && number > 0 && !isUnnumberedRule(doc.front)
  const retired = tombstone
    ? [{
      key: String(doc.front.key),
      number,
      at: new Date(Number.isFinite(now) ? Number(now) : Date.now()).toISOString(),
    }]
    : []

  const removed = removeRuleFile(base, doc.file, { ...opts, fs })
  if (!removed.ok) return removed

  regenerateManifest(base, { fs, retired })
  // 单 commit：git rm 已暂存删除，manifest/墓碑由 add -A 一并收进同一提交。
  const commit = commitRuleChange(base, `rule: purge ${key} (#${number})`, opts)
  return {
    ok: true,
    key: String(doc.front.key),
    number,
    version: Number(doc.front.version) || 1,
    historySnapshot: snap.rev,
    commit,
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

/** `now`（毫秒/Date）→ `YYYY-MM-DD`；非法输入退回今天，不因时间戳造假日期。 */
function dateOf(now) {
  const d = now instanceof Date ? now : new Date(Number.isFinite(now) ? Number(now) : Date.now())
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10)
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
  const saved = writeRule(base, nextDoc, { fs, git: false })
  if (!saved.ok) {
    const restored = atomicWriteFile(doc.file, oldSource)
    return { ok: false, error: saved.error, detail: saved.detail, rolledBack: restored.ok }
  }

  const commit = commitRuleChange(base, `rule: update ${key} v${version}`, opts)
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
  const saved = writeRule(base, nextDoc, { fs, git: false })
  if (!saved.ok) {
    const restored = atomicWriteFile(doc.file, oldSource)
    return { ok: false, error: saved.error, detail: saved.detail, rolledBack: restored.ok }
  }

  const commit = commitRuleChange(base, `rule: revert ${key} to ${resolved.rev}`, opts)
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

/**
 * 本地 git 提交（不联网；git 不可用/目录不是仓库时**降级**为只写文件）。
 * @param {string} dir @param {string} message
 * @param {{git?:boolean,exec?:Function}} opts
 * @returns {object|null} 未尝试提交时 null
 */
function commitRuleChange(dir, message, opts = {}) {
  if (opts.git === false) return null
  const repo = isGitRepo(dir, { exec: opts.exec })
  if (!repo.ok) {
    return { ok: false, committed: false, message, error: repo.error || 'not_a_git_repo' }
  }
  const done = gitCommit(dir, message, { exec: opts.exec })
  if (!done.ok) return { ok: false, committed: false, message, error: done.error || 'git_failed' }
  return { ok: true, committed: Boolean(done.committed), message }
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
 * @returns {{nextNumber:number,total:number,unnumbered:number,byStatus:Record<string,number>,
 *   retired:Array<{key:string,number:number,at:string}>}}
 */
export function computeManifest(rules, retired = []) {
  const tombstones = normalizeRetired(retired)
  const byStatus = {}
  const numbers = []
  let unnumbered = 0
  for (const doc of Array.isArray(rules) ? rules : []) {
    const status = String(doc?.front?.status || 'unknown')
    byStatus[status] = (byStatus[status] || 0) + 1
    const n = Number(doc?.front?.number)
    if (Number.isInteger(n) && n > 0) numbers.push(n)
    else if (isUnnumberedRule(doc?.front)) unnumbered += 1
  }
  const occupied = numbers.concat(tombstones.map((item) => item.number))
  return {
    nextNumber: nextRuleNumber(occupied),
    total: numbers.length,
    unnumbered,
    byStatus,
    retired: tombstones,
  }
}

/**
 * 生成 manifest.json（生成物，勿手改）；内容稳定排序，便于 git diff。
 *
 * 必须**保留已有墓碑**：manifest 是墓碑的唯一真源，任何一次普通写入触发的重生成都不能
 * 把 `retired` 清掉，否则编号会被回收。`opts.retired` 用于本次 purge 追加，与旧墓碑合并去重。
 *
 * @param {string} root
 * @param {{fs?:typeof nodeFs, retired?:Array<{key:string,number:number,at:string}>}} [opts]
 * @returns {{ok:boolean,manifest?:object,error?:string}}
 */
export function regenerateManifest(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const existing = readManifest(base)
  const oldRetired = Array.isArray(existing?.retired) ? existing.retired : []
  const retired = normalizeRetired(oldRetired.concat(Array.isArray(opts.retired) ? opts.retired : []))
  const list = listRules(base)
  const view = computeManifest(list.rules, retired)
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
 * add -A + commit；无改动视为成功但不提交（规则写失败不该被空 commit 掩盖）。
 * @returns {{ok:boolean,committed?:boolean,error?:string}}
 */
export function gitCommit(dir, message, opts = {}) {
  const added = runGit(dir, ['add', '-A'], opts)
  if (!added.ok) return added
  const staged = runGit(dir, ['diff', '--cached', '--quiet'], opts)
  // diff --quiet 有差异时退出码 1；runGit 把非 0 当失败，这里按"有差异"解释。
  if (!staged.ok && staged.code === 1) {
    const committed = runGit(dir, ['commit', '-m', String(message || 'rules: update'), '--no-gpg-sign'], opts)
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
    const ignore = join(root, '.gitignore')
    // `.seeded.json` 是默认播种标记（本机状态）：进 git 会让换机后"已播种"，新机永远不长默认规则。
    if (!existsSyncSafe(ignore, fs)) fs.writeFileSync(ignore, '*.tmp-*\n.locks/\n.seeded.json\n', 'utf8')
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
  const committed = initialized
    ? gitCommit(root, 'rules: init repository', { exec })
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

