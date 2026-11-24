/**
 * Hybrid 后端（审计 §4 P1）：本地 SQLite 为真源，HTTP 远端为副本。
 *
 * 三条硬口径（Why）：
 * - 读：HTTP 主（超时用 `Config.sync.httpTimeoutMs`，默认 800ms）→ 失败/超时回退本地。
 *   读失败永远不能让对话阻塞；回退次数必须可观测（stats.sync.http_fallbacks），
 *   否则"远端一直挂着"在面板上看起来和"一切正常"一样。
 * - 写：先写 LocalBackend（本地缓存为真源，不丢），再向本地库 sync_outbox 入队一条
 *   `op='upsert'` 行（节点快照 JSON）。写接口显式失败：本地写失败直接返回 `{ok:false}`，
 *   outbox 入队失败只记在返回值里（本地已落库，缓存不能因为排队失败而回滚）。
 * - flushOutbox：queued → running 领取 → HttpBackend.write → done；失败指数退避重排
 *   （attempts++ / next_at），上限 8 次后 failed。全程不抛，面板/watchdog 共用。
 *
 * 冲突：远端回 `{action:'conflict'}` 或 `{conflict:true}` 时，把本地节点 status 置 'stale'
 * 并把 outbox 行标 failed + last_error 保存证据（payload 快照保留），不静默覆盖远端事实。
 *
 * 持久化：outbox 行在 SQLite 里，进程重启后重建 backend 仍会续跑未完成的行；
 * 构造时把上次崩溃遗留的 running 行复位成 queued（同一 dataDir 只允许一个实例在跑）。
 */
import { now } from './db.js'

/** 同步任务重试上限：8 次后判 failed（与 keeper/jobs 的口径一致：可观测、不无限重试）。 */
export const OUTBOX_MAX_ATTEMPTS = 8
/** 单次 flush 默认领取上限。 */
const DEFAULT_FLUSH_LIMIT = 50
/** Config.sync.httpTimeoutMs 的代码默认值（与 schemastery 默认一致）。 */
const DEFAULT_HTTP_TIMEOUT_MS = 800
/** watchdog 周期（30s）。 */
export const OUTBOX_WATCHDOG_INTERVAL_MS = 30_000
/** 指数退避秒：attempts=1 → 1s，2 → 2s，3 → 4s … 封顶 300s。 */
const BACKOFF_CAP_SEC = 300

/** schemastery Ref 解包（core 不 import host，与 backend.js 同一口径）。 */
function plain(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/** 读接口第二参数兼容：AbortSignal（hook 旧写法）或 { signal, timeoutMs, identity } 选项对象。 */
function callOpts(opts) {
  if (!opts || typeof opts !== 'object') return {}
  if (typeof opts.addEventListener === 'function' && typeof opts.aborted === 'boolean') return { signal: opts }
  return { ...opts }
}

function nowSec() {
  return Date.now() / 1000
}

function stringifyDetail(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/**
 * 本地真源 + 远端副本 + 持久 outbox。
 *
 * 显式接收 local/http 实例（不在本模块 import backend.js），避免 backend.js
 * 与本文件形成静态循环依赖；工厂 `createBackend` 负责组装。
 */
export class HybridBackend {
  /**
   * @param {{ local: object, http?: object|null, config?: object|Function|null, log?: Function,
   *   httpTimeoutMs?: number }} opts
   */
  constructor({ local, http = null, config = null, log = () => {}, httpTimeoutMs = 0 } = {}) {
    if (!local || typeof local.withDb !== 'function') throw new TypeError('hybrid: local backend required')
    this.local = local
    this.http = http
    this.mode = 'hybrid'
    this.log = typeof log === 'function' ? log : () => {}
    this.closed = false
    this._configSource = config
    this._timeoutOverride = Number.isFinite(Number(httpTimeoutMs)) && Number(httpTimeoutMs) > 0
      ? Number(httpTimeoutMs)
      : 0
    /** 读回退观测：total 与按方法计数，stats.sync 直接渲染。 */
    this.fallbacks = { total: 0, byMethod: /** @type {Record<string, number>} */ ({}), last: null }
    /** 上一次 recall 的来源：'http' | 'local'（采纳回写要回到同一侧）。 */
    this._lastRecall = 'local'
    this._recovered = false
    try { this._recoverRunning() } catch (err) { this.log(`[whale-memory] outbox recover deferred: ${err?.message || err}`) }
  }

  get ready() { return !this.closed && Boolean(this.local?.ready) }

  /**
   * 运行中补 token：转发到 HTTP 客户端（凭证服务异步解析，构造时拿不到）。
   * @param {string} token
   * @returns {{ ok: boolean }}
   */
  setToken(token) {
    if (this.http && typeof this.http.setToken === 'function') return this.http.setToken(token)
    return { ok: false }
  }

  /** 协议状态透传（面板与 stats 用）。 */
  get protocolStatus() {
    return this.http?.protocolStatus || null
  }

  /** outbox 计数（`GET /version`、`/stats` 的只读出口；local/http 模式没有这个 getter）。 */
  get outbox() {
    return this._outboxStats()
  }

  get dbFile() { return this.local?.dbFile || '' }

  _config() {
    const c = typeof this._configSource === 'function' ? this._configSource() : this._configSource
    return c && typeof c === 'object' ? c : {}
  }

  /** 本次 HTTP 调用预算：显式覆盖 > 实时 Config.sync.httpTimeoutMs > 800ms。 */
  _timeoutMs() {
    if (this._timeoutOverride > 0) return this._timeoutOverride
    const n = Number(plain(this._config()?.sync?.httpTimeoutMs))
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTP_TIMEOUT_MS
  }

  _httpReady() {
    return Boolean(this.http && this.http.ready)
  }

  _noteFallback(method, reason) {
    this.fallbacks.total += 1
    this.fallbacks.byMethod[method] = (Number(this.fallbacks.byMethod[method]) || 0) + 1
    this.fallbacks.last = { method, reason: String(reason || 'error'), at: Date.now() / 1000 }
  }

  _db() {
    return this.local.withDb((db) => db)
  }

  /** 崩溃补偿：上次进程留下的 running 行复位 queued（只做一次）。 */
  _recoverRunning() {
    if (this._recovered || this.closed) return
    this.local.withDb((db) => {
      db.prepare("UPDATE sync_outbox SET state='queued', updated_at=? WHERE state='running'").run(nowSec())
    })
    this._recovered = true
  }

  /** outbox 计数（面板/stats 共用；表缺失也返回 0，不阻断统计）。 */
  _outboxStats() {
    try {
      const db = this._db()
      const count = (state) => Number(db.prepare('SELECT count(*) AS n FROM sync_outbox WHERE state=?').get(state)?.n || 0)
      const oldest = db.prepare("SELECT min(created_at) AS t FROM sync_outbox WHERE state IN ('queued','running')").get()?.t
      const age = oldest === null || oldest === undefined ? 0 : Math.max(0, Math.floor(nowSec() - Number(oldest)))
      return { queued: count('queued'), running: count('running'), failed: count('failed'), oldestAgeSec: age }
    } catch {
      return { queued: 0, running: 0, failed: 0, oldestAgeSec: 0 }
    }
  }

  _syncHealth() {
    const protocol = this.http?.protocolStatus || { ok: false, protocol: null, expected: null, mismatch: null, checked_at: null }
    return {
      http_ready: this._httpReady(),
      http_timeout_ms: this._timeoutMs(),
      http_fallbacks: this.fallbacks.total,
      fallback_by_method: { ...this.fallbacks.byMethod },
      last_fallback: this.fallbacks.last,
      protocol: protocol.protocol,
      protocol_expected: protocol.expected,
      protocol_mismatch: protocol.mismatch,
      protocol_checked_at: protocol.checked_at,
    }
  }

  /** stats 装饰：并入 outbox 与 hybrid 观测字段，原有字段一律不删/不改。 */
  _decorateStats(base) {
    const result = base && typeof base === 'object' ? base : {}
    const outbox = this._outboxStats()
    result.outbox = outbox
    if (!result.health || typeof result.health !== 'object') result.health = {}
    result.health.outbox = outbox
    result.health.sync = this._syncHealth()
    return result
  }

  /**
   * 读主路径：HTTP → null 时回退本地。
   * @param {'stats'|'recent'|'search'|'recall'} method
   * @param {any[]} args
   * @param {AbortSignal|{signal?:AbortSignal}} [opts] 调用选项（signal 可选）
   * @returns {Promise<any|null>} HTTP 结果；未命中/失败返回 null（由调用方回退）
   */
  async _httpRead(method, args, opts = {}) {
    if (!this._httpReady() || typeof this.http[method] !== 'function') {
      this._noteFallback(method, 'http_unavailable')
      return null
    }
    try {
      const out = await this.http[method](...args, { ...callOpts(opts), timeoutMs: this._timeoutMs() })
      if (out === null || out === undefined || out?.ok === false) {
        this._noteFallback(method, out === null || out === undefined ? 'remote_empty' : 'remote_error')
        return null
      }
      return out
    } catch (err) {
      this._noteFallback(method, 'remote_throw')
      this.log(`[whale-memory] hybrid ${method} fallback: ${err?.message || err}`)
      return null
    }
  }

  async stats(opts = {}) {
    try { this._recoverRunning() } catch { /* 统计不因补偿失败而挂 */ }
    const remote = await this._httpRead('stats', [], opts)
    const base = remote || await this.local.stats()
    return this._decorateStats(base)
  }

  async recent(limit = 3, opts = {}) {
    const remote = await this._httpRead('recent', [limit], opts)
    return remote || this.local.recent(limit, opts)
  }

  async search(q, opts = {}) {
    const remote = await this._httpRead('search', [q], opts)
    return remote || this.local.search(q, opts)
  }

  async recall(q, opts = {}) {
    const remote = await this._httpRead('recall', [q], opts)
    this._lastRecall = remote ? 'http' : 'local'
    return remote || this.local.recall(q, opts)
  }

  /**
   * 置顶规则只读本地真源：外部记忆服务协议里没有规则/置顶语义（R1 设计），
   * 远端即便有 stats 也不参与注入，避免"远端空表把本地规则清空"。
   * @param {{userId?:string, roleId?:string, workspace?:string}} identity
   * @param {{limit?:number}} [opts]
   */
  async pinnedRules(identity, opts = {}) {
    if (typeof this.local.pinnedRules !== 'function') return []
    try {
      return await this.local.pinnedRules(identity, opts)
    } catch (err) {
      this.log(`[whale-memory] pinnedRules fail-open: ${err?.message || err}`)
      return []
    }
  }

  /**
   * 采纳回写必须回到上次 recall 的同一侧。
   *
   * 远端没有 markRecallUsed 时**不得**回退本地：recallId 是远端审计行 id，
   * 写进本地 recalls 的 used 列只会随机污染本地同号行。返回显式不可用，由 hook
   * 记一条日志（采纳信号是观测数据，宁缺毋滥）。
   */
  markRecallUsed(recallId, used = true) {
    if (this._lastRecall === 'http') {
      if (typeof this.http?.markRecallUsed === 'function') return this.http.markRecallUsed(recallId, used)
      this.log('[whale-memory] adoption mark skipped: remote backend has no markRecallUsed')
      return { ok: false, updated: 0, error: 'mark_unavailable' }
    }
    return this.local.markRecallUsed(recallId, used)
  }

  /**
   * 写：本地为先（真源），再入 outbox。
   *
   * 本地写失败 → 原样返回显式失败；本地成功但节点快照/排队失败 → 仍 ok:true，
   * `outbox.error` 标记（缓存已落地，不能因排队故障丢掉本地事实）。
   *
   * @param {object} q 与 LocalBackend.write 同形
   */
  async write(q) {
    const localRes = await this.local.write(q)
    if (!localRes || localRes.ok === false) return localRes || { ok: false, error: 'local_write_failed' }
    if (!localRes.id) return { ...localRes, outbox: null }
    try {
      const snap = await this.local.getNode(localRes.id)
      if (!snap?.ok || !snap.node) return { ...localRes, outbox: { queued: false, error: 'node_snapshot_missing' } }
      const queued = this._enqueueUpsert(snap.node)
      return { ...localRes, outbox: queued }
    } catch (err) {
      this.log(`[whale-memory] hybrid outbox enqueue fail-open: ${err?.message || err}`)
      return { ...localRes, outbox: { queued: false, error: 'outbox_enqueue_failed' } }
    }
  }

  /**
   * 入队 upsert：同一节点已有 queued 行时复用并覆盖快照（真源是最新本地状态；
   * 反复编辑同一节点没必要排 N 条旧快照）。running 行不碰，避免覆盖 in-flight 任务。
   *
   * @param {object} node LocalBackend.getNode 的节点行
   * @returns {{ queued: boolean, id: number, reused: boolean }}
   */
  _enqueueUpsert(node) {
    const db = this._db()
    const nodeId = String(node?.id ?? '')
    if (!nodeId) throw new Error('outbox: node id required')
    const payload = JSON.stringify(node)
    const ts = nowSec()
    const existing = db.prepare(
      "SELECT id FROM sync_outbox WHERE node_id=? AND op='upsert' AND state='queued' ORDER BY id DESC LIMIT 1",
    ).get(nodeId)
    if (existing) {
      db.prepare("UPDATE sync_outbox SET payload=?, state='queued', next_at=?, updated_at=? WHERE id=?")
        .run(payload, ts, ts, existing.id)
      return { queued: true, id: Number(existing.id), reused: true }
    }
    const info = db.prepare(`INSERT INTO sync_outbox
      (op,node_id,payload,state,attempts,next_at,last_error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('upsert', nodeId, payload, 'queued', 0, ts, null, ts, ts)
    return { queued: true, id: Number(info.lastInsertRowid), reused: false }
  }

  /** 领取可跑行并置 running（单事务，避免两个 flusher 抢同一行）。 */
  _claim(limit) {
    const db = this._db()
    const ts = nowSec()
    const max = Math.max(1, Math.min(500, Math.floor(Number(limit) || DEFAULT_FLUSH_LIMIT)))
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare(
        "SELECT id,node_id,payload,attempts FROM sync_outbox WHERE state='queued' AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?",
      ).all(ts, max)
      const upd = db.prepare("UPDATE sync_outbox SET state='running', updated_at=? WHERE id=?")
      for (const row of rows) upd.run(ts, row.id)
      db.exec('COMMIT')
      return rows
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* noop */ }
      throw err
    }
  }

  _finishDone(id) {
    this._db().prepare("UPDATE sync_outbox SET state='done', next_at=NULL, last_error=NULL, updated_at=? WHERE id=?")
      .run(nowSec(), id)
  }

  /** @param {number} [attempts] 到达上限时把最终次数写回（失败行也要能看出重试了几次）。 */
  _finishFailed(id, detail, attempts = null) {
    this._db().prepare(`UPDATE sync_outbox
      SET state='failed', next_at=NULL, last_error=?, updated_at=?, attempts=COALESCE(?, attempts)
      WHERE id=?`).run(String(detail).slice(0, 500), nowSec(), attempts, id)
  }

  /**
   * 失败重排：attempts++ 并指数退避；到上限置 failed。
   * @returns {'retry'|'failed'}
   */
  _retry(row, errorText) {
    const attempts = Number(row.attempts || 0) + 1
    const text = String(errorText || 'write_failed').slice(0, 300)
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      this._finishFailed(row.id, `attempts_exhausted: ${text}`, attempts)
      return 'failed'
    }
    const delay = Math.min(BACKOFF_CAP_SEC, 2 ** (attempts - 1))
    this._db().prepare("UPDATE sync_outbox SET state='queued', attempts=?, next_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(attempts, nowSec() + delay, text, nowSec(), row.id)
    return 'retry'
  }

  /** 冲突：本地节点置 stale（不覆盖远端），outbox 行保留 payload + 证据。 */
  _markConflict(row, remote) {
    const detail = stringifyDetail({
      reason: 'conflict',
      remote_action: String(remote?.action ?? 'conflict'),
      remote_id: remote?.id ?? null,
      at: nowSec(),
    })
    this._finishFailed(row.id, detail)
    try {
      const out = this.local.updateNode(row.node_id, { status: 'stale' }, { mode: 'sync' })
      if (!out?.ok) this.log(`[whale-memory] hybrid conflict: local node ${row.node_id} not marked stale (${out?.error || 'unknown'})`)
    } catch (err) {
      this.log(`[whale-memory] hybrid conflict mark stale fail-open: ${err?.message || err}`)
    }
  }

  /**
   * 排队同步：领取 → 写远端 → done / 退避 / 冲突。永不抛。
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ ok: boolean, claimed: number, done: number, retry: number,
   *   conflict: number, failed: number, errors: Array<{id:number,node_id:string,error:string}>,
   *   error?: string }>}
   */
  async flushOutbox({ limit = DEFAULT_FLUSH_LIMIT } = {}) {
    /** @type {{ok:boolean,claimed:number,done:number,retry:number,conflict:number,failed:number,errors:Array<{id:number,node_id:string,error:string}>,error?:string}} */
    const out = { ok: true, claimed: 0, done: 0, retry: 0, conflict: 0, failed: 0, errors: [] }
    if (this.closed) return { ...out, ok: false, error: 'backend_disposed' }
    if (!this._httpReady()) return { ...out, ok: false, error: 'http_not_configured' }
    let rows
    try {
      this._recoverRunning()
      rows = this._claim(limit)
    } catch (err) {
      return { ...out, ok: false, error: 'outbox_unavailable', errors: [{ id: 0, node_id: '', error: String(err?.message || err) }] }
    }
    out.claimed = rows.length
    for (const row of rows) {
      let event
      try {
        event = JSON.parse(row.payload)
      } catch {
        this._finishFailed(row.id, 'invalid_payload')
        out.failed += 1
        out.errors.push({ id: Number(row.id), node_id: String(row.node_id || ''), error: 'invalid_payload' })
        continue
      }
      let res
      try {
        res = await this.http.write(event, { timeoutMs: this._timeoutMs() })
      } catch (err) {
        res = { ok: false, error: String(err?.message || err) }
      }
      if (res?.ok && !res.conflict) {
        try { this._finishDone(row.id); out.done += 1 } catch (err) {
          out.failed += 1
          out.errors.push({ id: Number(row.id), node_id: String(row.node_id || ''), error: String(err?.message || err) })
        }
        continue
      }
      if (res?.conflict || res?.action === 'conflict') {
        this._markConflict(row, res)
        out.conflict += 1
        continue
      }
      const errorText = res?.error || res?.action || 'remote_write_failed'
      try {
        const moved = this._retry(row, errorText)
        if (moved === 'failed') out.failed += 1
        else out.retry += 1
        out.errors.push({ id: Number(row.id), node_id: String(row.node_id || ''), error: String(errorText) })
      } catch (err) {
        out.failed += 1
        out.errors.push({ id: Number(row.id), node_id: String(row.node_id || ''), error: String(err?.message || err) })
      }
    }
    return out
  }

  /** 协议探测透传（不匹配时 HttpBackend 已记录 protocolMismatch，面板可读）。 */
  async version(opts = {}) {
    if (!this.http) return { ok: false, expected: null, error: 'http_not_configured' }
    return this.http.version({ timeoutMs: this._timeoutMs(), ...opts })
  }

  /** 协议状态（面板用）；无 http 时给显式不可用对象。 */
  httpStatus() {
    if (!this.http) return { ok: false, protocol: null, expected: null, mismatch: null, checked_at: null, baseUrl: '' }
    return this.http.protocolStatus || { ok: false, protocol: null, expected: null, mismatch: null, checked_at: null, baseUrl: '' }
  }

  // 以下是本地专属能力：所有落库/审计/导入导出都走本地真源，不代理远端。
  withDb(fn) { return this.local.withDb(fn) }
  drainWrites() { return this.local.drainWrites() }
  reviewWrite(id, decision, reason) { return this.local.reviewWrite(id, decision, reason) }
  listEpisodic(limit) { return this.local.listEpisodic(limit) }
  nodes(q) { return this.local.nodes(q) }
  getNode(id, opts) { return this.local.getNode(id, opts) }
  updateNode(id, patch, opts) { return this.local.updateNode(id, patch, opts) }
  writes(limit, action, opts) { return this.local.writes(limit, action, opts) }
  edges(limit, opts) { return this.local.edges(limit, opts) }
  evolution(limit, opts) { return this.local.evolution(limit, opts) }
  recalls(limit, opts) { return this.local.recalls(limit, opts) }
  importJsonl(q) { return this.local.importJsonl(q) }
  exportJsonl(q) { return this.local.exportJsonl(q) }
  startImport(q) { return this.local.startImport(q) }
  importStatus(jobId) { return this.local.importStatus(jobId) }

  dispose() {
    this.closed = true
    try { this.local.dispose?.() } catch { /* noop */ }
  }
}

/**
 * outbox watchdog：每 30s 调一次 `flushOutbox`，随 ctx.effect 回收定时器。
 *
 * 只做调度不做实现：backend 没有 flushOutbox（local/http 模式）就安静返回
 * `{installed:false}`，接线方不需要先判断 mode。定时器 unref，不拖住进程退出。
 *
 * @param {{ backend: object, config?: object, ctx: any, log?: Function, intervalMs?: number }} opts
 * @returns {{ installed: boolean, dispose: Function }}
 */
export function installOutboxWatchdog({ backend, config, ctx, log = () => {}, intervalMs = OUTBOX_WATCHDOG_INTERVAL_MS } = {}) {
  const safeLog = typeof log === 'function' ? log : () => {}
  if (!backend || typeof backend.flushOutbox !== 'function') {
    safeLog('[whale-memory] outbox watchdog skipped: backend has no flushOutbox')
    return { installed: false, dispose() {} }
  }
  if (!ctx || typeof ctx.effect !== 'function') {
    safeLog('[whale-memory] outbox watchdog skipped: ctx.effect unavailable')
    return { installed: false, dispose() {} }
  }
  const period = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Number(intervalMs)
    : OUTBOX_WATCHDOG_INTERVAL_MS
  let timer = null
  const tick = () => {
    Promise.resolve()
      .then(() => backend.flushOutbox({ limit: DEFAULT_FLUSH_LIMIT }))
      .then((res) => {
        if (res && Number(res.claimed) > 0) {
          safeLog(`[whale-memory] outbox flush claimed=${res.claimed} done=${res.done} retry=${res.retry} conflict=${res.conflict} failed=${res.failed}`)
        }
      })
      .catch((err) => safeLog(`[whale-memory] outbox flush failed-open: ${err?.message || err}`))
  }
  const disposer = ctx.effect(() => {
    timer = setInterval(tick, period)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }, 'whale-memory: outbox watchdog')
  return {
    installed: true,
    dispose() {
      try {
        if (typeof disposer === 'function') disposer()
      } catch (err) {
        safeLog(`[whale-memory] outbox watchdog dispose fail-open: ${err?.message || err}`)
      } finally {
        if (timer) clearInterval(timer)
        timer = null
      }
    },
  }
}
