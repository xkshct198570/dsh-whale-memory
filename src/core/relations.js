/**
 * 关系层与演化（架构书 §7）：边不是装饰，扩散要能解释，注记必须封顶。
 *
 * 三条硬约束：
 * - 扩散只走 `topic`/`reference` 且 `conf ≥ edges.minConf`；`mutex` 永不扩散（同词不同义）。
 * - 每条边 1 跳、每跳 ×0.6；不做 2 跳（v2 收敛结论）。
 * - `context_note` 硬顶 200 字（schema CHECK 兜底 + 这里再拦一层），只追加注记、不改正文与 tags；
 *   每次改动写 `evolution`，面板能查"这条记忆被谁改过"。
 *
 * 本模块只碰 edges/evolution/nodes.context_note，不碰 FTS、不碰注入文本。
 */
import { now } from './db.js'

/** context_note 硬顶（字）；与 schema CHECK 同值。 */
export const NOTE_MAX = 200
/** 扩散每跳衰减系数。 */
export const HOP_FACTOR = 0.6
/** 可扩散边类型（mutex/similar/supersede 不扩散）。 */
export const DIFFUSION_ETYPES = new Set(['topic', 'reference'])
const EDGE_ETYPES = new Set(['similar', 'topic', 'supersede', 'mutex', 'reference'])
const EDGE_SOURCES = new Set(['tag', 'reflect', 'manual', 'decision'])

function clamp01(value, fallback = 0.5) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
}

/** 标签数组（去空、去重、小写比较但保留原样）。 */
export function normalizeTags(tags) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? '').trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** 解析库里存的 tags JSON；坏数据当空数组（读路径绝不抛）。 */
export function parseTags(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? normalizeTags(parsed) : []
  } catch { return [] }
}

/**
 * 演化注记：去重追加，超 200 字时丢最旧片段（覆盖而不是无限增长）。
 * @param {string} oldNote
 * @param {string[]} tags
 * @param {number} [max]
 * @returns {string}
 */
export function evolutionNote(oldNote, tags, max = NOTE_MAX) {
  const limit = Math.max(1, Math.floor(Number(max) || NOTE_MAX))
  const fragments = String(oldNote || '').split(' · ').map((s) => s.trim()).filter(Boolean)
  const seen = new Set(fragments.map((s) => s.toLowerCase()))
  for (const tag of normalizeTags(tags)) {
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    fragments.push(tag)
  }
  while (fragments.length > 1 && fragments.join(' · ').length > limit) fragments.shift()
  let note = fragments.join(' · ')
  if (note.length > limit) note = `${note.slice(0, limit - 1)}…`
  return note
}

/**
 * 边是否参与 1 跳扩散。
 * @param {{ etype?: string, conf?: number }} edge
 * @param {number} [minConf]
 */
export function passDiffusion(edge, minConf = 0.6) {
  if (!edge || !DIFFUSION_ETYPES.has(String(edge.etype || ''))) return false
  return clamp01(edge.conf) >= clamp01(minConf, 0.6)
}

/**
 * 幂等写边（同 from/to/etype 只升级置信与权重，不产生重复行）。
 * @returns {{ ok: boolean, error?: string }}
 */
export function upsertEdge(db, edge) {
  const etype = String(edge?.etype || '')
  const source = String(edge?.source || 'tag')
  if (!EDGE_ETYPES.has(etype)) return { ok: false, error: 'invalid_etype' }
  if (!EDGE_SOURCES.has(source)) return { ok: false, error: 'invalid_source' }
  const fromId = String(edge?.fromId || '')
  const toId = String(edge?.toId || '')
  if (!fromId || !toId || fromId === toId) return { ok: false, error: 'invalid_edge_ids' }
  db.prepare(`INSERT INTO edges (from_id,to_id,etype,source,conf,weight,created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(from_id,to_id,etype) DO UPDATE SET
      conf = max(edges.conf, excluded.conf),
      weight = max(edges.weight, excluded.weight)`).run(
    fromId, toId, etype, source, clamp01(edge.conf), Number(edge.weight ?? 0.6), now(),
  )
  return { ok: true }
}

/** 取代溯源边（old → new，conf=1）。 */
export function linkSupersede(db, oldId, newId) {
  return upsertEdge(db, { fromId: String(oldId), toId: String(newId), etype: 'supersede', source: 'decision', conf: 1, weight: 1 })
}

/** 冲突告警边（不扩散）。 */
export function linkMutex(db, aId, bId) {
  return upsertEdge(db, { fromId: String(aId), toId: String(bId), etype: 'mutex', source: 'decision', conf: 0.9, weight: 0.9 })
}

/**
 * 按标签共现重建 similar 边（巩固 job 整批跑，不每条写入都重建）。
 * 规则：同 tag 且成员数 ≤ dfMax（大众词不连边）；置信按成员数分档 0.6/0.45/0.3。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dfMax?: number, maxNodes?: number, maxPairs?: number }} [opts]
 * @returns {{ nodes: number, tags: number, edges: number }}
 */
export function rebuildTagEdges(db, { dfMax = 12, maxNodes = 5000, maxPairs = 5000 } = {}) {
  const rows = db.prepare('SELECT id, tags FROM nodes WHERE status=? LIMIT ?').all('active', Math.max(1, maxNodes))
  const byTag = new Map()
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      const key = tag.toLowerCase()
      let ids = byTag.get(key)
      if (!ids) { ids = []; byTag.set(key, ids) }
      ids.push(String(row.id))
    }
  }
  let pairs = 0
  let usedTags = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const ids of byTag.values()) {
      const df = ids.length
      if (df < 2 || df > Math.max(2, dfMax)) continue
      usedTags += 1
      const conf = df <= 2 ? 0.6 : df <= 6 ? 0.45 : 0.3
      for (let i = 0; i < ids.length && pairs < maxPairs; i += 1) {
        for (let j = i + 1; j < ids.length && pairs < maxPairs; j += 1) {
          upsertEdge(db, { fromId: ids[i], toId: ids[j], etype: 'similar', source: 'tag', conf, weight: 0.6 })
          pairs += 1
        }
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw err
  }
  return { nodes: rows.length, tags: usedTags, edges: pairs }
}

/**
 * 新节点 ADD 后给 top-K 相似邻居追加注记（不改正文/tags；受保护节点也只追加注记）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, tags: string[], identity?: { userId?: string, roleId?: string, workspace?: string } }} newNode
 * @param {{ topK?: number, minScore?: number, traceId?: string, maxNodes?: number }} [opts]
 * @returns {{ updated: number, skipped: number, capped: number }}
 */
export function applyNeighborNotes(db, newNode, opts = {}) {
  const tags = normalizeTags(newNode?.tags)
  if (!newNode?.id || tags.length === 0) return { updated: 0, skipped: 0, capped: 0 }
  const topK = Math.max(0, Math.floor(Number(opts.topK ?? 3)))
  const minScore = clamp01(opts.minScore ?? 0.3, 0.3)
  const wanted = new Set(tags.map((t) => t.toLowerCase()))

  const rows = db.prepare('SELECT id, tags, context_note, user_id, role_id, workspace FROM nodes WHERE status=? AND id<>? LIMIT ?')
    .all('active', String(newNode.id), Math.max(1, Number(opts.maxNodes ?? 500)))
  const ident = newNode.identity || {}
  const candidates = []
  for (const row of rows) {
    // 只改同隔离面的邻居：共享('')可见，跨人/跨端不互写注记。
    if (String(ident.userId || '') && String(row.user_id || '') && String(row.user_id) !== String(ident.userId)) continue
    if (String(ident.roleId || '') && String(row.role_id || '') && String(row.role_id) !== String(ident.roleId)) continue
    if (String(ident.workspace || '') && String(row.workspace || '') && String(row.workspace) !== String(ident.workspace)) continue
    const rowTags = parseTags(row.tags).map((t) => t.toLowerCase())
    if (rowTags.length === 0) continue
    const overlap = rowTags.filter((t) => wanted.has(t)).length
    const union = new Set([...rowTags, ...wanted]).size
    const score = union > 0 ? overlap / union : 0
    if (score < minScore) continue
    candidates.push({ id: String(row.id), note: String(row.context_note || ''), score })
  }
  candidates.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))

  const ts = now()
  let updated = 0
  let skipped = 0
  let capped = 0
  for (const row of candidates.slice(0, topK)) {
    const next = evolutionNote(row.note, tags, NOTE_MAX)
    if (next === row.note) { skipped += 1; continue }
    if (next.length > NOTE_MAX) { capped += 1; continue }
    db.prepare('UPDATE nodes SET context_note=?, updated_at=? WHERE id=?').run(next, ts, row.id)
    db.prepare(`INSERT INTO evolution (ts,from_id,to_id,field,old_value,new_value,trace_id)
      VALUES (?,?,?,?,?,?,?)`).run(ts, String(newNode.id), row.id, 'context_note', row.note, next, String(opts.traceId || ''))
    updated += 1
  }
  return { updated, skipped, capped }
}

/**
 * 1 跳扩散：从 top-K 种子命中找 topic/reference 边对端（双向），返回候选行。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ seeds: Array<{ id: string }>, identity?: any, minConf?: number, cap?: number }} q
 */
export function expandOneHop(db, { seeds = [], identity = {}, minConf = 0.6, cap = 20 } = {}) {
  const ids = [...new Set(seeds.slice(0, 3).map((s) => String(s?.id || '')).filter(Boolean))]
  if (ids.length === 0) return []
  const marks = ids.map(() => '?').join(',')
  const filter = []
  const params = []
  for (const [col, v] of [['user_id', identity?.userId], ['role_id', identity?.roleId], ['workspace', identity?.workspace]]) {
    if (!v) continue
    filter.push(`(n.${col} = '' OR n.${col} = ?)`)
    params.push(String(v))
  }
  const where = filter.length ? ` AND ${filter.join(' AND ')}` : ''
  const sql = `SELECT e.from_id, e.to_id, e.conf, n.id, n.text, n.level, n.memory_type, n.source, n.created_at, n.last_hit_at
    FROM edges e JOIN nodes n ON n.id = CASE WHEN e.from_id IN (${marks}) THEN e.to_id ELSE e.from_id END
    WHERE (e.from_id IN (${marks}) OR e.to_id IN (${marks}))
      AND e.etype IN ('topic','reference') AND e.conf >= ?
      AND n.status = 'active'${where}
    LIMIT ?`
  let rows
  try {
    rows = db.prepare(sql).all(...ids, ...ids, ...ids, clamp01(minConf, 0.6), ...params, Math.max(1, Number(cap) || 20))
  } catch { return [] }
  const out = []
  const seen = new Set(ids)
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push({ ...row, hops: 1, via_conf: row.conf })
    if (out.length >= cap) break
  }
  return out
}

/** 边/演化统计（面板 /edges 用）。 */
export function relationStats(db) {
  const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
  return {
    edges: one('SELECT count(*) AS n FROM edges'),
    by_type: db.prepare('SELECT etype, count(*) AS n FROM edges GROUP BY etype').all(),
    evolution: one('SELECT count(*) AS n FROM evolution'),
    noted_nodes: one("SELECT count(*) AS n FROM nodes WHERE context_note <> ''"),
  }
}
