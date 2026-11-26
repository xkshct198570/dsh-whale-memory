/**
 * Session Wrap 的“整合”（Reconcile）阶段：邻居检索 → 一次模型调用 → 决策校验 → 影子落地。
 *
 * 拆分（S3）：core 侧只做提示词/解析/硬判据（src/core/reconcile.js）；本文件做 I/O 与落库编排。
 * 依赖方向：host → core/{reconcile,search,writer,wrap-runs} + 同目录 dispatch 常量；不 import 门面。
 *
 * 安全口径：默认 `wrap.reconcile.enabled=false`（走 0.6.10 原路）；开启后也只产影子候选/审计，
 * 不直接改 active 记忆；ARCHIVE 候选 accept 时仍受保护面与身份闸约束。
 */
import { buildReconcilePrompt, parseReconcileOutput, validateDecisions } from '../../core/reconcile.js'
import { search } from '../../core/search.js'
import { updateRun } from '../../core/wrap-runs.js'
import { recordWrite } from '../../core/writer.js'
import { ingestItem, runPatchOf } from './ingest.js'
import { collectModelText } from './distill.js'
import { KINDS_WRITTEN, LEVEL_OF_KIND, TYPE_OF_KIND, WRAP_ORIGIN } from './dispatch.js'

const DEFAULTS = Object.freeze({ topK: 5, maxNeighborChars: 200 })

/**
 * 取每条候选的邻居（同身份 FTS topK；截断到 maxNeighborChars）。
 * @returns {Array<{id:string,itemIndex:number,text:string,level:string,status:string,updated_at:number}>}
 */
export function collectNeighbors({ withDb, identity, items, topK = DEFAULTS.topK, maxNeighborChars = DEFAULTS.maxNeighborChars }) {
  const out = []
  const limit = Math.max(1, Math.min(10, Number(topK) || DEFAULTS.topK))
  const cap = Math.max(40, Math.min(500, Number(maxNeighborChars) || DEFAULTS.maxNeighborChars))
  const list = Array.isArray(items) ? items : []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (!KINDS_WRITTEN.has(String(item?.kind || ''))) continue
    let hits = []
    try {
      hits = withDb((db) => search(db, {
        query: String(item?.text || ""), identity, limit, minRel: 0,
      }).hits || [])
    } catch { hits = [] }
    for (const hit of hits) {
      if (!hit || !hit.id) continue
      out.push({
        id: String(hit.id),
        itemIndex: index,
        text: String(hit.text || '').slice(0, cap),
        level: String(hit.level || ''),
        status: String(hit.status || 'active'),
        updated_at: Number(hit.updated_at || 0),
      })
    }
  }
  return out
}

/**
 * 执行整合：无候选/无邻居时跳过（不白烧模型）；模型失败/坏 JSON 返回失败，由调用方标 run=failed。
 *
 * @param {{
 *   runId:number, distilled:any, spool:any, cfg:any, withDb:Function,
 *   getLlm?:Function, getSelection?:Function, log?:Function,
 * }} deps
 * @returns {Promise<{ok:boolean, skipped?:string, reason?:string, decisions?:Array<object>,
 *   rejected?:Array<object>, neighbors?:Array<object>}>}
 */
export async function reconcilePhase({ runId, distilled, spool, cfg, withDb, getLlm, getSelection, log = () => {} }) {
  const items = Array.isArray(distilled?.items) ? distilled.items : []
  const pending = items.filter((item) => KINDS_WRITTEN.has(String(item?.kind || '')))
  if (pending.length === 0) return { ok: true, skipped: 'no_candidates', decisions: [], rejected: [] }

  const identity = spool?.identity || {}
  const neighbors = collectNeighbors({
    withDb, identity: { userId: identity.userId || '', roleId: identity.roleId || '', workspace: identity.workspace || '' },
    items, topK: cfg?.topK, maxNeighborChars: cfg?.maxNeighborChars,
  })
  if (neighbors.length === 0) {
    // 无邻居=全部 ADD，无需模型：省一次调用，行为可解释。
    const decisions = pending.map((item) => ({
      item: items.indexOf(item), op: 'ADD', targetId: '', afterText: String(item.text || '').slice(0, 200),
      reason: 'no_neighbor', evidence: '',
    }))
    return { ok: true, skipped: 'no_neighbors', decisions, rejected: [], neighbors }
  }

  const llm = (() => { try { return getLlm?.() } catch { return null } })()
  const selection = (() => { try { return getSelection?.() } catch { return null } })()
  if (!llm || typeof llm.stream !== 'function') return { ok: true, skipped: 'no_model', decisions: [], rejected: [], neighbors }

  const prompt = buildReconcilePrompt(items, neighbors)
  const got = await collectModelText(llm, selection, prompt, {
    modelOverride: cfg?.model, providerOverride: cfg?.provider, timeoutMs: cfg?.timeoutMs,
  })
  if (!got.ok) {
    log(`[whale-memory] wrap run=${runId} reconcile model failed reason=${got.reason} neighbors=${neighbors.length}`)
    return { ok: false, reason: String(got.reason || 'model_error'), neighbors }
  }
  const parsed = parseReconcileOutput(got.text)
  if (!parsed.ok) {
    log(`[whale-memory] wrap run=${runId} reconcile bad_json textLen=${got.text.length} reasoning=${got.reasoningChars || 0}`)
    return { ok: false, reason: `bad_json:${parsed.error || 'parse'}`, neighbors }
  }
  const { valid, rejected } = validateDecisions(parsed.decisions, { items, neighbors })
  // 同一候选多条有效决策只认第一条（其余进 rejected，报告可见）。
  const seen = new Set()
  const decisions = []
  for (const decision of valid) {
    if (seen.has(decision.item)) { rejected.push({ decision, error: 'multiple_ops' }); continue }
    seen.add(decision.item)
    decisions.push(decision)
  }
  const checkpoint = { decisions, rejected, neighbors: neighbors.length, at: Date.now() / 1000 }
  withDb((db) => updateRun(db, runId, {
    phase: 'reconciled',
    distilled_json: { ...distilled, reconcile: checkpoint },
  }))
  log(`[whale-memory] wrap run=${runId} reconcile ok decisions=${decisions.length} rejected=${rejected.length} neighbors=${neighbors.length}`)
  return { ok: true, decisions, rejected, neighbors }
}

/**
 * 把整合决策落成记忆/审核候选（与 dispatch 共用唯一 ingest 闸）。
 *
 * 只处理“会写长期记忆”的 kind；rule/open_loop 仍交给 dispatchPhase（本函数不动它们的状态）。
 * - ADD/MERGE/SUPERSEDE：走 ingestPolicy（不再按 autoAccept 提权/降级）；
 * - NOOP：只记审计；ARCHIVE：仍产 CANDIDATE（人工审核后才改状态）。
 *
 * @returns {Promise<{items:Array<object>, failures:Array<object>, applied:Array<object>}>}
 */
export async function applyReconcile({
  items, distilled, spool, runId, decisions, rejected = [], config, backend, ingest,
  withDb, log = () => {},
}) {
  const list = Array.isArray(items) ? items : []
  const failures = []
  const applied = []
  const byItem = new Map()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!byItem.has(decision.item)) byItem.set(decision.item, decision)
  }
  const traceId = `wrap:${runId}`
  const identity = spool?.identity || {}
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    const kind = String(item?.kind || '')
    if (!KINDS_WRITTEN.has(kind)) continue
    // S4：已被并进前一条的候选不再各自落库（否则 3 同主题仍会有 3 条候选）。
    if (String(item?.status || '').startsWith('merged_into:')) continue
    const decision = byItem.get(i) || {
      item: i, op: 'ADD', targetId: '', afterText: String(item.text || '').slice(0, 200), reason: 'no_decision', evidence: '',
    }
    const text = String(decision.afterText || item.text || '')
    // S4：模型可给 level/memoryType/tags 校正（已过 core 白名单），未给则沿用 kind 映射。
    const tags = Array.isArray(decision.tags) && decision.tags.length > 0
      ? ['session-wrap', 'reconcile', ...decision.tags]
      : ['session-wrap', 'reconcile', ...(Array.isArray(item.tags) ? item.tags : [])]
    const level = String(decision.level || LEVEL_OF_KIND[kind] || 'normal')
    const memoryType = String(decision.memoryType || TYPE_OF_KIND[kind] || 'semantic')
    const audit = {
      level, memory_type: memoryType, tags: tags.slice(0, 8), origin: WRAP_ORIGIN, source: 'self',
    }
    try {
      if (decision.op === 'NOOP') {
        withDb((db) => recordWrite(db, { identity, traceId }, {
          action: 'NOOP', reason: `reconcile_noop:${decision.reason || ''}`.slice(0, 160),
          nodeId: decision.targetId || null, afterText: text, mode: 'shadow',
          ...audit, targetId: decision.targetId || null,
        }))
        list[i] = { ...item, status: 'noop', reconcile: { op: 'NOOP', targetId: decision.targetId || '' } }
      } else if (decision.op === 'ARCHIVE') {
        withDb((db) => recordWrite(db, { identity, traceId }, {
          action: 'CANDIDATE', reason: `reconcile_archive:${decision.reason || ''}`.slice(0, 160),
          nodeId: null, afterText: '', mode: 'shadow',
          ...audit, shadowOf: 'ARCHIVE', targetId: decision.targetId,
        }))
        list[i] = {
          ...item, status: 'review', nodeId: '', action: 'CANDIDATE',
          reconcile: { op: 'ARCHIVE', targetId: decision.targetId },
        }
      } else {
        const written = await ingestItem({
          backend, item: { ...item, text }, identity, runId, ingest,
          origin: WRAP_ORIGIN, source: 'self', level, memoryType, tags: tags.slice(0, 8),
        })
        list[i] = {
          ...item, status: written.status, nodeId: written.nodeId || '',
          action: String(written.action || ''),
          reconcile: { op: decision.op, targetId: decision.targetId || '' },
        }
        if (written.status.startsWith('write_failed:')) {
          const code = written.status.slice('write_failed:'.length)
          list[i].failure = written.reason || code
          failures.push({ index: i, reason: `write_failed:${code}` })
        }
      }
      // S4 跨候选合并：被合并的条目置 merged_into，不再各自落一条副本（断言节点数）。
      for (const merged of Array.isArray(decision.mergeItems) ? decision.mergeItems : []) {
        if (!Number.isInteger(merged) || merged === i || !list[merged]) continue
        list[merged] = { ...list[merged], status: `merged_into:${i}` }
      }
      applied.push({ index: i, op: decision.op, targetId: decision.targetId || '', mergeItems: decision.mergeItems || [] })
    } catch (err) {
      list[i] = { ...item, status: 'write_failed:exception', failure: String(err?.message || err).slice(0, 120) }
      failures.push({ index: i, reason: `write_exception:${String(err?.message || err).slice(0, 120)}` })
    }
    withDb((db) => updateRun(db, runId, runPatchOf(distilled, list)))
  }
  if (failures.length) log(`[whale-memory] wrap run=${runId} reconcile apply failures=${failures.length}`)
  return { items: list, failures, applied, rejected }
}
