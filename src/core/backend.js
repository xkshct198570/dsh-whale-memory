/**
 * MemoryBackend（S2）：LocalSqliteBackend 为默认真源；HttpBackend 保留给外部服务。
 *
 * 主线程零大批量检索：search/recall 走 DbWorkerClient（worker_threads，1200ms 超时）；
 * 写入/导入/导出仍在主线程短事务（≤20/批），因为写需要单写者一致性。
 * 所有失败 fail-open：检索失败返回 null/空结果，不阻塞对话。
 */
import { closeDb, getMeta, now, openDb, setMeta } from './db.js'
import { bigrams, contentHash, normalize } from './tokenize.js'
import { search as searchDb } from './search.js'
import { DbWorkerClient } from './workers/client.js'

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

const NODE_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'created_at', 'updated_at', 'valid_at', 'invalid_at',
  'expired_at', 'superseded_by', 'origin', 'trace_id', 'text_hash',
]

export class LocalBackend {
  /**
   * @param {{ dataDir?: string, useWorker?: boolean, log?: (s:string)=>void, timeoutMs?: number }} [opts]
   */
  constructor({ dataDir = '', useWorker = true, log = () => {}, timeoutMs = 1200 } = {}) {
    this.dataDir = dataDir
    this.log = log
    this.useWorker = useWorker !== false
    this.timeoutMs = timeoutMs
    this.db = null
    this.dbPath = ''
    this.worker = null
    this.closed = false
    /** @type {Map<string,{lines:string[],next:number,added:number,skipped:number,errors:number,total:number,identity:any}>} */
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

  async stats() {
    const db = this._db()
    const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
    return {
      totals: {
        nodes_total: one('SELECT count(*) AS n FROM nodes'),
        nodes_active: one("SELECT count(*) AS n FROM nodes WHERE status='active'"),
        edges: one('SELECT count(*) AS n FROM edges'),
      },
      schema_version: getMeta(db, 'schema_version'),
      generated_at: new Date().toISOString(),
    }
  }

  async recent(limit = 3) {
    const db = this._db()
    const rows = db.prepare(
      'SELECT ts,hit_ids,chars,injected,elapsed_ms FROM recalls ORDER BY ts DESC LIMIT ?',
    ).all(Math.max(1, Math.min(10, Number(limit) || 3)))
    return { items: rows.map((r) => ({
      ts: r.ts, hits: (JSON.parse(r.hit_ids || '[]')).length, chars: r.chars,
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
   * @param {{ query:string, maxHits:number, identity:Identity, minRel?:number }} q
   */
  async recall(q, signal) {
    const started = Date.now()
    const result = await this.search({ query: q?.query, limit: q?.maxHits ?? 5, identity: q?.identity, minRel: q?.minRel }, signal)
    const hits = (result?.hits || []).slice(0, Math.max(0, Number(q?.maxHits ?? 5)))
    const prefix = hits.length
      ? '【你想到的旧事】\n' + hits.map((h) => `- ${String(h.text || '').trim()}`).join('\n')
      : ''
    if (prefix) {
      try {
        const db = this._db()
        db.prepare(`INSERT INTO recalls
          (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          now(), String(q?.traceId || ''), String(q?.query || '').slice(0, 500),
          JSON.stringify(hits.map((h) => h.id)), prefix.length, 1, 0,
          Date.now() - started,
          String(q?.identity?.userId || ''), String(q?.identity?.roleId || ''), String(q?.identity?.workspace || ''),
          'hook',
        )
      } catch (err) {
        this.log(`[whale-memory] recall audit fail-open: ${err?.message || err}`)
      }
    }
    return { ok: true, prefix, chars: prefix.length, hits: hits.length }
  }

  /** @param {{ text:string, level?:string, memory_type?:string, tags?:string[], identity:Identity }} q */
  async write(q) {
    const text = normalize(String(q?.text || ''))
    if (!text) return { ok: false, error: 'invalid_text' }
    if (text.length > 500) return { ok: false, error: 'text_too_long' }
    const db = this._db()
    const hash = contentHash(text)
    const ident = q?.identity || {}
    const dup = db.prepare(
      "SELECT id FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1",
    ).get(hash, String(ident.userId || ''), String(ident.roleId || ''), String(ident.workspace || ''))
    if (dup) return { ok: true, id: String(dup.id), duplicate: true }
    const ts = now()
    const id = `n${Date.now()}_${hash.slice(0, 10)}`
    const tags = Array.isArray(q.tags) ? q.tags.filter((x) => typeof x === 'string').slice(0, 32) : []
    db.prepare(`INSERT INTO nodes
      (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
       context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, text, hash, bigrams(text), q.level || 'normal', q.memory_type || 'semantic',
      'owner', 'active', String(ident.roleId || ''), String(ident.userId || ''), String(ident.workspace || ''),
      JSON.stringify(tags), '', 1, 0, 'none', 'panel', String(q.traceId || ''), ts, ts,
    )
    return { ok: true, id }
  }

  /** @param {{ jsonl:string, identity:Identity, dryRun?:boolean }} q */
  async importJsonl(q) {
    const db = this._db()
    const lines = String(q?.jsonl || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const ident = q?.identity || {}
    let added = 0; let skipped = 0; let errors = 0
    const ts = now()
    const insert = db.prepare(`INSERT INTO nodes
      (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
       context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,1,0,'none',?,?,?,?)`)
    const exists = db.prepare(
      "SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1",
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const line of lines) {
        let row
        try { row = JSON.parse(line) } catch { errors += 1; continue }
        const text = normalize(String(row?.text || ''))
        if (!text || text.length > 500) { errors += 1; continue }
        const hash = contentHash(text)
        const u = String(row?.user_id ?? ident.userId ?? '')
        const r = String(row?.role_id ?? ident.roleId ?? '')
        const w = String(row?.workspace ?? ident.workspace ?? '')
        if (exists.get(hash, u, r, w)) { skipped += 1; continue }
        if (q?.dryRun) { added += 1; continue }
        insert.run(
          String(row?.id || '') || `n${Date.now()}_${hash.slice(0, 10)}_${added}`,
          text, hash, bigrams(text),
          row?.level || 'normal', row?.memory_type || 'semantic', row?.source || 'import',
          r, u, w, JSON.stringify(Array.isArray(row?.tags) ? row.tags : []), '',
          String(row?.origin || 'import'), String(row?.trace_id || ''),
          Number(row?.created_at) || ts, Number(row?.updated_at) || ts,
        )
        added += 1
      }
      db.exec(q?.dryRun ? 'ROLLBACK' : 'COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* noop */ }
      throw err
    }
    return { added, skipped, errors, dryRun: Boolean(q?.dryRun) }
  }

  /** @param {{ identity:Identity }} [q] */
  async exportJsonl(q = {}) {
    const db = this._db()
    const rows = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes ORDER BY created_at, id`).all()
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

  /** 最近写入审计（只读）。 */
  async writes(limit = 20) {
    const db = this._db()
    const rows = db.prepare('SELECT id,ts,trace_id,action,node_id,reason,mode,user_id,role_id,workspace FROM writes ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    return { items: rows }
  }

  /** 最近召回审计（只读）。 */
  async recalls(limit = 20) {
    const db = this._db()
    const rows = db.prepare('SELECT id,ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,source FROM recalls ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
    return { items: rows.map((r) => ({ ...r, hits: (JSON.parse(r.hit_ids || '[]')).length })) }
  }

  /**
   * 异步分片导入：>50 行返回 202 + jobId；每批 50 条、用 setImmediate 让出事件循环。
   * @param {{ jsonl:string, identity:Identity }} q
   */
  async startImport(q) {
    const db = this._db()
    const lines = String(q?.jsonl || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const ts = now()
    const created = db.prepare('INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('import', 'queued', 0, JSON.stringify({ total: lines.length, added: 0, skipped: 0, errors: 0 }), ts, ts)
    const jobId = String(created.lastInsertRowid)
    this._imports.set(jobId, { lines, next: 0, added: 0, skipped: 0, errors: 0, total: lines.length, identity: q?.identity || {} })
    this._runImport(jobId)
    return { ok: true, async: true, jobId, total: lines.length }
  }

  _runImport(jobId) {
    const job = this._imports.get(jobId)
    if (!job || this.closed) return
    const db = this._db()
    db.prepare("UPDATE jobs SET state='running', updated_at=? WHERE id=?").run(now(), Number(jobId))
    const ident = job.identity || {}
    const insert = db.prepare(`INSERT INTO nodes
      (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
       context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,1,0,'none',?,?,?,?)`)
    const exists = db.prepare("SELECT 1 FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1")
    const batch = job.lines.slice(job.next, job.next + 50)
    job.next += batch.length
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const line of batch) {
        let row
        try { row = JSON.parse(line) } catch { job.errors += 1; continue }
        const text = normalize(String(row?.text || ''))
        if (!text || text.length > 500) { job.errors += 1; continue }
        const hash = contentHash(text)
        const u = String(row?.user_id ?? ident.userId ?? '')
        const r = String(row?.role_id ?? ident.roleId ?? '')
        const w = String(row?.workspace ?? ident.workspace ?? '')
        if (exists.get(hash, u, r, w)) { job.skipped += 1; continue }
        insert.run(
          String(row?.id || '') || `n${Date.now()}_${hash.slice(0, 10)}_${job.added}`,
          text, hash, bigrams(text), row?.level || 'normal', row?.memory_type || 'semantic', row?.source || 'import',
          r, u, w, JSON.stringify(Array.isArray(row?.tags) ? row.tags : []), '',
          String(row?.origin || 'import'), String(row?.trace_id || ''),
          Number(row?.created_at) || now(), Number(row?.updated_at) || now(),
        )
        job.added += 1
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* noop */ }
      job.errors += batch.length
      this.log(`[whale-memory] import batch fail: ${err?.message || err}`)
    }
    const payload = JSON.stringify({ total: job.total, added: job.added, skipped: job.skipped, errors: job.errors })
    const done = job.next >= job.total
    db.prepare('UPDATE jobs SET state=?, payload=?, last_error=?, updated_at=? WHERE id=?')
      .run(done ? 'done' : 'running', payload, job.errors ? 'partial_errors' : null, now(), Number(jobId))
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
  })
}
