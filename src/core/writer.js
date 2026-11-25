/**
 * 记忆写入编排（writer）：审计 + 处理 + 评审 + 写队列（纯判定 + 显式 DB 事务）。
 *
 * privacy/decide 底座已拆到 `writer/`；本文件保留 audit / process / review / queue 四段，
 * 待 P3d3/P3d4 继续拆分。
 *
 * 边界：
 * - 只依赖 node 内置与本域纯工具；不碰路由/模型编排（LLM 只经注入的 getLlm）。
 * - 写事务/回滚/重试是"数据不丢不乱"的唯一判据，必须能脱宿主单测。
 */
import { value } from '../shared/config-values.js'
import { now } from './db.js'
import { bigrams, contentHash, normalize } from './tokenize.js'
import { linkMutex, linkSupersede, normalizeTags } from './relations.js'
import { buildJudgePrompt, mapCandidates, parseJudgeOutput } from './judge.js'
import { privacyCheck } from './writer/privacy.js'
import {
  slotsOf, contradiction, timeOverlap, findCandidates, decideWrite,
  sourceRank, finite, normalizeIdentity, isProtectedTarget,
  mapSource, validLevel, validMemoryType, validExpiredAt, TEXT_LIMIT,
} from './writer/decide.js'

// 子模块公开符号原样再导出：门面路径与导出名保持不变，调用方无需改动。
export {
  privacyCheck,
  slotsOf, contradiction, timeOverlap, findCandidates, decideWrite,
}

/** 每批任务数（写连接上保持短事务，避免长阻塞）。 */
const BATCH = 20
/** 写 job 自身重试上限与退避（与 keeper 的 1m→5m→30m 同口径；写队列是唯一 owner）。 */
const WRITE_MAX_ATTEMPTS = 4
const WRITE_BACKOFF_SECONDS = [0, 60, 300, 1800]
/** 写队列只负责自己的 queued/到期重试，30s 扫一次足够，不抢 keeper 的 10min 语义。 */
const WRITE_RETRY_TICK_MS = 30_000
/** 判定器候选上限：只问最新的 N 条（提示词体积/token 成本的硬闸门，候选再多也只截最新）。 */
const JUDGE_CANDIDATE_LIMIT = 12
/** 判定器模型硬超时：单条超 2s 即回落规则，不拖住整批写入。 */
const JUDGE_TIMEOUT_MS = 2000


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
export function recordWrite(db, event, decision) {
  const ident = normalizeIdentity(event?.identity)
  const payload = {
    level: validLevel(decision?.level ?? event?.level),
    memory_type: validMemoryType(decision?.memory_type ?? event?.memory_type),
    tags: normalizeTags(decision?.tags ?? event?.tags),
    source: mapSource(decision?.source ?? event?.source),
    origin: String(event?.origin ?? ''),
    expired_at: validExpiredAt(event?.expired_at),
    shadowOf: decision?.shadowOf ? String(decision.shadowOf) : null,
    targetId: decision?.targetId ? String(decision.targetId) : null,
  }
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
function validAtOf(event, ts) {
  const raw = event?.referenceTime
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 && n <= ts ? n : ts
}

function insertNodeRow(db, event, text, { ts, validAt, source, origin, level, memoryType, expiredAt }) {
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
function acceptCandidate(db, row, text, payload, shadowOf, writeId) {
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

/**
 * 判定器模型调用：照 reflect.js 的 stream 收集口径（text-delta/block-end），
 * 外加 2s AbortController 硬超时（模型卡住不能拖住整批写入）。
 *
 * 非导出：只有队列用；测试通过 fake llm 端到端覆盖（见 writer.test.mjs）。
 *
 * @param {{ stream: Function }} llm
 * @param {{ provider?: string, model?: string } | null} selection
 * @param {string} prompt
 * @param {string} modelOverride write.model（非空即覆盖默认模型）
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
function collectJudgeText(llm, selection, prompt, modelOverride) {
  const provider = selection?.provider
  const model = modelOverride || selection?.model
  if (!provider || !model) return Promise.resolve({ ok: false, error: 'no_model' })
  return new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    const finish = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    const timer = setTimeout(() => {
      try { controller.abort() } catch { /* 已结束的 stream 再 abort 无害 */ }
      finish({ ok: false, error: 'timeout' })
    }, JUDGE_TIMEOUT_MS)
    void (async () => {
      let text = ''
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          temperature: 0,
          maxTokens: 200,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text += String(chunk.block.text || '')
        }
        finish({ ok: true, text })
      } catch {
        finish({ ok: false, error: 'llm_error' })
      }
    })()
  })
}

/**
 * 持久化写入队列（铁律 3：进程重启后不丢事件）。
 *
 * 为什么用 jobs 表而不是内存数组：事件入队即落盘，进程重启后 enqueue 的 Promise 自然消失，
 * 但 job 还在；下次 createWriteQueue 把遗留 running 复位 queued，drain 继续跑完。
 *
 * 判定器（judge=llm）：每条 job 处理前，在 DB 事务外取候选 → 无候选直接 ADD（不调模型）→
 * 有候选且 llm/selection 可用才问模型；解析失败/超时/模型缺失一律带 `judge_fallback:<why>`
 * 回落规则。模型调用从不进事务、单条失败只影响该条（job 仍按规则落库），整批照跑。
 *
 * @param {{
 *   store: { withDb: <T>(fn: (db: import('node:sqlite').DatabaseSync) => T) => T },
 *   config?: object|Function,
 *   log?: (line: string) => void,
 *   getLlm?: (() => any) | null,
 *   getSelection?: (() => { provider?: string, model?: string } | null) | null,
 * }} args
 * @returns {{
 *   enqueue: (event: object) => Promise<{ ok: boolean, id?: string, action: string, reason: string, duplicate?: boolean, judge?: object }>,
 *   drain: () => Promise<{ processed: number }>,
 *   review: (id: number|string, decision: 'accept'|'reject', reason?: string) => { ok: boolean, id?: string, error?: string },
 *   pending: () => number,
 *   dispose: () => void,
 * }}
 */
export function createWriteQueue({ store, config, log = () => {}, getLlm = null, getSelection = null } = {}) {
  if (!store || typeof store.withDb !== 'function') throw new TypeError('createWriteQueue: store.withDb required')
  const cfg = config || {}
  // config 可以是 getter：面板改 shadow/auto 后必须即时生效，不能在构造时冻结。
  const liveConfig = () => (typeof cfg === 'function' ? cfg() : cfg)
  const onDb = (fn) => store.withDb(fn)

  // 崩溃补偿：上一次进程死在 running 的 write job 重新排队（attempts 保留，便于观察重试次数）。
  // 队列是 write job 的唯一消费者；启动补偿由 index.js 初始化时调 drainWrites 触发。
  try {
    onDb((db) => db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE kind='write' AND state='running'").run(now()))
  } catch (err) {
    log(`[whale-memory] write queue reset failed: ${err?.message || err}`)
  }

  /** @type {Map<number, (result: any) => void>} */
  const waiters = new Map()
  /** waiter 入队时刻：跨 drain/跨进程兜底超时用（秒）。 */
  const waitSince = new Map()
  let draining = null
  let closed = false
  let waitSweeper = null
  let retryTimer = null
  /** 单条等待上限：超过即结算 TIMEOUT（面板写入不能无限悬挂）。 */
  const WAIT_TIMEOUT_MS = 120_000

  /** 把一条 job 的终态翻译成 enqueue 的返回形状。 */
  function settleFromRow(jobId, row) {
    const fail = { ok: false, action: 'FAILED', reason: String(row?.last_error || 'job_failed') }
    if (!row) return { ok: false, action: 'LOST', reason: 'job_row_missing' }
    if (row.state === 'failed') return fail
    let parsed = {}
    try { parsed = JSON.parse(String(row.payload || '{}')) || {} } catch { parsed = {} }
    const inner = parsed.result && typeof parsed.result === 'object' ? parsed.result : {}
    return { ...inner, ok: inner.ok === undefined ? row.state === 'done' : Boolean(inner.ok), action: String(inner.action || 'DONE') }
  }

  /**
   * 终态扫地机：本进程没处理到的 job（另一 drain/另一进程抢先）也必须结算 waiter。
   * 只在有 waiter 时开一个 interval，清空后自停；定时器 unref，不拖住宿主退出。
   */
  function ensureWaitSweep() {
    if (waitSweeper || closed) return
    waitSweeper = setInterval(() => {
      if (waiters.size === 0) {
        clearInterval(waitSweeper)
        waitSweeper = null
        return
      }
      for (const [jobId, resolve] of [...waiters]) {
        try {
          const row = onDb((db) => db.prepare('SELECT state,payload,last_error FROM jobs WHERE id=?').get(jobId))
          if (row && (row.state === 'done' || row.state === 'failed')) {
            waiters.delete(jobId)
            waitSince.delete(jobId)
            resolve(settleFromRow(jobId, row))
            continue
          }
          const started = waitSince.get(jobId) || 0
          if (started && Date.now() - started > WAIT_TIMEOUT_MS) {
            waiters.delete(jobId)
            waitSince.delete(jobId)
            resolve({ ok: false, action: 'TIMEOUT', reason: 'queue_wait_timeout' })
          }
        } catch {
          // 读库失败（锁/关闭）下一轮继续，不在这里把 waiter 判死。
        }
      }
    }, 1000)
    if (typeof waitSweeper.unref === 'function') waitSweeper.unref()
  }

  /** judge=llm 开关（兼容 Ref 与扁平 config；读不到一律按 rules）。 */
  const judgeEnabled = (live) => {
    try {
      const c = value(live)
      const w = value(c?.write)
      return String(value(w?.judge ?? '') || '') === 'llm'
    } catch {
      return false
    }
  }

  /**
   * 判定器裁决（模型调用绝不进 DB 事务：先 onDb 同步取候选，再在事务外问模型）。
   * 无候选返回 null（调用方直接走规则 ADD，不花模型钱）；其余失败返回 ok:false 的裁决，
   * 由 decideWrite 回落规则并在结果里带 `judge_fallback:<why>`。
   */
  async function judgeEvent(event, live) {
    const fallback = (why) => ({ ok: false, error: `judge_fallback:${why}` })
    let candidates
    try {
      candidates = onDb((db) => findCandidates(db, event))
    } catch {
      return fallback('candidates_unavailable')
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    const llm = typeof getLlm === 'function' ? getLlm() : null
    if (!llm || typeof llm.stream !== 'function') return fallback('llm_unavailable')
    const selection = typeof getSelection === 'function' ? getSelection() : null
    const writeSection = value(value(live)?.write)
    const modelOverride = String(value(writeSection?.model) ?? '')
    if (!selection?.provider || (!selection?.model && !modelOverride)) return fallback('no_model')
    const text = normalize(String(event?.text ?? ''))
    const { map, lines } = mapCandidates(candidates.slice(0, JUDGE_CANDIDATE_LIMIT))
    const out = await collectJudgeText(llm, selection, buildJudgePrompt(text, lines), modelOverride)
    if (!out.ok) return fallback(out.error || 'llm_error')
    const parsed = parseJudgeOutput(out.text, map)
    if (!parsed.ok) return fallback(parsed.error)
    return { ok: true, targetId: parsed.targetId, action: parsed.action, reason: parsed.reason }
  }

  /** 单批处理：置 running → processEvent → done/failed，单条失败不打断整批。 */
  async function runDrain() {
    let processed = 0
    for (;;) {
      if (closed) break
      let batch
      try {
        batch = onDb((db) => db.prepare(
          "SELECT id,payload,attempts FROM jobs WHERE kind='write' AND state='queued'"
          + " AND (next_at IS NULL OR next_at <= ?) ORDER BY next_at IS NOT NULL, next_at, id LIMIT " + BATCH,
        ).all(now()))
      } catch (err) {
        log(`[whale-memory] write queue read failed: ${err?.message || err}`)
        break
      }
      if (!Array.isArray(batch) || batch.length === 0) break

      for (const job of batch) {
        const jobId = Number(job.id)
        let event = {}
        try { event = JSON.parse(String(job.payload ?? '{}')) } catch { event = {} }
        let result
        let verdict = null
        try {
          onDb((db) => db.prepare("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=?")
            .run(now(), jobId))
          const live = liveConfig()
          if (judgeEnabled(live)) {
            try {
              verdict = await judgeEvent(event, live)
            } catch (err) {
              verdict = { ok: false, error: `judge_fallback:${String(err?.message || err)}` }
            }
          }
          const targetEvent = verdict ? { ...event, __judgeVerdict: verdict } : event
          result = onDb((db) => processEvent(db, targetEvent, live))
          if (result?.judge?.used) {
            log(`[whale-memory] judge used=true action=${result.judge.action} target=${result.judge.targetId ?? '-'}`)
          } else if (verdict) {
            log(`[whale-memory] judge fallback reason=${result?.judge?.error || verdict.error || 'unknown'}`)
          }
          const payload = JSON.stringify({
            ...event,
            result: {
              action: result.action, id: result.id ?? null, reason: result.reason ?? '',
              ...(result.judge ? { judge: result.judge } : {}),
            },
          })
          onDb((db) => db.prepare("UPDATE jobs SET state='done', payload=?, last_error=NULL, updated_at=? WHERE id=?")
            .run(payload, now(), jobId))
        } catch (err) {
          const reason = String(err?.message || err).slice(0, 300)
          result = { ok: false, action: 'FAILED', reason }
          try {
            const attempts = Math.max(0, Number(job.attempts || 0)) + 1
            if (attempts < WRITE_MAX_ATTEMPTS) {
              const delay = WRITE_BACKOFF_SECONDS[Math.min(attempts, WRITE_BACKOFF_SECONDS.length - 1)]
              onDb((db) => db.prepare(`UPDATE jobs SET state='queued', attempts=?, last_error=?, next_at=?, updated_at=?
                WHERE id=? AND state='running'`).run(attempts, reason, now() + delay, now(), jobId))
            } else {
              onDb((db) => db.prepare(`UPDATE jobs SET state='failed', attempts=?, last_error=?, next_at=NULL, updated_at=?
                WHERE id=? AND state='running'`).run(attempts, reason, now(), jobId))
            }
          } catch (inner) {
            log(`[whale-memory] write queue retry/fail update failed: ${inner?.message || inner}`)
          }
        }
        processed += 1
        const resolver = waiters.get(jobId)
        if (resolver) {
          waiters.delete(jobId)
          waitSince.delete(jobId)
          // 调用方要知道"这是重复消息"（面板/对话侧可据此静默）
          const out = result.action === 'NOOP' && result.reason === 'duplicate'
            ? { ...result, duplicate: true }
            : result
          resolver(out)
        }
      }
      if (batch.length < BATCH) break
      // 满批后让出事件循环，避免长队列霸占主线程（写入在下一批继续）
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { processed }
  }

  /** 到期重试的兜底扫描：只处理自身 queued 行，不依赖 keeper。 */
  function ensureRetryTimer() {
    if (retryTimer || closed) return
    retryTimer = setInterval(() => {
      if (closed) return
      try {
        const due = Number(onDb((db) => db.prepare(
          "SELECT count(*) AS n FROM jobs WHERE kind='write' AND state='queued' AND (next_at IS NULL OR next_at <= ?)",
        ).get(now())?.n || 0))
        if (due > 0) drain().catch((err) => log(`[whale-memory] write queue retry drain failed: ${err?.message || err}`))
      } catch (err) {
        log(`[whale-memory] write queue retry scan failed: ${err?.message || err}`)
      }
    }, WRITE_RETRY_TICK_MS)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  ensureRetryTimer()

  /** 单飞：并发 drain 返回同一个 Promise。 */
  function drain() {
    if (closed) return Promise.resolve({ processed: 0 })
    if (draining) return draining
    draining = runDrain().finally(() => { draining = null })
    return draining
  }

  /** 入队：先落盘再返回 Promise；该 job 处理完（done/failed）时 resolve。 */
  function enqueue(event) {
    if (closed) return Promise.resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    const payload = JSON.stringify(event ?? {})
    let jobId
    try {
      jobId = Number(onDb((db) => db.prepare(
        'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ).run('write', 'queued', 0, payload, now(), now()).lastInsertRowid))
    } catch (err) {
      return Promise.resolve({ ok: false, action: 'REJECT', reason: `queue_insert_failed:${err?.message || err}` })
    }
    const promise = new Promise((resolve) => {
      waiters.set(jobId, resolve)
      waitSince.set(jobId, Date.now())
    })
    ensureWaitSweep()
    setImmediate(() => { drain().catch((err) => log(`[whale-memory] write queue drain failed: ${err?.message || err}`)) })
    return promise
  }

  /**
   * 审核候选（writes 行 action='CANDIDATE'）。
   * accept：读 writes.payload 还原等级/类型/tags/source/expired_at，并按 shadowOf 执行动作
   *   （ADD/REVIEW 插新节点，MERGE 改目标正文，SUPERSEDE 插新节点并让旧节点失效）；
   *   origin 保留候选原始来源（payload.origin）；旧候选无 origin 时回落 'shadow-review'。
   * reject：审计行改 REJECT，reason 追加 review:reject[:理由]。
   *
   * @param {number|string} id writes 行 id
   * @param {'accept'|'reject'} decision
   * @param {string} [reason] 驳回理由（≤200 由路由截断）
   * @param {{ identity?: { userId?: string, roleId?: string, workspace?: string } }} [opts]
   *   identity：审核人所在分区；给出时只允许审核同分区候选（跨分区 id 直给 404）。
   * @returns {{ ok: boolean, id?: string, error?: string }}
   */
  function review(id, decision, reason, opts = {}) {
    const action = String(decision ?? '')
    if (action !== 'accept' && action !== 'reject') return { ok: false, error: 'invalid_decision' }
    const writeId = Number(id)
    if (!Number.isInteger(writeId)) return { ok: false, error: 'candidate_not_found' }
    const ident = normalizeIdentity(opts?.identity)
    const scoped = Boolean(opts?.identity)
    try {
      return onDb((db) => {
        const row = db.prepare(
          `SELECT id,trace_id,action,reason,after_text,mode,payload,user_id,role_id,workspace FROM writes
           WHERE id=? AND action='CANDIDATE'${scoped ? ' AND user_id=? AND role_id=? AND workspace=?' : ''}`,
        ).get(writeId, ...(scoped ? [ident.userId, ident.roleId, ident.workspace] : []))
        if (!row) return { ok: false, error: 'candidate_not_found' }

        if (action === 'reject') {
          const extra = `review:reject${reason ? ':' + String(reason) : ''}`
          const previous = String(row.reason ?? '').trim()
          db.prepare("UPDATE writes SET action='REJECT', reason=? WHERE id=?")
            .run(previous ? `${previous} · ${extra}` : extra, writeId)
          return { ok: true }
        }

        let payload = {}
        try { payload = JSON.parse(String(row.payload ?? '{}')) || {} } catch { payload = {} }
        const text = normalize(String(row.after_text ?? ''))
        if (!text || text.length > TEXT_LIMIT) return { ok: false, error: 'invalid_text' }
        return withTx(db, () => acceptCandidate(db, row, text, payload, String(payload.shadowOf || 'ADD'), writeId))
      })
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  /** 待处理 job 数（queued + running）。 */
  function pending() {
    if (closed) return 0
    try {
      return Number(onDb((db) => db.prepare(
        "SELECT count(*) AS n FROM jobs WHERE kind='write' AND state IN ('queued','running')",
      ).get()?.n || 0))
    } catch {
      return 0
    }
  }

  /** 释放内存态（不动库：未完成的 job 留给下次启动继续）。 */
  function dispose() {
    closed = true
    if (waitSweeper) { clearInterval(waitSweeper); waitSweeper = null }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
    for (const resolve of waiters.values()) resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    waiters.clear()
    waitSince.clear()
  }

  return { enqueue, drain, review, pending, dispose }
}
