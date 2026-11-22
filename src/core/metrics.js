/**
 * 观测指标（架构书 §9.1）：十一项口径 + 7 日 series 的唯一真源。
 *
 * 为什么集中在一处：面板 KPI、日报、以后可能的告警必须读同一份口径。分母定义
 * （零注入率用「无命中召回」、采纳率分母只算 injected=1）一旦各写各的，
 * 历史曲线就不可比，复盘也说不清是行为变了还是统计变了。
 *
 * 为什么纯函数（只读 db、不写库）：stats() 每次面板刷新都会调用，只读接口
 * 产生副作用会让「看一眼面板」变成一次写事务；落表只由日报 handler 显式调
 * writeMetricsRows，写入时机可控、可重放。
 *
 * 为什么日期用本地时区：与既有 stats 的 setHours(0,0,0,0) 口径保持一致。
 * 用 UTC 划天会让东八区「今天」差 8 小时，日报与面板对不上同一天。
 *
 * 为什么 job_success_7d / write_reject_rate 用日历 7 日窗口而不是滚动 24h×7：
 * series 是「按自然日」的 7 根柱子，指标与柱子必须同窗口；否则报表里的
 * 曲线和顶部数字永远互相解释不通。
 */
import { statSync } from 'node:fs'

/**
 * 指标定义（唯一真源）：name 即 metrics 表列 + /stats 契约键名。
 * dir='min' 表示越大越好（≥ 目标），dir='max' 表示越小越好（≤ 目标）；
 * dir=null 的指标只观测不判达标（FTS 对齐是布尔、库体积是规模）。
 * @type {Array<{ name: string, label: string, dir: 'min'|'max'|null, target: number|null, fmt: string }>}
 */
export const METRIC_DEFS = [
  { name: 'precision_at_3', label: 'precision@3（评测集）', dir: 'min', target: 0.9, fmt: 'rate' },
  { name: 'ident_hit_rate', label: '识别命中率（评测集）', dir: 'min', target: 1.0, fmt: 'rate' },
  { name: 'zero_injection_rate', label: '零注入率（7 日）', dir: 'max', target: 0.1, fmt: 'rate' },
  { name: 'adoption_rate', label: '采纳率（7 日）', dir: 'min', target: 0.35, fmt: 'rate' },
  { name: 'idle_rate', label: '空转率（7 日）', dir: 'max', target: 0.65, fmt: 'rate' },
  { name: 'inject_chars_avg', label: '注入字数均值（7 日）', dir: 'max', target: 1500, fmt: 'chars' },
  { name: 'pending_age_max_min', label: '待向量最长滞留', dir: 'max', target: 10, fmt: 'min' },
  { name: 'job_success_7d', label: '作业成功率（7 日）', dir: 'min', target: 0.95, fmt: 'rate' },
  { name: 'write_reject_rate', label: '写入拒绝率（7 日）', dir: 'max', target: 0.2, fmt: 'rate' },
  { name: 'fts_aligned', label: 'FTS 对齐', dir: null, target: null, fmt: 'bool' },
  { name: 'db_size_bytes', label: '库体积', dir: null, target: null, fmt: 'bytes' },
]

/**
 * 初始目标（§9.1 定死；只含可判达标的九项，键名与 /stats 契约一致）。
 * @type {Readonly<Record<string, number>>}
 */
export const TARGETS = Object.freeze(Object.fromEntries(
  METRIC_DEFS.filter((def) => def.target !== null).map((def) => [def.name, def.target]),
))

/** 7 日曲线的固定长度（最旧 → 今天）。 */
const SERIES_DAYS = 7

/** 评测类指标：运行时不算评测，只读 metrics 表里最近一次评测落下的值。 */
const EVAL_METRICS = ['precision_at_3', 'ident_hit_rate']

/**
 * 每个自然日的召回聚合（一条 SQL 出 6 个数，避免 6 次往返）。
 * 零命中判定与既有 report / stats 同口径：hit_ids 为 '[]'（或空串）。
 */
const SERIES_SQL = `SELECT count(*) AS recalls,
  sum(CASE WHEN hit_ids NOT IN ('[]','') THEN 1 ELSE 0 END) AS withHits,
  sum(CASE WHEN injected = 1 THEN 1 ELSE 0 END) AS injected,
  sum(CASE WHEN injected = 1 AND used = 1 THEN 1 ELSE 0 END) AS adopted,
  sum(CASE WHEN hit_ids IN ('[]','') THEN 1 ELSE 0 END) AS zeroHit,
  avg(CASE WHEN injected = 1 THEN chars END) AS avgChars
  FROM recalls WHERE ts >= ? AND ts < ?`

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 时间戳 → 本地 YYYY-MM-DD。
 * @param {Date} date
 * @returns {string}
 */
function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 解析 YYYY-MM-DD 成本地日期部件；格式非法直接抛（宁可显式报错，不静默算错天）。
 * @param {string} day
 * @returns {{ y: number, mo: number, d: number }}
 * @throws {TypeError} day 不是 YYYY-MM-DD
 */
function parseDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new TypeError(`computeMetrics: invalid day ${day}`)
  return { y: Number(match[1]), mo: Number(match[2]), d: Number(match[3]) }
}

/**
 * 某自然日的半开区间 [本地 00:00, 次日 00:00)（秒）。
 * 用 Date(y, mo-1, d+offset) 构造而不是加减 86400：跨月/夏令时都由平台日历算准。
 * @param {{ y: number, mo: number, d: number }} parts
 * @param {number} [offsetDays]
 * @returns {{ start: number, end: number }}
 */
function dayBounds(parts, offsetDays = 0) {
  const start = new Date(parts.y, parts.mo - 1, parts.d + offsetDays, 0, 0, 0, 0)
  const end = new Date(parts.y, parts.mo - 1, parts.d + offsetDays + 1, 0, 0, 0, 0)
  return { start: start.getTime() / 1000, end: end.getTime() / 1000 }
}

/**
 * 统计 7 日窗口内的召回（按自然日分桶，最旧 → 今天）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ y: number, mo: number, d: number }} parts 锚点日（窗口末日）
 * @returns {{ series: object[], windowStart: number, windowEnd: number }}
 */
function buildSeries(db, parts) {
  const stmt = db.prepare(SERIES_SQL)
  const series = []
  for (let offset = -(SERIES_DAYS - 1); offset <= 0; offset += 1) {
    const { start, end } = dayBounds(parts, offset)
    const row = stmt.get(start, end) || {}
    const avgChars = row.avgChars === null || row.avgChars === undefined ? null : Number(row.avgChars)
    series.push({
      day: dayKey(new Date(parts.y, parts.mo - 1, parts.d + offset)),
      recalls: Number(row.recalls || 0),
      withHits: Number(row.withHits || 0),
      injected: Number(row.injected || 0),
      adopted: Number(row.adopted || 0),
      zeroHit: Number(row.zeroHit || 0),
      avgChars: Number.isFinite(avgChars) ? avgChars : null,
    })
  }
  return {
    series,
    windowStart: dayBounds(parts, -(SERIES_DAYS - 1)).start,
    windowEnd: dayBounds(parts, 0).end,
  }
}

/**
 * 读 metrics 表里某指标最近一天的值（评测结果由评测脚本落这张表，运行时不再跑评测）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {number|null} 无记录/非数值一律 null
 */
function latestEvalMetric(db, name) {
  try {
    const row = db.prepare('SELECT value FROM metrics WHERE name = ? ORDER BY day DESC LIMIT 1').get(name)
    const value = row ? Number(row.value) : NaN
    return Number.isFinite(value) ? value : null
  } catch {
    // 旧库/手工裁剪库可能没有 metrics 表：评测指标按「未接入」处理，不阻断观测。
    return null
  }
}

/**
 * FTS 对齐判定：nodes 行数必须与两张 FTS 的索引行数一致。
 *
 * 为什么优先比 *_docsize 而不是 count(*)：外部内容表（content='nodes'）的
 * count(*) 实际扫的是 nodes 本身，触发器缺失时仍然相等，证明不了索引完整。
 * docsize 每入索引一条文档一行，才是真索引行数。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
function ftsAligned(db) {
  const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
  const nodes = one('SELECT count(*) AS n FROM nodes')
  try {
    if (nodes !== one('SELECT count(*) AS n FROM nodes_fts_docsize')) return false
    if (nodes !== one('SELECT count(*) AS n FROM nodes_fts_bi_docsize')) return false
    return true
  } catch {
    // 极端裁剪的 FTS5 构建可能没有 docsize：退回内容表比对（与 backend 导入闸门口径一致）。
    try {
      return nodes === one('SELECT count(*) AS n FROM nodes_fts') && nodes === one('SELECT count(*) AS n FROM nodes_fts_bi')
    } catch {
      return false
    }
  }
}

/**
 * 文件字节数；不存在按 0（WAL 未生成是常态，不能因此抛错）。
 * @param {string} path
 * @returns {number}
 */
function fileSize(path) {
  try {
    return Number(statSync(path).size) || 0
  } catch {
    return 0
  }
}

/**
 * 计算十一项指标 + 7 日 series（只读，不写库）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的库连接（表由 schema 保证）
 * @param {{ day?: string, now?: number, dbFile?: string, embedEnabled?: boolean }} [opts]
 *   day: 锚点日 YYYY-MM-DD（缺省取 now 的本地日期）；now: 秒级时间戳（缺省当前时间，
 *   注入固定时钟便于测试/日报对齐）；dbFile: 库文件绝对路径（缺省不统计体积）；
 *   embedEnabled: 嵌入管线是否开（§9.1：embed 关时 pendingAgeMax 记 0——没有 worker
 *   会消费 pending，滞留时长恒涨，按真实值展示等于每天给一个不可行动的 ✗）
 * @returns {{ day: string, values: object, targets: object, series: object[] }}
 *   values 键名即 /stats 契约（十一项）；series 恒为 7 项，最旧 → 今天
 * @throws {TypeError} db 不可用 / now 非有限数 / day 格式非法
 */
export function computeMetrics(db, { day, now = Date.now() / 1000, dbFile = '', embedEnabled = true } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('computeMetrics: db required')
  const nowSec = Number(now)
  if (!Number.isFinite(nowSec)) throw new TypeError('computeMetrics: now must be finite seconds')

  const anchor = day === undefined || day === null || day === '' ? dayKey(new Date(nowSec * 1000)) : String(day)
  const parts = parseDay(anchor)
  const { series, windowStart, windowEnd } = buildSeries(db, parts)

  const totals = series.reduce((acc, item) => ({
    recalls: acc.recalls + item.recalls,
    injected: acc.injected + item.injected,
    adopted: acc.adopted + item.adopted,
    zeroHit: acc.zeroHit + item.zeroHit,
  }), { recalls: 0, injected: 0, adopted: 0, zeroHit: 0 })

  const charsRow = db.prepare(
    'SELECT avg(chars) AS v FROM recalls WHERE ts >= ? AND ts < ? AND injected = 1',
  ).get(windowStart, windowEnd)
  const charsAvg = charsRow?.v === null || charsRow?.v === undefined ? null : Number(charsRow.v)

  const jobRow = db.prepare(`SELECT
    sum(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done,
    sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM jobs WHERE updated_at >= ? AND updated_at < ? AND state IN ('done','failed')`).get(windowStart, windowEnd)
  const jobDone = Number(jobRow?.done || 0)
  const jobFailed = Number(jobRow?.failed || 0)
  const jobTotal = jobDone + jobFailed

  const writeRow = db.prepare(`SELECT count(*) AS total,
    sum(CASE WHEN action = 'REJECT' THEN 1 ELSE 0 END) AS rejects
    FROM writes WHERE ts >= ? AND ts < ?`).get(windowStart, windowEnd)
  const writeTotal = Number(writeRow?.total || 0)
  const writeRejects = Number(writeRow?.rejects || 0)

  const pendingRow = db.prepare(
    "SELECT min(created_at) AS oldest, count(*) AS n FROM nodes WHERE vector_state = 'pending'",
  ).get()
  const pendingCount = Number(pendingRow?.n || 0)
  const oldestPending = pendingRow?.oldest === null || pendingRow?.oldest === undefined ? null : Number(pendingRow.oldest)
  // 分钟保留 1 位小数：面板/日报展示用，浮点噪声（600.0000001s）不该变成 10.000001 分钟。
  // embed 关 → 恒 0：pending 是"等待嵌入"的语义，没有消费方时它只是历史残渣。
  const pendingAge = embedEnabled !== false && pendingCount > 0 && oldestPending !== null
    ? Math.max(0, Math.round(((nowSec - oldestPending) * 10) / 60) / 10)
    : 0

  const adoption = totals.injected > 0 ? totals.adopted / totals.injected : null

  const values = {
    precision_at_3: latestEvalMetric(db, EVAL_METRICS[0]),
    ident_hit_rate: latestEvalMetric(db, EVAL_METRICS[1]),
    zero_injection_rate: totals.recalls > 0 ? totals.zeroHit / totals.recalls : null,
    adoption_rate: adoption,
    idle_rate: adoption === null ? null : 1 - adoption,
    inject_chars_avg: Number.isFinite(charsAvg) ? charsAvg : null,
    pending_age_max_min: pendingAge,
    job_success_7d: jobTotal > 0 ? jobDone / jobTotal : null,
    write_reject_rate: writeTotal > 0 ? writeRejects / writeTotal : null,
    fts_aligned: ftsAligned(db),
    db_size_bytes: dbFile ? fileSize(String(dbFile)) + fileSize(`${dbFile}-wal`) : 0,
  }

  return { day: anchor, values, targets: TARGETS, series }
}

/**
 * 把指标落 metrics 表（日报 handler 调用；UPSERT 幂等，同一天可反复重算）。
 *
 * 只写数字型：null 表示「未接入」（评测没跑/没有召回），写 NULL 会污染
 * metrics.value 的 NOT NULL 约束，也会让"最近一天有值"的读取口径失准；
 * 布尔（fts_aligned）不是数值指标，由 /stats 实时算，不落表。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ day: string, values: object }} metrics computeMetrics 的返回（或同形状对象）
 * @returns {{ written: number, day: string }} written=实际 UPSERT 的指标条数
 * @throws {TypeError} db 不可用 / metrics.day 非 YYYY-MM-DD
 */
export function writeMetricsRows(db, metrics) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('writeMetricsRows: db required')
  const day = String(metrics?.day ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('writeMetricsRows: invalid metrics.day')
  const values = metrics?.values && typeof metrics.values === 'object' ? metrics.values : {}
  const stmt = db.prepare(`INSERT INTO metrics (day, name, value) VALUES (?, ?, ?)
    ON CONFLICT(day, name) DO UPDATE SET value = excluded.value`)
  let written = 0
  for (const def of METRIC_DEFS) {
    const value = values[def.name]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    stmt.run(day, def.name, value)
    written += 1
  }
  return { written, day }
}
