/**
 * Session Wrap 的分流阶段：记忆候选（写库/强制 shadow）、规则提案、待办不落长期记忆。
 *
 * 拆分（P2c）：本文件只做“蒸馏条目→落库/提案”，不调模型、不出报告；
 * 失败分“可重试（write_failed:）”与“终态跳过”，续跑按 item.status 幂等。
 * 依赖方向：host → shared + core/wrap-runs；不 import 门面。
 */
import { bool } from '../../shared/config-values.js'
import { updateRun } from '../../core/wrap-runs.js'

/** 单条记忆写入的来源标记：候选按 origin=session-wrap 过滤/回查。 */
export const WRAP_ORIGIN = 'session-wrap'
export const KINDS_WRITTEN = new Set(['lesson', 'decision', 'preference', 'fact'])

export const LEVEL_OF_KIND = Object.freeze({
  lesson: 'important', decision: 'important', preference: 'normal', fact: 'normal', rule: 'important',
})
export const TYPE_OF_KIND = Object.freeze({
  lesson: 'procedural', decision: 'semantic', preference: 'semantic', fact: 'semantic', rule: 'procedural',
})

/** 候选状态计数：从 distilled items 现算，重试/续跑不会把计数越加越多。 */
export function countsOf(items) {
  const out = { candidates: 0, rule_proposals: 0, open_loops: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item?.status || 'pending')
    if (status === 'written') out.candidates += 1
    else if (status === 'proposal') out.rule_proposals += 1
    else if (status === 'open_loop') out.open_loops += 1
  }
  return out
}

/**
 * 执行分流阶段。
 * @param {{
 *   items:any[], distilled:any, spool:any, runId:number, config:any, backend:any, autoAccept:boolean,
 *   withDb:Function, createProposal:Function, log?:Function,
 * }} deps
 * @returns {Promise<{items:any[], failures:any[]}>}
 */
export async function dispatchPhase({ items, distilled, spool, runId, config, backend, autoAccept, withDb, createProposal, log = () => {} }) {
  const writeEnabled = bool(config?.write?.enabled, true)
  const rulesEnabled = bool(config?.rules?.enabled, true)
  const failures = []
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    const status = String(item.status || 'pending')
    // 写失败是可重试状态：进入本轮重新尝试；其余终态直接跳过（续跑幂等）。
    const retryable = status.startsWith('write_failed:')
    if (status !== 'pending' && !retryable) continue
    if (!KINDS_WRITTEN.has(item.kind) && item.kind !== 'rule' && item.kind !== 'open_loop') {
      list[i] = { ...item, status: 'skipped:unknown_kind' }
    } else if (item.kind === 'open_loop') {
      list[i] = { ...item, status: 'open_loop' }
    } else if (item.kind === 'rule') {
      if (!rulesEnabled) {
        list[i] = { ...item, status: 'skipped:rules_disabled' }
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
          list[i] = proposal?.ok
            ? { ...item, status: 'proposal', proposalId: String(proposal.proposal?.id || ''), cooling: Boolean(proposal.cooling) }
            : { ...item, status: `proposal_rejected:${String(proposal?.code || 'unknown').slice(0, 80)}` }
        } catch (err) {
          failures.push({ index: i, reason: `proposal_error:${String(err?.message || err).slice(0, 120)}` })
          list[i] = { ...item, status: 'write_failed:proposal_error' }
        }
      }
    } else if (!writeEnabled) {
      list[i] = { ...item, status: 'skipped:write_disabled' }
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
          list[i] = {
            ...item,
            status: 'written',
            nodeId: res.id ? String(res.id) : '',
            action: String(res.action || ''),
            candidate: Boolean(res.candidate),
          }
        } else {
          const code = String(res?.error || 'write_failed')
          const permanent = ['write_disabled', 'privacy', 'text_too_long', 'invalid_text', 'invalid_level', 'invalid_memory_type', 'invalid_tags'].includes(code)
          list[i] = permanent
            ? { ...item, status: `skipped:${code}` }
            : { ...item, status: `write_failed:${code}` }
          if (!permanent) failures.push({ index: i, reason: `write_failed:${code}` })
        }
      } catch (err) {
        list[i] = { ...item, status: 'write_failed:exception' }
        failures.push({ index: i, reason: `write_exception:${String(err?.message || err).slice(0, 120)}` })
      }
    }
    const counts = countsOf(list)
    withDb((db) => updateRun(db, runId, { distilled_json: { ...distilled, items: list }, ...counts, phase: 'written' }))
  }
  return { items: list, failures }
}
