/**
 * 反思（S4）：把最近 episodic 提炼成 semantic/procedural 长期记忆。
 *
 * - 提示词/解析在 `reflect-prompt.js`（纯函数，可脱库测试）。
 * - runReflect：读近期 episodic → DSH 默认模型（ctx.llm.stream）→ 解析 JSON → 落库（source=self）。
 * - 调度：单一自动闸 scheduleAuto（enabled/队列/日限/峰时）供空闲 tick 与 turn 触发共用；
 *   手动 trigger 绕过峰时/日限但仍要求身份。身份由调用方显式传入（架构书 §5.5.1）：
 *   run() 不再现取 Config 身份，缺 userId/workspace 一律 identity_required。
 */
import { bool, num, value } from '../shared/config-values.js'
import { ingestPolicyOf } from '../shared/ingest-policy.js'
import { layerOfMemoryType } from '../shared/layers.js'
import { compileSuppressWindows, inSuppressWindow, localDayKey } from '../shared/maintenance-window.js'
import { memoryPressure } from '../shared/memory-guard.js'
import { buildReflectPrompt, parseReflectOutput } from './reflect-prompt.js'

/**
 * 反思输出预算：默认模型是推理档，会把思考计入 maxTokens；1200 会被思考吃光 → 正文空 →
 * 解析出 []（真机 47/47 次 `items=0`，2026-11-26 实核）。给足“思考+JSON”，并只收一种文本通道。
 */
const REFLECT_MAX_TOKENS = 8192

async function collectLlmText(llm, selection, prompt, modelOverride) {
  const provider = selection?.provider
  const model = modelOverride || selection?.model
  if (!provider || !model) return { ok: false, reason: 'no_model' }
  // 适配器会同时发 text-delta 与 block-end.text；两者相加会把 JSON 拼两遍（与收尾蒸馏同一根因）。
  let streamed = ''
  let blocked = ''
  let reasoningChars = 0
  for await (const chunk of llm.stream({
    provider, model, temperature: 0.2, maxTokens: REFLECT_MAX_TOKENS,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') streamed += chunk.text
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blocked += String(chunk.block.text || '')
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
  }
  return { ok: true, text: streamed || blocked, reasoningChars }
}

/**
 * 反思身份归一：只接受 userId+workspace 都非空的三元组；其余返回 null。
 * @param {unknown} raw
 * @returns {{ userId: string, roleId: string, workspace: string } | null}
 */
function identityOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ident = {
    userId: String(raw.userId || '').trim(),
    roleId: String(raw.roleId || '').trim(),
    workspace: String(raw.workspace || '').trim(),
  }
  return ident.userId && ident.workspace ? ident : null
}

/**
 * 条目级拒绝码：价值闸/身份闸/内容校验等"这条不该入库"的终态；其余 ok:false 属基础设施失败，
 * 必须让 run 失败（keeper 退避重试），不能计成 rejected 混进"价值闸拒绝"。
 */
const ITEM_REJECT_RE = /^(gate:|identity_required|invalid_text|text_too_long|ignored|privacy|daily_cap|write_disabled|write_rejected)/

/**
 * 反思写入计数：added=新增/合并/取代，review=候选，rejected=条目级拒绝，duplicate=判重命中，
 * failed=基础设施失败（队列超时/落库失败/无返回）。
 * @param {{ ok?: boolean, action?: string, candidate?: boolean, duplicate?: boolean, error?: string, reason?: string } | null | undefined} res
 * @param {{ added:number, review:number, rejected:number, duplicate:number, failed:number }} counts
 */
function tally(res, counts) {
  if (!res || typeof res !== 'object') { counts.failed += 1; return 'no_result' }
  if (res.ok === false) {
    const code = String(res.error || res.reason || 'write_failed')
    if (ITEM_REJECT_RE.test(code)) { counts.rejected += 1; return code }
    counts.failed += 1
    return code
  }
  if (res.candidate === true || res.action === 'CANDIDATE') { counts.review += 1; return 'review' }
  if (res.duplicate === true || res.action === 'NOOP') { counts.duplicate += 1; return 'duplicate' }
  counts.added += 1
  return 'added'
}

/**
 * @param {{ backend:any, llm:any, selection:any, config:any,
 *   identity:{userId:string,roleId:string,workspace:string}, sessionId?:string, log?:Function }} deps
 *   identity 必须由调用方显式给出（会话身份或任务 payload 身份），缺一即 `identity_required`；
 *   本函数不再从 Config 现取，杜绝“后台反思写共享 '' 分区”。
 * @returns {Promise<{ok:boolean, reason?:string, added?:number, review?:number, rejected?:number,
 *   material?:number, items?:number}>}
 */
export async function runReflect({ backend, llm, selection, config, identity = null, sessionId = '', log = () => {} }) {
  try {
    const ident = identityOf(identity)
    if (!ident) {
      log('[whale-memory] reflect skip identity_required (no session partition)')
      return { ok: false, reason: 'identity_required' }
    }
    if (!llm || typeof llm.stream !== 'function') {
      log('[whale-memory] reflect skip reason=llm_unavailable')
      return { ok: false, reason: 'llm_unavailable' }
    }
    if (!selection?.provider || (!selection?.model && !config?.reflect?.model)) {
      log('[whale-memory] reflect skip reason=no_model')
      return { ok: false, reason: 'no_model' }
    }
    if (memoryPressure().stress) {
      log('[whale-memory] reflect skip reason=memory_pressure')
      return { ok: false, reason: 'memory_pressure' }
    }
    const items = await backend.listEpisodic(20, { identity: ident })
    if (!items || items.length === 0) return { ok: true, added: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, material: 0, items: 0, reason: 'no_material' }
    const maxItems = num(config?.reflect?.maxItems, 8)
    const prompt = buildReflectPrompt(items, { maxItems })
    const out = await collectLlmText(llm, selection, prompt, config?.reflect?.model || '')
    if (!out.ok) return { ok: false, reason: out.reason }
    let parsed = parseReflectOutput(out.text)
    if (parsed.length === 0 && String(out.text || '').trim()) {
      // 解析空但正文非空：按收尾蒸馏同口径重试一次，只追加约束不改素材。
      log(`[whale-memory] reflect parse empty textLen=${out.text.length} reasoning=${out.reasoningChars || 0} retry=1`)
      const retry = await collectLlmText(llm, selection, `${prompt}\n\n只输出一个 JSON 数组，不要解释、不要代码围栏。`, config?.reflect?.model || '')
      if (retry.ok) parsed = parseReflectOutput(retry.text)
    } else if (String(out.text || '').trim() === '') {
      log(`[whale-memory] reflect empty text reasoning=${out.reasoningChars || 0} (reasoning may dominate; check reflect.model/budget)`)
    }
    parsed = parsed.slice(0, maxItems)
    // 同一 ingestPolicy 真源（shared/ingest-policy.js）：confidence 固定 1，任务句直接拒；
    // wrap.ingest.mode=review 时反思也回退候选，不绕过用户显式选择的保守档。
    const ingestPolicy = ingestPolicyOf(config?.wrap?.ingest, { confidence: 1 })
    const counts = { added: 0, review: 0, rejected: 0, duplicate: 0, failed: 0 }
    let lastFailure = ''
    try {
      for (const item of parsed) {
        const r = await backend.write({
          text: item.text, level: 'important', memory_type: item.type, source: 'self',
          tags: ['reflect'], origin: 'reflect', identity: ident,
          layer: layerOfMemoryType(item.type), ingestPolicy,
        })
        const outcome = tally(r, counts)
        if (counts.failed > 0 && outcome !== 'added' && outcome !== 'review' && outcome !== 'duplicate') lastFailure = outcome
      }
    } catch (err) {
      // 第 N 条抛错时前 N-1 条可能已落库：先把已有计数打出来，再按 write_failed 失败（keeper 可退避）。
      counts.failed += 1
      lastFailure = String(err?.message || err)
    }
    // 日志只计数，不打印任何记忆正文（架构书 §6）。
    log(`[whale-memory] reflect done material=${items.length} items=${parsed.length} added=${counts.added} review=${counts.review} rejected=${counts.rejected} duplicate=${counts.duplicate} failed=${counts.failed}`)
    // 基础设施失败不得冒充成功（铁律 22）：返回 ok:false，keeper 记 failed/退避，路由可见 error。
    if (counts.failed > 0) {
      return { ok: false, reason: 'write_failed', error: lastFailure, material: items.length, items: parsed.length, ...counts }
    }
    return { ok: true, material: items.length, items: parsed.length, ...counts }
  } catch (err) {
    log(`[whale-memory] reflect fail-open: ${err?.message || err}`)
    return { ok: false, reason: 'reflect_error' }
  }
}

/**
 * 反思调度器（S4）：job 入队（持久化）→ keeper 串行执行；或未接 keeper 时进程内直跑。
 *
 * 身份契约（架构书 §5.5.1）：
 * - `scheduleAuto` 的 payload 必须带显式身份；空闲 tick 只用 `getSessionIdentity()`（最近会话身份，
 *   含 sessionId），绝不用 Config 现取的三元组；
 * - 手动 `trigger` 由路由显式传最近会话身份，绕过峰时/日限（显式动作）但仍要求身份。
 *
 * @param {any} ctx cordis ctx（事件总线）
 * @param {{
 *   backend:any, config:any, getLlm:Function, getSelection:Function,
 *   getSessionIdentity?: () => ({ identity: object, sessionId?: string } | null),
 *   log?:Function, keeper?:any, now?:() => number,
 * }} deps
 * @returns {{ tick:() => Promise<any>, trigger:(opts?:object) => Promise<any>,
 *   scheduleAuto:(opts:{identity:object, sessionId?:string, reason?:string}) => object,
 *   dispose:() => void }}
 */
export function installReflectScheduler(ctx, {
  backend, config, getLlm, getSelection, getSessionIdentity = () => null,
  log = () => {}, keeper = null, now = () => Date.now(),
}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  let lastActivity = clock()
  let running = false
  let autoDay = ''
  let autoRuns = 0
  /** 坏窗口值只记一次（按原文签名去重；配置改了再记新值）。 */
  const warnedWindows = new Set()
  /** 空闲无会话身份只记一次：tick 每 60s 一次，逐次打印会刷屏；身份恢复后重新武装。 */
  let idleSkipLogged = false

  /** 当前执行身份只在 payload 里，不再现取 Config（S4 四点之一）。失败一律收敛为可见结果，不抛出。 */
  const run = async (payload = {}) => {
    const ident = identityOf(payload?.identity)
    if (!ident) {
      log('[whale-memory] reflect skip identity_required (job payload lacks identity)')
      return { ok: false, reason: 'identity_required' }
    }
    try {
      return await runReflect({
        backend, llm: getLlm?.(), selection: getSelection?.(), config,
        identity: ident, sessionId: String(payload?.sessionId || ''), log,
      })
    } catch (err) {
      log(`[whale-memory] reflect run fail-open: ${err?.message || err}`)
      return { ok: false, reason: 'reflect_error' }
    }
  }

  if (keeper && typeof keeper.register === 'function') {
    try {
      // 写库/队列等基础设施失败要让 keeper 走退避重试（铁律 22）：handler 抛出，job 记 failed；
      // 价值闸拒绝/无素材/无模型等终态仍按 done（重试无意义，日志已可见）。
      keeper.register('reflect', async (payload) => {
        const out = await run(payload)
        if (out?.ok === false && out.reason === 'write_failed') {
          throw new Error(`reflect_write_failed:${String(out.error || '').slice(0, 160)}`)
        }
        return out
      })
    } catch (err) {
      log(`[whale-memory] reflect handler not registered: ${err?.message || err}`)
    }
  }

  /**
   * 队列里已有 reflect（queued/running）时不再叠加。
   * 优先用 keeper.countActive（精确 SQL），不用 status() 的最近 200 行快照——写队列每条写入一行 job，
   * 反射 job 可能被挤出快照窗口而误判为空 → 重复入队（重复烧模型）。
   */
  const queueBusy = () => {
    if (keeper && typeof keeper.countActive === 'function') {
      try {
        return keeper.countActive('reflect') > 0
      } catch (err) {
        log(`[whale-memory] reflect queue count fail-open: ${err?.message || err}`)
        return true
      }
    }
    if (keeper && typeof keeper.status === 'function') {
      try {
        return keeper.status().jobs.some((job) => job.kind === 'reflect' && (job.state === 'queued' || job.state === 'running'))
      } catch (err) {
        // 状态读失败不得静默放行：按"忙"处理，避免重复入队（可见日志）。
        log(`[whale-memory] reflect queue status fail-open: ${err?.message || err}`)
        return true
      }
    }
    return running
  }

  /**
   * 单一自动闸：enabled → 队列空 → 日限 → 峰时；通过后入队（带身份 payload）或直跑。
   * @param {{ identity: object, sessionId?: string, reason?: string }} opts
   * @returns {{ ok: boolean, reason?: string, scheduled?: boolean, ran?: boolean, jobId?: number }}
   */
  const scheduleAuto = ({ identity, sessionId = '', reason = 'auto' } = {}) => {
    const ident = identityOf(identity)
    if (!ident) return { ok: false, reason: 'identity_required' }
    if (!bool(config?.reflect?.enabled, false)) return { ok: false, reason: 'disabled' }
    if (queueBusy()) return { ok: false, reason: 'queued' }
    const day = localDayKey(new Date(clock()))
    if (day !== autoDay) { autoDay = day; autoRuns = 0 }
    if (autoRuns >= num(config?.reflect?.maxRunsPerDay, 24)) return { ok: false, reason: 'daily_limit' }
    const compiled = compileSuppressWindows(value(config?.maintenance?.suppressWindows, []))
    for (const bad of compiled.invalid) {
      if (warnedWindows.has(bad)) continue
      warnedWindows.add(bad)
      log(`[whale-memory] maintenance.suppressWindows ignored invalid entry="${bad}"`)
    }
    if (inSuppressWindow(compiled.windows, new Date(clock()))) return { ok: false, reason: 'suppress_window' }

    const payload = { identity: ident, sessionId: String(sessionId || ''), reason: String(reason || 'auto') }
    const tag = String(reason || 'auto')
    if (keeper && typeof keeper.enqueue === 'function') {
      try {
        const jobId = keeper.enqueue('reflect', payload)
        autoRuns += 1
        lastActivity = clock()
        log(`[whale-memory] reflect scheduled source=${tag} job=${jobId}`)
        return { ok: true, scheduled: true, jobId }
      } catch (err) {
        log(`[whale-memory] reflect enqueue failed source=${tag}: ${err?.message || err}`)
        return { ok: false, reason: 'enqueue_failed' }
      }
    }
    running = true
    autoRuns += 1
    lastActivity = clock()
    // run 自身已收敛异常；这里再兜一层并保证 running 一定释放（否则直跑路径会永久 queued）。
    Promise.resolve(run(payload))
      .catch((err) => log(`[whale-memory] reflect direct run fail-open: ${err?.message || err}`))
      .finally(() => { running = false })
    return { ok: true, ran: true }
  }

  // 必须 waterfall 形式返回 next()：裸 listener 返回 undefined 会让 agent loop 读 decision.kind 崩
  const off = ctx.on('agent/pre-step', async (payload, next) => {
    lastActivity = clock()
    return next()
  })

  const tick = async () => {
    try {
      if (!bool(config?.reflect?.enabled, false)) return { skipped: 'disabled' }
      const idleMs = num(config?.reflect?.idleMinutes, 30) * 60_000
      if (clock() - lastActivity < idleMs) return { skipped: 'not_idle' }
      const got = typeof getSessionIdentity === 'function' ? getSessionIdentity() : null
      const ident = identityOf(got?.identity)
      if (!ident) {
        // 空闲反思没有会话分区可落：跳过并留一次可见证据，绝不写 '' 共享分区。
        if (!idleSkipLogged) {
          idleSkipLogged = true
          log('[whale-memory] reflect idle skipped: no recent session identity')
        }
        return { skipped: 'identity_required' }
      }
      idleSkipLogged = false
      return scheduleAuto({ identity: ident, sessionId: got?.sessionId || '', reason: 'idle' })
    } catch (err) {
      log(`[whale-memory] reflect scheduler fail-open: ${err?.message || err}`)
      return { skipped: 'error' }
    }
  }

  const timer = setInterval(() => { void tick() }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  const dispose = () => { clearInterval(timer); off?.() }

  /**
   * 手动触发（面板/诊断）：显式动作，绕过 enabled/峰时/日限，但仍要求身份；队列忙则 busy。
   * @param {{ identity: object, sessionId?: string, reason?: string }} [opts]
   */
  const trigger = async ({ identity, sessionId = '', reason = 'manual' } = {}) => {
    const ident = identityOf(identity)
    if (!ident) return { ok: false, reason: 'identity_required' }
    if (queueBusy()) return { ok: false, reason: 'busy' }
    const payload = { identity: ident, sessionId: String(sessionId || ''), reason }
    lastActivity = clock()
    if (keeper && typeof keeper.runNow === 'function') {
      const got = await keeper.runNow('reflect', payload)
      if (got?.skipped === 'busy') return { ok: false, reason: 'busy' }
      if (got?.deferred) return { ok: false, reason: 'deferred', deferred: got.deferred }
      if (got?.state === 'failed') return { ok: false, reason: 'reflect_error', error: got.last_error || '' }
      return got?.result && typeof got.result === 'object' ? got.result : { ok: got?.state === 'done' }
    }
    if (running) return { ok: false, reason: 'busy' }
    running = true
    try { return await run(payload) } finally { running = false }
  }

  return { tick, trigger, scheduleAuto, dispose }
}
