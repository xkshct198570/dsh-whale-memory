/**
 * 写入决策 + 持久化队列（L2 机制层，架构书 §6.2 决策顺序 / §7.3 时间重叠）。
 *
 * 为什么这样设计：
 * - 决策与落库分离：decideWrite 只读库、只产出 decision；processEvent 才动 nodes/edges/writes。
 *   一条规则能单独验，面板也能预演（拿到 decision 先给用户看，再决定是否落库）。
 * - 决策顺序即优先级：文本合法性 → 隐私 → 配额 → 同 origin 复写 → 同文去重（含来源升级）→
 *   相似合并 → 冲突 → 影子 → 新增。
 *   顺序不能换：先查冲突再脱敏，脱敏后的文本与库内文本就不可比；先去重再配额，重复消息会白吃额度。
 * - 冲突判定不调模型：否定词对 + 槽位（端口/路径/版本/日期）差异足够稳定，可离线复现、零成本。
 * - 事实时间与系统时间分开：invalid_at 用"新事实生效时间"，expired_at 用系统删除时间，回溯可解释。
 * - 队列必须落 jobs 表：DSH 进程随对话重启，内存队列会丢事件；启动时把 running 复位成 queued 是崩溃补偿。
 * - 影子模式把"会落库"的动作统一降级为 CANDIDATE：审核前 nodes 一行不写，只留 writes 审计；
 *   NOOP/REJECT 不是落库动作，照旧记审计。
 * - 本模块不做邻居注记（applyNeighborNotes 由集成层调用）：写入只负责自己的一致性，扩散注记属于关系层调度。
 * - 配置可能来自 schemastery（`.volatile()` 字段是 Ref）：core 不得 import host，因此本文件自带
 *   `plain()` 解包。不解包时 `Ref === 'auto'` 恒 false、`Number(Ref)` 恒 NaN，
 *   auto 会静默退化成 shadow、maxChars/dailyCap 恒回默认值。
 * - 去重要比较来源可信度（架构书 §6.3：owner > self > group > web/tool > import）：
 *   同文但新来源更可信时升 source（MERGE/source_upgrade），否则才 NOOP；
 *   否则 owner 事实会被低可信版本吞掉，并失去保护面。
 * - MERGE 也必须尊重保护面（owner/core/procedural）：命中受保护目标改走 REVIEW（protected_merge），
 *   新节点 + mutex，旧正文一行不动。
 * - 影子候选的决策载荷落 writes.payload：审核 accept 按 shadowOf 还原字段并执行同构动作，
 *   不能再用硬编码 normal/semantic/self（那样 SUPERSEDE/MERGE 候选会被静默当 ADD）。
 */
import { now } from './db.js'
import { bigrams, contentHash, normalize, similarity } from './tokenize.js'
import { linkMutex, linkSupersede, normalizeTags } from './relations.js'
import { buildJudgePrompt, mapCandidates, parseJudgeOutput } from './judge.js'

/** 脱敏占位符（隐私命中一律替换成它，长度稳定、可被检索到"这里被脱敏过"）。 */
const MASK = '[已脱敏]'
/** 每批任务数（写连接上保持短事务，避免长阻塞）。 */
const BATCH = 20
/** 判定器候选上限：只问最新的 N 条（提示词体积/token 成本的硬闸门，候选再多也只截最新）。 */
const JUDGE_CANDIDATE_LIMIT = 12
/** 判定器模型硬超时：单条超 2s 即回落规则，不拖住整批写入。 */
const JUDGE_TIMEOUT_MS = 2000
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

/** 来源可信度等级（架构书 §6.3）：owner > self > group > web/tool > import；未知来源最低。 */
const SOURCE_RANK = { owner: 5, self: 4, group: 3, web: 2, tool: 2, import: 1 }

/** 单条写入文本硬顶（与 nodes.text CHECK 同值）。 */
const TEXT_LIMIT = 500

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

/**
 * 解包 schemastery 的 Ref（`.volatile()` 字段）：`get()` 才是值。
 *
 * 为什么在 core 里重复一份：分层约束禁止 core import host，而配置对象由 host 注入；
 * Ref 直接参与比较会恒假/NaN（`Ref === 'auto'` 为 false、`Number(Ref)` 为 NaN），
 * 结果就是开关"看起来配了但永远不生效"。
 *
 * @param {unknown} value 可能是 Ref 的配置值
 * @returns {unknown} 解包后的原始值
 */
function plain(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/**
 * 来源可信度（用于同文去重时的 source 升级判定）。
 * @param {unknown} source nodes.source 值
 * @returns {number} 等级（越大越可信）；未知来源 0
 */
function sourceRank(source) {
  return SOURCE_RANK[String(source ?? '')] ?? 0
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

/** 搜索反哺 origin 键的形状：`tool:<工具名>#<16 位 hex>`（search-feed 的固定格式）。 */
const ORIGIN_KEY_RE = /^tool:[^#\s]+#[0-9a-f]{16}$/

/** 决策参数归一：mode 缺省 shadow（保守），maxChars 不许突破 schema 的 500 硬顶。 */
function resolveOptions(opts) {
  const o = plain(opts) || {}
  return {
    mode: plain(o.mode) === 'auto' ? 'auto' : 'shadow',
    maxChars: Math.max(1, Math.min(TEXT_LIMIT, finite(plain(o.maxChars), TEXT_LIMIT))),
    dailyCap: Math.max(0, Math.floor(finite(plain(o.dailyCap), 200))),
    protect: plain(o.protect) !== false,
    redact: plain(o.redact) !== false,
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
 * 受保护目标（架构书 §6.2 保护面）：owner 来源 / core 等级 / procedural 类型。
 * MERGE 与 SUPERSEDE 共用同一口径，protect=false 时整体关闭。
 *
 * @param {{ source?: unknown, level?: unknown, memory_type?: unknown } | null | undefined} row
 * @param {{ protect?: boolean }} options
 * @returns {boolean}
 */
function isProtectedTarget(row, options) {
  if (!options?.protect) return false
  return String(row?.source ?? '') === 'owner'
    || String(row?.level ?? '') === 'core'
    || String(row?.memory_type ?? '') === 'procedural'
}

/**
 * 同身份分区的 active 候选（相似合并/冲突判定的同一份口径）。
 *
 * 为什么抽成导出函数：判定器（judge=llm）必须在 DB 事务外先拿到候选去问模型，
 * 再让 decideWrite 按裁决落库；两处各写一条 SELECT 迟早口径漂移（一处分区/状态写错，
 * 判定器就会对另一批节点裁决）。顺序固定 created_at DESC（最新优先，判定器编号也用这个顺序）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ identity?: object }} event
 * @returns {Array<{ id: string, text: string, level: string, memory_type: string,
 *   source: string, valid_at: number|null, invalid_at: number|null }>}
 */
export function findCandidates(db, event) {
  const ident = normalizeIdentity(event?.identity)
  return db.prepare(
    `SELECT id,text,level,memory_type,source,valid_at,invalid_at FROM nodes
     WHERE status='active' AND user_id=? AND role_id=? AND workspace=?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(ident.userId, ident.roleId, ident.workspace, CANDIDATE_LIMIT)
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
function decideByRules(db, event, opts = {}) {
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

  // 3. 当日配额（NOOP/REJECT 不占额度：它们没有产生新事实；SPLIT 是导入迁移记账，不算当日新增）
  const since = startOfDay(now())
  const used = Number(db.prepare(
    "SELECT count(*) AS n FROM writes WHERE ts>=? AND user_id=? AND role_id=? AND workspace=? AND action NOT IN ('NOOP','REJECT','SPLIT')",
  ).get(since, ident.userId, ident.roleId, ident.workspace)?.n || 0)
  if (used >= options.dailyCap) return { action: 'REJECT', reason: 'daily_cap', mode: options.mode }

  // 4. 同 origin 复写（搜索反哺：同查询同日同一个 origin 只更新既有节点，不新增、不被 NOOP 吞掉）
  //    搜索摘要每次返回内容可能不同，但语义上是"同一查询的当天结果"；按 origin 定向 MERGE，
  //    同时续 TTL（event.expired_at 提供时）。顺序必须在同 hash NOOP 之前。
  //    只认 search-feed 的固定键形状：origin 在其它写入路径是粗粒度"证据出处"（panel/unit/...），
  //    拿它当唯一键会把同来源的不同事实误合并。
  const originKey = ORIGIN_KEY_RE.test(String(event?.origin ?? '')) ? String(event.origin) : ''
  if (originKey) {
    const sameOrigin = db.prepare(
      "SELECT id,text,level,memory_type,source FROM nodes WHERE origin=? AND status='active' AND user_id=? AND role_id=? AND workspace=? ORDER BY created_at DESC LIMIT 1",
    ).get(originKey, ident.userId, ident.roleId, ident.workspace)
    if (sameOrigin) {
      const targetId = String(sameOrigin.id)
      const beforeText = String(sameOrigin.text ?? '')
      // 保护面优先：受保护节点的正文不允许被来源复写改写（与相似 MERGE 同口径）。
      if (isProtectedTarget(sameOrigin, options)) {
        return settle({
          action: 'REVIEW',
          reason: 'protected_merge',
          targetId,
          beforeText,
          afterText: text,
        }, options, { text, redacted })
      }
      return settle({
        action: 'MERGE',
        reason: 'origin_merge',
        targetId,
        beforeText,
        afterText: text,
      }, options, { text, redacted })
    }
  }

  // 5. 同身份原文命中：来源更可信 → 升级 source；否则 NOOP（记一次命中，不新增事实）
  const hash = contentHash(text)
  const dup = db.prepare(
    "SELECT id,text,source FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1",
  ).get(hash, ident.userId, ident.roleId, ident.workspace)
  if (dup) {
    const incoming = mapSource(event?.source)
    if (sourceRank(incoming) > sourceRank(dup.source)) {
      // 内容相同、来源更可信：只改 source 与 updated_at（正文/双时态不动），审计记 MERGE/source_upgrade。
      return settle({
        action: 'MERGE',
        reason: 'source_upgrade',
        targetId: String(dup.id),
        beforeText: String(dup.text ?? ''),
        afterText: text,
        sourceUpgrade: true,
        source: incoming,
      }, options, { text, redacted })
    }
    return {
      action: 'NOOP',
      reason: 'duplicate',
      targetId: String(dup.id),
      beforeText: String(dup.text ?? ''),
      afterText: text,
      mode: options.mode,
    }
  }

  const candidates = findCandidates(db, event)

  // 6. 相似合并：只有"信息只增不减"才合并，否则交给冲突/新增
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
    const targetId = String(mergeRow.id)
    const beforeText = String(mergeRow.text ?? '')
    // 保护面同样适用于合并：owner/core/procedural 的正文不得被自动改写，
    // 改走 REVIEW（新节点 + mutex），旧节点正文保持一行不动。
    if (isProtectedTarget(mergeRow, options)) {
      return settle({
        action: 'REVIEW',
        reason: 'protected_merge',
        targetId,
        beforeText,
        afterText: text,
      }, options, { text, redacted })
    }
    return settle({
      action: 'MERGE',
      reason: 'merge_similar',
      targetId,
      beforeText,
      afterText: text,
    }, options, { text, redacted })
  }

  // 7. 冲突：同身份 active 候选里找"否定/槽位"冲突且时间重叠的最近一条
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
    const protectedTarget = isProtectedTarget(conflictRow, options)
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

/** 判定器可覆盖的动作（与 processEvent 的既有落库分支一一对应；REVIEW/CANDIDATE 由影子/保护面派生）。 */
const JUDGE_ACTIONS = new Set(['ADD', 'MERGE', 'SUPERSEDE', 'NOOP'])

/**
 * 判定器裁决 → 等价的规则决策（不重新找候选：模型已按候选裁决，这里只复核目标仍然可用）。
 *
 * 三道闸缺一不可：
 * - 目标必须仍 active（模型调用期间别的 job 可能已把它取代/归档）；
 * - 必须同身份分区可见（跨 user/role/workspace 的节点不许被裁决命中，否则是越权改写）；
 * - 非受保护面（owner/core/procedural 的正文只能人工审核，模型说了也不算）。
 * 任一不过返回 error → 调用方回落规则，reason 带 `judge_fallback:<why>`。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} event
 * @param {{ ok: true, targetId?: string|null, action?: string }} verdict
 * @param {object} options resolveOptions 结果
 * @param {{ afterText?: string, reason?: string }} base 规则决策（取已脱敏正文）
 * @returns {{ decision?: object, error?: string }}
 */
function judgeDecision(db, event, verdict, options, base) {
  const action = String(verdict?.action ?? '').trim().toUpperCase()
  if (!JUDGE_ACTIONS.has(action)) return { error: 'judge_fallback:bad_action' }
  const text = String(base?.afterText ?? '')
  const redacted = String(base?.reason ?? '').includes('privacy:redacted')
  if (action === 'ADD') {
    return { decision: settle({ action: 'ADD', reason: 'judge_add', afterText: text }, options, { text, redacted }) }
  }
  const targetId = isBlank(verdict?.targetId) ? '' : String(verdict.targetId)
  if (!targetId) return { error: 'judge_fallback:target_missing' }
  const ident = normalizeIdentity(event?.identity)
  const row = db.prepare(
    "SELECT id,text,level,memory_type,source FROM nodes WHERE id=? AND status='active' AND user_id=? AND role_id=? AND workspace=? LIMIT 1",
  ).get(targetId, ident.userId, ident.roleId, ident.workspace)
  if (!row) return { error: 'judge_fallback:target_unavailable' }
  if (isProtectedTarget(row, options)) return { error: 'judge_fallback:protected_target' }
  return {
    decision: settle({
      action,
      reason: `judge_${action.toLowerCase()}`,
      targetId: String(row.id),
      beforeText: String(row.text ?? ''),
      afterText: text,
    }, options, { text, redacted }),
  }
}

/**
 * 决策入口：规则先跑（文本合法性 → 隐私 → 配额 → 同 origin → 同文 → 相似 → 冲突 → 新增），
 * 判定器裁决只在规则通过前置闸之后覆盖语义判断这一层。
 *
 * 为什么规则先跑而不是让模型接管全流程：脱敏/配额/同 origin 复写是安全与记账口径，
 * 模型不能绕过；REJECT 时判定器连覆盖的机会都没有（非法文本/超额不会因为模型说 ADD 就落库）。
 * 没有任何裁决（judgeVerdict 缺省）时与旧行为逐字节相同。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ text?: string, traceId?: string, identity?: object, tags?: string[], level?: string,
 *   memory_type?: string, expired_at?: number, source?: string, origin?: string,
 *   __judgeVerdict?: object }} event
 * @param {{ mode?: 'shadow'|'auto', maxChars?: number, dailyCap?: number, protect?: boolean,
 *   redact?: boolean, judgeVerdict?: { ok: boolean, targetId?: string|null, action?: string,
 *   error?: string } }} [opts]
 * @returns {{ action: string, reason: string, targetId?: string, beforeText?: string,
 *   afterText?: string, mode?: string, shadowOf?: string,
 *   judge?: { used: boolean, action?: string, targetId?: string|null, error?: string } }}
 */
export function decideWrite(db, event, opts = {}) {
  const plainOpts = plain(opts) || {}
  const verdict = plain(plainOpts.judgeVerdict ?? event?.__judgeVerdict)
  const base = decideByRules(db, event, opts)
  if (!verdict) return base
  if (base.action === 'REJECT') return { ...base, judge: { used: false, error: 'judge_fallback:rejected' } }
  if (plain(verdict)?.ok !== true) {
    const why = String(plain(verdict)?.error || 'invalid_verdict')
    return { ...base, judge: { used: false, error: why } }
  }
  const options = resolveOptions(opts)
  const applied = judgeDecision(db, event, plain(verdict), options, base)
  if (!applied.decision) return { ...base, judge: { used: false, error: applied.error } }
  return {
    ...applied.decision,
    judge: {
      used: true,
      action: String(applied.decision.shadowOf || applied.decision.action),
      targetId: applied.decision.targetId ? String(applied.decision.targetId) : null,
    },
  }
}

/**
 * 写审计行（writes）。每个决策结果都要留痕，面板/复盘靠它。
 *
 * payload（v2）保存影子候选的决策载荷：审核 accept 时据此还原字段并按 shadowOf 执行，
 * 避免"候选是 SUPERSEDE/MERGE，接受后却按 ADD 落库"的载荷丢失。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ traceId?: string, identity?: object, mode?: string, level?: string, memory_type?: string,
 *   tags?: string[], source?: string, origin?: string, expired_at?: number }} event 原始事件
 * @param {{ action: string, reason?: string, nodeId?: string|null, beforeText?: string|null,
 *   afterText?: string|null, mode?: string, level?: string, memory_type?: string, tags?: string[],
 *   source?: string, shadowOf?: string, targetId?: string|null }} decision
 * @returns {number} 新 writes 行 id
 */
export function recordWrite(db, event, decision) {
  const ident = normalizeIdentity(event?.identity)
  const payload = {
    level: validLevel(decision?.level ?? event?.level),
    memory_type: validMemoryType(decision?.memory_type ?? event?.memory_type),
    tags: normalizeTags(decision?.tags ?? event?.tags),
    source: mapSource(decision?.source ?? event?.source),
    origin: String(event?.origin ?? ''),
    expired_at: validExpiredAt(event?.expired_at),
    shadowOf: decision?.shadowOf ? String(decision.shadowOf) : null,
    targetId: decision?.targetId ? String(decision.targetId) : null,
  }
  const info = db.prepare(`INSERT INTO writes
    (ts,trace_id,action,node_id,reason,before_text,after_text,mode,payload,user_id,role_id,workspace)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    now(),
    String(event?.traceId ?? ''),
    String(decision?.action ?? ''),
    decision?.nodeId ? String(decision.nodeId) : null,
    String(decision?.reason ?? ''),
    decision?.beforeText === undefined || decision?.beforeText === null ? null : String(decision.beforeText),
    decision?.afterText === undefined || decision?.afterText === null ? null : String(decision.afterText),
    String(decision?.mode ?? event?.mode ?? 'shadow'),
    JSON.stringify(payload),
    ident.userId,
    ident.roleId,
    ident.workspace,
  )
  return Number(info.lastInsertRowid)
}

/**
 * 演化留痕（evolution 的唯一 INSERT 入口）。
 *
 * 为什么收敛成一处：「所有改动留痕」（架构书 §7.2）意味着 supersede 迁移、面板人工编辑、
 * 邻居注记都要落同一张表；散在各处的 INSERT 迟早漏字段（旧代码只有 relations.js 一处，
 * supersede 与人工 updateNode 都没留痕）。from_id=发起方/被改节点，to_id=被改节点。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ts?: number, fromId?: string, toId?: string, field?: string,
 *   oldValue?: unknown, newValue?: unknown, traceId?: string }} row
 * @returns {number} 新 evolution 行 id
 */
export function recordEvolution(db, row = {}) {
  const text = (v) => (v === null || v === undefined ? null : String(v).slice(0, 500))
  const info = db.prepare(`INSERT INTO evolution (ts,from_id,to_id,field,old_value,new_value,trace_id)
    VALUES (?,?,?,?,?,?,?)`).run(
    finite(row.ts, now()),
    String(row.fromId ?? ''),
    String(row.toId ?? ''),
    String(row.field ?? ''),
    text(row.oldValue),
    text(row.newValue),
    String(row.traceId ?? '').slice(0, 64),
  )
  return Number(info.lastInsertRowid) || 0
}

/** 事务包装：调用方已开事务时不重复 BEGIN（BEGIN 失败即视为嵌套，直接执行）。 */
export function withTx(db, fn) {
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
/**
 * 事实生效时间（Graphiti: reference_time 与系统时间分离）。
 *
 * `valid_at` 表示"这条事实何时为真"：调用方可传事件时间（消息时间/历史日志时间）；
 * 缺省才回落到本次系统时间。`created_at` 永远是系统时间，不参与这里。
 * 只接受有限正数，且不允许未来时间（未来时间会让"现在"过滤误判过期）。
 * @param {{ referenceTime?: unknown } | null | undefined} event
 * @param {number} ts 系统时间（秒）
 * @returns {number}
 */
function validAtOf(event, ts) {
  const raw = event?.referenceTime
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 && n <= ts ? n : ts
}

function insertNodeRow(db, event, text, { ts, validAt, source, origin, level, memoryType, expiredAt }) {
  const ident = normalizeIdentity(event?.identity)
  const hash = contentHash(text)
  // id 由"毫秒时间 + hash 前 10 位"组成；同文本写进不同身份/分区可能落在同一毫秒，
  // 此时仅靠 hash 会撞主键。保持 id 形状不变（既有契约/面板正则），冲突时把毫秒数 +1 找空位。
  let at = Date.now()
  let id = `n${at}_${hash.slice(0, 10)}`
  while (db.prepare('SELECT 1 FROM nodes WHERE id=?').get(id)) {
    at += 1
    id = `n${at}_${hash.slice(0, 10)}`
  }
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

/**
 * 配置 → 决策参数（兼容完整 config、write 段、以及扁平的 mode 别名）。
 *
 * 注意：真实 Config 的 write 段字段都是 schemastery Ref，必须先 plain() 再比较；
 * 否则 `w.reviewMode === 'auto'` 恒 false（auto 静默退化成 shadow）、`finite(Ref)` 恒 NaN
 * （maxChars/dailyCap 恒回默认值）。
 *
 * 隐私开关（审计 P0-1 假开关）：真源是 Config 的 `privacy.redact`（面板「设置·隐私」那一栏
 * 真正落在 schema 的 privacy 组；`write.redact` 在 schema 里不存在，只被旧单测当扁平写法用）。
 * 因此先读 `privacy.redact`，缺失才回落 `write.redact`——保留直连 write 段的旧调用方。
 *
 * @param {object|((() => object))|null|undefined} config
 * @returns {{ mode: 'shadow'|'auto', maxChars: number, dailyCap: number, protect: boolean, redact: boolean }}
 */
function resolveConfig(config) {
  const c = plain(config)
  const root = c && typeof c === 'object' ? c : {}
  const section = plain(root.write)
  const w = section && typeof section === 'object' ? section : root
  const privacySection = plain(root.privacy)
  const privacy = privacySection && typeof privacySection === 'object' ? privacySection : null
  const redact = privacy && privacy.redact !== undefined
    ? plain(privacy.redact) !== false
    : plain(w.redact) !== false
  return {
    mode: plain(w.reviewMode ?? w.mode) === 'auto' ? 'auto' : 'shadow',
    maxChars: finite(plain(w.maxChars), TEXT_LIMIT),
    dailyCap: finite(plain(w.dailyCap), 200),
    protect: plain(w.protect) !== false,
    redact,
  }
}

/**
 * 处理一个事件：决策 → 落库/落审计 → 返回结果。
 *
 * 落库动作（架构书 §6.2/§7.3）：
 * - ADD：插新节点（active），valid_at=本次时间。
 * - MERGE：改目标节点的 text/text_hash/text_bigrams/updated_at，不新增节点；同 origin 复写或
 *   相似合并时若事件带 expired_at 则同时续期。来源升级（source_upgrade）只改 source/updated_at。
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
    return { ok: false, action, reason: String(decision.reason ?? ''), ...(decision.judge ? { judge: decision.judge } : {}) }
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
    if (decision.sourceUpgrade) {
      // 同文来源升级：只改 source/updated_at，正文与双时态保持不变。
      const upgraded = mapSource(decision.source ?? event?.source)
      withTx(db, () => {
        db.prepare('UPDATE nodes SET source=?, updated_at=? WHERE id=?').run(upgraded, ts, targetId)
      })
    } else {
      // 同 origin/相似 MERGE：更新正文；事件带 TTL 时同时续期（搜索反哺每天刷新同一查询的摘要）。
      const expiredAt = validExpiredAt(event?.expired_at)
      withTx(db, () => {
        if (expiredAt !== null) {
          db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, expired_at=?, updated_at=? WHERE id=?')
            .run(text, contentHash(text), bigrams(text), expiredAt, ts, targetId)
        } else {
          db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, updated_at=? WHERE id=?')
            .run(text, contentHash(text), bigrams(text), ts, targetId)
        }
      })
    }
    nodeId = targetId
  } else if (action === 'ADD') {
    nodeId = withTx(db, () => insertNodeRow(db, event, text, {
      ts,
      validAt: validAtOf(event, ts),
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
        validAt: validAtOf(event, ts),
        source: mapSource(event?.source),
        origin: String(event?.origin ?? ''),
        level: validLevel(event?.level),
        memoryType: validMemoryType(event?.memory_type),
        expiredAt: validExpiredAt(event?.expired_at),
      })
      if (action === 'SUPERSEDE') {
        // 旧值必须在 UPDATE 之前读：evolution 的 old_value 是"改之前"，不能拿新行反推。
        const before = db.prepare('SELECT status, text FROM nodes WHERE id=?').get(targetId) || {}
        db.prepare(`UPDATE nodes SET status='superseded', invalid_at=?, expired_at=?, superseded_by=?, updated_at=?
          WHERE id=?`).run(ts, ts, newId, ts, targetId)
        linkSupersede(db, targetId, newId)
        // 所有改动留痕（§7.2）：状态迁移一条；正文被新事实替换时再补一条 text。
        recordEvolution(db, {
          ts, fromId: targetId, toId: newId, field: 'status',
          oldValue: before.status ?? 'active', newValue: 'superseded', traceId: event?.traceId,
        })
        if (String(before.text ?? '') !== text) {
          recordEvolution(db, {
            ts, fromId: targetId, toId: newId, field: 'text',
            oldValue: before.text ?? '', newValue: text, traceId: event?.traceId,
          })
        }
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
  return {
    ok: true,
    id: nodeId ?? undefined,
    action,
    reason: String(decision.reason ?? ''),
    ...(decision.judge ? { judge: decision.judge } : {}),
  }
}

/**
 * 影子候选落库（review accept 的唯一执行器）：按 payload.shadowOf 执行与 auto 模式同构的动作。
 *
 * 为什么必须还原载荷：只拿 after_text 硬编码落 ADD 会把 SUPERSEDE/MERGE 候选变成新事实，
 * 既丢双时态（expired_at）也丢关系边（supersede/mutex）。载荷缺失的旧候选回落 ADD。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row writes 行（含 after_text/trace_id/user_id/role_id/workspace）
 * @param {string} text normalize 后的正文
 * @param {object} payload recordWrite 存入的决策载荷
 * @param {string} shadowOf ADD/MERGE/SUPERSEDE/REVIEW
 * @param {number} writeId writes 行 id
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
function acceptCandidate(db, row, text, payload, shadowOf, writeId) {
  const ts = now()
  const ident = {
    userId: String(row.user_id ?? ''),
    roleId: String(row.role_id ?? ''),
    workspace: String(row.workspace ?? ''),
  }
  const targetId = payload?.targetId ? String(payload.targetId) : ''
  const event = { identity: ident, traceId: String(row.trace_id ?? ''), tags: normalizeTags(payload?.tags) }
  const insert = () => insertNodeRow(db, event, text, {
    ts,
    validAt: validAtOf({ ...event, referenceTime: payload?.referenceTime }, ts),
    source: mapSource(payload?.source),
    origin: 'shadow-review',
    level: validLevel(payload?.level),
    memoryType: validMemoryType(payload?.memory_type),
    expiredAt: validExpiredAt(payload?.expired_at),
  })

  if (shadowOf === 'MERGE') {
    const target = targetId ? db.prepare('SELECT id,source,level,memory_type,text FROM nodes WHERE id=?').get(targetId) : null
    if (!target) return { ok: false, error: 'target_not_found' }
    // 决策时目标不受保护、审核时已被标记保护：accept 必须拒绝，不能绕过保护面。
    if (isProtectedTarget(target, { protect: true })) return { ok: false, error: 'protected_target' }
    const incoming = mapSource(payload?.source)
    const source = sourceRank(incoming) > sourceRank(target.source) ? incoming : target.source
    const expiredAt = validExpiredAt(payload?.expired_at)
    if (expiredAt !== null) {
      db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, source=?, expired_at=?, updated_at=? WHERE id=?')
        .run(text, contentHash(text), bigrams(text), source, expiredAt, ts, targetId)
    } else {
      db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, source=?, updated_at=? WHERE id=?')
        .run(text, contentHash(text), bigrams(text), source, ts, targetId)
    }
    // 审核通过也是"一次改动"：正文被影子候选替换要留痕（§7.2），否则 accept 成了审计盲区。
    if (String(target.text ?? '') !== text) {
      recordEvolution(db, {
        ts, fromId: targetId, toId: targetId, field: 'text',
        oldValue: target.text ?? '', newValue: text, traceId: row.trace_id,
      })
    }
    db.prepare("UPDATE writes SET action='MERGE', node_id=? WHERE id=?").run(targetId, writeId)
    return { ok: true, id: targetId }
  }

  if (shadowOf === 'SUPERSEDE') {
    const target = targetId ? db.prepare('SELECT id,status,text FROM nodes WHERE id=?').get(targetId) : null
    if (!target) return { ok: false, error: 'target_not_found' }
    const newId = insert()
    db.prepare(`UPDATE nodes SET status='superseded', invalid_at=?, expired_at=?, superseded_by=?, updated_at=?
      WHERE id=?`).run(ts, ts, newId, ts, targetId)
    linkSupersede(db, targetId, newId)
    // 影子候选 accept 后的取代与 auto 模式同构：状态迁移 + 正文替换都要留痕。
    recordEvolution(db, {
      ts, fromId: targetId, toId: newId, field: 'status',
      oldValue: target.status ?? 'active', newValue: 'superseded', traceId: row.trace_id,
    })
    if (String(target.text ?? '') !== text) {
      recordEvolution(db, {
        ts, fromId: targetId, toId: newId, field: 'text',
        oldValue: target.text ?? '', newValue: text, traceId: row.trace_id,
      })
    }
    db.prepare("UPDATE writes SET action='SUPERSEDE', node_id=? WHERE id=?").run(newId, writeId)
    return { ok: true, id: newId }
  }

  // ADD / REVIEW（旧候选 payload 缺失也走这里：等价 ADD）
  const newId = insert()
  if (shadowOf === 'REVIEW' && targetId && db.prepare('SELECT 1 FROM nodes WHERE id=?').get(targetId)) {
    linkMutex(db, targetId, newId)
  }
  const landed = shadowOf === 'REVIEW' ? 'REVIEW' : 'ADD'
  db.prepare('UPDATE writes SET action=?, node_id=? WHERE id=?').run(landed, newId, writeId)
  return { ok: true, id: newId }
}

/**
 * 判定器模型调用：照 reflect.js 的 stream 收集口径（text-delta/block-end），
 * 外加 2s AbortController 硬超时（模型卡住不能拖住整批写入）。
 *
 * 非导出：只有队列用；测试通过 fake llm 端到端覆盖（见 writer.test.mjs）。
 *
 * @param {{ stream: Function }} llm
 * @param {{ provider?: string, model?: string } | null} selection
 * @param {string} prompt
 * @param {string} modelOverride write.model（非空即覆盖默认模型）
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
function collectJudgeText(llm, selection, prompt, modelOverride) {
  const provider = selection?.provider
  const model = modelOverride || selection?.model
  if (!provider || !model) return Promise.resolve({ ok: false, error: 'no_model' })
  return new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    const finish = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    const timer = setTimeout(() => {
      try { controller.abort() } catch { /* 已结束的 stream 再 abort 无害 */ }
      finish({ ok: false, error: 'timeout' })
    }, JUDGE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    void (async () => {
      let text = ''
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          temperature: 0,
          maxTokens: 200,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text += String(chunk.block.text || '')
        }
        finish({ ok: true, text })
      } catch {
        finish({ ok: false, error: 'llm_error' })
      }
    })()
  })
}

/**
 * 持久化写入队列（铁律 3：进程重启后不丢事件）。
 *
 * 为什么用 jobs 表而不是内存数组：事件入队即落盘，进程重启后 enqueue 的 Promise 自然消失，
 * 但 job 还在；下次 createWriteQueue 把遗留 running 复位 queued，drain 继续跑完。
 *
 * 判定器（judge=llm）：每条 job 处理前，在 DB 事务外取候选 → 无候选直接 ADD（不调模型）→
 * 有候选且 llm/selection 可用才问模型；解析失败/超时/模型缺失一律带 `judge_fallback:<why>`
 * 回落规则。模型调用从不进事务、单条失败只影响该条（job 仍按规则落库），整批照跑。
 *
 * @param {{
 *   store: { withDb: <T>(fn: (db: import('node:sqlite').DatabaseSync) => T) => T },
 *   config?: object|Function,
 *   log?: (line: string) => void,
 *   getLlm?: (() => any) | null,
 *   getSelection?: (() => { provider?: string, model?: string } | null) | null,
 * }} args
 * @returns {{
 *   enqueue: (event: object) => Promise<{ ok: boolean, id?: string, action: string, reason: string, duplicate?: boolean, judge?: object }>,
 *   drain: () => Promise<{ processed: number }>,
 *   review: (id: number|string, decision: 'accept'|'reject', reason?: string) => { ok: boolean, id?: string, error?: string },
 *   pending: () => number,
 *   dispose: () => void,
 * }}
 */
export function createWriteQueue({ store, config, log = () => {}, getLlm = null, getSelection = null } = {}) {
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

  /** judge=llm 开关（兼容 Ref 与扁平 config；读不到一律按 rules）。 */
  const judgeEnabled = (live) => {
    try {
      const c = plain(live)
      const w = plain(c?.write)
      return String(plain(w?.judge ?? '') || '') === 'llm'
    } catch {
      return false
    }
  }

  /**
   * 判定器裁决（模型调用绝不进 DB 事务：先 onDb 同步取候选，再在事务外问模型）。
   * 无候选返回 null（调用方直接走规则 ADD，不花模型钱）；其余失败返回 ok:false 的裁决，
   * 由 decideWrite 回落规则并在结果里带 `judge_fallback:<why>`。
   */
  async function judgeEvent(event, live) {
    const fallback = (why) => ({ ok: false, error: `judge_fallback:${why}` })
    let candidates
    try {
      candidates = onDb((db) => findCandidates(db, event))
    } catch {
      return fallback('candidates_unavailable')
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    const llm = typeof getLlm === 'function' ? getLlm() : null
    if (!llm || typeof llm.stream !== 'function') return fallback('llm_unavailable')
    const selection = typeof getSelection === 'function' ? getSelection() : null
    const writeSection = plain(plain(live)?.write)
    const modelOverride = String(plain(writeSection?.model) ?? '')
    if (!selection?.provider || (!selection?.model && !modelOverride)) return fallback('no_model')
    const text = normalize(String(event?.text ?? ''))
    const { map, lines } = mapCandidates(candidates.slice(0, JUDGE_CANDIDATE_LIMIT))
    const out = await collectJudgeText(llm, selection, buildJudgePrompt(text, lines), modelOverride)
    if (!out.ok) return fallback(out.error || 'llm_error')
    const parsed = parseJudgeOutput(out.text, map)
    if (!parsed.ok) return fallback(parsed.error)
    return { ok: true, targetId: parsed.targetId, action: parsed.action, reason: parsed.reason }
  }

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
        let verdict = null
        try {
          onDb((db) => db.prepare("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=?")
            .run(now(), jobId))
          const live = liveConfig()
          if (judgeEnabled(live)) {
            try {
              verdict = await judgeEvent(event, live)
            } catch (err) {
              verdict = { ok: false, error: `judge_fallback:${String(err?.message || err)}` }
            }
          }
          const targetEvent = verdict ? { ...event, __judgeVerdict: verdict } : event
          result = onDb((db) => processEvent(db, targetEvent, live))
          if (result?.judge?.used) {
            log(`[whale-memory] judge used=true action=${result.judge.action} target=${result.judge.targetId ?? '-'}`)
          } else if (verdict) {
            log(`[whale-memory] judge fallback reason=${result?.judge?.error || verdict.error || 'unknown'}`)
          }
          const payload = JSON.stringify({
            ...event,
            result: { action: result.action, id: result.id ?? null, ...(result.judge ? { judge: result.judge } : {}) },
          })
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
   * accept：读 writes.payload 还原等级/类型/tags/source/expired_at，并按 shadowOf 执行动作
   *   （ADD/REVIEW 插新节点，MERGE 改目标正文，SUPERSEDE 插新节点并让旧节点失效）；
   *   origin 固定 'shadow-review'（审核来源可追溯，原事件 origin 仍在 payload 里）。
   * reject：审计行改 REJECT，reason 追加 review:reject[:理由]。
   *
   * @param {number|string} id writes 行 id
   * @param {'accept'|'reject'} decision
   * @param {string} [reason] 驳回理由（≤200 由路由截断）
   * @returns {{ ok: boolean, id?: string, error?: string }}
   */
  function review(id, decision, reason) {
    const action = String(decision ?? '')
    if (action !== 'accept' && action !== 'reject') return { ok: false, error: 'invalid_decision' }
    const writeId = Number(id)
    if (!Number.isInteger(writeId)) return { ok: false, error: 'candidate_not_found' }
    try {
      return onDb((db) => {
        const row = db.prepare(
          "SELECT id,trace_id,action,reason,after_text,mode,payload,user_id,role_id,workspace FROM writes WHERE id=? AND action='CANDIDATE'",
        ).get(writeId)
        if (!row) return { ok: false, error: 'candidate_not_found' }

        if (action === 'reject') {
          const extra = `review:reject${reason ? ':' + String(reason) : ''}`
          const previous = String(row.reason ?? '').trim()
          db.prepare("UPDATE writes SET action='REJECT', reason=? WHERE id=?")
            .run(previous ? `${previous} · ${extra}` : extra, writeId)
          return { ok: true }
        }

        let payload = {}
        try { payload = JSON.parse(String(row.payload ?? '{}')) || {} } catch { payload = {} }
        const text = normalize(String(row.after_text ?? ''))
        if (!text || text.length > TEXT_LIMIT) return { ok: false, error: 'invalid_text' }
        return withTx(db, () => acceptCandidate(db, row, text, payload, String(payload.shadowOf || 'ADD'), writeId))
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
