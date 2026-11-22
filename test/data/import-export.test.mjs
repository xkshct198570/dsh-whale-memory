/**
 * 导入/导出保真 + 内存闸门口径回归（架构书 §8：迁移不复活、不静默丢数据）。
 *
 * 覆盖口径：
 * - 导出补 hits/last_hit_at/vector_state；导入直通状态/双时态/superseded_by，枚举非法回落默认。
 * - export→import 二次导入幂等（含 superseded/archived，不允许"复活"成新 active 节点）。
 * - 出口按身份过滤：只导出本分区 + 共享（`(列='' OR 列=?)`）。
 * - >500 字：多规则按边界拆分（tags 带 split_from、writes(SPLIT)），单规则拒绝并给出 reasons。
 * - 导入事务末尾 FTS 一致性闸：nodes 与两张 FTS 行数不等则整批回滚。
 * - schema v1 → v2 幂等迁移（writes.payload），高版本仍拒绝。
 * - 内存闸门优先 MemAvailable（含 page cache），压力判定的边界可注入。
 *
 * 说明：memory-guard 的两条用例也放这里，因为本次修复的文件白名单只允许新建本测试文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LocalBackend } from '../../src/core/backend.js'
import { ensureSchema, SCHEMA_VERSION } from '../../src/core/schema.js'
import { now } from '../../src/core/db.js'
import { availableBytes, memoryPressure, FREE_FLOOR, RSS_CEIL } from '../../src/host/memory-guard.js'

const ident = { userId: 'u1', roleId: '', workspace: 'web' }

/** 临时库 backend：每个用例独立目录，结束时关闭。 */
function fresh(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-io-'))
  return new LocalBackend({ dataDir: dir, useWorker: false, ...opts })
}

/** 解析导出 JSONL。 */
function parseJsonl(jsonl) {
  return String(jsonl || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// 1. 导入/导出保真
// ---------------------------------------------------------------------------

test('导出含 hits/last_hit_at/vector_state；export→import 保状态与双时态且二次导入幂等', async () => {
  const src = fresh()
  const dst = fresh()
  try {
    const oldText = '项目部署在测试环境 端口是 8080'
    const newText = '项目部署在测试环境 端口是 9090'
    const old = await src.write({ text: oldText, identity: ident })
    const neu = await src.write({ text: newText, identity: ident })
    assert.equal(neu.action, 'SUPERSEDE')

    const ttl = now() + 86400
    const expiring = await src.write({ text: '带 TTL 的临时事实', identity: ident, expired_at: ttl })
    assert.equal(expiring.ok, true)

    const rows = parseJsonl(await src.exportJsonl({ identity: ident }))
    assert.equal(rows.length, 3)
    const oldRow = rows.find((r) => r.id === old.id)
    for (const field of ['hits', 'last_hit_at', 'vector_state']) {
      assert.ok(field in oldRow, `导出必须带 ${field}`)
    }
    assert.equal(oldRow.status, 'superseded')
    assert.equal(oldRow.superseded_by, neu.id)
    assert.ok(Number(oldRow.invalid_at) > 0)
    assert.ok(Number(oldRow.expired_at) > 0)

    const imported = await dst.importJsonl({ jsonl: await src.exportJsonl({ identity: ident }), identity: ident })
    assert.equal(imported.ok, true)
    assert.equal(imported.added, 3)

    const importedOld = await dst.getNode(old.id)
    assert.equal(importedOld.node.status, 'superseded', 'superseded 不得在导入后复活')
    assert.equal(importedOld.node.superseded_by, neu.id)
    assert.ok(Number(importedOld.node.invalid_at) > 0)
    assert.ok(Number(importedOld.node.expired_at) > 0)
    assert.equal(importedOld.node.vector_state, 'none')
    assert.equal(importedOld.node.weight, 1)
    assert.equal(importedOld.node.hits, 0)

    const importedExpiring = await dst.getNode(expiring.id)
    assert.equal(Number(importedExpiring.node.expired_at), ttl)

    // 二次导入：按同 hash + 同身份（不限 status）跳过，不新增、也不复活
    const again = await dst.importJsonl({ jsonl: await src.exportJsonl({ identity: ident }), identity: ident })
    assert.equal(again.added, 0)
    assert.equal(again.skipped, 3)
    assert.equal((await dst.stats()).totals.nodes_total, 3)
  } finally {
    src.dispose()
    dst.dispose()
  }
})

test('导入枚举回落：非法 status/vector_state 回落默认，context_note 截 200，hits/weight 数值兜底', async () => {
  const b = fresh()
  try {
    const jsonl = JSON.stringify({
      id: 'n-bad-enum',
      text: '非法枚举字段回落',
      status: 'alive',
      vector_state: 'done',
      level: 'urgent',
      memory_type: 'chat',
      source: 'unknown',
      context_note: '注'.repeat(300),
      hits: 'not-a-number',
      weight: null,
      valid_at: 'x',
    })
    const r = await b.importJsonl({ jsonl, identity: ident })
    assert.equal(r.ok, true)
    assert.equal(r.added, 1)
    const node = await b.getNode('n-bad-enum')
    assert.equal(node.node.status, 'active')
    assert.equal(node.node.vector_state, 'none')
    assert.equal(node.node.level, 'normal')
    assert.equal(node.node.memory_type, 'semantic')
    assert.equal(node.node.source, 'import')
    assert.equal(node.node.context_note.length, 200)
    assert.equal(Number(node.node.hits), 0)
    assert.equal(Number(node.node.weight), 1)
    assert.equal(node.node.valid_at, null)
  } finally { b.dispose() }
})

// ---------------------------------------------------------------------------
// 2. 导出身份过滤
// ---------------------------------------------------------------------------

test('导出身份过滤：只含本分区 + 共享，不泄漏其它 workspace', async () => {
  const b = fresh()
  try {
    await b.write({ text: '网页分区规则甲', identity: ident })
    await b.write({ text: 'qq 分区规则乙', identity: { userId: 'u1', roleId: '', workspace: 'qq' } })
    await b.write({ text: '共享规则丙', identity: { userId: 'u1', roleId: '', workspace: '' } })

    const texts = parseJsonl(await b.exportJsonl({ identity: ident })).map((r) => r.text).sort()
    assert.deepEqual(texts, ['共享规则丙', '网页分区规则甲'].sort())

    const qqTexts = parseJsonl(await b.exportJsonl({ identity: { userId: 'u1', roleId: '', workspace: 'qq' } }))
      .map((r) => r.text).sort()
    assert.deepEqual(qqTexts, ['qq 分区规则乙', '共享规则丙'].sort())
  } finally { b.dispose() }
})

// ---------------------------------------------------------------------------
// 3. 超长文本：拒绝计数 / 边界拆分
// ---------------------------------------------------------------------------

test('523 字单规则：rejected/reasons 计数且不丢其它行', async () => {
  const b = fresh()
  try {
    const longLine = JSON.stringify({ id: 'nlong1', text: '规'.repeat(523) })
    const normalLine = JSON.stringify({ text: '其它正常行不丢' })
    const r = await b.importJsonl({ jsonl: `${longLine}\n${normalLine}`, identity: ident })

    assert.equal(r.ok, true)
    assert.equal(r.errors, 1)
    assert.equal(r.rejected, 1)
    assert.equal(r.kept, 1)
    assert.equal(r.split, 0)
    assert.equal(r.added, 1)
    assert.deepEqual(r.reasons, { too_long_single_rule: 1 })
    assert.equal(r.error_details.length, 1)
    assert.equal(r.error_details[0].index, 0)
    assert.equal(r.error_details[0].reason, 'too_long_single_rule')
    assert.match(r.error_details[0].text_hash, /^[0-9a-f]{12}$/)
    assert.equal((await b.stats()).totals.nodes_total, 1)
  } finally { b.dispose() }
})

test('两段超长规则：按边界拆成 2 条，tags 带 split_from、写 SPLIT 审计；dryRun 计数同口径', async () => {
  const b = fresh()
  try {
    const rule1 = `1.${'甲'.repeat(400)}`
    const rule2 = `2.${'乙'.repeat(300)}`
    const jsonl = [
      JSON.stringify({ id: 'nlong2', text: `${rule1}\n${rule2}`, tags: ['导入'] }),
      JSON.stringify({ text: '拆分同批里的普通行' }),
    ].join('\n')

    const dry = await b.importJsonl({ jsonl, identity: ident, dryRun: true })
    assert.equal(dry.kept, 1)
    assert.equal(dry.split, 1)
    assert.equal(dry.rejected, 0)
    assert.equal(dry.added, 3)
    assert.equal((await b.stats()).totals.nodes_total, 0, 'dryRun 不落库')

    const r = await b.importJsonl({ jsonl, identity: ident })
    assert.equal(r.kept, 1)
    assert.equal(r.split, 1, 'split 统计的是源行数，不是段数')
    assert.equal(r.added, 3, '两段 + 一条普通行')
    assert.equal(r.errors, 0)

    const segments = b.withDb((db) => db.prepare("SELECT id,text,tags FROM nodes WHERE id LIKE 'nlong2_s%' ORDER BY id").all())
    assert.equal(segments.length, 2)
    for (const segment of segments) {
      assert.ok(segment.text.length <= 500)
      const tags = JSON.parse(segment.tags)
      assert.ok(tags.includes('split_from:nlong2'), '拆分段必须可追回原条目')
      assert.ok(tags.includes('导入'), '原 tags 保留')
    }
    const splitWrites = b.withDb((db) => Number(db.prepare("SELECT count(*) AS n FROM writes WHERE action='SPLIT'").get().n))
    assert.equal(splitWrites, 2)
  } finally { b.dispose() }
})

// ---------------------------------------------------------------------------
// 4. FTS 一致性闸
// ---------------------------------------------------------------------------

test('导入 FTS 闸：正常三表相等；触发器缺失 → 整批 ROLLBACK + fts_misaligned', async () => {
  const ok = fresh()
  try {
    const r = await ok.importJsonl({ jsonl: JSON.stringify({ text: '正常导入要对齐三表' }), identity: ident })
    assert.equal(r.ok, true)
    const counts = ok.withDb((db) => ({
      nodes: Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n),
      fts: Number(db.prepare('SELECT count(*) AS n FROM nodes_fts').get().n),
      ftsBi: Number(db.prepare('SELECT count(*) AS n FROM nodes_fts_bi').get().n),
    }))
    assert.deepEqual(counts, { nodes: 1, fts: 1, ftsBi: 1 })
  } finally { ok.dispose() }

  const broken = fresh()
  try {
    await broken.write({ text: '闸门测试的既有节点', identity: ident })
    broken.withDb((db) => db.exec('DROP TRIGGER nodes_ai'))
    const r = await broken.importJsonl({ jsonl: JSON.stringify({ text: '触发器缺失时的新节点' }), identity: ident })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'fts_misaligned')
    assert.equal((await broken.stats()).totals.nodes_total, 1, '不一致必须整批回滚')
  } finally { broken.dispose() }
})

// ---------------------------------------------------------------------------
// 5. schema v1 → v2 幂等迁移
// ---------------------------------------------------------------------------

test('ensureSchema：v1 库补 writes.payload 并升到 v2；重复执行幂等；高版本拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-schema-'))
  const file = join(dir, 'memory.db')
  const db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    db.exec(`CREATE TABLE writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      trace_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      node_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      before_text TEXT,
      after_text TEXT,
      mode TEXT NOT NULL DEFAULT 'shadow',
      user_id TEXT NOT NULL DEFAULT '',
      role_id TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT ''
    );`)
    db.prepare("INSERT INTO meta (key,value) VALUES ('schema_version','1')").run()

    const columnsBefore = db.prepare('PRAGMA table_info(writes)').all().map((c) => c.name)
    assert.ok(!columnsBefore.includes('payload'), '前置条件：v1 writes 没有 payload')

    assert.deepEqual(ensureSchema(db), { version: SCHEMA_VERSION })
    const columnsAfter = db.prepare('PRAGMA table_info(writes)').all().map((c) => c.name)
    assert.ok(columnsAfter.includes('payload'))
    assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '2')

    // 迁移后可正常写入载荷（列可读写）
    db.prepare(`INSERT INTO writes (ts,action,payload) VALUES (?,?,?)`).run(now(), 'CANDIDATE', '{"shadowOf":"ADD"}')
    assert.equal(String(db.prepare('SELECT payload FROM writes ORDER BY id DESC LIMIT 1').get().payload), '{"shadowOf":"ADD"}')

    // 幂等：再跑一次不报错、版本不变
    assert.deepEqual(ensureSchema(db), { version: 2 })

    // 高版本仍拒绝（只增不减）
    db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run()
    assert.throws(() => ensureSchema(db), /schema_incompatible/)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// 6. 内存闸门口径（Fix 9）
// ---------------------------------------------------------------------------

test('内存闸门：优先解析 /proc/meminfo 的 MemAvailable，读不到回落 freemem', () => {
  const meminfo = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    4096000 kB\n'
  assert.equal(availableBytes(() => meminfo), 4096000 * 1024)

  // 没有 MemAvailable 行 / 读取抛错：回落 os.freemem()（非负数值）
  for (const reader of [() => 'MemTotal: 1000 kB\n', () => { throw new Error('no proc') }]) {
    const fallback = availableBytes(reader)
    assert.equal(Number.isFinite(fallback), true)
    assert.ok(fallback >= 0)
  }
})

test('内存闸门：压力判定边界（free < 500MB 或 rss > 2GB，等号不算压力）', () => {
  const noRss = () => 1
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR - 1, rssBytes: noRss }).stress, true)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR, rssBytes: noRss }).stress, false)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR * 10, rssBytes: () => RSS_CEIL + 1 }).stress, true)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR * 10, rssBytes: () => RSS_CEIL }).stress, false)

  const pressure = memoryPressure({ freeBytes: FREE_FLOOR - 1024, rssBytes: 1024 })
  assert.equal(pressure.stress, true)
  assert.equal(pressure.freeMB, Math.round((FREE_FLOOR - 1024) / 1048576))
})

test('error_details 最多 20 条（不塞全文，只留序号/原因/哈希前缀）', async () => {
  const b = fresh()
  try {
    const jsonl = Array.from({ length: 25 }, (_, i) => `{坏 JSON ${i}`).join('\n')
    const r = await b.importJsonl({ jsonl, identity: ident })
    assert.equal(r.ok, true)
    assert.equal(r.errors, 25)
    assert.equal(r.rejected, 25)
    assert.equal(r.reasons.invalid_json, 25)
    assert.equal(r.error_details.length, 20)
    for (const detail of r.error_details) {
      assert.equal(detail.reason, 'invalid_json')
      assert.match(detail.text_hash, /^[0-9a-f]{12}$/)
    }
  } finally { b.dispose() }
})
