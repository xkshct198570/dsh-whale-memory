#!/usr/bin/env node
/**
 * 迁移审计 + 边迁移（一命令化）。
 *
 * 用途：把 Python 网关库（memory_nodes/memory_edges/memory_fts）与插件本地库
 * （nodes/edges/nodes_fts/nodes_fts_bi）放一起对账，回答三个问题：
 *   1. 两边节点/边/FTS 差多少，差在哪些分区与状态；
 *   2. text_hash 到底能映射上多少节点（Python 是 sha1(raw)，插件是 sha256(normalize)，
 *      算法不同，直接等值必然为 0，必须按插件口径重算）；
 *   3. 用 eval.json 的查询双读，迁移后召回会不会明显变差。
 *
 * 红线：
 * - Python 库只读打开，任何模式都不写；
 * - dry-run（默认）下插件库也只读打开，且明确打印「未写库」；
 * - 只有 `--apply` 才写插件库；写之前默认先 `wal_checkpoint(TRUNCATE)` 再
 *   `VACUUM INTO <plugin-db 目录>/backup/whale-<ts>.db`，备份最多保留 5 份；
 * - 边迁移只写 `etype='similar' / source='manual'`，Python 的 etype/source 不复制；
 *   supersede/mutex 行跳过（Python 侧没有可依赖的类型语义），报告里写明。
 *
 * 用法：
 *   node scripts/migrate-audit.mjs                       # dry-run + 默认路径
 *   node scripts/migrate-audit.mjs --report -            # 只打 stdout，不落报告
 *   node scripts/migrate-audit.mjs --apply               # 备份 + 只审计，不写边
 *   node scripts/migrate-audit.mjs --apply --apply-edges # 备份 + 写 similar 边
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { search } from '../src/core/search.js'
import { buildPlan } from '../src/core/queryplan.js'
import { contentHash, normalize } from '../src/core/tokenize.js'
import { clamp01 } from '../src/core/relations.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const FIXTURE_PATH = join(REPO_ROOT, 'test', 'fixtures', 'eval.json')

/** 边迁移的固定口径：不复制 Python 的 etype/source。 */
export const EDGE_ETYPE = 'similar'
export const EDGE_SOURCE = 'manual'
/** Python 侧类型不可信/插件侧语义不同，明确不迁的两类。 */
export const SKIP_EDGE_TYPES = new Set(['supersede', 'mutex'])
/** 备份保留份数。 */
export const MAX_BACKUPS = 5
/** 双读时插件 search 的条数（Python 侧固定 LIMIT 50）。 */
const DEFAULT_TOPN = 5
const PLUGIN_DB_FILE = 'memory.db'
const PYTHON_DB_FILE = 'whale.db'

const compactStamp = (date = new Date()) => date.toISOString().replace(/\D/g, '').slice(0, 17)
const isoNow = () => new Date().toISOString()

const sqliteString = (value) => `'${String(value).replace(/'/g, "''")}'`
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0)
const truncate = (text, max = 48) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** `~` 展开；相对路径按当前目录解析。 */
function expandPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return resolve(raw)
}

/**
 * 解析 CLI 参数。未知参数直接报错，避免静默跑错库。
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const stamp = compactStamp()
  const opts = {
    pythonDb: join(homedir(), 'ai-router-microservice', 'data', PYTHON_DB_FILE),
    pluginDb: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-memory', PLUGIN_DB_FILE),
    apply: false,
    applyEdges: false,
    backup: true,
    backupDir: '', // 空=跟随 --plugin-db 所在目录的 backup/（不写进代码仓）
    report: '', // 空=同 backupDir 下 migrate-audit-<ts>.md
    queries: FIXTURE_PATH,
    topN: DEFAULT_TOPN,
    json: false,
    help: false,
    dryRunFlag: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '')
    if (arg === '-h' || arg === '--help') { opts.help = true; continue }
    if (arg === '--apply') { opts.apply = true; continue }
    if (arg === '--apply-edges') { opts.applyEdges = true; continue }
    if (arg === '--dry-run') { opts.dryRunFlag = true; continue }
    if (arg === '--backup') { opts.backup = true; continue }
    if (arg === '--no-backup') { opts.backup = false; continue }
    if (arg === '--json') { opts.json = true; continue }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)

    const eq = arg.indexOf('=')
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim()
    const known = new Set(['python-db', 'plugin-db', 'backup-dir', 'report', 'queries', 'topn'])
    if (!known.has(key)) throw new Error(`未知参数：--${key}（支持 --python-db/--plugin-db/--backup-dir/--report/--queries/--topn）`)
    let value
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('--')) throw new Error(`--${key} 缺少值`)
      value = String(next)
      i += 1
    }
    if (value === '') throw new Error(`--${key} 缺少值`)

    switch (key) {
      case 'python-db': opts.pythonDb = expandPath(value); break
      case 'plugin-db': opts.pluginDb = expandPath(value); break
      case 'backup-dir': opts.backupDir = expandPath(value); break
      case 'report': opts.report = value === '-' || value === 'stdout' ? '-' : expandPath(value); break
      case 'queries': opts.queries = expandPath(value); break
      case 'topn': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error(`--topn 必须是 1..50 的整数，收到 ${value}`)
        opts.topN = n
        break
      }
      default: throw new Error(`未知参数：--${key}`)
    }
  }

  if (opts.apply && opts.dryRunFlag) throw new Error('--apply 与 --dry-run 不能同时使用')
  if (opts.applyEdges && !opts.apply) throw new Error('--apply-edges 必须与 --apply 一起用（dry-run 不写库）')
  opts.pythonDb = expandPath(opts.pythonDb)
  opts.pluginDb = expandPath(opts.pluginDb)
  // 备份/报告默认落在插件库同目录的 backup/（$DSH_HOME/whale-memory/backup），
  // 不写进代码仓：仓内 data/ 不是用户数据目录，迁移产物不该变成未跟踪文件。
  if (!opts.backupDir) opts.backupDir = join(dirname(opts.pluginDb), 'backup')
  if (!opts.report) opts.report = join(opts.backupDir, `migrate-audit-${stamp}.md`)
  opts.backupDir = expandPath(opts.backupDir)
  return opts
}

/** 目录路径补默认文件名；文件路径原样。 */
function normalizeDbPath(path, fileName, label) {
  const raw = String(path ?? '').trim()
  if (!raw) throw new Error(`${label} 路径为空`)
  const abs = resolve(raw)
  if (!existsSync(abs)) throw new Error(`${label} 不存在：${abs}`)
  const info = statSync(abs)
  if (info.isDirectory()) {
    const file = join(abs, fileName)
    if (!existsSync(file)) throw new Error(`${label} 目录里找不到 ${fileName}：${abs}`)
    return file
  }
  if (!info.isFile()) throw new Error(`${label} 不是普通文件：${abs}`)
  return abs
}

function openReadOnly(path, label) {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return { db, path, label }
}

function openWritable(path, label) {
  const db = new DatabaseSync(path, { readOnly: false })
  db.exec('PRAGMA busy_timeout = 5000')
  return { db, path, label }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(String(name)))
}

function countRows(db, table) {
  if (!tableExists(db, table)) return null
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n || 0)
}

function readMetaValue(db, table, keyColumn, valueColumn, key) {
  if (!tableExists(db, table)) return null
  const row = db.prepare(`SELECT ${valueColumn} AS v FROM ${table} WHERE ${keyColumn} = ?`).get(String(key))
  return row ? String(row.v) : null
}

function statusCounts(db, table, statusColumn = 'status') {
  const total = countRows(db, table)
  if (total === null) return null
  const byStatus = {}
  for (const row of db.prepare(`SELECT ${statusColumn} AS status, count(*) AS n FROM ${table} GROUP BY ${statusColumn}`).all()) {
    byStatus[String(row.status ?? '')] = Number(row.n || 0)
  }
  const pick = (...keys) => keys.reduce((sum, key) => sum + Number(byStatus[key] || 0), 0)
  return {
    total,
    byStatus,
    active: Number(byStatus.active || 0),
    archived: Number(byStatus.archived || 0),
    superseded: Number(byStatus.superseded || 0),
    stale: Number(byStatus.stale || 0),
    other: Math.max(0, total - pick('active', 'archived', 'superseded', 'stale')),
  }
}

function partitionCounts(db, table, roleColumn = 'role_id', userColumn = 'user_id') {
  if (!tableExists(db, table)) return []
  return db.prepare(
    `SELECT ${roleColumn} AS role_id, ${userColumn} AS user_id, count(*) AS n
     FROM ${table} GROUP BY ${roleColumn}, ${userColumn} ORDER BY n DESC, role_id, user_id`,
  ).all().map((row) => ({ role_id: String(row.role_id ?? ''), user_id: String(row.user_id ?? ''), n: Number(row.n || 0) }))
}

function ftsAlignment(db, nodesTable, ftsTables) {
  const nodes = countRows(db, nodesTable)
  const align = {}
  for (const fts of ftsTables) {
    const docsize = countRows(db, `${fts}_docsize`)
    align[fts] = { docsize, aligned: nodes !== null && docsize === nodes, missingTable: docsize === null }
  }
  const aligned = nodes !== null && Object.values(align).every((item) => item.aligned)
  return { nodes, tables: align, aligned }
}

function edgeStatsPython(db) {
  if (!tableExists(db, 'memory_edges')) return { total: null, byPartition: [], byType: [], missingEndpoints: null }
  const total = Number(db.prepare('SELECT count(*) AS n FROM memory_edges').get()?.n || 0)
  const byPartition = partitionCounts(db, 'memory_edges')
  const byType = db.prepare('SELECT etype, source, count(*) AS n FROM memory_edges GROUP BY etype, source ORDER BY n DESC')
    .all().map((row) => ({ etype: String(row.etype ?? ''), source: String(row.source ?? ''), n: Number(row.n || 0) }))
  let missingEndpoints = null
  if (tableExists(db, 'memory_nodes')) {
    missingEndpoints = Number(db.prepare(
      `SELECT count(*) AS n FROM memory_edges e
       WHERE NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.id = e.a)
          OR NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.id = e.b)`,
    ).get()?.n || 0)
  }
  return { total, byPartition, byType, missingEndpoints }
}

function edgeStatsPlugin(db) {
  if (!tableExists(db, 'edges')) return { total: null, byType: [], missingEndpoints: null }
  const total = Number(db.prepare('SELECT count(*) AS n FROM edges').get()?.n || 0)
  const byType = db.prepare('SELECT etype, source, count(*) AS n FROM edges GROUP BY etype, source ORDER BY n DESC')
    .all().map((row) => ({ etype: String(row.etype ?? ''), source: String(row.source ?? ''), n: Number(row.n || 0) }))
  let missingEndpoints = null
  if (tableExists(db, 'nodes')) {
    missingEndpoints = Number(db.prepare(
      `SELECT count(*) AS n FROM edges e
       WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.from_id)
          OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.to_id)`,
    ).get()?.n || 0)
  }
  return { total, byType, missingEndpoints }
}

function readRows(db, table, columns) {
  if (!tableExists(db, table)) throw new Error(`缺少表：${table}`)
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all().map((row) => ({ ...row }))
}

function hashText(mode, text) {
  return createHash(mode).update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * text_hash 映射：Python 侧 text_hash（sha1(raw)）与插件侧 text_hash（sha256(normalize)）
 * 算法不同，直接等值在真实库上为 0。映射顺序：
 *   1) 直接等值（兼容历史/手工导入）；
 *   2) 按插件口径重算 contentHash(Python text)；
 *   3) 诊断用回退：normalize(text) 完全相等 / Python id 与插件 id 相等。
 * 只有 1/2 算「hash 映射」，边迁移也只使用这部分的 id。
 */
export function buildNodeMapping(pythonNodes, pluginNodes) {
  const byHash = new Map()
  const byNormText = new Map()
  const byId = new Map()
  const push = (map, key, row) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  }
  for (const row of pluginNodes) {
    push(byHash, String(row.text_hash || ''), row)
    push(byNormText, normalize(row.text), row)
    byId.set(String(row.id), row)
  }

  const scoreCandidate = (row, py) => {
    let score = 0
    if (String(row.role_id ?? '') === String(py.role_id ?? '')) score += 8
    if (String(row.user_id ?? '') === String(py.user_id ?? '')) score += 4
    if (String(row.id) === String(py.id)) score += 2
    if (String(row.status) === 'active') score += 1
    return score
  }
  const pick = (candidates, py) => [...candidates].sort((a, b) =>
    scoreCandidate(b, py) - scoreCandidate(a, py) ||
    Number(a.created_at || 0) - Number(b.created_at || 0) ||
    (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0),
  )[0]

  const hashByPyId = new Map()
  const byPyId = new Map()
  const stats = {
    pythonNodes: pythonNodes.length,
    pluginNodes: pluginNodes.length,
    directHashMatches: 0,
    computedHashMatches: 0,
    hashMapped: 0,
    fallbackTextMatches: 0,
    fallbackIdMatches: 0,
    unmapped: 0,
    unmappedReasons: { not_in_plugin: 0 },
    hashSuccessRate: 0,
    duplicatePluginHashes: 0,
    duplicatePythonHashes: 0,
  }
  const samples = []
  const duplicateHashKeys = (rows) => {
    const seen = new Map()
    for (const row of rows) {
      const key = String(row.text_hash || '')
      if (!key) continue
      seen.set(key, (seen.get(key) || 0) + 1)
    }
    return [...seen.values()].filter((n) => n > 1).length
  }
  stats.duplicatePluginHashes = duplicateHashKeys(pluginNodes)
  stats.duplicatePythonHashes = duplicateHashKeys(pythonNodes)

  for (const py of pythonNodes) {
    const pyId = String(py.id)
    const pyHash = String(py.text_hash || '')
    let via = null
    let candidates = []
    if (pyHash && byHash.has(pyHash)) {
      via = 'direct_hash'
      candidates = byHash.get(pyHash)
      stats.directHashMatches += 1
    } else {
      const computed = contentHash(py.text)
      if (computed && byHash.has(computed)) {
        via = 'computed_hash'
        candidates = byHash.get(computed)
        stats.computedHashMatches += 1
      }
    }
    if (candidates.length > 0) {
      const hit = pick(candidates, py)
      const record = { pluginId: String(hit.id), via, pluginStatus: String(hit.status ?? '') }
      hashByPyId.set(pyId, record)
      byPyId.set(pyId, record)
      stats.hashMapped += 1
      continue
    }

    // 诊断回退：文本完全相等，或 id 相等（插件节点曾经改过正文/哈希格式）。
    const textCandidates = byNormText.get(normalize(py.text))
    if (textCandidates && textCandidates.length > 0) {
      const hit = pick(textCandidates, py)
      const record = { pluginId: String(hit.id), via: 'text_exact', pluginStatus: String(hit.status ?? '') }
      byPyId.set(pyId, record)
      stats.fallbackTextMatches += 1
      continue
    }
    const idHit = byId.get(pyId)
    if (idHit) {
      byPyId.set(pyId, { pluginId: pyId, via: 'python_id', pluginStatus: String(idHit.status ?? '') })
      stats.fallbackIdMatches += 1
      continue
    }
    stats.unmapped += 1
    stats.unmappedReasons.not_in_plugin += 1
    if (samples.length < 5) {
      samples.push({
        pythonId: pyId,
        status: String(py.status ?? ''),
        textHashLength: pyHash.length,
        reason: 'not_in_plugin',
        text: truncate(py.text, 40),
      })
    }
  }

  stats.hashSuccessRate = pct(stats.hashMapped, stats.pythonNodes)
  return { byPyId, hashByPyId, stats, samples, pluginById: byId }
}

function mappingByStatus(pythonNodes, mapping) {
  const out = {}
  for (const row of pythonNodes) {
    const status = String(row.status ?? '')
    if (!out[status]) out[status] = { python: 0, hashMapped: 0, fallbackMapped: 0, unmapped: 0 }
    out[status].python += 1
    const record = mapping.byPyId.get(String(row.id))
    if (!record) out[status].unmapped += 1
    else if (record.via === 'direct_hash' || record.via === 'computed_hash') out[status].hashMapped += 1
    else out[status].fallbackMapped += 1
  }
  return out
}

/**
 * 规划边迁移（不写库）：过滤 supersede/mutex、未映射端点、跨分区、自环、已存在边。
 * @param {Array<object>} pythonEdges
 * @param {{ hashByPyId: Map<string, any>, pluginById: Map<string, any> }} mapping
 * @param {Set<string>} existingPairs `${from}\u0000${to}\u0000similar`
 */
export function planEdgeMigration(pythonEdges, mapping, existingPairs) {
  const stats = {
    total: pythonEdges.length,
    planned: 0,
    skippedByType: 0,
    skippedUnmappedEndpoint: 0,
    skippedUnmappedA: 0,
    skippedUnmappedB: 0,
    skippedPartition: 0,
    skippedSelfLoop: 0,
    skippedExisting: 0,
    invalidWeight: 0,
  }
  const planned = []
  const skippedSamples = { unmapped: [], partition: [], type: [], existing: [], selfLoop: [] }
  const pushSample = (key, sample) => {
    if (skippedSamples[key].length < 5) skippedSamples[key].push(sample)
  }

  for (const edge of pythonEdges) {
    const etype = String(edge.etype ?? '')
    if (SKIP_EDGE_TYPES.has(etype)) {
      stats.skippedByType += 1
      pushSample('type', { a: String(edge.a), b: String(edge.b), etype })
      continue
    }
    const a = String(edge.a)
    const b = String(edge.b)
    const mapA = mapping.hashByPyId.get(a)
    const mapB = mapping.hashByPyId.get(b)
    if (!mapA || !mapB) {
      stats.skippedUnmappedEndpoint += 1
      if (!mapA) stats.skippedUnmappedA += 1
      if (!mapB) stats.skippedUnmappedB += 1
      pushSample('unmapped', { a, b, unmapped: !mapA ? 'a' : '', alsoB: !mapB && mapA ? 'b' : '' })
      continue
    }
    const from = String(mapA.pluginId)
    const to = String(mapB.pluginId)
    if (from === to) {
      stats.skippedSelfLoop += 1
      pushSample('selfLoop', { a, b, mapped: from })
      continue
    }
    const fromRow = mapping.pluginById.get(from)
    const toRow = mapping.pluginById.get(to)
    if (!fromRow || !toRow) {
      stats.skippedUnmappedEndpoint += 1
      pushSample('unmapped', { a, b, reason: 'plugin_row_missing' })
      continue
    }
    if (String(fromRow.role_id ?? '') !== String(edge.role_id ?? '') || String(fromRow.user_id ?? '') !== String(edge.user_id ?? '') ||
        String(toRow.role_id ?? '') !== String(edge.role_id ?? '') || String(toRow.user_id ?? '') !== String(edge.user_id ?? '')) {
      stats.skippedPartition += 1
      pushSample('partition', {
        a: from, b: to, edgePartition: `${edge.role_id}/${edge.user_id}`,
        fromPartition: `${fromRow.role_id}/${fromRow.user_id}`, toPartition: `${toRow.role_id}/${toRow.user_id}`,
      })
      continue
    }
    const key = `${from}\u0000${to}\u0000${EDGE_ETYPE}`
    if (existingPairs.has(key)) {
      stats.skippedExisting += 1
      pushSample('existing', { from, to, etype: EDGE_ETYPE })
      continue
    }
    const rawWeight = Number(edge.weight)
    const weight = Number.isFinite(rawWeight) ? rawWeight : 0
    if (!Number.isFinite(rawWeight)) stats.invalidWeight += 1
    planned.push({
      from,
      to,
      weight,
      conf: clamp01(weight, 0),
      pythonType: etype,
      pythonSource: String(edge.source ?? ''),
      role_id: String(edge.role_id ?? ''),
      user_id: String(edge.user_id ?? ''),
    })
    stats.planned += 1
  }
  return { stats, planned, skippedSamples }
}

function loadExistingPairs(db) {
  const set = new Set()
  if (!tableExists(db, 'edges')) return set
  for (const row of db.prepare("SELECT from_id, to_id, etype FROM edges WHERE etype = ?").all(EDGE_ETYPE)) {
    set.add(`${String(row.from_id)}\u0000${String(row.to_id)}\u0000${EDGE_ETYPE}`)
  }
  return set
}

/** 事务写边：UNIQUE(from,to,etype) 冲突不更新，保证重复执行 added=0。 */
export function applyPlannedEdges(db, plan) {
  if (plan.planned.length === 0) return { added: 0, skippedExisting: 0 }
  const insert = db.prepare(
    `INSERT INTO edges (from_id, to_id, etype, source, conf, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_id, to_id, etype) DO NOTHING`,
  )
  const ts = Date.now() / 1000
  let added = 0
  let skippedExisting = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const edge of plan.planned) {
      const result = insert.run(edge.from, edge.to, EDGE_ETYPE, EDGE_SOURCE, edge.conf, edge.weight, ts)
      if (Number(result.changes || 0) > 0) added += 1
      else skippedExisting += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原异常 */ }
    throw err
  }
  return { added, skippedExisting }
}

function listBackups(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^whale-\d{14,17}\.db$/.test(name))
    .map((name) => {
      const path = join(dir, name)
      let mtime = 0
      try { mtime = statSync(path).mtimeMs } catch { /* 读不到就按名字排序 */ }
      return { name, path, mtime }
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

/** 备份：checkpoint(TRUNCATE) → VACUUM INTO；随后只保留最新 MAX_BACKUPS 份 whale-*.db。 */
export function backupPluginDb(db, backupDir) {
  const dir = resolve(backupDir)
  mkdirSync(dir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  let stamp = compactStamp()
  let target = join(dir, `whale-${stamp}.db`)
  let counter = 0
  while (existsSync(target)) {
    counter += 1
    target = join(dir, `whale-${stamp}-${counter}.db`)
  }
  db.exec(`VACUUM INTO ${sqliteString(target)}`)
  const all = listBackups(dir)
  const deleted = []
  for (const item of all.slice(MAX_BACKUPS)) {
    const abs = resolve(item.path)
    if (dirname(abs) !== dir) continue // 只删备份目录里的 whale-*.db
    unlinkSync(abs)
    deleted.push(item.name)
  }
  return { performed: true, path: target, deleted, kept: Math.min(all.length, MAX_BACKUPS) }
}

/** 双读：插件 search（默认口径）vs Python memory_fts（LIMIT 50，按 trigram 口径构造查询）。 */
function pythonFtsHits(pythonDb, query, limit = 50) {
  const plan = buildPlan(query)
  const terms = [...new Set([...plan.cjkTerms, ...plan.asciiTerms, ...plan.idents, ...plan.ips])].filter((term) => term.length >= 3)
  if (terms.length === 0) {
    return { rows: [], match: '', note: 'python_trigram_requires_ge3' }
  }
  if (!tableExists(pythonDb, 'memory_fts') || !tableExists(pythonDb, 'memory_nodes')) {
    return { rows: [], match: '', note: 'memory_fts_missing' }
  }
  const match = terms.map((term) => `"${String(term).replace(/"/g, '""')}"`).join(' OR ')
  try {
    const rows = pythonDb.prepare(
      `SELECT n.id, n.text FROM memory_fts f JOIN memory_nodes n ON n.rowid = f.rowid
       WHERE memory_fts MATCH ? AND n.status = 'active' ORDER BY rank LIMIT ?`,
    ).all(match, limit).map((row) => ({ ...row }))
    return { rows, match, note: '' }
  } catch (err) {
    return { rows: [], match, note: `fts_error: ${err.message}` }
  }
}

function dualReadReport(pluginDb, pythonDb, fixturePath, topN) {
  let fixture
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  } catch (err) {
    return { fixture: fixturePath, cases: [], summary: { error: `读不到查询集：${err.message}` } }
  }
  const cases = []
  let pluginKeyTotal = 0
  let pythonKeyTotal = 0
  let interTotal = 0
  let unionTotal = 0
  let comparable = 0
  let sumPluginCoverage = 0
  let sumJaccard = 0
  let sumComparableCoverage = 0
  let sumComparableJaccard = 0

  for (const item of Array.isArray(fixture.cases) ? fixture.cases : []) {
    const query = String(item.query ?? '')
    if (!query) continue
    let pluginHits = []
    let pluginError = ''
    try {
      pluginHits = search(pluginDb, { query, limit: topN }).hits || []
    } catch (err) {
      pluginError = err.message
    }
    const pluginRows = pluginHits.map((hit) => ({ id: String(hit.id ?? ''), text: String(hit.text ?? '') }))
    const python = pythonFtsHits(pythonDb, query, 50)
    const pluginKeys = new Set(pluginRows.map((row) => normalize(row.text)).filter(Boolean))
    const pythonKeys = new Set(python.rows.map((row) => normalize(row.text)).filter(Boolean))
    const inter = [...pluginKeys].filter((key) => pythonKeys.has(key))
    const union = new Set([...pluginKeys, ...pythonKeys])
    const coverage = pct(inter.length, pluginKeys.size)
    const jaccard = pct(inter.length, union.size)
    pluginKeyTotal += pluginKeys.size
    pythonKeyTotal += pythonKeys.size
    interTotal += inter.length
    unionTotal += union.size
    sumPluginCoverage += coverage
    sumJaccard += jaccard
    const hasPythonTerms = !python.note.startsWith('python_trigram')
    if (pluginKeys.size > 0 && hasPythonTerms) {
      comparable += 1
      sumComparableCoverage += coverage
      sumComparableJaccard += jaccard
    }
    const missingInPython = pluginRows
      .filter((row) => !pythonKeys.has(normalize(row.text)))
      .slice(0, 2)
      .map((row) => ({ id: row.id, text: truncate(row.text, 40) }))
    const pythonOnly = python.rows
      .filter((row) => !pluginKeys.has(normalize(row.text)))
      .slice(0, 2)
      .map((row) => ({ id: String(row.id), text: truncate(row.text, 40) }))
    cases.push({
      id: String(item.id ?? ''),
      kind: String(item.kind ?? ''),
      query,
      expectEmpty: String(item.kind ?? '') === 'empty',
      pluginCount: pluginRows.length,
      pythonCount: python.rows.length,
      pluginKeys: pluginKeys.size,
      pythonKeys: pythonKeys.size,
      intersection: inter.length,
      union: union.size,
      overlapPercent: coverage,
      jaccardPercent: jaccard,
      pluginCoveragePercent: coverage,
      pythonTerms: python.match,
      pythonNote: python.note,
      pluginError,
      missingInPython,
      pythonOnly,
    })
  }

  const caseCount = cases.length || 1
  return {
    fixture: fixturePath,
    topN,
    pythonLimit: 50,
    compareBy: 'normalize(text) 文本集合，避免两边 id/hash 算法差异影响对比',
    cases,
    summary: {
      cases: cases.length,
      comparable,
      pluginKeyTotal,
      pythonKeyTotal,
      intersectionTotal: interTotal,
      unionTotal,
      overlapPercent: pct(interTotal, pluginKeyTotal),
      jaccardPercent: pct(interTotal, unionTotal),
      meanPluginCoveragePercent: Math.round((sumPluginCoverage / caseCount) * 100) / 100,
      meanJaccardPercent: Math.round((sumJaccard / caseCount) * 100) / 100,
      meanComparableCoveragePercent: comparable ? Math.round((sumComparableCoverage / comparable) * 100) / 100 : 0,
      meanComparableJaccardPercent: comparable ? Math.round((sumComparableJaccard / comparable) * 100) / 100 : 0,
    },
  }
}

function inspectPythonHashAlgorithm(pythonNodes) {
  let sha1Raw = 0
  let sha1Normalized = 0
  let len40 = 0
  let len64 = 0
  for (const row of pythonNodes) {
    const hash = String(row.text_hash || '')
    if (hash.length === 40) len40 += 1
    if (hash.length === 64) len64 += 1
    if (hashText('sha1', row.text) === hash) sha1Raw += 1
    if (hashText('sha1', normalize(row.text)) === hash) sha1Normalized += 1
  }
  return {
    nodeCount: pythonNodes.length,
    hashLength40: len40,
    hashLength64: len64,
    sha1RawMatches: sha1Raw,
    sha1NormalizedMatches: sha1Normalized,
    pluginExpected: 'sha256(normalize(text)) 64 位 hex',
  }
}

function inspectPluginHashAlgorithm(pluginNodes) {
  let matches = 0
  let len64 = 0
  for (const row of pluginNodes) {
    const hash = String(row.text_hash || '')
    if (hash.length === 64) len64 += 1
    if (contentHash(row.text) === hash) matches += 1
  }
  return { nodeCount: pluginNodes.length, hashLength64: len64, sha256NormalizedMatches: matches }
}

/** 收集两侧对账事实（只读）。 */
function collectAudit(pythonDb, pluginDb, opts) {
  const pythonNodes = readRows(pythonDb, 'memory_nodes',
    ['id', 'role_id', 'user_id', 'text', 'text_hash', 'status', 'created_at', 'updated_at'])
  const pluginNodes = readRows(pluginDb, 'nodes',
    ['id', 'role_id', 'user_id', 'workspace', 'text', 'text_hash', 'status', 'created_at', 'updated_at'])
  const pythonEdges = tableExists(pythonDb, 'memory_edges')
    ? readRows(pythonDb, 'memory_edges', ['role_id', 'user_id', 'a', 'b', 'weight', 'etype', 'source'])
    : []
  const mappingBase = buildNodeMapping(pythonNodes, pluginNodes)
  const mapping = {
    ...mappingBase.stats,
    byStatus: mappingByStatus(pythonNodes, mappingBase),
    samples: mappingBase.samples,
    algorithm: inspectPythonHashAlgorithm(pythonNodes),
    pluginAlgorithm: inspectPluginHashAlgorithm(pluginNodes),
  }

  const existingPairs = loadExistingPairs(pluginDb)
  const edgePlan = planEdgeMigration(pythonEdges, mappingBase, existingPairs)

  return {
    pythonNodes,
    pluginNodes,
    pythonEdges,
    mappingBase,
    mapping,
    edgePlan,
    python: {
      path: opts.pythonDb,
      schemaVersion: readMetaValue(pythonDb, 'memory_meta', 'k', 'v', 'schema_version'),
      userVersion: Number(pythonDb.prepare('PRAGMA user_version').get()?.user_version || 0),
      nodes: statusCounts(pythonDb, 'memory_nodes'),
      nodePartitions: partitionCounts(pythonDb, 'memory_nodes'),
      fts: ftsAlignment(pythonDb, 'memory_nodes', ['memory_fts', 'memory_fts_bi']),
      edges: edgeStatsPython(pythonDb),
      metaKeys: tableExists(pythonDb, 'memory_meta')
        ? pythonDb.prepare('SELECT k FROM memory_meta ORDER BY k').all().map((row) => String(row.k))
        : [],
    },
    plugin: {
      path: opts.pluginDb,
      schemaVersion: readMetaValue(pluginDb, 'meta', 'key', 'value', 'schema_version'),
      userVersion: Number(pluginDb.prepare('PRAGMA user_version').get()?.user_version || 0),
      nodes: statusCounts(pluginDb, 'nodes'),
      nodePartitions: partitionCounts(pluginDb, 'nodes'),
      fts: ftsAlignment(pluginDb, 'nodes', ['nodes_fts', 'nodes_fts_bi']),
      edges: edgeStatsPlugin(pluginDb),
    },
    mapping,
    edgePlan,
  }
}

function markdownTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`
  const line = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, line, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

function buildMarkdown(report) {
  const py = report.python
  const pg = report.plugin
  const mapping = report.mapping
  const migration = report.edgeMigration
  const dual = report.dualRead
  const lines = []
  lines.push(`# 迁移审计报告（${report.generatedAt}）`)
  lines.push('')
  lines.push(`> 模式：**${report.mode === 'apply' ? 'apply（允许写库）' : 'dry-run（未写库）'}**`)
  lines.push(`>`)
  lines.push(`> Python 库：\`${py.path}\``)
  lines.push(`> 插件库：\`${pg.path}\``)
  lines.push('')

  lines.push('## 摘要')
  lines.push('')
  lines.push(markdownTable(
    ['项', 'Python', '插件', '说明'],
    [
      ['schema 版本', py.schemaVersion ?? '—', pg.schemaVersion ?? '—', '两边独立演进，不要求相等'],
      ['节点总数', py.nodes?.total ?? '—', pg.nodes?.total ?? '—', '插件是导入后的子集/合并集'],
      ['active', py.nodes?.active ?? '—', pg.nodes?.active ?? '—', '召回只看 active'],
      ['archived', py.nodes?.archived ?? '—', pg.nodes?.archived ?? '—', '归档不复活'],
      ['superseded', py.nodes?.superseded ?? '—', pg.nodes?.superseded ?? '—', '取代关系不丢'],
      ['stale', py.nodes?.stale ?? '—', pg.nodes?.stale ?? '—', ''],
      ['FTS 对齐', py.fts?.aligned ? '✅' : '❌', pg.fts?.aligned ? '✅' : '❌', 'nodes 行数 vs 两张 FTS docsize'],
      ['边总数', py.edges?.total ?? '—', pg.edges?.total ?? '—', '插件边含 tag/reflect/manual'],
      ['text_hash 映射', `${mapping.hashMapped}/${mapping.pythonNodes}（${mapping.hashSuccessRate}%）`, '—', 'sha1(raw) → sha256(normalize) 重算'],
      ['双读 overlap', `${dual.summary?.overlapPercent ?? '—'}%`, '—', '插件 topN 命中在 Python FTS 50 中的占比'],
    ],
  ))
  lines.push('')

  lines.push('## 1. 节点与状态')
  lines.push('')
  const statusRows = []
  const statuses = [...new Set([...Object.keys(py.nodes?.byStatus || {}), ...Object.keys(pg.nodes?.byStatus || {})])].sort()
  for (const status of statuses) {
    statusRows.push([status || '(空)', py.nodes?.byStatus?.[status] ?? 0, pg.nodes?.byStatus?.[status] ?? 0])
  }
  lines.push(markdownTable(['status', 'Python', '插件'], statusRows))
  lines.push('')
  lines.push('Python 分区：')
  lines.push('')
  lines.push(markdownTable(['role_id', 'user_id', '节点数'],
    (py.nodePartitions || []).map((row) => [row.role_id || '(空)', row.user_id || '(空)', row.n])))
  lines.push('')

  lines.push('## 2. FTS 对齐')
  lines.push('')
  const ftsRows = []
  for (const [label, side] of [['Python', py], ['插件', pg]]) {
    for (const [table, info] of Object.entries(side.fts?.tables || {})) {
      ftsRows.push([label, table, info.docsize ?? '缺表', side.fts?.nodes ?? '—', info.aligned ? '✅' : '❌'])
    }
  }
  lines.push(markdownTable(['侧', 'FTS 表', 'docsize 行数', 'nodes 行数', '对齐'], ftsRows))
  lines.push('')
  if (!py.fts?.aligned || !pg.fts?.aligned) {
    lines.push('> ⚠️ FTS 未对齐：先不要写边，优先修复或重建 FTS（外部内容表可用 `INSERT INTO <fts>(<fts>) VALUES(\'rebuild\')`）。')
    lines.push('')
  }

  lines.push('## 3. 边')
  lines.push('')
  lines.push(`Python \`memory_edges\` 共 **${py.edges?.total ?? '—'}** 条；缺少端点的边 **${py.edges?.missingEndpoints ?? '—'}** 条。`)
  lines.push('')
  lines.push(markdownTable(['role_id', 'user_id', '边数'],
    (py.edges?.byPartition || []).map((row) => [row.role_id || '(空)', row.user_id || '(空)', row.n])))
  lines.push('')
  lines.push('Python 边类型（原样，仅用于说明为什么不迁 supersede/mutex）：')
  lines.push('')
  lines.push(markdownTable(['etype', 'source', '边数'],
    (py.edges?.byType || []).map((row) => [row.etype || '(空)', row.source || '(空)', row.n])))
  lines.push('')
  lines.push('插件边类型：')
  lines.push('')
  lines.push(markdownTable(['etype', 'source', '边数'],
    (pg.edges?.byType || []).map((row) => [row.etype || '(空)', row.source || '(空)', row.n])))
  lines.push('')

  lines.push('## 4. text_hash 映射')
  lines.push('')
  lines.push(`Python 节点 **${mapping.pythonNodes}**，插件节点 **${mapping.pluginNodes}**。`)
  lines.push('')
  lines.push(markdownTable(['口径', '数量', '说明'], [
    ['直接 hash 等值', mapping.directHashMatches, '历史兼容；真实库通常为 0'],
    ['按插件口径重算命中', mapping.computedHashMatches, 'sha256(normalize(Python text)) 命中插件 text_hash'],
    ['hash 映射合计', `${mapping.hashMapped}（${mapping.hashSuccessRate}%）`, '边迁移只使用这一部分'],
    ['文本完全相等回退', mapping.fallbackTextMatches, '仅诊断，不用于边迁移'],
    ['Python id 相等回退', mapping.fallbackIdMatches, '仅诊断，不用于边迁移'],
    ['未映射节点', mapping.unmapped, `原因：${Object.entries(mapping.unmappedReasons || {}).map(([key, n]) => `${key}=${n}`).join('，') || '—'}`],
  ]))
  lines.push('')
  lines.push('算法事实：')
  lines.push('')
  lines.push(markdownTable(['侧', '事实'], [
    ['Python', `sha1(raw text) 命中 ${mapping.algorithm?.sha1RawMatches ?? '—'}/${mapping.algorithm?.nodeCount ?? '—'}；40 位哈希 ${mapping.algorithm?.hashLength40 ?? '—'} 条；64 位 ${mapping.algorithm?.hashLength64 ?? '—'} 条`],
    ['插件', `sha256(normalize(text)) 命中 ${mapping.pluginAlgorithm?.sha256NormalizedMatches ?? '—'}/${mapping.pluginAlgorithm?.nodeCount ?? '—'}；64 位哈希 ${mapping.pluginAlgorithm?.hashLength64 ?? '—'} 条`],
  ]))
  lines.push('')
  lines.push('按状态：')
  lines.push('')
  lines.push(markdownTable(['status', 'Python', 'hash 映射', '回退映射', '未映射', '映射率'],
    Object.entries(mapping.byStatus || {}).sort().map(([status, item]) => [
      status || '(空)', item.python, item.hashMapped, item.fallbackMapped, item.unmapped,
      `${pct(item.hashMapped, item.python)}%`,
    ])))
  lines.push('')
  if (mapping.samples?.length) {
    lines.push('未映射样例（前 5）：')
    lines.push('')
    lines.push(markdownTable(['python id', 'status', 'hash 长度', '原因', 'text'],
      mapping.samples.map((row) => [row.pythonId, row.status, row.textHashLength, row.reason, row.text])))
    lines.push('')
  }

  lines.push('## 5. 双读对比')
  lines.push('')
  lines.push(`查询集：\`${dual.fixture}\`；插件 search topN=${dual.topN}，Python \`memory_fts\` LIMIT ${dual.pythonLimit}；对比键：${dual.compareBy}。`)
  lines.push('')
  if (dual.summary?.error) {
    lines.push(`> ⚠️ ${dual.summary.error}`)
  } else {
    lines.push(markdownTable(['指标', '值'], [
      ['用例数', dual.summary.cases],
      ['可比较用例数（有 Python trigram 词项）', dual.summary.comparable],
      ['插件命中在 Python 50 中的占比（按全部插件命中）', `${dual.summary.overlapPercent}%`],
      ['Jaccard（插件 topN vs Python 50）', `${dual.summary.jaccardPercent}%`],
      ['平均单查询覆盖率', `${dual.summary.meanPluginCoveragePercent}%`],
      ['可比较用例平均覆盖率', `${dual.summary.meanComparableCoveragePercent}%`],
      ['可比较用例平均 Jaccard', `${dual.summary.meanComparableJaccardPercent}%`],
    ]))
    lines.push('')
    lines.push(markdownTable(['用例', '查询', '插件', 'Python', '交集', 'overlap', '差异样例'],
      dual.cases.map((item) => [
        item.id, item.query, item.pluginCount, item.pythonCount, item.intersection,
        `${item.overlapPercent}%`,
        [
          item.missingInPython.length ? `插件独有：${item.missingInPython.map((x) => x.text).join('；')}` : '',
          item.pythonOnly.length ? `Python 独有：${item.pythonOnly.map((x) => x.text).join('；')}` : '',
          item.pythonNote ? `注：${item.pythonNote}` : '',
          item.pluginError ? `插件错误：${item.pluginError}` : '',
        ].filter(Boolean).join(' ') || '—',
      ])))
  }
  lines.push('')

  lines.push('## 6. 边迁移')
  lines.push('')
  lines.push('口径：')
  lines.push('')
  lines.push('- 只迁 Python `memory_edges` 的 `(a,b,weight)`；`etype` 固定写 `similar`，`source` 固定写 `manual`；')
  lines.push('- `conf = clamp(weight, 0, 1)`，`weight = weight`；')
  lines.push('- 端点按 text_hash 映射到插件 `nodes.id`；两端必须落在插件同一 `role_id/user_id` 分区；')
  lines.push('- `UNIQUE(from_id,to_id,etype)` 幂等，重复执行只增 0；')
  lines.push('- **不迁 supersede/mutex**：Python 侧没有可依赖的类型语义，插件侧也不复制其历史类型；需要时人工登记。')
  lines.push('')
  lines.push(markdownTable(['项', '数量'], [
    ['Python 边总数', migration.total],
    ['本次可写（规划）', migration.planned],
    ['实际新增', migration.applied ? migration.added : '未执行'],
    ['已存在跳过', migration.applied ? migration.skippedExisting : migration.skippedExisting],
    ['supersede/mutex 跳过', migration.skippedByType],
    ['端点未映射跳过', migration.skippedUnmappedEndpoint],
    ['跨分区跳过', migration.skippedPartition],
    ['自环跳过', migration.skippedSelfLoop],
    ['权重非法（按 0）', migration.invalidWeight],
  ]))
  lines.push('')
  if (!migration.applied) {
    lines.push('> 本次未写边（dry-run 或未传 `--apply --apply-edges`）。')
    lines.push('')
  }
  for (const [label, samples] of Object.entries(migration.skippedSamples || {})) {
    if (!samples?.length) continue
    lines.push(`${label} 跳过样例：`)
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(samples, null, 2))
    lines.push('```')
    lines.push('')
  }

  lines.push('## 7. 备份与回滚')
  lines.push('')
  if (report.backup?.performed) {
    lines.push(`- 备份文件：\`${report.backup.path}\``)
    lines.push(`- 保留份数：${report.backup.kept ?? '—'}（最多 ${MAX_BACKUPS} 份）`)
    if (report.backup.deleted?.length) lines.push(`- 本次清理：${report.backup.deleted.join(', ')}`)
    lines.push('- 回滚：停止插件/宿主写入 → 用备份文件覆盖插件 `memory.db` → 删除同名 `-wal`/`-shm` → 手动重启 DSH。')
  } else {
    lines.push(`- 未备份：${report.backup?.reason || 'dry-run 不写库'}。`)
    lines.push('- 真正 apply 时默认会先 checkpoint 再 `VACUUM INTO`，备份最多保留 5 份。')
  }
  lines.push('')

  lines.push('## 8. 复跑')
  lines.push('')
  lines.push('```bash')
  lines.push(`node scripts/migrate-audit.mjs --python-db ${JSON.stringify(py.path)} --plugin-db ${JSON.stringify(pg.path)} --report -`)
  if (migration.applied) {
    lines.push(`node scripts/migrate-audit.mjs --python-db ${JSON.stringify(py.path)} --plugin-db ${JSON.stringify(pg.path)} --report -  # 应显示新增 0`)
  }
  lines.push('```')
  lines.push('')
  if (report.warnings?.length) {
    lines.push('## 9. 告警')
    lines.push('')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function reportPaths(reportPath, stamp) {
  if (!reportPath || reportPath === '-' || reportPath === 'stdout') return null
  let md
  let json
  if (String(reportPath).endsWith('.json')) {
    json = String(reportPath)
    md = json.replace(/\.json$/, '.md')
  } else {
    md = String(reportPath).endsWith('.md') ? String(reportPath) : `${reportPath}.md`
    json = md.replace(/\.md$/, '.json')
  }
  return { md, json }
}

function writeReports(paths, report, markdown) {
  if (!paths) return
  mkdirSync(dirname(paths.md), { recursive: true })
  mkdirSync(dirname(paths.json), { recursive: true })
  writeFileSync(paths.md, markdown, 'utf8')
  writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/**
 * 主流程：审计 → （可选）备份 → （可选）写边 → 报告。
 * @param {ReturnType<typeof parseArgs>} opts
 */
export async function runAudit(opts) {
  const stamp = compactStamp()
  const pythonPath = normalizeDbPath(opts.pythonDb, PYTHON_DB_FILE, 'Python 库')
  const pluginPath = normalizeDbPath(opts.pluginDb, PLUGIN_DB_FILE, '插件库')
  const apply = Boolean(opts.apply)
  const applyEdges = Boolean(opts.applyEdges)
  const warnings = []

  const pythonSide = openReadOnly(pythonPath, 'python')
  let pluginSide = apply ? openWritable(pluginPath, 'plugin') : openReadOnly(pluginPath, 'plugin')
  let backup = { performed: false, reason: apply ? '未执行' : 'dry-run 只读，不备份' }
  let edgeApplied = null

  try {
    if (apply) {
      if (!tableExists(pluginSide.db, 'nodes') || !tableExists(pluginSide.db, 'edges')) {
        throw new Error('插件库缺少 nodes/edges 表（不是 whale-memory 库？）')
      }
      if (opts.backup) {
        backup = backupPluginDb(pluginSide.db, opts.backupDir)
      } else {
        backup = { performed: false, reason: '--no-backup' }
      }
    }

    const audit = collectAudit(pythonSide.db, pluginSide.db, { pythonDb: pythonPath, pluginDb: pluginPath })
    const dualRead = dualReadReport(pluginSide.db, pythonSide.db, opts.queries, opts.topN)

    if (!audit.python.fts.aligned) warnings.push('Python FTS docsize 与 memory_nodes 行数不一致，先修 FTS 再迁边。')
    if (!audit.plugin.fts.aligned) warnings.push('插件 FTS docsize 与 nodes 行数不一致，先修 FTS 再迁边。')
    if (audit.mapping.directHashMatches === 0 && audit.mapping.computedHashMatches > 0) {
      warnings.push('两边 text_hash 算法不同（Python sha1(raw) vs 插件 sha256(normalize)），直接等值为 0，已按插件口径重算。')
    }
    if (audit.mapping.unmapped > 0) warnings.push(`${audit.mapping.unmapped} 个 Python 节点在插件库无对应 hash/id，边端点未映射会跳过。`)
    if (audit.python.edges.missingEndpoints > 0) warnings.push(`${audit.python.edges.missingEndpoints} 条 Python 边的端点不在 memory_nodes。`)

    if (apply && applyEdges) {
      edgeApplied = applyPlannedEdges(pluginSide.db, audit.edgePlan)
    }

    const migration = {
      requested: applyEdges,
      applied: Boolean(apply && applyEdges),
      policy: {
        etype: EDGE_ETYPE,
        source: EDGE_SOURCE,
        conf: 'clamp(weight,0,1)',
        weight: 'weight',
        skippedTypes: [...SKIP_EDGE_TYPES],
        partition: '两端插件节点必须与 Python 边同 role_id/user_id',
        idempotent: 'UNIQUE(from_id,to_id,etype) + ON CONFLICT DO NOTHING',
      },
      total: audit.edgePlan.stats.total,
      planned: audit.edgePlan.stats.planned,
      added: edgeApplied?.added ?? 0,
      skippedExisting: (edgeApplied?.skippedExisting ?? 0) + audit.edgePlan.stats.skippedExisting,
      skippedByType: audit.edgePlan.stats.skippedByType,
      skippedUnmappedEndpoint: audit.edgePlan.stats.skippedUnmappedEndpoint,
      skippedUnmappedA: audit.edgePlan.stats.skippedUnmappedA,
      skippedUnmappedB: audit.edgePlan.stats.skippedUnmappedB,
      skippedPartition: audit.edgePlan.stats.skippedPartition,
      skippedSelfLoop: audit.edgePlan.stats.skippedSelfLoop,
      invalidWeight: audit.edgePlan.stats.invalidWeight,
      skippedSamples: audit.edgePlan.skippedSamples,
    }
    if (!migration.applied && apply) {
      migration.added = 0
      migration.note = '已 apply 但未传 --apply-edges，未写边'
    }
    if (edgeApplied && edgeApplied.skippedExisting > 0) {
      migration.note = '有边在写入瞬间已存在（并发/重复），按幂等跳过'
    }

    const report = {
      version: 1,
      generatedAt: isoNow(),
      mode: apply ? 'apply' : 'dry-run',
      wroteDatabase: Boolean(apply && applyEdges && (edgeApplied?.added ?? 0) > 0),
      python: audit.python,
      plugin: audit.plugin,
      mapping: audit.mapping,
      edgeMigration: migration,
      dualRead,
      backup,
      warnings,
      options: {
        pythonDb: pythonPath,
        pluginDb: pluginPath,
        apply,
        applyEdges,
        backup: Boolean(opts.backup),
        backupDir: opts.backupDir,
        report: opts.report,
        queries: opts.queries,
        topN: opts.topN,
      },
    }
    const markdown = buildMarkdown(report)
    const paths = reportPaths(opts.report, stamp)
    writeReports(paths, report, markdown)
    return { report, markdown, paths }
  } finally {
    try { pythonSide.db.close() } catch { /* 收尾不抛 */ }
    try { pluginSide.db.close() } catch { /* 收尾不抛 */ }
  }
}

/** stdout 摘要：不刷屏；完整 JSON 在报告文件里（或 --json）。 */
function printSummary(result, opts) {
  const { report } = result
  const py = report.python
  const pg = report.plugin
  const migration = report.edgeMigration
  console.log(`[migrate-audit] ${report.mode === 'apply' ? 'apply' : 'dry-run（未写库）'}`)
  console.log(`[migrate-audit] Python ${py.path} schema=${py.schemaVersion ?? '—'} nodes=${py.nodes?.total ?? '—'} active=${py.nodes?.active ?? '—'} archived=${py.nodes?.archived ?? '—'} superseded=${py.nodes?.superseded ?? '—'}`)
  console.log(`[migrate-audit] 插件   ${pg.path} schema=${pg.schemaVersion ?? '—'} nodes=${pg.nodes?.total ?? '—'} active=${pg.nodes?.active ?? '—'} archived=${pg.nodes?.archived ?? '—'} superseded=${pg.nodes?.superseded ?? '—'}`)
  console.log(`[migrate-audit] FTS 对齐 python=${py.fts?.aligned ? 'OK' : 'BAD'} plugin=${pg.fts?.aligned ? 'OK' : 'BAD'}`)
  console.log(`[migrate-audit] 边 python=${py.edges?.total ?? '—'} plugin=${pg.edges?.total ?? '—'}；text_hash 映射 ${report.mapping.hashMapped}/${report.mapping.pythonNodes}（${report.mapping.hashSuccessRate}%）`)
  console.log(`[migrate-audit] 双读 overlap=${report.dualRead.summary?.overlapPercent ?? '—'}%（可比较用例平均 ${report.dualRead.summary?.meanComparableCoveragePercent ?? '—'}%）`)
  console.log(`[migrate-audit] 边迁移：可写 ${migration.planned}，本次新增 ${migration.applied ? migration.added : '未执行'}，跳过 supersede/mutex ${migration.skippedByType}、未映射 ${migration.skippedUnmappedEndpoint}、跨分区 ${migration.skippedPartition}、自环 ${migration.skippedSelfLoop}、已存在 ${migration.skippedExisting}`)
  if (report.backup?.performed) console.log(`[migrate-audit] 备份：${report.backup.path}（保留 ${report.backup.kept} 份）`)
  if (result.paths) console.log(`[migrate-audit] 报告：${result.paths.md} / ${result.paths.json}`)
  if (opts.json) console.log(JSON.stringify(report, null, 2))
  for (const warning of report.warnings || []) console.error(`[migrate-audit] 告警：${warning}`)
}

function helpText() {
  return `用法：node scripts/migrate-audit.mjs [选项]

默认是 dry-run（只读），打印摘要并写 Markdown+JSON 报告；--apply 才写插件库。

  --python-db <path>   Python 库（默认 ~/ai-router-microservice/data/whale.db；给目录则取 whale.db）
  --plugin-db <path>   插件库（默认 $DSH_HOME/whale-memory/memory.db；给目录则取 memory.db）
  --apply              允许写插件库（写前默认先备份）
  --apply-edges        与 --apply 同用，把 memory_edges 迁成插件 similar/manual 边
  --dry-run            显式只读（默认行为）
  --backup / --no-backup  apply 时是否先 checkpoint + VACUUM INTO（默认 --backup）
  --backup-dir <dir>   备份目录（默认 <plugin-db 所在目录>/backup，最多保留 ${MAX_BACKUPS} 份）
  --report <path>      报告路径（.md/.json 同基名；'-' 表示只打 stdout，不落文件）
  --queries <path>     双读查询集（默认 test/fixtures/eval.json）
  --topn <1..50>       插件 search 条数（默认 ${DEFAULT_TOPN}；Python 侧固定 LIMIT 50）
  --json               额外把完整 JSON 报告打到 stdout
  -h, --help           本帮助

边迁移限制：只写 etype=similar / source=manual；conf=clamp(weight,0,1)；端点必须按 text_hash
映射且落在插件同 role_id/user_id 分区；supersede/mutex 不迁（Python 无可靠类型语义）。
`
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`[migrate-audit] 参数错误：${err.message}`)
    return 1
  }
  if (opts.help) {
    process.stdout.write(helpText())
    return 0
  }
  try {
    const result = await runAudit(opts)
    printSummary(result, opts)
    return 0
  } catch (err) {
    console.error(`[migrate-audit] 失败：${err.message}`)
    return 1
  }
}

const isEntry = process.argv[1] && SCRIPT_PATH === fileURLToPath(pathToFileURL(resolve(process.argv[1])))
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => { console.error('[migrate-audit] 未捕获异常：', err); process.exitCode = 1 },
  )
}
