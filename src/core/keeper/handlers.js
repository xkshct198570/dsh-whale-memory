/**
 * keeper 默认 handlers：巩固（去重 + 主题边）、归档清理、向量批处理、日报落表。
 *
 * 拆分（P2b）：handler 与专用批处理/渲染 helper 在本文件；调度状态机在 ./scheduler.js，
 * 通用小工具在 ./util.js。依赖方向：core → shared；不 import scheduler（避免环）。
 * I/O 边界：读写 jobs / nodes / edges / writes（audit）/ metrics（日报落表）并写 reports 目录；
 * 日报统计只读 recalls；不碰 FTS、不碰召回注入；write/reflect 的 handler 由 index.js 接线，这里不注册。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bool, num, value } from '../../shared/config-values.js'
import { METRIC_DEFS, computeMetrics, writeMetricsRows } from '../metrics.js'
import { parseTags, rebuildTagEdges, upsertEdge } from '../relations.js'
import { toSeconds } from './util.js'
import { dayStamp } from '../../shared/day-stamp.js'

/** vector 每次最多处理的 pending 条数。 */
const VECTOR_BATCH = 32

/** text_hash 重复收敛每批最多归档条数（审计行同批上限，写连接保持短事务）。 */
const DEDUPE_BATCH = 200
/** 来源等级：owner > self > group > web/tool > import（writer SOURCE_MAP 的语义优先级）。 */
const SOURCE_RANK = { owner: 5, self: 4, group: 3, web: 2, tool: 2, import: 1 }

/**
 * 同身份 text_hash 重复 active 节点收敛（架构书 §8.2）。
 *
 * 为什么必须收敛：去重只在写入决策时拦"新事件"，重复历史（导入/多来源同步）仍会堆出
 * 同身份同文多行，检索会把同一事实算多次、面板也难以人工清理。
 * 保留来源等级最高者（owner>self>group>web/tool>import），其余置 archived 并逐条留审计。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ batch?: number, maxNodes?: number, nowSec?: number }} [opts]
 * @returns {{ merged: number }} merged = 本批归档条数（≤ batch）
 */
export function convergeDuplicateHashes(db, { batch = DEDUPE_BATCH, maxNodes = 5000, nowSec = Date.now() / 1000 } = {}) {
  const limit = Math.max(1, Math.floor(Number(batch) || DEDUPE_BATCH))
  // 规则镜像不参与「用户事实去重」：mirror 的 source=owner 会让它挤掉用户同文事实。
  // 口径与 v4 唯一索引、writer.findDup 一致（origin='rule:*' 豁免）。
  const rows = db.prepare(`SELECT id, text_hash, source, created_at, user_id, role_id, workspace
    FROM nodes WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')
    ORDER BY created_at, id LIMIT ?`).all(Math.max(1, Number(maxNodes) || 5000))
  const groups = new Map()
  for (const row of rows) {
    const hash = String(row.text_hash || '')
    if (!hash) continue
    // 身份分区必须完全相同（共享 '' 也是同一分区）；跨人/跨端同文不是重复。
    const key = [row.user_id ?? '', row.role_id ?? '', row.workspace ?? '', hash].join('\u0000')
    let list = groups.get(key)
    if (!list) { list = []; groups.set(key, list) }
    list.push(row)
  }

  const doomed = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort((a, b) =>
      (SOURCE_RANK[String(b.source)] ?? 0) - (SOURCE_RANK[String(a.source)] ?? 0) ||
      Number(a.created_at || 0) - Number(b.created_at || 0) ||
      (String(a.id) < String(b.id) ? -1 : 1))
    for (const row of list.slice(1)) {
      doomed.push(row)
      if (doomed.length >= limit) break
    }
    if (doomed.length >= limit) break
  }
  if (doomed.length === 0) return { merged: 0 }

  const ts = Number(nowSec) || Date.now() / 1000
  db.exec('BEGIN IMMEDIATE')
  let merged = 0
  try {
    const archive = db.prepare("UPDATE nodes SET status='archived', updated_at=? WHERE id=? AND status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')")
    const audit = db.prepare(`INSERT INTO writes (ts,trace_id,action,node_id,reason,mode,user_id,role_id,workspace)
      VALUES (?,?,'CONSOLIDATE',?,'dedupe_hash','auto',?,?,?)`)
    for (const row of doomed) {
      const info = archive.run(ts, String(row.id))
      if (Number(info?.changes || 0) === 0) continue
      audit.run(ts, '', String(row.id), String(row.user_id ?? ''), String(row.role_id ?? ''), String(row.workspace ?? ''))
      merged += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw err
  }
  return { merged }
}

/**
 * 主题边生成（架构书 §7.1 的扩散链路入口）：同身份、同 tag 小群体内连 `topic` 边。
 *
 * 为什么放在巩固 job：边是整批重建的派生数据，写入路径只负责事实，不在每次写时现连。
 * 主题边只连同身份分区（user_id/role_id/workspace 完全相同，共享 '' 同一分区），
 * 跨人/跨端不连——否则扩散会把别人的记忆带进本会话。
 * 置信口径：两节点共享 tag 数 ≥2 → 0.8，否则 0.6（同 tag 一对即 0.6）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dfMax?: number, maxNodes?: number, maxPairs?: number }} [opts]
 * @returns {{ edges: number, tags: number }} edges=新建/升级的 pair 数，tags=参与的分区-tag 组数
 */
export function buildTopicEdges(db, { dfMax = 12, maxNodes = 5000, maxPairs = 5000 } = {}) {
  const rows = db.prepare('SELECT id, tags, user_id, role_id, workspace FROM nodes WHERE status=? ORDER BY id LIMIT ?')
    .all('active', Math.max(1, Number(maxNodes) || 5000))
  /** @type {Map<string, { ids: string[], tagSets: Map<string, Set<string>> }>} */
  const groups = new Map()
  for (const row of rows) {
    const partition = [row.user_id ?? '', row.role_id ?? '', row.workspace ?? ''].join('\u0000')
    const tagSet = new Set(parseTags(row.tags).map((t) => t.toLowerCase()))
    if (tagSet.size === 0) continue
    const id = String(row.id)
    for (const tag of tagSet) {
      const key = `${partition}\u0000${tag}`
      let group = groups.get(key)
      if (!group) { group = { ids: [], tagSets: new Map() }; groups.set(key, group) }
      group.ids.push(id)
      group.tagSets.set(id, tagSet)
    }
  }

  const max = Math.max(1, Math.floor(Number(maxPairs) || 5000))
  const seenPairs = new Set()
  let pairs = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const group of groups.values()) {
      const ids = group.ids
      if (ids.length < 2 || ids.length > Math.max(2, Number(dfMax) || 12)) continue
      for (let i = 0; i < ids.length && pairs < max; i += 1) {
        for (let j = i + 1; j < ids.length && pairs < max; j += 1) {
          const a = ids[i] < ids[j] ? ids[i] : ids[j]
          const b = ids[i] < ids[j] ? ids[j] : ids[i]
          const pairKey = `${a}\u0000${b}`
          if (seenPairs.has(pairKey)) continue
          const tagA = group.tagSets.get(a)
          const tagB = group.tagSets.get(b)
          if (!tagA || !tagB) continue
          let shared = 0
          for (const tag of tagA) if (tagB.has(tag)) shared += 1
          if (shared === 0) continue
          seenPairs.add(pairKey)
          upsertEdge(db, {
            fromId: a, toId: b, etype: 'topic', source: 'reflect',
            conf: shared >= 2 ? 0.8 : 0.6, weight: 0.6,
          })
          pairs += 1
        }
      }
      if (pairs >= max) break
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw err
  }
  return { edges: pairs, tags: groups.size }
}

/**
 * 指标值渲染：null 表示"未接入"（评测没跑/没有召回），布尔指标用 ✓/✗。
 * 为什么单位在渲染层定：metrics.js 只存纯数值，展示单位（%、字、分钟、MB）随日报/面板变，
 * 存成字符串会让 metrics 表无法做算术和曲线。
 * @param {{ fmt: string }} def METRIC_DEFS 的一项
 * @param {unknown} value computeMetrics 产出的原始值
 * @returns {string}
 */
function metricCell(def, value) {
  if (value === null || value === undefined) return '未接入'
  if (value === true) return '✓'
  if (value === false) return '✗'
  const num = Number(value)
  if (!Number.isFinite(num)) return '未接入'
  switch (def.fmt) {
    case 'rate': return rateText(num)
    case 'chars': return `${Math.round(num)} 字`
    case 'min': return `${num.toFixed(1)} 分钟`
    case 'bytes': return `${(num / 1024 / 1024).toFixed(2)} MB`
    default: return String(value)
  }
}

/**
 * 目标列渲染：只有可判达标的指标有目标（FTS 对齐/库体积是观测项，标 —）。
 * @param {{ dir: string|null, target: number|null, fmt: string }} def
 * @returns {string}
 */
function targetCell(def) {
  if (def.target === null || def.target === undefined) return '—'
  const cmp = def.dir === 'min' ? '≥' : '≤'
  return `${cmp} ${def.fmt === 'rate' ? rateText(def.target) : def.target}`
}

/**
 * 达标列渲染：值缺失或指标本身不判达标时给 —，不把"没数据"判成"不达标"。
 * @param {{ dir: string|null, target: number|null }} def
 * @param {unknown} value
 * @returns {string}
 */
function passCell(def, value) {
  if (value === null || value === undefined || typeof value !== 'number' || def.target === null || def.target === undefined) return '—'
  const ok = def.dir === 'min' ? value >= def.target : value <= def.target
  return ok ? '✓' : '✗'
}

/** 比率 → 百分比文本（保留 1 位，避免 0.3333333333333333 刷屏）。 */
function rateText(value) {
  return `${(Number(value) * 100).toFixed(1)}%`
}

/**
 * Top10 表里的查询截断：recalls.query 最长 500 字（整段用户提示词），原样入表会把
 * 日报撑成一篇聊天记录，也看不出聚合意图；80 字足够识别同一类查询。
 * @param {unknown} query
 * @returns {string}
 */
function shortQuery(query) {
  const text = String(query ?? '')
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/** Markdown 表格单元格转义：query 里可能有 | 或换行，不转义会把表结构打断。 */
function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 两个审计 Top10 表的渲染（空数据写「（无）」，不留空表头）。 */
function countTable(rows, column) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ['（无）']
  return [
    `| 查询 | ${column} |`,
    '| --- | --- |',
    ...list.map((row) => `| ${markdownCell(shortQuery(row.query))} | ${Number(row.n || 0)} |`),
  ]
}

/** 24h 失败 job 表：attempts 是已失败重试次数，last_error 是最后一次原因。 */
function failedTable(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ['（无）']
  return [
    '| kind | attempts | last_error | updated_at |',
    '| --- | --- | --- | --- |',
    ...list.map((row) => `| ${markdownCell(row.kind)} | ${Number(row.attempts || 0)} | ${markdownCell(row.last_error || '')} | ${clockText(row.updated_at)} |`),
  ]
}

/** 本地时钟文本 YYYY-MM-DD HH:mm（日报里的 updated_at 人读用）。 */
function clockText(seconds) {
  const d = new Date(toSeconds(seconds) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 默认 handlers 安装（createKeeper 内调用；单独拆函数便于阅读）。 */
export function installDefaultHandlers(keeper, deps) {
  const { store, config = {}, log = () => {}, nowSec } = deps

  keeper.register('consolidate', async () => {
    return store.withDb((db) => {
      // 顺序：先收敛同文重复（否则重复节点会参与建边），再重建 tag 相似边与主题边，最后跑 TTL。
      // 主题边只由巩固 job 批量生成：写入路径不现连边，扩散才有一条稳定、可解释的链路。
      const dedupe = convergeDuplicateHashes(db, { nowSec: nowSec() })
      const edges = rebuildTagEdges(db, {})
      const topics = buildTopicEdges(db, {})
      const ts = nowSec()
      // TTL：过期的 active 节点降级 stale（不物理删，召回自然失效）。
      const info = db.prepare(`UPDATE nodes SET status='stale', updated_at=?
        WHERE status='active' AND expired_at IS NOT NULL AND expired_at < ?`).run(ts, ts)
      return {
        edges: Number(edges?.edges || 0), tags: Number(edges?.tags || 0),
        topic_edges: Number(topics?.edges || 0), merged: Number(dedupe?.merged || 0),
        stale: Number(info?.changes || 0),
      }
    })
  })

  keeper.register('archive', async (payload = {}) => {
    // retentionDays 走 config-values.num 解包：字段现在是普通 number，但同一段配置里还有
    // .volatile() 的 Ref（如 redact）；一旦它也变成 Ref，裸 Number() 会恒 NaN→0 = 静默关掉清理。
    const days = num(config?.privacy?.retentionDays, 0)
    if (!(days > 0)) return { skipped: 'retention_disabled' }
    const cutoff = nowSec() - days * 86400
    // 分区口径：物理删除是破坏性动作，默认只清"本机配置的身份分区"（config.identity），
    // 不碰别人的分区；payload.identity 可显式指定（同步/测试用）。
    // 身份三元组全是 .volatile() Ref，必须经 value() 解包，否则恒空 = 静默退化成全局清理。
    const configuredIdentity = {
      userId: value(config?.identity?.userId, ''),
      roleId: value(config?.identity?.roleId, ''),
      workspace: value(config?.identity?.workspace, ''),
    }
    // payload.identity 显式给对象时以它为准（同步/测试）；给 `{}` 表示"恢复全局清理"。
    // 注意破坏性语义：默认口径从旧版"全库清理"改为"配置身份分区清理"，共享('')内容不删。
    const requested = payload?.identity && typeof payload.identity === 'object' ? payload.identity : null
    const scope = archiveScope(requested || configuredIdentity)
    return store.withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      let deleted = 0
      try {
        const info = db.prepare(`DELETE FROM nodes WHERE status='archived' AND updated_at < ?${scope.sql}`)
          .run(cutoff, ...scope.params)
        deleted = Number(info?.changes || 0)
        db.prepare(`INSERT INTO writes (ts,trace_id,action,node_id,reason,mode)
          VALUES (?,?,'ARCHIVE',NULL,?,'auto')`).run(
          nowSec(), '', `retention_days=${days}; cutoff=${cutoff}; deleted=${deleted}${scope.note}`,
        )
        db.exec('COMMIT')
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* noop */ }
        throw err
      }
      log(`[whale-memory] keeper archive deleted=${deleted} days=${days}`)
      return { deleted, cutoff, days }
    })
  })

  keeper.register('vector', async () => {
    if (!config?.embed?.enabled) return { skipped: 'embed_disabled' }
    const rows = store.withDb((db) => db.prepare(`SELECT id FROM nodes WHERE vector_state='pending' LIMIT ?`).all(VECTOR_BATCH))
    if (rows.length === 0) return { processed: 0, skipped: 'vector_empty' }
    // 本机没有嵌入实现（config.embed 只定义开关，未接 provider）：
    // 不改 vector_state、不报失败，接上实现后同一批 pending 自然重跑。
    return { pending: rows.length, skipped: 'embed_unavailable' }
  })

  keeper.register('report', async () => {
    const dbFile = typeof store.dbFile === 'string' ? store.dbFile : ''
    if (!dbFile) return { skipped: 'no_dbfile' }
    const ts = nowSec()
    const day = dayStamp(ts)
    const data = store.withDb((db) => {
      const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0)
      const stats = {
        nodes: one('SELECT count(*) AS n FROM nodes'),
        active: one("SELECT count(*) AS n FROM nodes WHERE status='active'"),
        edges: one('SELECT count(*) AS n FROM edges'),
        jobsDone: one(`SELECT count(*) AS n FROM jobs WHERE state='done' AND updated_at >= ?`, ts - 86400),
        jobsFailed: one(`SELECT count(*) AS n FROM jobs WHERE state='failed' AND updated_at >= ?`, ts - 86400),
        recalls: one('SELECT count(*) AS n FROM recalls WHERE ts >= ?', ts - 86400),
        withHits: one(`SELECT count(*) AS n FROM recalls WHERE ts >= ? AND hit_ids NOT IN ('[]','')`, ts - 86400),
        injected: one(`SELECT count(*) AS n FROM recalls WHERE ts >= ? AND injected=1`, ts - 86400),
      }
      // 「命中但未注入」是"低分命中"在没有分数列时的代理口径：检索命中了，但注入侧被
      // 预算/层级裁光。按 query 聚合才能看出反复发生的是同一类问题。
      const lowScoreHits = db.prepare(`SELECT query, count(*) AS n FROM recalls
        WHERE ts >= ? AND injected = 0 AND hit_ids NOT IN ('[]','')
        GROUP BY query ORDER BY n DESC, query LIMIT 10`).all(ts - 86400)
      const unadopted = db.prepare(`SELECT query, count(*) AS n FROM recalls
        WHERE ts >= ? AND injected = 1 AND used = 0
        GROUP BY query ORDER BY n DESC, query LIMIT 10`).all(ts - 86400)
      const failedJobs = db.prepare(`SELECT kind, attempts, last_error, updated_at FROM jobs
        WHERE state='failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20`).all(ts - 86400)
      // embed 关 → pending 滞留记 0（§9.1），日报不该每天挂一个没有消费方的 ✗。
      const metrics = computeMetrics(db, {
        day, now: ts, dbFile, embedEnabled: bool(config?.embed?.enabled, false),
      })
      // 指标落表与日报写文件同一次执行：面板读 metrics 表做历史对比时，
      // 日报当天必须已经有一行，否则"昨天日报有、今天面板没有"。
      writeMetricsRows(db, metrics)
      return { stats, lowScoreHits, unadopted, failedJobs, metrics }
    })

    const { stats, metrics } = data
    const totalJobs = stats.jobsDone + stats.jobsFailed
    const jobRate = totalJobs > 0 ? Math.round((stats.jobsDone / totalJobs) * 1000) / 10 : 100
    // 零注入不计：无命中的召回说明没得注，不算失手，不进注入率分母。
    const injectRate = stats.withHits > 0 ? Math.round((stats.injected / stats.withHits) * 1000) / 10 : 0
    const markdown = [
      `# 记忆日报 ${day}`,
      '',
      '## 规模',
      '',
      `- 节点总数：${stats.nodes}`,
      `- active：${stats.active}`,
      `- edges：${stats.edges}`,
      '',
      '## 指标（架构书 §9.1，十一项）',
      '',
      '| 指标 | 值 | 目标 | 达标 |',
      '| --- | --- | --- | --- |',
      ...METRIC_DEFS.map((def) => `| ${def.label} | ${metricCell(def, metrics.values[def.name])} | ${targetCell(def)} | ${passCell(def, metrics.values[def.name])} |`),
      '',
      `> 指标日：${metrics.day}；7 日窗口按本地自然日，与 /stats 同源。`,
      '',
      '## 近 24h 作业',
      '',
      `- 成功率：${jobRate}%（done ${stats.jobsDone} / failed ${stats.jobsFailed}）`,
      '',
      '## 近 24h 召回',
      '',
      `- 召回：${stats.recalls} 次（有命中 ${stats.withHits} 次）`,
      `- 注入：${stats.injected} 次，注入率 ${injectRate}%（零注入不计：无命中的召回不进分母）`,
      '',
      '## 命中但未注入 Top10（近 24h）',
      '',
      '> 代理口径：无分数明细列，暂以「检索有命中但 injected=0」近似「低分命中」；分数明细待 schema v3 挂账。',
      '',
      ...countTable(data.lowScoreHits, '命中次数'),
      '',
      '## 未采纳 Top10（近 24h）',
      '',
      '> 口径：injected=1 且 used=0（used 由回复引用弱信号回写：注入节点原文 10 字窗口或中文 bigram 覆盖命中即记采纳；改写幅度大的回复可能漏判）。',
      '',
      ...countTable(data.unadopted, '未采纳次数'),
      '',
      '## 近 24h 失败 job（state=failed，updated_at 降序）',
      '',
      ...failedTable(data.failedJobs),
      '',
    ].join('\n')
    const dir = join(dirname(dbFile), 'reports')
    const path = join(dir, `${day}.md`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, markdown, 'utf8')
    return { path, nodes: stats.nodes, active: stats.active, edges: stats.edges, metrics_day: metrics.day }
  })
}

/**
 * 归档清理的分区条件（破坏性删除专用）。
 *
 * 与读路径的 `列='' OR 列=值` 口径**故意不同**：读是把共享内容也让你看见，
 * 删是拿着一个分区的配置去物理删库——共享('')内容不属于任何单一分区，
 * 不能因为 A 的保留策略被连带删掉。所以这里只做严格相等，且空字段不参与。
 *
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @returns {{ sql: string, params: string[], note: string }}
 */
export function archiveScope(identity) {
  if (!identity || typeof identity !== 'object') return { sql: '', params: [], note: '; scope=all' }
  const clauses = []
  const params = []
  for (const [col, raw] of [['user_id', identity.userId], ['role_id', identity.roleId], ['workspace', identity.workspace]]) {
    const text = typeof raw === 'string' ? raw : String(raw ?? '')
    if (!text) continue
    clauses.push(`${col} = ?`)
    params.push(text)
  }
  if (clauses.length === 0) return { sql: '', params: [], note: '; scope=all' }
  return { sql: ` AND ${clauses.join(' AND ')}`, params, note: `; scope=${params.join('/')}` }
}
