/**
 * 反思（S4）：把最近 episodic 提炼成 semantic/procedural 长期记忆。
 *
 * - 纯函数：buildReflectPrompt / parseReflectOutput（可脱库测试）。
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

const MAX_MATERIAL = 6000
const MAX_ITEM_CHARS = 500

export function buildReflectPrompt(items, { maxItems = 8 } = {}) {
  const body = (items || []).map((it, i) => `${i + 1}. ${String(it.text || '').slice(0, 500)}`).join('\n')
  return [
    '你是记忆整理器。把下面的经历片段提炼成可长期复用的规则/事实。',
    `最多 ${maxItems} 条；只输出 JSON 数组，每项 {"text":"...","type":"semantic|procedural"}。`,
    '要求：只复述素材里出现的事实；不要编造、不要写解释、不要超过 500 字；没有可提炼的就输出 []。',
    '',
    body,
  ].join('\n').slice(0, MAX_MATERIAL)
}

export function parseReflectOutput(raw) {
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let arr
  try { arr = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({
      text: x.text.trim().slice(0, MAX_ITEM_CHARS),
      type: x.type === 'procedural' ? 'procedural' : 'semantic',
    }))
}

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
 * 反思写入计数：added=落库/合并，review=候选，rejected=价值闸/身份闸拒绝。
 * @param {{ ok?: boolean, action?: string, candidate?: boolean }} res backend.write 结果
 */
function tally(res, counts) {
  if (res?.ok === false) counts.rejected += 1
  else if (res?.candidate === true || res?.action === 'CANDIDATE') counts.review += 1
  else if (res?.ok === true) counts.added += 1
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
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm_unavailable' }
    if (!selection?.provider || (!selection?.model && !config?.reflect?.model)) return { ok: false, reason: 'no_model' }
    if (memoryPressure().stress) return { ok: false, reason: 'memory_pressure' }
    const items = await backend.listEpisodic(20, { identity: ident })
    if (!items || items.length === 0) return { ok: true, added: 0, review: 0, rejected: 0, material: 0, items: 0, reason: 'no_material' }
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
    const counts = { added: 0, review: 0, rejected: 0 }
    for (const item of parsed) {
      const r = await backend.write({
        text: item.text, level: 'important', memory_type: item.type, source: 'self',
        tags: ['reflect'], origin: 'reflect', identity: ident,
        layer: layerOfMemoryType(item.type), ingestPolicy,
      })
      tally(r, counts)
    }
    // 日志只计数，不打印任何记忆正文（架构书 §6）。
    log(`[whale-memory] reflect done material=${items.length} items=${parsed.length} added=${counts.added} review=${counts.review} rejected=${counts.rejected}`)
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

  /** 当前执行身份只在 payload 里，不再现取 Config（S4 四点之一）。 */
  const run = (payload = {}) => {
    const ident = identityOf(payload?.identity)
    if (!ident) {
      log('[whale-memory] reflect skip identity_required (job payload lacks identity)')
      return Promise.resolve({ ok: false, reason: 'identity_required' })
    }
    return runReflect({
      backend, llm: getLlm?.(), selection: getSelection?.(), config,
      identity: ident, sessionId: String(payload?.sessionId || ''), log,
    })
  }

  if (keeper && typeof keeper.register === 'function') {
    try { keeper.register('reflect', (payload) => run(payload)) } catch (err) {
      log(`[whale-memory] reflect handler not registered: ${err?.message || err}`)
    }
  }

  /** 队列里已有 reflect（queued/running）时不再叠加，防压力期堆一堆重复 job。 */
  const queueBusy = () => {
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
    void run(payload).finally(() => { running = false })
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
        log('[whale-memory] reflect idle skipped: no recent session identity')
        return { skipped: 'identity_required' }
      }
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
