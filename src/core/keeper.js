/**
 * 后台作业调度（S4，架构书 §8.1）：jobs 表状态机 + 单飞 + 启动补偿 + 水位闸门。
 *
 * 硬约束：
 * - 状态机 queued → running → done|failed；失败 attempts+1：
 *   attempts<3 回 queued 且 next_at=now+backoffSeconds(attempts)，attempts>=3 落 failed。
 * - 单飞：同 kind 同时只 1 个 running（claim 用条件 UPDATE，changes=0 即跳过）。
 * - 全局并发=1：tick/drain 抢不到执行权就立刻让路，不起第二个 job。
 * - 启动补偿：先跑 queued 到期，再跑 attempts<3 的 failed（重置回 queued）；done 永不复跑。
 * - 水位闸门：执行前 pressure()；stress 时 job 回 queued、next_at=now+600，
 *   日志只在"进入压力态"打一次（清压后复位，不刷屏）。
 * - 定时器 unref：不拖住 Host 退出；dispose 后 tick 空转（{ran:[],skipped:'disposed'}）。
 *
 * 本模块只读写 jobs / nodes / edges / writes（audit）与 reports 目录，
 * 不碰 FTS、不碰召回注入；write/reflect 的 handler 由 index.js 接线，这里不注册。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { memoryPressure } from '../host/memory-guard.js'
import { parseTags, rebuildTagEdges, upsertEdge } from './relations.js'

/** 允许的作业类型（enqueue/register 校验用；与 schema jobs.kind 语义一致）。 */
export const JOB_KINDS = ['consolidate', 'reflect', 'write', 'vector', 'archive', 'report']

/** 失败重试退避（秒）：0→0（首跑不等）、1→60、2→300、3+→1800。 */
const BACKOFF_SECONDS = [0, 60, 300]
export function backoffSeconds(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0))
  return n >= 3 ? 1800 : BACKOFF_SECONDS[n]
}

/** 压力态下 job 回 queued 的延后秒数。 */
const PRESSURE_DEFER_SECONDS = 600
/** 最多 3 次失败后不再自动跑。 */
const MAX_ATTEMPTS = 3
/** vector 每次最多处理的 pending 条数。 */
const VECTOR_BATCH = 32
/** claim 时一次最多看多少候选（同 kind 被占用时继续找别的）。 */
const CANDIDATE_LIMIT = 20

/** text_hash 重复收敛每批最多归档条数（审计行同批上限，写连接保持短事务）。 */
const DEDUPE_BATCH = 200
/** 来源等级：owner > self > group > web/tool > import（writer SOURCE_MAP 的语义优先级）。 */
const SOURCE_RANK = { owner: 5, self: 4, group: 3, web: 2, tool: 2, import: 1 }

const toSeconds = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
const clampText = (value, max = 500) => String(value ?? '').slice(0, max)

function safeJson(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

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

  /** 挑一条可跑 job：先 queued 到期，再 attempts<3 的 failed（重置后跑）。 */
  function pickAndClaim() {
    return store.withDb((db) => {
      const queued = db.prepare(`SELECT * FROM jobs
        WHERE state='queued' AND (next_at IS NULL OR next_at <= ?)
        ORDER BY next_at IS NOT NULL, next_at, id LIMIT ?`).all(dbNow(), CANDIDATE_LIMIT)
      for (const row of queued) {
        if (claim(db, row.id)) return { job: row }
      }
      let blocked = queued.length > 0

      const failed = db.prepare(`SELECT * FROM jobs WHERE state='failed' AND attempts < ?
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

  /** 执行权回收 / 状态收尾。 */
  function finishDone(id) {
    store.withDb((db) => db.prepare("UPDATE jobs SET state='done', updated_at=?, last_error=NULL WHERE id=? AND state='running'")
      .run(dbNow(), Number(id)))
  }

  function finishFailed(job, err) {
    const attempts = Math.max(0, Number(job.attempts || 0)) + 1
    const message = clampText(err?.message || err || 'job_error')
    lastError = `${job.kind}: ${message}`
    store.withDb((db) => {
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE jobs SET state='failed', attempts=?, last_error=?, next_at=NULL, updated_at=?
          WHERE id=? AND state='running'`).run(attempts, message, dbNow(), Number(job.id))
      } else {
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
        const result = await handler(safeJson(job.payload), { log, now: nowSec })
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
      if (typeof handler !== 'function') throw new TypeError('register: handler required')
      if (handlers.has(key)) throw new Error(`duplicate_handler: ${key}`)
      handlers.set(key, handler)
      return this
    },

    /** 入队（state='queued'）；nextAt 为秒级时间戳，缺省表示立即可跑。 */
    enqueue(kind, payload = {}, { nextAt } = {}) {
      const key = String(kind || '')
      if (!JOB_KINDS.includes(key)) throw new Error(`unknown_kind: ${key}`)
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
  timer = setInterval(() => { void keeper.tick().catch(() => {}) }, Math.max(1000, Math.floor(Number(intervalMs) || 600000)))
  if (typeof timer.unref === 'function') timer.unref()
  return keeper
}

/**
 * 同身份 text_hash 重复 active 节点收敛（架构书 §8.2）。
 *
 * 为什么必须收敛：去重只在写入决策时拦"新事件"，重复历史（导入/多来源同步）仍会堆出
 * 同身份同文多行，检索会把同一事实算多次、面板也难以人工清理。
 * 保留来源等级最高者（owner>self>group>web/tool>import），其余置 archived 并逐条留审计。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ batch?: number, maxNodes?: number, nowSec?: number }} [opts]
 * @returns {{ merged: number }} merged = 本批归档条数（≤ batch）
 */
export function convergeDuplicateHashes(db, { batch = DEDUPE_BATCH, maxNodes = 5000, nowSec = Date.now() / 1000 } = {}) {
  const limit = Math.max(1, Math.floor(Number(batch) || DEDUPE_BATCH))
  const rows = db.prepare(`SELECT id, text_hash, source, created_at, user_id, role_id, workspace
    FROM nodes WHERE status='active' ORDER BY created_at, id LIMIT ?`).all(Math.max(1, Number(maxNodes) || 5000))
  const groups = new Map()
  for (const row of rows) {
    const hash = String(row.text_hash || '')
    if (!hash) continue
    // 身份分区必须完全相同（共享 '' 也是同一分区）；跨人/跨端同文不是重复。
    const key = [row.user_id ?? '', row.role_id ?? '', row.workspace ?? '', hash].join('\u0000')
    let list = groups.get(key)
    if (!list) { list = []; groups.set(key, list) }
    list.push(row)
  }

  const doomed = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort((a, b) =>
      (SOURCE_RANK[String(b.source)] ?? 0) - (SOURCE_RANK[String(a.source)] ?? 0) ||
      Number(a.created_at || 0) - Number(b.created_at || 0) ||
      (String(a.id) < String(b.id) ? -1 : 1))
    for (const row of list.slice(1)) {
      doomed.push(row)
      if (doomed.length >= limit) break
    }
    if (doomed.length >= limit) break
  }
  if (doomed.length === 0) return { merged: 0 }

  const ts = Number(nowSec) || Date.now() / 1000
  db.exec('BEGIN IMMEDIATE')
  let merged = 0
  try {
    const archive = db.prepare("UPDATE nodes SET status='archived', updated_at=? WHERE id=? AND status='active'")
    const audit = db.prepare(`INSERT INTO writes (ts,trace_id,action,node_id,reason,mode,user_id,role_id,workspace)
      VALUES (?,?,'CONSOLIDATE',?,'dedupe_hash','auto',?,?,?)`)
    for (const row of doomed) {
      const info = archive.run(ts, String(row.id))
      if (Number(info?.changes || 0) === 0) continue
      audit.run(ts, '', String(row.id), String(row.user_id ?? ''), String(row.role_id ?? ''), String(row.workspace ?? ''))
      merged += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw err
  }
  return { merged }
}

/**
 * 主题边生成（架构书 §7.1 的扩散链路入口）：同身份、同 tag 小群体内连 `topic` 边。
 *
 * 为什么放在巩固 job：边是整批重建的派生数据，写入路径只负责事实，不在每次写时现连。
 * 主题边只连同身份分区（user_id/role_id/workspace 完全相同，共享 '' 同一分区），
 * 跨人/跨端不连——否则扩散会把别人的记忆带进本会话。
 * 置信口径：两节点共享 tag 数 ≥2 → 0.8，否则 0.6（同 tag 一对即 0.6）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dfMax?: number, maxNodes?: number, maxPairs?: number }} [opts]
 * @returns {{ edges: number, tags: number }} edges=新建/升级的 pair 数，tags=参与的分区-tag 组数
 */
export function buildTopicEdges(db, { dfMax = 12, maxNodes = 5000, maxPairs = 5000 } = {}) {
  const rows = db.prepare('SELECT id, tags, user_id, role_id, workspace FROM nodes WHERE status=? ORDER BY id LIMIT ?')
    .all('active', Math.max(1, Number(maxNodes) || 5000))
  /** @type {Map<string, { ids: string[], tagSets: Map<string, Set<string>> }>} */
  const groups = new Map()
  for (const row of rows) {
    const partition = [row.user_id ?? '', row.role_id ?? '', row.workspace ?? ''].join('\u0000')
    const tagSet = new Set(parseTags(row.tags).map((t) => t.toLowerCase()))
    if (tagSet.size === 0) continue
    const id = String(row.id)
    for (const tag of tagSet) {
      const key = `${partition}\u0000${tag}`
      let group = groups.get(key)
      if (!group) { group = { ids: [], tagSets: new Map() }; groups.set(key, group) }
      group.ids.push(id)
      group.tagSets.set(id, tagSet)
    }
  }

  const max = Math.max(1, Math.floor(Number(maxPairs) || 5000))
  const seenPairs = new Set()
  let pairs = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const group of groups.values()) {
      const ids = group.ids
      if (ids.length < 2 || ids.length > Math.max(2, Number(dfMax) || 12)) continue
      for (let i = 0; i < ids.length && pairs < max; i += 1) {
        for (let j = i + 1; j < ids.length && pairs < max; j += 1) {
          const a = ids[i] < ids[j] ? ids[i] : ids[j]
          const b = ids[i] < ids[j] ? ids[j] : ids[i]
          const pairKey = `${a}\u0000${b}`
          if (seenPairs.has(pairKey)) continue
          const tagA = group.tagSets.get(a)
          const tagB = group.tagSets.get(b)
          if (!tagA || !tagB) continue
          let shared = 0
          for (const tag of tagA) if (tagB.has(tag)) shared += 1
          if (shared === 0) continue
          seenPairs.add(pairKey)
          upsertEdge(db, {
            fromId: a, toId: b, etype: 'topic', source: 'reflect',
            conf: shared >= 2 ? 0.8 : 0.6, weight: 0.6,
          })
          pairs += 1
        }
      }
      if (pairs >= max) break
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw err
  }
  return { edges: pairs, tags: groups.size }
}

/** 默认 handlers 安装（createKeeper 内调用；单独拆函数便于阅读）。 */
function installDefaultHandlers(keeper, deps) {
  const { store, config = {}, log = () => {}, nowSec } = deps

  keeper.register('consolidate', async () => {
    return store.withDb((db) => {
      // 顺序：先收敛同文重复（否则重复节点会参与建边），再重建 tag 相似边与主题边，最后跑 TTL。
      // 主题边只由巩固 job 批量生成：写入路径不现连边，扩散才有一条稳定、可解释的链路。
      const dedupe = convergeDuplicateHashes(db, { nowSec: nowSec() })
      const edges = rebuildTagEdges(db, {})
      const topics = buildTopicEdges(db, {})
      const ts = nowSec()
      // TTL：过期的 active 节点降级 stale（不物理删，召回自然失效）。
      const info = db.prepare(`UPDATE nodes SET status='stale', updated_at=?
        WHERE status='active' AND expired_at IS NOT NULL AND expired_at < ?`).run(ts, ts)
      return {
        edges: Number(edges?.edges || 0), tags: Number(edges?.tags || 0),
        topic_edges: Number(topics?.edges || 0), merged: Number(dedupe?.merged || 0),
        stale: Number(info?.changes || 0),
      }
    })
  })

  keeper.register('archive', async () => {
    const days = Number(config?.privacy?.retentionDays || 0)
    if (!(days > 0)) return { skipped: 'retention_disabled' }
    const cutoff = nowSec() - days * 86400
    return store.withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      let deleted = 0
      try {
        const info = db.prepare(`DELETE FROM nodes WHERE status='archived' AND updated_at < ?`).run(cutoff)
        deleted = Number(info?.changes || 0)
        db.prepare(`INSERT INTO writes (ts,trace_id,action,node_id,reason,mode)
          VALUES (?,?,'ARCHIVE',NULL,?,'auto')`).run(nowSec(), '', `retention_days=${days}; cutoff=${cutoff}; deleted=${deleted}`)
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* noop */ }
        throw err
      }
      log(`[whale-memory] keeper archive deleted=${deleted} days=${days}`)
      return { deleted, cutoff, days }
    })
  })

  keeper.register('vector', async () => {
    if (!config?.embed?.enabled) return { skipped: 'embed_disabled' }
    const rows = store.withDb((db) => db.prepare(`SELECT id FROM nodes WHERE vector_state='pending' LIMIT ?`).all(VECTOR_BATCH))
    if (rows.length === 0) return { processed: 0, skipped: 'vector_empty' }
    // 本机没有嵌入实现（config.embed 只定义开关，未接 provider）：
    // 不改 vector_state、不报失败，接上实现后同一批 pending 自然重跑。
    return { pending: rows.length, skipped: 'embed_unavailable' }
  })

  keeper.register('report', async () => {
    const dbFile = typeof store.dbFile === 'string' ? store.dbFile : ''
    if (!dbFile) return { skipped: 'no_dbfile' }
    const ts = nowSec()
    const day = dayStamp(ts)
    const stats = store.withDb((db) => {
      const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0)
      return {
        nodes: one('SELECT count(*) AS n FROM nodes'),
        active: one("SELECT count(*) AS n FROM nodes WHERE status='active'"),
        edges: one('SELECT count(*) AS n FROM edges'),
        jobsDone: one(`SELECT count(*) AS n FROM jobs WHERE state='done' AND updated_at >= ?`, ts - 86400),
        jobsFailed: one(`SELECT count(*) AS n FROM jobs WHERE state='failed' AND updated_at >= ?`, ts - 86400),
        recalls: one('SELECT count(*) AS n FROM recalls WHERE ts >= ?', ts - 86400),
        withHits: one(`SELECT count(*) AS n FROM recalls WHERE ts >= ? AND hit_ids NOT IN ('[]','')`, ts - 86400),
        injected: one('SELECT count(*) AS n FROM recalls WHERE ts >= ? AND injected=1', ts - 86400),
      }
    })
    const totalJobs = stats.jobsDone + stats.jobsFailed
    const jobRate = totalJobs > 0 ? Math.round((stats.jobsDone / totalJobs) * 1000) / 10 : 100
    // 零注入不计：无命中的召回说明没得注，不算失手，不进注入率分母。
    const injectRate = stats.withHits > 0 ? Math.round((stats.injected / stats.withHits) * 1000) / 10 : 0
    const markdown = [
      `# 记忆日报 ${day}`,
      '',
      '## 规模',
      '',
      `- 节点总数：${stats.nodes}`,
      `- active：${stats.active}`,
      `- edges：${stats.edges}`,
      '',
      '## 近 24h 作业',
      '',
      `- 成功率：${jobRate}%（done ${stats.jobsDone} / failed ${stats.jobsFailed}）`,
      '',
      '## 近 24h 召回',
      '',
      `- 召回：${stats.recalls} 次（有命中 ${stats.withHits} 次）`,
      `- 注入：${stats.injected} 次，注入率 ${injectRate}%（零注入不计：无命中的召回不进分母）`,
      '',
    ].join('\n')
    const dir = join(dirname(dbFile), 'reports')
    const path = join(dir, `${day}.md`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, markdown, 'utf8')
    return { path, nodes: stats.nodes, active: stats.active, edges: stats.edges }
  })
}

/** 本地日期戳 YYYY-MM-DD（日报文件名口径）。 */
function dayStamp(seconds) {
  const d = new Date(toSeconds(seconds) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 装配：createKeeper（含默认 handlers 与 unref 定时器）+ ctx.effect 生命周期。
 * ctx 卸载时 dispose（清 timer、置 disposed），不重复注册 handlers。
 *
 * @param {{ effect?: (fn: () => () => void, label?: string) => any }} ctx
 * @param {Parameters<typeof createKeeper>[0]} deps
 */
/**
 * 崩溃残留回收（铁律 3）：本进程刚启动，任何 state='running' 都是上个进程留下的；
 * 置回 queued 让 tick 续跑，否则该 kind 会被单飞条件永远挡住。
 * @param {{ withDb: Function }} store
 * @param {(line: string) => void} [log]
 * @returns {number} 回收条数
 */
export function recoverRunningJobs(store, log = () => {}) {
  if (!store || typeof store.withDb !== 'function') return 0
  const changed = Number(store.withDb((db) => db.prepare(
    "UPDATE jobs SET state='queued', next_at=NULL, updated_at=? WHERE state='running'",
  ).run(Date.now() / 1000))?.changes || 0)
  if (changed > 0) log(`[whale-memory] keeper recovered ${changed} stale running job(s)`)
  return changed
}

/**
 * 装配：先回收崩溃残留，再 createKeeper（默认 handlers + unref 定时器）+ ctx.effect 生命周期。
 *
 * @param {{ effect?: (fn: () => () => void, label?: string) => any }} ctx
 * @param {Parameters<typeof createKeeper>[0]} deps
 */
export function installKeeper(ctx, deps = {}) {
  recoverRunningJobs(deps.store, deps.log)
  const keeper = createKeeper(deps)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => keeper.dispose(), 'whale-memory: keeper')
  }
  return keeper
}
