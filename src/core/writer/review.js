// 职责：影子候选 accept 落库（按 payload.shadowOf 还原并执行同构动作）；依赖：../db.js + ../tokenize.js + ../relations.js + ./decide.js + ./audit.js + ./process.js；不 import 门面，无公开导出。
import { now } from '../db.js'
import { bigrams, contentHash, normalize } from '../tokenize.js'
import { linkMutex, linkSupersede, normalizeTags } from '../relations.js'
import {
  isProtectedTarget, mapSource, sourceRank, validExpiredAt, validLevel, validMemoryType,
} from './decide.js'
import { isActiveHashConflict, recordEvolution, recordWrite } from './audit.js'
import { insertNodeRow, validAtOf } from './process.js'

/**
 * 影子候选落库（review accept 的唯一执行器）：按 payload.shadowOf 执行与 auto 模式同构的动作。
 *
 * 为什么必须还原载荷：只拿 after_text 硬编码落 ADD 会把 SUPERSEDE/MERGE 候选变成新事实，
 * 既丢双时态（expired_at）也丢关系边（supersede/mutex）。载荷缺失的旧候选回落 ADD。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row writes 行（含 after_text/trace_id/user_id/role_id/workspace）
 * @param {string} text normalize 后的正文
 * @param {object} payload recordWrite 存入的决策载荷
 * @param {string} shadowOf ADD/MERGE/SUPERSEDE/REVIEW
 * @param {number} writeId writes 行 id
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export function acceptCandidate(db, row, text, payload, shadowOf, writeId) {
  const ts = now()
  const ident = {
    userId: String(row.user_id ?? ''),
    roleId: String(row.role_id ?? ''),
    workspace: String(row.workspace ?? ''),
  }
  const targetId = payload?.targetId ? String(payload.targetId) : ''
  const event = { identity: ident, traceId: String(row.trace_id ?? ''), tags: normalizeTags(payload?.tags) }
  // 审核落库必须保留候选原始来源：把 origin 一律改写成 shadow-review 会抹掉
  // session-wrap / 搜索反哺等来源，候选接受后无法再回查是哪次 run 产生的。
  const landedOrigin = String(payload?.origin || '').trim() || 'shadow-review'
  const insert = () => insertNodeRow(db, event, text, {
    ts,
    validAt: validAtOf({ ...event, referenceTime: payload?.referenceTime }, ts),
    source: mapSource(payload?.source),
    origin: landedOrigin,
    level: validLevel(payload?.level),
    memoryType: validMemoryType(payload?.memory_type),
    expiredAt: validExpiredAt(payload?.expired_at),
  })

  const identOf = () => ({
    userId: String(row.user_id ?? ''), roleId: String(row.role_id ?? ''), workspace: String(row.workspace ?? ''),
  })
  const findActiveDuplicate = () => {
    const id = identOf()
    return db.prepare(`SELECT id FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=?
      AND status='active' LIMIT 1`).get(contentHash(text), id.userId, id.roleId, id.workspace) || null
  }

  if (shadowOf === 'MERGE') {
    const ident = identOf()
    // 身份三列 + status='active'：审核只能改“本分区仍然有效”的目标，跨分区/已失效一律拒绝。
    const target = targetId ? db.prepare(`SELECT id,source,level,memory_type,text FROM nodes
      WHERE id=? AND user_id=? AND role_id=? AND workspace=? AND status='active'`).get(
      targetId, ident.userId, ident.roleId, ident.workspace) : null
    if (!target) return { ok: false, error: 'target_not_active' }
    // 决策时目标不受保护、审核时已被标记保护：accept 必须拒绝，不能绕过保护面。
    if (isProtectedTarget(target, { protect: true })) return { ok: false, error: 'protected_target' }
    const incoming = mapSource(payload?.source)
    const source = sourceRank(incoming) > sourceRank(target.source) ? incoming : target.source
    const expiredAt = validExpiredAt(payload?.expired_at)
    try {
      if (expiredAt !== null) {
        db.prepare(`UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, source=?, expired_at=?, updated_at=?
          WHERE id=? AND status='active'`).run(text, contentHash(text), bigrams(text), source, expiredAt, ts, targetId)
      } else {
        db.prepare(`UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, source=?, updated_at=?
          WHERE id=? AND status='active'`).run(text, contentHash(text), bigrams(text), source, ts, targetId)
      }
    } catch (err) {
      if (isActiveHashConflict(err)) return { ok: false, error: 'duplicate_active' }
      throw err
    }
    // 审核通过也是"一次改动"：正文被影子候选替换要留痕（§7.2），否则 accept 成了审计盲区。
    if (String(target.text ?? '') !== text) {
      recordEvolution(db, {
        ts, fromId: targetId, toId: targetId, field: 'text',
        oldValue: target.text ?? '', newValue: text, traceId: row.trace_id,
      })
    }
    db.prepare("UPDATE writes SET action='MERGE', node_id=? WHERE id=?").run(targetId, writeId)
    return { ok: true, id: targetId }
  }

  if (shadowOf === 'SUPERSEDE') {
    const ident = identOf()
    const target = targetId ? db.prepare(`SELECT id,status,text FROM nodes
      WHERE id=? AND user_id=? AND role_id=? AND workspace=? AND status='active'`).get(
      targetId, ident.userId, ident.roleId, ident.workspace) : null
    if (!target) return { ok: false, error: 'target_not_active' }
    let newId
    try {
      newId = insert()
    } catch (err) {
      if (!isActiveHashConflict(err)) throw err
      const dup = findActiveDuplicate()
      if (!dup) throw err
      newId = String(dup.id)
    }
    // 影子候选 accept 后的取代同样要让旧规则退顶（与 auto 路径一致）；同文竞态不自我取代。
    if (newId !== targetId) {
      db.prepare(`UPDATE nodes SET status='superseded', pinned=0, invalid_at=?, expired_at=?, superseded_by=?, updated_at=?
        WHERE id=? AND status='active'`).run(ts, ts, newId, ts, targetId)
    }
    if (newId !== targetId) {
      linkSupersede(db, targetId, newId)
      // 影子候选 accept 后的取代与 auto 模式同构：状态迁移 + 正文替换都要留痕。
      recordEvolution(db, {
        ts, fromId: targetId, toId: newId, field: 'status',
        oldValue: target.status ?? 'active', newValue: 'superseded', traceId: row.trace_id,
      })
      if (String(target.text ?? '') !== text) {
        recordEvolution(db, {
          ts, fromId: targetId, toId: newId, field: 'text',
          oldValue: target.text ?? '', newValue: text, traceId: row.trace_id,
        })
      }
    }
    const landedSupersede = newId === targetId ? 'NOOP' : 'SUPERSEDE'
    db.prepare('UPDATE writes SET action=?, node_id=? WHERE id=?').run(landedSupersede, newId, writeId)
    return { ok: true, id: newId, ...(newId === targetId ? { duplicate: true } : {}) }
  }

  // ADD / REVIEW（旧候选 payload 缺失也走这里：等价 ADD）
  let newId
  let duplicate = false
  try {
    newId = insert()
  } catch (err) {
    if (!isActiveHashConflict(err)) throw err
    const dup = findActiveDuplicate()
    if (!dup) throw err
    newId = String(dup.id)
    duplicate = true
  }
  if (shadowOf === 'REVIEW' && targetId && newId !== targetId
    && db.prepare('SELECT 1 FROM nodes WHERE id=?').get(targetId)) {
    linkMutex(db, targetId, newId)
  }
  const landed = duplicate ? 'NOOP' : shadowOf === 'REVIEW' ? 'REVIEW' : 'ADD'
  db.prepare('UPDATE writes SET action=?, node_id=? WHERE id=?').run(landed, newId, writeId)
  return { ok: true, id: newId, ...(duplicate ? { duplicate: true } : {}) }
}
