/**
 * MemoryBackend（S2）：LocalSqliteBackend 为默认真源；HttpBackend 保留给外部服务。
 *
 * 主线程零大批量检索：search/recall 走 DbWorkerClient（worker_threads，1200ms 超时）；
 * 写入/导入/导出仍在主线程短事务（≤20/批），因为写需要单写者一致性。
 * 所有失败 fail-open：检索失败返回 null/空结果，不阻塞对话。
 *
 * 两条硬口径（Why）：
 * - 配置来自 schemastery，`write.enabled` 是 Ref；不 `get()` 就直接判 `=== false` 恒假，
 *   "关写"开关等于没有。这里统一解包后再判（core 不 import host，故本地实现 plain()）。
 * - 导入/导出必须保真：状态（superseded/archived/stale）、双时态（valid_at/invalid_at/expired_at/
 *   superseded_by）、命中统计与向量态都要往返；否则 export→import 会把已失效事实"复活"。
 *   导入事务末尾还要用 nodes 与两张 FTS 的行数闸门证明索引没有写坏。
 */
import { closeDb, getMeta, now, openDb, setMeta } from './db.js'
import { bigrams, contentHash, normalize } from './tokenize.js'
import { search as searchDb, ftsStats } from './search.js'
import { planBudget, trimHits } from './budget.js'
import { applyNeighborNotes, relationStats } from './relations.js'
import { computeMetrics } from './metrics.js'
import { memoryPressure } from '../host/memory-guard.js'
import { bool } from '../host/config-values.js'
import { createWriteQueue, isActiveHashConflict, recordEvolution, recordWrite, withTx } from './writer.js'
import { DbWorkerClient } from './workers/client.js'
import { HybridBackend } from './hybrid.js'

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

const NODE_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'pinned', 'hits', 'last_hit_at', 'vector_state',
  'created_at', 'updated_at', 'valid_at', 'invalid_at', 'expired_at', 'superseded_by',
  'origin', 'trace_id', 'text_hash',
]

/** 导入字段白名单（非法枚举回落默认，避免把 export 的脏值写进 CHECK 约束）。 */
const NODE_STATUS = new Set(['active', 'archived', 'superseded', 'stale'])
const NODE_LEVELS = new Set(['core', 'important', 'normal'])
const NODE_TYPES = new Set(['semantic', 'procedural', 'episodic', 'mixed'])
const NODE_SOURCES = new Set(['owner', 'self', 'group', 'web', 'tool', 'import'])
const VECTOR_STATES = new Set(['none', 'pending', 'ready', 'failed'])

/** 文本硬顶（与 nodes.text CHECK 同值）。 */
const TEXT_LIMIT = 500
/** 规则边界：行首 "1." / "1、" / "1)" 或 【标题】行（导入长文本拆分用）。 */
const RULE_BOUNDARY = /^\s*(?:\d+\s*[.、)]|【[^】]*】)/
/** 导入失败明细上限（返回体不塞全文，只给序号/原因/哈希前缀）。 */
const ERROR_DETAIL_LIMIT = 20

/**
 * 导入 INSERT：显式列出全部可保真字段（v1 导入写死 active/''/1/0/none 会让
 * superseded/archived/stale 在 export→import 后复活）。
 * v3 起补 `pinned`：规则置顶是节点属性，导出/导入必须往返（旧 JSONL 缺列按 0）。
 */
const IMPORT_INSERT_SQL = `INSERT INTO nodes
  (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
   context_note,weight,pinned,hits,last_hit_at,vector_state,origin,trace_id,valid_at,invalid_at,expired_at,
   superseded_by,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

/** 枚举回落。 @param {unknown} value @param {Set<string>} allowed @param {string} fallback */
function pickEnum(value, allowed, fallback) {
  const v = String(value ?? '')
  return allowed.has(v) ? v : fallback
}

/**
 * schemastery Ref 解包：`.volatile()` 字段 `get()` 才是值。
 * 不 import host（分层约束），在 core 内做同一口径。
 * @param {unknown} value
 * @returns {unknown}
 */
function plain(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/** 数值回落（空值/null 不参与 Number，避免 Number(null)===0 的假值）。 */
function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 时间戳兜底：缺失/非法返回 null（不能返回 0，0 会让双时态判断产生假"已失效"）。 */
function timeOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * hit_ids 解析成命中条数。
 * 审计表是历史数据，手工修过/旧版本写坏的行解析失败按 0 计，不能因为一行脏数据让面板整页挂。
 * @param {unknown} raw hit_ids 列原文（JSON 数组字符串）
 * @returns {number}
 */
function hitIdsCount(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/**
 * 导出身份过滤：与 search 同口径 `(列='' OR 列=?)`，空身份字段不过滤。
 * 为什么导出也要过滤：导出文件会被拿去推送/外传，不带身份条件等于跨分区泄漏。
 *
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @returns {{ sql: string, params: string[] }}
 */
function identityFilter(identity) {
  const clauses = []
  const params = []
  for (const [col, raw] of [
    ['user_id', identity?.userId],
    ['role_id', identity?.roleId],
    ['workspace', identity?.workspace],
  ]) {
    const value = typeof raw === 'string' ? raw : String(raw ?? '')
    if (!value) continue
    clauses.push(`(${col} = '' OR ${col} = ?)`)
    params.push(value)
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * 完整 WHERE：身份条件 + 额外条件（全部 AND）。列名属于 nodes 表本身（不做别名）。
 *
 * why 不直接拼字符串：身份条件是安全闸，额外条件（id/action/source）是业务过滤，
 * 两者混写时最容易漏参数占位，导致"查询全表"这种静默越权。
 *
 * @param {Identity|null|undefined} identity
 * @param {Array<[string, unknown[]]>} [extra] 每项 `[SQL 片段, 参数数组]`
 * @returns {{ sql: string, params: string[] }}
 */
function whereOf(identity, extra = []) {
  const filter = identityFilter(identity)
  const parts = []
  const params = []
  if (filter.sql) {
    parts.push(filter.sql.slice(' WHERE '.length))
    params.push(...filter.params)
  }
  for (const [sql, args] of extra) {
    parts.push(sql)
    params.push(...(args || []))
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
}

/** edges/evolution 的双端可见条件：两端都在可见集合内才算本分区的边/演化。
 * @param {Identity|null|undefined} identity
 * @returns {{ sql: string, params: string[], active: boolean }}
 */
function bothEndsVisible(identity) {
  const filter = identityFilter(identity)
  if (!filter.sql) return { sql: '', params: [], active: false }
  const vis = `SELECT id FROM nodes${filter.sql}`
  return {
    sql: `(from_id IN (${vis}) AND to_id IN (${vis}))`,
    params: [...filter.params, ...filter.params],
    active: true,
  }
}

/**
 * 长文本按规则边界拆分。
 *
 * 为什么在导入时拆：>500 字直接丢弃等于静默丢数据，而"多条规则挤成一行"是最常见的导入形态，
 * 按行首编号/【标题】切段就能无损落库；切不出来（单条超长规则）才拒绝。
 *
 * @param {string} raw 原始文本（拆分必须在 normalize 前做，normalize 会压缩换行）
 * @returns {string[] | null} 每段 normalize 后 ≤500 且段数 ≥2；否则 null
 */
function splitLongText(raw) {
  const starts = []
  let offset = 0
  for (const line of raw.split('\n')) {
    if (RULE_BOUNDARY.test(line)) starts.push(offset)
    offset += line.length + 1
  }
  if (starts.length < 2) return null
  const points = [0]
  for (const at of starts) if (at > 0 && !points.includes(at)) points.push(at)
  const segments = []
  for (let i = 0; i < points.length; i += 1) {
    const end = i + 1 < points.length ? points[i + 1] : raw.length
    const segment = normalize(raw.slice(points[i], end))
    if (!segment) continue
    if (segment.length > TEXT_LIMIT) return null
    segments.push(segment)
  }
  return segments.length >= 2 ? segments : null
}

/** 组装一条导入节点行（字段全部已回落/校验）。 */
function importNodeRow(base, id, text, tags) {
  return {
    ...base,
    id,
    text,
    text_hash: contentHash(text),
    text_bigrams: bigrams(text),
    tags: JSON.stringify(Array.isArray(tags) ? tags : []),
  }
}

/**
 * 单行导入 → 落库计划（同步/异步共用）。
 *
 * @param {object} row JSONL 行对象
 * @param {{ userId?: string, roleId?: string, workspace?: string }} identity 调用方身份（行内字段优先）
 * @param {{ ts: number, seq: number }} opts ts=当前时间兜底；seq=行序号（生成 id 保证唯一）
 * @returns {{ kind: 'error', reason: string, textHash: string } | { kind: 'rows', rows: object[], split?: boolean }}
 */
function planImportRows(row, identity, { ts, seq }) {
  const raw = String(row?.text ?? '')
  const text = normalize(raw)
  if (!text) return { kind: 'error', reason: 'invalid_text', textHash: contentHash(raw) }

  const base = {
    role_id: String(row?.role_id ?? identity?.roleId ?? ''),
    user_id: String(row?.user_id ?? identity?.userId ?? ''),
    workspace: String(row?.workspace ?? identity?.workspace ?? ''),
    level: pickEnum(row?.level, NODE_LEVELS, 'normal'),
    memory_type: pickEnum(row?.memory_type, NODE_TYPES, 'semantic'),
    source: pickEnum(row?.source, NODE_SOURCES, 'import'),
    status: pickEnum(row?.status, NODE_STATUS, 'active'),
    context_note: String(row?.context_note ?? '').slice(0, 200),
    weight: finiteOr(row?.weight, 1),
    // v3：置顶只接受 1/true；旧 JSONL 缺列按 0（不因导入把候选/事实意外顶上去）。
    pinned: row?.pinned === 1 || row?.pinned === true ? 1 : 0,
    hits: Math.max(0, Math.floor(finiteOr(row?.hits, 0))),
    last_hit_at: timeOrNull(row?.last_hit_at),
    vector_state: pickEnum(row?.vector_state, VECTOR_STATES, 'none'),
    origin: String(row?.origin ?? '') || 'import',
    trace_id: String(row?.trace_id ?? ''),
    valid_at: timeOrNull(row?.valid_at),
    invalid_at: timeOrNull(row?.invalid_at),
    expired_at: timeOrNull(row?.expired_at),
    superseded_by: row?.superseded_by === null || row?.superseded_by === undefined || row?.superseded_by === ''
      ? null
      : String(row.superseded_by),
    created_at: finiteOr(row?.created_at, ts),
    updated_at: finiteOr(row?.updated_at, ts),
  }
  const originId = String(row?.id ?? '')
  const pieces = text.length > TEXT_LIMIT ? splitLongText(raw) : null

  if (text.length > TEXT_LIMIT && !pieces) {
    return { kind: 'error', reason: 'too_long_single_rule', textHash: contentHash(raw) }
  }
  if (!pieces) {
    const id = originId || `n${Date.now()}_${contentHash(text).slice(0, 10)}_${seq}`
    return { kind: 'rows', rows: [importNodeRow(base, id, text, row?.tags)] }
  }

  // 拆分保真：每段 tags 追加 split_from:<原 id>，让检索/复盘能追回原条目。
  const splitFrom = originId || `import:${contentHash(raw).slice(0, 12)}`
  const tags = [...(Array.isArray(row?.tags) ? row.tags : []), `split_from:${splitFrom}`]
  const rows = pieces.map((piece, i) => {
    const id = originId
      ? `${originId}_s${i + 1}`
      : `n${Date.now()}_${contentHash(piece).slice(0, 10)}_${seq}_${i}`
    return importNodeRow(base, id, piece, tags)
  })
  return { kind: 'rows', rows, split: true }
}

/**
 * 导入事务末尾的 FTS 一致性闸。
 *
 * 先按契约比对 nodes 与两张 FTS 的行数；但外部内容表（content='nodes'）的 count(*)
 * 实际是扫内容表，触发器缺失时仍然相等，不能作为证据。真正的索引行数在 FTS5 的
 * shadow 表 `*_docsize` 里（每个入索引的文档一行），所以再用它证明"每个节点都进了索引"。
 * 任一不一致 → false（调用方 ROLLBACK 并返回 fts_misaligned）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
function ftsAligned(db) {
  const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
  const nodes = one('SELECT count(*) AS n FROM nodes')
  if (nodes !== one('SELECT count(*) AS n FROM nodes_fts')) return false
  if (nodes !== one('SELECT count(*) AS n FROM nodes_fts_bi')) return false
  try {
    if (nodes !== one('SELECT count(*) AS n FROM nodes_fts_docsize')) return false
    if (nodes !== one('SELECT count(*) AS n FROM nodes_fts_bi_docsize')) return false
  } catch {
    // 极端裁剪的 FTS5 构建可能没有 docsize：此时只能退回上面的内容表比对，不阻断导入。
    return true
  }
  return true
}

/**
 * 落库一批导入计划行（同步/异步共用）。
 *
 * 幂等键不限定 status：已存在 superseded/archived 节点再次导入也必须 skipped，
 * 否则 export→import 会把已失效事实"复活"成新 active 行。
 * 拆分段额外写 writes(action='SPLIT')，让"一行变多行"可复盘。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ node: object, split: boolean }>} items
 * @param {{ insert: any, exists: any, dryRun?: boolean }} io
 * @returns {{ added: number, skipped: number }}
 */
/** import 进度在 meta 的 key（小 JSON；避免每批重写 jobs.payload 里的 jsonl）。 */
function importProgressKey(jobId) {
  return `import_progress:${Number(jobId)}`
}

/** 进度形状：cursor + 计划书 §8.3 的全部统计字段。 */
function emptyImportProgress() {
  return {
    cursor: 0, added: 0, skipped: 0, errors: 0, kept: 0, split: 0, rejected: 0,
    reasons: {}, error_details: [],
  }
}

/** 读进度（缺失/坏 JSON 按初始值，不让坏 meta 阻断续跑）。 */
function readImportProgress(db, jobId) {
  const base = emptyImportProgress()
  const raw = getMeta(db, importProgressKey(jobId))
  if (!raw) return base
  try {
    const parsed = JSON.parse(raw)
    return {
      ...base,
      ...parsed,
      reasons: parsed && typeof parsed.reasons === 'object' && parsed.reasons ? parsed.reasons : {},
      error_details: Array.isArray(parsed?.error_details) ? parsed.error_details.slice(0, ERROR_DETAIL_LIMIT) : [],
    }
  } catch { return base }
}

/** 写进度 + job 状态（两条语句；崩溃在两者之间时进度落后于数据，但 exists 去重可安全重放）。 */
function saveImportProgress(db, jobId, progress, state, lastError) {
  progress.rejected = progress.errors
  setMeta(db, importProgressKey(jobId), JSON.stringify(progress))
  db.prepare('UPDATE jobs SET state=?, last_error=?, updated_at=? WHERE id=?')
    .run(state, lastError || null, now(), Number(jobId))
}

function landImportRows(db, items, { insert, exists, dryRun = false }) {
  let added = 0
  let skipped = 0
  for (const item of items) {
    const node = item.node
    if (exists.get(node.text_hash, node.user_id, node.role_id, node.workspace)) { skipped += 1; continue }
    if (!dryRun) {
      try {
        insert.run(
          node.id, node.text, node.text_hash, node.text_bigrams,
          node.level, node.memory_type, node.source, node.status,
          node.role_id, node.user_id, node.workspace, node.tags,
          node.context_note, node.weight, node.pinned, node.hits, node.last_hit_at,
          node.vector_state, node.origin, node.trace_id,
          node.valid_at, node.invalid_at, node.expired_at, node.superseded_by,
          node.created_at, node.updated_at,
        )
      } catch (err) {
        // 并发竞态：别的进程刚插了同文 → 索引拒绝；按“已存在”跳过，不让整批回滚/失败。
        if (isActiveHashConflict(err)) { skipped += 1; continue }
        throw err
      }
      if (item.split) {
        recordWrite(db, { identity: { userId: node.user_id, roleId: node.role_id, workspace: node.workspace } }, {
          action: 'SPLIT', reason: 'split_import', nodeId: node.id, afterText: node.text, mode: 'auto',
        })
      }
    }
    added += 1
  }
  return { added, skipped }
}

export class LocalBackend {
  /**
   * @param {{ dataDir?: string, useWorker?: boolean, log?: (s:string)=>void, timeoutMs?: number,
   *   config?: object|Function, getLlm?: () => any, getSelection?: () => object }} [opts]
   *   getLlm/getSelection：判定器（write.judge='llm'）用的模型入口，由 index.js 透传；
   *   缺省时队列按 rules 跑（单测/直连不需要宿主模型）。
   */
  constructor({ dataDir = '', useWorker = true, log = () => {}, timeoutMs = 1200, config = null, getLlm = null, getSelection = null } = {}) {
    this.dataDir = dataDir
    this.mode = 'local'
    this.log = log
    this.useWorker = useWorker !== false
    this.timeoutMs = timeoutMs
    this.db = null
    this.dbPath = ''
    this.worker = null
    this.closed = false
    // 判定器取模型是延迟的（每条事件才调一次 getter）：不持有 llm 实例，避免插件 dispose 后引用旧对象。
    this.getLlm = typeof getLlm === 'function' ? getLlm : null
    this.getSelection = typeof getSelection === 'function' ? getSelection : null
    // 写入决策要读实时配置（shadow/auto 面板可改），因此持 getter 而不是快照。
    // 无配置（单测/直连）默认 auto：旧行为不变；生产由 index.js 注入实时配置（默认 shadow）。
    this._config = config
      ? (typeof config === 'function' ? config : () => config)
      : () => ({ write: { reviewMode: 'auto' } })
    this.writeQueue = null
  }

  /**
   * 后端可用性：真探测能否拿到连接（打开/迁移失败即 false），不再恒 true。
   * 只在第一次调用时真开库，之后命中 this.db（连接缓存），不会每次 stats 都重开。
   */
  get ready() {
    try { this._db(); return true } catch { return false }
  }

  _db() {
    if (this.closed) throw new Error('backend_disposed')
    if (!this.db) {
      this.db = openDb(this.dataDir || undefined)
      this.dbPath = this.db.prepare('PRAGMA database_list').get()?.file || this.dbPath
      setMeta(this.db, 'boot_id', String(process.pid))
      const info = this.db.schemaInfo
      if (info?.deduped) this.log(`[whale-memory] schema v4 deduped ${info.deduped} duplicate active node(s)`)
      if (info && info.uniqueIndex === false) this.log('[whale-memory] unique hash index unavailable (dirty db kept running)')
      if (this.db.quarantine) this.log(`[whale-memory] corrupt db quarantined: ${this.db.quarantine.renamed.join(',') || this.db.quarantine.reason}`)
      if (this.db.quickCheckSkipped) this.log(`[whale-memory] quick_check skipped (transient): ${this.db.quickCheckSkipped}`)
    }
    return this.db
  }

  _worker() {
    if (!this.useWorker) return null
    if (this.closed) return null
    if (!this.worker) {
      try {
        this.worker = new DbWorkerClient({ timeoutMs: this.timeoutMs, log: this.log })
      } catch (err) {
        this.log(`[whale-memory] worker unavailable: ${err?.message || err}`)
        this.useWorker = false
        return null
      }
    }
    return this.worker
  }

  /**
   * S4 内部闸口：在同一写连接上跑同步片段（writer/keeper 的调度与审计用）。
   * 不给外部 HTTP 层使用；不做缓存、不建新连接，保持单写者语义。
   * @template T
   * @param {(db: import('node:sqlite').DatabaseSync) => T} fn
   * @returns {T}
   */
  withDb(fn) {
    if (typeof fn !== 'function') throw new TypeError('withDb: fn required')
    return fn(this._db())
  }

  /** 库文件绝对路径（诊断/日报用；未打开时为空）。 */
  get dbFile() {
    return this.dbPath
  }

  _writer() {
    if (this.closed) throw new Error('backend_disposed')
    if (!this.writeQueue) {
      this.writeQueue = createWriteQueue({
        store: this,
        config: this._config,
        log: this.log,
        getLlm: this.getLlm,
        getSelection: this.getSelection,
      })
    }
    return this.writeQueue
  }

  /** 续跑遗留的写队列 job（keeper 的 write handler / 启动补偿用）。 */
  async drainWrites() {
    return this._writer().drain()
  }

  /** shadow 候选审核（面板「写入」页）。 */
  /**
   * 审核影子候选：identity 由路由传入，只允许本分区候选/目标（跨分区 id 返回 candidate_not_found）。
   * @param {number|string} id writes 行 id
   * @param {'accept'|'reject'} decision
   * @param {string} [reason]
   * @param {{ identity?: { userId?: string, roleId?: string, workspace?: string } }} [opts]
   */
  reviewWrite(id, decision, reason, opts = {}) {
    return this._writer().review(id, decision, reason, opts)
  }

  async stats() {
    const db = this._db()
    const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
    const nodesTotal = one('SELECT count(*) AS n FROM nodes')
    const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000 })()
    const ftsRows = (() => { try { return one('SELECT count(*) AS n FROM nodes_fts_docsize') } catch { return null } })()
    const ftsBiRows = (() => { try { return one('SELECT count(*) AS n FROM nodes_fts_bi_docsize') } catch { return null } })()
    const jobRow = (state) => one(`SELECT count(*) AS n FROM jobs WHERE state='${state}'`)
    const lastFailed = (() => { try { return db.prepare("SELECT last_error FROM jobs WHERE state='failed' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get()?.last_error || null } catch { return null } })()
    // 最近失败明细：面板「最近失败」卡片直接渲染，省得再开一个接口。
    const recentFailures = (() => {
      try {
        return db.prepare(`SELECT id,kind,state,attempts,last_error,updated_at FROM jobs
          WHERE state='failed' ORDER BY updated_at DESC LIMIT 5`).all().map((row) => ({
          id: Number(row.id), kind: String(row.kind || ''), state: String(row.state || 'failed'),
          attempts: Number(row.attempts || 0), last_error: row.last_error || null,
          updated_at: Number(row.updated_at || 0),
        }))
      } catch { return [] }
    })()
    // 指标/曲线与 totals/health 同一份打开连接：computeMetrics 只读，不新增连接也不写库。
    // embed 关时 pending 滞留按 0 计（§9.1），不然每份日报都挂一个不可行动的 ✗。
    const liveConfig = typeof this._config === 'function' ? this._config() : null
    const metrics = computeMetrics(db, {
      now: Date.now() / 1000, dbFile: this.dbPath, embedEnabled: bool(liveConfig?.embed?.enabled, false),
    })
    return {
      totals: {
        nodes_total: nodesTotal,
        nodes_active: one("SELECT count(*) AS n FROM nodes WHERE status='active'"),
        edges: one('SELECT count(*) AS n FROM edges'),
        recalls_today: one(`SELECT count(*) AS n FROM recalls WHERE ts >= ${dayStart}`),
        injected_chars_today: one(`SELECT coalesce(sum(chars),0) AS n FROM recalls WHERE ts >= ${dayStart}`),
      },
      health: {
        fts_aligned: ftsRows !== null && ftsBiRows !== null && ftsRows === nodesTotal && ftsBiRows === nodesTotal,
        fts_rows: ftsRows,
        fts_bi_rows: ftsBiRows,
        vector_pending: one("SELECT count(*) AS n FROM nodes WHERE vector_state='pending'"),
        jobs: {
          running: jobRow('running'), queued: jobRow('queued'), failed: jobRow('failed'),
          last_error: lastFailed, recent_failures: recentFailures,
        },
        pressure: memoryPressure(),
        fts_errors: ftsStats.errors,
        fts_last_error: ftsStats.last_error || null,
        schema: {
          version: getMeta(db, 'schema_version'),
          unique_hash_index: this.db?.schemaInfo?.uniqueIndex !== false,
          quarantined: Boolean(this.db?.quarantine),
        },
      },
      metrics: { day: metrics.day, values: metrics.values, targets: metrics.targets },
      series: metrics.series,
      schema_version: getMeta(db, 'schema_version'),
      generated_at: new Date().toISOString(),
    }
  }

  /**
   * 最近召回摘要（面板首页）：按身份过滤，避免首页把别人分区的查询词显示出来。
   * @param {number} [limit] 1..10
   * @param {{ identity?: Identity }} [opts]
   */
  async recent(limit = 3, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity)
    const rows = db.prepare(
      `SELECT ts,query,hit_ids,chars,injected,elapsed_ms FROM recalls${where.sql} ORDER BY ts DESC LIMIT ?`,
    ).all(...where.params, Math.max(1, Math.min(10, Number(limit) || 3)))
    return { items: rows.map((r) => ({
      ts: r.ts, query: String(r.query || ''), hits: hitIdsCount(r.hit_ids), chars: r.chars,
      injected: Boolean(r.injected), elapsed_ms: r.elapsed_ms,
    })) }
  }

  /**
   * @param {{ query:string, limit:number, identity:Identity, minRel?:number }} q
   */
  async search(q, signal) {
    const db = this._db()
    const opts = {
      query: String(q?.query || ''), limit: q?.limit ?? 5,
      identity: q?.identity, minRel: q?.minRel,
      diffusion: q?.diffusion, minConf: q?.minConf,
    }
    const worker = this._worker()
    if (worker) {
      try {
        return await worker.search({ dbPath: this.dbPath, ...opts })
      } catch (err) {
        this.log(`[whale-memory] worker search fallback: ${err?.code || err?.message || err}`)
      }
    }
    return searchDb(db, opts)
  }

  /**
   * 召回 + 组装注入文本（与旧网关口径兼容的前缀）。
   *
   * 观测硬约束：**每一次召回都落一行 recalls**，包括零命中与意图预算为 0 的链路。
   * 为什么：零命中不落库时，"零注入率/空转率"永远没有分母，审计看到的只有成功注入
   * 的样本，等于用幸存者偏差给自己打分。预算为 0 也要落一行，否则"按意图关掉注入"
   * 和"根本没有记忆"在数据里长得一样。
   *
   * 注入开关（审计 P1-1 假开关）：
   * - `injectLevels`：只注入这些等级的节点（空数组=不注入）；不传=不过滤（旧调用方行为不变）。
   * - `showSources`：true（默认）时每行带 `[core/owner]` 来源标记，false 时只留正文。
   *
   * @param {{ query:string, maxHits:number, identity:Identity, minRel?:number,
   *   source?:string, traceId?:string, charBudget?:number, intentBudget?:boolean,
   *   injectLevels?:string[], showSources?:boolean }} q
   */
  async recall(q, signal) {
    const started = Date.now()
    // 意图预算（架构书 §5.4）：闲聊/排障/回忆分档；画图链路 0 注入。
    const budget = planBudget(q?.query, {
      intentBudget: q?.intentBudget,
      maxHits: q?.maxHits ?? 5,
      charBudget: q?.charBudget,
    })
    // 预算 0 是「按设计不检索」，不是「检索了但零命中」：source=intent0 与命中率指标区分开，
    // 避免画图链路把 zero_injection_rate 永久拉红。
    const intentZero = budget.maxHits <= 0 || budget.charBudget <= 0
    // 调用方标来源（hook / panel-test / search...）；截 32 与 writes.source 口径一致。
    const source = String(intentZero ? 'intent0' : (q?.source || 'hook')).slice(0, 32)
    /**
     * 落审计行。hit_ids 记录的是**检索命中集合**（并非最终注入集合）：只有把"命中了
     * 但被预算裁掉/丢弃"也留下来，日报才能列出"命中但未注入"的低分候选。
     * 注入与否由 injected/chars 表达，两者不混在同一个字段里。
     * @param {{ hitIds?: string[], chars?: number, injected?: number }} row
     * @returns {number} 新行 id（失败 0）：hook 拿它回写 used 采纳信号
     */
    const audit = ({ hitIds = [], chars = 0, injected = 0 }) => {
      try {
        const db = this._db()
        const info = db.prepare(`INSERT INTO recalls
          (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          now(), String(q?.traceId || ''), String(q?.query || '').slice(0, 500),
          JSON.stringify(hitIds), chars, injected,
          // used 落库时恒 0：注入不等于采纳，证据只能等回复侧（hook 的 assistant-stream）
          // 拿到引用文本后再回写；这里先写 0 是「尚未判定」，不是「判定为未采纳」。
          0,
          Date.now() - started,
          String(q?.identity?.userId || ''), String(q?.identity?.roleId || ''), String(q?.identity?.workspace || ''),
          source,
        )
        return Number(info.lastInsertRowid) || 0
      } catch (err) {
        this.log(`[whale-memory] recall audit fail-open: ${err?.message || err}`)
        return 0
      }
    }

    if (intentZero) {
      audit({})
      return { ok: true, prefix: '', chars: 0, hits: 0, intent: budget.intent }
    }
    const result = await this.search({
      query: q?.query, limit: budget.maxHits, identity: q?.identity, minRel: q?.minRel,
      diffusion: q?.diffusion, minConf: q?.minConf,
    }, signal)
    const searched = Array.isArray(result?.hits) ? result.hits : []
    // 等级过滤必须在预算裁剪之前：先砍掉不该注入的层级，再让预算决定注入多少条。
    // 空数组是显式"一个等级都不要"（面板全不勾），不是"不过滤"；不传才是不过滤。
    const levels = Array.isArray(q?.injectLevels) ? new Set(q.injectLevels.map((x) => String(x))) : null
    const allowed = levels ? searched.filter((h) => levels.has(String(h?.level ?? ''))) : searched
    const trimmed = trimHits(allowed, budget)
    const hits = trimmed.hits
    const showSources = q?.showSources !== false
    /**
     * 每行来源标记 `[level/source]`：让人一眼看出这条记忆的分量与出处（§4.3）。
     * showSources=false 时完全不写标记——面板关掉开关就要真的看不见。
     */
    const markOf = (h) => `[${String(h?.level || 'normal')}/${String(h?.source || 'self')}] `
    const prefix = hits.length
      ? '【你想到的旧事】\n' + hits.map((h) => `- ${showSources ? markOf(h) : ''}${String(h.text || '').trim()}`).join('\n')
      : ''
    const recallId = audit({
      hitIds: searched.map((h) => h.id),
      chars: prefix.length,
      injected: prefix ? 1 : 0,
    })
    return {
      ok: true, prefix, chars: prefix.length, hits: hits.length,
      intent: budget.intent, dropped: trimmed.dropped, clipped: trimmed.clipped,
      // 被等级开关挡掉的数量：面板"命中但未注入"从此能区分"层级不收"与"预算不够"。
      level_filtered: searched.length - allowed.length,
      // 采纳信号的判定素材：只给**最终注入**的节点（被预算裁掉的节点不该产生采纳）。
      recallId,
      injectedNodes: hits.map((h) => ({ id: String(h?.id ?? ''), text: String(h?.text ?? '') })),
    }
  }

  /**
   * 采纳信号回写：一次召回被回复引用后置 used=1。
   *
   * why 只改 used 列：hit_ids/chars/injected 描述的是「注入事实」，回复侧只能证明
   * 「是否被引用」，两者混在一个字段里会让日报的注入率与采纳率互相污染。
   * 失败 fail-open：观测信号不能反向影响正常回复链路。
   *
   * @param {number} recallId `recall()` 返回的审计行 id
   * @param {boolean} [used]
   * @returns {{ ok: boolean, updated: number }}
   */
  markRecallUsed(recallId, used = true) {
    const id = Number(recallId)
    if (!Number.isInteger(id) || id <= 0) return { ok: false, updated: 0 }
    try {
      const info = this._db().prepare('UPDATE recalls SET used=? WHERE id=?').run(used ? 1 : 0, id)
      return { ok: true, updated: Number(info.changes) || 0 }
    } catch (err) {
      this.log(`[whale-memory] markRecallUsed fail-open: ${err?.message || err}`)
      return { ok: false, updated: 0 }
    }
  }

  /**
   * 写入入口（S4 决策流水线）：校验 → 落 jobs 队列 → decideWrite → processEvent。
   * shadow 模式只留 writes CANDIDATE，不落 nodes；auto 模式才写记忆库。
   * @param {{ text:string, level?:string, memory_type?:string, source?:string, tags?:string[], expired_at?:number, origin?:string, traceId?:string, identity:Identity }} q
   */
  async write(q) {
    const text = normalize(String(q?.text || ''))
    if (!text) return { ok: false, error: 'invalid_text' }
    if (text.length > 500) return { ok: false, error: 'text_too_long' }
    const writeCfg = plain(this._config()?.write) || {}
    // 关写开关必须先解包 Ref（schemas 里是 .volatile()，直接 === false 恒假，开关等于没有）。
    if (plain(writeCfg.enabled) === false) return { ok: false, error: 'write_disabled' }
    const ident = q?.identity || {}
    const tags = Array.isArray(q.tags) ? q.tags.filter((x) => typeof x === 'string').slice(0, 32) : []
    const event = {
      traceId: String(q?.traceId || ''),
      source: String(q?.source || 'manual'),
      identity: { userId: String(ident.userId || ''), roleId: String(ident.roleId || ''), workspace: String(ident.workspace || '') },
      text,
      tags,
      at: Date.now(),
      candidateType: q?.memory_type || null,
      origin: String(q?.origin || 'panel'),
      level: q?.level || 'normal',
      memory_type: q?.memory_type || 'semantic',
      // v3：规则置顶随事件下传（writer 落库；默认 0，不改变既有写入口行为）。
      pinned: q?.pinned === 1 || q?.pinned === true ? 1 : 0,
      expired_at: Number.isFinite(Number(q?.expired_at)) ? Number(q.expired_at) : undefined,
    }
    const res = await this._writer().enqueue(event)
    if (!res || res.ok === false) {
      return { ok: false, error: String(res?.reason || 'write_rejected'), action: res?.action }
    }
    if (res.id) {
      // 演化注记只追加 context_note（≤200），不改正文/tags；失败不阻断写入结果。
      try {
        this.withDb((db) => applyNeighborNotes(db, { id: res.id, tags, identity: event.identity }, { traceId: event.traceId }))
      } catch (err) {
        this.log(`[whale-memory] neighbor notes fail-open: ${err?.message || err}`)
      }
    }
    return {
      ok: true,
      id: res.id,
      action: res.action,
      duplicate: Boolean(res.duplicate),
      candidate: res.action === 'CANDIDATE',
    }
  }

  /**
   * 反思素材：最近 episodic（只读）。
   *
   * 身份过滤不可省：反思会把素材交给模型再写回；不按分区取会把别人的私有 episodic
   * 混进来，写回时又落共享分区，等于把私有事实洗成公开记忆。
   *
   * @param {number} [limit]
   * @param {{ identity?: Identity }} [opts]
   */
  async listEpisodic(limit = 20, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity)
    const rows = db.prepare(`SELECT id,text,created_at,tags FROM nodes${where.sql}
      ${where.sql ? 'AND' : 'WHERE'} status='active' AND memory_type='episodic'
      ORDER BY created_at DESC LIMIT ?`).all(...where.params, Math.max(1, Math.min(50, Number(limit) || 20)))
    return rows
  }

  /**
   * 同步导入 JSONL（≤50 行走这里；大导入走 startImport 分片）。
   *
   * 保真口径：status/vector_state 校验枚举回落，双时态与 superseded_by 直通，
   * context_note 截 200，hits/weight/last_hit_at 数值回落；>500 字按规则边界拆分，
   * 拆不出才拒绝并计入 reasons / error_details（不再静默丢行）。
   * 事务末尾做 FTS 一致性闸，不一致整个 ROLLBACK 并返回 fts_misaligned。
   * 统计口径（计划书 §8.3）：kept=原样保留的源行数、split=被拆分的源行数（不是段数）、
   * rejected=拒绝的源行数（与 errors 同值）；added 仍是实际写入节点数。
   *
   * @param {{ jsonl:string, identity?:Identity, dryRun?:boolean }} q
   * @returns {Promise<{ ok:boolean, added:number, skipped:number, errors:number, kept:number,
   *   split:number, rejected:number, reasons:object,
   *   error_details:Array<{index:number,reason:string,text_hash:string}>, dryRun:boolean, error?:string }>}
   */
  async importJsonl(q) {
    const db = this._db()
    const lines = String(q?.jsonl || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const ident = q?.identity || {}
    const ts = now()
    const dryRun = Boolean(q?.dryRun)
    const insert = db.prepare(IMPORT_INSERT_SQL)
    const exists = db.prepare(
      `SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=?
        AND (origin IS NULL OR origin NOT LIKE 'rule:%') LIMIT 1`,
    )

    let errors = 0
    let kept = 0
    let splitLines = 0
    /** @type {Record<string, number>} */
    const reasons = {}
    /** @type {Array<{ index: number, reason: string, text_hash: string }>} */
    const errorDetails = []
    /** @type {Array<{ node: object, split: boolean }>} */
    const items = []

    lines.forEach((line, index) => {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        errors += 1
        reasons.invalid_json = (reasons.invalid_json || 0) + 1
        if (errorDetails.length < ERROR_DETAIL_LIMIT) {
          errorDetails.push({ index, reason: 'invalid_json', text_hash: contentHash(line).slice(0, 12) })
        }
        return
      }
      const plan = planImportRows(row, ident, { ts, seq: index })
      if (plan.kind === 'error') {
        errors += 1
        reasons[plan.reason] = (reasons[plan.reason] || 0) + 1
        if (errorDetails.length < ERROR_DETAIL_LIMIT) {
          errorDetails.push({ index, reason: plan.reason, text_hash: plan.textHash.slice(0, 12) })
        }
        return
      }
      if (plan.split) splitLines += 1
      else kept += 1
      for (const node of plan.rows) items.push({ node, split: plan.split === true })
    })

    let added = 0
    let skipped = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      ;({ added, skipped } = landImportRows(db, items, { insert, exists, dryRun }))
      if (!dryRun && !ftsAligned(db)) {
        db.exec('ROLLBACK')
        return {
          ok: false, error: 'fts_misaligned', added: 0, skipped: 0, errors,
          kept, split: splitLines, rejected: errors, reasons, error_details: errorDetails, dryRun,
        }
      }
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* noop */ }
      throw err
    }
    return {
      ok: true, added, skipped, errors, kept, split: splitLines, rejected: errors,
      reasons, error_details: errorDetails, dryRun,
    }
  }

  /**
   * 导出 JSONL：按身份过滤（与 search 同口径 `(列='' OR 列=?)`），补 hits/last_hit_at/vector_state。
   * 身份过滤是硬要求：导出文件会被拿去推送/外传，不过滤等于跨分区泄漏。
   * @param {{ identity?:Identity }} [q]
   */
  async exportJsonl(q = {}) {
    const db = this._db()
    const filter = identityFilter(q?.identity)
    const rows = db.prepare(
      `SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${filter.sql} ORDER BY created_at, id`,
    ).all(...filter.params)
    return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  }

  /**
   * 置顶规则（schema v3；R4 每会话首次注入的数据入口）。
   *
   * 口径：
   * - 只取 `status='active' AND pinned=1`：退役（superseded）与归档规则不得再注入。
   * - 身份/作用域走 `whereOf` 的 `(列='' OR 列=?)`：规则默认共享（''），可整条限定工作区；
   *   `''` 始终可见，所以共享规则在任何会话都会带上。
   * - 排序 weight（显式/高置信优先）→ updated_at（最近改动优先）→ created_at，结果稳定可测。
   * - 上限只做硬保护（1..100），预算裁剪（条数/字符）由 R4 的注入层负责，这里不静默丢。
   *
   * @param {Identity|null|undefined} identity 会话身份
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<object[]>} 节点行（字段同导出，含 pinned）
   */
  async pinnedRules(identity, { limit = 20 } = {}) {
    const db = this._db()
    const max = Math.max(1, Math.min(100, Number(limit) || 20))
    const where = whereOf(identity, [["status='active'", []], ['pinned=1', []]])
    return db.prepare(
      `SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql}
       ORDER BY weight DESC, updated_at DESC, created_at DESC LIMIT ?`,
    ).all(...where.params, max)
  }

  /**
   * 节点分页（面板「记忆」页）：列表与 total 都按身份过滤（与 export 同口径）。
   * why total 也要过滤：列表过滤而总数不过滤时，面板会显示"本区 2 条 / 共 40 条"，
   * 既暴露了别人分区的规模，也让翻页逻辑把空页当成还有数据。
   *
   * @param {{ identity?:Identity, limit?:number, offset?:number }} q
   */
  async nodes(q = {}) {
    const db = this._db()
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20))
    const offset = Math.max(0, Number(q.offset) || 0)
    const where = whereOf(q?.identity)
    const total = Number(db.prepare(`SELECT count(*) AS n FROM nodes${where.sql}`).get(...where.params)?.n || 0)
    const rows = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...where.params, limit, offset)
    return { items: rows, total }
  }

  /**
   * 单节点详情（面板抽屉）：不属本身份的节点一律按 node_not_found 处理。
   * why 不返回 403：存在性本身就是信息（"某 id 有记忆"），跨身份探测不该有反馈。
   * @param {string} id
   * @param {{ identity?:Identity }} [opts]
   */
  async getNode(id, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity, [['id=?', [String(id || '')]]])
    const row = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql}`).get(...where.params)
    if (!row) return { ok: false, error: 'node_not_found' }
    // 面板详情抽屉要"1 跳邻居边"（§7.2）：只暴露身份可见的两端。
    // 边没有身份列，按两端节点是否在可见集合里判断（与 /edges 同口径）。
    let edges = []
    try {
      const filter = identityFilter(opts?.identity)
      const cond = filter.sql
        ? `AND e.from_id IN (SELECT id FROM nodes${filter.sql}) AND e.to_id IN (SELECT id FROM nodes${filter.sql})`
        : ''
      const rows = db.prepare(`SELECT e.id, e.from_id, e.to_id, e.etype, e.source, e.conf, e.weight, e.created_at
        FROM edges e
        WHERE (e.from_id = ? OR e.to_id = ?) ${cond}
        ORDER BY e.conf DESC, e.id DESC LIMIT 20`)
        .all(String(id || ''), String(id || ''), ...filter.params, ...filter.params)
      edges = rows.map((edge) => ({
        ...edge,
        neighbor: edge.from_id === String(id) ? edge.to_id : edge.from_id,
      }))
    } catch { edges = [] }
    return { ok: true, node: row, edges }
  }

  /**
   * 面板编辑/归档：只改白名单字段，重算 hash/bigrams，并把改动完整留痕。
   *
   * 三条硬约束（审计 P0-3 / A3）：
   * - 事务内先读旧行：旧值既用于身份校验，也是审计的 before_text（事后读会被改后的值骗）。
   * - 受保护目标（source=owner / level=core / memory_type=procedural）只允许改非正文状态，
   *   改正文或改等级返回 protected_target；面板不能绕过保护把规则改成别的意思。
   * - status=superseded 必须带 superseded_by，否则 superseded_by_required —— 防止留下
   *   "已失效但不知道被谁取代"的半残数据。
   * - 普通目标的每个字段改动写一条 writes（EDIT/ARCHIVE）+ 一条 evolution（旧值/新值）。
   *
   * @param {string} id
   * @param {{ text?:string, status?:string, level?:string, tags?:string[], superseded_by?:string }} patch
   * @param {{ identity?:Identity, traceId?:string, mode?:'manual'|'sync' }} [opts]
   *   mode 只影响 writes.mode（面板人工 vs 同步冲突标记），便于审计区分改动来源。
   * @returns {{ ok: boolean, id?: string, error?: string }}
   */
  async updateNode(id, patch = {}, opts = {}) {
    const db = this._db()
    const target = String(id || '')
    const where = whereOf(opts?.identity, [['id=?', [target]]])
    const row = db.prepare(`SELECT * FROM nodes${where.sql}`).get(...where.params)
    if (!row) return { ok: false, error: 'node_not_found' }
    // 乐观并发：客户端回传详情里的 updated_at，期间被别人改过就拒绝，不拿旧快照覆盖。
    const expected = opts?.expectedUpdatedAt
    if (expected !== undefined && expected !== null && expected !== ''
      && String(expected) !== String(row.updated_at)) {
      return { ok: false, error: 'node_changed' }
    }
    const text = patch.text === undefined ? row.text : normalize(String(patch.text))
    if (!text || text.length > 500) return { ok: false, error: 'invalid_text' }
    const status = patch.status === undefined ? row.status : String(patch.status)
    if (!['active', 'archived', 'stale', 'superseded'].includes(status)) return { ok: false, error: 'invalid_status' }
    const level = patch.level === undefined ? row.level : String(patch.level)
    if (!['core', 'important', 'normal'].includes(level)) return { ok: false, error: 'invalid_level' }
    const tags = patch.tags === undefined ? row.tags : JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])
    const supersededBy = patch.superseded_by === undefined || patch.superseded_by === null
      ? row.superseded_by
      : String(patch.superseded_by).trim().slice(0, 128)
    if (status === 'superseded' && !supersededBy) return { ok: false, error: 'superseded_by_required' }
    // 离开 superseded 时指针必须清空：留下"谁是继任者"而状态是 active，就是半残数据。
    const nextPointer = status === 'superseded' ? supersededBy : null

    const textChanged = text !== row.text
    const levelChanged = level !== row.level
    const protectedTarget = String(row.source || '') === 'owner'
      || String(row.level || '') === 'core'
      || String(row.memory_type || '') === 'procedural'
    if (protectedTarget && (textChanged || levelChanged)) return { ok: false, error: 'protected_target' }

    const statusChanged = status !== row.status
    const tagsChanged = tags !== row.tags
    const pointerChanged = String(nextPointer ?? '') !== String(row.superseded_by ?? '')
    const ts = now()
    const traceId = String(opts?.traceId || '').slice(0, 64)
    const mode = opts?.mode === 'sync' ? 'sync' : 'manual'

    try {
      return withTx(db, () => {
      // CAS：读旧行在事务外，若期间被别的写入改过，直接返回 node_changed，
      // 不用旧快照覆盖新值（审计 P2：丢更新窗口）。
      const current = db.prepare('SELECT updated_at FROM nodes WHERE id=?').get(target)
      if (current && String(current.updated_at) !== String(row.updated_at)) {
        return { ok: false, error: 'node_changed' }
      }
      if (textChanged || statusChanged || levelChanged || tagsChanged || pointerChanged) {
        db.prepare(`UPDATE nodes SET text=?,text_hash=?,text_bigrams=?,status=?,level=?,tags=?,superseded_by=?,updated_at=?
          WHERE id=?`).run(
          text, contentHash(text), bigrams(text), status, level, tags, nextPointer, ts, target,
        )
      }
      /** 一个字段的改动 = 一条 writes + 一条 evolution（面板「写入」页与「演化」页同源）。 */
      const audit = (action, field, oldValue, newValue, reason) => {
        db.prepare(`INSERT INTO writes
          (ts,trace_id,action,node_id,reason,before_text,after_text,mode,user_id,role_id,workspace)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          ts, traceId, action, target, reason,
          String(row.text ?? ''), field === 'text' ? String(newValue ?? '') : String(row.text ?? ''),
          mode, String(row.user_id ?? ''), String(row.role_id ?? ''), String(row.workspace ?? ''),
        )
        recordEvolution(db, { ts, fromId: target, toId: target, field, oldValue, newValue, traceId })
      }
      if (textChanged) audit('EDIT', 'text', row.text, text, 'manual_edit')
      if (statusChanged) audit('ARCHIVE', 'status', row.status, status, 'manual_archive')
      if (levelChanged) audit('EDIT', 'level', row.level, level, 'manual_level')
      if (tagsChanged) audit('EDIT', 'tags', row.tags, tags, 'manual_tags')
      if (pointerChanged) audit('EDIT', 'superseded_by', row.superseded_by ?? '', nextPointer ?? '', 'manual_supersede')
        return { ok: true, id: target, updated_at: ts }
      })
    } catch (err) {
      // 编辑后的正文与另一活跃行撞车：回明确错误码，不把 SQLite 约束文案透给面板。
      if (isActiveHashConflict(err)) return { ok: false, error: 'duplicate_active' }
      throw err
    }
  }

  /**
   * 最近写入审计（只读）；action 过滤用于面板只看 shadow 候选。
   * @param {number} [limit]
   * @param {string} [action]
   * @param {{ identity?:Identity }} [opts]
   */
  async writes(limit = 20, action = '', opts = {}) {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 20))
    const where = whereOf(opts?.identity, action ? [['action=?', [String(action)]]] : [])
    const rows = db.prepare(`SELECT id,ts,trace_id,action,node_id,reason,before_text,after_text,mode,user_id,role_id,workspace
      FROM writes${where.sql} ORDER BY ts DESC LIMIT ?`).all(...where.params, lim)
    return { items: rows }
  }

  /**
   * 关系统计 + 最近边（面板 /edges）：两端都在本身份可见集合内才算数。
   * edges 表没有隔离列，可见性只能经 nodes 判定；统计与明细必须同口径，否则总数与列表打架。
   * @param {number} [limit]
   * @param {{ identity?:Identity }} [opts]
   */
  async edges(limit = 50, opts = {}) {
    const db = this._db()
    const ends = bothEndsVisible(opts?.identity)
    const whereSql = ends.active ? ` WHERE ${ends.sql}` : ''
    const stat = relationStats(db, opts?.identity)
    const items = db.prepare(`SELECT id,from_id,to_id,etype,source,conf,weight,created_at FROM edges${whereSql}
      ORDER BY id DESC LIMIT ?`).all(...ends.params, Math.max(1, Math.min(100, Number(limit) || 50)))
    return { ok: true, ...stat, items }
  }

  /**
   * 演化审计（面板 /evolution）：按被改节点（to_id）所属身份过滤。
   * 两端都要求可见：跨分区的边/注记不该在别人的审计页出现（哪怕只是节点 id）。
   * @param {number} [limit]
   * @param {{ identity?:Identity }} [opts]
   */
  async evolution(limit = 50, opts = {}) {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 50))
    const ends = bothEndsVisible(opts?.identity)
    const whereSql = ends.active ? ` WHERE ${ends.sql}` : ''
    const items = db.prepare(`SELECT id,ts,from_id,to_id,field,old_value,new_value,trace_id FROM evolution${whereSql}
      ORDER BY id DESC LIMIT ?`).all(...ends.params, lim)
    return { ok: true, items }
  }

  /**
   * 最近召回审计（只读）：面板过滤与日报复盘共用同一个入口。
   *
   * 过滤参数全部走 SQL 占位符；filter 只认白名单（zero/unused），
   * 未知值按"不过滤"处理——面板多传一个键不能把整页查空。
   * 身份条件（opts.identity）与其它条件同层 AND，避免"过滤把人过滤掉了但统计没过滤"。
   *
   * @param {number} [limit] 1..100（越界夹取；非正数回落 20）
   * @param {{ source?: string, since?: number, filter?: 'zero'|'unused'|'', identity?: Identity }} [opts]
   *   source: 精确匹配来源（截 32）；since: 秒级下界；filter: zero=零命中 / unused=已注入未采纳
   * @returns {{ items: Array<{ id:number, ts:number, trace_id:string, query:string,
   *   hit_ids:string, chars:number, injected:number, used:number, elapsed_ms:number|null,
   *   source:string, hits:number }> }}
   */
  async recalls(limit = 20, opts = {}) {
    const db = this._db()
    const raw = Number(limit)
    const lim = Math.max(1, Math.min(100, Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
    const extra = []
    const source = String(opts?.source ?? '').slice(0, 32)
    if (source) extra.push(['source = ?', [source]])
    const since = Number(opts?.since)
    if (Number.isFinite(since)) extra.push(['ts >= ?', [since]])
    if (opts?.filter === 'zero') {
      extra.push(["hit_ids IN ('[]','')", []])
      extra.push(["source <> 'intent0'", []])
    }
    else if (opts?.filter === 'unused') extra.push(['injected = 1 AND used = 0', []])
    const where = whereOf(opts?.identity, extra)
    const sql = `SELECT id,ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,source
      FROM recalls${where.sql} ORDER BY ts DESC, id DESC LIMIT ?`
    const rows = db.prepare(sql).all(...where.params, lim)
    return { items: rows.map((r) => ({ ...r, hits: hitIdsCount(r.hit_ids) })) }
  }

  /**
   * 异步分片导入（>50 行）：202 + jobId。
   *
   * 持久化分两层，避免每批重写整份 jsonl（审计 A7：4 MiB 上限曾被放大 ~26×）：
   * - `jobs.payload` 只在入队时写一次 `{ jsonl, identity, total }`；
   * - 进度（cursor/统计/错误明细）写 `meta['import_progress:<jobId>']` 小 JSON，每批只改它。
   * 崩溃后 keeper recoverRunningJobs → handler('import') 从 cursor 续跑（铁律 3）。
   * @param {{ jsonl:string, identity?:Identity }} q
   */
  async startImport(q) {
    const db = this._db()
    const jsonl = String(q?.jsonl || '')
    const total = jsonl.split('\n').filter((line) => line.trim()).length
    const payload = { jsonl, identity: q?.identity || {}, total }
    const created = db.prepare('INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('import', 'running', 0, JSON.stringify(payload), now(), now())
    const jobId = String(created.lastInsertRowid)
    this._resumeImportJob(jobId).catch((err) => this.log(`[whale-memory] import job fail-open: ${err?.message || err}`))
    return { ok: true, async: true, jobId, total }
  }

  /** 续跑一条 import job（startImport 首跑 / keeper 崩溃恢复都走；进度在 meta，可重复调用）。 */
  async resumeImportJob(jobId) {
    return this._resumeImportJob(jobId)
  }

  /** @private */
  async _resumeImportJob(jobId) {
    const id = Number(jobId)
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_job_id' }
    const db = this._db()
    const row = db.prepare('SELECT id,kind,state,payload FROM jobs WHERE id=?').get(id)
    if (!row || String(row.kind) !== 'import') return { ok: false, error: 'job_not_found' }
    if (String(row.state) === 'done') return { ok: true, state: 'done', jobId: id }
    let payload
    try { payload = JSON.parse(String(row.payload || '{}')) || {} } catch { return { ok: false, error: 'payload_corrupt' } }
    const lines = String(payload.jsonl || '').split('\n').map((line) => line.trim()).filter(Boolean)
    if (!lines.length) return { ok: false, error: 'payload_corrupt' }
    const ident = payload.identity && typeof payload.identity === 'object' ? payload.identity : {}
    db.prepare("UPDATE jobs SET state='running', updated_at=? WHERE id=?").run(now(), id)
    const progress = readImportProgress(db, id)
    let cursor = Math.max(0, Math.min(lines.length, Number(progress.cursor) || 0))
    let lastBatchStart = cursor

    try {
    const insert = db.prepare(IMPORT_INSERT_SQL)
    // 规则镜像行不参与“已存在”判定；任意状态（含 archived）都算已导入，保证二次导入幂等。
    const exists = db.prepare(`SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=?
      AND (origin IS NULL OR origin NOT LIKE 'rule:%') LIMIT 1`)
    while (cursor < lines.length) {
      if (this.closed) return { ok: false, error: 'backend_disposed' }
      const batchStart = cursor
      lastBatchStart = batchStart
      const batch = lines.slice(batchStart, batchStart + 50)
      cursor += batch.length
      const ts = now()
      /** @type {Array<{ node: object, split: boolean }>} */
      const items = []
      batch.forEach((line, i) => {
        const index = batchStart + i
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          progress.errors += 1
          progress.reasons.invalid_json = (progress.reasons.invalid_json || 0) + 1
          if (progress.error_details.length < ERROR_DETAIL_LIMIT) {
            progress.error_details.push({ index, reason: 'invalid_json', text_hash: contentHash(line).slice(0, 12) })
          }
          return
        }
        const plan = planImportRows(parsed, ident, { ts, seq: index })
        if (plan.kind === 'error') {
          progress.errors += 1
          progress.reasons[plan.reason] = (progress.reasons[plan.reason] || 0) + 1
          if (progress.error_details.length < ERROR_DETAIL_LIMIT) {
            progress.error_details.push({ index, reason: plan.reason, text_hash: plan.textHash.slice(0, 12) })
          }
          return
        }
        if (plan.split) progress.split += 1
        else progress.kept += 1
        for (const node of plan.rows) items.push({ node, split: plan.split === true })
      })

      let failed = false
      try {
        db.exec('BEGIN IMMEDIATE')
        const { added, skipped } = landImportRows(db, items, { insert, exists })
        if (!ftsAligned(db)) {
          db.exec('ROLLBACK')
          failed = true
          progress.errors += items.length
          progress.reasons.fts_misaligned = (progress.reasons.fts_misaligned || 0) + 1
          if (progress.error_details.length < ERROR_DETAIL_LIMIT) {
            progress.error_details.push({ index: batchStart, reason: 'fts_misaligned', text_hash: '' })
          }
        } else {
          db.exec('COMMIT')
          progress.added += added
          progress.skipped += skipped
        }
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* noop */ }
        failed = true
        progress.errors += batch.length
        progress.reasons.batch_failed = (progress.reasons.batch_failed || 0) + 1
        this.log(`[whale-memory] import batch fail: ${err?.message || err}`)
      }

      if (failed) {
        // 失败批必须把 cursor 退回批首：keeper 重试从这一批重跑，不能跳着丢数据（审计 A6）。
        progress.cursor = batchStart
        saveImportProgress(db, id, progress, 'failed', progress.reasons.fts_misaligned ? 'fts_misaligned' : 'batch_failed')
        return { ok: false, error: progress.reasons.fts_misaligned ? 'fts_misaligned' : 'batch_failed', jobId: id }
      }
      progress.cursor = cursor
      saveImportProgress(db, id, progress, cursor >= lines.length ? 'done' : 'running',
        progress.errors ? 'partial_errors' : null)
      if (cursor < lines.length) await new Promise((resolve) => setImmediate(resolve))
    }
      saveImportProgress(db, id, progress, 'done', progress.errors ? 'partial_errors' : null)
      return { ok: true, state: 'done', jobId: id }
    } catch (err) {
      // 意外失败（比如 FTS 表缺失导致 prepare 就抛）：不能把 job 留在 running。
      // cursor 回退到当前批首，keeper 重试时整批重跑；状态 failed 让退避重试可见。
      progress.cursor = Math.max(0, Math.min(lastBatchStart, lines.length))
      try { saveImportProgress(db, id, progress, 'failed', String(err?.message || err).slice(0, 200)) } catch { /* 记录失败不遮蔽原始错误 */ }
      throw err
    }
  }

  async importStatus(jobId) {
    const db = this._db()
    const id = Number(jobId)
    const row = db.prepare('SELECT id,kind,state,last_error,created_at,updated_at FROM jobs WHERE id=?').get(id)
    if (!row) return { ok: false, error: 'job_not_found' }
    // 进度在 meta（小 JSON）；jobs.payload 里的 jsonl 永不回传。
    const progress = readImportProgress(db, id)
    return {
      ok: true,
      job: {
        id: row.id, kind: row.kind, state: row.state, ...progress,
        last_error: row.last_error, updated_at: row.updated_at,
      },
    }
  }

  dispose() {
    this.closed = true
    try { this.writeQueue?.dispose() } catch { /* noop */ }
    this.writeQueue = null
    try { this.worker?.dispose() } catch { /* noop */ }
    this.worker = null
    closeDb(this.db)
    this.db = null
  }
}

/**
 * 读接口第二参数兼容层：既接受 AbortSignal（hook 直传 `recall(q, signal)` 的旧写法），
 * 也接受 `{ signal, timeoutMs, identity }` 选项对象（路由统一 opts 口径）。
 * why 必须兼容：hook 传的是 AbortSignal，路由传的是 opts；HttpBackend 一个方法要接住两种调用。
 *
 * @param {AbortSignal|{signal?:AbortSignal,timeoutMs?:number,identity?:any}|null|undefined} opts
 * @returns {{ signal?: AbortSignal, timeoutMs?: number, identity?: any }}
 */
function callOpts(opts) {
  if (!opts || typeof opts !== 'object') return {}
  if (typeof opts.addEventListener === 'function' && typeof opts.aborted === 'boolean') return { signal: opts }
  return { ...opts }
}

/** 远端协议串：`GET /version` 回 `{protocol}`，不匹配即 protocol_mismatch（面板可读）。 */
export const WHALE_PROTOCOL = 'whale-memory/1'
/** 单次响应体硬顶（防止远端返回巨大 JSON 拖死主线程）。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * 外部服务客户端：读四接口 + 写接口 + version。
 *
 * 两条硬口径：
 * - 读接口 fail-open（返回 null），检索失败不能阻塞对话；
 * - 写接口显式失败（返回 `{ok:false,error}`），绝不静默 null——否则 outbox 会把
 *   "没写成功"当成"没响应"，重试与审计都失去依据。
 *
 * Bearer token 只由构造参数传入（不读 env/config 魔法），`authorization` 头统一注入，
 * 读/写/version 三条链路同源。
 */
export class HttpBackend {
  /**
   * @param {{ baseUrl?: string, timeoutMs?: number, token?: string, log?: Function }} [opts]
   */
  constructor({ baseUrl, timeoutMs = 3000, token = '', log = () => {} } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.mode = 'http'
    this.timeoutMs = timeoutMs
    this.token = token
    this.log = log
    /** 最近一次成功探测到的协议串（未探测为 null）。 */
    this.protocol = null
    /** 最近一次协议不匹配的证据 `{protocol,expected,baseUrl,at}`；匹配/未探测为 null。 */
    this.protocolMismatch = null
    this.protocolCheckedAt = null
  }

  get ready() { return Boolean(this.baseUrl) }

  /**
   * 运行中补 token（凭证服务异步解析，构造时拿不到）。
   * @param {string} token
   * @returns {{ ok: boolean }}
   */
  setToken(token) {
    this.token = String(token || '')
    return { ok: true }
  }

  /** 面板/统计可读的协议状态：即使不匹配也返回对象，不抛。 */
  get protocolStatus() {
    return {
      ok: this.protocol === WHALE_PROTOCOL,
      protocol: this.protocol,
      expected: WHALE_PROTOCOL,
      mismatch: this.protocolMismatch,
      checked_at: this.protocolCheckedAt,
      baseUrl: this.baseUrl,
    }
  }

  /**
   * 统一发送：不抛异常，返回显式结果。
   * @param {string} path
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string> }} [opts]
   * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string, timedOut?: boolean }>}
   */
  async _send(path, opts = {}) {
    if (!this.ready) return { ok: false, status: 0, error: 'backend_not_configured' }
    const { method = 'GET', body, signal, timeoutMs = this.timeoutMs, headers = {} } = opts
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    const timeout = AbortSignal.timeout(budget)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(this.baseUrl + path, {
        method, signal: combined,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, status: res.status, error: `http_${res.status}`, text: text.slice(0, 500) }
      }
      if (text.length > MAX_RESPONSE_BYTES) return { ok: false, status: res.status, error: 'response_too_large' }
      let data = null
      if (text) {
        try { data = JSON.parse(text) } catch { return { ok: false, status: res.status, error: 'invalid_json' } }
      }
      return { ok: true, status: res.status, data }
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return {
        ok: false, status: 0, timedOut,
        error: timedOut ? 'timeout' : String(err?.code || err?.message || 'network_error'),
      }
    }
  }

  /** 读接口 fail-open：失败返回 null（内部日志保留原因）。 */
  async request(path, opts = {}) {
    const out = await this._send(path, opts)
    if (out.ok) return out.data
    this.log(`[whale-memory] backend ${opts.method || 'GET'} ${path} fail-open: ${out.error}`)
    return null
  }

  async stats(opts = {}) { return this.request('/stats', callOpts(opts)) }
  /**
   * 置顶规则在外部协议里没有端点：规则语义只存在于本地库（R1 设计）。
   * 返回 null 让 Hybrid 回退本地真源；直接调用方拿到 null 即"无规则"。
   */
  async pinnedRules() { return null }
  async recent(limit, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request(`/recent?limit=${encodeURIComponent(limit)}`, { signal, ...rest })
  }
  async search(q, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request('/search', { method: 'POST', body: q, signal, ...rest })
  }
  async recall(q, opts = {}) {
    const { signal, ...rest } = callOpts(opts)
    return this.request('/recall', { method: 'POST', body: q, signal, ...rest })
  }

  /**
   * 写入远端：POST `/write`，body `{event}`；成功返回远端 action。
   *
   * 冲突不在这里裁决：`{action:'conflict'}` 或 `{conflict:true}` 原样作为
   * `conflict:true` 交给 Hybrid（它负责把本地节点置 stale 并保留 outbox 明细）。
   *
   * @param {object} event 节点/事件快照
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: boolean, action?: string, conflict?: boolean, id?: string|null, status?: number, error?: string }>}
   */
  async write(event, opts = {}) {
    const out = await this._send('/write', { method: 'POST', body: { event }, ...opts })
    if (!out.ok) return { ok: false, error: out.error, status: out.status, timedOut: Boolean(out.timedOut) }
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    if (data.ok === false) return { ok: false, error: String(data.error || 'write_rejected'), status: out.status, action: data.action }
    const action = String(data.action ?? 'ok')
    return {
      ok: true,
      action,
      conflict: action === 'conflict' || data.conflict === true,
      id: data.id === undefined || data.id === null ? null : String(data.id),
      status: out.status,
    }
  }

  /**
   * 协议探测：GET `/version` → `{protocol:'whale-memory/1'}`。
   *
   * 不匹配时不抛、不静默：返回 `{ok:false,error:'protocol_mismatch'}`，同时把证据留在
   * `protocolMismatch` / `protocolStatus` 上（面板与 stats 可读）。网络失败也显式返回。
   *
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: boolean, protocol?: string|null, expected: string, mismatch?: boolean, status?: number, error?: string }>}
   */
  async version(opts = {}) {
    const out = await this._send('/version', opts)
    if (!out.ok) return { ok: false, expected: WHALE_PROTOCOL, status: out.status, error: out.error }
    const protocol = String(out.data?.protocol ?? '')
    this.protocol = protocol || null
    this.protocolCheckedAt = Date.now()
    this.protocolMismatch = protocol === WHALE_PROTOCOL
      ? null
      : { protocol: protocol || null, expected: WHALE_PROTOCOL, baseUrl: this.baseUrl, at: this.protocolCheckedAt }
    if (this.protocolMismatch) {
      this.log(`[whale-memory] backend protocol mismatch: ${protocol || '(empty)'} != ${WHALE_PROTOCOL}`)
      return { ok: false, error: 'protocol_mismatch', protocol, expected: WHALE_PROTOCOL, mismatch: true, status: out.status }
    }
    return { ok: true, protocol, expected: WHALE_PROTOCOL, status: out.status }
  }
}

/**
 * 后端工厂：local（默认）/ http（纯远端）/ hybrid（本地真源 + 远端副本 + outbox）。
 *
 * hybrid 不再当纯 Http 返回：读走 HTTP 失败回本地，写必须落本地并排队同步。
 *
 * @param {{ mode?: string, url?: string, timeoutMs?: number }} cfg backend 配置段
 * @param {{ token?: string, log?: Function, dataDir?: string, useWorker?: boolean, config?: object|Function,
 *   getLlm?: () => any, getSelection?: () => object }} [extra]
 *   config 为完整配置（或 getter）：hybrid 读 `sync.httpTimeoutMs`（默认 800ms），
 *   LocalBackend 读 `write.*`，二者同源；getLlm/getSelection 供 `write.judge='llm'` 的判定器取模型。
 */
export function createBackend(cfg, extra = {}) {
  if (cfg?.mode === 'http') {
    return new HttpBackend({
      baseUrl: cfg.url || '',
      timeoutMs: cfg.timeoutMs || 3000,
      token: extra.token || '',
      log: extra.log || (() => {}),
    })
  }
  if (cfg?.mode === 'hybrid') {
    const liveConfig = () => {
      const c = extra.config
      return typeof c === 'function' ? c() : c
    }
    const syncTimeout = Number(plain(liveConfig()?.sync?.httpTimeoutMs))
    const httpTimeoutMs = Number.isFinite(syncTimeout) && syncTimeout > 0 ? syncTimeout : 800
    const local = new LocalBackend({
      dataDir: extra.dataDir || '',
      useWorker: extra.useWorker !== false,
      timeoutMs: cfg?.timeoutMs || 1200,
      log: extra.log,
      config: extra.config,
      getLlm: extra.getLlm,
      getSelection: extra.getSelection,
    })
    const http = new HttpBackend({
      baseUrl: cfg.url || '',
      timeoutMs: httpTimeoutMs,
      token: extra.token || '',
      log: extra.log || (() => {}),
    })
    return new HybridBackend({ local, http, config: extra.config, log: extra.log || (() => {}), httpTimeoutMs })
  }
  return new LocalBackend({
    dataDir: extra.dataDir || '',
    useWorker: extra.useWorker !== false,
    timeoutMs: cfg?.timeoutMs || 1200,
    log: extra.log,
    config: extra.config,
    getLlm: extra.getLlm,
    getSelection: extra.getSelection,
  })
}
