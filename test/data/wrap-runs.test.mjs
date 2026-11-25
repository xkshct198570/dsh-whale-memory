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

test('schema v6：wrap_runs 表/状态列齐 + 去唯一键（允许失败重试新建行）+ prefs 表', () => {
  const db = db0()
  const cols = db.prepare('PRAGMA table_info(wrap_runs)').all().map((c) => c.name)
  for (const name of [
    'id', 'session_id', 'material_hash', 'state', 'trigger', 'user_id', 'role_id', 'workspace',
    'job_id', 'attempts', 'phase', 'summary', 'distilled_json', 'candidates',
    'rule_proposals', 'open_loops', 'report_path', 'hygiene_json', 'switch_ready_json',
    'error', 'created_at', 'updated_at',
  ]) assert.ok(cols.includes(name), `wrap_runs 缺列 ${name}`)
  const idx = db.prepare('PRAGMA index_list(wrap_runs)').all()
  assert.equal(idx.some((row) => Number(row.unique) === 1), false, 'v6 去掉唯一约束：失败耗尽后允许新 run 行')
  assert.ok(idx.some((row) => String(row.name) === 'idx_wrap_runs_material'), '必须有 (session_id,material_hash,id) 查询索引')
  const prefs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wrap_session_prefs'").get()
  assert.ok(prefs, 'v6 必须有 wrap_session_prefs')
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

test('S2/v6：failed 且 attempts 耗尽 + reset → 新建 run（新 runId），历史行保留', () => {
  const db = db0()
  const first = createRun(db, { sessionId: 's-ex', materialHash: 'h-ex', trigger: 'manual', identity: IDENT, now: 10 }).run
  updateRun(db, first.id, { state: 'failed', attempts: 4, error: 'bad_json:bad_json' })
  const next = createRun(db, { sessionId: 's-ex', materialHash: 'h-ex', trigger: 'manual', identity: IDENT, now: 11, reset: true, maxAttempts: 4 })
  assert.equal(next.ok, true)
  assert.equal(next.created, true, '耗尽后必须新建行')
  assert.notEqual(next.run.id, first.id, '必须是新 runId')
  assert.equal(next.run.state, 'queued')
  // 历史行仍可查（不物理删）。
  const old = db.prepare('SELECT state,attempts FROM wrap_runs WHERE id=?').get(first.id)
  assert.equal(old.state, 'failed')
  assert.equal(Number(old.attempts), 4)
  // 同材料再点仍是同一新 run（幂等）。
  const again = createRun(db, { sessionId: 's-ex', materialHash: 'h-ex', trigger: 'manual', identity: IDENT, now: 12, reset: true })
  assert.equal(again.run.id, next.run.id)
})

test('S2/v6：未耗尽的 failed + reset → 重置同一行（保留断点、attempts 归零）', () => {
  const db = db0()
  const run = createRun(db, { sessionId: 's-mid', materialHash: 'h-mid', trigger: 'manual', identity: IDENT, now: 20 }).run
  updateRun(db, run.id, { state: 'failed', attempts: 2, error: 'model_timeout', distilled_json: { items: [] } })
  const reset = createRun(db, { sessionId: 's-mid', materialHash: 'h-mid', trigger: 'manual', identity: IDENT, now: 21, reset: true, maxAttempts: 4 })
  assert.equal(reset.run.id, run.id)
  assert.equal(reset.reset, true)
  assert.equal(reset.run.state, 'queued')
  assert.equal(Number(reset.run.attempts), 0)
})
