/**
 * 反思（S4）：把最近 episodic 提炼成 semantic/procedural 规则。
 *
 * - 纯函数：buildReflectPrompt / parseReflectOutput（可脱库测试）。
 * - runReflect：读近期 episodic → DSH 默认模型（ctx.llm.stream）→ 解析 JSON → 落库（source=self）。
 * - 调度：installReflectScheduler 在空闲 ≥idleMinutes 时跑，OOM/忙时跳过；手动可触发。
 */
import { num } from '../host/config-values.js'
import { memoryPressure } from '../host/memory-guard.js'

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

async function collectLlmText(llm, selection, prompt, modelOverride) {
  const provider = selection?.provider
  const model = modelOverride || selection?.model
  if (!provider || !model) return { ok: false, reason: 'no_model' }
  let text = ''
  for await (const chunk of llm.stream({
    provider, model, temperature: 0.2, maxTokens: 1200,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text += String(chunk.block.text || '')
  }
  return { ok: true, text }
}

/**
 * @param {{ backend:any, llm:any, selection:any, config:any, log?:Function }} deps
 */
export async function runReflect({ backend, llm, selection, config, log = () => {} }) {
  try {
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm_unavailable' }
    if (!selection?.provider || (!selection?.model && !config?.reflect?.model)) return { ok: false, reason: 'no_model' }
    if (memoryPressure().stress) return { ok: false, reason: 'memory_pressure' }
    const items = await backend.listEpisodic(20)
    if (!items || items.length === 0) return { ok: true, added: 0, reason: 'no_material' }
    const maxItems = num(config?.reflect?.maxItems, 8)
    const prompt = buildReflectPrompt(items, { maxItems })
    const out = await collectLlmText(llm, selection, prompt, config?.reflect?.model || '')
    if (!out.ok) return { ok: false, reason: out.reason }
    const parsed = parseReflectOutput(out.text).slice(0, maxItems)
    let added = 0
    for (const item of parsed) {
      const r = await backend.write({
        text: item.text, level: 'important', memory_type: item.type, source: 'self',
        tags: ['reflect'], origin: 'reflect', identity: { userId: '', roleId: '', workspace: '' },
      })
      if (r?.ok && !r.duplicate) added += 1
    }
    log(`[whale-memory] reflect done material=${items.length} items=${parsed.length} added=${added}`)
    return { ok: true, added, material: items.length, items: parsed.length }
  } catch (err) {
    log(`[whale-memory] reflect fail-open: ${err?.message || err}`)
    return { ok: false, reason: 'reflect_error' }
  }
}

/**
 * 空闲调度：pre-step 刷新 lastActivity；每 60s 检查一次，空闲 ≥idleMinutes 才跑。
 * 反 OOM：RSS >600MB 或已有 run 进行中 → 跳过。
 */
export function installReflectScheduler(ctx, { backend, config, getLlm, getSelection, log = () => {} }) {
  let lastActivity = Date.now()
  let running = false
  let lastRunDay = ''
  let runsToday = 0
  // 必须 waterfall 形式返回 next()：裸 listener 返回 undefined 会让 agent loop 读 decision.kind 崩
  const off = ctx.on('agent/pre-step', async (payload, next) => {
    lastActivity = Date.now()
    return next()
  })

  const tick = async () => {
    try {
      if (running || !config?.reflect?.enabled) return
      const idleMs = num(config?.reflect?.idleMinutes, 30) * 60_000
      if (Date.now() - lastActivity < idleMs) return
      const day = new Date().toISOString().slice(0, 10)
      if (day !== lastRunDay) { lastRunDay = day; runsToday = 0 }
      if (runsToday >= num(config?.reflect?.maxRunsPerDay, 24)) return
      running = true; runsToday += 1; lastActivity = Date.now()
      await runReflect({ backend, llm: getLlm?.(), selection: getSelection?.(), config, log })
    } catch (err) {
      log(`[whale-memory] reflect scheduler fail-open: ${err?.message || err}`)
    } finally { running = false }
  }

  const timer = setInterval(() => { void tick() }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  const dispose = () => { clearInterval(timer); off?.() }
  return { tick, dispose, trigger: async () => { if (running) return { ok: false, reason: 'busy' }; running = true; try { return await runReflect({ backend, llm: getLlm?.(), selection: getSelection?.(), config, log }) } finally { running = false } } }
}
