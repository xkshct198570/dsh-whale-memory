/**
 * 反思（S4）：把最近 episodic 提炼成 semantic/procedural 规则。
 *
 * - 纯函数：buildReflectPrompt / parseReflectOutput（可脱库测试）。
 * - runReflect：读近期 episodic → DSH 默认模型（ctx.llm.stream）→ 解析 JSON → 落库（source=self）。
 * - 调度：installReflectScheduler 在空闲 ≥idleMinutes 时跑，OOM/忙时跳过；手动可触发。
 */
import { num } from '../shared/config-values.js'
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
 * @param {{ backend:any, llm:any, selection:any, config:any,
 *   identity?:{userId:string,roleId:string,workspace:string}, log?:Function }} deps
 *   identity 缺省为空三元组（只处理共享分区）；调度器必须传当前分区，不能把
 *   别人的 episodic 喂给模型再把结果写回共享分区。
 */
export async function runReflect({ backend, llm, selection, config, identity = null, log = () => {} }) {
  try {
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm_unavailable' }
    if (!selection?.provider || (!selection?.model && !config?.reflect?.model)) return { ok: false, reason: 'no_model' }
    if (memoryPressure().stress) return { ok: false, reason: 'memory_pressure' }
    const ident = identity && typeof identity === 'object'
      ? { userId: String(identity.userId || ''), roleId: String(identity.roleId || ''), workspace: String(identity.workspace || '') }
      : { userId: '', roleId: '', workspace: '' }
    const items = await backend.listEpisodic(20, { identity: ident })
    if (!items || items.length === 0) return { ok: true, added: 0, reason: 'no_material' }
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
    let added = 0
    for (const item of parsed) {
      const r = await backend.write({
        text: item.text, level: 'important', memory_type: item.type, source: 'self',
        tags: ['reflect'], origin: 'reflect', identity: ident,
      })
      if (r?.ok && !r.duplicate) added += 1
    }
    log(`[whale-memory] reflect done material=${items.length} items=${parsed.length} added=${added} textLen=${out.text.length} reasoning=${out.reasoningChars || 0}`)
    return { ok: true, added, material: items.length, items: parsed.length }
  } catch (err) {
    log(`[whale-memory] reflect fail-open: ${err?.message || err}`)
    return { ok: false, reason: 'reflect_error' }
  }
}

/**
 * 空闲调度：pre-step 刷新 lastActivity；每 60s 检查一次，空闲 ≥idleMinutes 才跑。
 * 反 OOM：RSS/可用内存告急、已有 run 进行中 → 跳过。
 *
 * 接入 keeper 后（生产路径），反思与巩固/向量共用「全局并发 1」：这里只负责
 * 「何时该反思」→ 入队；真正执行由 keeper 的 reflect handler 串行跑（OOM 盲区之四）。
 * 未传 keeper 时保留原来的直跑路径（单测/诊断用）。
 */
export function installReflectScheduler(ctx, {
  backend, config, getLlm, getSelection, getIdentity, log = () => {}, keeper = null,
}) {
  let lastActivity = Date.now()
  let running = false
  let lastRunDay = ''
  let runsToday = 0
  /** 当前分区身份：调度器在每次执行时现取（进程内 userId/role 可能随登录/角色切换变化）。 */
  const identityNow = () => {
    try {
      const got = typeof getIdentity === 'function' ? getIdentity() : null
      if (got && got.ok === false) return null
      const ident = got?.identity || got
      if (!ident || typeof ident !== 'object') return null
      return { userId: String(ident.userId || ''), roleId: String(ident.roleId || ''), workspace: String(ident.workspace || '') }
    } catch { return null }
  }
  const run = () => {
    const identity = identityNow()
    if (!identity) return Promise.resolve({ ok: false, reason: 'identity_required' })
    return runReflect({ backend, llm: getLlm?.(), selection: getSelection?.(), config, identity, log })
  }

  if (keeper && typeof keeper.register === 'function') {
    try { keeper.register('reflect', () => run()) } catch (err) {
      log(`[whale-memory] reflect handler not registered: ${err?.message || err}`)
    }
  }

  /** 队列里已有 reflect（queued/running）时不再叠加，防压力期堆一堆重复 job。 */
  const queuedReflect = () => {
    if (!keeper || typeof keeper.status !== 'function') return running
    return keeper.status().jobs.some((job) => job.kind === 'reflect' && (job.state === 'queued' || job.state === 'running'))
  }

  // 必须 waterfall 形式返回 next()：裸 listener 返回 undefined 会让 agent loop 读 decision.kind 崩
  const off = ctx.on('agent/pre-step', async (payload, next) => {
    lastActivity = Date.now()
    return next()
  })

  const tick = async () => {
    try {
      if (!config?.reflect?.enabled) return
      const idleMs = num(config?.reflect?.idleMinutes, 30) * 60_000
      if (Date.now() - lastActivity < idleMs) return
      const day = new Date().toISOString().slice(0, 10)
      if (day !== lastRunDay) { lastRunDay = day; runsToday = 0 }
      if (runsToday >= num(config?.reflect?.maxRunsPerDay, 24)) return
      if (queuedReflect()) return
      if (keeper && typeof keeper.enqueue === 'function') {
        runsToday += 1
        lastActivity = Date.now()
        keeper.enqueue('reflect', {})
        return
      }
      running = true; runsToday += 1; lastActivity = Date.now()
      await run()
    } catch (err) {
      log(`[whale-memory] reflect scheduler fail-open: ${err?.message || err}`)
    } finally { running = false }
  }

  const timer = setInterval(() => { void tick() }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  const dispose = () => { clearInterval(timer); off?.() }

  const trigger = async () => {
    if (keeper && typeof keeper.runNow === 'function') {
      if (queuedReflect()) return { ok: false, reason: 'busy' }
      const got = await keeper.runNow('reflect', {})
      if (got?.skipped === 'busy') return { ok: false, reason: 'busy' }
      if (got?.deferred) return { ok: false, reason: 'deferred', deferred: got.deferred }
      if (got?.state === 'failed') return { ok: false, reason: 'reflect_error', error: got.last_error || '' }
      return got?.result && typeof got.result === 'object' ? got.result : { ok: got?.state === 'done' }
    }
    if (running) return { ok: false, reason: 'busy' }
    running = true
    try { return await run() } finally { running = false }
  }

  return { tick, dispose, trigger }
}
