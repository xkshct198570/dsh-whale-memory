/**
 * Session Wrap 的报告/保留：报告渲染与读取、保留期清扫、可切会话结论。
 *
 * 拆分（P2c）：本文件只做“run→报告/可切结论”与台账/报告保留；蒸馏/分流/对账在各自模块。
 * 依赖方向：host → core/{wrap-report,memory-hygiene,wrap-runs} + 同目录 spool-run（I/O helper）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { renderWrapReport, wrapReportFileName } from '../../core/wrap-report.js'
import { auditMemory } from '../../core/memory-hygiene.js'
import { getRun } from '../../core/wrap-runs.js'
import { atomicWrite } from './spool-run.js'
import { dayStamp } from '../../shared/day-stamp.js'
import { KINDS_WRITTEN } from './dispatch.js'

/** 可切会话结论：报告落盘 + 没有**其他** wrap job 在排队/运行；清洁问题只作 warning。 */
export function computeSwitchReady({ reportPath, reportEnabled, currentJobId, withDb, hygiene }) {
  const blockers = []
  const warnings = []
  if (reportEnabled) {
    let exists = false
    try { exists = Boolean(reportPath) && statSync(reportPath).isFile() } catch { exists = false }
    if (!exists) blockers.push('report_missing')
  }
  try {
    const rows = withDb((db) => db.prepare(
      "SELECT id FROM jobs WHERE kind='wrap' AND state IN ('queued','running') AND id<>? LIMIT 5",
    ).all(Number(currentJobId) || -1))
    if (Array.isArray(rows) && rows.length > 0) blockers.push(`wrap_jobs_pending:${rows.length}`)
  } catch { blockers.push('wrap_jobs_unreadable') }
  for (const code of hygiene?.blockers || []) warnings.push(`hygiene:${code}`)
  for (const code of hygiene?.warnings || []) warnings.push(`hygiene:${code}`)
  return { ready: blockers.length === 0, blockers, warnings, at: Date.now() / 1000 }
}

/**
 * 决策摘要（S4）：按 op 计数 + 被合并条数 + 拒绝原因；不含任何正文。
 * @param {object} reconcile run.distilled_json.reconcile
 * @param {object} distilled
 * @returns {{total:number, counts:Record<string,number>, rejected:string[], merged:number}}
 */
export function summarizeDecisions(reconcile, distilled) {
  const counts = {}
  const decisions = Array.isArray(reconcile?.decisions) ? reconcile.decisions : []
  for (const decision of decisions) {
    const op = String(decision?.op || '')
    if (op) counts[op] = (counts[op] || 0) + 1
  }
  const merged = (Array.isArray(distilled?.items) ? distilled.items : [])
    .filter((item) => String(item?.status || '').startsWith('merged_into:')).length
  const rejected = (Array.isArray(reconcile?.rejected) ? reconcile.rejected : [])
    .map((row) => String(row?.error || 'unknown'))
    .filter(Boolean)
  const applied = Array.isArray(reconcile?.applied) ? reconcile.applied.length : 0
  return { total: decisions.length, applied, counts, rejected, merged }
}

/**
 * 报告阶段：清洁审计 → 渲染/落盘报告 → 计算可切会话结论。
 * @param {{
 *   runId:number, run:any, spool:any, distilled:any, items:any[], api:any, backend:any,
 *   baseDir:string, reportDir:string, wrapCfg:()=>any, withDb:Function, now:()=>number, log?:Function,
 * }} deps
 */
export function reportPhase({ runId, run, spool, distilled, items, api, backend, baseDir, reportDir, wrapCfg, withDb, now, log = () => {} }) {
  const candidates = items.filter((item) => KINDS_WRITTEN.has(item.kind))
  const ruleProposals = items.filter((item) => item.kind === 'rule')
  const openLoops = items.filter((item) => item.kind === 'open_loop')
  let hygiene = null
  try {
    hygiene = withDb((db) => auditMemory(db, {
      dbFile: String(backend.dbFile || ''), nowSec: now(), backupDir: join(baseDir, 'backup'),
    }))
  } catch (err) {
    hygiene = {
      ok: false, blockers: ['hygiene_unavailable'], warnings: [],
      checks: [], stats: {},
    }
    log(`[whale-memory] wrap hygiene unavailable: ${err?.message || err}`)
  }
  const reportPath = wrapCfg().report
    ? join(reportDir, wrapReportFileName({ day: dayStamp(now()), sessionId: String(spool.sessionId || ''), runId }))
    : ''
  let reportWritten = false
  if (reportPath) {
    try {
      mkdirSync(reportDir, { recursive: true, mode: 0o700 })
      // 报告自身尚未落盘：摘要里的“可切会话”不计 report_missing，
      // 否则每份报告都会写“否”，真实结论看 run.switch_ready_json / 面板。
      const switchPreview = computeSwitchReady({
        reportPath: '', reportEnabled: false, currentJobId: api?.jobId, withDb, hygiene,
      })
      const reconcile = distilled && distilled.reconcile ? distilled.reconcile : null
      const decisions = reconcile ? summarizeDecisions(reconcile, distilled) : null
      const markdown = renderWrapReport({
        decisions,
        run: {
          id: runId, trigger: String(spool.trigger || run.trigger || ''),
          day: dayStamp(now()), createdAt: run.created_at,
        },
        summary: distilled.summary || '',
        // 报告只认条目状态：ingested 只计数+node id；review 才打印正文；skipped 只打印分类码。
        items: candidates,
        ruleProposals,
        openLoops,
        hygiene,
        switchReady: switchPreview,
        // 报告层要人读时间，统一 ISO；run.created_at 仍是秒级数值（面板/排序用）。
        generatedAt: new Date(now() * 1000).toISOString(),
        dropped: distilled.dropped || [],
      })
      atomicWrite(reportPath, markdown, 0o600)
      reportWritten = true
    } catch (err) {
      log(`[whale-memory] wrap report write failed: ${err?.message || err}`)
    }
  }
  const switchReady = computeSwitchReady({
    reportPath: reportWritten ? reportPath : '', reportEnabled: Boolean(reportPath),
    currentJobId: api?.jobId, withDb, hygiene,
  })
  return { hygiene, reportPath, reportWritten, switchReady }
}

/** 报告读取：只认 run.report_path 且必须落在 reports 目录内（防路径穿越）。 */
export function reportRead({ runId, withDb, reportDir, identity = null }) {
  const run = withDb((db) => getRun(db, runId))
  if (!run || !run.report_path) return { ok: false, error: 'report_missing' }
  // 作用域闸（审计 P1-03）：显式身份必须与 run 三元组完全一致；不一致按“不存在”返回，
  // 不暴露“这条 run 属于别的分区”这一事实。identity=null 是本机面板默认视图。
  if (identity && typeof identity === 'object') {
    const same = String(run.user_id ?? '') === String(identity.userId ?? '')
      && String(run.role_id ?? '') === String(identity.roleId ?? '')
      && String(run.workspace ?? '') === String(identity.workspace ?? '')
    if (!same) return { ok: false, error: 'report_missing' }
  }
  const dir = resolve(reportDir)
  const abs = resolve(String(run.report_path))
  if (!existsSync(abs)) return { ok: false, error: 'report_missing' }
  const lexical = relative(dir, abs)
  if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) {
    return { ok: false, error: 'report_path_outside' }
  }
  try {
    const realDir = realpathSync(dir)
    const realFile = realpathSync(abs)
    const rel = relative(realDir, realFile)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: 'report_path_outside' }
    const stat = statSync(realFile)
    if (!stat.isFile() || stat.size > 512 * 1024) return { ok: false, error: 'report_unreadable' }
    return { ok: true, runId: run.id, path: realFile, text: readFileSync(realFile, 'utf8') }
  } catch { return { ok: false, error: 'report_unreadable' } }
}

/**
 * 台账/报告保留策略：删除超过 retentionDays 的终态 run，并清扫不再被任何 run 引用的旧报告。
 * 只动 done/failed/skipped 的 run；queued/running 可能在续跑，绝不删；0=永久。
 */
export function sweepStorage({ supported, wrapCfg, reportDir, withDb, now, log = () => {} }) {
  if (!supported) return { runs: 0, reports: 0 }
  const days = wrapCfg().retentionDays
  if (!(days > 0)) return { runs: 0, reports: 0 }
  const cutoff = now() - days * 86400
  let runs = 0
  let keptPaths = new Set()
  try {
    runs = withDb((db) => {
      const info = db.prepare(`DELETE FROM wrap_runs WHERE created_at < ?
        AND state IN ('done','failed','skipped')`).run(cutoff)
      const rows = db.prepare("SELECT report_path FROM wrap_runs WHERE report_path <> ''").all()
      keptPaths = new Set(rows.map((row) => String(row.report_path)))
      return Number(info?.changes || 0)
    })
  } catch (err) {
    log(`[whale-memory] wrap retention runs fail-open: ${err?.message || err}`)
    return { runs: 0, reports: 0 }
  }
  let reports = 0
  try {
    if (existsSync(reportDir)) {
      for (const name of readdirSync(reportDir)) {
        if (!/^session-wrap-.*\.md$/.test(name)) continue
        const abs = join(reportDir, name)
        if (keptPaths.has(abs)) continue
        try {
          if (statSync(abs).mtimeMs < cutoff * 1000) {
            rmSync(abs, { force: true })
            reports += 1
          }
        } catch { /* 单文件失败不影响其它 */ }
      }
    }
  } catch (err) {
    log(`[whale-memory] wrap retention reports fail-open: ${err?.message || err}`)
  }
  if (runs || reports) log(`[whale-memory] wrap retention deleted runs=${runs} reports=${reports} days=${days}`)
  return { runs, reports }
}
