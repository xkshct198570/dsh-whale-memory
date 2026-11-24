import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSchema } from '../../src/core/schema.js'
import { auditMemory } from '../../src/core/memory-hygiene.js'

const CHECK_KEYS = [
  'fts_aligned', 'duplicate_active', 'orphan_edges', 'expired_active',
  'failed_jobs', 'pending_jobs', 'backup_fresh', 'db_size',
]

/** 临时内存库：ensureSchema 建全表，用后 close；不落盘。 */
function freshDb() {
  const db = new DatabaseSync(':memory:')
  ensureSchema(db)
  return db
}

/** 插入一条最小合法节点（写全会影响检查项的列；触发器会同步两个 FTS）。 */
function insertNode(db, over = {}) {
  const ts = 1700000000
  const row = {
    id: 'n1', text: '测试节点', text_hash: 'h1', text_bigrams: '测试 试节 节点',
    status: 'active', origin: '', user_id: '', role_id: '', workspace: '', expired_at: null,
    created_at: ts, updated_at: ts, ...over,
  }
  db.prepare(`INSERT INTO nodes (id, text, text_hash, text_bigrams, status, origin,
    user_id, role_id, workspace, expired_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.text, row.text_hash, row.text_bigrams, row.status, row.origin,
    row.user_id, row.role_id, row.workspace, row.expired_at, row.created_at, row.updated_at)
}

function count(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
}

test('空库：ok=true、检查项顺序固定、fts_aligned ok、stats 全 0', () => {
  const db = freshDb()
  try {
    const result = auditMemory(db)
    assert.equal(result.ok, true)
    assert.deepEqual(result.blockers, [])
    assert.deepEqual(result.checks.map((check) => check.key), CHECK_KEYS)
    assert.equal(result.checks[0].key, 'fts_aligned')
    assert.equal(result.checks[0].status, 'ok')
    assert.match(result.checks[0].detail, /nodes=0/)
    assert.deepEqual(
      Object.keys(result.stats),
      ['nodes', 'active', 'archived', 'stale', 'superseded', 'edges', 'writes',
        'ftsRows', 'ftsBiRows', 'failedJobs', 'pendingJobs', 'dbBytes'],
    )
    assert.equal(result.stats.nodes, 0)
    assert.equal(result.stats.dbBytes, 0)
    // 无备份必须可见（fail-open 但要留证据）：warn 不阻塞 ok。
    assert.ok(result.warnings.includes('no_backup'))
    assert.equal(result.checks.find((c) => c.key === 'backup_fresh').status, 'warn')
  } finally { db.close() }
})

test('手工删除 FTS 索引行 → fts_aligned fail + blocker（外部内容表 count 仍相等，必须看 _docsize）', () => {
  const db = freshDb()
  try {
    insertNode(db)
    assert.equal(count(db, 'nodes_fts'), 1)
    assert.equal(count(db, 'nodes_fts_docsize'), 1)
    // 直接删索引行：nodes 里那行还在，nodes_fts 的 count(*) 读内容表仍是 1，
    // 只有 _docsize 能看出索引真的少了一行。
    db.exec('DELETE FROM nodes_fts')
    assert.equal(count(db, 'nodes'), 1)
    assert.equal(count(db, 'nodes_fts'), 1, '外部内容表 count 读的是 nodes')
    assert.equal(count(db, 'nodes_fts_docsize'), 0, '索引里实际 0 行 → 不同步')

    const result = auditMemory(db)
    assert.equal(result.ok, false)
    assert.equal(result.blockers.length, 1)
    const check = result.checks.find((item) => item.key === 'fts_aligned')
    assert.equal(check.status, 'fail')
    assert.match(check.detail, /FTS 未对齐/)
    assert.match(check.detail, /nodes=1 fts=1 fts_bi=1 idx=0 idx_bi=1/)
    // 只读：审计不改库、不补索引。
    assert.equal(count(db, 'nodes_fts_docsize'), 0)
  } finally { db.close() }
})

test('孤儿边 → warn（不阻塞 ok），并计入 stats.edges', () => {
  const db = freshDb()
  try {
    db.prepare(`INSERT INTO edges (from_id, to_id, etype, source, conf, weight, created_at)
      VALUES (?, ?, 'similar', 'tag', 0.5, 0.6, ?)`).run('ghost-a', 'ghost-b', 1700000000)
    const result = auditMemory(db)
    assert.equal(result.ok, true)
    const check = result.checks.find((item) => item.key === 'orphan_edges')
    assert.equal(check.status, 'warn')
    assert.match(check.detail, /孤儿边 1 条/)
    assert.ok(result.warnings.includes(check.detail))
    assert.equal(result.stats.edges, 1)
  } finally { db.close() }
})

test('到期未归档 / 失败 job → warn；pending job 只计数且 ok', () => {
  const db = freshDb()
  try {
    insertNode(db, { expired_at: 1000 })
    const ts = 1700000000
    db.prepare('INSERT INTO jobs (kind, state, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('reflect', 'failed', ts, ts)
    db.prepare('INSERT INTO jobs (kind, state, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('consolidate', 'queued', ts, ts)
    const nowSec = 1700000100
    const result = auditMemory(db, { nowSec })
    assert.equal(result.ok, true)
    assert.equal(result.checks.find((c) => c.key === 'expired_active').status, 'warn')
    assert.equal(result.checks.find((c) => c.key === 'failed_jobs').status, 'warn')
    const pending = result.checks.find((c) => c.key === 'pending_jobs')
    assert.equal(pending.status, 'ok')
    assert.match(pending.detail, /1 条/)
    assert.equal(result.stats.failedJobs, 1)
    assert.equal(result.stats.pendingJobs, 1)
  } finally { db.close() }
})

test('duplicate_active：rule: 来源不计入重复组（规则与事实可分同文共存）', () => {
  const db = freshDb()
  try {
    insertNode(db, { id: 'r1', text: '规则节点', text_hash: 'hr', text_bigrams: '规则 则节 节点', origin: 'rule:one' })
    insertNode(db, { id: 'r2', text: '规则节点', text_hash: 'hr', text_bigrams: '规则 则节 节点', origin: 'rule:two' })
    const result = auditMemory(db)
    assert.equal(result.checks.find((c) => c.key === 'duplicate_active').status, 'ok')
    assert.equal(result.ok, true)
  } finally { db.close() }
})

test('backup_fresh：超过 7 天 → warn；7 天内 → ok（临时目录，用后删）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-hygiene-'))
  const db = freshDb()
  try {
    const oldFile = join(dir, 'whale-20260101.db')
    writeFileSync(oldFile, 'x')
    const oldSec = (Date.now() - 8 * 24 * 3600 * 1000) / 1000
    utimesSync(oldFile, oldSec, oldSec)
    const stale = auditMemory(db, { backupDir: dir })
    const staleCheck = stale.checks.find((c) => c.key === 'backup_fresh')
    assert.equal(staleCheck.status, 'warn')
    assert.match(staleCheck.detail, /超过 7 天/)
    assert.equal(stale.ok, true, '备份超期只 warn，不阻塞收尾')

    const freshFile = join(dir, 'whale-20261124.db')
    writeFileSync(freshFile, 'y')
    const fresh = auditMemory(db, { backupDir: dir })
    const freshCheck = fresh.checks.find((c) => c.key === 'backup_fresh')
    assert.equal(freshCheck.status, 'ok')
    assert.match(freshCheck.detail, /whale-20261124\.db/)

    const missingDir = auditMemory(db, { backupDir: join(dir, 'nope') })
    assert.equal(missingDir.checks.find((c) => c.key === 'backup_fresh').status, 'warn')
    assert.ok(missingDir.warnings.includes('no_backup'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('db_size：dbFile 不存在按 0 且永远 ok；表缺失类异常兜成 warn 不抛', () => {
  const db = freshDb()
  try {
    const result = auditMemory(db, { dbFile: '/definitely/not/here/whale.db' })
    const size = result.checks.find((c) => c.key === 'db_size')
    assert.equal(size.status, 'ok')
    assert.match(size.detail, /0 字节/)
    assert.equal(result.stats.dbBytes, 0)
  } finally { db.close() }

  // 结构损坏的库（只建 nodes，没有 FTS/jobs）：检查项一律 warn，不抛。
  const broken = new DatabaseSync(':memory:')
  try {
    broken.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, text TEXT, text_hash TEXT, status TEXT, "
      + 'user_id TEXT, role_id TEXT, workspace TEXT, origin TEXT, expired_at REAL)')
    const result = auditMemory(broken)
    assert.equal(result.ok, true)
    assert.ok(result.warnings.length >= 1)
    for (const key of CHECK_KEYS) {
      const check = result.checks.find((item) => item.key === key)
      assert.ok(check, `缺少检查项 ${key}`)
      assert.ok(['ok', 'warn', 'fail'].includes(check.status))
      assert.equal(typeof check.detail, 'string')
    }
    const fts = result.checks.find((c) => c.key === 'fts_aligned')
    assert.equal(fts.status, 'warn')
    assert.match(fts.detail, /check_error/)
  } finally { broken.close() }
})

test('审计只读：运行前后所有业务表行数不变', () => {
  const db = freshDb()
  try {
    insertNode(db)
    const ts = 1700000000
    db.prepare('INSERT INTO jobs (kind, state, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('reflect', 'failed', ts, ts)
    const before = ['nodes', 'edges', 'writes', 'jobs', 'recalls', 'evolution']
      .map((table) => count(db, table))
    auditMemory(db, { nowSec: 1700000100 })
    const after = ['nodes', 'edges', 'writes', 'jobs', 'recalls', 'evolution']
      .map((table) => count(db, table))
    assert.deepEqual(after, before)
  } finally { db.close() }
})
