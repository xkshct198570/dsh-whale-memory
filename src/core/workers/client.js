/**
 * DbWorkerClient：把 `node:sqlite` 的同步工作挪到 worker_threads（S2 隔离层，主线程侧）。
 *
 * 硬约束：
 *  - 本文件**不 import node:sqlite**，主线程零 SQL；所有库操作都在 db-worker.js 内。
 *  - 每个请求独立 id + 独立超时（默认 1200ms）；超时 → terminate 该线程 + 重建 + reject worker_timeout。
 *  - 任何路径都不泄漏 pending：超时/崩溃/退出/dispose 都会把在途请求逐个 settle。
 *  - dispose 幂等；dispose 后在途请求 reject worker_disposed，迟到消息一律忽略。
 *
 * 错误一律 reject 普通对象 `{ code, message }`（不是 Error 实例，便于跨层判码）。
 */
import { Worker } from 'node:worker_threads'

const DEFAULT_WORKER_URL = new URL('./db-worker.js', import.meta.url)
const DEFAULT_TIMEOUT_MS = 1200

function errorOf(code, message) {
  return { code, message: String(message ?? code) }
}

function messageOf(err) {
  return String(err?.message ?? err ?? 'unknown error')
}

export class DbWorkerClient {
  /**
   * @param {{ workerPath?: string | URL, timeoutMs?: number, log?: (line: string) => void }} [opts]
   */
  constructor({ workerPath, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
    this.workerPath = workerPath ?? DEFAULT_WORKER_URL
    const t = Number(timeoutMs)
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS
    this.log = typeof log === 'function' ? log : () => {}
    /** @type {Worker | null} */
    this._worker = null
    /** @type {Map<number, { id:number, op:string, worker:Worker, timer:NodeJS.Timeout, resolve:Function, reject:Function }>} */
    this._pending = new Map()
    this._seq = 0
    this._disposed = false
  }

  get disposed() { return this._disposed }
  get alive() { return !this._disposed && Boolean(this._worker) }
  /** 诊断用：在途请求数，正常应为 0（泄漏检测）。 */
  get pendingCount() { return this._pending.size }

  /**
   * 线程存活探针（也让测试能验证"主线程不被阻塞"）。
   * @param {number} [sleepMs]
   * @returns {Promise<{ op:string, sleptMs:number }>}
   */
  async probe(sleepMs = 0) {
    const msg = await this._send('probe', { sleepMs })
    return { op: 'probe', sleptMs: Number(msg?.sleptMs ?? 0) }
  }

  /**
   * 检索。limit 由 worker 侧夹到 1..50（S2：每路 LIMIT 50）。
   * @param {{ dbPath:string, query:string, limit?:number, identity?:unknown, minRel?:number }} q
   * @returns {Promise<unknown>} search.js 的返回值
   */
  async search({ dbPath, query = '', limit = 50, identity, minRel } = {}) {
    const msg = await this._send('search', { dbPath, query, limit, identity, minRel })
    return msg?.result
  }

  /**
   * 只读计数。
   * @param {string} dbPath
   * @returns {Promise<{ nodes:number, active:number }>}
   */
  async stats(dbPath) {
    const msg = await this._send('stats', { dbPath })
    return msg?.result
  }

  /** terminate + 清定时器；幂等。在途请求全部 reject worker_disposed。 */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    const worker = this._worker
    this._worker = null
    for (const id of [...this._pending.keys()]) {
      const entry = this._pending.get(id)
      this._pending.delete(id)
      if (!entry) continue
      clearTimeout(entry.timer)
      entry.reject(errorOf('worker_disposed', `client 已 dispose，op=${entry.op} 未完成`))
    }
    if (worker) this._terminate(worker)
  }

  // ---- 内部：请求收发 -------------------------------------------------------

  _send(op, fields) {
    return new Promise((resolve, reject) => {
      if (this._disposed) {
        reject(errorOf('worker_disposed', 'client 已 dispose'))
        return
      }
      let worker
      try {
        worker = this._ensureWorker()
      } catch (err) {
        reject(errorOf('worker_spawn_failed', messageOf(err)))
        return
      }
      const id = ++this._seq
      const timer = setTimeout(() => this._onTimeout(id), this.timeoutMs)
      this._pending.set(id, { id, op, worker, timer, resolve, reject })
      try {
        worker.postMessage({ id, op, ...fields })
      } catch (err) {
        // 线程已不可用：settle 本请求，下次调用走 _ensureWorker 重建。
        this._settle(id, errorOf('worker_post_failed', messageOf(err)))
      }
    })
  }

  _settle(id, error) {
    const entry = this._pending.get(id)
    if (!entry) return
    this._pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(error)
  }

  _onMessage(worker, msg) {
    // dispose 之后到达的一切消息（含迟到回执）都丢弃。
    if (this._disposed) return
    if (!msg || typeof msg !== 'object') return
    const entry = this._pending.get(msg.id)
    if (!entry || entry.worker !== worker) return
    this._pending.delete(entry.id)
    clearTimeout(entry.timer)
    if (msg.ok) {
      entry.resolve(msg)
      return
    }
    entry.reject(errorOf(msg.error?.code || 'worker_error', msg.error?.message || 'worker 返回失败'))
  }

  _onTimeout(id) {
    const entry = this._pending.get(id)
    if (!entry) return
    this._pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(errorOf('worker_timeout', `worker 超过 ${this.timeoutMs}ms 未回执（op=${entry.op}）`))
    const worker = entry.worker
    this.log(`[whale-memory:worker] timeout op=${entry.op} → terminate + rebuild`)
    // 该线程被终止后，同线程上其余在途请求也一起失败，避免悬挂。
    this._failGeneration(worker, errorOf('worker_terminated', 'worker 因超时被终止'), id)
    this._terminate(worker)
    if (this._disposed) return
    // 立即重建，保证下一次调用拿到的是干净线程；重建失败留给下一次按需重试。
    try {
      this._spawnWorker()
    } catch (err) {
      this.log(`[whale-memory:worker] rebuild failed: ${messageOf(err)}`)
    }
  }

  _onWorkerError(worker, err) {
    if (this._disposed) return
    this.log(`[whale-memory:worker] error: ${messageOf(err)}`)
    if (this._worker === worker) this._worker = null
    this._failGeneration(worker, errorOf('worker_error', messageOf(err)))
    this._terminate(worker)
  }

  _onWorkerExit(worker, code) {
    if (this._disposed) return
    if (this._worker === worker) this._worker = null
    this._failGeneration(worker, errorOf('worker_exited', `worker 退出（code=${code}）`))
    // 不在这里自动重建：坏 workerPath 会导致无限重启。下一次请求按需重建（崩溃可重建）。
    this._terminate(worker)
  }

  _failGeneration(worker, error, exceptId = null) {
    for (const id of [...this._pending.keys()]) {
      const entry = this._pending.get(id)
      if (!entry || entry.worker !== worker) continue
      if (exceptId !== null && id === exceptId) continue
      this._pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject({ ...error })
    }
  }

  _ensureWorker() {
    if (this._disposed) throw new Error('client 已 dispose')
    if (this._worker) return this._worker
    return this._spawnWorker()
  }

  _spawnWorker() {
    const worker = new Worker(this.workerPath)
    worker.on('message', (msg) => this._onMessage(worker, msg))
    worker.on('error', (err) => this._onWorkerError(worker, err))
    worker.on('exit', (code) => this._onWorkerExit(worker, code))
    this._worker = worker
    return worker
  }

  _terminate(worker) {
    if (!worker) return
    if (this._worker === worker) this._worker = null
    try {
      worker.removeAllListeners('message')
      worker.removeAllListeners('error')
      worker.removeAllListeners('exit')
    } catch { /* 已销毁的 worker */ }
    try {
      const done = worker.terminate()
      if (done && typeof done.catch === 'function') done.catch(() => {})
    } catch { /* terminate 失败不影响已 reject 的结果 */ }
  }
}

export default DbWorkerClient
