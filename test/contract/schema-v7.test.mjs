/**
 * schema v7 契约：`nodes.layer` 加法迁移 + 迁移前快照 fail-closed + health 原因可见。
 *
 * 判据（架构书 §5.7.1）：
 * - v6 库升级：只加列、节点数不变、旧行 `layer=NULL`、`schema_version=7`、幂等两遍只快照一次；
 * - 快照失败（`backup/` 是文件）→ 抛 `migration_backup_failed:<reason>` 且**不迁移**（版本仍 6、无 layer 列）；
 * - 阻断是进程内记忆的：修好磁盘后同一 backend 不自动重试（每步重跑 VACUUM 是自愈死循环）；
 * - `/stats` 返回 502 且 error 带完整原因（面板离线卡按 errText 原样显示）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, openDb } from '../../src/core/db.js'
import { LocalBackend } from '../../src/core/backend.js'
import { createRoutes } from '../../src/host/routes.js'

const BACKUP_RE = /^whale-\d{14,17}(?:-\d+)?\.db$/

const ROUTE_CONFIG = {
  identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
  panel: { allowRemote: false },
  recall: {},
  backend: { mode: 'local' },
}

/** 造一个"真 v6 库"：现行 v7 DDL 建库 → 塞两行（旧行 layer 必为 NULL）→ 删 layer 列 → 钉回 version=6。 */
function makeV6Db(dir) {
  const db = openDb(dir)
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES ('n1','v6 旧行一：网关端口 3982','h1','', 'normal','semantic','self','active','','','','[]','',1,0,0,'none','','',1,1)`).run()
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES ('n2','v6 旧行二：DSH 端口 3080','h2','', 'normal','semantic','self','active','','','','[]','',1,0,0,'none','','',2,2)`).run()
  db.exec('ALTER TABLE nodes DROP COLUMN layer')
  db.prepare("UPDATE meta SET value='6' WHERE key='schema_version'").run()
  closeDb(db)
}

/** 不迁移地读 meta（raw 连接不走 ensureSchema）。 */
function readMetaVersion(dir) {
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try { return String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? '') } finally { db.close() }
}

function nodeColumns(dir) {
  const db = new DatabaseSync(join(dir, 'memory.db'))
  try { return db.prepare('PRAGMA table_info(nodes)').all().map((c) => String(c.name)) } finally { db.close() }
}

test('v6→v7：只加 layer 列，节点数不变、旧行 NULL、版本 7、幂等且只快照一次', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  makeV6Db(dir)
  assert.equal(readMetaVersion(dir), '6')

  const db = openDb(dir)
  try {
    assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '7')
    assert.ok(nodeColumns(dir).includes('layer'), '迁移后 nodes 必须有 layer 列')
    const rows = db.prepare('SELECT id,layer FROM nodes ORDER BY id').all()
    assert.deepEqual(rows.map((r) => [r.id, r.layer]), [['n1', null], ['n2', null]], '旧行不得被填值')
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2, '迁移前后节点数必须相等')
    assert.equal(db.migrationBackup?.performed, true, '迁移前必须留整库快照')
    const backups = readdirSync(join(dir, 'backup')).filter((name) => BACKUP_RE.test(name))
    assert.equal(backups.length, 1)
    // 快照是可打开的完整库：证明确实是 VACUUM INTO 产物，不是空文件。
    const snap = new DatabaseSync(join(dir, 'backup', backups[0]), { readOnly: true })
    try { assert.equal(Number(snap.prepare('SELECT count(*) AS n FROM nodes').get().n), 2) } finally { snap.close() }
  } finally { closeDb(db) }

  // 幂等：已是 v7，不再快照、不报错、数据不动。
  const db2 = openDb(dir)
  try {
    assert.equal(Number(db2.prepare('SELECT count(*) AS n FROM nodes').get().n), 2)
    assert.equal(readdirSync(join(dir, 'backup')).filter((name) => BACKUP_RE.test(name)).length, 1)
  } finally { closeDb(db2) }
})

test('快照失败 → migration_backup_failed 且不迁移（版本仍 6、无 layer 列）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-fail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  makeV6Db(dir)
  // 确定性注入：把 backup/ 造成普通文件 → mkdirSync(backup) 必失败，而库所在目录/'-wal' 仍可写。
  writeFileSync(join(dir, 'backup'), 'not-a-directory')

  assert.throws(() => openDb(dir), (err) => {
    assert.equal(err?.code, 'migration_backup_failed')
    assert.match(String(err?.message), /^migration_backup_failed:/)
    assert.ok(String(err?.reason).length > 0, 'reason 必须可展示')
    return true
  })

  assert.equal(readMetaVersion(dir), '6', '失败不得写版本号')
  assert.equal(nodeColumns(dir).includes('layer'), false, '失败不得执行 ALTER')
})

test('迁移阻断被记忆：修好磁盘后同一 backend 不自动重试（避免每步重跑 VACUUM）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-block-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  makeV6Db(dir)
  const backupFile = join(dir, 'backup')
  writeFileSync(backupFile, 'not-a-directory')

  const backend = new LocalBackend({ dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => backend.dispose())
  assert.equal(backend.ready, false)
  assert.match(String(backend.openError), /backup|directory|EEXIST|ENOTDIR/i)

  // 修复"磁盘"：删掉挡路的文件。同一进程仍应保持阻断（重启才是重试点），
  // 否则每轮 pre-step 都会重新尝试迁移快照，等于把一次性故障变成热路径负担。
  rmSync(backupFile)
  assert.throws(() => backend.withDb((db) => db), (err) => err?.code === 'migration_backup_failed')
  assert.equal(readMetaVersion(dir), '6')
})

test('/stats 在迁移阻断时返回可行动原因（health 区显示 [migration_backup_failed:...]）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  makeV6Db(dir)
  writeFileSync(join(dir, 'backup'), 'not-a-directory')
  const backend = new LocalBackend({ dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => backend.dispose())

  const server = http.createServer(createRoutes({ config: ROUTE_CONFIG, backend }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const root = `http://127.0.0.1:${server.address().port}/whale-memory/api`
  const res = await fetch(`${root}/stats`)
  const body = JSON.parse(await res.text())
  assert.equal(res.status, 502)
  assert.equal(body.ok, false)
  assert.equal(body.offline, true)
  assert.match(String(body.error), /^migration_backup_failed:/, '错误必须带原因，不能折叠成 backend_error')
  assert.ok(String(body.reason).length > 0)
  assert.equal(body.backend.ready, false)
  // 数据路由同样要能说出原因（记忆库页只看到 backend_error 等于没说）：/nodes 走统一错误出口。
  const nodesRes = await fetch(`${root}/nodes?limit=1`)
  const nodesBody = JSON.parse(await nodesRes.text())
  assert.equal(nodesRes.status, 502)
  assert.match(String(nodesBody.error), /^migration_backup_failed:/)
  assert.ok(String(nodesBody.reason).length > 0)
  // /version 在阻断期间仍 200（ready 快速失败；页头/协议信息不该跟着记忆库一起黑）。
  const version = await fetch(`${root}/version`)
  assert.equal(version.status, 200)
})


test('版本行缺失 + 有数据 + 无 layer：仍必须先快照再迁移（不得当成新库）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-nover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  makeV6Db(dir)
  const raw = new DatabaseSync(join(dir, 'memory.db'))
  raw.prepare("DELETE FROM meta WHERE key='schema_version'").run()
  raw.close()

  const db = openDb(dir)
  try {
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2)
    assert.ok(nodeColumns(dir).includes('layer'))
    assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '7')
    assert.equal(db.migrationBackup?.performed, true, '带数据的库必须先留快照')
    assert.equal(readdirSync(join(dir, 'backup')).filter((name) => BACKUP_RE.test(name)).length, 1)
  } finally { closeDb(db) }
})

test('版本号已 7 但缺 layer 列（形态不符）：先快照再补列', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-shape-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seed = openDb(dir)
  seed.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES ('s1','半迁移样本','hs','', 'normal','semantic','self','active','','','','[]','',1,0,0,'none','','',1,1)`).run()
  closeDb(seed)
  const raw = new DatabaseSync(join(dir, 'memory.db'))
  raw.exec('ALTER TABLE nodes DROP COLUMN layer')
  raw.close()

  const db = openDb(dir)
  try {
    assert.ok(nodeColumns(dir).includes('layer'), '缺列必须被补上')
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
    assert.equal(db.prepare('SELECT layer FROM nodes WHERE id=?').get('s1').layer, null)
    assert.equal(db.migrationBackup?.performed, true, '形态不符也必须先留快照')
  } finally { closeDb(db) }
})

test('全新空目录：没有可回滚数据，不产生迁移快照', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v7-fresh-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = openDb(dir)
  try {
    assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '7')
    assert.equal(readdirSync(dir).includes('backup'), false, '空库首建不该留空快照')
  } finally { closeDb(db) }
})
