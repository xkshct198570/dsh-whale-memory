// 职责：backend 写 API 域——write/updateNode/候选审核/写队列 getter 与遗留 job 续跑。
// 依赖方向：base（身份 WHERE）← 本文件；写队列与审计走 writer 门面，本地连接经 this._db()/this.withDb() 取。

/** @typedef {import('./base.js').Identity} Identity */

import { createWriteQueue, isActiveHashConflict, isProtectedTarget, recordEvolution, validLayer, withTx, writePayload } from '../writer.js'
import { bigrams, contentHash, normalize } from '../tokenize.js'
import { now } from '../db.js'
import { applyNeighborNotes, parseTags } from '../relations.js'
import { value } from '../../shared/config-values.js'
import { whereOf } from './base.js'

export const writeApi = {

  _writer() {
    if (this.closed) throw new Error('backend_disposed')
    if (!this.writeQueue) {
      this.writeQueue = createWriteQueue({
        store: this,
        config: this._config,
        log: this.log,
        getLlm: this.getLlm,
        getSelection: this.getSelection,
      })
    }
    return this.writeQueue
  },

  /** 续跑遗留的写队列 job（keeper 的 write handler / 启动补偿用）。 */
  async drainWrites() {
    return this._writer().drain()
  },

  /** shadow 候选审核（面板「写入」页）。 */
  /**
   * 审核影子候选：identity 由路由传入，只允许本分区候选/目标（跨分区 id 返回 candidate_not_found）。
   * @param {number|string} id writes 行 id
   * @param {'accept'|'reject'} decision
   * @param {string} [reason]
   * @param {{ identity?: { userId?: string, roleId?: string, workspace?: string } }} [opts]
   */
  reviewWrite(id, decision, reason, opts = {}) {
    return this._writer().review(id, decision, reason, opts)
  },

  /**
   * 写入入口（S4 决策流水线）：校验 → 落 jobs 队列 → decideWrite → processEvent。
   * shadow 模式只留 writes CANDIDATE，不落 nodes；auto 模式才写记忆库。
   * @param {{ text:string, level?:string, memory_type?:string, source?:string, tags?:string[], expired_at?:number, origin?:string, traceId?:string, identity:Identity, layer?:string }} q
   */
  async write(q) {
    const text = normalize(String(q?.text || ''))
    if (!text) return { ok: false, error: 'invalid_text' }
    if (text.length > 500) return { ok: false, error: 'text_too_long' }
    const writeCfg = value(this._config()?.write) || {}
    // 关写开关必须先解包 Ref（schemas 里是 .volatile()，直接 === false 恒假，开关等于没有）。
    if (value(writeCfg.enabled) === false) return { ok: false, error: 'write_disabled' }
    const ident = q?.identity || {}
    const tags = Array.isArray(q.tags) ? q.tags.filter((x) => typeof x === 'string').slice(0, 32) : []
    const event = {
      traceId: String(q?.traceId || ''),
      source: String(q?.source || 'manual'),
      identity: { userId: String(ident.userId || ''), roleId: String(ident.roleId || ''), workspace: String(ident.workspace || '') },
      text,
      tags,
      at: Date.now(),
      candidateType: q?.memory_type || null,
      origin: String(q?.origin || 'panel'),
      level: q?.level || 'normal',
      memory_type: q?.memory_type || 'semantic',
      // v3：规则置顶随事件下传（writer 落库；默认 0，不改变既有写入口行为）。
      pinned: q?.pinned === 1 || q?.pinned === true ? 1 : 0,
      // v7：分层标签在写入口收敛成三值或 NULL（模型工具/面板/旧调用方不带 kind → NULL）。
      layer: validLayer(q?.layer),
      expired_at: Number.isFinite(Number(q?.expired_at)) ? Number(q.expired_at) : undefined,
      // 内部写入口专用：单条强制 shadow（旧调用方；session-wrap 现改用 ingestPolicy.mode='review'）。
      // 路由 /write 不透传该字段，外部无法用它做除“更保守”以外的任何事。
      __forceShadow: q?.forceShadow === true,
      // 内部写入口专用：价值闸/歧义闸策略（session-wrap/tool/reflect 传）。路由 /write 不透传。
      __ingest: q?.ingestPolicy && typeof q.ingestPolicy === 'object' ? q.ingestPolicy : undefined,
    }
    const res = await this._writer().enqueue(event)
    if (!res || res.ok === false) {
      return { ok: false, error: String(res?.reason || 'write_rejected'), action: res?.action }
    }
    if (res.id) {
      // 演化注记只追加 context_note（≤200），不改正文/tags；失败不阻断写入结果。
      try {
        this.withDb((db) => applyNeighborNotes(db, { id: res.id, tags, identity: event.identity }, { traceId: event.traceId }))
      } catch (err) {
        this.log(`[whale-memory] neighbor notes fail-open: ${err?.message || err}`)
      }
    }
    return {
      ok: true,
      id: res.id,
      action: res.action,
      reason: String(res.reason ?? ''),
      duplicate: Boolean(res.duplicate),
      candidate: res.action === 'CANDIDATE',
    }
  },

  /**
   * 面板编辑/归档：只改白名单字段，重算 hash/bigrams，并把改动完整留痕。
   *
   * 三条硬约束（审计 P0-3 / A3）：
   * - 事务内先读旧行：旧值既用于身份校验，也是审计的 before_text（事后读会被改后的值骗）。
   * - 受保护目标（source=owner / level=core / memory_type=procedural）只允许改非正文状态，
   *   改正文或改等级返回 protected_target；面板不能绕过保护把规则改成别的意思。
   * - status=superseded 必须带 superseded_by，否则 superseded_by_required —— 防止留下
   *   "已失效但不知道被谁取代"的半残数据。
   * - 普通目标的每个字段改动写一条 writes（EDIT/ARCHIVE）+ 一条 evolution（旧值/新值）。
   *
   * @param {string} id
   * @param {{ text?:string, status?:string, level?:string, tags?:string[], superseded_by?:string, layer?:string }} patch
   * @param {{ identity?:Identity, traceId?:string, mode?:'manual'|'sync', origin?:string, reason?:string }} [opts]
   *   mode 只影响 writes.mode（面板人工 vs 同步冲突标记）；origin 落 writes.payload.origin（工具改写传 'tool'）；
   *   reason 覆盖归档审计原因（缺省 `<origin>_archive`）。
   * @returns {{ ok: boolean, id?: string, error?: string }}
   */
  async updateNode(id, patch = {}, opts = {}) {
    const db = this._db()
    const target = String(id || '')
    const where = whereOf(opts?.identity, [['id=?', [target]]])
    const row = db.prepare(`SELECT * FROM nodes${where.sql}`).get(...where.params)
    if (!row) return { ok: false, error: 'node_not_found' }
    // 乐观并发：客户端回传详情里的 updated_at，期间被别人改过就拒绝，不拿旧快照覆盖。
    const expected = opts?.expectedUpdatedAt
    if (expected !== undefined && expected !== null && expected !== ''
      && String(expected) !== String(row.updated_at)) {
      return { ok: false, error: 'node_changed' }
    }
    const text = patch.text === undefined ? row.text : normalize(String(patch.text))
    if (!text || text.length > 500) return { ok: false, error: 'invalid_text' }
    const status = patch.status === undefined ? row.status : String(patch.status)
    if (!['active', 'archived', 'stale', 'superseded'].includes(status)) return { ok: false, error: 'invalid_status' }
    const level = patch.level === undefined ? row.level : String(patch.level)
    if (!['core', 'important', 'normal'].includes(level)) return { ok: false, error: 'invalid_level' }
    // v7 分层：显式给出才改（白名单收敛），缺省保留原值；不做全库回填（旧行 NULL 保持）。
    const tags = patch.tags === undefined ? row.tags : JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])
    const supersededBy = patch.superseded_by === undefined || patch.superseded_by === null
      ? row.superseded_by
      : String(patch.superseded_by).trim().slice(0, 128)
    if (status === 'superseded' && !supersededBy) return { ok: false, error: 'superseded_by_required' }
    // 离开 superseded 时指针必须清空：留下"谁是继任者"而状态是 active，就是半残数据。
    const nextPointer = status === 'superseded' ? supersededBy : null

    const layer = patch.layer === undefined ? row.layer : validLayer(patch.layer)
    const textChanged = text !== row.text
    const levelChanged = level !== row.level
    const layerChanged = String(layer ?? '') !== String(row.layer ?? '')
    // 保护面判据只认 decide.js 的 isProtectedTarget（同一判据一处；此前这里抄了一份）。
    if (isProtectedTarget(row, { protect: true }) && (textChanged || levelChanged)) {
      return { ok: false, error: 'protected_target' }
    }

    const statusChanged = status !== row.status
    const tagsChanged = tags !== row.tags
    const pointerChanged = String(nextPointer ?? '') !== String(row.superseded_by ?? '')
    // 无变化时不发 UPDATE 也不产审计：返回“实际生效的 updated_at”，否则调用方拿到一个
    // 从未落库的新时间戳，下一次 CAS 必然误判 node_changed（幻影版本号）。
    const changed = textChanged || statusChanged || levelChanged || tagsChanged || pointerChanged || layerChanged
    // CAS 基线必须严格递增：同一毫秒内两次保存若返回相同 updated_at，客户端下一次提交仍带旧值
    // 会被误判 node_changed（A3 偶发红）。至少比旧值大 1 微秒。
    const ts = Math.max(now(), Number(row.updated_at || 0) + 0.000001)
    const traceId = String(opts?.traceId || '').slice(0, 64)
    const mode = opts?.mode === 'sync' ? 'sync' : 'manual'
    // 来源标记落 writes.payload.origin（v2 列）：工具改写必须可查（json_extract），
    // 面板/同步沿用各自默认值；payload 与影子候选同形（writePayload 唯一构造）。
    const origin = String(opts?.origin || (opts?.mode === 'sync' ? 'sync' : 'panel')).slice(0, 32)
    const verb = origin === 'tool' ? 'tool' : origin === 'sync' ? 'sync' : 'manual'
    const payloadJson = JSON.stringify(writePayload({
      level,
      memory_type: row.memory_type,
      tags: parseTags(tags),
      layer,
      source: row.source,
      origin,
      expired_at: row.expired_at,
      shadowOf: null,
      targetId: null,
    }))
    const reasonOf = (fallback) => String(opts?.reason || fallback).slice(0, 200)

    try {
      return withTx(db, () => {
      // CAS：读旧行在事务外，若期间被别的写入改过，直接返回 node_changed，
      // 不用旧快照覆盖新值（审计 P2：丢更新窗口）。
      const current = db.prepare('SELECT updated_at FROM nodes WHERE id=?').get(target)
      if (current && String(current.updated_at) !== String(row.updated_at)) {
        return { ok: false, error: 'node_changed' }
      }
      if (changed) {
        db.prepare(`UPDATE nodes SET text=?,text_hash=?,text_bigrams=?,status=?,level=?,tags=?,layer=?,superseded_by=?,updated_at=?
          WHERE id=?`).run(
          text, contentHash(text), bigrams(text), status, level, tags, layer, nextPointer, ts, target,
        )
      }
      /** 一个字段的改动 = 一条 writes + 一条 evolution（面板「写入」页与「演化」页同源）。 */
      const audit = (action, field, oldValue, newValue, reason) => {
        db.prepare(`INSERT INTO writes
          (ts,trace_id,action,node_id,reason,before_text,after_text,mode,payload,user_id,role_id,workspace)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          ts, traceId, action, target, reason,
          String(row.text ?? ''), field === 'text' ? String(newValue ?? '') : String(row.text ?? ''),
          mode, payloadJson, String(row.user_id ?? ''), String(row.role_id ?? ''), String(row.workspace ?? ''),
        )
        recordEvolution(db, { ts, fromId: target, toId: target, field, oldValue, newValue, traceId })
      }
      if (textChanged) audit('EDIT', 'text', row.text, text, `${verb}_edit`)
      if (statusChanged) audit('ARCHIVE', 'status', row.status, status, reasonOf(`${verb}_archive`))
      if (levelChanged) audit('EDIT', 'level', row.level, level, `${verb}_level`)
      if (tagsChanged) audit('EDIT', 'tags', row.tags, tags, `${verb}_tags`)
      if (layerChanged) audit('EDIT', 'layer', row.layer ?? '', layer ?? '', `${verb}_layer`)
      if (pointerChanged) audit('EDIT', 'superseded_by', row.superseded_by ?? '', nextPointer ?? '', `${verb}_supersede`)
        return { ok: true, id: target, updated_at: changed ? ts : Number(row.updated_at || 0) }
      })
    } catch (err) {
      // 编辑后的正文与另一活跃行撞车：回明确错误码，不把 SQLite 约束文案透给面板。
      if (isActiveHashConflict(err)) return { ok: false, error: 'duplicate_active' }
      throw err
    }
  },

}
