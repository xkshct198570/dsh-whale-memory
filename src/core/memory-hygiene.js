/**
 * 记忆库清洁审计（只读）：FTS 对齐、活跃重复、孤儿边、过期未归档、失败/积压 job、备份新旧、库体积。
 *
 * 为什么必须只读：审计会在收尾、面板、定时巡检多处被调用；任何一次「顺手修一下」都会让
 * 审计变成不可预测的写路径，也会把并发写拖进锁竞争。修复动作由调用方在拿到 fail 后另行执行
 * （并有自己的备份与回滚）。
 *
 * 为什么失败要兜成 warn 而不是抛：一张表还没建（旧库）、一条 SQL 语法不兼容，都不该让整个
 * 收尾失败；但也不能静默——把异常变成 status='warn' 的 check 行，报告里看得见。
 * 这就是 fail-open 但可见：ok 仍可能为 true，但 warnings 里必有证据。
 *
 * 检查项顺序固定（报告按节解析）：fts_aligned → duplicate_active → orphan_edges → expired_active
 * → failed_jobs → pending_jobs → backup_fresh → db_size。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 备份新鲜度阈值：7 天。超期不算故障（不阻塞收尾），但要在报告里提醒。 */
const BACKUP_MAX_AGE_SEC = 7 * 24 * 60 * 60
const DAY_SEC = 24 * 60 * 60

/**
 * 取单个标量计数；任何异常直接抛给调用方，由 runCheck 兜成 warn。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql 只允许 SELECT count(*)
 * @param {Array<unknown>} [params]
 * @returns {number}
 */
function scalar(db, sql, params = []) {
  const row = db.prepare(sql).get(...params)
  const value = row ? Number(row.n) : 0
  if (!Number.isFinite(value)) throw new Error(`non_finite_count: ${sql}`)
  return value
}

/** 安全计数：给 stats 用，异常落 0（stats 只做展示，不该让审计失败）。 */
function safeCount(db, sql, params = []) {
  try { return scalar(db, sql, params) } catch { return 0 }
}

/**
 * FTS 索引里的真实文档行数（读 FTS5 的 `_docsize` 影子表）。
 *
 * 为什么不能只数 nodes_fts：这两个 FTS5 表是外部内容表（content='nodes'），
 * 对它们做 count(*) 读的其实是 nodes，恒等于 nodes 行数——触发器失效、索引缺行时
 * 计数照样相等，检查会变成永远绿的假绿灯（铁律 22）。`_docsize` 是索引自己的行数，
 * 才能发现「node 已落库但没进索引」。
 * 读不到（columnsize=0 / 非 fts5 实现 / 影子表不存在）返回 null，调用方退回内容表计数，不阻断。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table FTS 表名（nodes_fts / nodes_fts_bi）
 * @returns {number|null}
 */
function ftsIndexRows(db, table) {
  try { return scalar(db, `SELECT count(*) AS n FROM "${table}_docsize"`) } catch { return null }
}

/** 执行一项检查：异常兜成 warn，detail 带原始错误，见得到才有意义。 */
function runCheck(key, fn) {
  try {
    return fn()
  } catch (err) {
    return { key, status: 'warn', detail: `check_error: ${err && err.message ? err.message : String(err)}` }
  }
}

/**
 * 最近一份备份（按 mtime）：目录不存在、不可读、无匹配都返回 null（调用方按「无备份」记 warn）。
 * 为什么要吞目录错误：备份目录可能还没建，这不是故障而是事实；审计该说「没有备份」，
 * 而不是抛一个让收尾整轮失败的异常。
 */
function latestBackup(backupDir) {
  if (!backupDir || typeof backupDir !== 'string') return null
  let names
  try { names = readdirSync(backupDir) } catch { return null }
  let latest = null
  for (const name of names) {
    if (!/^whale-.*\.db$/i.test(name)) continue
    try {
      const stat = statSync(join(backupDir, name))
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { name, mtimeMs: stat.mtimeMs }
    } catch { /* 单个文件 stat 失败不影响其它备份：跳过即可 */ }
  }
  return latest
}

/**
 * 审计记忆库。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的数据库连接（本函数只读）
 * @param {{dbFile?: string, nowSec?: number, backupDir?: string}} [options]
 *   dbFile 用于统计体积（statSync 失败按 0）；nowSec 缺省取当前秒；
 *   backupDir 缺省 ''（视为无备份 → warn no_backup）
 * @returns {{ok: boolean, blockers: string[], warnings: string[],
 *   stats: {nodes: number, active: number, archived: number, stale: number, superseded: number,
 *     edges: number, writes: number, ftsRows: number, ftsBiRows: number, failedJobs: number,
 *     pendingJobs: number, dbBytes: number},
 *   checks: Array<{key: string, status: 'ok'|'warn'|'fail', detail: string}>}}
 *   ok = blockers 为空；warnings 为所有 warn 项的 detail 摘要
 */
export function auditMemory(db, { dbFile = '', nowSec, backupDir = '' } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('auditMemory: db required')
  }
  const now = Number.isFinite(nowSec) && nowSec > 0 ? Math.floor(nowSec) : Math.floor(Date.now() / 1000)
  const nowMs = now * 1000
  const checks = []
  const blockers = []
  const warnings = []

  /** 统一收口：fail 进 blockers，warn 进 warnings，ok 不进任何数组。 */
  const push = (check) => {
    checks.push(check)
    if (check.status === 'fail') blockers.push(check.detail)
    if (check.status === 'warn') warnings.push(check.detail)
    return check
  }

  const nodes = safeCount(db, 'SELECT count(*) AS n FROM nodes')
  const ftsRows = safeCount(db, 'SELECT count(*) AS n FROM nodes_fts')
  const ftsBiRows = safeCount(db, 'SELECT count(*) AS n FROM nodes_fts_bi')

  push(runCheck('fts_aligned', () => {
    const base = scalar(db, 'SELECT count(*) AS n FROM nodes')
    const fts = scalar(db, 'SELECT count(*) AS n FROM nodes_fts')
    const bi = scalar(db, 'SELECT count(*) AS n FROM nodes_fts_bi')
    // 外部内容表的 count(*) 恒等于 nodes，单看它检测不出不同步；索引真实行数看 _docsize。
    const idx = ftsIndexRows(db, 'nodes_fts')
    const idxBi = ftsIndexRows(db, 'nodes_fts_bi')
    const aligned = base === fts && base === bi
      && (idx === null || base === idx)
      && (idxBi === null || base === idxBi)
    const counts = `nodes=${base} fts=${fts} fts_bi=${bi} idx=${idx === null ? 'n/a' : idx}`
      + ` idx_bi=${idxBi === null ? 'n/a' : idxBi}`
    return {
      key: 'fts_aligned',
      status: aligned ? 'ok' : 'fail',
      detail: aligned ? counts : `FTS 未对齐 ${counts}`,
    }
  }))

  push(runCheck('duplicate_active', () => {
    const groups = scalar(db, `SELECT count(*) AS n FROM (
      SELECT 1 FROM nodes
      WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')
      GROUP BY text_hash, user_id, role_id, workspace
      HAVING count(*) > 1
    )`)
    return {
      key: 'duplicate_active',
      status: groups > 0 ? 'fail' : 'ok',
      detail: groups > 0 ? `存在 ${groups} 组重复活跃节点` : '无重复活跃节点',
    }
  }))

  push(runCheck('orphan_edges', () => {
    const orphans = scalar(db, `SELECT count(*) AS n FROM edges e
      WHERE NOT EXISTS (SELECT 1 FROM nodes f WHERE f.id = e.from_id)
         OR NOT EXISTS (SELECT 1 FROM nodes t WHERE t.id = e.to_id)`)
    return {
      key: 'orphan_edges',
      status: orphans > 0 ? 'warn' : 'ok',
      detail: orphans > 0 ? `孤儿边 ${orphans} 条` : '无孤儿边',
    }
  }))

  push(runCheck('expired_active', () => {
    const expired = scalar(db,
      "SELECT count(*) AS n FROM nodes WHERE status='active' AND expired_at IS NOT NULL AND expired_at < ?",
      [now])
    return {
      key: 'expired_active',
      status: expired > 0 ? 'warn' : 'ok',
      detail: expired > 0 ? `到期未归档 ${expired} 条` : '无到期未归档节点',
    }
  }))

  push(runCheck('failed_jobs', () => {
    const failed = scalar(db, "SELECT count(*) AS n FROM jobs WHERE state='failed'")
    return {
      key: 'failed_jobs',
      status: failed > 0 ? 'warn' : 'ok',
      detail: failed > 0 ? `失败 job ${failed} 条` : '无失败 job',
    }
  }))

  push(runCheck('pending_jobs', () => {
    const pending = scalar(db, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')")
    // 积压只是计数：收尾时队列非空很常见（收尾自己就会入队），不该被当异常。
    return { key: 'pending_jobs', status: 'ok', detail: `排队/运行中 job ${pending} 条` }
  }))

  push(runCheck('backup_fresh', () => {
    const latest = latestBackup(backupDir)
    if (!latest) {
      return { key: 'backup_fresh', status: 'warn', detail: 'no_backup' }
    }
    const ageSec = Math.max(0, Math.floor((nowMs - latest.mtimeMs) / 1000))
    const fresh = ageSec <= BACKUP_MAX_AGE_SEC
    return {
      key: 'backup_fresh',
      status: fresh ? 'ok' : 'warn',
      detail: fresh
        ? `${latest.name} 距今 ${Math.floor(ageSec / 3600)} 小时`
        : `${latest.name} 距今 ${Math.floor(ageSec / DAY_SEC)} 天，超过 7 天`,
    }
  }))

  const dbBytes = (() => {
    try {
      if (!dbFile) return 0
      const stat = statSync(dbFile)
      return Number.isFinite(stat.size) ? stat.size : 0
    } catch { return 0 }
  })()

  push(runCheck('db_size', () => ({
    key: 'db_size',
    status: 'ok',
    detail: dbFile ? `${dbFile} ${dbBytes} 字节` : `未提供 dbFile（0 字节）`,
  })))

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    stats: {
      nodes,
      active: safeCount(db, "SELECT count(*) AS n FROM nodes WHERE status='active'"),
      archived: safeCount(db, "SELECT count(*) AS n FROM nodes WHERE status='archived'"),
      stale: safeCount(db, "SELECT count(*) AS n FROM nodes WHERE status='stale'"),
      superseded: safeCount(db, "SELECT count(*) AS n FROM nodes WHERE status='superseded'"),
      edges: safeCount(db, 'SELECT count(*) AS n FROM edges'),
      writes: safeCount(db, 'SELECT count(*) AS n FROM writes'),
      ftsRows,
      ftsBiRows,
      failedJobs: safeCount(db, "SELECT count(*) AS n FROM jobs WHERE state='failed'"),
      pendingJobs: safeCount(db, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')"),
      dbBytes,
    },
    checks,
  }
}
