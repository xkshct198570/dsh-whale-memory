/**
 * schema v6 迁移回归：wrap_runs 去 UNIQUE 重建 + wrap_session_prefs 建表，数据不丢、幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema, migrateWrapRunsV6 } from '../../src/core/schema.js'

const V5_WRAP_RUNS = `CREATE TABLE wrap_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  material_hash     TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','running','done','failed','skipped')),
  trigger           TEXT NOT NULL DEFAULT 'manual',
  user_id           TEXT NOT NULL DEFAULT '',
  role_id           TEXT NOT NULL DEFAULT '',
  workspace         TEXT NOT NULL DEFAULT '',
  job_id            INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  phase             TEXT NOT NULL DEFAULT 'created'
                    CHECK (phase IN ('created','distilled','written','reported','done')),
  summary           TEXT NOT NULL DEFAULT '',
  distilled_json    TEXT,
  candidates        INTEGER NOT NULL DEFAULT 0,
  rule_proposals    INTEGER NOT NULL DEFAULT 0,
  open_loops        INTEGER NOT NULL DEFAULT 0,
  report_path       TEXT NOT NULL DEFAULT '',
  hygiene_json      TEXT,
  switch_ready_json TEXT,
  error             TEXT NOT NULL DEFAULT '',
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL,
  UNIQUE (session_id, material_hash)
)`

test('v6：旧 UNIQUE 表重建后数据保留、约束消失、索引重建', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v6-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  t.after(() => db.close())
  ensureSchema(db)
  // 造回 v5 形态：删表按旧 DDL 重建并塞一行。
  db.exec('DROP TABLE wrap_runs')
  db.exec(V5_WRAP_RUNS)
  db.prepare(`INSERT INTO wrap_runs (session_id,material_hash,state,trigger,attempts,created_at,updated_at)
    VALUES ('s1','h1','failed','manual',4,1,2)`).run()
  assert.equal(migrateWrapRunsV6(db).rebuilt, true)
  const rows = db.prepare('SELECT session_id,material_hash,state,attempts FROM wrap_runs').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'failed')
  assert.equal(Number(rows[0].attempts), 4)
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wrap_runs'").get().sql)
  assert.equal(/UNIQUE\s*\(\s*session_id/i.test(sql), false)
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_wrap_runs_material'").get())
  // 幂等：再跑不重建。
  assert.equal(migrateWrapRunsV6(db).rebuilt, false)
})

test('v6：ensureSchema 幂等建 prefs 表；skip_auto 默认 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-v6b-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dir, 'memory.db'))
  t.after(() => db.close())
  const first = ensureSchema(db)
  assert.equal(first.version, 7)
  db.prepare("INSERT INTO wrap_session_prefs (session_id,updated_at) VALUES ('s1',1)").run()
  const row = db.prepare("SELECT skip_auto FROM wrap_session_prefs WHERE session_id='s1'").get()
  assert.equal(Number(row.skip_auto), 0)
  assert.equal(ensureSchema(db).version, 7)
})
