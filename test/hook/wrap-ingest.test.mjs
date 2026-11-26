/**
 * S1 收尾写入应用层：dispatch/reconcile 一律带 ingestPolicy，状态映射与计数单一投影。
 *
 * 断言真实产物：writes 行的 action/payload、run 的 counts 列与 distilled_json.counts；
 * backend 用桩只为注入不同决策结果，落库/审计仍走真 SQLite。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../../src/core/db.js'
import { createRun, getRun } from '../../src/core/wrap-runs.js'
import { countsOf, runPatchOf } from '../../src/host/session-wrap/ingest.js'
import { dispatchPhase, WRAP_ORIGIN } from '../../src/host/session-wrap/dispatch.js'
import { applyReconcile } from '../../src/host/session-wrap/reconcile.js'

const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }
const INGEST = { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true }

function freshWrap(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-wrap-ingest-'))
  const db = openDb(dir)
  t.after(() => closeDb(db))
  const run = createRun(db, { sessionId: 's1', materialHash: 'h1', trigger: 'manual', identity: IDENT, now: Date.now() / 1000 }).run
  return { dir, db, run, withDb: (fn) => fn(db) }
}

/** 按正文关键字返回不同动作，模拟 backend 的完整状态面。 */
function stubBackend(decisions) {
  const writes = []
  return {
    writes,
    async write(q) {
      writes.push(q)
      const hit = decisions[String(q.text)] || { ok: true, id: 'n-add', action: 'ADD' }
      return hit
    },
  }
}

function itemsOf() {
  return [
    { kind: 'lesson', text: '动库前必须先备份', confidence: 0.9, tags: ['运维'] },
    { kind: 'fact', text: '刚才那个端口可能变了', confidence: 0.8, tags: [] },
    { kind: 'decision', text: '先跑一遍全量门禁', confidence: 0.9, tags: [] },
    { kind: 'preference', text: '基线只在全绿后刷新', confidence: 0.9, tags: [] },
    { kind: 'rule', text: '以后动库前必须备份', confidence: 0.9, tags: [] },
    { kind: 'open_loop', text: '补一条备份校验脚本', confidence: 0.6, tags: [] },
  ]
}

test('countsOf：新状态 ingested/review/skipped 与旧 written+candidate 兼容；candidates=reviewed', () => {
  const counts = countsOf([
    { status: 'ingested' }, { status: 'review' }, { status: 'skipped:gate:task' },
    { status: 'noop' }, { status: 'written', candidate: true }, { status: 'written', candidate: false },
    { status: 'proposal' }, { status: 'open_loop' }, { status: 'write_failed:x' },
  ])
  assert.deepEqual(counts, {
    candidates: 2, ingested: 2, reviewed: 2, skipped: 1, rule_proposals: 1, open_loops: 1,
  })
  const patch = runPatchOf({ summary: 's' }, [{ status: 'review' }, { status: 'ingested' }])
  assert.deepEqual(patch.distilled_json.counts, { ingested: 1, reviewed: 1, skipped: 0 })
  assert.equal(patch.candidates, 1)
})

test('dispatch：普通项一律带 ingestPolicy、source=self；状态映射/计数/run 断点一致', async (t) => {
  const { db, run, withDb } = freshWrap(t)
  const items = itemsOf()
  const backend = stubBackend({
    '动库前必须先备份': { ok: true, id: 'n-a', action: 'ADD' },
    '刚才那个端口可能变了': { ok: true, action: 'CANDIDATE' },
    '先跑一遍全量门禁': { ok: false, action: 'REJECT', error: 'gate:task' },
    '基线只在全绿后刷新': { ok: true, id: 'n-b', action: 'NOOP' },
  })
  const proposals = []
  const out = await dispatchPhase({
    items, distilled: { summary: 's', items }, spool: { identity: IDENT, sessionId: 's1' },
    runId: run.id, config: { write: { enabled: true }, rules: { enabled: true } },
    backend, ingest: INGEST, withDb,
    createProposal: (arg) => { proposals.push(arg); return { ok: true, proposal: { id: 'p1' } } },
  })
  assert.equal(out.failures.length, 0)
  const byText = new Map(out.items.map((item) => [item.text, item]))
  assert.equal(byText.get('动库前必须先备份').status, 'ingested')
  assert.equal(byText.get('刚才那个端口可能变了').status, 'review')
  assert.equal(byText.get('先跑一遍全量门禁').status, 'skipped:gate:task')
  assert.equal(byText.get('基线只在全绿后刷新').status, 'noop')
  assert.equal(byText.get('以后动库前必须备份').status, 'proposal')
  assert.equal(byText.get('补一条备份校验脚本').status, 'open_loop')
  assert.equal(proposals.length, 1)

  for (const q of backend.writes) {
    assert.equal(q.source, 'self', 'wrap 自产记忆必须 source=self')
    assert.equal(q.origin, WRAP_ORIGIN)
    assert.deepEqual(q.ingestPolicy, {
      mode: INGEST.mode, minConfidence: INGEST.minConfidence,
      dropTaskInstructions: INGEST.dropTaskInstructions, confidence: q.ingestPolicy.confidence,
    })
    assert.equal(typeof q.ingestPolicy.confidence, 'number')
    assert.equal(q.traceId, `wrap:${run.id}`)
  }
  const saved = getRun(db, run.id)
  assert.deepEqual(saved.distilled.counts, { ingested: 1, reviewed: 1, skipped: 1 })
  assert.equal(saved.candidates, 1)
  assert.equal(saved.open_loops, 1)
  assert.equal(saved.rule_proposals, 1)
  assert.equal(saved.phase, 'written')
})

test('dispatch：写失败保留 write_failed 与 failures（可重试），不静默 done', async (t) => {
  const { run, withDb } = freshWrap(t)
  const backend = stubBackend({ '动库前必须先备份': { ok: false, error: 'db_locked' } })
  const out = await dispatchPhase({
    items: [{ kind: 'lesson', text: '动库前必须先备份', confidence: 0.9 }],
    distilled: { items: [] }, spool: { identity: IDENT }, runId: run.id,
    config: { write: { enabled: true }, rules: { enabled: true } },
    backend, ingest: INGEST, withDb, createProposal: () => ({ ok: false }),
  })
  assert.equal(out.items[0].status, 'write_failed:db_locked')
  assert.equal(out.failures.length, 1)
  assert.equal(getRun(dbOf(withDb), run.id).distilled.counts.ingested, 0)
})

function dbOf(withDb) {
  let found = null
  withDb((db) => { found = db })
  return found
}

test('reconcile：ADD 走 ingestPolicy、ARCHIVE 仍 CANDIDATE、NOOP 只审计；计数与状态一致', async (t) => {
  const { db, run, withDb } = freshWrap(t)
  const items = [
    { kind: 'lesson', text: '动库前必须先备份', confidence: 0.9 },
    { kind: 'fact', text: '端口 3080 已作废', confidence: 0.9 },
    { kind: 'preference', text: '基线只在全绿后刷新', confidence: 0.9 },
  ]
  const decisions = [
    { item: 0, op: 'ADD', targetId: '', afterText: '动库前必须先备份', reason: '新事实' },
    { item: 1, op: 'ARCHIVE', targetId: 'n-old', afterText: '', reason: '作废' },
    { item: 2, op: 'NOOP', targetId: 'n-other', afterText: '基线只在全绿后刷新', reason: '已有' },
  ]
  const backend = stubBackend({ '动库前必须先备份': { ok: true, id: 'n-new', action: 'ADD' } })
  const out = await applyReconcile({
    items, distilled: { items }, spool: { identity: IDENT }, runId: run.id,
    decisions, rejected: [], config: {}, backend, ingest: INGEST, withDb,
  })
  assert.equal(out.failures.length, 0)
  assert.equal(out.items[0].status, 'ingested')
  assert.equal(out.items[0].nodeId, 'n-new')
  assert.equal(out.items[1].status, 'review')
  assert.equal(out.items[2].status, 'noop')

  assert.equal(backend.writes.length, 1, '只有 ADD 走 backend.write')
  assert.equal(backend.writes[0].ingestPolicy.mode, 'auto')
  assert.equal(backend.writes[0].source, 'self')

  const audit = db.prepare("SELECT action,payload,reason FROM writes WHERE action IN ('CANDIDATE','NOOP') ORDER BY id").all()
  const archive = audit.find((row) => JSON.parse(row.payload).shadowOf === 'ARCHIVE')
  assert.ok(archive, 'ARCHIVE 必须落 CANDIDATE 审计')
  assert.equal(archive.action, 'CANDIDATE')
  assert.ok(audit.some((row) => row.action === 'NOOP'), 'NOOP 必须留审计')

  const saved = getRun(db, run.id)
  assert.deepEqual(saved.distilled.counts, { ingested: 1, reviewed: 1, skipped: 0 })
  assert.equal(saved.candidates, 1)
})

test('reconcile 续跑：终态条目不得重放（已入库不会被改 NOOP，计数不丢）', async (t) => {
  const { db, run, withDb } = freshWrap(t)
  const items = [
    { kind: 'lesson', text: '动库前必须先备份', confidence: 0.9 },
    { kind: 'fact', text: '发布前必须跑全量门禁', confidence: 0.9 },
  ]
  const decisions = items.map((item, i) => ({ item: i, op: 'ADD', targetId: '', afterText: item.text, reason: 'new' }))
  let failOnce = true
  const backend = {
    writes: [],
    async write(q) {
      this.writes.push(q)
      if (failOnce && String(q.text) === '发布前必须跑全量门禁') {
        failOnce = false
        return { ok: false, error: 'db_locked' }
      }
      return { ok: true, id: `n-${this.writes.length}`, action: 'ADD' }
    },
  }
  const first = await applyReconcile({
    items, distilled: { items }, spool: { identity: IDENT }, runId: run.id,
    decisions, rejected: [], config: {}, backend, ingest: INGEST, withDb,
  })
  assert.equal(first.items[0].status, 'ingested')
  assert.equal(first.items[1].status, 'write_failed:db_locked')
  assert.equal(backend.writes.length, 2)
  const runAfterFirst = getRun(db, run.id)
  assert.deepEqual(runAfterFirst.distilled.counts, { ingested: 1, reviewed: 0, skipped: 0 })

  // 重试：只补 write_failed 的那条；已入库条目不得再次写库
  const second = await applyReconcile({
    items: first.items, distilled: { items: first.items }, spool: { identity: IDENT }, runId: run.id,
    decisions, rejected: [], config: {}, backend, ingest: INGEST, withDb,
  })
  assert.equal(backend.writes.length, 3, '第二遍只允许补写失败条目一次')
  assert.equal(second.items[0].status, 'ingested')
  assert.equal(second.items[1].status, 'ingested')
  const runAfterSecond = getRun(db, run.id)
  assert.deepEqual(runAfterSecond.distilled.counts, { ingested: 2, reviewed: 0, skipped: 0 })
})
