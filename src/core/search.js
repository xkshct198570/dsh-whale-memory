/**
 * 本地检索（L2 机制层，S2 MVP）：候选三级 + 两段式打分。
 *
 * 硬约束（架构书 §5.2，不可调）：
 * - 每一路 FTS 必须 `LIMIT 50`；单次检索候选总量 `MAX_CANDIDATES=150`；排序只在候选集上算。
 * - 空查询 / minLenOk=false / 纯符号 → 直接空结果，绝不 LIKE、绝不无 LIMIT 扫表。
 * - 身份过滤：传入非空 userId/roleId/workspace ⇒ `(列='' OR 列=值)`；不传 ⇒ 全见。
 * - L3 向量在 S2 关闭（vec 恒 0，未向量化节点不惩罚）。
 *
 * 打分（v2 口径移植）：
 *   rel      = min(1, Σ命中权重 / min(termCount,4))，termCount 为去重后的词项数
 *   权重      ident/IP 1.5、ascii 1.2、cjk 1.0、negation 1.2
 *   effWeight = LEVEL(core10/important3/normal1) × SOURCE(owner1.0/self0.8/group0.6/web0.5/
 *               tool0.5/import0.7) × TYPE(procedural1.2/semantic1/episodic0.9/mixed1) × 0.5^(ageDays/90)
 *   gain      = 0.5 + 0.5 × log2(1+min(effWeight,12)) / log2(13)
 *   score     = rel × mult × gain，intent 与 memory_type 一致时 mult=1.5
 * 只有 rel >= minRel 才保留；被门挡掉的候选计入 below_min_n（面板要看得见）。
 */
import { buildPlan } from './queryplan.js'
import { normalize } from './tokenize.js'
import { now } from './db.js'
import { HOP_FACTOR, clamp01, expandOneHop } from './relations.js'

const FTS_LIMIT = 50
const MAX_CANDIDATES = 150
const MIN_REL_DEFAULT = 0.34

const W = { ident: 1.5, ip: 1.5, ascii: 1.2, cjk: 1.0, negation: 1.2 }
const LEVEL = { core: 10, important: 3, normal: 1 }
const SOURCE = { owner: 1.0, self: 0.8, group: 0.6, web: 0.5, tool: 0.5, import: 0.7 }
const TYPE = { procedural: 1.2, semantic: 1.0, episodic: 0.9, mixed: 1.0 }

const LOG2_13 = Math.log2(13)

/** @param {number} started @returns {object} */
function emptyResult(started) {
  return { hits: [], count: 0, below_min_n: 0, elapsed_ms: Math.max(0, Date.now() - started) }
}

/** @param {string} text 原样（含空格/大小写）→ FTS5 短语 */
function phrase(text) {
  return `"${String(text).replace(/"/g, '""')}"`
}

/** @param {string[]} terms @returns {string} */
function orMatch(terms) {
  return terms.map(phrase).join(' OR ')
}

/** @param {string[]} values @returns {string[]} */
function dedupe(values) {
  const out = []
  for (const v of values) if (v && !out.includes(v)) out.push(v)
  return out
}

/**
 * 身份过滤条件（只对传入的非空字段生效）。
 * @param {{ userId?: string, roleId?: string, workspace?: string } | null | undefined} identity
 * @returns {{ sql: string, params: string[] }}
 */
function identityFilter(identity) {
  const clauses = []
  const params = []
  for (const [col, value] of [
    ['user_id', identity?.userId],
    ['role_id', identity?.roleId],
    ['workspace', identity?.workspace],
  ]) {
    const v = typeof value === 'string' ? value : String(value ?? '')
    if (!v) continue
    clauses.push(`(n.${col} = '' OR n.${col} = ?)`)
    params.push(v)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params }
}

/**
 * 跑一路 FTS（固定 LIMIT 50），把候选按 id 去重并入 map。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'nodes_fts'|'nodes_fts_bi'} table
 * @param {string} match
 * @param {{ sql: string, params: string[] }} filter
 * @param {Map<string, any>} candidates
 */
function collectFts(db, table, match, filter, candidates, path = 'L1') {
  if (!match || candidates.size >= MAX_CANDIDATES) return
  const sql =
    `SELECT n.id, n.text, n.level, n.memory_type, n.source, n.created_at, n.last_hit_at, n.context_note ` +
    `FROM ${table} JOIN nodes n ON n.rowid = ${table}.rowid ` +
    `WHERE ${table} MATCH ? AND n.status = 'active'${filter.sql} ` +
    `ORDER BY rank LIMIT ${FTS_LIMIT}`
  let rows
  try {
    rows = db.prepare(sql).all(match, ...filter.params)
  } catch {
    return // FTS 语法/库结构异常一律 fail-open（检索不能拖垮对话）
  }
  for (const row of rows) {
    if (candidates.size >= MAX_CANDIDATES) return
    if (!candidates.has(row.id)) candidates.set(row.id, { ...row, _path: path })
  }
}

/**
 * 打分词项：按文本去重、取最大权重（同一文本既是 ascii 又是 ident 时只算一次）。
 * 注意：cjkGrams 只用于 L2 候选召回，不参与 rel 分母（分母口径 = cjkTerms+asciiTerms+idents+ips+negations）。
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {{ text: string, weight: number }[]}
 */
function scoreTerms(plan) {
  const map = new Map()
  const add = (text, weight) => {
    if (!text) return
    const key = String(text)
    const prev = map.get(key)
    if (!prev || prev.weight < weight) map.set(key, { text: key, weight })
  }
  for (const t of plan.cjkTerms) add(t, W.cjk)
  for (const t of plan.asciiTerms) add(t, W.ascii)
  for (const t of plan.idents) add(t, W.ident)
  for (const t of plan.ips) add(t, W.ip)
  for (const t of plan.negations) add(t, W.negation)
  return [...map.values()]
}

/** @param {string} level @returns {number} */
function levelRank(level) {
  return LEVEL[level] ?? LEVEL.normal
}

/**
 * 本地检索。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   query: string, limit?: number,
 *   identity?: { userId?: string, roleId?: string, workspace?: string },
 *   minRel?: number
 * }} opts
 */
export function search(db, opts = {}) {
  const started = Date.now()
  if (!db || typeof db.prepare !== 'function') return emptyResult(started)

  const { query } = opts
  const plan = buildPlan(query)
  if (!plan.minLenOk) return emptyResult(started)

  const limitRaw = Number(opts.limit ?? 5)
  const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.min(FTS_LIMIT, Math.floor(limitRaw))) : 5
  const minRelRaw = Number(opts.minRel ?? MIN_REL_DEFAULT)
  const minRel = Number.isFinite(minRelRaw) ? Math.max(0, Math.min(1, minRelRaw)) : MIN_REL_DEFAULT

  const terms = scoreTerms(plan)
  if (terms.length === 0) return emptyResult(started)

  const filter = identityFilter(opts.identity)
  const candidates = new Map()

  // L1：≥3 字的整词/标识符/IP 短语 OR（trigram）。
  const l1Terms = dedupe([...plan.cjkTerms, ...plan.asciiTerms, ...plan.idents, ...plan.ips])
    .filter((t) => t.length >= 3)
  collectFts(db, 'nodes_fts', orMatch(l1Terms), filter, candidates, 'L1')

  // L2：L1 候选不足时才兜底（中文 bigram + ASCII trigram）；候选已够不浪费查询。
  if (candidates.size < limit || candidates.size === 0) {
    collectFts(db, 'nodes_fts_bi', orMatch(plan.cjkGrams), filter, candidates, 'L2')
    const l2Ascii = dedupe([...plan.asciiTerms, ...plan.idents]).filter((t) => t.length >= 3)
    collectFts(db, 'nodes_fts', orMatch(l2Ascii), filter, candidates, 'L2')
  }

  const nowSec = now()
  const denominator = Math.min(terms.length, 4)
  const hits = []
  let below = 0

  for (const row of candidates.values()) {
    const haystack = normalize(row.text)
    let sum = 0
    const matched = []
    for (const term of terms) {
      if (!haystack.includes(term.text)) continue
      sum += term.weight
      if (matched.length < 8) matched.push(term.text)
    }
    const rel = denominator > 0 ? Math.min(1, sum / denominator) : 0
    if (rel < minRel) {
      below += 1
      continue
    }

    const level = levelRank(row.level)
    const source = SOURCE[row.source] ?? 0.5
    const type = TYPE[row.memory_type] ?? 1
    const ageDays = Math.max(0, (nowSec - Number(row.created_at || 0)) / 86400)
    const decay = Math.pow(0.5, ageDays / 90)
    // context_note 只做检索加权（+5%），永不进注入正文（架构书 §7.2）。
    const noteBoost = String(row.context_note || '') ? 1.05 : 1
    const effWeight = level * source * type * decay * noteBoost
    const gain = 0.5 + (0.5 * Math.log2(1 + Math.min(effWeight, 12))) / LOG2_13
    const mult = plan.intent && plan.intent === row.memory_type ? 1.5 : 1
    const score = rel * mult * gain

    hits.push({
      id: row.id,
      text: row.text,
      level: row.level,
      type: row.memory_type,
      source: row.source,
      score,
      rel,
      components: { rel, mult, gain, effWeight, vec: 0, path: String(row._path || 'L1'), matched },
      // 排序辅助，不返回
      _lastHitAt: Number(row.last_hit_at ?? 0),
    })
  }

  // 1 跳扩散（架构书 §7.1）：只从 top-3 种子沿 topic/reference 边扩，
  // 每跳 ×0.6 且再乘边置信 conf（minConf 由 expandOneHop 的 SQL 过滤）；
  // mutex/supersede 不参与（expandOneHop 的 SQL 已按 etype 过滤）。
  const seen = new Set(hits.map((h) => h.id))
  const relBySeed = new Map(hits.slice(0, 3).map((h) => [h.id, h.rel]))
  if (opts.diffusion !== false && hits.length > 0) {
    for (const row of expandOneHop(db, {
      seeds: hits.slice(0, 3),
      identity: opts.identity,
      minConf: opts.minConf,
      cap: 20,
    })) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      // 边的方向不固定：via 是种子那一端，另一头才是扩散命中。
      const fromId = String(row.from_id)
      const toId = String(row.to_id)
      const viaSeed = relBySeed.has(fromId) ? fromId : toId
      const seedRel = relBySeed.get(viaSeed) ?? 0
      // 扩散分 = 种子分 × 每跳衰减 × 边置信：低置信边不该和 1.0 边一样响。
      const viaConf = clamp01(row.via_conf)
      const rel = Math.min(1, seedRel * HOP_FACTOR * viaConf)
      if (rel < minRel) { below += 1; continue }
      const level = levelRank(row.level)
      const source = SOURCE[row.source] ?? 0.5
      const type = TYPE[row.memory_type] ?? 1
      const ageDays = Math.max(0, (nowSec - Number(row.created_at || 0)) / 86400)
      const decay = Math.pow(0.5, ageDays / 90)
      const effWeight = level * source * type * decay
      const gain = 0.5 + (0.5 * Math.log2(1 + Math.min(effWeight, 12))) / LOG2_13
      const mult = plan.intent && plan.intent === row.memory_type ? 1.5 : 1
      hits.push({
        id: row.id,
        text: row.text,
        level: row.level,
        type: row.memory_type,
        source: row.source,
        score: rel * mult * gain,
        rel,
        components: {
          rel, mult, gain, effWeight, vec: 0,
          path: 'diffusion', hops: 1, via: viaSeed, conf: viaConf,
        },
        _lastHitAt: Number(row.last_hit_at ?? 0),
      })
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      levelRank(b.level) - levelRank(a.level) ||
      b._lastHitAt - a._lastHitAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const top = hits.slice(0, limit).map(({ _lastHitAt, ...hit }) => hit)
  return {
    hits: top,
    count: top.length,
    below_min_n: below,
    elapsed_ms: Math.max(0, Date.now() - started),
  }
}
