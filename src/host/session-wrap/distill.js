/**
 * Session Wrap 的蒸馏阶段：模型调用 → 解析 → 证据校验 → 写断点。
 *
 * 拆分（P2c）：本文件只做“材料→结构化条目”，不写候选/提案、不出报告；
 * 断点落在 wrap_runs.distilled_json，重试从已完成条目继续，不重复调模型。
 * 依赖方向：host → core/distill + core/wrap-runs；不 import 门面。
 */
import { buildDistillPrompt, clampSummary, parseDistillOutput, validateDistillItems } from '../../core/distill.js'
import { updateRun } from '../../core/wrap-runs.js'

/** 模型输出上限（字符）：超过只截断解析，不把异常大文本写进库。 */
export const MODEL_OUTPUT_MAX = 100_000

/**
 * 蒸馏请求的输出预算。真机证据（2026-11-26）：
 * - gui-ji V4.1-Flash：reasoning 8.5k–9.4k 字符，4096/8192 都会截断正文（textLen 0–2.5k）；
 * - deepseek-account/deepseek-flash：reasoning 12.7k–17.3k 字符 + 正文 4.1k–4.7k，8192 仍被截断。
 * 收尾是低频动作（自动默认关），32768 让“思考+JSON”一次装下；超出仍会截断并在日志给提示。
 */
export const DISTILL_MAX_TOKENS = 32768

/** 首次解析失败后的重试提示：只追加约束，不改素材与判据。 */
export function distillRetryPrompt(prompt) {
  return `${prompt}\n\n上一次输出无法解析为 JSON。这次只输出一个 JSON 对象：不要代码围栏、不要解释、不要思考过程，第一个字符必须是 {。`
}

/**
 * 模型输出收集：只收文本增量/文本块；超时由 AbortController 真正中断适配器请求。
 * `reasoningChars` 只用于诊断（推理模型把预算烧在思考上时，文本为空而思考非空）。
 */
export async function collectModelText(llm, selection, prompt, {
  modelOverride = '', providerOverride = '', timeoutMs = 60_000, maxTokens = DISTILL_MAX_TOKENS,
} = {}) {
  const provider = String(providerOverride || selection?.provider || '')
  const model = String(modelOverride || selection?.model || '')
  if (!provider || !model) return { ok: false, reason: 'no_model' }
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* noop */ } }, Math.max(1000, Number(timeoutMs) || 60_000))
  if (typeof timer.unref === 'function') timer.unref()
  // 适配器会同时发 text-delta（增量）与 block-end（整块文本）：两者相加会把 JSON 拼两遍，
  // parse 时「首个 { 到末个 }」跨两段 → 坏 JSON（真机 01:59：正文 2804 字符≈1.4k 的两倍）。
  // 口径：有增量用增量，只有整块（无增量）才用整块。
  let streamed = ''
  let blocked = ''
  let reasoningChars = 0
  try {
    const iterable = llm.stream({
      provider, model, temperature: 0.2, maxTokens, signal: ac.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of iterable) {
      if (streamed.length + blocked.length >= MODEL_OUTPUT_MAX) break
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') streamed += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blocked += String(chunk.block.text || '')
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
    }
    const text = streamed || blocked
    return { ok: true, text: text.slice(0, MODEL_OUTPUT_MAX), reasoningChars }
  } catch (err) {
    // AbortError 在不同适配器里形状不同：以 signal 为判据，不靠 message 字符串。
    const reason = ac.signal?.aborted ? 'model_timeout' : `model_error:${String(err?.message || err).slice(0, 160)}`
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 执行蒸馏阶段（含断点续跑）。
 * @param {{
 *   runId:number, run:any, spool:any, spoolPath:string, cfg:any, withDb:Function,
 *   getLlm:Function, getSelection:Function, finalize:Function, log?:Function,
 * }} deps
 * @returns {Promise<{distilled?:any, skipped?:string, dropped?:number}>}
 */
export async function distillPhase({ runId, run, spool, spoolPath, cfg, withDb, getLlm, getSelection, finalize, log = () => {} }) {
  let distilled = run.distilled && Array.isArray(run.distilled.items) ? run.distilled : null
  if (distilled) return { distilled }

  const llm = (() => { try { return getLlm?.() } catch { return null } })()
  const selection = (() => { try { return getSelection?.() } catch { return null } })()
  if (!llm || typeof llm.stream !== 'function') {
    finalize(runId, 'skipped', { error: 'no_model' })
    return { skipped: 'no_model' }
  }
  const prompt = buildDistillPrompt(
    { turns: spool.material.turns },
    { maxItems: cfg.maxItems, maxChars: cfg.maxMaterialChars },
  )
  const got = await collectModelText(llm, selection, prompt, {
    modelOverride: cfg.model, providerOverride: cfg.provider, timeoutMs: cfg.timeoutMs,
  })
  if (!got.ok) {
    if (got.reason === 'no_model') {
      finalize(runId, 'skipped', { error: 'no_model' })
      return { skipped: 'no_model' }
    }
    finalize(runId, 'failed', { error: String(got.reason).slice(0, 200) })
    throw new Error(got.reason)
  }
  let parsed = parseDistillOutput(got.text)
  if (!parsed.ok) {
    // 失败可见：只记模型/长度/推理字数，不记输出正文（报告与日志无原文是硬约束）。
    log(`[whale-memory] wrap run=${runId} distill bad_json attempt=1 model=${String(cfg.provider || selection?.provider || '-')}/${String(cfg.model || selection?.model || '-')} textLen=${got.text.length} reasoning=${got.reasoningChars || 0}${(got.reasoningChars || 0) > got.text.length ? ' (reasoning dominates: 建议 wrap.provider/model 换非推理模型)' : ''}`)
    const retry = await collectModelText(llm, selection, distillRetryPrompt(prompt), {
      modelOverride: cfg.model, providerOverride: cfg.provider, timeoutMs: cfg.timeoutMs,
    })
    if (retry.ok) {
      parsed = parseDistillOutput(retry.text)
      if (!parsed.ok) {
        log(`[whale-memory] wrap run=${runId} distill bad_json attempt=2 textLen=${retry.text.length} reasoning=${retry.reasoningChars || 0}`)
      }
    } else {
      log(`[whale-memory] wrap run=${runId} distill retry failed reason=${retry.reason}`)
    }
  }
  if (!parsed.ok) {
    finalize(runId, 'failed', { error: `bad_json:${parsed.error || 'parse'}` })
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
    finalize(runId, 'skipped', { error: 'no_items', phase: 'distilled' }, { deleteSpool: true, spoolPath })
    log(`[whale-memory] wrap run=${runId} skipped no_items dropped=${distilled.dropped.length}`)
    return { skipped: 'no_items', dropped: distilled.dropped.length }
  }
  return { distilled }
}
