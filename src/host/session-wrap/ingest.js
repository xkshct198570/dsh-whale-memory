/**
 * Session Wrap 的写入闸应用层：把蒸馏/整合条目交给 backend.write（带 ingestPolicy），
 * 并把写入结果映射成可续跑的 item 状态与 run 计数。
 *
 * 拆分（S1）：判据在 shared/ingest-policy.js（纯）与 core/writer/process.js（唯一闸）；
 * 本文件只做“传参 + 状态映射 + 计数”，不复制分类/判重/落库判据。
 * 依赖方向：host → shared + core/wrap-runs；不 import 门面。
 */

/** 与 Config 缺省一致；host 必须显式传入实时配置，不在本文件读全局。 */
export const INGEST_DEFAULTS = Object.freeze({
  mode: 'auto',
  minConfidence: 0.55,
  dropTaskInstructions: true,
})

/** 写入前就失败、重试也不会变的错误码：直接终态跳过（与 0.7.x dispatch 口径一致）。 */
const PERMANENT_ERRORS = new Set([
  'write_disabled', 'privacy', 'text_too_long', 'invalid_text', 'invalid_level',
  'invalid_memory_type', 'invalid_tags',
])

/**
 * item 状态计数（唯一投影）：新状态 ingested/review/noop/skipped；兼容旧 run 的
 * written+candidate（按 candidate 标志归 review）与 proposal/open_loop。
 *
 * @param {Array<object>} items
 * @returns {{ candidates:number, ingested:number, reviewed:number, skipped:number,
 *   rule_proposals:number, open_loops:number }}
 */
export function countsOf(items) {
  const out = {
    candidates: 0, ingested: 0, reviewed: 0, skipped: 0, rule_proposals: 0, open_loops: 0,
  }
  for (const item of Array.isArray(items) ? items : []) {
    const status = String(item?.status || 'pending')
    if (status === 'ingested') out.ingested += 1
    else if (status === 'review') out.reviewed += 1
    else if (status === 'written') {
      if (item?.candidate) out.reviewed += 1
      else out.ingested += 1
    } else if (status.startsWith('skipped:')) out.skipped += 1
    else if (status === 'proposal') out.rule_proposals += 1
    else if (status === 'open_loop') out.open_loops += 1
  }
  // candidates 列＝待审候选数（旧面板/旧 run 兼容口径）。
  out.candidates = out.reviewed
  return out
}

/**
 * 动作计数（日志口径，不含正文）：added/merged/superseded/noop/rejected。
 * 只从 item.action 读；被闸拒绝但 action 已标注 REJECT 的条目计入 rejected。
 * @param {Array<object>} items
 */
export function actionsOf(items) {
  const out = { added: 0, merged: 0, superseded: 0, noop: 0, rejected: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    const action = String(item?.action || '')
    if (action === 'ADD') out.added += 1
    else if (action === 'MERGE') out.merged += 1
    else if (action === 'SUPERSEDE') out.superseded += 1
    else if (action === 'NOOP') out.noop += 1
    else if (action === 'REJECT') out.rejected += 1
  }
  return out
}

/**
 * run 行更新补丁：计数只落 distilled_json.counts + 既有三列，避免 updateRun 白名单静默丢字段。
 * @param {object} distilled
 * @param {Array<object>} items
 */
export function runPatchOf(distilled, items) {
  const counts = countsOf(items)
  return {
    // counts 只存契约三键（§5.4）；candidates/rule_proposals/open_loops 仍落 run 列。
    distilled_json: {
      ...(distilled && typeof distilled === 'object' ? distilled : {}),
      items,
      counts: { ingested: counts.ingested, reviewed: counts.reviewed, skipped: counts.skipped },
    },
    candidates: counts.candidates,
    rule_proposals: counts.rule_proposals,
    open_loops: counts.open_loops,
  }
}

/** backend.write 结果 → item 状态（终态可续跑幂等）。 */
function statusOf(res) {
  if (!res || res.ok === false) {
    const code = String(res?.error || 'write_failed').slice(0, 80)
    if (String(res?.action || '') === 'REJECT') return { status: `skipped:${code}`, action: 'REJECT' }
    if (PERMANENT_ERRORS.has(code)) return { status: `skipped:${code}`, action: 'REJECT' }
    return { status: `write_failed:${code}`, action: 'FAILED' }
  }
  const action = String(res.action || '')
  if (action === 'CANDIDATE') return { status: 'review', nodeId: '', action }
  if (action === 'REJECT') {
    return { status: `skipped:${String(res.reason || 'rejected').slice(0, 80)}`, action }
  }
  if (action === 'NOOP') return { status: 'noop', nodeId: res.id ? String(res.id) : '', action }
  return { status: 'ingested', nodeId: res.id ? String(res.id) : '', action }
}

/**
 * 落一条普通记忆：唯一入口（dispatch 与 reconcile 共用），一律带 ingestPolicy。
 *
 * @param {{
 *   backend:any, item:object, identity:object, runId:number,
 *   ingest:object, origin:string, level:string, memoryType:string,
 *   source?:string, tags:string[],
 * }} deps
 * @returns {Promise<{status:string, nodeId?:string, action:string, reason?:string}>}
 */
export async function ingestItem({
  backend, item, identity, runId, ingest, origin, level, memoryType,
  source = 'self', tags = [],
}) {
  const cfg = { ...INGEST_DEFAULTS, ...(ingest && typeof ingest === 'object' ? ingest : {}) }
  try {
    const res = await backend.write({
      text: String(item?.text || ''),
      level,
      memory_type: memoryType,
      source,
      tags,
      origin,
      traceId: `wrap:${runId}`,
      identity,
      ingestPolicy: {
        mode: cfg.mode,
        minConfidence: cfg.minConfidence,
        dropTaskInstructions: cfg.dropTaskInstructions,
        confidence: item?.confidence,
      },
    })
    return statusOf(res)
  } catch (err) {
    return { status: 'write_failed:exception', action: 'FAILED', reason: String(err?.message || err).slice(0, 120) }
  }
}
