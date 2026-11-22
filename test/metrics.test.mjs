/**
 * 观测层单测（架构书 §9.1 / 审计 backlog P1）：十一项指标口径、7 日 series、
 * metrics 落表幂等、/stats 契约键。
 *
 * 全部在临时库上用手工构造的行验证——断言的是真实 SQL 聚合结果与真实库行，
 * 不是"函数没抛错"。锚定固定时钟 NOW，日历窗口由本测试独立按本地时区算一遍，
 * 避免"测试跟着实现错"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../src/core/db.js'
import { LocalBackend } from '../src/core/backend.js'
import { METRIC_DEFS, TARGETS, computeMetrics, writeMetricsRows } from '../src/core/metrics.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'

const NOW = 1_700_000_000 // 固定时钟（秒）
const pad = (n) => String(n).padStart(2, '0')
const anchor = new Date(NOW * 1000)

/** 锚点日的本地日期戳（测试独立算，不 import 实现里的私有函数）。 */
function dayKey(offset = 0) {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 锚点日前后 offset 天的本地 00:00（秒）。 */
function dayStart(offset = 0) {
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, 0, 0, 0, 0).getTime() / 1000
}

const DAY = dayKey(0)
const METRIC_NAMES = METRIC_DEFS.map((def) => def.name).sort()

/** 临时库：schema 由 openDb 建好；返回库文件路径供 db_size_bytes / 日报用。 */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-metrics-'))
  return { dir, dbFile: join(dir, 'memory.db'), db: openDb(dir) }
}

function insertNode(db, { id, text, status = 'active', vectorState = 'none', createdAt = NOW }) {
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'normal','semantic','owner',?,'','u1','web','[]','',1,0,?,'test','',?,?)`).run(
    id, text, contentHash(text), bigrams(text), status, vectorState, createdAt, createdAt,
  )
}

function insertRecall(db, {
  ts, query = '规则', hitIds = [], chars = 0, injected = 0, used = 0, source = 'hook',
}) {
  db.prepare(`INSERT INTO recalls
    (ts,trace_id,query,hit_ids,chars,injected,used,elapsed_ms,user_id,role_id,workspace,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ts, '', query, JSON.stringify(hitIds), chars, injected, used, 3, 'u1', '', 'web', source,
  )
}

function insertJob(db, { kind = 'consolidate', state = 'done', attempts = 0, lastError = null, updatedAt = NOW }) {
  db.prepare(`INSERT INTO jobs (kind,state,attempts,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(kind, state, attempts, lastError, updatedAt, updatedAt)
}

function insertWrite(db, { ts = NOW, action = 'ADD' }) {
  db.prepare(`INSERT INTO writes (ts,trace_id,action,reason,mode,user_id,role_id,workspace)
    VALUES (?,?,?,?,'auto','u1','','web')`).run(ts, '', action, 'test')
}

/**
 * 主夹具（手算口径见各断言附近的注释）：
 *  - 今日 4 次召回：有命中 3、注入 2、采纳 1、零注入（无命中）1、注入字数 10/20 → 均值 15
 *  - 昨日 1 次零命中召回；8 天前 1 次注入（窗口外，证明窗口真的裁掉了它）
 *  - 7 日窗口内 job：done 3 / failed 1；8 天前 done 1（窗口外）
 *  - 7 日窗口内 writes：REJECT 2 / 共 8；8 天前 REJECT 1（窗口外）
 *  - pending 节点 1 条，created_at = NOW-600 → 滞留 10 分钟
 *  - metrics 表预置两条 precision_at_3（旧 0.5、新 0.87）证明"读最近一天"
 */
function seed() {
  const { dir, db, dbFile } = freshDb()
  insertNode(db, { id: 'n1', text: '网关回调端口规则' })
  insertNode(db, { id: 'n2', text: '记忆检索预算规则' })
  insertNode(db, { id: 'n3', text: '向量化待处理规则', vectorState: 'pending', createdAt: NOW - 600 })
  db.prepare('INSERT INTO edges (from_id,to_id,etype,source,conf,weight,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('n1', 'n2', 'similar', 'tag', 0.5, 0.6, NOW)

  insertRecall(db, { ts: dayStart(0) + 60, query: '规则一', hitIds: ['n1'], chars: 10, injected: 1 })
  insertRecall(db, { ts: dayStart(0) + 120, query: '零命中一', hitIds: [], chars: 0, injected: 0 })
  insertRecall(db, { ts: dayStart(0) + 180, query: '规则二', hitIds: ['n2'], chars: 20, injected: 1, used: 1 })
  insertRecall(db, { ts: dayStart(0) + 240, query: '命中未注入', hitIds: ['n3'], chars: 0, injected: 0 })
  insertRecall(db, { ts: dayStart(-1) + 60, query: '零命中二', hitIds: [], chars: 0, injected: 0 })
  insertRecall(db, { ts: dayStart(-8) + 60, query: '窗口外', hitIds: ['n1'], chars: 5, injected: 1, used: 1 })

  insertJob(db, { kind: 'consolidate', state: 'done', updatedAt: dayStart(0) + 10 })
  insertJob(db, { kind: 'reflect', state: 'done', updatedAt: dayStart(-1) + 10 })
  insertJob(db, { kind: 'report', state: 'done', updatedAt: dayStart(-3) + 10 })
  insertJob(db, { kind: 'write', state: 'failed', attempts: 3, lastError: 'boom', updatedAt: dayStart(0) + 20 })
  insertJob(db, { kind: 'archive', state: 'done', updatedAt: dayStart(-9) + 10 })
  insertJob(db, { kind: 'vector', state: 'queued', updatedAt: dayStart(0) + 30 })

  for (let i = 0; i < 6; i += 1) insertWrite(db, { ts: dayStart(0) + 100 + i, action: 'ADD' })
  insertWrite(db, { ts: dayStart(0) + 200, action: 'REJECT' })
  insertWrite(db, { ts: dayStart(0) + 201, action: 'REJECT' })
  insertWrite(db, { ts: dayStart(-8) + 100, action: 'REJECT' })

  db.prepare('INSERT INTO metrics (day,name,value) VALUES (?,?,?)').run('2020-01-01', 'precision_at_3', 0.5)
  db.prepare('INSERT INTO metrics (day,name,value) VALUES (?,?,?)').run('2022-06-01', 'precision_at_3', 0.87)
  db.prepare('INSERT INTO metrics (day,name,value) VALUES (?,?,?)').run('2022-06-01', 'ident_hit_rate', 1)

  return { dir, db, dbFile }
}

test('十一项指标：手算值 + targets 契约 + 7 日 series 今天为最新', () => {
  const { db, dbFile } = seed()
  try {
    const m = computeMetrics(db, { day: DAY, now: NOW, dbFile })
    assert.equal(m.day, DAY)
    assert.deepEqual(Object.keys(m.values).sort(), METRIC_NAMES)
    assert.equal(METRIC_NAMES.length, 11)

    // 目标：与架构书 §9.1 初始目标逐键相等（键名不得改）。
    assert.deepEqual(m.targets, {
      precision_at_3: 0.9,
      ident_hit_rate: 1.0,
      zero_injection_rate: 0.1,
      adoption_rate: 0.35,
      idle_rate: 0.65,
      inject_chars_avg: 1500,
      pending_age_max_min: 10,
      job_success_7d: 0.95,
      write_reject_rate: 0.2,
    })
    assert.deepEqual(m.targets, TARGETS)

    // 零注入率：hit_ids='[]' 的召回 2 / 全部召回 5 = 0.4（窗口外那次不进分母）。
    assert.equal(m.values.zero_injection_rate, 0.4)
    // 采纳率：used=1 且 injected=1 的 1 / injected=1 的 2 = 0.5；空转率 = 1 - 0.5。
    assert.equal(m.values.adoption_rate, 0.5)
    assert.equal(m.values.idle_rate, 0.5)
    // 注入字数均值：(10 + 20) / 2 = 15（injected=0 的 chars=0 不进分母）。
    assert.equal(m.values.inject_chars_avg, 15)
    // 作业成功率：done 3 / (3+1) = 0.75（queued 与窗口外 done 都不计）。
    assert.equal(m.values.job_success_7d, 0.75)
    // 写入拒绝率：REJECT 2 / 全部 8 = 0.25。
    assert.equal(m.values.write_reject_rate, 0.25)
    // 待向量滞留：NOW - (NOW-600) = 600s = 10 分钟。
    assert.equal(m.values.pending_age_max_min, 10)
    // FTS 对齐：3 节点 = 3 条索引行。
    assert.equal(m.values.fts_aligned, true)
    // 库体积：主库文件 + -wal（此刻可能还没 WAL，主库必然 > 0；有 WAL 时必须两段相加）。
    assert.ok(m.values.db_size_bytes > 0)
    assert.ok(m.values.db_size_bytes >= statSync(dbFile).size)
    const wal = `${dbFile}-wal`
    if (existsSync(wal)) {
      assert.equal(m.values.db_size_bytes, statSync(dbFile).size + statSync(wal).size)
    }
    // 评测类指标只读 metrics 表最近一天：0.87（不是 0.5）。
    assert.equal(m.values.precision_at_3, 0.87)
    assert.equal(m.values.ident_hit_rate, 1)

    // series：恒 7 项、最旧 → 今天。
    assert.equal(m.series.length, 7)
    assert.equal(m.series[0].day, dayKey(-6))
    assert.equal(m.series.at(-1).day, DAY)
    assert.deepEqual(m.series.at(-1), {
      day: DAY, recalls: 4, withHits: 3, injected: 2, adopted: 1, zeroHit: 1, avgChars: 15,
    })
    assert.deepEqual(m.series.at(-2), {
      day: dayKey(-1), recalls: 1, withHits: 0, injected: 0, adopted: 0, zeroHit: 1, avgChars: null,
    })
    // 7 日合计 5 次（8 天前那次被窗口裁掉）。
    assert.equal(m.series.reduce((sum, item) => sum + item.recalls, 0), 5)
    assert.equal(m.series.reduce((sum, item) => sum + item.zeroHit, 0), 2)
    assert.equal(m.series.reduce((sum, item) => sum + item.injected, 0), 2)
  } finally { closeDb(db) }
})

test('fts 不齐（节点绕过触发器插入）→ fts_aligned=false', () => {
  const { db, dbFile } = freshDb()
  try {
    insertNode(db, { id: 'n-ok', text: '正常进索引的节点' })
    // 模拟触发器缺失/索引写坏：节点进内容表但没进 FTS 索引。
    db.exec('DROP TRIGGER nodes_ai')
    db.prepare(`INSERT INTO nodes
      (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
       context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
      VALUES (?,?,?,?,'normal','semantic','owner','active','','u1','web','[]','',1,0,'none','test','',?,?)`).run(
      'n-miss', '没进索引的节点', contentHash('没进索引的节点'), bigrams('没进索引的节点'), NOW, NOW,
    )
    const m = computeMetrics(db, { day: DAY, now: NOW, dbFile })
    assert.equal(m.values.fts_aligned, false)
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2)
    assert.notEqual(
      Number(db.prepare('SELECT count(*) AS n FROM nodes_fts_docsize').get().n), 2,
      '夹具必须真的让索引行数与节点数不一致',
    )
  } finally { closeDb(db) }
})

test('空库：无评测 → precision_at_3/ident_hit_rate 为 null；无召回/作业/写入 → 相应比率为 null', () => {
  const { db } = freshDb()
  try {
    // 故意不传 dbFile：体积统计只认调用方给的路径，纯函数不猜。
    const m = computeMetrics(db, { day: DAY, now: NOW })
    assert.equal(m.values.precision_at_3, null)
    assert.equal(m.values.ident_hit_rate, null)
    assert.equal(m.values.zero_injection_rate, null)
    assert.equal(m.values.adoption_rate, null)
    assert.equal(m.values.idle_rate, null)
    assert.equal(m.values.inject_chars_avg, null)
    assert.equal(m.values.job_success_7d, null)
    assert.equal(m.values.write_reject_rate, null)
    // 无 pending 时滞留为 0（不是 null：0 表示"没有积压"这个确定事实）。
    assert.equal(m.values.pending_age_max_min, 0)
    assert.equal(m.values.fts_aligned, true)
    // 不传 dbFile 时体积按 0（纯函数不猜路径）。
    assert.equal(m.values.db_size_bytes, 0)
    assert.equal(m.series.length, 7)
    assert.ok(m.series.every((item) => item.recalls === 0 && item.injected === 0 && item.avgChars === null))
    // 非法输入显式抛错，不静默算错天。
    assert.throws(() => computeMetrics(db, { day: '2023/11/15' }), /invalid day/)
    assert.throws(() => computeMetrics(null), /db required/)
  } finally { closeDb(db) }
})

test('writeMetricsRows：只写数字型、UPSERT 幂等、fts_aligned 不落表', () => {
  const { db, dbFile } = seed()
  try {
    const m = computeMetrics(db, { day: DAY, now: NOW, dbFile })
    const first = writeMetricsRows(db, m)
    assert.equal(first.day, DAY)
    assert.equal(first.written, 10, '十一项里只有 fts_aligned 是布尔，不落表')

    const rows = db.prepare('SELECT name, value FROM metrics WHERE day = ?').all(DAY)
    assert.equal(rows.length, 10)
    const byName = new Map(rows.map((row) => [row.name, Number(row.value)]))
    assert.equal(byName.get('inject_chars_avg'), 15)
    assert.equal(byName.get('zero_injection_rate'), 0.4)
    assert.equal(byName.get('pending_age_max_min'), 10)
    assert.equal(byName.has('fts_aligned'), false)
    assert.deepEqual([...byName.keys()].sort(), METRIC_NAMES.filter((name) => name !== 'fts_aligned'))
    // 评测指标也落表：连同两条历史值共 3 行。
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM metrics WHERE name='precision_at_3'").get().n), 3)

    // 同一天再写一次：行数不变、值被覆盖（日报可反复重算）。
    const second = writeMetricsRows(db, { day: DAY, values: { ...m.values, inject_chars_avg: 99 } })
    assert.equal(second.written, 10)
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM metrics WHERE day = ?').get(DAY).n), 10)
    assert.equal(
      Number(db.prepare('SELECT value FROM metrics WHERE day = ? AND name = ?').get(DAY, 'inject_chars_avg').value),
      99,
    )
    assert.throws(() => writeMetricsRows(db, { day: 'bad', values: {} }), /invalid metrics.day/)
    assert.throws(() => writeMetricsRows(db, { values: {} }), /invalid metrics.day/)
  } finally { closeDb(db) }
})

test('embed 开关：关时 pending 滞留按 0 记（§9.1「embed 关时为 0」）', () => {
  const { db, dbFile } = seed()
  try {
    // 同一份数据：开 embed 时滞留 10 分钟（没有消费方就会无限涨，展示真实值等于每天一个 ✗）。
    const on = computeMetrics(db, { day: DAY, now: NOW, dbFile, embedEnabled: true })
    assert.equal(on.values.pending_age_max_min, 10)
    const off = computeMetrics(db, { day: DAY, now: NOW, dbFile, embedEnabled: false })
    assert.equal(off.values.pending_age_max_min, 0)
    // 关的是"滞留时长"，不是"有没有待处理"：其余指标一个都不变。
    assert.equal(off.values.db_size_bytes, on.values.db_size_bytes)
    assert.equal(off.values.fts_aligned, on.values.fts_aligned)
    assert.deepEqual(off.series, on.series)
  } finally { closeDb(db) }
})

test('stats：metrics/series/recent_failures 与既有 totals/health 键并存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-metrics-stats-'))
  const backend = new LocalBackend({ dataDir: dir, useWorker: false })
  try {
    backend.withDb((db) => {
      insertNode(db, { id: 's1', text: '面板统计样本节点' })
      for (let i = 1; i <= 7; i += 1) {
        insertJob(db, {
          kind: `kind-${i}`, state: 'failed', attempts: 3, lastError: `err-${i}`, updatedAt: NOW + i,
        })
      }
      // 比所有 failed 都新的 queued 行：recent_failures 只能取 state=failed。
      insertJob(db, { kind: 'queued-newest', state: 'queued', updatedAt: NOW + 1000 })
    })
    const st = await backend.stats()

    // 既有契约：一个键都不许少。
    assert.deepEqual(Object.keys(st.totals).sort(),
      ['edges', 'injected_chars_today', 'nodes_active', 'nodes_total', 'recalls_today'])
    assert.equal(st.totals.nodes_total, 1)
    assert.equal(typeof st.schema_version, 'string')
    assert.ok(st.generated_at)
    for (const key of ['fts_aligned', 'fts_rows', 'fts_bi_rows', 'vector_pending', 'jobs', 'pressure']) {
      assert.ok(key in st.health, `health.${key} 不得丢`)
    }
    for (const key of ['running', 'queued', 'failed', 'last_error', 'recent_failures']) {
      assert.ok(key in st.health.jobs, `health.jobs.${key} 不得丢`)
    }

    // 新增契约：metrics.values 十一项、targets 九项、series 恰好 7 项。
    const today = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    })()
    assert.equal(st.metrics.day, today)
    assert.deepEqual(Object.keys(st.metrics.values).sort(), METRIC_NAMES)
    assert.deepEqual(st.metrics.targets, TARGETS)
    assert.equal(st.series.length, 7)
    assert.equal(st.series.at(-1).day, today)
    assert.deepEqual(Object.keys(st.series[0]).sort(),
      ['adopted', 'avgChars', 'day', 'injected', 'recalls', 'withHits', 'zeroHit'])
    assert.equal(st.health.vector_pending, 0)
    assert.equal(st.metrics.values.pending_age_max_min, 0)
    assert.equal(st.metrics.values.fts_aligned, true)
    assert.ok(st.metrics.values.db_size_bytes > 0, 'stats 必须带上真实库文件路径')

    // recent_failures：最近 5 条 failed、updated_at 降序、键集合固定。
    const recent = st.health.jobs.recent_failures
    assert.equal(recent.length, 5)
    assert.deepEqual(Object.keys(recent[0]).sort(), ['attempts', 'id', 'kind', 'last_error', 'state', 'updated_at'])
    assert.ok(recent.every((row) => row.state === 'failed'))
    assert.deepEqual(recent.map((row) => row.last_error), ['err-7', 'err-6', 'err-5', 'err-4', 'err-3'])
    for (let i = 1; i < recent.length; i += 1) {
      assert.ok(recent[i - 1].updated_at > recent[i].updated_at, 'updated_at 必须降序')
    }
    assert.equal(st.health.jobs.failed, 7)
  } finally { backend.dispose() }
})
