/**
 * 本地库入口（L3 存储层，S2 MVP）：打开/关闭/元数据/时间。
 *
 * 口径：
 * - 库文件固定为 `<dataDir>/memory.db`；dataDir 为空时落 `$DSH_HOME/whale-memory`（可用环境变量迁移）。
 * - 打开即建目录、WAL、busy_timeout=5000，并执行 ensureSchema（幂等）。
 * - readOnly=true 时不建目录、不切 WAL、不写 schema（用于备份/诊断）；调用方自担"库必须已存在"。
 * - 单写者：本模块不提供连接池，同一 dataDir 由上层串行使用（worker 单飞）。
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema } from './schema.js'

export const DB_FILE = 'memory.db'

const BUSY_TIMEOUT_MS = 5000

/**
 * @param {string} dataDir 数据目录（不存在则创建）
 * @param {{ readOnly?: boolean }} [opts]
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dataDir, { readOnly = false } = {}) {
  const raw = String(dataDir ?? '').trim()
  const dir = raw ? resolve(raw) : join(process.env.DSH_HOME || process.cwd(), 'whale-memory')

  if (!readOnly) mkdirSync(dir, { recursive: true })

  const db = new DatabaseSync(join(dir, DB_FILE), { readOnly })
  // busy_timeout 对读写都必要：并发写由 SQLite 排队，不抛 SQLITE_BUSY。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
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
