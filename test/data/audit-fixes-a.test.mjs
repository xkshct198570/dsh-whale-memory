/**
 * 2026-11-26 双插件严苛审查 A 阶段热修回归（数据层）。
 *
 * 覆盖：F1 archive 分区不可判定拒绝执行 / F2 迁移去重按质量序 /
 * F3 每日配额只数新事实 / F4 落库与审计同事务 / F5 启动回收不抢 write job /
 * F7 打开失败不泄漏连接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, closeDb } from '../../src/core/db.js'
import { dedupeActiveHashes, ensureSchema } from '../../src/core/schema.js'
import { recoverRunningJobs } from '../../src/core/keeper.js'
import { decideWrite, processEvent } from '../../src/core/writer.js'

function tmp(t, prefix = 'whale-audit-a-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const IDENT = { userId: 'u1', roleId: '', workspace: '' }

test('F1：archive 不可判定分区 → skipped，不物理删（scope=all 反例）', (t) => {
  // 纯函数层已由 keeper.test 覆盖执行路径；这里钉住"空三元组绝不等于全库删除"的判据。
  const dir = tmp(t, 'f1-')
  const db = openDb(dir)
  try {
    const inserts = []
    for (const user of ['', 'alice', 'bob']) {
      db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,status,user_id,role_id,workspace,created_at,updated_at)
        VALUES (?,?,?,'','archived',?,'','',?,?)`).run(`n-${user || 'shared'}`, `旧-${user}`, `h-${user || 's'}`, user, 1, 1)
    }
    // 模拟旧实现的 scope=all 删除：必须只能通过显式 identity 命中，不再有"空=全库"入口。
    const info = db.prepare("DELETE FROM nodes WHERE status='archived' AND user_id = ?").run('')
    assert.equal(Number(info.changes), 1, '空 userId 只命中共享分区一行')
    assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get().n, 2)
  } finally { closeDb(db) }
})

test('F2：迁移去重保留最高信任行（owner/core/procedural 不被 web/normal 顶掉）', (t) => {
  const dir = tmp(t)
  const db = new DatabaseSync(join(dir, 'memory.db'))
  t.after(() => db.close())
  ensureSchema(db)
  db.exec('DROP INDEX IF EXISTS idx_nodes_active_hash')
  const ins = db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,user_id,role_id,workspace,created_at,updated_at)
    VALUES (?,?,?,'',?,?,?,'active',?,'','',?,?)`)
  ins.run('low', '同一事实', 'h1', 'normal', 'semantic', 'web', 'u1', 1, 1)
  ins.run('high', '同一事实', 'h1', 'core', 'procedural', 'owner', 'u1', 2, 2)
  assert.equal(dedupeActiveHashes(db), 1)
  const rows = db.prepare("SELECT id,status FROM nodes WHERE text_hash='h1' ORDER BY id").all()
  assert.equal(rows.find((r) => r.id === 'high').status, 'active', '高信任行必须是规范行')
  assert.equal(rows.find((r) => r.id === 'low').status, 'superseded')
})

test('F3：每日配额只数 ADD/MERGE/SUPERSEDE，面板 EDIT 不占额度', (t) => {
  const dir = tmp(t, 'f3-')
  const db = openDb(dir)
  try {
    const ts = Date.now() / 1000
    const ins = db.prepare(`INSERT INTO writes (ts,trace_id,action,node_id,reason,mode,user_id,role_id,workspace)
      VALUES (?,?,'EDIT','n1','manual_edit','auto',?,'','')`)
    for (let i = 0; i < 5; i += 1) ins.run(ts, '', 'u1')
    const decision = decideWrite(db, { text: '新的可执行事实：端口改为 4090 并记录排查判据', identity: IDENT }, { mode: 'auto', dailyCap: 2 })
    assert.notEqual(decision.reason, 'daily_cap', 'EDIT 不应消耗日配额')
  } finally { closeDb(db) }
})

test('F4：审计写入失败 → 节点落库一并回滚（同事务）', (t) => {
  const dir = tmp(t, 'f4-')
  const db = openDb(dir)
  try {
    db.exec('ALTER TABLE writes RENAME TO writes_broken')
    assert.throws(() => processEvent(db, {
      text: '事务原子性探针：这条不应留在库里',
      identity: IDENT, source: 'self', origin: 'unit',
    }, { write: { reviewMode: 'auto', dailyCap: 200, maxChars: 500 } }))
    assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get().n, 0, '审计失败必须回滚节点')
  } finally { closeDb(db) }
})

test('F5：启动回收只复位非保留 kind，write job 留给写队列', (t) => {
  const dir = tmp(t)
  const db = openDb(dir)
  t.after(() => closeDb(db))
  const ins = db.prepare("INSERT INTO jobs (kind,state,attempts,created_at,updated_at) VALUES (?, 'running', 0, 1, 1)")
  ins.run('write')
  ins.run('consolidate')
  const n = recoverRunningJobs({ withDb: (fn) => fn(db) })
  assert.equal(n, 1)
  const rows = db.prepare('SELECT kind,state FROM jobs ORDER BY kind').all()
  assert.equal(rows.find((r) => r.kind === 'write').state, 'running', 'write 不得被 keeper 抢跑')
  assert.equal(rows.find((r) => r.kind === 'consolidate').state, 'queued')
})

test('F7：openDb 失败路径关闭连接，不随失败次数泄漏 fd', (t) => {
  const dir = tmp(t)
  const dbFile = join(dir, 'memory.db')
  const raw = new DatabaseSync(dbFile)
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  raw.prepare("INSERT INTO meta VALUES ('schema_version','99')").run()
  raw.close()
  const fdDir = '/proc/self/fd'
  const countFds = () => { try { return readdirSync(fdDir).length } catch { return -1 } }
  const before = countFds()
  for (let i = 0; i < 20; i += 1) {
    assert.throws(() => openDb(dir), /schema_incompatible/)
  }
  const after = countFds()
  if (before >= 0) assert.ok(after <= before + 2, `fd 泄漏：before=${before} after=${after}`)
})
