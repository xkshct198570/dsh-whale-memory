// 职责：/wrap/status 的响应投影（队列位次/阶段/失败语义；无正文、无跨用户）；依赖：零 import。
//
// 拆分（S1b）：门面只取数（latest/rows/spool/capture），字段形状集中在此，
// 防止面板需要的新字段散落在门面分支里、也防止顺手把正文/spool 内容带出去。

/**
 * 排队视图：无排队=null；有则 count/position（队首恒 1）/phase（排队恒 null）/materialHash。
 * @param {{head:()=>object|null, size:()=>number, positionOf:(id:number)=>number|null}} queue
 * @param {number|null} [focusRunId] 指定 run 的位次（刚入队的那个）；缺省取队首。
 * @returns {null|{count:number, position:number|null, phase:null, materialHash:string}}
 */
export function projectQueued(queue, focusRunId = null) {
  const count = Number(queue?.size?.() || 0)
  if (count <= 0) return null
  const entry = queue.head?.() || null
  const position = focusRunId ? queue.positionOf?.(Number(focusRunId)) : (entry ? 1 : null)
  return {
    count,
    position: position === null || position === undefined ? null : Number(position),
    phase: null,
    materialHash: String(entry?.materialHash || ''),
  }
}

/** 最新 run 的 retrying 投影（S2）：run=failed 但 keeper job 还在退避排队 → {attempt,max}。 */
export function projectRetrying(latest, job = null) {
  if (!latest || latest.state !== 'failed') return false
  if (!job || String(job.state) !== 'queued') return false
  const attempts = Number(job.attempts || 0)
  const max = Number(job.maxAttempts || 4)
  if (attempts <= 0 || attempts >= max) return false
  return { attempt: Math.min(max, attempts + 1), max }
}

/**
 * 最新 run 的写入计数：新 run 读 distilled_json.counts；旧 run 无该字段时按列回退
 * （reviewed=candidates，ingested/skipped=0），面板不因旧行缺字段而报错。
 * @param {object|null} latest decodeRun 结果
 * @returns {{ ingested:number, reviewed:number, skipped:number }}
 */
export function countsOfRun(latest) {
  const raw = latest && latest.distilled && typeof latest.distilled === 'object'
    ? latest.distilled.counts : null
  if (raw && typeof raw === 'object') {
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0)
    return { ingested: n(raw.ingested), reviewed: n(raw.reviewed), skipped: n(raw.skipped) }
  }
  return { ingested: 0, reviewed: Number(latest && latest.candidates || 0), skipped: 0 }
}

/**
 * 状态响应（总纲 §5.3 字段形状）。
 *
 * @param {{
 *   supported:boolean, enabled:boolean, maxRunsPerDay:number, jobs:number,
 *   latest:object|null, rows:Array<object>, spool:object, capture:object|null,
 *   queue:any, runsToday:number, lastSkip?:any, lastManual?:any, now?:number,
 * }} input
 * @returns {object}
 */
export function buildWrapStatus({
  supported, enabled, maxRunsPerDay, jobs, latest, rows, spool, capture, queue,
  runsToday, lastSkip = null, lastManual = null, focusRunId = null,
  auto = { enabled: false, idleMinutes: 0 }, job = null, reconcileEnabled = false,
}) {
  if (!supported) {
    return { ok: true, supported: false, enabled: false, latest: null, reason: 'unsupported_backend' }
  }
  return {
    ok: true,
    supported: true,
    enabled: Boolean(enabled),
    runsToday: Number(runsToday || 0),
    maxRunsPerDay: Number(maxRunsPerDay || 0),
    jobs: Number(jobs || 0),
    // 阶段投影开关（§5.3）：关闭时 UI 不得出现 reconcile 阶段。
    reconcile: { enabled: Boolean(reconcileEnabled) },
    queued: projectQueued(queue, focusRunId),
    latest: latest ? {
      id: Number(latest.id),
      state: latest.state,
      phase: latest.phase,
      trigger: latest.trigger,
      attempts: Number(latest.attempts || 0),
      createdAt: Number(latest.created_at || 0),
      updatedAt: Number(latest.updated_at || 0),
      candidates: Number(latest.candidates || 0),
      counts: countsOfRun(latest),
      ruleProposals: Number(latest.rule_proposals || 0),
      openLoops: Number(latest.open_loops || 0),
      switchReady: latest.switchReady || null,
      error: latest.error || '',
      reportAvailable: Boolean(latest.report_path),
      retrying: projectRetrying(latest, job),
    } : null,
    recent: Array.isArray(rows) ? rows : [],
    spool: spool || { files: 0, bytes: 0 },
    capture: capture || null,
    // S1b 契约：auto 固定 {enabled:false,idleMinutes:0}；S2 才接配置（避免“面板勾了但没接线”）。
    auto: { enabled: Boolean(auto?.enabled), idleMinutes: Number(auto?.idleMinutes || 0) },
    lastSkip: lastSkip || null,
    lastManual: lastManual || null,
  }
}
