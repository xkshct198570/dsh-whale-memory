// 职责：backend 读 API 域——stats/recent/search/recall/nodes/writes/edges/evolution/recalls（只读检索与统计）。
// 依赖方向：base（身份闸/字段白名单）← 本文件；本地连接经 this._db()/this._worker() 取，不 import local-db。

/** @typedef {import('./base.js').Identity} Identity */

import { getMeta, now } from '../db.js'
import { search as searchDb, ftsStats } from '../search.js'
import { planBudget, trimHits } from '../budget.js'
import { relationStats } from '../relations.js'
import { computeMetrics } from '../metrics.js'
import { memoryPressure } from '../../shared/memory-guard.js'
import { bool } from '../../shared/config-values.js'
import { NODE_EXPORT_FIELDS, identityFilter, whereOf } from './base.js'
import { LAYERS } from '../../shared/layers.js'

/**
 * hit_ids 解析成命中条数。
 * 审计表是历史数据，手工修过/旧版本写坏的行解析失败按 0 计，不能因为一行脏数据让面板整页挂。
 * @param {unknown} raw hit_ids 列原文（JSON 数组字符串）
 * @returns {number}
 */
function hitIdsCount(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/** edges/evolution 的双端可见条件：两端都在可见集合内才算本分区的边/演化。
 * @param {Identity|null|undefined} identity
 * @returns {{ sql: string, params: string[], active: boolean }}
 */
function bothEndsVisible(identity) {
  const filter = identityFilter(identity)
  if (!filter.sql) return { sql: '', params: [], active: false }
  const vis = `SELECT id FROM nodes WHERE ${filter.sql}`
  return {
    sql: `(from_id IN (${vis}) AND to_id IN (${vis}))`,
    params: [...filter.params, ...filter.params],
    active: true,
  }
}

export const queryApi = {

  async stats() {
    const db = this._db()
    const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
    const nodesTotal = one('SELECT count(*) AS n FROM nodes')
    const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000 })()
    const ftsRows = (() => { try { return one('SELECT count(*) AS n FROM nodes_fts_docsize') } catch { return null } })()
    const ftsBiRows = (() => { try { return one('SELECT count(*) AS n FROM nodes_fts_bi_docsize') } catch { return null } })()
    const jobRow = (state) => one(`SELECT count(*) AS n FROM jobs WHERE state='${state}'`)
    const lastFailed = (() => { try { return db.prepare("SELECT last_error FROM jobs WHERE state='failed' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get()?.last_error || null } catch { return null } })()
    // 最近失败明细：面板「最近失败」卡片直接渲染，省得再开一个接口。
    const recentFailures = (() => {
      try {
        return db.prepare(`SELECT id,kind,state,attempts,last_error,updated_at FROM jobs
          WHERE state='failed' ORDER BY updated_at DESC LIMIT 5`).all().map((row) => ({
          id: Number(row.id), kind: String(row.kind || ''), state: String(row.state || 'failed'),
          attempts: Number(row.attempts || 0), last_error: row.last_error || null,
          updated_at: Number(row.updated_at || 0),
        }))
      } catch { return [] }
    })()
    // 指标/曲线与 totals/health 同一份打开连接：computeMetrics 只读，不新增连接也不写库。
    // embed 关时 pending 滞留按 0 计（§9.1），不然每份日报都挂一个不可行动的 ✗。
    const liveConfig = typeof this._config === 'function' ? this._config() : null
    const metrics = computeMetrics(db, {
      now: Date.now() / 1000, dbFile: this.dbPath, embedEnabled: bool(liveConfig?.embed?.enabled, false),
    })
    return {
      totals: {
        nodes_total: nodesTotal,
        nodes_active: one("SELECT count(*) AS n FROM nodes WHERE status='active'"),
        edges: one('SELECT count(*) AS n FROM edges'),
        recalls_today: one(`SELECT count(*) AS n FROM recalls WHERE ts >= ${dayStart}`),
        injected_chars_today: one(`SELECT coalesce(sum(chars),0) AS n FROM recalls WHERE ts >= ${dayStart}`),
      },
      health: {
        fts_aligned: ftsRows !== null && ftsBiRows !== null && ftsRows === nodesTotal && ftsBiRows === nodesTotal,
        fts_rows: ftsRows,
        fts_bi_rows: ftsBiRows,
        // [SHELVED 封存] 不再统计 vector_pending：语义召回无消费者，每次 /stats 全表扫是纯浪费。
        // 恢复时连同面板「待处理」健康位一起加回（延后文档 §1.1）。
        jobs: {
          running: jobRow('running'), queued: jobRow('queued'), failed: jobRow('failed'),
          last_error: lastFailed, recent_failures: recentFailures,
        },
        pressure: memoryPressure(),
        fts_errors: ftsStats.errors,
        fts_last_error: ftsStats.last_error || null,
        schema: {
          version: getMeta(db, 'schema_version'),
          unique_hash_index: this.db?.schemaInfo?.uniqueIndex !== false,
          quarantined: Boolean(this.db?.quarantine),
        },
      },
      metrics: { day: metrics.day, values: metrics.values, targets: metrics.targets },
      series: metrics.series,
      schema_version: getMeta(db, 'schema_version'),
      generated_at: new Date().toISOString(),
    }
  },

  /**
   * 首轮画像取数（v7）：同身份 active 节点按 layer 分组取前 N，只读 id/text/layer。
   *
   * 排序 `pinned DESC, weight DESC, updated_at DESC`（置顶规则优先，其次权重，其次最新）；
   * layer 精确匹配三值：DB 无 CHECK，未知值/NULL 自然不进画像（读路径把未知当未分层）。
   *
   * @param {{ user?: number, lesson?: number, fact?: number }} [limits] 每组条数上限（0 表示不取）
   * @param {{ identity?: Identity }} [opts]
   * @returns {Promise<{ user: Array<{id:string,text:string,layer:string}>,
   *   lesson: Array<{id:string,text:string,layer:string}>,
   *   fact: Array<{id:string,text:string,layer:string}> }>}
   */
  async profileLayers(limits = {}, opts = {}) {
    const db = this._db()
    const out = { user: [], lesson: [], fact: [] }
    const filter = identityFilter(opts?.identity)
    for (const layer of LAYERS) {
      const cap = Math.max(0, Math.min(20, Math.trunc(Number(limits?.[layer]) || 0)))
      if (!cap) continue
      out[layer] = db.prepare(`SELECT id,text,layer FROM nodes
        WHERE status='active' AND layer=?${filter.sql ? ` AND ${filter.sql}` : ''}
        ORDER BY pinned DESC, weight DESC, updated_at DESC LIMIT ?`)
        .all(layer, ...filter.params, cap)
        .map((row) => ({ id: String(row.id), text: String(row.text ?? ''), layer: String(row.layer) }))
    }
    return out
  },

  /**
   * 最近召回摘要（面板首页）：按身份过滤，避免首页把别人分区的查询词显示出来。
   * @param {number} [limit] 1..10
   * @param {{ identity?: Identity }} [opts]
   */
  async recent(limit = 3, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity)
    const rows = db.prepare(
      `SELECT ts,query,hit_ids,chars,injected,elapsed_ms FROM recalls${where.sql} ORDER BY ts DESC LIMIT ?`,
    ).all(...where.params, Math.max(1, Math.min(10, Number(limit) || 3)))
    return { items: rows.map((r) => ({
      ts: r.ts, query: String(r.query || ''), hits: hitIdsCount(r.hit_ids), chars: r.chars,
      injected: Boolean(r.injected), elapsed_ms: r.elapsed_ms,
    })) }
  },

  /**
   * @param {{ query:string, limit:number, identity:Identity, minRel?:number }} q
   */
  async search(q, signal) {
    const db = this._db()
    const opts = {
      query: String(q?.query || ''), limit: q?.limit ?? 5,
      identity: q?.identity, minRel: q?.minRel,
      diffusion: q?.diffusion, minConf: q?.minConf,
    }
    const worker = this._worker()
    if (worker) {
      try {
        return await worker.search({ dbPath: this.dbPath, ...opts })
      } catch (err) {
        this.log(`[whale-memory] worker search fallback: ${err?.code || err?.message || err}`)
      }
    }
    return searchDb(db, opts)
  },

  /**
   * 召回 + 组装注入文本（与旧网关口径兼容的前缀）。
   *
   * 观测硬约束：**每一次召回都落一行 recalls**，包括零命中与意图预算为 0 的链路。
   * 为什么：零命中不落库时，"零注入率/空转率"永远没有分母，审计看到的只有成功注入
   * 的样本，等于用幸存者偏差给自己打分。预算为 0 也要落一行，否则"按意图关掉注入"
   * 和"根本没有记忆"在数据里长得一样。
   *
   * 注入开关（审计 P1-1 假开关）：
   * - `injectLevels`：只注入这些等级的节点（空数组=不注入）；不传=不过滤（旧调用方行为不变）。
   * - `showSources`：true（默认）时每行带 `[core/owner]` 来源标记，false 时只留正文。
   *
   * @param {{ query:string, maxHits:number, identity:Identity, minRel?:number,
   *   source?:string, traceId?:string, charBudget?:number, intentBudget?:boolean,
   *   injectLevels?:string[], showSources?:boolean }} q
   */
  async recall(q, signal) {
    const started = Date.now()
    // 意图预算（架构书 §5.4）：闲聊/排障/回忆分档；画图链路 0 注入。
    const budget = planBudget(q?.query, {
      intentBudget: q?.intentBudget,
      maxHits: q?.maxHits ?? 5,
      charBudget: q?.charBudget,
    })
    // 预算 0 是「按设计不检索」，不是「检索了但零命中」：source=intent0 与命中率指标区分开，
    // 避免画图链路把 zero_injection_rate 永久拉红。
    const intentZero = budget.maxHits <= 0 || budget.charBudget <= 0
    // 调用方标来源（hook / panel-test / search...）；截 32 与 writes.source 口径一致。
    const source = String(intentZero ? 'intent0' : (q?.source || 'hook')).slice(0, 32)
    /**
     * 落审计行。hit_ids 记录的是**检索命中集合**（并非最终注入集合）：只有把"命中了
     * 但被预算裁掉/丢弃"也留下来，日报才能列出"命中但未注入"的低分候选。
     * 注入与否由 injected/chars 表达，两者不混在同一个字段里。
     * @param {{ hitIds?: string[], chars?: number, injected?: number }} row
     * @returns {number} 新行 id（失败 0）：hook 拿它回写 used 采纳信号
     */
    const audit = ({ hitIds = [], chars = 0, injected = 0 }) => {
      try {
        const db = this._db()
        const info = db.prepare(`INSERT INTO recalls
          (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          now(), String(q?.traceId || ''), String(q?.query || '').slice(0, 500),
          JSON.stringify(hitIds), chars, injected,
          // used 落库时恒 0：注入不等于采纳，证据只能等回复侧（hook 的 assistant-stream）
          // 拿到引用文本后再回写；这里先写 0 是「尚未判定」，不是「判定为未采纳」。
          0,
          Date.now() - started,
          String(q?.identity?.userId || ''), String(q?.identity?.roleId || ''), String(q?.identity?.workspace || ''),
          source,
        )
        return Number(info.lastInsertRowid) || 0
      } catch (err) {
        this.log(`[whale-memory] recall audit fail-open: ${err?.message || err}`)
        return 0
      }
    }

    if (intentZero) {
      audit({})
      return { ok: true, prefix: '', chars: 0, hits: 0, intent: budget.intent }
    }
    const result = await this.search({
      query: q?.query, limit: budget.maxHits, identity: q?.identity, minRel: q?.minRel,
      diffusion: q?.diffusion, minConf: q?.minConf,
    }, signal)
    const searched = Array.isArray(result?.hits) ? result.hits : []
    // 等级过滤必须在预算裁剪之前：先砍掉不该注入的层级，再让预算决定注入多少条。
    // 空数组是显式"一个等级都不要"（面板全不勾），不是"不过滤"；不传才是不过滤。
    const levels = Array.isArray(q?.injectLevels) ? new Set(q.injectLevels.map((x) => String(x))) : null
    const allowed = levels ? searched.filter((h) => levels.has(String(h?.level ?? ''))) : searched
    const trimmed = trimHits(allowed, budget)
    const hits = trimmed.hits
    const showSources = q?.showSources !== false
    /**
     * 每行来源标记 `[level/source]`：让人一眼看出这条记忆的分量与出处（§4.3）。
     * showSources=false 时完全不写标记——面板关掉开关就要真的看不见。
     */
    const markOf = (h) => `[${String(h?.level || 'normal')}/${String(h?.source || 'self')}] `
    const prefix = hits.length
      ? '【你想到的旧事】\n' + hits.map((h) => `- ${showSources ? markOf(h) : ''}${String(h.text || '').trim()}`).join('\n')
      : ''
    const recallId = audit({
      hitIds: searched.map((h) => h.id),
      chars: prefix.length,
      injected: prefix ? 1 : 0,
    })
    return {
      ok: true, prefix, chars: prefix.length, hits: hits.length,
      intent: budget.intent, dropped: trimmed.dropped, clipped: trimmed.clipped,
      // 被等级开关挡掉的数量：面板"命中但未注入"从此能区分"层级不收"与"预算不够"。
      level_filtered: searched.length - allowed.length,
      // 采纳信号的判定素材：只给**最终注入**的节点（被预算裁掉的节点不该产生采纳）。
      recallId,
      injectedNodes: hits.map((h) => ({ id: String(h?.id ?? ''), text: String(h?.text ?? '') })),
    }
  },

  /**
   * 采纳信号回写：一次召回被回复引用后置 used=1。
   *
   * why 只改 used 列：hit_ids/chars/injected 描述的是「注入事实」，回复侧只能证明
   * 「是否被引用」，两者混在一个字段里会让日报的注入率与采纳率互相污染。
   * 失败 fail-open：观测信号不能反向影响正常回复链路。
   *
   * @param {number} recallId `recall()` 返回的审计行 id
   * @param {boolean} [used]
   * @returns {{ ok: boolean, updated: number }}
   */
  markRecallUsed(recallId, used = true) {
    const id = Number(recallId)
    if (!Number.isInteger(id) || id <= 0) return { ok: false, updated: 0 }
    try {
      const info = this._db().prepare('UPDATE recalls SET used=? WHERE id=?').run(used ? 1 : 0, id)
      return { ok: true, updated: Number(info.changes) || 0 }
    } catch (err) {
      this.log(`[whale-memory] markRecallUsed fail-open: ${err?.message || err}`)
      return { ok: false, updated: 0 }
    }
  },

  /**
   * 反思素材：最近 episodic（只读）。
   *
   * 身份过滤不可省：反思会把素材交给模型再写回；不按分区取会把别人的私有 episodic
   * 混进来，写回时又落共享分区，等于把私有事实洗成公开记忆。
   *
   * @param {number} [limit]
   * @param {{ identity?: Identity }} [opts]
   */
  async listEpisodic(limit = 20, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity)
    const rows = db.prepare(`SELECT id,text,created_at,tags FROM nodes${where.sql}
      ${where.sql ? 'AND' : 'WHERE'} status='active' AND memory_type='episodic'
      ORDER BY created_at DESC LIMIT ?`).all(...where.params, Math.max(1, Math.min(50, Number(limit) || 20)))
    return rows
  },

  /**
   * 置顶规则（schema v3；R4 每会话首次注入的数据入口）。
   *
   * 口径：
   * - 只取 `status='active' AND pinned=1`：退役（superseded）与归档规则不得再注入。
   * - 身份/作用域走 `whereOf` 的 `(列='' OR 列=?)`：规则默认共享（''），可整条限定工作区；
   *   `''` 始终可见，所以共享规则在任何会话都会带上。
   * - 排序 weight（显式/高置信优先）→ updated_at（最近改动优先）→ created_at，结果稳定可测。
   * - 上限只做硬保护（1..100），预算裁剪（条数/字符）由 R4 的注入层负责，这里不静默丢。
   *
   * @param {Identity|null|undefined} identity 会话身份
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<object[]>} 节点行（字段同导出，含 pinned）
   */
  async pinnedRules(identity, { limit = 20 } = {}) {
    const db = this._db()
    const max = Math.max(1, Math.min(100, Number(limit) || 20))
    const where = whereOf(identity, [["status='active'", []], ['pinned=1', []]])
    return db.prepare(
      `SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql}
       ORDER BY weight DESC, updated_at DESC, created_at DESC LIMIT ?`,
    ).all(...where.params, max)
  },

  /**
   * 节点分页（面板「记忆」页）：列表与 total 都按身份过滤（与 export 同口径）。
   * why total 也要过滤：列表过滤而总数不过滤时，面板会显示"本区 2 条 / 共 40 条"，
   * 既暴露了别人分区的规模，也让翻页逻辑把空页当成还有数据。
   *
   * @param {{ identity?:Identity, limit?:number, offset?:number }} q
   */
  async nodes(q = {}) {
    const db = this._db()
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20))
    const offset = Math.max(0, Number(q.offset) || 0)
    const where = whereOf(q?.identity)
    const total = Number(db.prepare(`SELECT count(*) AS n FROM nodes${where.sql}`).get(...where.params)?.n || 0)
    const rows = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...where.params, limit, offset)
    return { items: rows, total }
  },

  /**
   * 单节点详情（面板抽屉）：不属本身份的节点一律按 node_not_found 处理。
   * why 不返回 403：存在性本身就是信息（"某 id 有记忆"），跨身份探测不该有反馈。
   * @param {string} id
   * @param {{ identity?:Identity }} [opts]
   */
  async getNode(id, opts = {}) {
    const db = this._db()
    const where = whereOf(opts?.identity, [['id=?', [String(id || '')]]])
    const row = db.prepare(`SELECT ${NODE_EXPORT_FIELDS.join(',')} FROM nodes${where.sql}`).get(...where.params)
    if (!row) return { ok: false, error: 'node_not_found' }
    // 面板详情抽屉要"1 跳邻居边"（§7.2）：只暴露身份可见的两端。
    // 边没有身份列，按两端节点是否在可见集合里判断（与 /edges 同口径）。
    let edges = []
    try {
      const filter = identityFilter(opts?.identity)
      const cond = filter.sql
        ? `AND e.from_id IN (SELECT id FROM nodes WHERE ${filter.sql}) AND e.to_id IN (SELECT id FROM nodes WHERE ${filter.sql})`
        : ''
      const rows = db.prepare(`SELECT e.id, e.from_id, e.to_id, e.etype, e.source, e.conf, e.weight, e.created_at
        FROM edges e
        WHERE (e.from_id = ? OR e.to_id = ?) ${cond}
        ORDER BY e.conf DESC, e.id DESC LIMIT 20`)
        .all(String(id || ''), String(id || ''), ...filter.params, ...filter.params)
      edges = rows.map((edge) => ({
        ...edge,
        neighbor: edge.from_id === String(id) ? edge.to_id : edge.from_id,
      }))
    } catch { edges = [] }
    return { ok: true, node: row, edges }
  },

  /**
   * 最近写入审计（只读）；action 过滤用于面板只看 shadow 候选。
   * @param {number} [limit]
   * @param {string} [action]
   * @param {{ identity?:Identity }} [opts]
   */
  async writes(limit = 20, action = '', opts = {}) {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 20))
    const where = whereOf(opts?.identity, action ? [['action=?', [String(action)]]] : [])
    const rows = db.prepare(`SELECT id,ts,trace_id,action,node_id,reason,before_text,after_text,mode,payload,user_id,role_id,workspace
      FROM writes${where.sql} ORDER BY ts DESC LIMIT ?`).all(...where.params, lim)
    // 只把候选来源摘成扁平字段，不回传整段 payload：面板要的是 origin 徽标，
    // 回传决策载荷会把 tags/双时态/内部 targetId 一起暴露给只读列表。
    return {
      items: rows.map((row) => {
        let origin = ''
        try {
          const payload = JSON.parse(String(row.payload || '{}'))
          origin = typeof payload?.origin === 'string' ? payload.origin : ''
        } catch { /* 旧候选 payload 坏/空：origin 留空，不影响列表 */ }
        const { payload: _payload, ...rest } = row
        return { ...rest, origin }
      }),
    }
  },

  /**
   * 关系统计 + 最近边（面板 /edges）：两端都在本身份可见集合内才算数。
   * edges 表没有隔离列，可见性只能经 nodes 判定；统计与明细必须同口径，否则总数与列表打架。
   * @param {number} [limit]
   * @param {{ identity?:Identity }} [opts]
   */
  async edges(limit = 50, opts = {}) {
    const db = this._db()
    const ends = bothEndsVisible(opts?.identity)
    const whereSql = ends.active ? ` WHERE ${ends.sql}` : ''
    const stat = relationStats(db, opts?.identity)
    const items = db.prepare(`SELECT id,from_id,to_id,etype,source,conf,weight,created_at FROM edges${whereSql}
      ORDER BY id DESC LIMIT ?`).all(...ends.params, Math.max(1, Math.min(100, Number(limit) || 50)))
    return { ok: true, ...stat, items }
  },

  /**
   * 演化审计（面板 /evolution）：按被改节点（to_id）所属身份过滤。
   * 两端都要求可见：跨分区的边/注记不该在别人的审计页出现（哪怕只是节点 id）。
   * @param {number} [limit]
   * @param {{ identity?:Identity }} [opts]
   */
  async evolution(limit = 50, opts = {}) {
    const db = this._db()
    const lim = Math.max(1, Math.min(100, Number(limit) || 50))
    const ends = bothEndsVisible(opts?.identity)
    const whereSql = ends.active ? ` WHERE ${ends.sql}` : ''
    const items = db.prepare(`SELECT id,ts,from_id,to_id,field,old_value,new_value,trace_id FROM evolution${whereSql}
      ORDER BY id DESC LIMIT ?`).all(...ends.params, lim)
    return { ok: true, items }
  },

  /**
   * 最近召回审计（只读）：面板过滤与日报复盘共用同一个入口。
   *
   * 过滤参数全部走 SQL 占位符；filter 只认白名单（zero/unused），
   * 未知值按"不过滤"处理——面板多传一个键不能把整页查空。
   * 身份条件（opts.identity）与其它条件同层 AND，避免"过滤把人过滤掉了但统计没过滤"。
   *
   * @param {number} [limit] 1..100（越界夹取；非正数回落 20）
   * @param {{ source?: string, since?: number, filter?: 'zero'|'unused'|'', identity?: Identity }} [opts]
   *   source: 精确匹配来源（截 32）；since: 秒级下界；filter: zero=零命中 / unused=已注入未采纳
   * @returns {{ items: Array<{ id:number, ts:number, trace_id:string, query:string,
   *   hit_ids:string, chars:number, injected:number, used:number, elapsed_ms:number|null,
   *   source:string, hits:number }> }}
   */
  async recalls(limit = 20, opts = {}) {
    const db = this._db()
    const raw = Number(limit)
    const lim = Math.max(1, Math.min(100, Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
    const extra = []
    const source = String(opts?.source ?? '').slice(0, 32)
    if (source) extra.push(['source = ?', [source]])
    const since = Number(opts?.since)
    if (Number.isFinite(since)) extra.push(['ts >= ?', [since]])
    if (opts?.filter === 'zero') {
      extra.push(["hit_ids IN ('[]','')", []])
      extra.push(["source <> 'intent0'", []])
    }
    else if (opts?.filter === 'unused') extra.push(['injected = 1 AND used = 0', []])
    const where = whereOf(opts?.identity, extra)
    const sql = `SELECT id,ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,source
      FROM recalls${where.sql} ORDER BY ts DESC, id DESC LIMIT ?`
    const rows = db.prepare(sql).all(...where.params, lim)
    return { items: rows.map((r) => ({ ...r, hits: hitIdsCount(r.hit_ids) })) }
  },

}
