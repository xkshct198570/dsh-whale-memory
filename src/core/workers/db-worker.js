/**
 * db-worker：worker_threads 入口（S2 隔离层）。
 *
 * 为什么存在：`node:sqlite` 是同步 API，检索/计数跑在主线程会卡住事件循环。
 * 本文件把"打开只读库 + 跑检索"整段搬进独立线程，主线程只收发消息。
 *
 * 协议（父线程 → 本线程）：{ id, op, ... }
 *   op='probe'  { sleepMs }                       → { id, ok:true, op:'probe', sleptMs }
 *   op='search' { dbPath, query, limit, identity, minRel, diffusion, minConf }
 *                                                 → { id, ok:true, op:'search', result }
 *   op='stats'  { dbPath }                        → { id, ok:true, op:'stats', result:{ nodes, active } }
 * 任何失败：{ id, ok:false, error:{ code, message } }；本线程绝不因单个请求退出。
 *
 * 检索实现由 Agent-Core 的 src/core/search.js 提供（export function search(db, opts)），
 * 这里只负责动态 import 与库句柄生命周期；文件尚未就绪时回 search_unavailable，不假装有结果。
 */
import { parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/** S2 硬约束：每路 LIMIT 50。 */
const LIMIT_MAX = 50
/** search 模块路径按本文件定位，父线程传什么 cwd 都不影响。 */
const SEARCH_URL = new URL('../search.js', import.meta.url)

/** 本层自有的错误码；其余异常一律按 db/op 失败归类。 */
const OWN_CODES = new Set([
  'bad_request',
  'bad_op',
  'db_open_failed',
  'search_unavailable',
  'search_failed',
  'stats_failed',
  'probe_failed',
  'result_not_cloneable',
])

function fail(code, message) {
  const err = new Error(String(message ?? code))
  err.code = code
  return err
}

function toErrorMessage(err) {
  const text = err?.message ?? String(err ?? 'unknown error')
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

function toErrorPayload(err) {
  const rawCode = typeof err?.code === 'string' ? err.code : ''
  if (OWN_CODES.has(rawCode)) return { code: rawCode, message: toErrorMessage(err) }
  if (/unable to open database file/i.test(toErrorMessage(err))) {
    return { code: 'db_open_failed', message: toErrorMessage(err) }
  }
  return { code: 'worker_op_failed', message: toErrorMessage(err) }
}

function reply(message) {
  try {
    parentPort.postMessage(message)
    return true
  } catch (err) {
    // 结果不可结构化克隆（如函数/Symbol）时退化成错误回执，绝不让父线程干等超时。
    try {
      parentPort.postMessage({
        id: message?.id ?? null,
        ok: false,
        error: { code: 'result_not_cloneable', message: toErrorMessage(err) },
      })
    } catch { /* 连错误都发不出去只剩这一种可能：通道已关闭 */ }
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requireDbPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail('bad_request', 'dbPath 必填（string）')
  }
  return value
}

function openReadOnly(dbPath) {
  try {
    return new DatabaseSync(requireDbPath(dbPath), { readOnly: true })
  } catch (err) {
    if (OWN_CODES.has(err?.code)) throw err
    throw fail('db_open_failed', toErrorMessage(err))
  }
}

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return LIMIT_MAX
  return Math.min(LIMIT_MAX, Math.max(1, Math.trunc(n)))
}

/** search 模块只在首次成功加载后缓存；文件后补到位也能生效。 */
let searchModule = null

async function loadSearch() {
  if (searchModule) return searchModule
  let mod
  try {
    mod = await import(SEARCH_URL.href)
  } catch (err) {
    throw fail('search_unavailable', `无法加载 search.js：${toErrorMessage(err)}`)
  }
  searchModule = mod
  return mod
}

function pickSearchFn(mod) {
  const fn = mod?.search ?? mod?.default?.search ?? (typeof mod?.default === 'function' ? mod.default : null)
  if (typeof fn !== 'function') {
    throw fail('search_unavailable', 'search.js 未导出 search(db, opts)')
  }
  return fn
}

async function opProbe(msg) {
  const requested = Number(msg?.sleepMs)
  const ms = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 60_000) : 0
  const startedAt = Date.now()
  if (ms > 0) await sleep(ms)
  return { op: 'probe', sleptMs: Date.now() - startedAt }
}

async function opSearch(msg) {
  const dbPath = requireDbPath(msg?.dbPath)
  const mod = await loadSearch()
  const run = pickSearchFn(mod)
  const db = openReadOnly(dbPath)
  try {
    const opts = {
      query: typeof msg?.query === 'string' ? msg.query : String(msg?.query ?? ''),
      limit: clampLimit(msg?.limit),
      identity: msg?.identity,
      minRel: msg?.minRel,
      // 与 client.search 成对：漏一个就会让 advanced.worker 下的扩散开关哑掉。
      diffusion: msg?.diffusion,
      minConf: msg?.minConf,
    }
    const result = await run(db, opts)
    return { op: 'search', result }
  } catch (err) {
    if (OWN_CODES.has(err?.code)) throw err
    throw fail('search_failed', toErrorMessage(err))
  } finally {
    try { db.close() } catch { /* 关闭失败不影响结果 */ }
  }
}

function nodesColumns(db) {
  const rows = db.prepare("SELECT name FROM pragma_table_info('nodes')").all()
  return new Set(rows.map((row) => String(row?.name)))
}

function countRows(db, whereSql) {
  const sql = whereSql ? `SELECT COUNT(*) AS c FROM nodes WHERE ${whereSql}` : 'SELECT COUNT(*) AS c FROM nodes'
  const row = db.prepare(sql).get()
  return Number(row?.c ?? 0)
}

function opStats(msg) {
  const dbPath = requireDbPath(msg?.dbPath)
  const db = openReadOnly(dbPath)
  try {
    const cols = nodesColumns(db)
    // 空库/尚未建表：明确回 0，而不是把"没初始化"当故障或编造计数。
    if (cols.size === 0) return { op: 'stats', result: { nodes: 0, active: 0 } }
    const nodes = countRows(db, '')
    const where = []
    if (cols.has('status')) where.push("status = 'active'")
    else if (cols.has('active')) where.push('active = 1')
    else if (cols.has('state')) where.push("state = 'active'")
    else if (cols.has('superseded_by')) where.push('superseded_by IS NULL')
    if (cols.has('deleted_at')) where.push('deleted_at IS NULL')
    const active = where.length ? countRows(db, where.join(' AND ')) : nodes
    return { op: 'stats', result: { nodes, active } }
  } catch (err) {
    if (OWN_CODES.has(err?.code)) throw err
    throw fail('stats_failed', toErrorMessage(err))
  } finally {
    try { db.close() } catch { /* 关闭失败不影响结果 */ }
  }
}

async function handle(msg) {
  const id = msg?.id ?? null
  const op = typeof msg?.op === 'string' ? msg.op : ''
  try {
    let payload
    if (op === 'probe') payload = await opProbe(msg)
    else if (op === 'search') payload = await opSearch(msg)
    else if (op === 'stats') payload = opStats(msg)
    else throw fail('bad_op', `未知 op：${op || '(空)'}`)
    reply({ id, ok: true, ...payload })
  } catch (err) {
    const error = toErrorPayload(err)
    // 保留 op 便于父线程/日志定位；失败也一定带 id 回执。
    reply({ id, ok: false, op: op || null, error })
  }
}

if (parentPort) {
  parentPort.on('message', (msg) => { void handle(msg) })

  // 兜底：单请求的 try/catch 已覆盖业务异常；这里只防"线程意外退出"导致父线程假死。
  process.on('uncaughtException', (err) => {
    try { console.error(`[whale-memory:worker] uncaught: ${toErrorMessage(err)}`) } catch { /* ignore */ }
  })
  process.on('unhandledRejection', (err) => {
    try { console.error(`[whale-memory:worker] unhandled rejection: ${toErrorMessage(err)}`) } catch { /* ignore */ }
  })
}
