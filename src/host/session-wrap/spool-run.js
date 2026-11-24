/**
 * Session Wrap 的 spool 与 run 生命周期：原子读写、路径、TTL 清扫、终态落库、触发/入队/对账。
 *
 * 拆分（P2c）：文件 I/O 与 run 状态机集中在本文件；蒸馏/分流/报告分别在 distill/dispatch/report.js；
 * 编排与装配留在门面 session-wrap.js。
 * 依赖方向：host → shared + core/wrap-runs；不 import 门面（避免环）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { value } from '../../shared/config-values.js'
import { countRunsToday, createRun, getRun, updateRun } from '../../core/wrap-runs.js'

/** 数据目录：优先真实库文件所在目录（dataDir 空时 openDb 会落到 DSH_HOME），
 * 这样 spool/reports 与 memory.db 永远同根，灾备/清理不会两处漂移。
 * @param {any} backend @param {any} config @returns {string} */
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
export function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 原子写（同目录 tmp + rename）：崩溃不会留下半截 JSON。 */
export function atomicWrite(path, text, mode = 0o600) {
  const tmp = `${path}.tmp.${process.pid}`
  try { rmSync(tmp, { force: true }) } catch { /* noop */ }
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  renameSync(tmp, path)
}

/** spool 文件路径由 run id + material_hash 前缀决定（同一 run 重试复用同一文件）。 */
export function spoolPathOf(spoolDir, run) {
  return join(spoolDir, `run-${Number(run.id)}-${String(run.material_hash || '').slice(0, 32)}.json`)
}

export function removeSpool(path) {
  if (!path) return false
  try { rmSync(path, { force: true }); return true } catch { return false }
}

/** 终态收尾：更新 run，按需删 spool（DB 写失败时保留材料，重启对账还能续跑）。 */
export function finishRun({ withDb, log = () => {} }, runId, state, patch = {}, { deleteSpool = false, spoolPath = '' } = {}) {
  let run = null
  try {
    run = withDb((db) => updateRun(db, runId, { state, ...patch }).run)
  } catch (err) {
    log(`[whale-memory] wrap finish(${state}) failed: ${err?.message || err}`)
  }
  if (deleteSpool && run) removeSpool(spoolPath)
  return run
}

/** 终态必须真的落库才算完成：失败一律抛错交给 keeper 退避重试。 */
export function finishOrThrow(deps, runId, state, patch = {}, opts = {}) {
  const run = finishRun(deps, runId, state, patch, opts)
  if (!run) throw new Error(`finalize_failed:${state}`)
  return run
}

/** 把采集快照写进 spool：先落 spool 再入队；0600、目录 0700。 */
export function writeSpoolSnapshot({ spoolDir, run, sessionId, identity, header, trigger, hash, at, material, now }) {
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 })
  const snapshot = {
    runId: Number(run.id),
    sessionId: String(sessionId),
    identity: {
      userId: String(identity?.userId || ''), roleId: String(identity?.roleId || ''), workspace: String(identity?.workspace || ''),
    },
    header: { id: header?.id || String(sessionId), cwd: header?.cwd || '' },
    trigger,
    hash: String(hash),
    startedAt: Number(at) || now(),
    material: {
      turns: Array.isArray(material?.turns) ? material.turns : [],
      seqTo: Number(material?.seqTo) || 0,
      chars: Number(material?.chars) || 0,
    },
  }
  const spoolPath = spoolPathOf(spoolDir, run)
  atomicWrite(spoolPath, JSON.stringify(snapshot), 0o600)
  return { spoolPath, snapshot }
}

export function spoolStats(spoolDir) {
  try {
    if (!existsSync(spoolDir)) return { files: 0, bytes: 0 }
    let files = 0
    let bytes = 0
    for (const name of readdirSync(spoolDir)) {
      if (!name.endsWith('.json')) continue
      try {
        files += 1
        bytes += statSync(join(spoolDir, name)).size
      } catch { /* 文件刚被删：忽略 */ }
    }
    return { files, bytes }
  } catch { return { files: 0, bytes: 0 } }
}

/** spool TTL 清扫：只删超过 TTL 的文件；终态由 execute 自己删，不在清扫里猜状态。 */
export function sweepSpool({ spoolDir, ttlHours, fallbackTtlHours, log = () => {} }) {
  // 单一 clamp：显式 ttl 为假值（0/null/空串）时回落到配置值；两者都 0 才强制 1h。
  const ttl = Math.max(1, Number(ttlHours) || Number(fallbackTtlHours))
  let deleted = 0
  try {
    if (!existsSync(spoolDir)) return { deleted: 0 }
    const cutoff = Date.now() - ttl * 3600_000
    for (const name of readdirSync(spoolDir)) {
      const abs = join(spoolDir, name)
      try {
        if (statSync(abs).mtimeMs < cutoff) { rmSync(abs, { force: true }); deleted += 1 }
      } catch { /* 并发删除/权限：跳过 */ }
    }
  } catch (err) {
    log(`[whale-memory] wrap spool sweep fail-open: ${err?.message || err}`)
  }
  return { deleted }
}

function snapshotTurns(material) {
  return Array.isArray(material?.turns) ? material.turns.length : 0
}

/**
 * 触发/入队服务：把采集器交来的触发变成幂等 run + spool + wrap job。
 * @param {{
 *   withDb:Function, keeper:any, captureRef:{current:any}, wrapCfg:()=>any,
 *   spoolDir:()=>string, now:()=>number, log?:Function, supported:boolean,
 *   state:{disposed:boolean,lastSkip:any,lastManual:any},
 * }} deps
 */
export function createTriggerService({ withDb, keeper, captureRef, wrapCfg, spoolDir, now, log = () => {}, supported, state }) {
  const jobLive = (jobId) => {
    if (!jobId) return false
    try {
      const row = withDb((db) => db.prepare('SELECT state FROM jobs WHERE id=?').get(Number(jobId)))
      return Boolean(row && (row.state === 'queued' || row.state === 'running'))
    } catch { return false }
  }

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
    if (state.disposed) return { ok: false, reason: 'disposed' }
    if (!supported) return { ok: false, reason: 'unsupported_backend' }
    const cfg = wrapCfg()
    if (!cfg.enabled) return { ok: false, reason: 'wrap_disabled' }
    const tx = String(trigger || 'manual')
    const auto = tx === 'idle' || tx === 'disposed'
    if (auto) {
      const gate = autoGate()
      if (!gate.ok) { state.lastSkip = { at: now(), trigger: tx, reason: gate.reason }; return gate }
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
      try { captureRef?.current?.advance?.(String(sessionId), Number(material?.seqTo) || 0) } catch { /* 已成功，推进失败只影响去重 */ }
      return { ok: true, runId: run.id, existing: true, done: true, state: run.state }
    }
    if (!created.active && !created.reset) {
      return { ok: true, runId: run.id, existing: true, done: false, state: run.state }
    }
    if (run.state === 'queued' || run.state === 'running') {
      if (jobLive(run.job_id)) return { ok: true, runId: run.id, existing: true, state: run.state }
    }

    let spoolPath
    try {
      ;({ spoolPath } = writeSpoolSnapshot({
        spoolDir: spoolDir(), run, sessionId, identity, header, trigger: tx, hash, at, material, now,
      }))
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
    state.lastManual = { at: now(), trigger: tx, runId: run.id }
    log(`[whale-memory] wrap queued run=${run.id} trigger=${tx} turns=${snapshotTurns(material)} hash=${String(hash).slice(0, 12)}`)
    return { ok: true, runId: run.id, existing: Boolean(created.existing), state: run.state }
  }

  return { onTrigger, autoGate, activeWrapJobs, jobLive, enqueueJob }
}

/**
 * 启动对账：queued/running 的 run 没有活 job 时补一条（进程死在入队与执行之间）。
 * 不重跑 done；spool 丢失的 run 标 failed（可见），不伪造成功。
 */
export function reconcileRuns({ withDb, log = () => {}, jobLive, enqueueJob, spoolDir }) {
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
    const path = spoolPathOf(spoolDir, row)
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
