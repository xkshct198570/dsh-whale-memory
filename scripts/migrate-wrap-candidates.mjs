#!/usr/bin/env node
/**
 * Session Wrap 历史候选迁移（0.7.3 → 0.8）：把旧 CANDIDATE 按新 ingest 闸重放一次。
 *
 * 口径（架构书 §5.4/施工计划 S1 第 8 步）：
 * - 默认 dry-run：只读打开库，按价值闸分类打印预计结果，零副作用；
 * - `--apply` 前强制备份（wal_checkpoint → VACUUM INTO <dbDir>/backup/whale-<ts>.db）；
 * - 只选 `action='CANDIDATE' AND payload.origin='session-wrap'`，且跳过迁移自身产生的候选
 *   （`trace_id LIKE 'migrate:%'`）与 ARCHIVE 审核项（删改状态需人工）；
 * - 原行改 `action='MIGRATED'`、node_id=<新 id>、reason=`migrated:<action>:<id>`；
 * - 历史 `reason LIKE 'auto_ingested:%'` 的 REJECT 同轮归一 MIGRATED（保留正文作历史审计）；
 * - 跑两遍计数不变（幂等）：迁移产生的候选靠 trace_id 前缀排除。
 *
 * 依赖方向：scripts → core（writer/ingest-policy），不 import host。
 * 用法：node scripts/migrate-wrap-candidates.mjs [--apply] [--db <memory.db>]
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { processEvent } from '../src/core/writer.js'
import { classifyDurability, detectAmbiguity, DURABILITY } from '../src/shared/ingest-policy.js'

const DEFAULT_DB = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-memory', 'memory.db')
const INGEST = { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true, confidence: 1 }

/** @param {string[]} argv */
export function parseArgs(argv = []) {
  const opts = { db: DEFAULT_DB, apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '')
    if (arg === '-h' || arg === '--help') { opts.help = true; continue }
    if (arg === '--apply') { opts.apply = true; continue }
    if (arg === '--dry-run') { opts.apply = false; continue }
    if (arg === '--db') {
      const next = argv[i + 1]
      if (!next || String(next).startsWith('--')) throw new Error('--db 缺少路径')
      opts.db = resolve(String(next))
      i += 1
      continue
    }
    if (arg.startsWith('--db=')) { opts.db = resolve(arg.slice(5)); continue }
    throw new Error(`未知参数：${arg}（支持 --apply / --db <path> / --help）`)
  }
  return opts
}

const candidateRows = (db) => db.prepare(`SELECT id,trace_id,after_text,payload,user_id,role_id,workspace
  FROM writes
  WHERE action='CANDIDATE' AND json_extract(payload,'$.origin')='session-wrap'
    AND (trace_id IS NULL OR trace_id NOT LIKE 'migrate:%')
  ORDER BY id`).all()

/** 迁移前的可解释分类（dry-run 与 apply 共用同一判据）。 */
function planOf(row) {
  if (!row.user_id || !row.workspace) return { action: 'SKIP', reason: 'identity_missing' }
  let payload = {}
  try { payload = JSON.parse(String(row.payload || '{}')) || {} } catch { payload = {} }
  if (payload.shadowOf === 'ARCHIVE') return { action: 'SKIP', reason: 'archive_review' }
  const text = String(row.after_text || '')
  const kind = classifyDurability(text)
  if (kind === DURABILITY.STALE || kind === DURABILITY.TASK) return { action: 'REJECT', reason: `gate:${kind}` }
  if (kind === DURABILITY.UNCERTAIN) {
    const amb = detectAmbiguity(text)
    const reason = amb.reasons.includes('subjective')
      ? (amb.reasons.includes('deictic') ? 'gate:subjective:deictic' : 'gate:subjective')
      : amb.reasons.includes('deictic') ? 'gate:ambiguous' : 'gate:unclassified'
    return { action: 'CANDIDATE', reason }
  }
  // durable 仍可能因判重/保护面转审核；dry-run 只给“放行到判重”，不承诺一定落 active。
  return { action: 'INGEST', reason: 'durable→decide' }
}

function backup(db, dbPath) {
  const dir = join(dirname(dbPath), 'backup')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17)
  const target = join(dir, `whale-${stamp}.db`)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  return target
}

/**
 * 重放一条旧候选：真实走 processEvent（价值闸/判重/落库），再回写原行为 MIGRATED。
 * @returns {{action:string, reason:string, nodeId:string|null}}
 */
function replay(db, row) {
  const payload = (() => { try { return JSON.parse(String(row.payload || '{}')) || {} } catch { return {} } })()
  const res = processEvent(db, {
    traceId: `migrate:${row.id}`,
    identity: { userId: String(row.user_id || ''), roleId: String(row.role_id || ''), workspace: String(row.workspace || '') },
    text: String(row.after_text || ''),
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    origin: 'session-wrap',
    // 旧 wrap payload 一律 source='owner'（0.7.3 硬编码）；重放必须归一到 self，
    // 否则迁移落下的节点进入保护面，后续相似写入永远只能审核（架构书 B14）。
    source: 'self',
    level: payload.level || 'normal',
    memory_type: payload.memory_type || 'semantic',
    expired_at: payload.expired_at,
    __ingest: INGEST,
  // 一次性回填不受每日配额限制：否则超过 dailyCap 的候选会被静默跳过且原行已 MIGRATED。
  }, { write: { reviewMode: 'auto', dailyCap: 1_000_000 } })
  return { action: String(res.action || 'REJECT'), reason: String(res.reason || ''), nodeId: res.id ? String(res.id) : null }
}

/** @param {{db:string, apply:boolean}} opts */
export function run(opts) {
  if (!existsSync(opts.db)) throw new Error(`数据库不存在：${opts.db}`)
  const db = new DatabaseSync(opts.db, opts.apply ? { timeout: 5000 } : { readOnly: true })
  const out = { db: opts.db, apply: opts.apply, candidates: 0, planned: {}, migrated: 0, rejected: 0, review: 0, skipped: 0, normalized: 0, failed: 0, backup: '' }
  try {
    const rows = candidateRows(db)
    out.candidates = rows.length
    // 只有真要写入时才备份：no-op 的 --apply 不应每次多产一份 4.6M 快照。
    const staleRejects = Number(db.prepare("SELECT count(*) AS n FROM writes WHERE action='REJECT' AND reason LIKE 'auto_ingested:%'").get()?.n || 0)
    const actionable = rows.filter((row) => planOf(row).action !== 'SKIP').length
    if (opts.apply && (actionable > 0 || staleRejects > 0)) out.backup = backup(db, opts.db)
    // 可见性：库里还有别的来源候选（tool/reflect/无身份），本脚本不处理，必须报数而不是装作全清。
    out.otherCandidates = Number(db.prepare(`SELECT count(*) AS n FROM writes
      WHERE action='CANDIDATE' AND COALESCE(json_extract(payload,'$.origin'),'')<>'session-wrap'`).get()?.n || 0)
    for (const row of rows) {
      const plan = planOf(row)
      out.planned[plan.reason] = (out.planned[plan.reason] || 0) + 1
      if (plan.action === 'SKIP') { out.skipped += 1; continue }
      if (!opts.apply) continue
      try {
        const res = replay(db, row)
        if (res.action === 'REJECT' && res.reason === 'daily_cap') {
          // 配额闸拒绝不得吞原行：保留 CANDIDATE，下次 --apply 可重试，并显式计数。
          out.failed += 1
          console.error(`[migrate] row=${row.id} daily_cap（保留原行，可重试）`)
          continue
        }
        const reason = `migrated:${res.action}:${res.nodeId || '-'}`
        db.prepare("UPDATE writes SET action='MIGRATED', node_id=?, reason=? WHERE id=? AND action='CANDIDATE'")
          .run(res.nodeId, reason.slice(0, 200), row.id)
        out.migrated += 1
        if (res.action === 'REJECT') out.rejected += 1
        else if (res.action === 'CANDIDATE') out.review += 1
      } catch (err) {
        out.failed += 1
        console.error(`[migrate] row=${row.id} error=${String(err?.message || err).slice(0, 160)}`)
      }
    }
    if (opts.apply) {
      // 历史 auto_ingested:% REJECT：正文保留，但不再计 REJECT（S0 前手工处置留下的行）。
      const info = db.prepare(`UPDATE writes SET action='MIGRATED', reason=replace(reason,'auto_ingested:','migrated:')
        WHERE action='REJECT' AND reason LIKE 'auto_ingested:%'`).run()
      out.normalized = Number(info?.changes || 0)
    }
  } finally {
    db.close()
  }
  return out
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    console.error(`[migrate] ${err?.message || err}`)
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log('用法：node scripts/migrate-wrap-candidates.mjs [--apply] [--db <memory.db>]\n默认 dry-run；--apply 自动备份。')
    return
  }
  const out = run(opts)
  const lines = [
    `db: ${out.db}`,
    `mode: ${out.apply ? 'APPLY' : 'DRY-RUN'}${out.backup ? ` (backup: ${out.backup})` : ''}`,
    `候选: ${out.candidates} · 计划: ${JSON.stringify(out.planned)} · 未纳入(非 session-wrap): ${out.otherCandidates}`,
    out.apply
      ? `迁移: ${out.migrated}（REJECT ${out.rejected} / 仍待审 ${out.review}）· 跳过 ${out.skipped} · 失败 ${out.failed} · REJECT 归一 ${out.normalized}`
      : `dry-run：未写库（跳过 ${out.skipped} 条无身份/ARCHIVE）`,
  ]
  console.log(lines.join('\n'))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main()
