/**
 * 写入决策 + 持久化队列（L2 机制层，架构书 §6.2 决策顺序 / §7.3 时间重叠）。
 *
 * 为什么这样设计：
 * - 决策与落库分离：decideWrite 只读库、只产出 decision；processEvent 才动 nodes/edges/writes。
 *   一条规则能单独验，面板也能预演（拿到 decision 先给用户看，再决定是否落库）。
 * - 决策顺序即优先级：文本合法性 → 隐私 → 配额 → 去重 → 合并 → 冲突 → 影子 → 新增。
 *   顺序不能换：先查冲突再脱敏，脱敏后的文本与库内文本就不可比；先去重再配额，重复消息会白吃额度。
 * - 冲突判定不调模型：否定词对 + 槽位（端口/路径/版本/日期）差异足够稳定，可离线复现、零成本。
 * - 事实时间与系统时间分开：invalid_at 用"新事实生效时间"，expired_at 用系统删除时间，回溯可解释。
 * - 队列必须落 jobs 表：DSH 进程随对话重启，内存队列会丢事件；启动时把 running 复位成 queued 是崩溃补偿。
 * - 影子模式把"会落库"的动作统一降级为 CANDIDATE：审核前 nodes 一行不写，只留 writes 审计；
 *   NOOP/REJECT 不是落库动作，照旧记审计。
 * - 本模块不做邻居注记（applyNeighborNotes 由集成层调用）：写入只负责自己的一致性，扩散注记属于关系层调度。
 */
import { now } from './db.js'
import { bigrams, contentHash, normalize, similarity } from './tokenize.js'
import { linkMutex, linkSupersede, normalizeTags } from './relations.js'

/** 脱敏占位符（隐私命中一律替换成它，长度稳定、可被检索到"这里被脱敏过"）。 */
const MASK = '[已脱敏]'
/** 每批任务数（写连接上保持短事务，避免长阻塞）。 */
const BATCH = 20
/** 冲突/合并候选上限（单身份）。 */
const CANDIDATE_LIMIT = 300
/** MERGE 相似度下限。 */
const MERGE_SIM = 0.85
/** MERGE 信息增益：新文本比旧文本至少多这么多字（或直接包含旧文本）。 */
const MERGE_GROWTH = 8
/** 冲突判定（否定/槽位）的最低相似度。 */
const CONFLICT_SIM = 0.3
/** 会真正落 nodes 的动作；影子模式下它们统一降级为 CANDIDATE。 */
const LANDING = new Set(['ADD', 'MERGE', 'SUPERSEDE', 'REVIEW'])

const LEVELS = new Set(['core', 'important', 'normal'])
const MEMORY_TYPES = new Set(['semantic', 'procedural', 'episodic', 'mixed'])
/** 事件来源 → nodes.source（schema CHECK 只认这几种，'chat'/'search' 不是合法列值）。 */
const SOURCE_MAP = {
  chat: 'self',
  tool: 'tool',
  search: 'web',
  manual: 'self',
  import: 'import',
  owner: 'owner',
  group: 'group',
  web: 'web',
  self: 'self',
}

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

/** 否定词对（正向 ↔ 反向）；判定时先认反向词，避免"不可以"里的"可以"误判。 */
const NEGATION_PAIRS = [
  ['允许', '禁止'],
  ['启用', '停用'],
  ['开启', '关闭'],
  ['可以', '不可以'],
  ['支持', '不支持'],
  ['必须', '不必'],
]

/** 计划/承诺词：冲突时先别取代（还没落地的事实不能覆盖已落地的事实）。 */
const PLAN_WORDS = /下周|明天|计划|准备|等审批|待定|将要|打算/

/** 句界（端口要求"同句"）。
 * @param {string} text */
const SENTENCE_MARK = /[。！？!?；;\n]/

/** 端口语境提示词。 */
const PORT_HINT = /端口|port|回调|webhook/i

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g
const VERSION_RE = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?)(?![\w.])/g
const PATH_RE = /\/[\w.\-/]{3,}/g
const NUMBER_RE = /\b\d{2,5}\b/g

/** 空值（null/undefined/空串）不能走 Number()：Number(null)===0 会把"没有时间"当成"时间 0"。 */
function isBlank(value) {
  return value === null || value === undefined || value === ''
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function finite(value, fallback) {
  if (isBlank(value)) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 时间戳读取：缺失返回 null（而不是 0）。 @param {unknown} value */
function timeOrNull(value) {
  if (isBlank(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 事件身份归一（缺列一律 ''，与 schema 默认一致）。
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @returns {{ userId: string, roleId: string, workspace: string }}
 */
function normalizeIdentity(identity) {
  const i = identity || {}
  return {
    userId: String(i.userId ?? ''),
    roleId: String(i.roleId ?? ''),
    workspace: String(i.workspace ?? ''),
  }
}

/** 当日 00:00（本地时区）的秒级时间戳。 @param {number} tsSeconds */
function startOfDay(tsSeconds) {
  const d = new Date(tsSeconds * 1000)
  d.setHours(0, 0, 0, 0)
  return d.getTime() / 1000
}

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
function spansOf(text, re) {
  const out = []
  for (const match of text.matchAll(re)) {
    const at = Number(match.index ?? 0)
    out.push({ at, end: at + match[0].length, raw: match[0], match })
  }
  return out
}

/** 命中是否落在保留区间内（区间半开 [at,end)）。 */
function insideSpans(span, spans) {
  for (const s of spans) {
    if (span.at < s.end && span.end > s.at) return true
  }
  return false
}

/** 位置所在句子是否含端口语境词（"同句"的判定口径）。 */
function sentenceHasPortHint(text, at) {
  let start = at
  let end = at
  while (start > 0 && !SENTENCE_MARK.test(text[start - 1])) start -= 1
  while (end < text.length && !SENTENCE_MARK.test(text[end])) end += 1
  return PORT_HINT.test(text.slice(start, end))
}

/**
 * 槽位抽取：只认四类可机械对比的值，避免把"任意数字"都当事实。
 *
 * 规则（架构书 §6.2）：
 * - 端口：`\b\d{2,5}\b`，但必须与 端口|port|回调|webhook 同句；日期/版本/路径里的数字不算。
 * - 路径：`/` 开头、后接 ≥3 个 [\w.\-/]；跳过 '//' 开头（URL 协议头不算路径）。
 * - 版本：`v?d+.d+(.d+)?`（去 v，IP 这类多段数字不会被误判）。
 * - 日期：`YYYY-MM-DD`。
 *
 * @param {unknown} text
 * @returns {string[]} 形如 ['port:8080','path:/tmp/x','version:1.2','date:2026-11-22']（按出现顺序、去重）
 */
export function slotsOf(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!s) return []
  const slots = []

  const dates = spansOf(s, DATE_RE)
  for (const m of dates) slots.push({ at: m.at, slot: `date:${m.raw}` })

  const versions = spansOf(s, VERSION_RE)
  for (const m of versions) slots.push({ at: m.at, slot: `version:${m.match[1]}` })

  const paths = spansOf(s, PATH_RE)
  for (const m of paths) {
    if (m.raw.startsWith('//')) continue
    slots.push({ at: m.at, slot: `path:${m.raw}` })
  }

  // 端口必须同句含语境词；已被日期/版本/路径吃掉的数字不再算端口。
  const reserved = [...dates, ...versions, ...paths]
  for (const m of spansOf(s, NUMBER_RE)) {
    if (insideSpans(m, reserved)) continue
    if (!sentenceHasPortHint(s, m.at)) continue
    slots.push({ at: m.at, slot: `port:${m.raw}` })
  }

  slots.sort((a, b) => a.at - b.at)
  const seen = new Set()
  const out = []
  for (const item of slots) {
    if (seen.has(item.slot)) continue
    seen.add(item.slot)
    out.push(item.slot)
  }
  return out
}

/** 槽位按前缀归组：Map<prefix, Set<value>>。 */
function slotGroups(text) {
  const groups = new Map()
  for (const slot of slotsOf(text)) {
    const cut = slot.indexOf(':')
    if (cut <= 0) continue
    const key = slot.slice(0, cut)
    const value = slot.slice(cut + 1)
    let set = groups.get(key)
    if (!set) { set = new Set(); groups.set(key, set) }
    set.add(value)
  }
  return groups
}

/** 两集合是否完全相同。 */
function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** 文本在某组词对上的极性。先认否定词：'不可以' 同时含 '可以'，不能被当成正向。 */
function polarity(text, positive, negative) {
  const t = String(text || '')
  const hasNegative = t.includes(negative)
  const hasPositive = t.includes(positive) && !hasNegative
  return { positive: hasPositive, negative: hasNegative }
}

/**
 * 冲突判定（不调模型）：否定对优先，其次槽位差异；两种情况都要求整体相似度 ≥0.3。
 *
 * @param {{ text?: string, valid_at?: number, invalid_at?: number } | null | undefined} oldRow 库内候选行
 * @param {unknown} newText 新文本
 * @returns {'negation'|'slot'|null}
 */
export function contradiction(oldRow, newText) {
  const oldText = String(oldRow?.text ?? '')
  const next = String(newText ?? '')
  if (!oldText || !next) return null
  if (similarity(oldText, next) < CONFLICT_SIM) return null

  for (const [positive, negative] of NEGATION_PAIRS) {
    const a = polarity(oldText, positive, negative)
    const b = polarity(next, positive, negative)
    if ((a.positive && b.negative) || (a.negative && b.positive)) return 'negation'
  }

  const oldSlots = slotGroups(oldText)
  const nextSlots = slotGroups(next)
  for (const [prefix, values] of oldSlots) {
    const other = nextSlots.get(prefix)
    if (!other) continue
    if (!sameSet(values, other)) return 'slot'
  }
  return null
}

/**
 * 时间重叠（架构书 §7.3 三段式）：先看旧事实是否已在新事实生效前失效，再看新事实是否在旧事实生效前失效。
 *
 * 只做可比较的部分：缺失的时间戳不参与判断（否则 null 会被当成 0 产生假"不重叠"）。
 *
 * @param {{ valid_at?: number|null, invalid_at?: number|null } | null | undefined} oldRow
 * @param {number|{ valid_at?: number|null, invalid_at?: number|null }} newValidAt
 *   数字（新事实 valid_at）或带双时态字段的对象
 * @returns {'overlap'|'no-overlap'}
 */
export function timeOverlap(oldRow, newValidAt) {
  const old = oldRow || {}
  const neu = newValidAt && typeof newValidAt === 'object' ? newValidAt : { valid_at: newValidAt }
  const oldValid = timeOrNull(old.valid_at)
  const oldInvalid = timeOrNull(old.invalid_at)
  const neuValid = timeOrNull(neu.valid_at)
  const neuInvalid = timeOrNull(neu.invalid_at)

  if (oldInvalid !== null && neuValid !== null && oldInvalid <= neuValid) return 'no-overlap'
  if (neuInvalid !== null && oldValid !== null && neuInvalid <= oldValid) return 'no-overlap'
  return 'overlap'
}

/** 决策参数归一：mode 缺省 shadow（保守），maxChars 不许突破 schema 的 500 硬顶。 */
function resolveOptions(opts) {
  const o = opts || {}
  return {
    mode: o.mode === 'auto' ? 'auto' : 'shadow',
    maxChars: Math.max(1, Math.min(500, finite(o.maxChars, 500))),
    dailyCap: Math.max(0, Math.floor(finite(o.dailyCap, 200))),
    protect: o.protect !== false,
    redact: o.redact !== false,
  }
}

/** 给 decision 补 mode；影子模式把落库动作降级为 CANDIDATE。 */
function settle(decision, opts, { text = '', redacted = false } = {}) {
  const reason = [decision.reason, redacted && decision.action !== 'REJECT' ? 'privacy:redacted' : '']
    .filter(Boolean)
    .join(' · ')
  const base = { ...decision, reason, mode: opts.mode }
  if (opts.mode === 'shadow' && LANDING.has(base.action)) {
    return {
      ...base,
      action: 'CANDIDATE',
      reason: [`shadow:${base.action}`, reason].filter(Boolean).join(' · '),
      afterText: text,
      mode: 'shadow',
      shadowOf: base.action,
    }
  }
  return base
}

/**
 * 决策主流程（严格按架构书 §6.2 顺序，见文件头说明）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开且 ensureSchema 过的连接
 * @param {{ text?: string, traceId?: string, identity?: object, tags?: string[], level?: string,
 *   memory_type?: string, expired_at?: number, source?: string, origin?: string }} event
 * @param {{ mode?: 'shadow'|'auto', maxChars?: number, dailyCap?: number, protect?: boolean,
 *   redact?: boolean }} [opts]
 * @returns {{ action: string, reason: string, nodeId?: string, targetId?: string,
 *   beforeText?: string, afterText?: string, mode?: string, shadowOf?: string }}
 */
export function decideWrite(db, event, opts = {}) {
  const options = resolveOptions(opts)
  const ident = normalizeIdentity(event?.identity)

  // 1. 文本合法性
  const original = normalize(String(event?.text ?? ''))
  if (!original) return { action: 'REJECT', reason: 'invalid_text', mode: options.mode }
  if (original.length > options.maxChars) return { action: 'REJECT', reason: 'text_too_long', mode: options.mode }

  // 2. 隐私：默认脱敏后继续，严格入口直接拒绝
  const privacy = privacyCheck(original, { redact: options.redact })
  if (!privacy.ok) return { action: 'REJECT', reason: privacy.reason || 'privacy', mode: options.mode }
  const text = normalize(privacy.text)
  if (!text) return { action: 'REJECT', reason: 'invalid_text', mode: options.mode }
  const redacted = privacy.reason === 'privacy_redacted'

  // 3. 当日配额（NOOP/REJECT 不占额度：它们没有产生新事实）
  const since = startOfDay(now())
  const used = Number(db.prepare(
    "SELECT count(*) AS n FROM writes WHERE ts>=? AND user_id=? AND role_id=? AND workspace=? AND action NOT IN ('NOOP','REJECT')",
  ).get(since, ident.userId, ident.roleId, ident.workspace)?.n || 0)
  if (used >= options.dailyCap) return { action: 'REJECT', reason: 'daily_cap', mode: options.mode }

  // 4. 同身份原文命中 → NOOP（记一次命中，不新增事实）
  const hash = contentHash(text)
  const dup = db.prepare(
    "SELECT id,text FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1",
  ).get(hash, ident.userId, ident.roleId, ident.workspace)
  if (dup) {
    return {
      action: 'NOOP',
      reason: 'duplicate',
      targetId: String(dup.id),
      beforeText: String(dup.text ?? ''),
      afterText: text,
      mode: options.mode,
    }
  }

  const candidates = db.prepare(
    `SELECT id,text,level,memory_type,source,valid_at,invalid_at FROM nodes
     WHERE status='active' AND user_id=? AND role_id=? AND workspace=?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(ident.userId, ident.roleId, ident.workspace, CANDIDATE_LIMIT)

  // 5. 相似合并：只有"信息只增不减"才合并，否则交给冲突/新增
  let mergeRow = null
  let mergeScore = 0
  for (const row of candidates) {
    const oldText = String(row.text ?? '')
    if (!oldText) continue
    const sim = similarity(text, oldText)
    if (sim < MERGE_SIM) continue
    const gains = text.includes(oldText) || text.length - oldText.length >= MERGE_GROWTH
    if (!gains) continue
    if (sim > mergeScore) { mergeRow = row; mergeScore = sim }
  }
  if (mergeRow) {
    return settle({
      action: 'MERGE',
      reason: 'merge_similar',
      targetId: String(mergeRow.id),
      beforeText: String(mergeRow.text ?? ''),
      afterText: text,
    }, options, { text, redacted })
  }

  // 6. 冲突：同身份 active 候选里找"否定/槽位"冲突且时间重叠的最近一条
  const validAt = now()
  let conflictRow = null
  let conflictScore = 0
  let conflictKind = null
  for (const row of candidates) {
    const kind = contradiction(row, text)
    if (!kind) continue
    if (timeOverlap(row, { valid_at: validAt }) !== 'overlap') continue
    const sim = similarity(text, String(row.text ?? ''))
    if (sim > conflictScore) { conflictRow = row; conflictScore = sim; conflictKind = kind }
  }
  if (conflictRow) {
    const targetId = String(conflictRow.id)
    const beforeText = String(conflictRow.text ?? '')
    // 计划/承诺还没落地，不得取代已落地事实
    if (PLAN_WORDS.test(text)) {
      return settle({ action: 'ADD', reason: 'plan_deferred', targetId, beforeText, afterText: text }, options, { text, redacted })
    }
    const protectedTarget = options.protect
      && (String(conflictRow.source) === 'owner' || String(conflictRow.level) === 'core' || String(conflictRow.memory_type) === 'procedural')
    if (protectedTarget) {
      return settle({ action: 'REVIEW', reason: 'protected', targetId, beforeText, afterText: text }, options, { text, redacted })
    }
    return settle({
      action: 'SUPERSEDE',
      reason: `supersede:${conflictKind}`,
      targetId,
      beforeText,
      afterText: text,
    }, options, { text, redacted })
  }

  // 8. 其余 → ADD
  return settle({ action: 'ADD', reason: 'new', afterText: text }, options, { text, redacted })
}

/**
 * 写审计行（writes）。每个决策结果都要留痕，面板/复盘靠它。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ traceId?: string, identity?: object, mode?: string }} event 原始事件
 * @param {{ action: string, reason?: string, nodeId?: string|null, beforeText?: string|null,
 *   afterText?: string|null, mode?: string }} decision
 * @returns {number} 新 writes 行 id
 */
export function recordWrite(db, event, decision) {
  const ident = normalizeIdentity(event?.identity)
  const info = db.prepare(`INSERT INTO writes
    (ts,trace_id,action,node_id,reason,before_text,after_text,mode,user_id,role_id,workspace)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    now(),
    String(event?.traceId ?? ''),
    String(decision?.action ?? ''),
    decision?.nodeId ? String(decision.nodeId) : null,
    String(decision?.reason ?? ''),
    decision?.beforeText === undefined || decision?.beforeText === null ? null : String(decision.beforeText),
    decision?.afterText === undefined || decision?.afterText === null ? null : String(decision.afterText),
    String(decision?.mode ?? event?.mode ?? 'shadow'),
    ident.userId,
    ident.roleId,
    ident.workspace,
  )
  return Number(info.lastInsertRowid)
}

/** 事务包装：调用方已开事务时不重复 BEGIN（BEGIN 失败即视为嵌套，直接执行）。 */
function withTx(db, fn) {
  let begun = false
  try {
    db.exec('BEGIN IMMEDIATE')
    begun = true
  } catch {
    begun = false
  }
  try {
    const out = fn()
    if (begun) db.exec('COMMIT')
    return out
  } catch (err) {
    if (begun) { try { db.exec('ROLLBACK') } catch { /* 回滚失败不遮蔽原始错误 */ } }
    throw err
  }
}

/** 事件来源 → 合法 nodes.source。 */
function mapSource(source) {
  return SOURCE_MAP[String(source ?? '')] || 'self'
}

/** 合法 level（非法值降级 normal，写入路径不因脏参数失败）。 */
function validLevel(level) {
  const v = String(level ?? '')
  return LEVELS.has(v) ? v : 'normal'
}

/** 合法 memory_type。 */
function validMemoryType(type) {
  const v = String(type ?? '')
  return MEMORY_TYPES.has(v) ? v : 'semantic'
}

/** expired_at：只在显式传入有限正数时落库。 */
function validExpiredAt(value) {
  if (isBlank(value)) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 插一个 active 节点（内部用）：字段全填，双时态 valid_at 置为本次决策时间。
 * @returns {string} 节点 id
 */
function insertNodeRow(db, event, text, { ts, validAt, source, origin, level, memoryType, expiredAt }) {
  const ident = normalizeIdentity(event?.identity)
  const hash = contentHash(text)
  const id = `n${Date.now()}_${hash.slice(0, 10)}`
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,hits,vector_state,origin,trace_id,valid_at,expired_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,1,0,'none',?,?,?,?,?,?)`).run(
    id, text, hash, bigrams(text), level, memoryType, source,
    ident.roleId, ident.userId, ident.workspace,
    JSON.stringify(normalizeTags(event?.tags)), '',
    origin, String(event?.traceId ?? ''),
    validAt, expiredAt, ts, ts,
  )
  return id
}

/** 配置 → 决策参数（兼容完整 config、write 段、以及扁平的 mode 别名）。 */
function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const w = c.write && typeof c.write === 'object' ? c.write : c
  return {
    mode: (w.reviewMode ?? w.mode) === 'auto' ? 'auto' : 'shadow',
    maxChars: finite(w.maxChars, 500),
    dailyCap: finite(w.dailyCap, 200),
    protect: w.protect !== false,
    redact: w.redact !== false,
  }
}

/**
 * 处理一个事件：决策 → 落库/落审计 → 返回结果。
 *
 * 落库动作（架构书 §6.2/§7.3）：
 * - ADD：插新节点（active），valid_at=本次时间。
 * - MERGE：改目标节点的 text/text_hash/text_bigrams/updated_at，不新增节点。
 * - SUPERSEDE：插新节点；旧节点 status='superseded'、invalid_at/expired_at=本次时间、superseded_by=新 id；
 *   并写 supersede 边。
 * - REVIEW：插新节点 + mutex 边（同词不同义，永不扩散）。
 * - NOOP：目标 hits+1、last_hit_at=本次时间。
 * - CANDIDATE：不进 nodes，只写 writes（影子审核队列）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} event 事件（见 decideWrite）
 * @param {object} [config] 完整配置或 write 段（reviewMode/maxChars/dailyCap/protect/redact）
 * @returns {{ ok: boolean, id?: string, action: string, reason: string }}
 */
export function processEvent(db, event, config = {}) {
  const options = resolveConfig(config)
  const decision = decideWrite(db, event, options)
  const ts = now()
  const action = String(decision.action || 'REJECT')
  const text = normalize(String(decision.afterText ?? event?.text ?? ''))
  let nodeId = null

  if (action === 'REJECT') {
    recordWrite(db, event, { ...decision, nodeId: null })
    return { ok: false, action, reason: String(decision.reason ?? '') }
  }

  const targetId = decision.targetId ? String(decision.targetId) : ''

  if (action === 'NOOP') {
    if (!targetId) throw new Error('noop_target_missing')
    withTx(db, () => {
      db.prepare('UPDATE nodes SET hits=hits+1, last_hit_at=? WHERE id=?').run(ts, targetId)
    })
    nodeId = targetId
  } else if (action === 'MERGE') {
    if (!targetId) throw new Error('merge_target_missing')
    withTx(db, () => {
      db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, updated_at=? WHERE id=?')
        .run(text, contentHash(text), bigrams(text), ts, targetId)
    })
    nodeId = targetId
  } else if (action === 'ADD') {
    nodeId = withTx(db, () => insertNodeRow(db, event, text, {
      ts,
      validAt: ts,
      source: mapSource(event?.source),
      origin: String(event?.origin ?? ''),
      level: validLevel(event?.level),
      memoryType: validMemoryType(event?.memory_type),
      expiredAt: validExpiredAt(event?.expired_at),
    }))
  } else if (action === 'SUPERSEDE' || action === 'REVIEW') {
    if (!targetId) throw new Error(`${action.toLowerCase()}_target_missing`)
    nodeId = withTx(db, () => {
      const newId = insertNodeRow(db, event, text, {
        ts,
        validAt: ts,
        source: mapSource(event?.source),
        origin: String(event?.origin ?? ''),
        level: validLevel(event?.level),
        memoryType: validMemoryType(event?.memory_type),
        expiredAt: validExpiredAt(event?.expired_at),
      })
      if (action === 'SUPERSEDE') {
        db.prepare(`UPDATE nodes SET status='superseded', invalid_at=?, expired_at=?, superseded_by=?, updated_at=?
          WHERE id=?`).run(ts, ts, newId, ts, targetId)
        linkSupersede(db, targetId, newId)
      } else {
        linkMutex(db, targetId, newId)
      }
      return newId
    })
  } else if (action === 'CANDIDATE') {
    // 影子审核：nodes 一行不写，审计行保留 after_text 供 review 落库
    nodeId = null
  } else {
    throw new Error(`unknown_action:${action}`)
  }

  recordWrite(db, event, { ...decision, nodeId })
  return { ok: true, id: nodeId ?? undefined, action, reason: String(decision.reason ?? '') }
}

/**
 * 持久化写入队列（铁律 3：进程重启后不丢事件）。
 *
 * 为什么用 jobs 表而不是内存数组：事件入队即落盘，进程重启后 enqueue 的 Promise 自然消失，
 * 但 job 还在；下次 createWriteQueue 把遗留 running 复位 queued，drain 继续跑完。
 *
 * @param {{
 *   store: { withDb: <T>(fn: (db: import('node:sqlite').DatabaseSync) => T) => T },
 *   config?: object,
 *   log?: (line: string) => void,
 * }} args
 * @returns {{
 *   enqueue: (event: object) => Promise<{ ok: boolean, id?: string, action: string, reason: string, duplicate?: boolean }>,
 *   drain: () => Promise<{ processed: number }>,
 *   review: (id: number|string, decision: 'accept'|'reject', reason?: string) => { ok: boolean, id?: string, error?: string },
 *   pending: () => number,
 *   dispose: () => void,
 * }}
 */
export function createWriteQueue({ store, config, log = () => {} } = {}) {
  if (!store || typeof store.withDb !== 'function') throw new TypeError('createWriteQueue: store.withDb required')
  const cfg = config || {}
  // config 可以是 getter：面板改 shadow/auto 后必须即时生效，不能在构造时冻结。
  const liveConfig = () => (typeof cfg === 'function' ? cfg() : cfg)
  const onDb = (fn) => store.withDb(fn)

  // 崩溃补偿：上一次进程死在 running 的 write job 重新排队（attempts 保留，便于观察重试次数）
  try {
    onDb((db) => db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE kind='write' AND state='running'").run(now()))
  } catch (err) {
    log(`[whale-memory] write queue reset failed: ${err?.message || err}`)
  }

  /** @type {Map<number, (result: any) => void>} */
  const waiters = new Map()
  let draining = null
  let closed = false

  /** 单批处理：置 running → processEvent → done/failed，单条失败不打断整批。 */
  async function runDrain() {
    let processed = 0
    for (;;) {
      if (closed) break
      let batch
      try {
        batch = onDb((db) => db.prepare(
          "SELECT id,payload FROM jobs WHERE kind='write' AND state='queued' ORDER BY id LIMIT " + BATCH,
        ).all())
      } catch (err) {
        log(`[whale-memory] write queue read failed: ${err?.message || err}`)
        break
      }
      if (!Array.isArray(batch) || batch.length === 0) break

      for (const job of batch) {
        const jobId = Number(job.id)
        let event = {}
        try { event = JSON.parse(String(job.payload ?? '{}')) } catch { event = {} }
        let result
        try {
          onDb((db) => db.prepare("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=?")
            .run(now(), jobId))
          result = onDb((db) => processEvent(db, event, liveConfig()))
          const payload = JSON.stringify({ ...event, result: { action: result.action, id: result.id ?? null } })
          onDb((db) => db.prepare("UPDATE jobs SET state='done', payload=?, last_error=NULL, updated_at=? WHERE id=?")
            .run(payload, now(), jobId))
        } catch (err) {
          const reason = String(err?.message || err)
          result = { ok: false, action: 'FAILED', reason }
          try {
            onDb((db) => db.prepare("UPDATE jobs SET state='failed', last_error=?, updated_at=? WHERE id=?")
              .run(reason, now(), jobId))
          } catch (inner) {
            log(`[whale-memory] write queue mark failed: ${inner?.message || inner}`)
          }
        }
        processed += 1
        const resolver = waiters.get(jobId)
        if (resolver) {
          waiters.delete(jobId)
          // 调用方要知道"这是重复消息"（面板/对话侧可据此静默）
          const out = result.action === 'NOOP' && result.reason === 'duplicate'
            ? { ...result, duplicate: true }
            : result
          resolver(out)
        }
      }
      if (batch.length < BATCH) break
      // 满批后让出事件循环，避免长队列霸占主线程（写入在下一批继续）
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { processed }
  }

  /** 单飞：并发 drain 返回同一个 Promise。 */
  function drain() {
    if (closed) return Promise.resolve({ processed: 0 })
    if (draining) return draining
    draining = runDrain().finally(() => { draining = null })
    return draining
  }

  /** 入队：先落盘再返回 Promise；该 job 处理完（done/failed）时 resolve。 */
  function enqueue(event) {
    if (closed) return Promise.resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    const payload = JSON.stringify(event ?? {})
    let jobId
    try {
      jobId = Number(onDb((db) => db.prepare(
        'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ).run('write', 'queued', 0, payload, now(), now()).lastInsertRowid))
    } catch (err) {
      return Promise.resolve({ ok: false, action: 'REJECT', reason: `queue_insert_failed:${err?.message || err}` })
    }
    const promise = new Promise((resolve) => waiters.set(jobId, resolve))
    setImmediate(() => { drain().catch((err) => log(`[whale-memory] write queue drain failed: ${err?.message || err}`)) })
    return promise
  }

  /**
   * 审核候选（writes 行 action='CANDIDATE'）。
   * accept：用 after_text + 身份列落节点（source='self'、origin='shadow-review'），审计行改 ADD。
   * reject：审计行改 REJECT，reason 追加 review:reject[:理由]。
   */
  function review(id, decision, reason) {
    const action = String(decision ?? '')
    if (action !== 'accept' && action !== 'reject') return { ok: false, error: 'invalid_decision' }
    const writeId = Number(id)
    if (!Number.isInteger(writeId)) return { ok: false, error: 'candidate_not_found' }
    try {
      return onDb((db) => {
        const row = db.prepare(
          "SELECT id,trace_id,action,reason,after_text,mode,user_id,role_id,workspace FROM writes WHERE id=? AND action='CANDIDATE'",
        ).get(writeId)
        if (!row) return { ok: false, error: 'candidate_not_found' }

        if (action === 'accept') {
          const text = normalize(String(row.after_text ?? ''))
          if (!text || text.length > 500) return { ok: false, error: 'invalid_text' }
          const ts = now()
          const hash = contentHash(text)
          const nodeId = `n${Date.now()}_${hash.slice(0, 10)}`
          db.prepare(`INSERT INTO nodes
            (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
             context_note,weight,hits,vector_state,origin,trace_id,valid_at,expired_at,created_at,updated_at)
            VALUES (?,?,?,?,'normal','semantic','self','active',?,?,?,'[]','',1,0,'none','shadow-review',?,?,?,?,?)`).run(
            nodeId, text, hash, bigrams(text),
            String(row.role_id ?? ''), String(row.user_id ?? ''), String(row.workspace ?? ''),
            String(row.trace_id ?? ''), ts, null, ts, ts,
          )
          db.prepare("UPDATE writes SET action='ADD', node_id=? WHERE id=?").run(nodeId, writeId)
          return { ok: true, id: nodeId }
        }

        const extra = `review:reject${reason ? ':' + String(reason) : ''}`
        const previous = String(row.reason ?? '').trim()
        db.prepare("UPDATE writes SET action='REJECT', reason=? WHERE id=?")
          .run(previous ? `${previous} · ${extra}` : extra, writeId)
        return { ok: true }
      })
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  /** 待处理 job 数（queued + running）。 */
  function pending() {
    if (closed) return 0
    try {
      return Number(onDb((db) => db.prepare(
        "SELECT count(*) AS n FROM jobs WHERE kind='write' AND state IN ('queued','running')",
      ).get()?.n || 0))
    } catch {
      return 0
    }
  }

  /** 释放内存态（不动库：未完成的 job 留给下次启动继续）。 */
  function dispose() {
    closed = true
    for (const resolve of waiters.values()) resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    waiters.clear()
  }

  return { enqueue, drain, review, pending, dispose }
}
