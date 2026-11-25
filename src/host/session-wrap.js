/**
 * Session Wrap 门面与编排（Host 侧唯一执行体）。
 *
 * 一次收尾 = 采集快照（session-capture 交进来）→ 幂等 run → 单次蒸馏 → 证据校验 →
 * 分流写候选/规则提案 → 报告 → 清洁审计 → 可切会话结论。外部只有一个动作（显式/空闲/dispose/面板）。
 *
 * 拆分（P2c）：spool/run 生命周期在 ./session-wrap/spool-run.js；蒸馏在 ./session-wrap/distill.js；
 * 分流在 ./session-wrap/dispatch.js；报告/保留在 ./session-wrap/report.js；对账在 ./session-wrap/spool-run.js；
 * 本文件只做装配、状态视图与定时器。
 *
 * 分层硬约束：
 * - 纯函数在 core（distill/validate/report/hygiene），本文件只做编排与 I/O；
 * - 模型调用绝不进 hook 同步路径：由 keeper 的 `wrap` job 串行执行（全局并发 1）；
 * - 原始对话只进 spool（0600、TTL、不进灾备），报告/日志只写摘要、数量、runId；
 * - 候选写入默认 shadow（单条强制 shadow，不依赖全局 write.reviewMode）；规则只创建提案。
 * - 崩溃续跑：run 行是业务真源，distilled_json 保存每条的 status；spool 终态后删除，
 *   failed/no_model 保留到 TTL 供手动重试。
 */
import { join } from 'node:path'
import { bool, num, value } from '../shared/config-values.js'
import { createProposal } from '../core/rule-proposal.js'
import { getRun, latestRun, markRunAttempt, countRunsToday } from '../core/wrap-runs.js'
import {
  createTriggerService, finishOrThrow, readJsonFile, reconcileRuns,
  spoolStats, sweepSpool as sweepSpoolFiles, resolveDataDir,
} from './session-wrap/spool-run.js'
import { distillPhase } from './session-wrap/distill.js'
import { countsOf, dispatchPhase } from './session-wrap/dispatch.js'
import { reportPhase, reportRead, sweepStorage as sweepStorageFiles } from './session-wrap/report.js'

export { resolveDataDir } from './session-wrap/spool-run.js'

/** spool 清扫间隔：30 分钟；定时器 unref，不拖住宿主退出。 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000

/**
 * 安装 Session Wrap 服务。
 *
 * @param {{ effect?:Function, on?:Function }} ctx
 * @param {{
 *   backend:any, config:any, keeper:any, log?:(line:string)=>void,
 *   getLlm?:()=>any, getSelection?:()=>any, captureRef?:{current:any},
 *   now?:()=>number, modelTimeoutMs?:number, report?:boolean,
 * }} deps
 * @returns {{ onTrigger:Function, manual:Function, status:Function, report:Function,
 *   sweepSpool:Function, sweepStorage:Function, reconcile:Function, execute:Function,
 *   canAutoTrigger:Function, supported:boolean, dispose:Function }}
 */
export function installSessionWrap(ctx, {
  backend, config, keeper, log = () => {}, getLlm = () => null, getSelection = () => null,
  captureRef = { current: null }, now = () => Date.now() / 1000,
  modelTimeoutMs = 60_000, report: reportOverride = null, reconcileDelayMs = 1500,
} = {}) {
  const supported = Boolean(backend && typeof backend.withDb === 'function')
  const withDb = (fn) => backend.withDb(fn)
  const wrapCfg = () => {
    const w = config?.wrap || {}
    return {
      enabled: bool(w.enabled, true),
      explicit: bool(w.explicit, true),
      idle: bool(w.idle, true),
      disposed: bool(w.disposed, true),
      idleMinutes: num(w.idleMinutes, 10),
      maxItems: num(w.maxItems, 8),
      autoAccept: bool(w.autoAccept, false),
      spoolTtlHours: num(w.spoolTtlHours, 24),
      retentionDays: num(w.retentionDays, 180),
      maxRunsPerDay: num(w.maxRunsPerDay, 6),
      report: reportOverride === null ? bool(w.report, true) : Boolean(reportOverride),
      // 0.6.8：provider 曾漏投影，导致 wrap.provider 配了也被 selection 覆盖（真机 01:44 证据）。
      provider: String(value(w.provider, '') || ''),
      model: String(value(w.model, '') || ''),
      maxMaterialChars: num(w.maxMaterialChars, 12000),
      timeoutMs: num(w.timeoutMs, modelTimeoutMs),
    }
  }
  const baseDir = () => resolveDataDir(backend, config)
  const spoolDir = () => join(baseDir(), 'spool', 'session-wrap')
  const reportDir = () => join(baseDir(), 'reports')

  /** 共享可变状态：dispose 后触发短路；status 只读最近一次 skip/manual。 */
  const state = { disposed: false, lastSkip: null, lastManual: null }
  const trigger = createTriggerService({
    withDb, keeper, captureRef, wrapCfg, spoolDir, now, log, supported, state,
  })
  /** 终态落库的统一入口：只在写库成功时删 spool，失败抛给 keeper 重试。 */
  const finalize = (runId, nextState, patch, opts) => finishOrThrow({ withDb, log }, runId, nextState, patch, opts)

  /**
   * keeper `wrap` handler：真正的执行入口。
   * 返回值只用于 job 结果观测；失败一律 throw 让 keeper 走退避重试。
   */
  async function execute(payload = {}, api = {}) {
    const runId = Number(payload.runId)
    const spoolPath = String(payload.spoolPath || '')
    if (!Number.isInteger(runId) || runId <= 0) throw new Error('invalid_run_id')
    let run
    try { run = withDb((db) => getRun(db, runId)) } catch (err) {
      throw new Error(`run_read_failed:${String(err?.message || err).slice(0, 120)}`)
    }
    if (!run) return { skipped: 'run_missing' }
    if (run.state === 'done') return { skipped: 'already_done' }
    // 终态 skipped 的重复 job（人工重置会先把 state 改回 queued）不得再烧一次模型。
    if (run.state === 'skipped') return { skipped: 'already_skipped' }
    const cfg = wrapCfg()
    if (!cfg.enabled) {
      finalize(runId, 'skipped', { error: 'wrap_disabled' }, { deleteSpool: true, spoolPath })
      return { skipped: 'wrap_disabled' }
    }
    const spool = readJsonFile(spoolPath)
    if (!spool || typeof spool.material !== 'object' || !Array.isArray(spool.material?.turns)) {
      finalize(runId, 'failed', { error: 'spool_missing' })
      throw new Error('spool_missing')
    }
    run = withDb((db) => markRunAttempt(db, runId, now())) || run

    // 1) 蒸馏（断点续跑在 distillPhase 内）
    const distilledOut = await distillPhase({
      runId, run, spool, spoolPath, cfg, withDb, getLlm, getSelection, finalize, log,
    })
    if (distilledOut.skipped) {
      return distilledOut.dropped === undefined
        ? { skipped: distilledOut.skipped }
        : { skipped: distilledOut.skipped, dropped: distilledOut.dropped }
    }
    const distilled = distilledOut.distilled

    // 2) 分流：记忆候选 / 规则提案 / 待办不落长期记忆
    const { items, failures } = await dispatchPhase({
      items: distilled.items, distilled, spool, runId, config, backend,
      autoAccept: cfg.autoAccept, withDb, createProposal, log,
    })

    // 3) 报告（不含原始对话）+ 可切会话结论
    const reportOut = reportPhase({
      runId, run, spool, distilled, items, api, backend,
      baseDir: baseDir(), reportDir: reportDir(), wrapCfg, withDb, now, log,
    })
    const counts = countsOf(items)
    const common = {
      phase: 'reported', summary: distilled.summary || '', distilled_json: { ...distilled, items },
      report_path: reportOut.reportWritten ? reportOut.reportPath : '',
      hygiene_json: reportOut.hygiene, switch_ready_json: reportOut.switchReady, ...counts,
    }
    if (failures.length > 0) {
      const error = `candidate_write_failed:${failures.length}`
      finalize(runId, 'failed', { ...common, error })
      log(`[whale-memory] wrap run=${runId} failed ${error}`)
      throw new Error(error)
    }

    // 4) 成功后：落终态、删 spool、推进采集缓冲、入队一次巩固（不抢并发）。
    finalize(runId, 'done', { ...common, error: '', phase: 'done' }, { deleteSpool: true, spoolPath })
    try {
      const capture = captureRef?.current
      if (capture && typeof capture.advance === 'function') {
        capture.advance(String(spool.sessionId || ''), Number(spool.material?.seqTo) || 0)
      }
    } catch (err) {
      log(`[whale-memory] wrap advance capture fail-open: ${err?.message || err}`)
    }
    try {
      if (bool(config?.consolidate?.enabled, true)
        && !withDb((db) => db.prepare("SELECT 1 FROM jobs WHERE kind='consolidate' AND state IN ('queued','running') LIMIT 1").get())) {
        keeper.enqueue('consolidate', {})
      }
    } catch (err) {
      log(`[whale-memory] wrap consolidate enqueue fail-open: ${err?.message || err}`)
    }
    log(`[whale-memory] wrap done run=${runId} candidates=${counts.candidates} proposals=${counts.rule_proposals} open=${counts.open_loops} switchReady=${reportOut.switchReady.ready}`)
    return {
      runId, candidates: counts.candidates, ruleProposals: counts.rule_proposals,
      openLoops: counts.open_loops, report: reportOut.reportWritten ? reportOut.reportPath : '',
      switchReady: reportOut.switchReady,
    }
  }

  // keeper handler 注册：失败只记日志（wrap 不可用不能拖垮插件其它能力）。
  if (supported && keeper && typeof keeper.register === 'function') {
    try { keeper.register('wrap', execute) } catch (err) {
      log(`[whale-memory] wrap handler not registered: ${err?.message || err}`)
    }
  }

  /** 手动触发：走采集器最近有材料的会话；没有 live 会话材料时明确 409 原因。 */
  async function manual() {
    if (!supported) return { ok: false, reason: 'unsupported_backend' }
    const capture = captureRef?.current
    if (!capture || typeof capture.triggerRecent !== 'function') return { ok: false, reason: 'capture_unavailable' }
    if (!wrapCfg().enabled) return { ok: false, reason: 'wrap_disabled' }
    if (trigger.activeWrapJobs() > 0) return { ok: false, reason: 'busy_wrap' }
    const out = await capture.triggerRecent('manual')
    if (out?.ok) state.lastManual = { at: now(), trigger: 'manual', runId: out.runId }
    return out
  }

  /** 状态视图：只暴露计数/状态/可切会话，不返回候选正文。 */
  function status({ identity = null } = {}) {
    if (!supported) return { ok: true, supported: false, enabled: false, latest: null, reason: 'unsupported_backend' }
    let latest = null
    let today = 0
    let rows = []
    try {
      latest = withDb((db) => latestRun(db, { identity }))
      today = withDb((db) => countRunsToday(db, now(), { triggers: ['idle', 'disposed'] }))
      const scoped = identity && typeof identity === 'object'
        ? { sql: ' WHERE user_id=? AND role_id=? AND workspace=?', params: [
          String(identity.userId || ''), String(identity.roleId || ''), String(identity.workspace || ''),
        ] }
        : { sql: '', params: [] }
      rows = withDb((db) => db.prepare(`SELECT id,state,trigger,created_at,updated_at,error,candidates,rule_proposals,open_loops
        FROM wrap_runs${scoped.sql} ORDER BY id DESC LIMIT 5`).all(...scoped.params)).map((row) => ({
        id: Number(row.id), state: row.state, trigger: row.trigger,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        error: row.error || '', candidates: Number(row.candidates || 0),
        ruleProposals: Number(row.rule_proposals || 0), openLoops: Number(row.open_loops || 0),
      }))
    } catch (err) {
      return { ok: false, error: 'db_error', detail: String(err?.message || err).slice(0, 160) }
    }
    return {
      ok: true,
      supported: true,
      enabled: wrapCfg().enabled,
      runsToday: today,
      maxRunsPerDay: wrapCfg().maxRunsPerDay,
      jobs: trigger.activeWrapJobs(),
      latest: latest ? {
        id: latest.id, state: latest.state, trigger: latest.trigger,
        phase: latest.phase, attempts: latest.attempts,
        createdAt: latest.created_at, updatedAt: latest.updated_at,
        candidates: latest.candidates, ruleProposals: latest.rule_proposals, openLoops: latest.open_loops,
        switchReady: latest.switchReady, error: latest.error || '',
        reportAvailable: Boolean(latest.report_path),
      } : null,
      recent: rows,
      spool: spoolStats(spoolDir()),
      capture: captureRef?.current?.status ? captureRef.current.status() : null,
      lastSkip: state.lastSkip,
      lastManual: state.lastManual,
    }
  }

  /** 报告读取：路径穿越防护在 reportRead 内。 */
  function report(runId) {
    if (!supported) return { ok: false, error: 'unsupported_backend' }
    return reportRead({ runId, withDb, reportDir: reportDir() })
  }

  function sweepSpool({ ttlHours = null } = {}) {
    return sweepSpoolFiles({
      spoolDir: spoolDir(), ttlHours, fallbackTtlHours: wrapCfg().spoolTtlHours, log,
    })
  }

  function sweepStorage() {
    return sweepStorageFiles({ supported, wrapCfg, reportDir: reportDir(), withDb, now, log })
  }

  function reconcile() {
    if (!supported) return { checked: 0, requeued: 0, failed: 0 }
    return reconcileRuns({
      withDb, log, jobLive: trigger.jobLive, enqueueJob: trigger.enqueueJob, spoolDir: spoolDir(),
    })
  }

  // 启动对账延后执行：不阻塞插件 init，也给 keeper 的启动补偿让路。
  let bootTimer = null
  let timer = null
  if (supported) {
    bootTimer = setTimeout(() => {
      try { reconcile() } catch (err) { log(`[whale-memory] wrap reconcile fail-open: ${err?.message || err}`) }
      try { sweepSpool() } catch (err) { log(`[whale-memory] wrap spool sweep fail-open: ${err?.message || err}`) }
      try { sweepStorage() } catch (err) { log(`[whale-memory] wrap retention fail-open: ${err?.message || err}`) }
    }, Math.max(0, Number(reconcileDelayMs) || 1500))
    if (typeof bootTimer.unref === 'function') bootTimer.unref()
    timer = setInterval(() => {
      try { sweepSpool() } catch (err) { log(`[whale-memory] wrap spool sweep fail-open: ${err?.message || err}`) }
      try { sweepStorage() } catch (err) { log(`[whale-memory] wrap retention fail-open: ${err?.message || err}`) }
    }, SWEEP_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const dispose = () => {
    state.disposed = true
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null }
    if (timer) { clearInterval(timer); timer = null }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose(), 'whale-memory: session wrap')

  /** 采集器空闲 tick 的闸：把「今天额度/已有 job」判断前移，避免每 60s 反复打库。 */
  const canAutoTrigger = () => {
    if (!wrapCfg().idle) return { ok: false, reason: 'idle_disabled' }
    return trigger.autoGate()
  }

  return {
    onTrigger: trigger.onTrigger, manual, status, report, sweepSpool, sweepStorage, reconcile, execute,
    canAutoTrigger, supported, dispose,
  }
}
