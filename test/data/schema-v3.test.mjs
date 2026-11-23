/**
 * R1（schema v3 + 数据面）：pinned 列/索引、v2→v3 幂等迁移、迁移前快照、
 * 导出/导入保真、pinnedRules 工作区过滤与上限、规则退役撤顶。
 *
 * 为什么单独成文件：R1 的判据横跨 schema/db/backend/writer 四个模块，
 * 放进既有 writer/import 用例里会让"schema 迁移"这一层没有独立红绿信号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { openDb, closeDb, now, backupOnMigrate, MAX_BACKUPS } from '../../src/core/db.js'
import { DDL, SCHEMA_VERSION, ensureSchema } from '../../src/core/schema.js'
import { createBackend } from '../../src/core/backend.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { processEvent } from '../../src/core/writer.js'

const BACKUP_RE = /^whale-\d{14,17}(?:-\d+)?\.db$/

function tmpDir(prefix = 'whale-schema3-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 直接造节点行（不经 writer）：用于 pinned/作用域/排序这类纯数据面断言。 */
function insertNode(db, { id, text, pinned = 0, status = 'active', workspace = '', weight = 1, updatedAt = now() }) {
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'owner',?,'','',?,'[]','',?,?,0,'none','', '',?,?)`).run(
    id, text, contentHash(text), bigrams(text),
    'core', 'procedural', status, workspace, weight, pinned,
    now(), updatedAt,
  )
}

/**
 * 造一个 v2 库：先用现行 DDL 建全（含 pinned），塞数据，再把 pinned 列删掉并钉回 version=2。
 * 为什么不用手写旧 DDL：手抄 DDL 会与 src 漂移；用现行 DDL 反推"少一列"能保证
 * 除 pinned 以外的一切（FTS/触发器/索引）都是真实旧库形态。
 */
function makeV2Db(dir) {
  const db = new DatabaseSync(join(dir, 'memory.db'))
  db.exec(DDL)
  db.prepare("INSERT INTO meta (key,value) VALUES ('schema_version','2')").run()
  insertNode(db, { id: 'n1', text: '旧库事实一：网关端口 3982' })
  insertNode(db, { id: 'n2', text: '旧库事实二：DSH 端口 3080', workspace: '/home/hy/hy' })
  db.exec('DROP INDEX IF EXISTS idx_nodes_pinned')
  db.exec('ALTER TABLE nodes DROP COLUMN pinned')
  db.close()
}

test('新库：DDL 直接带 pinned 列与 idx_nodes_pinned，版本=4', (t) => {
  const dir = tmpDir()
  const db = openDb(dir)
  t.after(() => closeDb(db))
  assert.equal(SCHEMA_VERSION, 4)
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name)
  assert.ok(cols.includes('pinned'), 'nodes 必须有 pinned')
  const pinnedCol = db.prepare('PRAGMA table_info(nodes)').all().find((c) => c.name === 'pinned')
  assert.equal(Number(pinnedCol.notnull), 1)
  assert.equal(String(pinnedCol.dflt_value), '0')
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_pinned'").get()
  assert.ok(idx, 'pinned 索引必须存在')
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '4')
})

test('v2→v4：补 pinned 列（旧行全 0）、FTS 不变、重复打开幂等且只快照一次', (t) => {
  const dir = tmpDir()
  makeV2Db(dir)

  const db = openDb(dir)
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name)
  assert.ok(cols.includes('pinned'), '迁移后必须有 pinned')
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '4')

  const rows = db.prepare('SELECT id,pinned FROM nodes ORDER BY id').all()
  assert.deepEqual(rows.map((r) => [r.id, Number(r.pinned)]), [['n1', 0], ['n2', 0]], '旧行默认不置顶')

  // FTS 闸门：迁移不得让索引与节点失配（docsize 才是真索引行数）。
  const nodes = Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n)
  for (const table of ['nodes_fts_docsize', 'nodes_fts_bi_docsize']) {
    assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n), nodes, `${table} 行数对齐`)
  }

  // 迁移前快照：v2 库打开一次必须留 1 份 whale-*.db
  const backups = readdirSync(join(dir, 'backup')).filter((name) => BACKUP_RE.test(name))
  assert.equal(backups.length, 1, '迁移前必须做整库快照')
  assert.equal(db.migrationBackup?.performed, true)

  closeDb(db)

  // 再开一次：已是 v3，不应再产生第二份快照，数据与索引仍然对齐。
  const db2 = openDb(dir)
  t.after(() => closeDb(db2))
  assert.equal(readdirSync(join(dir, 'backup')).filter((name) => BACKUP_RE.test(name)).length, 1)
  assert.equal(Number(db2.prepare('SELECT count(*) AS n FROM nodes_fts_docsize').get().n), nodes)

  // ensureSchema 反复执行不报错（迁移的幂等性由列存在性判断，不看版本号）。
  assert.deepEqual(ensureSchema(db2), { version: 4, deduped: 0, uniqueIndex: true })
  assert.deepEqual(ensureSchema(db2), { version: 4, deduped: 0, uniqueIndex: true })
})

test('迁移快照：VACUUM INTO 可打开、只保留最新 MAX_BACKUPS 份', (t) => {
  const dir = tmpDir()
  const db = openDb(dir, { backupOnMigrate: false })
  t.after(() => closeDb(db))
  const backupDir = join(dir, 'backup')
  mkdirSync(backupDir, { recursive: true })
  // 预置 6 份更旧的备份（日期串保证字典序即时间序）
  for (let i = 0; i < 6; i += 1) writeFileSync(join(backupDir, `whale-2026010100000000${i}.db`), 'old')

  const out = backupOnMigrate(db, dir)
  assert.equal(out.performed, true)
  const backups = readdirSync(backupDir).filter((name) => BACKUP_RE.test(name)).sort()
  assert.equal(backups.length, MAX_BACKUPS, '最多保留 5 份')
  assert.ok(backups.includes(out.path.split('/').pop()), '新快照必须保留')
  assert.equal(backups.includes('whale-2026010100000000.db'), false, '最旧一份被清理')

  // 快照必须是可打开的完整 SQLite 库（不是空文件/坏页）
  const snap = new DatabaseSync(out.path, { readOnly: true })
  try {
    assert.equal(String(snap.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '4')
  } finally {
    snap.close()
  }
})

test('导出补 pinned：JSONL 行携带 pinned，导入缺列按 0、有列保真', async (t) => {
  const src = tmpDir('whale-export-')
  const be = createBackend({ mode: 'local' }, {
    dataDir: src, useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }),
  })
  t.after(() => be.dispose())

  const text = '【规则·文件卫生】AI 报告读完后先提炼结论再删源文件'
  const w = await be.write({
    text, pinned: 1, level: 'core', memory_type: 'procedural', source: 'owner',
    identity: { userId: '', roleId: '', workspace: '' },
  })
  assert.equal(w.ok, true)
  assert.equal(w.action, 'ADD')
  const stored = be.withDb((db) => db.prepare('SELECT pinned,level,memory_type FROM nodes WHERE id=?').get(w.id))
  assert.equal(Number(stored.pinned), 1, 'write(pinned:1) 必须落库')
  assert.equal(stored.level, 'core')

  const jsonl = await be.exportJsonl({ identity: {} })
  const exported = JSON.parse(jsonl.trim())
  assert.equal(Number(exported.pinned), 1, '导出必须带 pinned')

  // 导入：pinned=1 保真
  const be2 = createBackend({ mode: 'local' }, {
    dataDir: tmpDir('whale-import-'), useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }),
  })
  t.after(() => be2.dispose())
  const r = await be2.importJsonl({ jsonl, identity: {} })
  assert.equal(r.ok, true)
  assert.equal(r.added, 1)
  const imported = be2.withDb((db) => db.prepare('SELECT pinned FROM nodes WHERE text_hash=?').get(exported.text_hash))
  assert.equal(Number(imported.pinned), 1, '导入必须保真 pinned')

  // 导入：旧 JSONL 缺 pinned 列 → 0（不能继承/默认置顶）
  const legacy = { ...exported }
  delete legacy.pinned
  legacy.id = 'n-legacy'
  const be3 = createBackend({ mode: 'local' }, {
    dataDir: tmpDir('whale-import-legacy-'), useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }),
  })
  t.after(() => be3.dispose())
  const r3 = await be3.importJsonl({ jsonl: JSON.stringify(legacy), identity: {} })
  assert.equal(r3.ok, true)
  const old = be3.withDb((db) => db.prepare('SELECT pinned FROM nodes WHERE id=?').get('n-legacy'))
  assert.equal(Number(old.pinned), 0, '缺列按未置顶')
})

test('pinnedRules：只取 active+pinned，按工作区可见性过滤，weight 优先且受 limit 约束', async (t) => {
  const be = createBackend({ mode: 'local' }, {
    dataDir: tmpDir('whale-pinned-'), useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }),
  })
  t.after(() => be.dispose())
  be.withDb((db) => {
    insertNode(db, { id: 'shared', text: '共享规则：报告阅后即焚', pinned: 1, workspace: '', weight: 1.0, updatedAt: 100 })
    insertNode(db, { id: 'hy', text: '本工作区规则：hy 专用', pinned: 1, workspace: '/home/hy/hy', weight: 2.0, updatedAt: 200 })
    insertNode(db, { id: 'cloud', text: '云端对照组规则', pinned: 1, workspace: '/home/hy/网页端聊天', weight: 3.0 })
    insertNode(db, { id: 'candidate', text: '候选规则（未置顶）', pinned: 0 })
    insertNode(db, { id: 'retired', text: '已退役规则', pinned: 1, status: 'superseded' })
  })

  const rows = await be.pinnedRules({ userId: '', roleId: '', workspace: '/home/hy/hy' })
  assert.deepEqual(rows.map((r) => r.id), ['hy', 'shared'], 'weight 降序；云端规则不得泄漏进 hy 会话')

  const cloudRows = await be.pinnedRules({ userId: '', roleId: '', workspace: '/home/hy/网页端聊天' })
  assert.deepEqual(cloudRows.map((r) => r.id), ['cloud', 'shared'])

  const otherRows = await be.pinnedRules({ userId: '', roleId: '', workspace: '/tmp/其它' })
  assert.deepEqual(otherRows.map((r) => r.id), ['shared'], '无工作区限定规则在任何会话可见')

  assert.deepEqual((await be.pinnedRules({ workspace: '/home/hy/hy' }, { limit: 1 })).map((r) => r.id), ['hy'])

  assert.ok(rows.every((r) => Number(r.pinned) === 1), '返回行必须带 pinned=1 供注入层断言')
})

test('规则退役：被 SUPERSEDE 的置顶规则 pinned 自动清零（auto 路径）', (t) => {
  const dir = tmpDir('whale-retire-')
  const db = openDb(dir)
  t.after(() => closeDb(db))
  const ev = (text, extra = {}) => ({
    traceId: 'tr-v3', source: 'chat', identity: { userId: '', roleId: '', workspace: '' },
    text, tags: [], at: 0, candidateType: 'fact', origin: 'unit', level: 'normal', memory_type: 'semantic',
    ...extra,
  })
  const old = processEvent(db, ev('项目部署在测试环境 端口是 8080', { pinned: 1 }), { write: { reviewMode: 'auto' } })
  assert.equal(Number(db.prepare('SELECT pinned FROM nodes WHERE id=?').get(old.id).pinned), 1)

  const r = processEvent(db, ev('项目部署在测试环境 端口是 9090', { pinned: 0 }), { write: { reviewMode: 'auto' } })
  assert.equal(r.action, 'SUPERSEDE')
  const retired = db.prepare('SELECT status,pinned FROM nodes WHERE id=?').get(old.id)
  assert.equal(retired.status, 'superseded')
  assert.equal(Number(retired.pinned), 0, '退役规则必须撤顶，注入层不得再带它')
  // shadow 路径改的是同一句 UPDATE（writer.js 两处同构），auto 覆盖即可；accept 流程见 writer.test.mjs。
})
