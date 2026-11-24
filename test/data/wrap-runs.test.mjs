import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema } from '../../src/core/schema.js'
import {
  countRunsToday, createRun, decodeRun, findRun, getRun, latestRun, listRuns,
  markRunAttempt, updateRun,
} from '../../src/core/wrap-runs.js'

function db0() {
  const db = new DatabaseSync(':memory:')
  ensureSchema(db)
  return db
}

const IDENT = { userId: 'u1', roleId: '', workspace: '/w' }

test('schema v5：wrap_runs 表/幂等键/状态列齐', () => {
  const db = db0()
  const cols = db.prepare('PRAGMA table_info(wrap_runs)').all().map((c) => c.name)
  for (const name of [
    'id', 'session_id', 'material_hash', 'state', 'trigger', 'user_id', 'role_id', 'workspace',
    'job_id', 'attempts', 'phase', 'summary', 'distilled_json', 'candidates',
    'rule_proposals', 'open_loops', 'report_path', 'hygiene_json', 'switch_ready_json',
    'error', 'created_at', 'updated_at',
  ]) assert.ok(cols.includes(name), `wrap_runs 缺列 ${name}`)
  const idx = db.prepare('PRAGMA index_list(wrap_runs)').all()
  assert.ok(idx.some((row) => Number(row.unique) === 1), '必须有 (session_id,material_hash) 唯一索引')
  db.close()
})

test('createRun：首次建、同键幂等、done 不重跑', () => {
  const db = db0()
  const first = createRun(db, {
    sessionId: 's1', materialHash: 'h1', trigger: 'explicit', identity: IDENT, now: 1000,
  })
  assert.equal(first.created, true)
  assert.equal(first.active, true)
  assert.equal(first.run.state, 'queued')
  assert.equal(first.run.trigger, 'explicit')

  const again = createRun(db, { sessionId: 's1', materialHash: 'h1', trigger: 'idle', identity: IDENT, now: 1001 })
  assert.equal(again.created, false, '同键不得新建')
  assert.equal(again.run.id, first.run.id)
  assert.equal(again.active, true)

  assert.equal(updateRun(db, first.run.id, { state: 'done', candidates: 2 }).ok, true)
  const afterDone = createRun(db, {
    sessionId: 's1', materialHash: 'h1', trigger: 'manual', identity: IDENT, now: 1002, reset: true,
  })
  assert.equal(afterDone.done, true)
  assert.equal(afterDone.reset, false, 'done 绝不能被 reset 重跑')
  assert.equal(getRun(db, first.run.id).candidates, 2)
  db.close()
})

test('createRun：failed/skipped 只有 reset=true 才复活，且保留蒸馏断点', () => {
  const db = db0()
  const run = createRun(db, { sessionId: 's2', materialHash: 'h2', trigger: 'idle', identity: IDENT, now: 2000 }).run
  updateRun(db, run.id, {
    state: 'skipped', error: 'no_model', phase: 'distilled',
    distilled_json: { summary: 's', items: [{ kind: 'lesson', text: 't', status: 'pending' }] },
  })

  const auto = createRun(db, { sessionId: 's2', materialHash: 'h2', trigger: 'idle', identity: IDENT, now: 2001 })
  assert.equal(auto.active, false, '自动触发不得复活终态')
  assert.equal(getRun(db, run.id).state, 'skipped')

  const manual = createRun(db, {
    sessionId: 's2', materialHash: 'h2', trigger: 'manual', identity: IDENT, now: 2002, reset: true,
  })
  assert.equal(manual.reset, true)
  assert.equal(manual.run.state, 'queued')
  assert.equal(manual.run.error, '', '重置要清掉上次原因')
  assert.equal(manual.run.distilled.summary, 's', '重置必须保留已蒸馏断点')
  assert.equal(manual.run.attempts, 0)
  db.close()
})

test('updateRun：白名单/state 校验/JSON 列编码，decodeRun 解回', () => {
  const db = db0()
  const run = createRun(db, { sessionId: 's3', materialHash: 'h3', trigger: 'manual', identity: IDENT, now: 3000 }).run
  assert.equal(updateRun(db, run.id, { state: 'bogus' }).ok, false)
  assert.equal(updateRun(db, run.id, { session_id: 'hijack' }).error, 'no_fields', '幂等键不可改')
  const ok = updateRun(db, run.id, {
    state: 'done', hygiene_json: { ok: true }, switch_ready_json: { ready: true },
  })
  assert.equal(ok.ok, true)
  const got = getRun(db, run.id)
  assert.equal(got.state, 'done')
  assert.equal(got.hygiene.ok, true)
  assert.equal(got.switchReady.ready, true)
  assert.equal(findRun(db, 's3', 'h3').id, run.id)
  assert.equal(latestRun(db).id, run.id)
  assert.equal(listRuns(db, 5)[0].id, run.id)
  db.close()
})

test('markRunAttempt/countRunsToday：attempts 累加、今日按本地自然日计数', () => {
  const db = db0()
  const now = new Date(2026, 10, 24, 23, 0, 0).getTime() / 1000
  const a = createRun(db, { sessionId: 's4', materialHash: 'h4', trigger: 'manual', identity: IDENT, now }).run
  createRun(db, { sessionId: 's5', materialHash: 'h5', trigger: 'idle', identity: IDENT, now: now - 86400 })
  assert.equal(countRunsToday(db, now), 1)
  // 自动额度口径：只统计 idle/disposed；manual/explicit 是人工动作。
  assert.equal(countRunsToday(db, now, { triggers: ['idle', 'disposed'] }), 0)
  const auto = createRun(db, { sessionId: 's4b', materialHash: 'h4b', trigger: 'idle', identity: IDENT, now }).run
  assert.equal(countRunsToday(db, now, { triggers: ['idle', 'disposed'] }), 1)
  void auto
  const marked = markRunAttempt(db, a.id, now)
  assert.equal(marked.state, 'running')
  assert.equal(marked.attempts, 1)
  markRunAttempt(db, a.id, now)
  assert.equal(getRun(db, a.id).attempts, 2)
  const decoded = decodeRun(db.prepare('SELECT * FROM wrap_runs WHERE id=?').get(a.id))
  assert.equal(decoded.distilled, null)
  db.close()
})

test('createRun：缺键拒绝；同材料不同会话/不同材料不同会话各自一行', () => {
  const db = db0()
  assert.equal(createRun(db, { sessionId: '', materialHash: 'h', now: 1 }).ok, false)
  const a = createRun(db, { sessionId: 's6', materialHash: 'h6', trigger: 'manual', now: 1 })
  const b = createRun(db, { sessionId: 's7', materialHash: 'h6', trigger: 'manual', now: 1 })
  const c = createRun(db, { sessionId: 's6', materialHash: 'h7', trigger: 'manual', now: 1 })
  assert.equal(new Set([a.run.id, b.run.id, c.run.id]).size, 3)
  db.close()
})
