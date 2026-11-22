/**
 * 旧版配置迁移（架构书 §10.3）：首次启动把 hub 0.2.0 的环境变量一次性写进 Config。
 *
 * 口径：
 * - **只执行一次**：本地库 `meta.migrated_from='hub-0.2.0'`（backend 有 withDb 时，含 hybrid）；
 *   纯 http（无本地库）落 `$DSH_HOME/whale-memory/migration.json` 幂等文件；
 * - 没有旧 env 时什么都不做（不读 marker、不写 meta、不 edit）；
 * - 保存必须走 `ctx.get('configEditor').edit(ctx.fiber.entry, fn)`，失败只记日志不抛
 *   （迁移失败绝不能挡住插件启动）；成功后日志明确"已从旧版迁移，可删除旧 env"；
 * - 迁移只改持久化配置，**当前进程已建的 backend 不会换实现**，日志提示重启后生效。
 *
 * 环境变量映射（同名常量集中在 ENV_KEYS）：
 *   AI_ROUTER_GATEWAY              → backend.url（当前 mode=local 时切 http）
 *   AI_ROUTER_HUB_TIMEOUT_MS       → backend.timeoutMs（200..30000）
 *   AI_ROUTER_HUB_RECALL_TIMEOUT_MS→ recall.timeoutMs（100..10000）
 *   AI_ROUTER_HUB_ROLE_ID/USER_ID  → identity.roleId/userId，并切 mode=fixed
 *   AI_ROUTER_HUB_ALLOW_REMOTE     → panel.allowRemote
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getMeta, setMeta } from '../core/db.js'

/** marker 值：证明这批迁移已经跑过一次。 */
export const MIGRATED_FROM = 'hub-0.2.0'
/** 无本地库时的幂等文件（相对 $DSH_HOME）。 */
export const MIGRATION_FILE = 'migration.json'

export const ENV_KEYS = Object.freeze({
  gateway: 'AI_ROUTER_GATEWAY',
  timeout: 'AI_ROUTER_HUB_TIMEOUT_MS',
  recallTimeout: 'AI_ROUTER_HUB_RECALL_TIMEOUT_MS',
  roleId: 'AI_ROUTER_HUB_ROLE_ID',
  userId: 'AI_ROUTER_HUB_USER_ID',
  allowRemote: 'AI_ROUTER_HUB_ALLOW_REMOTE',
})

const TIMEOUT_RANGE = { min: 200, max: 30000 }
const RECALL_TIMEOUT_RANGE = { min: 100, max: 10000 }

/** @param {unknown} raw @param {{ min: number, max: number }} range @returns {number | null} */
function parseTimeout(raw, range) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) return null
  // 越界值夹到 schema 约束内：迁移写入的配置必须能过 Config 校验，否则整次保存会失败。
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

/** @param {unknown} raw @returns {boolean | null} */
function parseBoolean(raw) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim().toLowerCase()
  if (!text) return null
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return null
}

/**
 * 读旧 env，构造叶子补丁。没有可迁移项返回 null（"什么都不做"）。
 * @param {Record<string, unknown>} [env]
 * @returns {{ patch: any, keys: string[] } | null}
 */
export function readLegacyEnv(env = process.env) {
  const read = (key) => {
    const raw = env ? env[key] : undefined
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const keys = []
  /** @type {{ backend?: any, identity?: any, recall?: any, panel?: any }} */
  const patch = {}

  const gateway = read(ENV_KEYS.gateway)
  if (gateway) {
    patch.backend = { url: gateway }
    keys.push(ENV_KEYS.gateway)
  }

  const timeout = parseTimeout(read(ENV_KEYS.timeout), TIMEOUT_RANGE)
  if (timeout !== null) {
    patch.backend = { ...(patch.backend || {}), timeoutMs: timeout }
    keys.push(ENV_KEYS.timeout)
  }

  const recallTimeout = parseTimeout(read(ENV_KEYS.recallTimeout), RECALL_TIMEOUT_RANGE)
  if (recallTimeout !== null) {
    patch.recall = { timeoutMs: recallTimeout }
    keys.push(ENV_KEYS.recallTimeout)
  }

  const roleId = read(ENV_KEYS.roleId)
  const userId = read(ENV_KEYS.userId)
  if (roleId || userId) {
    patch.identity = {
      // 旧 hub 用固定角色/用户：迁移后必须固定，否则 auto 会让旧库分区漂移。
      mode: 'fixed',
      ...(roleId ? { roleId } : {}),
      ...(userId ? { userId } : {}),
    }
    if (roleId) keys.push(ENV_KEYS.roleId)
    if (userId) keys.push(ENV_KEYS.userId)
  }

  const allowRemote = parseBoolean(read(ENV_KEYS.allowRemote))
  if (allowRemote !== null) {
    patch.panel = { allowRemote }
    keys.push(ENV_KEYS.allowRemote)
  }

  return keys.length > 0 ? { patch, keys } : null
}

/** schemastery 的 `.volatile()` 值可能是 Ref：迁移只写纯值。 */
function plainTree(input) {
  if (input && typeof input === 'object' && typeof input.get === 'function' && !Array.isArray(input)) {
    return plainTree(input.get())
  }
  if (Array.isArray(input)) return input.map((item) => plainTree(item))
  if (input && typeof input === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(input)) out[key] = plainTree(val)
    return out
  }
  return input
}

/** 叶子深合并：只覆盖补丁里提交的叶子，未提交字段原样保留（与 /config POST 同口径）。 */
function leafMerge(base, patch) {
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = leafMerge(out[key], val)
    } else {
      out[key] = Array.isArray(val) ? val.slice() : val
    }
  }
  return out
}

/** 网关地址存在且当前是 local（或未配置）时才切 http；已是 http/hybrid 时不动 mode。 */
function withMode(patch, currentMode) {
  const mode = typeof currentMode === 'string' ? currentMode : ''
  if (!patch?.backend?.url) return patch
  if (mode && mode !== 'local') return patch
  return { ...patch, backend: { ...patch.backend, mode: 'http' } }
}

/** @param {{ dshHome?: string }} [opts] @returns {string} */
export function migrationFilePath({ dshHome = '' } = {}) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(home, 'whale-memory', MIGRATION_FILE)
}

/** 读幂等 marker；无本地库时读文件；不存在/损坏一律 null。 */
function readMarker(backend, file, log) {
  if (backend && typeof backend.withDb === 'function') {
    try {
      return backend.withDb((db) => ({
        from: getMeta(db, 'migrated_from'),
        at: getMeta(db, 'migrated_at'),
      }))
    } catch (err) {
      log(`[whale-memory] migration marker read fail-open: ${err?.message || err?.name || 'error'}`)
      return null
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { from: parsed?.migratedFrom || null, at: parsed?.migratedAt || null }
  } catch {
    return null
  }
}

/** 写幂等 marker；成功 true，失败 false（失败不抛，下个启动重试）。 */
function writeMarker(backend, file, atIso, log) {
  if (backend && typeof backend.withDb === 'function') {
    try {
      backend.withDb((db) => {
        setMeta(db, 'migrated_from', MIGRATED_FROM)
        setMeta(db, 'migrated_at', atIso)
      })
      return true
    } catch (err) {
      log(`[whale-memory] migration marker write fail-open: ${err?.message || err?.name || 'error'}`)
      return false
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ migratedFrom: MIGRATED_FROM, migratedAt: atIso }, null, 2))
    renameSync(tmp, file)
    return true
  } catch (err) {
    try { unlinkSync(`${file}.${process.pid}.tmp`) } catch { /* 临时文件清理失败不影响主流程 */ }
    log(`[whale-memory] migration file write fail-open: ${err?.message || err?.name || 'error'}`)
    return false
  }
}

/**
 * 安装首启迁移。调用即返回；实际执行在 ctx.effect 里异步进行（不阻塞 apply）。
 *
 * @param {any} ctx cordis ctx（configEditor / fiber.entry）
 * @param {{ backend?: any, log?: (line: string) => void, env?: Record<string, unknown>,
 *   dshHome?: string }} [opts]
 * @returns {{ state: { migratedFrom: string | null, migratedAt: string | null, pending: boolean },
 *   run: () => Promise<void>, ready: Promise<void> | null }}
 */
export function installConfigMigration(ctx, {
  backend = null,
  log = () => {},
  env = process.env,
  dshHome = '',
} = {}) {
  /** @type {{ migratedFrom: string | null, migratedAt: string | null, pending: boolean }} */
  const state = { migratedFrom: null, migratedAt: null, pending: false }
  const file = migrationFilePath({ dshHome })
  const legacy = readLegacyEnv(env)
  let ready = null

  const execute = async () => {
    try {
      // 没有旧 env：连 marker 都不读（"什么都不做"，不写 meta）。
      if (!legacy) return

      const marker = readMarker(backend, file, log)
      if (marker?.from) {
        state.migratedFrom = marker.from
        state.migratedAt = marker.at || null
        state.pending = false
        log(`[whale-memory] legacy config already migrated from=${marker.from}，跳过`)
        return
      }

      // 旧 env 在、但还没迁：先标记"待执行"，面板/`/stats` 立刻可见。
      state.pending = true

      const editor = ctx && typeof ctx.get === 'function' ? ctx.get('configEditor') : null
      const entry = ctx?.fiber?.entry
      if (!editor || typeof editor.edit !== 'function' || !entry) {
        log('[whale-memory] 检测到旧版 env，但 configEditor 不可用：迁移待执行（下次启动重试）')
        return
      }

      await editor.edit(entry, (current) => {
        const plain = plainTree(current || {})
        return leafMerge(plain, withMode(legacy.patch, plain?.backend?.mode))
      })

      const at = new Date().toISOString()
      const marked = writeMarker(backend, file, at, log)
      state.migratedFrom = MIGRATED_FROM
      state.migratedAt = at
      state.pending = !marked
      log(`[whale-memory] 已从旧版迁移（${legacy.keys.join(', ')}），可删除旧 env；重启 DSH 后生效`)
    } catch (err) {
      state.pending = true
      log(`[whale-memory] config migration fail-open: ${err?.message || err?.name || 'error'}`)
    }
  }

  const run = () => {
    if (!ready) ready = execute()
    return ready
  }

  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => { void run() }, 'whale-memory: config migration')
    } catch (err) {
      log(`[whale-memory] config migration install fail-open: ${err?.message || err?.name || 'error'}`)
    }
  } else {
    void run()
  }

  return { state, run, get ready() { return ready } }
}
