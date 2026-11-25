// 职责：事件落库（节点插入/配置归一/processEvent 编排）；依赖：../../shared/config-values.js + ../db.js + ../tokenize.js + ../relations.js + ./decide.js + ./audit.js；不 import 门面。
import { value } from '../../shared/config-values.js'
import { now } from '../db.js'
import { bigrams, contentHash, normalize } from '../tokenize.js'
import { linkMutex, linkSupersede, normalizeTags } from '../relations.js'
import {
  TEXT_LIMIT, decideWrite, finite, mapSource, normalizeIdentity, validExpiredAt,
  validLevel, validMemoryType,
} from './decide.js'
import { isActiveHashConflict, recordEvolution, recordWrite, withTx } from './audit.js'

/**
 * 插一个 active 节点（内部用）：字段全填，双时态 valid_at 置为本次决策时间。
 * @returns {string} 节点 id
 */
/**
 * 事实生效时间（Graphiti: reference_time 与系统时间分离）。
 *
 * `valid_at` 表示"这条事实何时为真"：调用方可传事件时间（消息时间/历史日志时间）；
 * 缺省才回落到本次系统时间。`created_at` 永远是系统时间，不参与这里。
 * 只接受有限正数，且不允许未来时间（未来时间会让"现在"过滤误判过期）。
 * @param {{ referenceTime?: unknown } | null | undefined} event
 * @param {number} ts 系统时间（秒）
 * @returns {number}
 */
export function validAtOf(event, ts) {
  const raw = event?.referenceTime
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 && n <= ts ? n : ts
}

export function insertNodeRow(db, event, text, { ts, validAt, source, origin, level, memoryType, expiredAt }) {
  const ident = normalizeIdentity(event?.identity)
  const hash = contentHash(text)
  // v3：规则置顶随事件下传；只有显式 1/true 才算置顶（导入/旧调用方默认 0）。
  const pinned = event?.pinned === 1 || event?.pinned === true ? 1 : 0
  // id 由"毫秒时间 + hash 前 10 位"组成；同文本写进不同身份/分区可能落在同一毫秒，
  // 此时仅靠 hash 会撞主键。保持 id 形状不变（既有契约/面板正则），冲突时把毫秒数 +1 找空位。
  let at = Date.now()
  let id = `n${at}_${hash.slice(0, 10)}`
  while (db.prepare('SELECT 1 FROM nodes WHERE id=?').get(id)) {
    at += 1
    id = `n${at}_${hash.slice(0, 10)}`
  }
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,hits,vector_state,origin,trace_id,valid_at,expired_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,1,?,0,'none',?,?,?,?,?,?)`).run(
    id, text, hash, bigrams(text), level, memoryType, source,
    ident.roleId, ident.userId, ident.workspace,
    JSON.stringify(normalizeTags(event?.tags)), '', pinned,
    origin, String(event?.traceId ?? ''),
    validAt, expiredAt, ts, ts,
  )
  return id
}

/**
 * 配置 → 决策参数（兼容完整 config、write 段、以及扁平的 mode 别名）。
 *
 * 注意：真实 Config 的 write 段字段都是 schemastery Ref，必须先 value() 再比较；
 * 否则 `w.reviewMode === 'auto'` 恒 false（auto 静默退化成 shadow）、`finite(Ref)` 恒 NaN
 * （maxChars/dailyCap 恒回默认值）。
 *
 * 隐私开关（审计 P0-1 假开关）：真源是 Config 的 `privacy.redact`（面板「设置·隐私」那一栏
 * 真正落在 schema 的 privacy 组；`write.redact` 在 schema 里不存在，只被旧单测当扁平写法用）。
 * 因此先读 `privacy.redact`，缺失才回落 `write.redact`——保留直连 write 段的旧调用方。
 *
 * @param {object|((() => object))|null|undefined} config
 * @returns {{ mode: 'shadow'|'auto', maxChars: number, dailyCap: number, protect: boolean, redact: boolean }}
 */
function resolveConfig(config) {
  const c = value(config)
  const root = c && typeof c === 'object' ? c : {}
  const section = value(root.write)
  const w = section && typeof section === 'object' ? section : root
  const privacySection = value(root.privacy)
  const privacy = privacySection && typeof privacySection === 'object' ? privacySection : null
  const redact = privacy && privacy.redact !== undefined
    ? value(privacy.redact) !== false
    : value(w.redact) !== false
  return {
    mode: value(w.reviewMode ?? w.mode) === 'auto' ? 'auto' : 'shadow',
    maxChars: finite(value(w.maxChars), TEXT_LIMIT),
    dailyCap: finite(value(w.dailyCap), 200),
    protect: value(w.protect) !== false,
    redact,
    ignorePatterns: Array.isArray(w.ignorePatterns)
      ? w.ignorePatterns.map((item) => String(item ?? '').trim()).filter(Boolean)
      : [],
  }
}

/**
 * 处理一个事件：决策 → 落库/落审计 → 返回结果。
 *
 * 落库动作（架构书 §6.2/§7.3）：
 * - ADD：插新节点（active），valid_at=本次时间。
 * - MERGE：改目标节点的 text/text_hash/text_bigrams/updated_at，不新增节点；同 origin 复写或
 *   相似合并时若事件带 expired_at 则同时续期。来源升级（source_upgrade）只改 source/updated_at。
 * - SUPERSEDE：插新节点；旧节点 status='superseded'、invalid_at/expired_at=本次时间、superseded_by=新 id；
 *   并写 supersede 边。
 * - REVIEW：插新节点 + mutex 边（同词不同义，永不扩散）。
 * - NOOP：目标 hits+1、last_hit_at=本次时间。
 * - CANDIDATE：不进 nodes，只写 writes（影子审核队列）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} event 事件（见 decideWrite）
 * @param {object} [config] 完整配置或 write 段（reviewMode/maxChars/dailyCap/protect/redact）
 * @returns {{ ok: boolean, id?: string, action: string, reason: string }}
 */
export function processEvent(db, event, config = {}) {
  const options = resolveConfig(config)
  // 调用方（仅 backend.write 的内部参数）可以对**单条**事件强制 shadow：
  // Session Wrap 要求即使全局 reviewMode=auto，候选也必须先经审核，且不能靠临时改全局配置
  // （并发写入会一起被降级）。这是保守方向，不构成提权面。
  if (event?.__forceShadow === true) options.mode = 'shadow'
  const decision = decideWrite(db, event, options)
  const ts = now()
  const text = normalize(String(decision.afterText ?? event?.text ?? ''))
  const ident = normalizeIdentity(event?.identity)
  const hash = contentHash(text)
  /** v4 唯一索引竞态时找"已经落地的同文活跃行"：找到就按重复处理，绝不让队列永久重试。 */
  const findDup = () => db.prepare(
    "SELECT id,text,source FROM nodes WHERE text_hash=? AND user_id=? AND role_id=? AND workspace=? AND status='active' LIMIT 1",
  ).get(hash, ident.userId, ident.roleId, ident.workspace)
  const touchDup = (id) => {
    db.prepare('UPDATE nodes SET hits=hits+1, last_hit_at=? WHERE id=?').run(ts, id)
  }
  let action = String(decision.action || 'REJECT')
  let nodeId = null
  /** 竞态下“取代目标==已落地同文行”：必须归 NOOP，不能谎报 SUPERSEDE（审计 A5）。 */
  let selfDuplicate = false

  if (action === 'REJECT') {
    recordWrite(db, event, { ...decision, nodeId: null })
    return { ok: false, action, reason: String(decision.reason ?? ''), ...(decision.judge ? { judge: decision.judge } : {}) }
  }

  const targetId = decision.targetId ? String(decision.targetId) : ''

  if (action === 'NOOP') {
    if (!targetId) throw new Error('noop_target_missing')
    withTx(db, () => {
      db.prepare('UPDATE nodes SET hits=hits+1, last_hit_at=? WHERE id=?').run(ts, targetId)
    })
    nodeId = targetId
  } else if (action === 'MERGE') {
    if (!targetId) throw new Error('merge_target_missing')
    if (decision.sourceUpgrade) {
      // 同文来源升级：只改 source/updated_at，正文与双时态保持不变。
      const upgraded = mapSource(decision.source ?? event?.source)
      withTx(db, () => {
        db.prepare('UPDATE nodes SET source=?, updated_at=? WHERE id=?').run(upgraded, ts, targetId)
      })
    } else {
      // 同 origin/相似 MERGE：更新正文；事件带 TTL 时同时续期（搜索反哺每天刷新同一查询的摘要）。
      const expiredAt = validExpiredAt(event?.expired_at)
      try {
        withTx(db, () => {
          if (expiredAt !== null) {
            db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, expired_at=?, updated_at=? WHERE id=?')
              .run(text, contentHash(text), bigrams(text), expiredAt, ts, targetId)
          } else {
            db.prepare('UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, updated_at=? WHERE id=?')
              .run(text, contentHash(text), bigrams(text), ts, targetId)
          }
        })
      } catch (err) {
        // 竞态：合并后的正文已被另一活跃行占用 → 退回 NOOP（目标不动，记一次命中）。
        if (!isActiveHashConflict(err)) throw err
        const dup = findDup()
        if (!dup) throw err
        touchDup(dup.id)
        action = 'NOOP'
        nodeId = String(dup.id)
        recordWrite(db, event, { ...decision, action, nodeId })
        return { ok: true, id: nodeId, action, reason: 'duplicate' }
      }
    }
    nodeId = targetId
  } else if (action === 'ADD') {
    try {
      nodeId = withTx(db, () => insertNodeRow(db, event, text, {
        ts,
        validAt: validAtOf(event, ts),
        source: mapSource(event?.source),
        origin: String(event?.origin ?? ''),
        level: validLevel(event?.level),
        memoryType: validMemoryType(event?.memory_type),
        expiredAt: validExpiredAt(event?.expired_at),
      }))
    } catch (err) {
      if (!isActiveHashConflict(err)) throw err
      const dup = findDup()
      if (!dup) throw err
      touchDup(dup.id)
      action = 'NOOP'
      nodeId = String(dup.id)
      recordWrite(db, event, { ...decision, action, nodeId })
      return { ok: true, id: nodeId, action, reason: 'duplicate' }
    }
  } else if (action === 'SUPERSEDE' || action === 'REVIEW') {
    if (!targetId) throw new Error(`${action.toLowerCase()}_target_missing`)
    const requested = action
    nodeId = withTx(db, () => {
      let newId
      try {
        newId = insertNodeRow(db, event, text, {
          ts,
          validAt: validAtOf(event, ts),
          source: mapSource(event?.source),
          origin: String(event?.origin ?? ''),
          level: validLevel(event?.level),
          memoryType: validMemoryType(event?.memory_type),
          expiredAt: validExpiredAt(event?.expired_at),
        })
      } catch (err) {
        // 竞态：同文已活跃 → 不插重复行；SUPERSEDE 仍要把旧目标指向既有行，REVIEW 仍建互斥边。
        if (!isActiveHashConflict(err)) throw err
        const dup = findDup()
        if (!dup) throw err
        newId = String(dup.id)
      }
      if (requested === 'SUPERSEDE' && newId !== targetId) {
        // 旧值必须在 UPDATE 之前读：evolution 的 old_value 是"改之前"，不能拿新行反推。
        const before = db.prepare('SELECT status, text FROM nodes WHERE id=?').get(targetId) || {}
        // v3：规则退役必须同时取消置顶——superseded 的规则若 pinned 还留着，注入层会继续带它。
        db.prepare(`UPDATE nodes SET status='superseded', pinned=0, invalid_at=?, expired_at=?, superseded_by=?, updated_at=?
          WHERE id=? AND status='active'`).run(ts, ts, newId, ts, targetId)
        linkSupersede(db, targetId, newId)
        // 所有改动留痕（§7.2）：状态迁移一条；正文被新事实替换时再补一条 text。
        recordEvolution(db, {
          ts, fromId: targetId, toId: newId, field: 'status',
          oldValue: before.status ?? 'active', newValue: 'superseded', traceId: event?.traceId,
        })
        if (String(before.text ?? '') !== text) {
          recordEvolution(db, {
            ts, fromId: targetId, toId: newId, field: 'text',
            oldValue: before.text ?? '', newValue: text, traceId: event?.traceId,
          })
        }
      } else if (requested === 'REVIEW' && newId !== targetId) {
        linkMutex(db, targetId, newId)
      }
      if (requested === 'SUPERSEDE' && newId === targetId) selfDuplicate = true
      return newId
    })
  } else if (action === 'CANDIDATE') {
    // 影子审核：nodes 一行不写，审计行保留 after_text 供 review 落库
    nodeId = null
  } else {
    throw new Error(`unknown_action:${action}`)
  }
  if (selfDuplicate) action = 'NOOP'
  const finalReason = selfDuplicate ? 'duplicate' : decision.reason
  recordWrite(db, event, { ...decision, action, reason: finalReason, nodeId })
  return {
    ok: true,
    ...(selfDuplicate ? { duplicate: true } : {}),
    id: nodeId ?? undefined,
    action,
    reason: String(finalReason ?? ''),
    ...(decision.judge ? { judge: decision.judge } : {}),
  }
}
