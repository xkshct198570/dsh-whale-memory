// 职责：jobs.payload 的正文治理（终态脱敏 / 超期清理）与「终态 / 可重试」判据唯一真源。
// 依赖方向：零依赖叶模块；keeper/scheduler、writer/queue、keeper/handlers 只 import 本模块。
//
// 为什么必须集中：jobs.payload 承载过写事件正文（memory text）与大导入的整段 JSONL，
// 终态后没人再需要它；脱敏写点分散在调度器与写队列，判据（哪些行算终态、保留哪些键）
// 一旦各写一份就会漂移成「一边脱敏一边留正文」。

/**
 * 重试上限：keeper（非 write）与写队列（write）共用同一数值。
 * 失败行的 payload 在 attempts 达上限前必须原样保留（重跑要读正文/游标），
 * 所以「failed」不等于「终态」——判据必须带上 attempts。
 */
export const RETRY_MAX_ATTEMPTS = 4

/**
 * 终态后仍保留的 payload 键（全部不含正文）：
 * - `reason`：反思自动日限按它判 turn_steps/idle（0.8.1-09）；
 * - `result`：写队列 waiter 结算（settleFromRow 只读 result）；
 * - `sessionId/identity/runId/spoolPath/materialHash/total`：追溯键，都不是正文。
 * 未列出的键（`text`、import 的 `jsonl`、`ingestPolicy`、`__judgeVerdict`…）一律丢弃。
 */
export const TERMINAL_PAYLOAD_KEYS = Object.freeze([
  'reason', 'sessionId', 'identity', 'runId', 'spoolPath', 'materialHash', 'total', 'result',
])

/**
 * 一行 job 是否已是终态（不会再被自动重跑）。
 * 判据：done；或 failed 且 attempts 已达重试上限（keeper 只重排 attempts<MAX 的 failed）。
 * @param {{ state?: unknown, attempts?: unknown } | null | undefined} row
 * @returns {boolean}
 */
export function isTerminalJob(row) {
  const state = String(row?.state ?? '')
  if (state === 'done') return true
  if (state !== 'failed') return false
  return Number(row?.attempts || 0) >= RETRY_MAX_ATTEMPTS
}

/**
 * 终态 payload 脱敏：只保留白名单键。
 * 接受对象或 JSON 文本；解析失败/非对象一律落 `{}`（安全默认，绝不把原正文透传出去）。
 *
 * @param {unknown} raw payload 原文（JSON 文本或对象）
 * @returns {string} 脱敏后的 JSON 文本
 */
export function redactJobPayload(raw) {
  let obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { return '{}' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}'
  const kept = {}
  for (const key of TERMINAL_PAYLOAD_KEYS) {
    if (obj[key] !== undefined) kept[key] = obj[key]
  }
  return JSON.stringify(kept)
}

/**
 * 单条终态行脱敏（终态转移时调用；非终态一律不动）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @returns {boolean} 是否真的改写了 payload
 */
export function scrubTerminalPayload(db, id) {
  const row = db.prepare('SELECT id,state,attempts,payload FROM jobs WHERE id=?').get(Number(id))
  if (!row || !isTerminalJob(row)) return false
  const next = redactJobPayload(row.payload)
  if (next === String(row.payload ?? '')) return false
  db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(next, Number(id))
  return true
}

/**
 * 修补式扫库：对所有终态行重跑脱敏（清历史正文），并按 TTL 物理删除超期终态行。
 *
 * 不变量（测试锁定）：`queued`/`running` 与「还能重跑的 failed」的行数、payload 字节都不变。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ttlDays?: number, nowSec?: number }} [opts] ttlDays=0 表示不删（脱敏仍执行）
 * @returns {{ scanned: number, redacted: number, purged: number, ttlDays: number, cutoff: number|null }}
 */
export function sweepJobPayloads(db, { ttlDays = 0, nowSec = Date.now() / 1000 } = {}) {
  const days = Math.max(0, Math.floor(Number(ttlDays) || 0))
  const now = Number(nowSec) || Date.now() / 1000
  const rows = db.prepare(
    `SELECT id,payload FROM jobs WHERE state='done' OR (state='failed' AND attempts>=?)`,
  ).all(RETRY_MAX_ATTEMPTS)
  let redacted = 0
  for (const row of rows) {
    if (row.payload === null || row.payload === undefined) continue
    const next = redactJobPayload(row.payload)
    if (next === String(row.payload)) continue
    db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(next, Number(row.id))
    redacted += 1
  }
  let purged = 0
  const cutoff = days > 0 ? now - days * 86400 : null
  if (cutoff !== null) {
    const info = db.prepare(
      `DELETE FROM jobs WHERE (state='done' OR (state='failed' AND attempts>=?)) AND updated_at < ?`,
    ).run(RETRY_MAX_ATTEMPTS, cutoff)
    purged = Number(info?.changes || 0)
  }
  return { scanned: rows.length, redacted, purged, ttlDays: days, cutoff }
}
