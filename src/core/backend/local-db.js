// 职责：backend 本地底座——LocalBackend 类本体（连接/健康/迁移/dispose）与三域方法装配。
// 依赖方向：base/db/workers 门面 ← 本文件；被 hybrid-bridge 引用；不 import host，也不 import 其它域的内部文件。

import { closeDb, migrationBackupError, openDb, setMeta } from '../db.js'
import { DbWorkerClient } from '../workers/index.js'
import { installMethods } from './base.js'
import { queryApi } from './query-api.js'
import { writeApi } from './write-api.js'
import { transferApi } from './transfer.js'

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
    // 迁移快照 fail-closed 的原因（进程内记忆）。为什么记忆：快照失败是确定性阻断，
    // 每步 retry 会反复跑 VACUUM INTO 失败路径（P1-10 类自愈死循环）；修复后由重启重试。
    this.openBlocked = ''
  }

  /**
   * 后端可用性：真探测能否拿到连接（打开/迁移失败即 false），不再恒 true。
   * 只在第一次调用时真开库，之后命中 this.db（连接缓存），不会每次 stats 都重开。
   */
  get ready() {
    try { this._db(); return true } catch { return false }
  }

  /** 迁移 fail-closed 阻断原因（空串=未阻断）；面板/health 只读展示。 */
  get openError() {
    return this.openBlocked
  }

  _db() {
    if (this.closed) throw new Error('backend_disposed')
    if (this.openBlocked) throw migrationBackupError(this.openBlocked)
    if (!this.db) {
      try {
        this.db = openDb(this.dataDir || undefined)
      } catch (err) {
        // 只记忆 fail-closed 原因；busy/权限抖动等瞬时错误保持可重试（原有语义）。
        if (err?.code === 'migration_backup_failed') {
          this.openBlocked = String(err.reason || err.message || 'unknown')
        }
        throw err
      }
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

// 装配：三个域的方法对象一次装回原型（描述符与 class 方法一致；任一重名整体不落，见 base.installMethods）。
installMethods(LocalBackend, queryApi, writeApi, transferApi)
