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
import { search as searchDb } from './search.js'
import { planBudget, trimHits } from './budget.js'
import { applyNeighborNotes, relationStats } from './relations.js'
import { computeMetrics } from './metrics.js'
import { memoryPressure } from '../host/memory-guard.js'
import { bool } from '../host/config-values.js'
import { createWriteQueue, recordWrite } from './writer.js'
import { DbWorkerClient } from './workers/client.js'

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

const NODE_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'hits', 'last_hit_at', 'vector_state',
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
 */
const IMPORT_INSERT_SQL = `INSERT INTO nodes
  (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
   context_note,weight,hits,last_hit_at,vector_state,origin,trace_id,valid_at,invalid_at,expired_at,
   superseded_by,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

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
function landImportRows(db, items, { insert, exists, dryRun = false }) {
  let added = 0
  let skipped = 0
  for (const item of items) {
    const node = item.node
    if (exists.get(node.text_hash, node.user_id, node.role_id, node.workspace)) { skipped += 1; continue }
    if (!dryRun) {
      insert.run(
        node.id, node.text, node.text_hash, node.text_bigrams,
        node.level, node.memory_type, node.source, node.status,
        node.role_id, node.user_id, node.workspace, node.tags,
        node.context_note, node.weight, node.hits, node.last_hit_at,
        node.vector_state, node.origin, node.trace_id,
        node.valid_at, node.invalid_at, node.expired_at, node.superseded_by,
        node.created_at, node.updated_at,
      )
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
   * @param {{ dataDir?: string, useWorker?: boolean, log?: (s:string)=>void, timeoutMs?: number }} [opts]
   */
  constructor({ dataDir = '', useWorker = true, log = () => {}, timeoutMs = 1200, config = null } = {}) {
    this.dataDir = dataDir
    this.log = log
    this.useWorker = useWorker !== false
    this.timeoutMs = timeoutMs
    this.db = null
    this.dbPath = ''
    this.worker = null
    this.closed = false
    // 写入决策要读实时配置（shadow/auto 面板可改），因此持 getter 而不是快照。
    // 无配置（单测/直连）默认 auto：旧行为不变；生产由 index.js 注入实时配置（默认 shadow）。
    this._config = config
      ? (typeof config === 'function' ? config : () => config)
      : () => ({ write: { reviewMode: 'auto' } })
    this.writeQueue = null
    /** @type {Map<string,{lines:string[],next:number,added:number,skipped:number,errors:number,kept:number,splitLines:number,reasons:object,errorDetails:object[],total:number,identity:any,failed:boolean}>} */
    this._imports = new Map()
  }

  get ready() { return true }

  _db() {
    if (this.closed) throw new Error('backend_disposed')
    if (!this.db) {
      this.db = openDb(this.dataDir || undefined)
      this.dbPath = this.db.prepare('PRAGMA database_list').get()?.file || this.dbPath
      setMeta(this.db, 'boot_id', String(process.pid))
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
      this.writeQueue = createWriteQueue({ store: this, config: this._config, log: this.log })
    }
    return this.writeQueue
  }

  /** 续跑遗留的写队列 job（keeper 的 write handler / 启动补偿用）。 */
  async drainWrites() {
    return this._writer().drain()
  }

  /** shadow 候选审核（面板「写入」页）。 */
  reviewWrite(id, decision, reason) {
    return this._writer().review(id, decision, reason)
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
      },
      metrics: { day: metrics.day, values: metrics.values, targets: metrics.targets },
      series: metrics.series,
      schema_version: getMeta(db, 'schema_version'),
      generated_at: new Date().toISOString(),
    }
  }

  async recent(limit = 3) {
    const db = this._db()
    const rows = db.prepare(
      'SELECT ts,query,hit_ids,chars,injected,elapsed_ms FROM recalls ORDER BY ts DESC LIMIT ?',
    ).all(Math.max(1, Math.min(10, Number(limit) || 3)))
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
   * @param {{ query:string, maxHits:number, identity:Identity, minRel?:number,
   *   source?:string, traceId?:string, charBudget?:number, intentBudget?:boolean }} q
   */
  async recall(q, signal) {
    const started = Date.now()
    // 意图预算（架构书 §5.4）：闲聊/排障/回忆分档；画图链路 0 注入。
    const budget = planBudget(q?.query, {
      intentBudget: q?.intentBudget,
      maxHits: q?.maxHits ?? 5,
      charBudget: q?.charBudget,
    })
    // 调用方标来源（hook / panel-test / search...）；截 32 与 writes.source 口径一致。
    const source = String(q?.source || 'hook').slice(0, 32)
    /**
     * 落审计行。hit_ids 记录的是**检索命中集合**（并非最终注入集合）：只有把"命中了
     * 但被预算裁掉/丢弃"也留下来，日报才能列出"命中但未注入"的低分候选。
     * 注入与否由 injected/chars 表达，两者不混在同一个字段里。
     * @param {{ hitIds?: string[], chars?: number, injected?: number }} row
     */
    const audit = ({ hitIds = [], chars = 0, injected = 0 }) => {
      try {
        const db = this._db()
        db.prepare(`INSERT INTO recalls
          (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          now(), String(q?.traceId || ''), String(q?.query || '').slice(0, 500),
          JSON.stringify(hitIds), chars, injected,
          // used 先留 0：回复引用信号未接入（backlog），adoptionRate 在接入前必然显示
          // "未采纳"，这比编一个假信号或干脆不落库都可解释。
          0,
          Date.now() - started,
          String(q?.identity?.userId || ''), String(q?.identity?.roleId || ''), String(q?.identity?.workspace || ''),
          source,
        )
      } catch (err) {
        this.log(`[whale-memory] recall audit fail-open: ${err?.message || err}`)
      }
    }

    if (budget.maxHits <= 0 || budget.charBudget <= 0) {
      audit({})
      return { ok: true, prefix: '', chars: 0, hits: 0, intent: budget.intent }
    }
    const result = await this.search({
      query: q?.query, limit: budget.maxHits, identity: q?.identity, minRel: q?.minRel,
      diffusion: q?.diffusion, minConf: q?.minConf,
    }, signal)
    const searched = Array.isArray(result?.hits) ? result.hits : []
    const trimmed = trimHits(searched, budget)
    const hits = trimmed.hits
    const prefix = hits.length
      ? '【你想到的旧事】\n' + hits.map((h) => `- ${String(h.text || '').trim()}`).join('\n')
      : ''
    audit({
      hitIds: searched.map((h) => h.id),
      chars: prefix.length,
      injected: prefix ? 1 : 0,
    })
    return {
      ok: true, prefix, chars: prefix.length, hits: hits.length,
      intent: budget.intent, dropped: trimmed.dropped, clipped: trimmed.clipped,
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

  /** 反思素材：最近 episodic（只读）。 */
  async listEpisodic(limit = 20) {
    const db = this._db()
    const rows = db.prepare("SELECT id,text,created_at,tags FROM nodes WHERE status='active' AND memory_type='episodic' ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(50, Number(limit) || 20)))
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
      'SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? LIMIT 1',
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

  /** @param {{ identity:Identity, limit:number, offset:number }} q */
  async nodes(q = {}) {
    const db = this._db()
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20))
    const offset = Math.max(0, Number(q.offset) || 0)
    const total = Number(db.prepare('SELECT count(*) AS n FROM nodes').get()?.n || 0)
    const rows = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
    return { items: rows, total }
  }

  /** 单节点详情：面板抽屉用。 */
  async getNode(id) {
    const db = this._db()
    const row = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes WHERE id=?`).get(String(id || ''))
    return row ? { ok: true, node: row } : { ok: false, error: 'node_not_found' }
  }

  /** 面板编辑/归档：只改白名单字段，重算 hash/bigrams。 */
  async updateNode(id, patch = {}) {
    const db = this._db()
    const row = db.prepare('SELECT * FROM nodes WHERE id=?').get(String(id || ''))
    if (!row) return { ok: false, error: 'node_not_found' }
    const text = patch.text === undefined ? row.text : normalize(String(patch.text))
    if (!text || text.length > 500) return { ok: false, error: 'invalid_text' }
    const status = patch.status === undefined ? row.status : String(patch.status)
    if (!['active', 'archived', 'stale', 'superseded'].includes(status)) return { ok: false, error: 'invalid_status' }
    const level = patch.level === undefined ? row.level : String(patch.level)
    if (!['core', 'important', 'normal'].includes(level)) return { ok: false, error: 'invalid_level' }
    const tags = patch.tags === undefined ? row.tags : JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])
    const hash = contentHash(text)
    db.prepare('UPDATE nodes SET text=?,text_hash=?,text_bigrams=?,status=?,level=?,tags=?,updated_at=? WHERE id=?')
      .run(text, hash, bigrams(text), status, level, tags, now(), String(id))
    return { ok: true, id: String(id) }
  }

  /** 最近写入审计（只读）；action 过滤用于面板只看 shadow 候选。 */
  async writes(limit = 20, action = '') {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 20))
    const rows = action
      ? db.prepare('SELECT id,ts,trace_id,action,node_id,reason,before_text,after_text,mode,user_id,role_id,workspace FROM writes WHERE action=? ORDER BY ts DESC LIMIT ?').all(String(action), lim)
      : db.prepare('SELECT id,ts,trace_id,action,node_id,reason,before_text,after_text,mode,user_id,role_id,workspace FROM writes ORDER BY ts DESC LIMIT ?').all(lim)
    return { items: rows }
  }

  /** 关系统计 + 最近边（面板 /edges）。 */
  async edges(limit = 50) {
    const db = this._db()
    const stat = relationStats(db)
    const items = db.prepare('SELECT id,from_id,to_id,etype,source,conf,weight,created_at FROM edges ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 50)))
    return { ok: true, ...stat, items }
  }

  /** 演化审计（面板 /evolution）。 */
  async evolution(limit = 50) {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 50))
    const items = db.prepare('SELECT id,ts,from_id,to_id,field,old_value,new_value,trace_id FROM evolution ORDER BY id DESC LIMIT ?').all(lim)
    return { ok: true, items }
  }

  /**
   * 最近召回审计（只读）：面板过滤与日报复盘共用同一个入口。
   *
   * 过滤参数全部走 SQL 占位符；filter 只认白名单（zero/unused），
   * 未知值按"不过滤"处理——面板多传一个键不能把整页查空。
   *
   * @param {number} [limit] 1..100（越界夹取；非正数回落 20）
   * @param {{ source?: string, since?: number, filter?: 'zero'|'unused'|'' }} [opts]
   *   source: 精确匹配来源（截 32）；since: 秒级下界；filter: zero=零命中 / unused=已注入未采纳
   * @returns {{ items: Array<{ id:number, ts:number, trace_id:string, query:string,
   *   hit_ids:string, chars:number, injected:number, used:number, elapsed_ms:number|null,
   *   source:string, hits:number }> }}
   */
  async recalls(limit = 20, opts = {}) {
    const db = this._db()
    const raw = Number(limit)
    const lim = Math.max(1, Math.min(100, Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
    const where = []
    const args = []
    const source = String(opts?.source ?? '').slice(0, 32)
    if (source) { where.push('source = ?'); args.push(source) }
    const since = Number(opts?.since)
    if (Number.isFinite(since)) { where.push('ts >= ?'); args.push(since) }
    if (opts?.filter === 'zero') where.push("hit_ids IN ('[]','')")
    else if (opts?.filter === 'unused') where.push('injected = 1 AND used = 0')
    const sql = `SELECT id,ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,source FROM recalls${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`
    const rows = db.prepare(sql).all(...args, lim)
    return { items: rows.map((r) => ({ ...r, hits: hitIdsCount(r.hit_ids) })) }
  }

  /**
   * 异步分片导入：>50 行返回 202 + jobId；每批 50 条、用 setImmediate 让出事件循环。
   * 与同步导入共用 planImportRows / landImportRows（保真字段、长文本拆分、FTS 闸门口径一致）。
   * @param {{ jsonl:string, identity?:Identity }} q
   */
  async startImport(q) {
    const db = this._db()
    const lines = String(q?.jsonl || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const ts = now()
    const payload = {
      total: lines.length, added: 0, skipped: 0, errors: 0, kept: 0, split: 0, rejected: 0,
      reasons: {}, error_details: [],
    }
    const created = db.prepare('INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('import', 'queued', 0, JSON.stringify(payload), ts, ts)
    const jobId = String(created.lastInsertRowid)
    this._imports.set(jobId, {
      lines, next: 0, added: 0, skipped: 0, errors: 0, kept: 0, splitLines: 0,
      reasons: {}, errorDetails: [], total: lines.length, identity: q?.identity || {}, failed: false,
    })
    this._runImport(jobId)
    return { ok: true, async: true, jobId, total: lines.length }
  }

  /** 按批推进异步导入（每批 50 行；FTS 闸门不一致则整批回滚并终止，不继续污染索引）。 */
  _runImport(jobId) {
    const job = this._imports.get(jobId)
    if (!job || this.closed) return
    const db = this._db()
    db.prepare("UPDATE jobs SET state='running', updated_at=? WHERE id=?").run(now(), Number(jobId))
    const ident = job.identity || {}
    const ts = now()
    const insert = db.prepare(IMPORT_INSERT_SQL)
    const exists = db.prepare('SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? LIMIT 1')
    const batch = job.lines.slice(job.next, job.next + 50)
    const batchStart = job.next
    job.next += batch.length

    /** @type {Array<{ node: object, split: boolean }>} */
    const items = []
    batch.forEach((line, i) => {
      const index = batchStart + i
      let row
      try {
        row = JSON.parse(line)
      } catch {
        job.errors += 1
        job.reasons.invalid_json = (job.reasons.invalid_json || 0) + 1
        if (job.errorDetails.length < ERROR_DETAIL_LIMIT) {
          job.errorDetails.push({ index, reason: 'invalid_json', text_hash: contentHash(line).slice(0, 12) })
        }
        return
      }
      const plan = planImportRows(row, ident, { ts, seq: index })
      if (plan.kind === 'error') {
        job.errors += 1
        job.reasons[plan.reason] = (job.reasons[plan.reason] || 0) + 1
        if (job.errorDetails.length < ERROR_DETAIL_LIMIT) {
          job.errorDetails.push({ index, reason: plan.reason, text_hash: plan.textHash.slice(0, 12) })
        }
        return
      }
      if (plan.split) job.splitLines += 1
      else job.kept += 1
      for (const node of plan.rows) items.push({ node, split: plan.split === true })
    })

    try {
      db.exec('BEGIN IMMEDIATE')
      const { added, skipped } = landImportRows(db, items, { insert, exists })
      if (!ftsAligned(db)) {
        db.exec('ROLLBACK')
        job.failed = true
        job.errors += items.length
        job.reasons.fts_misaligned = (job.reasons.fts_misaligned || 0) + 1
        if (job.errorDetails.length < ERROR_DETAIL_LIMIT) {
          job.errorDetails.push({ index: batchStart, reason: 'fts_misaligned', text_hash: '' })
        }
      } else {
        db.exec('COMMIT')
        job.added += added
        job.skipped += skipped
      }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* noop */ }
      job.errors += batch.length
      this.log(`[whale-memory] import batch fail: ${err?.message || err}`)
    }

    const payload = JSON.stringify({
      total: job.total, added: job.added, skipped: job.skipped, errors: job.errors,
      kept: job.kept, split: job.splitLines, rejected: job.errors,
      reasons: job.reasons, error_details: job.errorDetails,
    })
    const done = job.failed || job.next >= job.total
    db.prepare('UPDATE jobs SET state=?, payload=?, last_error=?, updated_at=? WHERE id=?')
      .run(
        job.failed ? 'failed' : done ? 'done' : 'running',
        payload,
        job.failed ? 'fts_misaligned' : job.errors ? 'partial_errors' : null,
        now(), Number(jobId),
      )
    if (done) { this._imports.delete(jobId); return }
    setImmediate(() => this._runImport(jobId))
  }

  async importStatus(jobId) {
    const db = this._db()
    const row = db.prepare('SELECT id,kind,state,payload,last_error,created_at,updated_at FROM jobs WHERE id=?').get(Number(jobId))
    if (!row) return { ok: false, error: 'job_not_found' }
    let payload = {}
    try { payload = JSON.parse(row.payload || '{}') } catch { payload = {} }
    return { ok: true, job: { id: row.id, kind: row.kind, state: row.state, ...payload, last_error: row.last_error, updated_at: row.updated_at } }
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

/** 外部服务客户端（S1 保留；只读四接口）。 */
export class HttpBackend {
  constructor({ baseUrl, timeoutMs = 3000, token = '', log = () => {} }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.token = token
    this.log = log
  }

  get ready() { return Boolean(this.baseUrl) }

  async request(path, opts = {}) {
    if (!this.ready) return null
    const { method = 'GET', body, signal, timeoutMs = this.timeoutMs } = opts
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(this.baseUrl + path, {
        method, signal: combined,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) return null
      const text = await res.text()
      if (text.length > 2 * 1024 * 1024) return null
      return JSON.parse(text)
    } catch (err) {
      this.log(`[whale-memory] backend ${method} ${path} fail-open: ${err?.name || err?.message || 'error'}`)
      return null
    }
  }

  async stats(signal) { return this.request('/stats', { signal }) }
  async recent(limit, signal) { return this.request(`/recent?limit=${encodeURIComponent(limit)}`, { signal }) }
  async search(q, signal) { return this.request('/search', { method: 'POST', body: q, signal }) }
  async recall(q, signal) { return this.request('/recall', { method: 'POST', body: q, signal }) }
}

/** @param {{ mode?: string, url?: string, timeoutMs?: number }} cfg @param {{ token?: string, log?: Function, dataDir?: string, useWorker?: boolean }} [extra] */
export function createBackend(cfg, extra = {}) {
  if (cfg?.mode === 'http' || cfg?.mode === 'hybrid') {
    return new HttpBackend({ baseUrl: cfg.url || '', timeoutMs: cfg.timeoutMs || 3000, ...extra })
  }
  return new LocalBackend({
    dataDir: extra.dataDir || '',
    useWorker: extra.useWorker !== false,
    timeoutMs: cfg?.timeoutMs || 1200,
    log: extra.log,
    config: extra.config,
  })
}
