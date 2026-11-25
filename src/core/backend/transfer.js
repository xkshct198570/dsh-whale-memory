// 职责：backend 导入导出域——JSONL 导入（拆分/白名单/幂等/进度/job）、导出、FTS 对齐闸。
// 依赖方向：base（字段白名单/身份闸）← 本文件；落库审计走 writer 门面，本地连接经 this._db() 取。

/** @typedef {import('./base.js').Identity} Identity */

import { getMeta, now, setMeta } from '../db.js'
import { bigrams, contentHash, normalize } from '../tokenize.js'
import { isActiveHashConflict, recordWrite } from '../writer.js'
import { NODE_EXPORT_FIELDS, identityFilter } from './base.js'

/** @typedef {import('./backend/base.js').Identity} Identity */

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

export const transferApi = {

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
  },

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
  },

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
  },

  /** 续跑一条 import job（startImport 首跑 / keeper 崩溃恢复都走；进度在 meta，可重复调用）。 */
  async resumeImportJob(jobId) {
    return this._resumeImportJob(jobId)
  },

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
  },

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
  },

}
