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

/** 模型输出收集：只收文本增量/文本块；超时由 AbortController 真正中断适配器请求。 */
export async function collectModelText(llm, selection, prompt, { modelOverride = '', timeoutMs = 60_000 } = {}) {
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
    modelOverride: cfg.model, timeoutMs: cfg.timeoutMs,
  })
  if (!got.ok) {
    if (got.reason === 'no_model') {
      finalize(runId, 'skipped', { error: 'no_model' })
      return { skipped: 'no_model' }
    }
    finalize(runId, 'failed', { error: String(got.reason).slice(0, 200) })
    throw new Error(got.reason)
  }
  const parsed = parseDistillOutput(got.text)
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
