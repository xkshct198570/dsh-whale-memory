// 职责：候选/规则判定与判定器（槽位/矛盾/时间重叠/候选/decideWrite）及写入字段映射；
// 依赖：../../shared/config-values.js + ../db.js + ../tokenize.js + ./privacy.js；不 import 门面。
import { value } from '../../shared/config-values.js'
import { now } from '../db.js'
import { bagKey, contentHash, normalize, similarity } from '../tokenize.js'
import { insideSpans, privacyCheck, sentenceHasPortHint, spansOf } from './privacy.js'

/** 冲突/合并候选上限（单身份）。 */
const CANDIDATE_LIMIT = 300
/** MERGE 相似度下限（信息只增不减的“近文”合并）。 */
const MERGE_SIM = 0.85
/** 近文合并的信息增益：新文本比旧文本至少多这么多字。 */
const MERGE_GROWTH = 8
/** 包含合并的旧文最短长度：太短的旧文被新文包住不算“信息增益”（§5.3 第 4 条）。 */
const MERGE_CONTAIN_MIN = 8
/** 疑似改写（无增益）的相似度下限：只转审核，不自动合并。 */
const PARA_SIM = 0.7
/** 冲突判定（否定/槽位）的最低相似度。 */
const CONFLICT_SIM = 0.3
/** 会真正落 nodes 的动作；影子模式下它们统一降级为 CANDIDATE。 */
const LANDING = new Set(['ADD', 'MERGE', 'SUPERSEDE', 'REVIEW'])

/** 来源可信度等级（架构书 §6.3）：owner > self > group > web/tool > import；未知来源最低。 */
const SOURCE_RANK = { owner: 5, self: 4, group: 3, web: 2, tool: 2, import: 1 }

/** 单条写入文本硬顶（与 nodes.text CHECK 同值）。 */
export const TEXT_LIMIT = 500

const LEVELS = new Set(['core', 'important', 'normal'])
const MEMORY_TYPES = new Set(['semantic', 'procedural', 'episodic', 'mixed'])
/** 分层标签（v7）合法值：DB 无 CHECK，写入层白名单是唯一保证。 */
const LAYERS = new Set(['fact', 'lesson', 'user'])
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

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g
const VERSION_RE = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?)(?![\w.])/g
const PATH_RE = /\/[\w.\-/]{3,}/g
const NUMBER_RE = /\b\d{2,5}\b/g

/** 空值（null/undefined/空串）不能走 Number()：Number(null)===0 会把"没有时间"当成"时间 0"。 */
export function isBlank(value) {
  return value === null || value === undefined || value === ''
}

/**
 * 来源可信度（用于同文去重时的 source 升级判定）。
 * @param {unknown} source nodes.source 值
 * @returns {number} 等级（越大越可信）；未知来源 0
 */
export function sourceRank(source) {
  return SOURCE_RANK[String(source ?? '')] ?? 0
}

/** @param {unknown} value @param {number} fallback @returns {number} */
export function finite(value, fallback) {
  if (isBlank(value)) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 时间戳读取：缺失返回 null（而不是 0）。 @param {unknown} value */
export function timeOrNull(value) {
  if (isBlank(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 事件身份归一（缺列一律 ''，与 schema 默认一致）。
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @returns {{ userId: string, roleId: string, workspace: string }}
 */
export function normalizeIdentity(identity) {
  const i = identity || {}
  return {
    userId: String(i.userId ?? ''),
    roleId: String(i.roleId ?? ''),
    workspace: String(i.workspace ?? ''),
  }
}

/** 当日 00:00（本地时区）的秒级时间戳。 @param {number} tsSeconds */
export function startOfDay(tsSeconds) {
  const d = new Date(tsSeconds * 1000)
  d.setHours(0, 0, 0, 0)
  return d.getTime() / 1000
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
export function resolveOptions(opts) {
  const o = value(opts) || {}
  return {
    mode: value(o.mode) === 'auto' ? 'auto' : 'shadow',
    maxChars: Math.max(1, Math.min(TEXT_LIMIT, finite(value(o.maxChars), TEXT_LIMIT))),
    dailyCap: Math.max(0, Math.floor(finite(value(o.dailyCap), 200))),
    protect: value(o.protect) !== false,
    redact: value(o.redact) !== false,
    // auto 模式下 REVIEW 不落 active，转人工审核候选（架构书 B1/§5.1 第 6 条）。
    reviewToCandidate: value(o.reviewToCandidate) === true,
    // 忽略规则：面板每行一条正则；只做「不进库」判定，不参与合并/去重。
    ignorePatterns: Array.isArray(o.ignorePatterns)
      ? o.ignorePatterns.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [],
  }
}

/**
 * 给 decision 补 mode。
 * - shadow：落库动作统一降级为 CANDIDATE（=0.7.3 行为，候选按原动作审核落库）；
 * - auto + reviewToCandidate：REVIEW 不落 active，转 CANDIDATE 且 shadowOf='REVIEW'，
 *   accept 时按 REVIEW 语义建互斥边（否则自动入库会把“同词不同义”静默写成普通新增）。
 */
export function settle(decision, opts, { text = '', redacted = false } = {}) {
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
  if (opts.mode === 'auto' && opts.reviewToCandidate === true && base.action === 'REVIEW') {
    return {
      ...base,
      action: 'CANDIDATE',
      reason: [`review:${base.action}`, reason].filter(Boolean).join(' · '),
      afterText: text,
      mode: 'auto',
      shadowOf: 'REVIEW',
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
export function isProtectedTarget(row, options) {
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

  // 1.5 忽略规则：命中任一正则即不进库（仍写审计 REJECT/ignored，不静默丢弃）。
  // 坏正则只跳过这一条：一条写错的规则不能挡住全部写入。
  for (const pattern of options.ignorePatterns) {
    try {
      if (new RegExp(pattern).test(original)) {
        return { action: 'REJECT', reason: 'ignored', mode: options.mode }
      }
    } catch { /* 非法正则：跳过，不阻断写入 */ }
  }

  // 2. 隐私：默认脱敏后继续，严格入口直接拒绝
  const privacy = privacyCheck(original, { redact: options.redact })
  if (!privacy.ok) return { action: 'REJECT', reason: privacy.reason || 'privacy', mode: options.mode }
  const text = normalize(privacy.text)
  if (!text) return { action: 'REJECT', reason: 'invalid_text', mode: options.mode }
  const redacted = privacy.reason === 'privacy_redacted'

  // 3. 当日配额（NOOP/REJECT 不占额度：它们没有产生新事实；SPLIT 是导入迁移记账，不算当日新增）
  // 只数“改变长期记忆”的动作：ADD/MERGE/SUPERSEDE；面板 EDIT、人工 ARCHIVE、巩固 CONSOLIDATE、
  // 影子 CANDIDATE/REVIEW 都不产生新事实，旧口径把它们也计入会把当日新写入提前挡死（审计 P2-F3）。
  const since = startOfDay(now())
  const used = Number(db.prepare(
    "SELECT count(*) AS n FROM writes WHERE ts>=? AND user_id=? AND role_id=? AND workspace=? AND action IN ('ADD','MERGE','SUPERSEDE')",
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
  // 规则镜像是实现行（origin=rule:*），不是用户事实：同文也不得把用户写入判成重复。
  const dup = db.prepare(
    `SELECT id,text,source FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=?
      AND status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%') LIMIT 1`,
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
  const incomingBag = bagKey(text)
  const validAt = now()

  // 6. 同身份判重（§5.3 固定顺序）：
  //    字符袋相同/语序 → 矛盾 → 包含 MERGE → 近文 REVIEW → 疑似改写 REVIEW。
  //    一次遍历收集各分支的最佳候选，再按顺序裁决；语义同义自动合并留 0.8.1。
  let bagSame = null
  let mergeRow = null
  let mergeScore = 0
  let mergeByContains = false
  let nearRow = null
  let nearScore = 0
  let paraRow = null
  let paraScore = 0
  let conflictRow = null
  let conflictScore = 0
  let conflictKind = null
  for (const row of candidates) {
    const oldText = String(row.text ?? '')
    if (!oldText) continue
    // 6.1 字符袋相同但 hash 不同：语序/极性可能反转（相似度可到 1.0），只转审核。
    if (bagKey(oldText) === incomingBag) { bagSame = row; break }
    const sim = similarity(text, oldText)
    // 6.2 矛盾先行：包含/近文都不得覆盖“否定/槽位相反”的事实。
    if (sim >= CONFLICT_SIM && timeOverlap(row, { valid_at: validAt }) === 'overlap') {
      const kind = contradiction(row, text)
      if (kind && sim > conflictScore) { conflictRow = row; conflictScore = sim; conflictKind = kind }
    }
    // 6.3 包含：新文完整包含旧文且旧文 ≥8 字 → 信息只增不减，不受 0.85 相似度限制。
    if (oldText.length >= MERGE_CONTAIN_MIN && text.includes(oldText)) {
      if (sim > mergeScore) { mergeRow = row; mergeScore = sim; mergeByContains = true }
      continue
    }
    const gains = text.length - oldText.length >= MERGE_GROWTH
    if (sim >= MERGE_SIM) {
      // 6.4 近文且有增益（旧口径的相似合并）；无增益转审核，不静默合并。
      if (gains) {
        if (sim > mergeScore) { mergeRow = row; mergeScore = sim; mergeByContains = false }
      } else if (sim > nearScore) { nearRow = row; nearScore = sim }
      continue
    }
    // 6.5 疑似改写且无增益：只转审核（语义同义判重不在本轮承诺）。
    if (sim >= PARA_SIM && !gains && sim > paraScore) { paraRow = row; paraScore = sim }
  }

  // 顺序 1：同字符袋 → REVIEW（语序/极性歧义；绝不 NOOP、绝不 MERGE）。
  if (bagSame) {
    const targetId = String(bagSame.id)
    return settle({
      action: 'REVIEW',
      reason: 'word_order_ambiguous',
      targetId,
      beforeText: String(bagSame.text ?? ''),
      afterText: text,
    }, options, { text, redacted })
  }

  // 顺序 2：矛盾（否定/槽位）——计划句延后、保护面转审核、否则取代。
  if (conflictRow) {
    const targetId = String(conflictRow.id)
    const beforeText = String(conflictRow.text ?? '')
    // 计划/承诺还没落地，不得取代已落地事实
    if (PLAN_WORDS.test(text)) {
      return settle({ action: 'ADD', reason: 'plan_deferred', targetId, beforeText, afterText: text }, options, { text, redacted })
    }
    if (isProtectedTarget(conflictRow, options)) {
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

  // 顺序 3：包含/近文合并——保护面不得被自动改写，改走 REVIEW。
  if (mergeRow) {
    const targetId = String(mergeRow.id)
    const beforeText = String(mergeRow.text ?? '')
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
      reason: mergeByContains ? 'merge_contains' : 'merge_similar',
      targetId,
      beforeText,
      afterText: text,
    }, options, { text, redacted })
  }

  // 顺序 4：近文无增益 → 审核；疑似改写无增益 → 审核（都不落 active）。
  if (nearRow) {
    return settle({
      action: 'REVIEW',
      reason: 'near_duplicate',
      targetId: String(nearRow.id),
      beforeText: String(nearRow.text ?? ''),
      afterText: text,
    }, options, { text, redacted })
  }
  if (paraRow) {
    return settle({
      action: 'REVIEW',
      reason: 'possible_paraphrase',
      targetId: String(paraRow.id),
      beforeText: String(paraRow.text ?? ''),
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
  const plainOpts = value(opts) || {}
  const verdict = value(plainOpts.judgeVerdict ?? event?.__judgeVerdict)
  const base = decideByRules(db, event, opts)
  if (!verdict) return base
  if (base.action === 'REJECT') return { ...base, judge: { used: false, error: 'judge_fallback:rejected' } }
  if (value(verdict)?.ok !== true) {
    const why = String(value(verdict)?.error || 'invalid_verdict')
    return { ...base, judge: { used: false, error: why } }
  }
  const options = resolveOptions(opts)
  const applied = judgeDecision(db, event, value(verdict), options, base)
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

/** 事件来源 → 合法 nodes.source。 */
export function mapSource(source) {
  return SOURCE_MAP[String(source ?? '')] || 'self'
}

/** 合法 level（非法值降级 normal，写入路径不因脏参数失败）。 */
export function validLevel(level) {
  const v = String(level ?? '')
  return LEVELS.has(v) ? v : 'normal'
}

/** 合法 memory_type。 */
export function validMemoryType(type) {
  const v = String(type ?? '')
  return MEMORY_TYPES.has(v) ? v : 'semantic'
}

/**
 * 分层标签（v7）：只允许 fact/lesson/user，其余（含缺省/旧调用方/脏导入）一律 NULL。
 *
 * 为什么不在 DB 加 CHECK：老库走 ALTER TABLE 加不了 CHECK；且未知值的语义是"未分层"
 * （读路径按 NULL 处理），用写入层白名单 + 读路径 IN 三值同样安全，且迁移不需要重建表。
 *
 * @param {unknown} layer
 * @returns {'fact'|'lesson'|'user'|null}
 */
export function validLayer(layer) {
  const v = String(layer ?? '')
  return LAYERS.has(v) ? v : null
}

/** expired_at：只在显式传入有限正数时落库。 */
export function validExpiredAt(value) {
  if (isBlank(value)) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}
