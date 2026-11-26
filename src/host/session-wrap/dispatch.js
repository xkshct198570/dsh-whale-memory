/**
 * Session Wrap 的分流阶段：普通记忆（走 ingest 闸）/ 规则提案 / 待办不落长期记忆。
 *
 * 拆分（P2c）：本文件只做“蒸馏条目→落库/提案”，不调模型、不出报告；
 * 失败分“可重试（write_failed:）”与“终态跳过”，续跑按 item.status 幂等。
 * 依赖方向：host → shared + core/wrap-runs + 同目录 ingest；不 import 门面。
 */
import { bool } from '../../shared/config-values.js'
import { updateRun } from '../../core/wrap-runs.js'
import { ingestItem, runPatchOf } from './ingest.js'

/** 单条记忆写入的来源标记：候选按 origin=session-wrap 过滤/回查。 */
export const WRAP_ORIGIN = 'session-wrap'
export const KINDS_WRITTEN = new Set(['lesson', 'decision', 'preference', 'fact'])

export const LEVEL_OF_KIND = Object.freeze({
  lesson: 'important', decision: 'important', preference: 'normal', fact: 'normal', rule: 'important',
})
export const TYPE_OF_KIND = Object.freeze({
  lesson: 'procedural', decision: 'semantic', preference: 'semantic', fact: 'semantic', rule: 'procedural',
})

/**
 * 执行分流阶段。
 * @param {{
 *   items:any[], distilled:any, spool:any, runId:number, config:any, backend:any, ingest:object,
 *   withDb:Function, createProposal:Function, log?:Function,
 * }} deps
 * @returns {Promise<{items:any[], failures:any[]}>}
 */
export async function dispatchPhase({
  items, distilled, spool, runId, config, backend, ingest,
  withDb, createProposal, log = () => {},
}) {
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
      const written = await ingestItem({
        backend,
        item,
        identity: spool.identity,
        runId,
        ingest,
        origin: WRAP_ORIGIN,
        // wrap 自产记忆写 source='self'：owner 属保护面，会让后续相似写入永远只能审核（B14）。
        source: 'self',
        level: LEVEL_OF_KIND[item.kind] || 'normal',
        memoryType: TYPE_OF_KIND[item.kind] || 'semantic',
        tags: ['session-wrap', ...(Array.isArray(item.tags) ? item.tags : [])].slice(0, 8),
      })
      list[i] = {
        ...item,
        status: written.status,
        nodeId: written.nodeId || '',
        action: String(written.action || ''),
        ...(written.status.startsWith('write_failed:')
          ? { failure: written.reason || written.status.slice('write_failed:'.length) }
          : {}),
      }
      if (written.status.startsWith('write_failed:')) {
        const code = written.status.slice('write_failed:'.length)
        failures.push({ index: i, reason: `write_failed:${code}` })
      }
    }
    withDb((db) => updateRun(db, runId, { ...runPatchOf(distilled, list), phase: 'written' }))
  }
  return { items: list, failures }
}
