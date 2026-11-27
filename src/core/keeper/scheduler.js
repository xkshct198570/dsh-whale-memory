/**
 * keeper 调度器：jobs 表状态机、单飞、启动补偿、水位闸门与生命周期装配。
 *
 * 拆分（P2b）：调度/装配在本文件；默认 handlers 在 ./handlers.js；通用小工具在 ./util.js。
 * 硬约束：queued → running → done|failed；attempts<4 按 60s/300s/1800s 退避，>=4 落 failed；
 * 同 kind 单飞；全局并发=1；启动补偿只跑 queued + attempts<4 的 failed；done 永不复跑；
 * 执行前 pressure()，stress 时 job 回 queued、next_at=now+600；timer unref，dispose 后空转。
 *
 * 依赖方向：core → shared；keeper/scheduler → keeper/handlers、keeper/util。
 */
import { memoryPressure } from '../../shared/memory-guard.js'
import { num } from '../../shared/config-values.js'
import { RETRY_MAX_ATTEMPTS, redactJobPayload } from '../job-payload.js'
import { openKeeperLease } from './lock.js'
import { installDefaultHandlers } from './handlers.js'
import { clampText, safeJson, toSeconds, withHandlerTimeout } from './util.js'

/** 允许的作业类型（schema jobs.kind 语义；write 由写队列独占，keeper 不调度）。 */
export const JOB_KINDS = ['consolidate', 'reflect', 'write', 'vector', 'archive', 'report', 'import', 'wrap', 'maintenance']
/** keeper 不得接管的 kind：write 的排队/重试/崩溃续跑全在 writer 的写队列里。 */
export const KEEPER_RESERVED_KINDS = Object.freeze(['write'])

/** 失败重试退避（秒）：§8.1 的 1m→5m→30m；attempts=0 是首跑不等，3 起封顶 30m。 */
const BACKOFF_SECONDS = [0, 60, 300, 1800]
export function backoffSeconds(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0))
  return BACKOFF_SECONDS[Math.min(n, BACKOFF_SECONDS.length - 1)]
}

/** 压力态下 job 回 queued 的延后秒数。 */
const PRESSURE_DEFER_SECONDS = 600
/** 最多 4 次失败后不再自动跑：1 次重排后按 60s/300s/1800s 再试三次（§8.1 1m→5m→30m）。
 *  与写队列同一个上限值（job-payload.RETRY_MAX_ATTEMPTS），「failed 是否终态」不得各写一份。 */
const MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS

/** claim 时一次最多看多少候选（同 kind 被占用时继续找别的）。 */
const CANDIDATE_LIMIT = 20

/**
 * @param {{
 *   store: { withDb: (fn: (db: import('node:sqlite').DatabaseSync) => any) => any, dbFile?: string },
 *   config?: any,
 *   log?: (line: string) => void,
 *   pressure?: () => { stress?: boolean, freeMB?: number, rssMB?: number },
 *   nowFn?: () => number,
 *   intervalMs?: number,
 * }} deps
 */
export function createKeeper({
  store,
  config = {},
  log = () => {},
  pressure = memoryPressure,
  nowFn = () => Date.now() / 1000,
  intervalMs = 600000,
  // 单实例租约（0.8.1-07）：consume=false 时本进程只入队/只读，不消费 jobs（另一个进程是 owner）。
  consume = true,
  // handler 硬超时（0=不限）：一个永不 resolve 的 handler 不能把其它 kind 永久堵在队列里。
  handlerTimeoutMs = 0,
} = {}) {
  if (!store || typeof store.withDb !== 'function') throw new TypeError('createKeeper: store.withDb required')

  /** @type {Map<string, (payload: any, api: {log: Function, now: Function}) => any>} */
  const handlers = new Map()
  let disposed = false
  let runningTick = false
  let pressureLogged = false
  let lastError = null
  let timer = null
  /** 最近一次成功执行的结果（runNow 取 handler 返回值用）。 */
  let lastRun = { id: null, kind: null, result: undefined }
  /** 最近一次执行是否失败（drain 统计用，不暴露进 tick 返回）。 */
  let lastFailed = false

  const nowSec = () => toSeconds(nowFn())
  const dbNow = () => nowSec()

  /** 读 pressure，异常按"无压力"处理（fail-open，闸门不能变成停机理由）。 */
  function pressureState() {
    try {
      const p = pressure()
      return { stress: Boolean(p?.stress), raw: p }
    } catch (err) {
      log(`[whale-memory] keeper pressure fail-open: ${err?.message || err}`)
      return { stress: false, raw: null }
    }
  }

  /** 同 kind 是否已有 running（DB 兜底；进程内单飞之外的第二层保险）。 */
  function claim(db, id) {
    const info = db.prepare(`UPDATE jobs SET state='running', updated_at=?, last_error=NULL
      WHERE id=? AND state='queued'
        AND NOT EXISTS (SELECT 1 FROM jobs AS r WHERE r.kind = jobs.kind AND r.state='running')`)
      .run(dbNow(), Number(id))
    return Number(info?.changes || 0) > 0
  }

  /** 挑一条可跑 job：先 queued 到期，再 attempts<MAX_ATTEMPTS 的 failed（重置后跑）。 */
  function pickAndClaim() {
    return store.withDb((db) => {
      const queued = db.prepare(`SELECT * FROM jobs
        WHERE state='queued' AND kind <> 'write' AND (next_at IS NULL OR next_at <= ?)
        ORDER BY next_at IS NOT NULL, next_at, id LIMIT ?`).all(dbNow(), CANDIDATE_LIMIT)
      for (const row of queued) {
        if (claim(db, row.id)) return { job: row }
      }
      let blocked = queued.length > 0

      const failed = db.prepare(`SELECT * FROM jobs WHERE state='failed' AND kind <> 'write' AND attempts < ?
        ORDER BY id LIMIT ?`).all(MAX_ATTEMPTS, CANDIDATE_LIMIT)
      for (const row of failed) {
        const reset = db.prepare(`UPDATE jobs SET state='queued', next_at=NULL, updated_at=?
          WHERE id=? AND state='failed' AND attempts < ?`).run(dbNow(), Number(row.id), MAX_ATTEMPTS)
        if (Number(reset?.changes || 0) === 0) continue
        if (claim(db, row.id)) return { job: row }
        blocked = true
      }
      return { job: null, skipped: blocked ? 'same_kind_running' : 'no_job' }
    })
  }

  /** 执行权回收 / 状态收尾。终态同轮脱敏：jobs.payload 不再保留正文（0.8.1-01）。 */
  function finishDone(id) {
    store.withDb((db) => {
      const row = db.prepare('SELECT payload FROM jobs WHERE id=?').get(Number(id))
      db.prepare("UPDATE jobs SET state='done', payload=?, updated_at=?, last_error=NULL WHERE id=? AND state='running'")
        .run(redactJobPayload(row?.payload), dbNow(), Number(id))
    })
  }

  function finishFailed(job, err) {
    const attempts = Math.max(0, Number(job.attempts || 0)) + 1
    const message = clampText(err?.message || err || 'job_error')
    lastError = `${job.kind}: ${message}`
    store.withDb((db) => {
      if (attempts >= MAX_ATTEMPTS) {
        // 终态：脱敏正文（重跑不会再读 payload，留着只是长期隐私负担）。
        db.prepare(`UPDATE jobs SET state='failed', attempts=?, last_error=?, next_at=NULL, payload=?, updated_at=?
          WHERE id=? AND state='running'`).run(attempts, message, redactJobPayload(job.payload), dbNow(), Number(job.id))
      } else {
        // 还能重排：payload 原样保留（重跑要读正文/游标），绝不在这里脱敏。
        const nextAt = dbNow() + backoffSeconds(attempts)
        db.prepare(`UPDATE jobs SET state='queued', attempts=?, last_error=?, next_at=?, updated_at=?
          WHERE id=? AND state='running'`).run(attempts, message, nextAt, dbNow(), Number(job.id))
      }
    })
  }

  function deferForPressure(job) {
    store.withDb((db) => db.prepare(`UPDATE jobs SET state='queued', next_at=?, updated_at=?
      WHERE id=? AND state='running'`).run(dbNow() + PRESSURE_DEFER_SECONDS, dbNow(), Number(job.id)))
  }

  /** 一次调度：返回内部结果（tick 会剥掉 failed/result 只留契约字段）。 */
  async function runOnce() {
    lastFailed = false
    if (disposed) return { ran: [], skipped: 'disposed', failed: false }
    if (!consume) return { ran: [], skipped: 'locked', failed: false }
    if (runningTick) return { ran: [], skipped: 'busy', failed: false }

    runningTick = true
    try {
      // 先读闸门再挑 job：压力态判断与"清压后复位日志标记"都不依赖队列是否为空。
      const gate = pressureState()
      if (!gate.stress) pressureLogged = false

      const picked = pickAndClaim()
      if (!picked.job) return { ran: [], skipped: picked.skipped, failed: false }
      const job = picked.job

      if (gate.stress) {
        deferForPressure(job)
        if (!pressureLogged) {
          pressureLogged = true
          const raw = gate.raw || {}
          log(`[whale-memory] keeper deferred by memory_pressure free=${raw.freeMB ?? '?'}MB rss=${raw.rssMB ?? '?'}MB`)
        }
        return { ran: [], deferred: 'memory_pressure', failed: false }
      }

      const handler = handlers.get(job.kind)
      if (typeof handler !== 'function') {
        // 没有 handler 视为失败（可重试），不静默吞掉——接线上漏了要能看见。
        finishFailed(job, new Error('no_handler'))
        log(`[whale-memory] keeper ${job.kind} failed: no_handler`)
        lastFailed = true
        return { ran: [job.kind], failed: true }
      }

      try {
        const task = handler(safeJson(job.payload), { log, now: nowSec, jobId: Number(job.id) })
        const result = handlerTimeoutMs > 0
          ? await withHandlerTimeout(task, handlerTimeoutMs, `${job.kind}:${Number(job.id)}`)
          : await task
        finishDone(job.id)
        lastRun = { id: Number(job.id), kind: job.kind, result }
        return { ran: [job.kind], result, failed: false }
      } catch (err) {
        finishFailed(job, err)
        log(`[whale-memory] keeper ${job.kind} attempt=${Number(job.attempts || 0) + 1} failed: ${err?.message || err}`)
        lastFailed = true
        return { ran: [job.kind], failed: true }
      }
    } catch (err) {
      // DB/调度层异常：不抛出（定时器路径不能炸 Host），记一条可见错误。
      lastError = `scheduler: ${err?.message || err}`
      log(`[whale-memory] keeper scheduler error: ${err?.message || err}`)
      return { ran: [], skipped: 'db_error', failed: false }
    } finally {
      runningTick = false
    }
  }

  const jobRow = (id) => store.withDb((db) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)))

  const keeper = {
    /**
     * 注册 handler：签名 (payload, api) => any|Promise；api={log, now}。
     * 重名策略：**抛错**（duplicate_handler）——默认 handler 已占 consolidate/vector/archive/report，
     * write/reflect 留给 index.js，重复注册一律是接线错误，静默覆盖只会掩盖 bug。
     */
    register(kind, handler) {
      const key = String(kind || '')
      if (!JOB_KINDS.includes(key)) throw new Error(`unknown_kind: ${key}`)
      if (KEEPER_RESERVED_KINDS.includes(key)) throw new Error(`reserved_kind: ${key} owned by write queue`)
      if (typeof handler !== 'function') throw new TypeError('register: handler required')
      if (handlers.has(key)) throw new Error(`duplicate_handler: ${key}`)
      handlers.set(key, handler)
      return this
    },

    /** 入队（state='queued'）；nextAt 为秒级时间戳，缺省表示立即可跑。 */
    enqueue(kind, payload = {}, { nextAt } = {}) {
      const key = String(kind || '')
      if (!JOB_KINDS.includes(key)) throw new Error(`unknown_kind: ${key}`)
      if (KEEPER_RESERVED_KINDS.includes(key)) throw new Error(`reserved_kind: ${key} owned by write queue`)
      let text = '{}'
      try { text = JSON.stringify(payload ?? {}) } catch { text = '{}' }
      const next = nextAt === undefined || nextAt === null || nextAt === '' ? null : toSeconds(nextAt)
      const info = store.withDb((db) => db.prepare(`INSERT INTO jobs (kind,state,attempts,next_at,payload,created_at,updated_at)
        VALUES (?, 'queued', 0, ?, ?, ?, ?)`).run(key, next, text, dbNow(), dbNow()))
      return Number(info.lastInsertRowid)
    },

    /** 单飞 tick：最多跑一个 job；并发调用直接让路（skipped:'busy'）。 */
    async tick() {
      const r = await runOnce()
      const out = { ran: r.ran }
      if (r.skipped) out.skipped = r.skipped
      if (r.deferred) out.deferred = r.deferred
      return out
    },

    /** 连续 tick（测试/启动补偿）：遇到无可跑、退避或压力闸门即停。 */
    async drain({ max = 10 } = {}) {
      const limit = Math.max(0, Math.floor(Number(max) || 0))
      const ran = []
      let failed = 0
      for (let i = 0; i < limit; i += 1) {
        const r = await this.tick()
        if (r.ran.length === 0) break
        ran.push(...r.ran)
        if (lastFailed) failed += 1
        if (r.deferred) break
      }
      return { ran, failed }
    },

    /**
     * 入队并跑到这条 job 结束（reflect 手动按钮用）。
     * 返回 { id, state, attempts, last_error, result?, skipped?, deferred? }；
     * result 是 handler 的返回值（成功时），便于按钮直接回显。
     */
    async runNow(kind, payload = {}) {
      const id = this.enqueue(kind, payload)
      // 只读进程没有消费者：立刻返回可判定状态，绝不空等 50 轮（铁律 22）。
      if (!consume) return { id, state: 'queued', attempts: 0, skipped: 'locked' }
      // 队列里可能还有别的 job，逐个 tick 直到这条到终态；上限防死循环（正常 ≤几条）。
      for (let i = 0; i < 50; i += 1) {
        const row = jobRow(id)
        if (!row) return { id, state: 'missing' }
        if (row.state === 'done' || row.state === 'failed') {
          return {
            id, state: row.state, attempts: Number(row.attempts || 0), last_error: row.last_error || null,
            result: lastRun.id === id ? lastRun.result : undefined,
          }
        }
        const r = await this.tick()
        if (r.deferred) {
          const cur = jobRow(id)
          return { id, state: cur?.state || 'queued', attempts: Number(cur?.attempts || 0), deferred: r.deferred }
        }
        if (r.skipped && r.skipped !== 'busy') {
          const cur = jobRow(id)
          return { id, state: cur?.state || 'missing', attempts: Number(cur?.attempts || 0), skipped: r.skipped, last_error: cur?.last_error || null }
        }
        if (r.skipped === 'busy') break // 别的 tick 正在跑：不空转，交给它
      }
      const cur = jobRow(id)
      return {
        id, state: cur?.state || 'missing', attempts: Number(cur?.attempts || 0),
        last_error: cur?.last_error || null, skipped: 'unfinished',
      }
    },

    /**
     * 某 kind 的在队数（queued/running）：供自动闸判断"队列已有"，不受 status() 200 行快照限制。
     * @param {string} kind
     * @returns {number}
     */
    countActive(kind) {
      const key = String(kind || '')
      return Number(store.withDb((db) => db.prepare(
        "SELECT count(*) AS n FROM jobs WHERE kind = ? AND state IN ('queued','running')",
      ).get(key)?.n || 0))
    },

    /**
     * 某 kind 在指定时间窗内、按 payload.reason 过滤的历史行数（0.8.1-09 反思日限用）。
     *
     * 为什么在 keeper 而不在调用方：jobs 表 owner 是 keeper；reflect 不直接读库，
     * 判据（按 reason 区分自动/手动）只在这里实现一次。reason 落在 payload 白名单里，
     * 终态脱敏后仍可查（见 job-payload.js）。
     *
     * @param {string} kind
     * @param {{ sinceSec?: number, reasons?: string[] }} [opts] sinceSec 缺省=全时段；reasons 空=不按 reason 过滤
     * @returns {number}
     */
    countRuns(kind, { sinceSec = 0, reasons = [] } = {}) {
      const key = String(kind || '')
      const since = Number(sinceSec) || 0
      const list = Array.isArray(reasons) ? reasons.map((item) => String(item)) : []
      return Number(store.withDb((db) => {
        if (list.length === 0) {
          return db.prepare('SELECT count(*) AS n FROM jobs WHERE kind=? AND created_at>=?').get(key, since)
        }
        const marks = list.map(() => '?').join(',')
        return db.prepare(`SELECT count(*) AS n FROM jobs WHERE kind=? AND created_at>=?
          AND json_extract(payload,'$.reason') IN (${marks})`).get(key, since, ...list)
      })?.n || 0)
    },

    /** 队列快照（面板用）：running/queued/failed 为**计数**，不是布尔。 */
    status() {
      const rows = store.withDb((db) => db.prepare(`SELECT id, kind, state, attempts, next_at, last_error
        FROM jobs ORDER BY id DESC LIMIT 200`).all())
      let running = 0
      let queued = 0
      let failed = 0
      for (const row of rows) {
        if (row.state === 'running') running += 1
        else if (row.state === 'queued') queued += 1
        else if (row.state === 'failed') failed += 1
      }
      return {
        running, queued, failed, lastError,
        consuming: consume,
        jobs: rows.map((row) => ({
          id: Number(row.id), kind: row.kind, state: row.state, attempts: Number(row.attempts || 0),
          next_at: row.next_at === null || row.next_at === undefined ? null : Number(row.next_at),
          last_error: row.last_error || null,
        })),
      }
    },

    /** 清 timer + 置 disposed；之后 tick 空转、drain 立即返回。 */
    dispose() {
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }

  installDefaultHandlers(keeper, { store, config, log, nowSec })

  // 定时器：unref 不拖住 Host 退出；tick 内部已兜底，这里再兜一层防 timer 回调炸。
  if (consume) {
    timer = setInterval(() => { void keeper.tick().catch(() => {}) }, Math.max(1000, Math.floor(Number(intervalMs) || 600000)))
    if (typeof timer.unref === 'function') timer.unref()
  }
  keeper.consuming = consume
  return keeper
}

/**
 * 崩溃残留回收（铁律 3）：本进程刚启动，任何 state='running' 都是上个进程留下的；
 * 置回 queued 让 tick 续跑，否则该 kind 会被单飞条件永远挡住。
 * @param {{ withDb: Function }} store
 * @param {(line: string) => void} [log]
 * @returns {number} 回收条数
 */
export function recoverRunningJobs(store, log = () => {}) {
  if (!store || typeof store.withDb !== 'function') return 0
  // 只回收非保留 kind（审计 P2-F5）：write job 的唯一消费者是写队列，它自己会把
  // running 复位；keeper 再复位会让下一个 keeper tick 把同一 write job 跑第二遍。
  const reserved = [...KEEPER_RESERVED_KINDS]
  const marks = reserved.map(() => '?').join(',')
  const changed = Number(store.withDb((db) => db.prepare(
    `UPDATE jobs SET state='queued', next_at=NULL, updated_at=? WHERE state='running'
       ${reserved.length ? `AND kind NOT IN (${marks})` : ''}`,
  ).run(Date.now() / 1000, ...reserved))?.changes || 0)
  if (changed > 0) log(`[whale-memory] keeper recovered ${changed} stale running job(s)`)
  return changed
}

/**
 * 装配：先回收崩溃残留，再 createKeeper（默认 handlers + unref 定时器）+ ctx.effect 生命周期。
 *
 * @param {{ effect?: (fn: () => () => void, label?: string) => any }} ctx
 * @param {Parameters<typeof createKeeper>[0] & { dataDir?: string }} deps
 *   dataDir：装配层解析好的库目录（backend 未开库时租约用它落锁）。
 */
export function installKeeper(ctx, deps = {}) {
  const { store, config = {}, log = () => {}, dataDir = '' } = deps
  // 单实例租约（0.8.1-07）：双进程共享同一 dataDir 时，第二个进程不得复位 running、
  // 也不得消费 jobs——否则同一 job 会被两个 keeper 各跑一遍（重复烧模型/重复写库）。
  // 锁策略（开关/dataDir/只读原因）在 keeper/lock.js；这里只做装配。
  const lease = openKeeperLease({ store, config, log, dataDir })
  // 只有拿到租约的进程才做崩溃补偿：复位 running 正是"双实例重复执行"的源头。
  if (lease.ok) recoverRunningJobs(store, log)
  const keeper = createKeeper({
    ...deps,
    consume: lease.ok,
    handlerTimeoutMs: Math.max(0, Math.trunc(num(config?.advanced?.keeperHandlerTimeoutMs, 0))),
  })
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => { keeper.dispose(); lease.release() }, 'whale-memory: keeper')
  }
  return keeper
}

