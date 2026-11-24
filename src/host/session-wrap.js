/**
 * Session Wrap 编排（Host 侧唯一执行体）。
 *
 * 一次收尾 = 采集快照（由 session-capture 交进来）→ 幂等 run → 单次蒸馏 → 证据校验 →
 * 分流写候选/规则提案 → 报告 → 清洁审计 → 可切会话结论。外部只有一个动作（显式/空闲/dispose/面板）。
 *
 * 分层硬约束：
 * - 纯函数在 core（distill/validate/report/hygiene），本文件只做编排与 I/O；
 * - 模型调用绝不进 hook 同步路径：由 keeper 的 `wrap` job 串行执行（全局并发 1）；
 * - 原始对话只进 spool（0600、TTL、不进灾备），报告/日志只写摘要、数量、runId；
 * - 候选写入默认 shadow（单条强制 shadow，不依赖全局 write.reviewMode）；规则只创建提案。
 *
 * 崩溃续跑（铁律 3）：
 * - run 行是业务真源，jobs 只是调度；distilled_json 保存每条的 status，重试从断点继续，
 *   不重复调用模型、不重复写已经成功的条目；
 * - spool 在终态（done/no_items/disabled）后删除；failed/no_model 保留到 TTL 供手动重试。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { bool, num, value } from './config-values.js'
import { buildDistillPrompt, clampSummary, parseDistillOutput, validateDistillItems } from '../core/distill.js'
import { renderWrapReport, wrapReportFileName } from '../core/wrap-report.js'
import { auditMemory } from '../core/memory-hygiene.js'
import { createProposal } from '../core/rule-proposal.js'
import {
  countRunsToday, createRun, findRun, getRun, latestRun, markRunAttempt, updateRun,
} from '../core/wrap-runs.js'

/** 自动触发（idle/disposed）的终态原因：这些原因允许用户手动重试时重置同一 run。 */
const TRANSIENT_MARK = 'transient'
/** spool 清扫间隔：30 分钟；定时器 unref，不拖住宿主退出。 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000
/** 模型输出上限（字符）：超过只截断解析，不把异常大文本写进库。 */
const MODEL_OUTPUT_MAX = 100_000
/** 单条记忆写入的来源标记：候选按 origin=session-wrap 过滤/回查。 */
const WRAP_ORIGIN = 'session-wrap'

const KINDS_WRITTEN = new Set(['lesson', 'decision', 'preference', 'fact'])

const LEVEL_OF_KIND = Object.freeze({
  lesson: 'important', decision: 'important', preference: 'normal', fact: 'normal', rule: 'important',
})
const TYPE_OF_KIND = Object.freeze({
  lesson: 'procedural', decision: 'semantic', preference: 'semantic', fact: 'semantic', rule: 'procedural',
})

/** 本地日期戳（报告文件名口径，与日报一致）。 */
function dayStamp(seconds) {
  const d = new Date(Number(seconds) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 数据目录：优先真实库文件所在目录（dataDir 空时 openDb 会落到 DSH_HOME），
 * 这样 spool/reports 与 memory.db 永远同根，灾备/清理不会两处漂移。
 *
 * @param {any} backend @param {any} config
 * @returns {string}
 */
export function resolveDataDir(backend, config) {
  try {
    const file = String(backend?.dbFile || '').trim()
    if (file) return dirname(file)
  } catch { /* dbFile getter 失败：回落配置 */ }
  const raw = String(value(config?.dataDir, '') || '').trim()
  if (raw) return resolve(raw)
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(home, 'whale-memory')
}

/** 安全 JSON：坏文件返回 null（调用方给可见失败，不当作空材料）。 */
function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 原子写（同目录 tmp + rename）：崩溃不会留下半截 JSON。 */
function atomicWrite(path, text, mode = 0o600) {
  const tmp = `${path}.tmp.${process.pid}`
  try { rmSync(tmp, { force: true }) } catch { /* noop */ }
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  renameSync(tmp, path)
}

/** 模型输出收集：只收文本增量/文本块；超时由 AbortController 真正中断适配器请求。 */
async function collectModelText(llm, selection, prompt, { modelOverride = '', timeoutMs = 60_000 } = {}) {
  const provider = selection?.provider
  const model = String(modelOverride || selection?.model || '')
  if (!provider || !model) return { ok: false, reason: 'no_model' }
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* noop */ } }, Math.max(1000, Number(timeoutMs) || 60_000))
  if (typeof timer.unref === 'function') timer.unref()
  let text = ''
  try {
    const iterable = llm.stream({
      provider, model, temperature: 0.2, maxTokens: 1800, signal: ac.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of iterable) {
      if (text.length >= MODEL_OUTPUT_MAX) break
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text += String(chunk.block.text || '')
    }
    return { ok: true, text: text.slice(0, MODEL_OUTPUT_MAX) }
  } catch (err) {
    // AbortError 在不同适配器里形状不同：以 signal 为判据，不靠 message 字符串。
    const reason = ac.signal?.aborted ? 'model_timeout' : `model_error:${String(err?.message || err).slice(0, 160)}`
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

/** 候选状态计数：从 distilled items 现算，重试/续跑不会把计数越加越多。 */
function countsOf(items) {
  const out = { candidates: 0, rule_proposals: 0, open_loops: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item?.status || 'pending')
    if (status === 'written') out.candidates += 1
    else if (status === 'proposal') out.rule_proposals += 1
    else if (status === 'open_loop') out.open_loops += 1
  }
  return out
}

/** 可切会话结论：报告落盘 + 没有**其他** wrap job 在排队/运行；清洁问题只作 warning。 */
function computeSwitchReady({ reportPath, reportEnabled, currentJobId, withDb, hygiene }) {
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
 * 安装 Session Wrap 服务。
 *
 * @param {{ effect?:Function, on?:Function }} ctx
 * @param {{
 *   backend:any, config:any, keeper:any, log?:(line:string)=>void,
 *   getLlm?:()=>any, getSelection?:()=>any, captureRef?:{current:any},
 *   now?:()=>number, modelTimeoutMs?:number, report?:boolean,
 * }} deps
 * @returns {{ onTrigger:Function, manual:Function, status:Function, report:Function,
 *   sweepSpool:Function, reconcile:Function, supported:boolean, dispose:Function }}
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
      model: String(value(w.model, '') || ''),
      maxMaterialChars: num(w.maxMaterialChars, 12000),
      timeoutMs: num(w.timeoutMs, modelTimeoutMs),
    }
  }
  const baseDir = () => resolveDataDir(backend, config)
  const spoolDir = () => join(baseDir(), 'spool', 'session-wrap')
  const reportDir = () => join(baseDir(), 'reports')

  let disposed = false
  let timer = null
  let lastSkip = null
  let lastManual = null

  const jobLive = (jobId) => {
    if (!jobId) return false
    try {
      const row = withDb((db) => db.prepare('SELECT state FROM jobs WHERE id=?').get(Number(jobId)))
      return Boolean(row && (row.state === 'queued' || row.state === 'running'))
    } catch { return false }
  }

  const spoolPathOf = (run) => join(spoolDir(), `run-${Number(run.id)}-${String(run.material_hash || '').slice(0, 32)}.json`)

  /**
   * 排队/运行中的 wrap job 数。必须查库而不是 keeper.status()：后者只取最近 200 条，
   * 旧 job 会被挤出窗口，busy 闸随之失效（审查 P2）。
   */
  const activeWrapJobs = () => {
    try {
      return withDb((db) => Number(db.prepare(
        "SELECT count(*) AS n FROM jobs WHERE kind='wrap' AND state IN ('queued','running')",
      ).get()?.n || 0))
    } catch { return 0 }
  }

  /** 自动触发闸：每天上限 + 已有 wrap job 在跑（避免空闲 tick 堆 job）。 */
  const autoGate = () => {
    if (!supported) return { ok: false, reason: 'unsupported_backend' }
    const cfg = wrapCfg()
    if (!cfg.enabled) return { ok: false, reason: 'wrap_disabled' }
    try {
      // 额度只由自动触发消耗：显式/手动是人工动作，不能把后台预算吃光（审查 P2）。
      const today = withDb((db) => countRunsToday(db, now(), { triggers: ['idle', 'disposed'] }))
      if (today >= cfg.maxRunsPerDay) return { ok: false, reason: 'rate_limited' }
    } catch { return { ok: false, reason: 'db_error' } }
    if (activeWrapJobs() > 0) return { ok: false, reason: 'busy' }
    return { ok: true }
  }

  /** 入队一条 wrap job；payload 只含指针，不含任何对话正文。 */
  const enqueueJob = (run, spoolPath) => {
    const jobId = keeper.enqueue('wrap', { runId: Number(run.id), spoolPath, materialHash: run.material_hash })
    withDb((db) => updateRun(db, run.id, { job_id: Number(jobId), state: 'queued' }))
    // 入队后主动踢一次 keeper：面板「立即收尾」不能等 10 分钟定时 tick。
    // tick 自身有单飞/水位闸门，重复踢只会 skipped:'busy'，不会起第二个 job。
    if (typeof keeper.tick === 'function') {
      try {
        const task = keeper.tick()
        if (task && typeof task.catch === 'function') {
          task.catch((err) => log(`[whale-memory] wrap kick tick fail-open: ${err?.message || err}`))
        }
      } catch (err) {
        log(`[whale-memory] wrap kick tick fail-open: ${err?.message || err}`)
      }
    }
    return Number(jobId)
  }

  /**
   * 采集器交来的触发：幂等建 run → 写 spool → 入队。
   * 显式/手动允许重置终态；自动触发绝不复活终态（防止空闲 tick 反复烧模型）。
   */
  async function onTrigger({ sessionId, trigger = 'manual', material, identity, header, hash, now: at }) {
    if (disposed) return { ok: false, reason: 'disposed' }
    if (!supported) return { ok: false, reason: 'unsupported_backend' }
    const cfg = wrapCfg()
    if (!cfg.enabled) return { ok: false, reason: 'wrap_disabled' }
    const tx = String(trigger || 'manual')
    const auto = tx === 'idle' || tx === 'disposed'
    if (auto) {
      const gate = autoGate()
      if (!gate.ok) { lastSkip = { at: now(), trigger: tx, reason: gate.reason }; return gate }
    }
    let created
    try {
      created = withDb((db) => createRun(db, {
        sessionId, materialHash: hash, trigger: tx, identity,
        now: now(), reset: !auto,
      }))
    } catch (err) {
      log(`[whale-memory] wrap create run fail-open: ${err?.message || err}`)
      return { ok: false, reason: 'db_error' }
    }
    if (!created?.ok) return { ok: false, reason: created?.error || 'invalid_key' }
    let run = created.run
    if (created.done) {
      // 同材料已成功：推进采集缓冲，避免用户继续聊后把旧轮次再次带进下一个 run（重复候选/白烧 token）。
      try { captureRef?.current?.advance?.(String(sessionId), Number(material?.seqTo) || 0) } catch { /* 已成功，推进失败只影响去重 */ }
      return { ok: true, runId: run.id, existing: true, done: true, state: run.state }
    }
    if (!created.active && !created.reset) {
      // 失败/跳过终态：对采集器返回 ok，避免 idle tick 每分钟重复尝试；材料保留供手动重试。
      return { ok: true, runId: run.id, existing: true, done: false, state: run.state }
    }
    if (run.state === 'queued' || run.state === 'running') {
      if (jobLive(run.job_id)) return { ok: true, runId: run.id, existing: true, state: run.state }
    }

    // 先落 spool 再入队：job 开始时 spool 必须可读；崩溃留下的 spool 由 TTL 清扫。
    const spoolPath = spoolPathOf(run)
    try {
      mkdirSync(spoolDir(), { recursive: true, mode: 0o700 })
      const snapshot = {
        runId: Number(run.id),
        sessionId: String(sessionId),
        identity: {
          userId: String(identity?.userId || ''), roleId: String(identity?.roleId || ''), workspace: String(identity?.workspace || ''),
        },
        header: { id: header?.id || String(sessionId), cwd: header?.cwd || '' },
        trigger: tx,
        hash: String(hash),
        startedAt: Number(at) || now(),
        material: {
          turns: Array.isArray(material?.turns) ? material.turns : [],
          seqTo: Number(material?.seqTo) || 0,
          chars: Number(material?.chars) || 0,
        },
      }
      atomicWrite(spoolPath, JSON.stringify(snapshot), 0o600)
    } catch (err) {
      log(`[whale-memory] wrap spool write failed: ${err?.message || err}`)
      try {
        withDb((db) => updateRun(db, run.id, { state: 'failed', error: `spool_write_failed:${String(err?.message || err).slice(0, 120)}` }))
      } catch { /* 可见失败已进日志 */ }
      return { ok: false, reason: 'spool_write_failed' }
    }
    try {
      enqueueJob(run, spoolPath)
      run = withDb((db) => getRun(db, run.id))
    } catch (err) {
      log(`[whale-memory] wrap enqueue failed: ${err?.message || err}`)
      return { ok: false, reason: 'enqueue_failed' }
    }
    lastManual = { at: now(), trigger: tx, runId: run.id }
    log(`[whale-memory] wrap queued run=${run.id} trigger=${tx} turns=${snapshotTurns(material)} hash=${String(hash).slice(0, 12)}`)
    return { ok: true, runId: run.id, existing: Boolean(created.existing), state: run.state }
  }

  function snapshotTurns(material) {
    return Array.isArray(material?.turns) ? material.turns.length : 0
  }

  /** 终态收尾：更新 run，按需删 spool。 */
  function finish(runId, state, patch = {}, { deleteSpool = false, spoolPath = '' } = {}) {
    let run = null
    try {
      run = withDb((db) => updateRun(db, runId, { state, ...patch }).run)
    } catch (err) {
      log(`[whale-memory] wrap finish(${state}) failed: ${err?.message || err}`)
    }
    // 只有终态真的落库才删 spool：DB 写失败时保留材料，重启对账还能续跑。
    if (deleteSpool && run) removeSpool(spoolPath)
    return run
  }

  /**
   * 终态必须真的落库才算完成：DB 锁/磁盘满时 finish 只记日志，若调用方仍返回成功，
   * keeper 会把 job 标 done、run 永远停在 running，清理缓冲后就永久丢材料（审查 P1）。
   * 失败一律抛错交给 keeper 退避重试；spool 由 finish 只在写成功时删除。
   */
  function finishOrThrow(runId, state, patch = {}, opts = {}) {
    const run = finish(runId, state, patch, opts)
    if (!run) throw new Error(`finalize_failed:${state}`)
    return run
  }

  function removeSpool(path) {
    if (!path) return false
    try { rmSync(path, { force: true }); return true } catch { return false }
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
      finishOrThrow(runId, 'skipped', { error: 'wrap_disabled' }, { deleteSpool: true, spoolPath })
      return { skipped: 'wrap_disabled' }
    }
    const spool = readJsonFile(spoolPath)
    if (!spool || typeof spool.material !== 'object' || !Array.isArray(spool.material?.turns)) {
      finishOrThrow(runId, 'failed', { error: 'spool_missing' })
      throw new Error('spool_missing')
    }
    run = withDb((db) => markRunAttempt(db, runId, now())) || run

    // 1) 蒸馏（断点续跑：distilled_json 已存在就不再调模型）
    let distilled = run.distilled && Array.isArray(run.distilled.items) ? run.distilled : null
    if (!distilled) {
      const llm = (() => { try { return getLlm?.() } catch { return null } })()
      const selection = (() => { try { return getSelection?.() } catch { return null } })()
      if (!llm || typeof llm.stream !== 'function') {
        finishOrThrow(runId, 'skipped', { error: 'no_model' })
        return { skipped: 'no_model' }
      }
      const prompt = buildDistillPrompt(
        { turns: spool.material.turns },
        { maxItems: cfg.maxItems, maxChars: cfg.maxMaterialChars },
      )
      const got = await collectModelText(llm, selection, prompt, {
        modelOverride: cfg.model, timeoutMs: cfg.timeoutMs,
      })
      if (!got.ok) {
        if (got.reason === 'no_model') {
          finishOrThrow(runId, 'skipped', { error: 'no_model' })
          return { skipped: 'no_model' }
        }
        finishOrThrow(runId, 'failed', { error: String(got.reason).slice(0, 200) })
        throw new Error(got.reason)
      }
      const parsed = parseDistillOutput(got.text)
      if (!parsed.ok) {
        finishOrThrow(runId, 'failed', { error: `bad_json:${parsed.error || 'parse'}` })
        throw new Error('distill_bad_json')
      }
      const validated = validateDistillItems(parsed.items, { turns: spool.material.turns }, {
        maxItems: cfg.maxItems,
      })
      const summary = clampSummary(parsed.summary)
      distilled = {
        summary,
        items: validated.items.map((item) => ({ ...item, status: 'pending' })),
        dropped: validated.dropped,
      }
      withDb((db) => updateRun(db, runId, {
        phase: 'distilled', summary, distilled_json: distilled, error: '',
      }))
      if (distilled.items.length === 0) {
        finishOrThrow(runId, 'skipped', { error: 'no_items', phase: 'distilled' }, { deleteSpool: true, spoolPath })
        log(`[whale-memory] wrap run=${runId} skipped no_items dropped=${distilled.dropped.length}`)
        return { skipped: 'no_items', dropped: distilled.dropped.length }
      }
    }

    // 2) 分流：记忆候选 / 规则提案 / 待办不落长期记忆
    const writeEnabled = bool(config?.write?.enabled, true)
    const rulesEnabled = bool(config?.rules?.enabled, true)
    const autoAccept = cfg.autoAccept
    const failures = []
    const items = distilled.items
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const status = String(item.status || 'pending')
      // 写失败是可重试状态：进入本轮重新尝试；其余终态直接跳过（续跑幂等）。
      const retryable = status.startsWith('write_failed:')
      if (status !== 'pending' && !retryable) continue
      if (!KINDS_WRITTEN.has(item.kind) && item.kind !== 'rule' && item.kind !== 'open_loop') {
        items[i] = { ...item, status: 'skipped:unknown_kind' }
      } else if (item.kind === 'open_loop') {
        items[i] = { ...item, status: 'open_loop' }
      } else if (item.kind === 'rule') {
        if (!rulesEnabled) {
          items[i] = { ...item, status: 'skipped:rules_disabled' }
        } else {
          try {
            const proposal = createProposal({
              text: item.text,
              source: 'session-wrap',
              identity: spool.identity,
              traceId: `wrap:${runId}`,
              sessionId: String(spool.sessionId || ''),
              config,
              log,
            })
            items[i] = proposal?.ok
              ? { ...item, status: 'proposal', proposalId: String(proposal.proposal?.id || ''), cooling: Boolean(proposal.cooling) }
              : { ...item, status: `proposal_rejected:${String(proposal?.code || 'unknown').slice(0, 80)}` }
          } catch (err) {
            // 提案写入是文件系统动作：异常按失败重试，不把整条 run 永久标失败。
            failures.push({ index: i, reason: `proposal_error:${String(err?.message || err).slice(0, 120)}` })
            items[i] = { ...item, status: `write_failed:proposal_error` }
          }
        }
      } else if (!writeEnabled) {
        items[i] = { ...item, status: 'skipped:write_disabled' }
      } else {
        try {
          const res = await backend.write({
            text: item.text,
            level: LEVEL_OF_KIND[item.kind] || 'normal',
            memory_type: TYPE_OF_KIND[item.kind] || 'semantic',
            source: 'owner',
            tags: ['session-wrap', ...(Array.isArray(item.tags) ? item.tags : [])].slice(0, 8),
            origin: WRAP_ORIGIN,
            traceId: `wrap:${runId}`,
            identity: spool.identity,
            forceShadow: !autoAccept,
          })
          if (res?.ok) {
            items[i] = {
              ...item,
              status: 'written',
              nodeId: res.id ? String(res.id) : '',
              action: String(res.action || ''),
              candidate: Boolean(res.candidate),
            }
          } else {
            const code = String(res?.error || 'write_failed')
            const permanent = ['write_disabled', 'privacy', 'text_too_long', 'invalid_text', 'invalid_level', 'invalid_memory_type', 'invalid_tags'].includes(code)
            items[i] = permanent
              ? { ...item, status: `skipped:${code}` }
              : { ...item, status: `write_failed:${code}` }
            if (!permanent) failures.push({ index: i, reason: `write_failed:${code}` })
          }
        } catch (err) {
          items[i] = { ...item, status: 'write_failed:exception' }
          failures.push({ index: i, reason: `write_exception:${String(err?.message || err).slice(0, 120)}` })
        }
      }
      const counts = countsOf(items)
      withDb((db) => updateRun(db, runId, { distilled_json: { ...distilled, items }, ...counts, phase: 'written' }))
    }

    // 3) 报告（不含原始对话）
    const counts = countsOf(items)
    const candidates = items.filter((item) => KINDS_WRITTEN.has(item.kind))
    const ruleProposals = items.filter((item) => item.kind === 'rule')
    const openLoops = items.filter((item) => item.kind === 'open_loop')
    let hygiene = null
    try {
      hygiene = withDb((db) => auditMemory(db, {
        dbFile: String(backend.dbFile || ''), nowSec: now(), backupDir: join(baseDir(), 'backup'),
      }))
    } catch (err) {
      hygiene = {
        ok: false, blockers: ['hygiene_unavailable'], warnings: [],
        checks: [], stats: {},
      }
      log(`[whale-memory] wrap hygiene unavailable: ${err?.message || err}`)
    }
    const reportPath = wrapCfg().report
      ? join(reportDir(), wrapReportFileName({ day: dayStamp(now()), sessionId: String(spool.sessionId || ''), runId }))
      : ''
    let reportWritten = false
    if (reportPath) {
      try {
        mkdirSync(reportDir(), { recursive: true, mode: 0o700 })
        // 报告自身尚未落盘：摘要里的“可切会话”不计 report_missing，
        // 否则每份报告都会写“否”，真实结论看 run.switch_ready_json / 面板。
        const switchPreview = computeSwitchReady({
          reportPath: '', reportEnabled: false, currentJobId: api?.jobId, withDb, hygiene,
        })
        const markdown = renderWrapReport({
          run: {
            id: runId, trigger: String(spool.trigger || run.trigger || ''),
            day: dayStamp(now()), createdAt: run.created_at,
          },
          summary: distilled.summary || '',
          candidates,
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
    const failedCount = failures.length
    const common = {
      phase: 'reported', summary: distilled.summary || '', distilled_json: { ...distilled, items },
      report_path: reportWritten ? reportPath : '', hygiene_json: hygiene,
      switch_ready_json: switchReady, ...counts,
    }
    if (failedCount > 0) {
      const error = `candidate_write_failed:${failedCount}`
      finishOrThrow(runId, 'failed', { ...common, error })
      log(`[whale-memory] wrap run=${runId} failed ${error}`)
      throw new Error(error)
    }

    // 4) 成功后：落终态、删 spool、推进采集缓冲、入队一次巩固（不抢并发）。
    // 先确保 done 真的落库，再删 spool/推进缓冲；终态写不进去就抛错重试（审查 P1）。
    finishOrThrow(runId, 'done', { ...common, error: '', phase: 'done' }, { deleteSpool: true, spoolPath })
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
    log(`[whale-memory] wrap done run=${runId} candidates=${counts.candidates} proposals=${counts.rule_proposals} open=${counts.open_loops} switchReady=${switchReady.ready}`)
    return {
      runId, candidates: counts.candidates, ruleProposals: counts.rule_proposals,
      openLoops: counts.open_loops, report: reportWritten ? reportPath : '', switchReady,
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
    // 已有一条 wrap job 在排队/运行：手动再点不能把同一段材料蒸馏第二遍（审查 P2）。
    if (activeWrapJobs() > 0) return { ok: false, reason: 'busy_wrap' }
    const out = await capture.triggerRecent('manual')
    if (out?.ok) lastManual = { at: now(), trigger: 'manual', runId: out.runId }
    return out
  }

  /**
   * 状态视图：只暴露计数/状态/可切会话，不返回候选正文。
   * identity 为 null 时展示全局最近一条（面板默认）；显式身份时严格同分区。
   */
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
    const spool = spoolStats()
    return {
      ok: true,
      supported: true,
      enabled: wrapCfg().enabled,
      runsToday: today,
      maxRunsPerDay: wrapCfg().maxRunsPerDay,
      jobs: activeWrapJobs(),
      latest: latest ? {
        id: latest.id, state: latest.state, trigger: latest.trigger,
        phase: latest.phase, attempts: latest.attempts,
        createdAt: latest.created_at, updatedAt: latest.updated_at,
        candidates: latest.candidates, ruleProposals: latest.rule_proposals, openLoops: latest.open_loops,
        // 状态视图只给计数/结论，不给摘要正文：面板/远端都拿不到会话里的具体句子。
        switchReady: latest.switchReady, error: latest.error || '',
        reportAvailable: Boolean(latest.report_path),
      } : null,
      recent: rows,
      spool,
      capture: captureRef?.current?.status ? captureRef.current.status() : null,
      lastSkip,
      lastManual,
    }
  }

  function spoolStats() {
    try {
      const dir = spoolDir()
      if (!existsSync(dir)) return { files: 0, bytes: 0 }
      let files = 0
      let bytes = 0
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          files += 1
          bytes += statSync(join(dir, name)).size
        } catch { /* 文件刚被删：忽略 */ }
      }
      return { files, bytes }
    } catch { return { files: 0, bytes: 0 } }
  }

  /** 报告读取：只认 run.report_path 且必须落在 reports 目录内（防路径穿越）。 */
  function report(runId) {
    if (!supported) return { ok: false, error: 'unsupported_backend' }
    const run = withDb((db) => getRun(db, runId))
    if (!run || !run.report_path) return { ok: false, error: 'report_missing' }
    const dir = resolve(reportDir())
    const abs = resolve(String(run.report_path))
    if (!existsSync(abs)) return { ok: false, error: 'report_missing' }
    // 先做一次词法越界判断：reports/ 目录还不存在时 realpath 会抛，
    // 不能把语义明确的 ../ 越界误报成 report_unreadable（审查新 P2）。
    const lexical = relative(dir, abs)
    if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) {
      return { ok: false, error: 'report_path_outside' }
    }
    try {
      // 再用 realpath 判越界：reports/ 内的软链可能指向目录外（审查 P2），只看字符串前缀挡不住。
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
   * 只动 done/failed/skipped 的 run（queued/running 可能在续跑，绝不删）；0 = 永久保留。
   * 报告先收集“仍在台账里的路径”再删，避免删掉仍可回查的报告。
   */
  function sweepStorage() {
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
      const dir = reportDir()
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!/^session-wrap-.*\.md$/.test(name)) continue
          const abs = join(dir, name)
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

  /** spool TTL 清扫：只删超过 TTL 的文件；终态由 execute 自己删，不在清扫里猜状态。 */
  function sweepSpool({ ttlHours = null } = {}) {
    const ttl = Math.max(1, Number(ttlHours) || wrapCfg().spoolTtlHours)
    const dir = spoolDir()
    let deleted = 0
    try {
      if (!existsSync(dir)) return { deleted: 0 }
      const cutoff = Date.now() - ttl * 3600_000
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name)
        try {
          if (statSync(abs).mtimeMs < cutoff) { rmSync(abs, { force: true }); deleted += 1 }
        } catch { /* 并发删除/权限：跳过 */ }
      }
    } catch (err) {
      log(`[whale-memory] wrap spool sweep fail-open: ${err?.message || err}`)
    }
    return { deleted }
  }

  /**
   * 启动对账：queued/running 的 run 没有活 job 时补一条（进程死在入队与执行之间）。
   * 不重跑 done；spool 丢失的 run 标 failed（可见），不伪造成功。
   */
  function reconcile() {
    if (!supported) return { checked: 0, requeued: 0, failed: 0 }
    let rows = []
    try {
      rows = withDb((db) => db.prepare(`SELECT id,state,job_id,material_hash FROM wrap_runs
        WHERE state IN ('queued','running') ORDER BY id LIMIT 100`).all())
    } catch (err) {
      log(`[whale-memory] wrap reconcile read failed: ${err?.message || err}`)
      return { checked: 0, requeued: 0, failed: 0 }
    }
    let requeued = 0
    let failed = 0
    for (const row of rows) {
      if (jobLive(row.job_id)) continue
      const path = spoolPathOf(row)
      if (!existsSync(path)) {
        try {
          withDb((db) => updateRun(db, row.id, { state: 'failed', error: 'spool_missing' }))
          failed += 1
        } catch { /* 下一次启动再试 */ }
        continue
      }
      try {
        enqueueJob(row, path)
        requeued += 1
      } catch (err) {
        log(`[whale-memory] wrap reconcile enqueue failed: ${err?.message || err}`)
      }
    }
    if (requeued || failed) log(`[whale-memory] wrap reconcile requeued=${requeued} failed=${failed}`)
    return { checked: rows.length, requeued, failed }
  }

  // 启动对账延后执行：不阻塞插件 init，也给 keeper 的启动补偿让路。
  let bootTimer = null
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
    disposed = true
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null }
    if (timer) { clearInterval(timer); timer = null }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose(), 'whale-memory: session wrap')

  /** 采集器空闲 tick 的闸：把「今天额度/已有 job」判断前移，避免每 60s 反复打库。 */
  const canAutoTrigger = () => {
    if (!wrapCfg().idle) return { ok: false, reason: 'idle_disabled' }
    return autoGate()
  }

  return {
    onTrigger, manual, status, report, sweepSpool, sweepStorage, reconcile, execute,
    canAutoTrigger, supported, dispose,
  }
}
