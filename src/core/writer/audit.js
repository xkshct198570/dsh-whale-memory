// 职责：writes/evolution 审计记录与事务/唯一冲突工具；依赖：../db.js + ../relations.js + ./decide.js；不 import 门面。
import { now } from '../db.js'
import { normalizeTags } from '../relations.js'
import {
  finite, mapSource, normalizeIdentity, validExpiredAt, validLayer, validLevel, validMemoryType,
} from './decide.js'

/**
 * 写审计行（writes）。每个决策结果都要留痕，面板/复盘靠它。
 *
 * payload（v2）保存影子候选的决策载荷：审核 accept 时据此还原字段并按 shadowOf 执行，
 * 避免"候选是 SUPERSEDE/MERGE，接受后却按 ADD 落库"的载荷丢失。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ traceId?: string, identity?: object, mode?: string, level?: string, memory_type?: string,
 *   tags?: string[], source?: string, origin?: string, expired_at?: number }} event 原始事件
 * @param {{ action: string, reason?: string, nodeId?: string|null, beforeText?: string|null,
 *   afterText?: string|null, mode?: string, level?: string, memory_type?: string, tags?: string[],
 *   source?: string, shadowOf?: string, targetId?: string|null }} decision
 * @returns {number} 新 writes 行 id
 */
/**
 * writes.payload 的唯一构造（v2 列）：来源/字段快照；影子候选审核时还承载 shadowOf/targetId。
 *
 * 为什么抽成导出函数：影子候选与工具改写的审计行必须同形；两处各拼一次 JSON 迟早字段漂移
 * （漏 origin/shadowOf 会让 `json_extract(payload,'$.origin')` 的查询静默漏行）。
 *
 * @param {{ level?: unknown, memory_type?: unknown, tags?: unknown, source?: unknown, origin?: unknown,
 *   expired_at?: unknown, shadowOf?: unknown, targetId?: unknown, layer?: unknown }} [fields]
 * @returns {{ level: string, memory_type: string, tags: string[], source: string, origin: string,
 *   expired_at: number|null, shadowOf: string|null, targetId: string|null, layer: string|null }}
 */
export function writePayload(fields = {}) {
  return {
    level: validLevel(fields?.level),
    memory_type: validMemoryType(fields?.memory_type),
    tags: normalizeTags(fields?.tags),
    source: mapSource(fields?.source),
    origin: String(fields?.origin ?? ''),
    expired_at: validExpiredAt(fields?.expired_at),
    shadowOf: fields?.shadowOf ? String(fields.shadowOf) : null,
    targetId: fields?.targetId ? String(fields.targetId) : null,
    // v7：影子候选 accept 要还原分层；不存这里，候选转正就会静默丢 layer。
    layer: validLayer(fields?.layer),
  }
}

export function recordWrite(db, event, decision) {
  const ident = normalizeIdentity(event?.identity)
  const payload = writePayload({
    level: decision?.level ?? event?.level,
    memory_type: decision?.memory_type ?? event?.memory_type,
    tags: decision?.tags ?? event?.tags,
    source: decision?.source ?? event?.source,
    origin: event?.origin,
    expired_at: event?.expired_at,
    shadowOf: decision?.shadowOf,
    targetId: decision?.targetId,
    layer: decision?.layer ?? event?.layer,
  })
  const info = db.prepare(`INSERT INTO writes
    (ts,trace_id,action,node_id,reason,before_text,after_text,mode,payload,user_id,role_id,workspace)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    now(),
    String(event?.traceId ?? ''),
    String(decision?.action ?? ''),
    decision?.nodeId ? String(decision.nodeId) : null,
    String(decision?.reason ?? ''),
    decision?.beforeText === undefined || decision?.beforeText === null ? null : String(decision.beforeText),
    decision?.afterText === undefined || decision?.afterText === null ? null : String(decision.afterText),
    String(decision?.mode ?? event?.mode ?? 'shadow'),
    JSON.stringify(payload),
    ident.userId,
    ident.roleId,
    ident.workspace,
  )
  return Number(info.lastInsertRowid)
}

/**
 * 演化留痕（evolution 的唯一 INSERT 入口）。
 *
 * 为什么收敛成一处：「所有改动留痕」（架构书 §7.2）意味着 supersede 迁移、面板人工编辑、
 * 邻居注记都要落同一张表；散在各处的 INSERT 迟早漏字段（旧代码只有 relations.js 一处，
 * supersede 与人工 updateNode 都没留痕）。from_id=发起方/被改节点，to_id=被改节点。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ts?: number, fromId?: string, toId?: string, field?: string,
 *   oldValue?: unknown, newValue?: unknown, traceId?: string }} row
 * @returns {number} 新 evolution 行 id
 */
export function recordEvolution(db, row = {}) {
  const text = (v) => (v === null || v === undefined ? null : String(v).slice(0, 500))
  const info = db.prepare(`INSERT INTO evolution (ts,from_id,to_id,field,old_value,new_value,trace_id)
    VALUES (?,?,?,?,?,?,?)`).run(
    finite(row.ts, now()),
    String(row.fromId ?? ''),
    String(row.toId ?? ''),
    String(row.field ?? ''),
    text(row.oldValue),
    text(row.newValue),
    String(row.traceId ?? '').slice(0, 64),
  )
  return Number(info.lastInsertRowid) || 0
}

/** SQLite 的“已在事务里”错误文案（不同版本措辞一致，仅大小写/前缀差异）。 */
const NESTED_TX_RE = /cannot start a transaction within a transaction/i
/** 唯一索引冲突（v4 活跃同文唯一；也覆盖主键/边唯一）。 */
const UNIQUE_VIOLATION_RE = /UNIQUE constraint failed/i

/** v4 唯一索引冲突判定：只在“活跃同文”这一路当作重复，不吞别的约束错误。 */
export function isActiveHashConflict(err) {
  const message = String(err?.message || err)
  return UNIQUE_VIOLATION_RE.test(message) && /nodes\.text_hash|idx_nodes_active_hash/i.test(message)
}

/**
 * 事务包装：调用方已开事务时不重复 BEGIN；**只有**“已在事务里”这一种失败算嵌套。
 * 其它 BEGIN 失败（锁冲突/只读库/磁盘错误）必须原样抛出——过去一律当嵌套，
 * 会让半写随外层 COMMIT、或退化成无事务多语句（审计 P1-4）。
 */
export function withTx(db, fn) {
  let begun = false
  try {
    db.exec('BEGIN IMMEDIATE')
    begun = true
  } catch (err) {
    if (!NESTED_TX_RE.test(String(err?.message || err))) throw err
    begun = false
  }
  try {
    const out = fn()
    if (begun) db.exec('COMMIT')
    return out
  } catch (err) {
    if (begun) { try { db.exec('ROLLBACK') } catch { /* 回滚失败不遮蔽原始错误 */ } }
    throw err
  }
}
