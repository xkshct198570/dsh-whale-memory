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
import { existsSync } from 'node:fs'
import { bool, num, value } from '../shared/config-values.js'
import { createProposal } from '../core/rule-proposal.js'
import { getRun, latestRun, markRunAttempt, countRunsToday } from '../core/wrap-runs.js'
import { createWrapQueue } from '../core/wrap-queue.js'
import { setSkipAuto, skipAutoMap, skipAutoOf } from '../core/wrap-prefs.js'
import {
  createTriggerService, finishOrThrow, readJsonFile, reconcileRuns,
  spoolStats, spoolPathOf, sweepSpool as sweepSpoolFiles, resolveDataDir,
} from './session-wrap/spool-run.js'
import { distillPhase } from './session-wrap/distill.js'
import { dispatchPhase } from './session-wrap/dispatch.js'
import { INGEST_DEFAULTS, actionsOf, countsOf, runPatchOf } from './session-wrap/ingest.js'
import { buildWrapStatus } from './session-wrap/status.js'
import { applyReconcile, reconcilePhase } from './session-wrap/reconcile.js'
import { reportPhase, reportRead, sweepStorage as sweepStorageFiles } from './session-wrap/report.js'

export { resolveDataDir } from './session-wrap/spool-run.js'

/** spool 清扫间隔：30 分钟；定时器 unref，不拖住宿主退出。 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000
/** 队列守护间隔：2s 推进 + 排队超时/销毁清理（30 分钟阈值由 wrap-queue 内判）。 */
const QUEUE_TICK_MS = 2 * 1000

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
      // 普通记忆自动入库（S1）：mode auto|review；review＝0.7.3 回退（全部影子候选）。
      ingest: {
        mode: value(w.ingest?.mode) === 'review' ? 'review' : INGEST_DEFAULTS.mode,
        minConfidence: num(w.ingest?.minConfidence, INGEST_DEFAULTS.minConfidence),
        dropTaskInstructions: bool(w.ingest?.dropTaskInstructions, INGEST_DEFAULTS.dropTaskInstructions),
      },
      spoolTtlHours: num(w.spoolTtlHours, 24),
      retentionDays: num(w.retentionDays, 180),
      maxRunsPerDay: num(w.maxRunsPerDay, 6),
      maxQueued: num(w.maxQueued, 8),
      report: reportOverride === null ? bool(w.report, true) : Boolean(reportOverride),
      // 0.6.8：provider 曾漏投影，导致 wrap.provider 配了也被 selection 覆盖（真机 01:44 证据）。
      provider: String(value(w.provider, '') || ''),
      model: String(value(w.model, '') || ''),
      maxMaterialChars: num(w.maxMaterialChars, 12000),
      timeoutMs: num(w.timeoutMs, modelTimeoutMs),
      reconcile: {
        enabled: bool(w.reconcile?.enabled, false),
        topK: num(w.reconcile?.topK, 5),
        maxNeighborChars: num(w.reconcile?.maxNeighborChars, 200),
      },
    }
  }
  const baseDir = () => resolveDataDir(backend, config)
  const spoolDir = () => join(baseDir(), 'spool', 'session-wrap')
  const reportDir = () => join(baseDir(), 'reports')

  /** 共享可变状态：dispose 后触发短路；status 只读最近一次 skip/manual。 */
  const state = { disposed: false, lastSkip: null, lastManual: null }
  /** 点击即排队（S1b）：内存队列 + 单会话 1 / 全局上限；重启即清空（启动清扫标 queue_cleared）。 */
  const wrapQueue = createWrapQueue({ maxQueued: wrapCfg().maxQueued })
  const trigger = createTriggerService({
    withDb, keeper, captureRef, wrapCfg, spoolDir, now, log, supported, state, wrapQueue, pumpQueue,
  })
  /** 终态落库的统一入口：只在写库成功时删 spool，失败抛给 keeper 重试。 */
  const finalize = (runId, nextState, patch, opts) => finishOrThrow({ withDb, log }, runId, nextState, patch, opts)

  /**
   * 推进队列：队首且当前没有 wrap job 在跑时，踢一条 keeper job。
   * keeper 全局串行（同 kind 单飞），所以一次只推进一条；完成/失败后由 handler finally 再踢。
   * @returns {{started:number, skipped?:string}}
   */
  let queuePumping = false
  function pumpQueue() {
    if (!supported || state.disposed) return { started: 0, skipped: 'disposed' }
    if (queuePumping) return { started: 0, skipped: 'busy' }
    if (trigger.activeWrapJobs() > 0) return { started: 0, skipped: 'running' }
    queuePumping = true
    try {
      let started = 0
      while (!state.disposed) {
        const entry = wrapQueue.head()
        if (!entry) break
        let run = null
        try { run = withDb((db) => getRun(db, entry.runId)) } catch { run = null }
        if (!run || run.state !== 'queued') { wrapQueue.removeByRun(entry.runId); continue }
        const spoolPath = spoolPathOf(spoolDir(), run)
        if (!existsSync(spoolPath)) {
          try {
            withDb((db) => db.prepare("UPDATE wrap_runs SET state='failed', error='spool_missing', updated_at=? WHERE id=? AND state='queued'")
              .run(now(), run.id))
          } catch { /* 下一次 pump 再试 */ }
          wrapQueue.removeByRun(entry.runId)
          state.lastSkip = { at: now(), reason: 'spool_missing', runId: run.id }
          continue
        }
        try {
          trigger.enqueueJob(run, spoolPath)
          wrapQueue.removeByRun(entry.runId)
          started += 1
          log(`[whale-memory] wrap queue start run=${run.id} session=${entry.sessionId}`)
        } catch (err) {
          log(`[whale-memory] wrap queue start failed run=${run.id}: ${err?.message || err}`)
          try {
            withDb((db) => db.prepare("UPDATE wrap_runs SET state='failed', error='enqueue_failed', updated_at=? WHERE id=? AND state='queued'")
              .run(now(), run.id))
          } catch { /* 可见失败已进日志 */ }
          wrapQueue.removeByRun(entry.runId)
        }
        break // 一次只踢一条，其余等 handler 完成
      }
      return { started }
    } finally {
      queuePumping = false
    }
  }

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
    let distilled = distilledOut.distilled

    // 2) 整合（S3，默认关）：先与既有记忆对齐出决策，再影子落地；关闭时完全走旧路。
    let items = distilled.items
    let failures = []
    let reconcileInfo = null
    if (cfg.reconcile.enabled) {
      const checkpoint = distilled.reconcile && Array.isArray(distilled.reconcile.decisions)
        ? distilled.reconcile : null
      let decisions = checkpoint ? checkpoint.decisions : null
      if (!decisions) {
        const rec = await reconcilePhase({
          runId, distilled, spool,
          cfg: {
            ...cfg.reconcile, provider: cfg.provider, model: cfg.model, timeoutMs: cfg.timeoutMs,
          },
          withDb, getLlm, getSelection, log,
        })
        if (!rec.ok) {
          const error = `reconcile_${String(rec.reason || 'failed')}`.slice(0, 200)
          finalize(runId, 'failed', { error })
          throw new Error(error)
        }
        decisions = Array.isArray(rec.decisions) ? rec.decisions : []
        reconcileInfo = { decisions, rejected: rec.rejected || [], neighbors: rec.neighbors || 0 }
      } else {
        reconcileInfo = { decisions, rejected: checkpoint.rejected || [], neighbors: checkpoint.neighbors || 0 }
      }
      // 先写断点（含 reconcile 决策），apply 内部按条落库时不会把断点覆盖掉。
      distilled = { ...distilled, items, reconcile: reconcileInfo }
      if (decisions.length > 0) {
        const applied = await applyReconcile({
          items, distilled, spool, runId, decisions,
          rejected: reconcileInfo.rejected, config, backend,
          ingest: cfg.ingest, withDb, log,
        })
        items = applied.items
        failures.push(...applied.failures)
        distilled = { ...distilled, items, reconcile: { ...reconcileInfo, applied: applied.applied } }
      }
    }
    // 3) 分流：规则提案 / 待办 / 未整合条目（applyReconcile 只处理写记忆的 kind）
    const dispatched = await dispatchPhase({
      items, distilled, spool, runId, config, backend,
      ingest: cfg.ingest, withDb, createProposal, log,
    })
    items = dispatched.items
    failures.push(...dispatched.failures)

    // 3) 报告（不含原始对话）+ 可切会话结论
    const reportOut = reportPhase({
      runId, run, spool, distilled, items, api, backend,
      baseDir: baseDir(), reportDir: reportDir(), wrapCfg, withDb, now, log,
    })
    const counts = countsOf(items)
    const common = {
      phase: 'reported', summary: distilled.summary || '', ...runPatchOf(distilled, items),
      report_path: reportOut.reportWritten ? reportOut.reportPath : '',
      hygiene_json: reportOut.hygiene, switch_ready_json: reportOut.switchReady,
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
    const acts = actionsOf(items)
    log(`[whale-memory] wrap run=${runId} ingest added=${acts.added} merged=${acts.merged} superseded=${acts.superseded} noop=${acts.noop} review=${counts.reviewed} rejected=${acts.rejected} skipped=${counts.skipped} proposals=${counts.rule_proposals} open=${counts.open_loops} switchReady=${reportOut.switchReady.ready}`)
    return {
      runId, candidates: counts.candidates, ingested: counts.ingested, skipped: counts.skipped,
      ruleProposals: counts.rule_proposals, openLoops: counts.open_loops,
      report: reportOut.reportWritten ? reportOut.reportPath : '',
      switchReady: reportOut.switchReady,
    }
  }

  // keeper handler 注册：失败只记日志（wrap 不可用不能拖垮插件其它能力）。
  if (supported && keeper && typeof keeper.register === 'function') {
    try {
      keeper.register('wrap', async (payload, api) => {
        const runId = Number(payload?.runId)
        try {
          return await execute(payload, api)
        } finally {
          // 无论终态如何都出队并推进下一条（失败已由 execute/finalize 落失败态）。
          if (Number.isInteger(runId)) wrapQueue.removeByRun(runId)
          // 延到下一轮事件循环：keeper 在 handler resolve 后才把 job 置 done，
          // 立即 pump 会看到自己仍 running 而被跳过。
          setImmediate(() => {
            try { pumpQueue() } catch (err) { log(`[whale-memory] wrap pump after run fail-open: ${err?.message || err}`) }
          })
        }
      })
    } catch (err) {
      log(`[whale-memory] wrap handler not registered: ${err?.message || err}`)
    }
  }

  /**
   * 手动触发：显式 sessionId 只收尾那一段；缺省沿用“最近有材料的会话”。
   * 指定会话时不再用全局 busy 拦：忙闲由该会话/材料的幂等状态回答（S1b 会改成 202 排队）。
   */
  async function manual({ sessionId = '' } = {}) {
    if (!supported) return { ok: false, reason: 'unsupported_backend' }
    const capture = captureRef?.current
    if (!capture || typeof capture.triggerRecent !== 'function') return { ok: false, reason: 'capture_unavailable' }
    if (!wrapCfg().enabled) return { ok: false, reason: 'wrap_disabled' }
    const sid = String(sessionId || '').trim()
    if (!sid) {
      const out = await capture.triggerRecent('manual')
      if (out?.ok) state.lastManual = { at: now(), trigger: 'manual', runId: out.runId }
      return out
    }
    if (sid.length > 200) return { ok: false, reason: 'invalid_session' }
    const out = await capture.flush(sid, 'manual', { force: true })
    if (out?.ok) state.lastManual = { at: now(), trigger: 'manual', runId: out.runId, sessionId: sid }
    return out
  }

  /**
   * 面板会话列表：采集器的实时缓冲 × wrap_runs 的最近一次结果。
   * 只回 id/活动时间/轮数/进行中/最近 run 状态；不含正文、标题、cwd（跨 host 字段白名单）。
   */
  function sessions({ identity = null } = {}) {
    const capture = captureRef?.current
    const items = capture && typeof capture.listSessions === 'function' ? capture.listSessions() : []
    const latestBySession = new Map()
    let skipMap = new Map()
    if (supported) {
      try { skipMap = withDb((db) => skipAutoMap(db)) } catch { skipMap = new Map() }
    }
    if (supported && items.length > 0) {
      try {
        const scoped = identity && typeof identity === 'object'
          ? { sql: ' WHERE user_id=? AND role_id=? AND workspace=?', params: [
            String(identity.userId || ''), String(identity.roleId || ''), String(identity.workspace || ''),
          ] }
          : { sql: '', params: [] }
        const rows = withDb((db) => db.prepare(
          `SELECT session_id,id,state,updated_at FROM wrap_runs${scoped.sql} ORDER BY id ASC`,
        ).all(...scoped.params))
        for (const row of rows) latestBySession.set(String(row.session_id), row)
      } catch { /* 读库失败：列表仍可用（最近 run 字段留空），不静默丢会话 */ }
    }
    return {
      ok: true,
      items: items.map((item) => {
        const row = latestBySession.get(item.sessionId)
        return {
          ...item,
          skipAuto: skipMap.get(item.sessionId) === true,
          lastRunId: row ? Number(row.id) : null,
          lastRunState: row ? String(row.state) : '',
        }
      }),
      auto: { enabled: bool(config?.wrap?.idle, false), idleMinutes: num(config?.wrap?.idleMinutes, 10) },
    }
  }

  /** 状态视图：只暴露计数/状态/可切会话/队列位次，不返回候选正文。 */
  function status({ identity = null, focusRunId = null } = {}) {
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
    let job = null
    if (latest && latest.job_id) {
      try { job = withDb((db) => db.prepare('SELECT id,state,attempts FROM jobs WHERE id=?').get(Number(latest.job_id))) } catch { job = null }
    }
    return buildWrapStatus({
      supported: true,
      enabled: wrapCfg().enabled,
      maxRunsPerDay: wrapCfg().maxRunsPerDay,
      jobs: trigger.activeWrapJobs(),
      auto: { enabled: wrapCfg().idle, idleMinutes: wrapCfg().idleMinutes },
      reconcileEnabled: wrapCfg().reconcile.enabled,
      job,
      latest,
      rows,
      spool: spoolStats(spoolDir()),
      capture: captureRef?.current?.status ? captureRef.current.status() : null,
      queue: wrapQueue,
      runsToday: today,
      lastSkip: state.lastSkip,
      lastManual: state.lastManual,
      focusRunId,
    })
  }

  /**
   * 设置“该会话跳过自动收尾”（S2）：落 wrap_session_prefs；缺表/坏库明确错误。
   * 只影响空闲/会话关闭自动触发，手动不受影响。
   */
  function setSessionPrefs({ sessionId = '', skipAuto = undefined } = {}) {
    if (!supported) return { ok: false, error: 'unsupported_backend' }
    const sid = String(sessionId || '').trim()
    if (!sid || sid.length > 200) return { ok: false, error: 'invalid_session' }
    if (typeof skipAuto !== 'boolean') return { ok: false, error: 'invalid_value' }
    let got = null
    try { got = withDb((db) => setSkipAuto(db, sid, skipAuto, now())) } catch (err) {
      return { ok: false, error: `db_error:${String(err?.message || err).slice(0, 120)}` }
    }
    if (!got || got.ok !== true) return { ok: false, error: got?.error || 'db_error' }
    log(`[whale-memory] wrap session skipAuto=${skipAuto ? 1 : 0} session=${sid}`)
    return { ok: true, sessionId: sid, skipAuto: Boolean(skipAuto) }
  }

  /** 报告读取：路径穿越防护在 reportRead 内。 */
  function report(runId, { identity = null } = {}) {
    if (!supported) return { ok: false, error: 'unsupported_backend' }
    return reportRead({ runId, withDb, reportDir: reportDir(), identity })
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
    if (!supported) return { checked: 0, requeued: 0, failed: 0, abandoned: 0 }
    // 进程重启后内存队列必为空：先清一次（防本进程内重复 reconcile 残留），
    // queued 且无活 job 的 run 由 reconcileRuns 标 failed/queue_cleared（不静默续跑）。
    const hadQueued = wrapQueue.size()
    wrapQueue.clear()
    const out = reconcileRuns({
      withDb, log, jobLive: trigger.jobLive, enqueueJob: trigger.enqueueJob, spoolDir: spoolDir(),
    })
    if (out.abandoned > 0) {
      state.lastSkip = { at: now(), reason: 'queue_cleared', count: out.abandoned }
      log(`[whale-memory] wrap queue cleared abandoned=${out.abandoned}${hadQueued ? ` memory=${hadQueued}` : ''}`)
    }
    try { pumpQueue() } catch (err) { log(`[whale-memory] wrap pump after reconcile fail-open: ${err?.message || err}`) }
    return out
  }

  // 启动对账延后执行：不阻塞插件 init，也给 keeper 的启动补偿让路。
  let bootTimer = null
  let timer = null
  let queueTimer = null
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
    // 队列守护（铁律 3）：sweep 超时/已销毁会话，pump 保证“handler 完成后/进程空闲”仍会推进。
    queueTimer = setInterval(() => {
      try {
        const removed = wrapQueue.sweep({
          now: Date.now(),
          disposed: (sid) => {
            const capture = captureRef?.current
            const list = capture && typeof capture.listSessions === 'function' ? capture.listSessions() : null
            return Array.isArray(list) ? !list.some((item) => item.sessionId === sid) : false
          },
        })
        for (const item of removed) {
          try {
            withDb((db) => db.prepare("UPDATE wrap_runs SET state='failed', error=?, updated_at=? WHERE id=? AND state='queued'")
              .run(item.reason, now(), item.runId))
          } catch { /* 下一轮 sweep 再试 */ }
          state.lastSkip = { at: now(), reason: item.reason, runId: item.runId }
          log(`[whale-memory] wrap queue drop run=${item.runId} reason=${item.reason}`)
        }
      } catch (err) { log(`[whale-memory] wrap queue sweep fail-open: ${err?.message || err}`) }
      try { pumpQueue() } catch (err) { log(`[whale-memory] wrap queue pump fail-open: ${err?.message || err}`) }
    }, QUEUE_TICK_MS)
    if (typeof queueTimer.unref === 'function') queueTimer.unref()
  }

  const dispose = () => {
    state.disposed = true
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null }
    if (timer) { clearInterval(timer); timer = null }
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null }
    wrapQueue.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose(), 'whale-memory: session wrap')

  /** 采集器空闲 tick 的闸：把「今天额度/已有 job」判断前移，避免每 60s 反复打库。 */
  const canAutoTrigger = () => {
    if (!wrapCfg().idle) return { ok: false, reason: 'idle_disabled' }
    return trigger.autoGate()
  }

  return {
    onTrigger: trigger.onTrigger, manual, status, sessions, setSessionPrefs, report, sweepSpool, sweepStorage, reconcile, execute, pumpQueue,
    canAutoTrigger, supported, dispose,
  }
}
