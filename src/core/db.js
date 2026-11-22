/**
 * 本地库入口（L3 存储层，S2 MVP）：打开/关闭/元数据/时间。
 *
 * 口径：
 * - 库文件固定为 `<dataDir>/memory.db`；dataDir 为空时落 `$DSH_HOME/whale-memory`（可用环境变量迁移）。
 * - 打开即建目录、WAL、busy_timeout=5000，并执行 ensureSchema（幂等）。
 * - readOnly=true 时不建目录、不切 WAL、不写 schema（用于备份/诊断）；调用方自担"库必须已存在"。
 * - 单写者：本模块不提供连接池，同一 dataDir 由上层串行使用（worker 单飞）。
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema, SCHEMA_VERSION } from './schema.js'

export const DB_FILE = 'memory.db'
/** 迁移快照保留份数：与 scripts/migrate-audit.mjs 的 MAX_BACKUPS 同口径。 */
export const MAX_BACKUPS = 5
const BACKUP_DIR = 'backup'

const BUSY_TIMEOUT_MS = 5000

/** 17 位时间戳（YYYYMMDDHHmmssSSS），与 migrate-audit 的 whale-<ts>.db 命名一致。 */
function stampNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/** SQLite 字符串字面量转义（VACUUM INTO 不能用参数绑定）。 */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 迁移前快照：checkpoint(WAL) → `VACUUM INTO <dataDir>/backup/whale-<ts>.db`，只留最新 MAX_BACKUPS 份。
 *
 * 为什么必须在 ensureSchema 之前做：v2→v3 是 ALTER TABLE，虽然只加列，但一旦库里数据/索引
 * 状态异常，回退只能靠迁移前整库快照；覆盖式备份会毁掉唯一可回滚点。
 * 为什么失败不阻断启动：记忆是 fail-open 组件，快照失败（磁盘满/权限）不该让对话起不来；
 * 返回 `{ performed:false, reason }` 由调用方决定是否告警，迁移本身仍继续。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dataDir 库所在目录（决定 backup/ 落点）
 * @returns {{ performed: boolean, path?: string, deleted?: string[], reason?: string }}
 */
export function backupOnMigrate(db, dataDir) {
  const base = String(dataDir ?? '').trim()
  if (!base) return { performed: false, reason: 'no_data_dir' }
  const dir = join(resolve(base), BACKUP_DIR)
  try {
    mkdirSync(dir, { recursive: true })
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 只读/无 WAL 时忽略 */ }
    const stamp = stampNow()
    let target = join(dir, `whale-${stamp}.db`)
    for (let i = 2; statSyncSafe(target); i += 1) target = join(dir, `whale-${stamp}-${i}.db`)
    db.exec(`VACUUM INTO ${sqlString(target)}`)
    const deleted = []
    const all = readdirSync(dir)
      .filter((name) => /^whale-\d{14,17}(?:-\d+)?\.db$/.test(name))
      .sort()
    for (const name of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      const abs = join(dir, name)
      rmSync(abs, { force: true })
      deleted.push(name)
    }
    return { performed: true, path: target, deleted }
  } catch (err) {
    return { performed: false, reason: String(err?.message || err) }
  }
}

function statSyncSafe(path) {
  try { statSync(path); return true } catch { return false }
}

/** 只读探测库内 schema 版本；meta 表不存在/读失败按 0（=新库或不可读，不做快照）。 */
function readSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    const n = Number(row?.value)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * @param {string} dataDir 数据目录（不存在则创建）
 * @param {{ readOnly?: boolean, backupOnMigrate?: boolean }} [opts]
 *   backupOnMigrate=false：跳过快照（单测/临时库可用；生产默认开）。
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dataDir, { readOnly = false, backupOnMigrate: doBackup = true } = {}) {
  const raw = String(dataDir ?? '').trim()
  const dir = raw ? resolve(raw) : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-memory')

  if (!readOnly) mkdirSync(dir, { recursive: true })

  const db = new DatabaseSync(join(dir, DB_FILE), { readOnly })
  // busy_timeout 对读写都必要：并发写由 SQLite 排队，不抛 SQLITE_BUSY。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const current = readSchemaVersion(db)
    if (doBackup && current > 0 && current < SCHEMA_VERSION) {
      // 快照结果挂在连接上供诊断（db.js 无 logger；不阻断、不静默：调用方可读）。
      db.migrationBackup = backupOnMigrate(db, dir)
    }
    ensureSchema(db)
  }
  return db
}

/** 关闭连接（幂等；已关闭不抛）。 */
export function closeDb(db) {
  if (!db || typeof db.close !== 'function') return
  try {
    db.close()
  } catch {
    // 已关闭/底层异常都不应打断收尾流程
  }
}

/** 读 meta；缺失返回 null。 */
export function getMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

/** 写 meta（upsert）；值统一转字符串。 */
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value ?? ''))
}

/** 当前时间（秒级 REAL）。 */
export function now() {
  return Date.now() / 1000
}
