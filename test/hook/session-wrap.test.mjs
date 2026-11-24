/**
 * Session Wrap 编排集成单测（真 SQLite 临时库 + 假 keeper/模型）。
 *
 * 覆盖：入队即幂等/日志不含正文、单次蒸馏→候选 shadow→报告→清洁→可切会话、
 * 无模型可重试、断点续跑不重复调模型、写失败不标 done、规则只提案、TTL 清扫、启动对账。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../../src/core/db.js'
import { installSessionWrap, resolveDataDir } from '../../src/host/session-wrap.js'
import { getRun, updateRun } from '../../src/core/wrap-runs.js'

function fresh(t, suffix = '') {
  const dir = mkdtempSync(join(tmpdir(), `whale-wrap-${suffix}`))
  const db = openDb(dir)
  t.after(() => { closeDb(db) })
  return { dir, db }
}

function configOf(dir, overrides = {}) {
  return {
    dataDir: dir,
    wrap: {
      enabled: true, explicit: true, idle: true, disposed: true, idleMinutes: 10,
      maxItems: 8, autoAccept: false, spoolTtlHours: 24, maxRunsPerDay: 6,
      report: true, model: '', maxMaterialChars: 12000, timeoutMs: 5000,
    },
    write: { enabled: true, reviewMode: 'auto' },
    rules: { enabled: true, dir: join(dir, 'rules'), requireGit: false },
    privacy: { redact: true },
    consolidate: { enabled: true },
    ...overrides,
  }
}

function fakeBackend(t, dir, db) {
  const writes = []
  const backend = {
    dbFile: join(dir, 'memory.db'),
    withDb: (fn) => fn(db),
    async write(q) {
      writes.push(q)
      return { ok: true, id: `n${writes.length}`, action: q.forceShadow ? 'CANDIDATE' : 'ADD', candidate: Boolean(q.forceShadow) }
    },
  }
  return { backend, writes }
}

function fakeKeeper(db) {
  const jobs = []
  const handlers = new Map()
  return {
    jobs,
    handlers,
    register(kind, fn) { handlers.set(kind, fn); return this },
    enqueue(kind, payload = {}) {
      const ts = Date.now() / 1000
      const id = Number(db.prepare(`INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at)
        VALUES (?,'queued',0,?,?,?)`).run(kind, JSON.stringify(payload), ts, ts).lastInsertRowid)
      jobs.push({ id, kind, payload })
      return id
    },
    status() {
      const rows = db.prepare('SELECT id,kind,state,attempts,last_error FROM jobs ORDER BY id DESC LIMIT 200').all()
      let running = 0
      let queued = 0
      let failed = 0
      for (const row of rows) {
        if (row.state === 'running') running += 1
        else if (row.state === 'queued') queued += 1
        else if (row.state === 'failed') failed += 1
      }
      return { running, queued, failed, jobs: rows }
    },
  }
}

function llmOf(payload) {
  return {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(payload) }
    },
  }
}

const MATERIAL = {
  turns: [
    { role: 'user', text: '以后都必须在动库前备份，这是铁律', turn: 1, seq: 2 },
    { role: 'assistant', text: '记住了：动库前先备份。', turn: 1, seq: 3 },
  ],
  seqTo: 3,
  chars: 30,
}

const VALID_OUTPUT = {
  summary: '本轮确认动库前必须先备份',
  items: [
    { kind: 'lesson', text: '动库前必须先备份', evidence: '动库前先备份', confidence: 0.9, tags: ['运维'] },
    { kind: 'open_loop', text: '补一条备份校验脚本', evidence: '动库前先备份', confidence: 0.6, tags: [] },
  ],
}

function setup(t, { overrides = {}, llm = llmOf(VALID_OUTPUT), selection = { provider: 'p', model: 'm' } } = {}) {
  const { dir, db } = fresh(t)
  const config = configOf(dir, overrides)
  const { backend, writes } = fakeBackend(t, dir, db)
  const keeper = fakeKeeper(db)
  const captureRef = { current: { advanceCalls: [], advance(sid, seq) { this.advanceCalls.push([sid, seq]) }, async triggerRecent() { return { ok: true, runId: 99 } } } }
  const wrap = installSessionWrap({ effect: (fn) => fn() }, {
    backend, config, keeper, captureRef, log: () => {},
    getLlm: () => llm, getSelection: () => selection,
  })
  return { dir, db, withDb: (fn) => fn(db), config, backend, writes, keeper, captureRef, wrap }
}

async function queueRun(s, { trigger = 'explicit', material = MATERIAL, identity = { userId: 'u1', roleId: '', workspace: '/w' }, sessionId = 's1', hash = 'hash-1' } = {}) {
  const out = await s.wrap.onTrigger({ sessionId, trigger, material, identity, header: { id: sessionId, cwd: '/w' }, hash, now: Date.now() / 1000 })
  assert.equal(out.ok, true, JSON.stringify(out))
  const job = s.keeper.jobs.find((item) => item.kind === 'wrap' && item.payload.runId === out.runId)
  assert.ok(job, 'wrap job 必须入队')
  return { out, job, payload: job.payload }
}

test('onTrigger：run+spool+job 幂等；spool 0600；job payload 只含指针不含正文', async (t) => {
  const s = setup(t)
  const { out, payload } = await queueRun(s, {})
  assert.ok(out.runId > 0)
  assert.equal(payload.runId, out.runId)
  assert.equal(typeof payload.spoolPath, 'string')
  assert.equal(JSON.stringify(payload).includes('动库前'), false, 'job payload 不得含对话正文')
  const spool = JSON.parse(readFileSync(payload.spoolPath, 'utf8'))
  assert.equal(spool.sessionId, 's1')
  assert.equal(spool.identity.workspace, '/w')
  assert.equal(spool.material.seqTo, 3)
  const mode = statSync(payload.spoolPath).mode & 0o777
  assert.equal(mode, 0o600, `spool 权限必须 0600，实际 ${mode.toString(8)}`)

  const again = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'explicit', material: MATERIAL, identity: { userId: 'u1' }, header: { id: 's1' }, hash: 'hash-1', now: Date.now() / 1000 })
  assert.equal(again.ok, true)
  assert.equal(again.existing, true, '同材料必须幂等')
  assert.equal(s.keeper.jobs.filter((job) => job.kind === 'wrap').length, 1, '不得重复入队')
})

test('execute：蒸馏→候选 shadow→报告无原文→清洁→可切会话→删 spool→巩固入队', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  const result = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(result.runId, out.runId)
  assert.equal(result.candidates, 1)
  assert.equal(result.openLoops, 1)
  assert.equal(result.switchReady.ready, true, JSON.stringify(result.switchReady))

  assert.equal(s.writes.length, 1)
  assert.equal(s.writes[0].forceShadow, true, '默认候选必须强制 shadow')
  assert.equal(s.writes[0].origin, 'session-wrap')
  assert.equal(s.writes[0].traceId, `wrap:${out.runId}`)
  assert.deepEqual(s.writes[0].tags.slice(0, 1), ['session-wrap'])

  const run = s.withDb((db) => getRun(db, out.runId))
  assert.equal(run.state, 'done')
  assert.equal(run.phase, 'done')
  assert.equal(run.candidates, 1)
  assert.equal(run.open_loops, 1)
  assert.equal(run.switchReady.ready, true)
  assert.ok(run.report_path && existsSync(run.report_path))
  const report = readFileSync(run.report_path, 'utf8')
  assert.match(report, /## 记忆候选/)
  assert.equal(report.includes('记住了：动库前先备份。'), false, '报告不得包含原始对话')
  assert.equal(report.includes('“'), false)
  assert.equal(statSync(run.report_path).mode & 0o777, 0o600)

  assert.equal(existsSync(job.payload.spoolPath), false, '成功终态必须删 spool')
  assert.deepEqual(s.captureRef.current.advanceCalls, [['s1', 3]])
  const consolidate = s.keeper.jobs.filter((item) => item.kind === 'consolidate')
  assert.equal(consolidate.length, 1, '成功后必须入队一次巩固')

  // 重复执行同一 job：幂等，不调模型/不重复写
  const again = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(again.skipped, 'already_done')
  assert.equal(s.writes.length, 1)

  // 已成功材料再次触发：不重跑，但必须推进采集缓冲（否则后续 run 会把旧轮次再烧一遍）。
  const dup = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'explicit', material: MATERIAL, identity: { userId: 'u1' }, header: { id: 's1' }, hash: 'hash-1', now: Date.now() / 1000 })
  assert.equal(dup.done, true)
  assert.equal(s.captureRef.current.advanceCalls.length, 2)
})

test('无模型：skipped:no_model、保留 spool、不写候选/报告；手动重置后可重跑', async (t) => {
  const s = setup(t, { llm: null, selection: null })
  const { job } = await queueRun(s, {})
  const result = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(result.skipped, 'no_model')
  assert.equal(existsSync(job.payload.spoolPath), true, '可重试的跳过必须保留 spool')
  const run = s.withDb((db) => getRun(db, job.payload.runId))
  assert.equal(run.state, 'skipped')
  assert.equal(run.error, 'no_model')
  assert.equal(s.writes.length, 0)

  const reset = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: { id: 's1' }, hash: 'hash-1', now: Date.now() / 1000 })
  assert.equal(reset.ok, true)
  assert.equal(reset.existing, false, '终态重置必须重新入队')
  assert.equal(s.withDb((db) => getRun(db, job.payload.runId)).state, 'queued')
})

test('断点续跑：已有 distilled_json 时不调模型，只补 pending/failed 条目', async (t) => {
  const s = setup(t, { llm: null, selection: null })
  const { job } = await queueRun(s, {})
  s.withDb((db) => updateRun(db, job.payload.runId, {
    state: 'queued', phase: 'distilled', summary: '已蒸馏', distilled_json: {
      summary: '已蒸馏',
      dropped: [],
      items: [
        { kind: 'lesson', text: '已经写过的教训', evidence: 'x', status: 'written', nodeId: 'n9' },
        { kind: 'fact', text: '断点后要补的事实', evidence: 'y', status: 'pending' },
      ],
    },
  }))
  const result = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(result.candidates, 2)
  assert.equal(s.writes.length, 1, '只允许写 pending 的那一条')
  assert.equal(s.writes[0].text, '断点后要补的事实')
})

test('写失败：run=failed 且 job 抛错（不标 done），spool 保留；重试只补失败条', async (t) => {
  const s = setup(t)
  let fail = true
  s.backend.write = async (q) => {
    if (fail) { fail = false; return { ok: false, error: 'db_locked' } }
    s.writes.push(q)
    return { ok: true, id: 'n1', action: 'CANDIDATE', candidate: true }
  }
  const { job } = await queueRun(s, {})
  await assert.rejects(() => s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 }), /candidate_write_failed:1/)
  const failed = s.withDb((db) => getRun(db, job.payload.runId))
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /candidate_write_failed/)
  assert.equal(existsSync(job.payload.spoolPath), true, '失败必须保留 spool')
  assert.ok(failed.report_path && existsSync(failed.report_path), '失败也要有报告，列出失败条')
  assert.match(readFileSync(failed.report_path, 'utf8'), /写入失败/)

  const retry = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(retry.runId, job.payload.runId)
  assert.equal(s.writes.length, 1)
  assert.equal(s.withDb((db) => getRun(db, job.payload.runId)).state, 'done')
  assert.equal(existsSync(job.payload.spoolPath), false)
})

test('规则只提案：rule 条目走 createProposal（文件落 proposals/），不写 nodes；无规范证据则降级', async (t) => {
  const output = {
    summary: '规则候选',
    items: [
      { kind: 'rule', text: '以后都必须在动库前备份', evidence: '以后都必须在动库前备份', confidence: 0.9, tags: [] },
      { kind: 'rule', text: '部署完要观察十分钟', evidence: '动库前先备份', confidence: 0.8, tags: [] },
    ],
  }
  const s = setup(t, { llm: llmOf(output) })
  const { job } = await queueRun(s, {})
  const result = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(result.ruleProposals, 1, '只有带规范句证据的条目能成为提案')
  // 第二条证据不是规范句 → 降级为 lesson 走记忆候选（不是静默丢弃），所以恰好 1 条写入。
  assert.equal(s.writes.length, 1, '规则本身不得直接写 nodes；降级条目按 lesson 写入')
  assert.equal(s.writes[0].text, '部署完要观察十分钟')
  const proposalsDir = join(s.dir, 'rules', 'proposals')
  const files = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter((name) => name.endsWith('.json')) : []
  assert.ok(files.length >= 1, '提案文件必须落盘')
  const run = s.withDb((db) => getRun(db, job.payload.runId))
  assert.equal(run.state, 'done')
})

test('证据编造：全部丢弃 → skipped:no_items，不写空记忆、不写报告', async (t) => {
  const output = {
    summary: '编造摘要',
    items: [{ kind: 'lesson', text: '凭空捏造的教训', evidence: '这段原文根本不存在', confidence: 0.9, tags: [] }],
  }
  const s = setup(t, { llm: llmOf(output) })
  const { job } = await queueRun(s, {})
  const result = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(result.skipped, 'no_items')
  assert.equal(s.writes.length, 0)
  assert.equal(existsSync(job.payload.spoolPath), false, '无条目终态删 spool')
  const run = s.withDb((db) => getRun(db, job.payload.runId))
  assert.equal(run.state, 'skipped')
})

test('自动触发闸：maxRunsPerDay 到上限后 idle/disposed 拒绝，显式仍允许', async (t) => {
  const first = setup(t)
  const { dir, db } = first
  // 造满今日额度（默认 6）
  for (let i = 0; i < 6; i += 1) {
    const seeded = await first.wrap.onTrigger({ sessionId: `old${i}`, trigger: 'idle', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: `h-${i}`, now: Date.now() / 1000 })
    assert.equal(seeded.ok, true, `第 ${i} 次自动触发应成功：${JSON.stringify(seeded)}`)
    // 模拟 job 已完成：本用例只验额度闸，不验 busy 闸（真实 keeper 会把 job 标 done）。
    first.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE kind='wrap'").run())
  }
  const blocked = await first.wrap.onTrigger({ sessionId: 'new', trigger: 'idle', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'new-h', now: Date.now() / 1000 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'rate_limited')
  const explicit = await first.wrap.onTrigger({ sessionId: 'new', trigger: 'explicit', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'new-h', now: Date.now() / 1000 })
  assert.equal(explicit.ok, true, '显式触发是人工动作，不受自动额度限制')
  void db
  void dir
})

test('status：只给计数/状态，不返回候选正文；report 只读 run 记录且拒绝穿越', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  const status = s.wrap.status({})
  assert.equal(status.ok, true)
  assert.equal(status.latest.id, out.runId)
  assert.equal(JSON.stringify(status.latest).includes('动库前必须先备份'), false, 'status 不得带候选正文')

  const got = s.wrap.report(out.runId)
  assert.equal(got.ok, true)
  assert.match(got.text, /会话收尾报告/)
  // 路径穿越：把 report_path 篡改到目录外，必须拒绝
  s.withDb((db) => updateRun(db, out.runId, { report_path: '/etc/passwd' }))
  const bad = s.wrap.report(out.runId)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'report_path_outside')
})

test('TTL 清扫：只删超期 spool；对账：queued run 没有活 job 时补一条', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  // 把 job 标 done 模拟“入队后进程死掉、job 丢了”
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id))
  const recon = s.wrap.reconcile()
  assert.equal(recon.requeued, 1)
  assert.equal(s.keeper.jobs.filter((item) => item.kind === 'wrap').length, 2)

  const old = Date.now() / 1000 - 48 * 3600
  s.withDb((db) => db.prepare('UPDATE wrap_runs SET created_at=?, updated_at=? WHERE id=?').run(old, old, out.runId))
  // 手动把 spool mtime 改旧（fs.utimes）
  const { utimesSync } = await import('node:fs')
  utimesSync(job.payload.spoolPath, old, old)
  const swept = s.wrap.sweepSpool({ ttlHours: 24 })
  assert.equal(swept.deleted, 1)
  assert.equal(existsSync(job.payload.spoolPath), false)
})

test('resolveDataDir：优先真实 dbFile 目录，其次 config.dataDir', () => {
  assert.equal(resolveDataDir({ dbFile: '/x/memory.db' }, { dataDir: '/y' }), '/x')
  assert.equal(resolveDataDir({}, { dataDir: '/y' }), '/y')
})


// ---------------------------------------------------------------------------
// 审查 P1/P2 回归：终态写失败、软链越界、手动 busy、自动额度、unsupported、dispose 对账
// ---------------------------------------------------------------------------

test('P1 终态落库失败：execute 必须抛错、不删 spool、不推进缓冲；DB 恢复后重试成功', async (t) => {
  const s = setup(t)
  const { job } = await queueRun(s, {})
  s.withDb((db) => db.exec(`CREATE TRIGGER block_done BEFORE UPDATE OF state ON wrap_runs
    WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'done_blocked'); END;`))
  await assert.rejects(
    () => s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 }),
    /finalize_failed:done/,
  )
  const run = s.withDb((db) => getRun(db, job.payload.runId))
  assert.equal(run.state, 'running', 'finish 失败时 run 不得假装 done')
  assert.equal(existsSync(job.payload.spoolPath), true, '终态未落库不得删 spool')
  assert.deepEqual(s.captureRef.current.advanceCalls, [], '终态未落库不得推进采集缓冲')

  s.withDb((db) => db.exec('DROP TRIGGER block_done'))
  const retry = await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  assert.equal(retry.runId, job.payload.runId)
  assert.equal(s.withDb((db) => getRun(db, job.payload.runId)).state, 'done')
  assert.deepEqual(s.captureRef.current.advanceCalls, [['s1', 3]])
})

test('P2 报告软链越界：reports 内软链指向目录外必须拒绝', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  const { symlinkSync, writeFileSync } = await import('node:fs')
  const run = s.withDb((db) => getRun(db, out.runId))
  const outside = join(s.dir, '..', `secret-${process.pid}.md`)
  writeFileSync(outside, 'SECRET-OUTSIDE')
  const link = join(s.dir, 'reports', 'link-escape.md')
  try {
    symlinkSync(outside, link)
  } catch { t.skip('平台不支持软链'); return }
  s.withDb((db) => updateRun(db, out.runId, { report_path: link }))
  const got = s.wrap.report(out.runId)
  assert.equal(got.ok, false)
  assert.equal(got.error, 'report_path_outside')
  const { rmSync } = await import('node:fs')
  rmSync(outside, { force: true })
  void run
})

test('P2 报告目录缺失时的错误码口径：词法越界仍报 outside，不误报 unreadable', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  await s.keeper.handlers.get('wrap')(job.payload, { jobId: job.id, log: () => {}, now: () => Date.now() / 1000 })
  const { rmSync, writeFileSync } = await import('node:fs')
  const reportsDir = join(s.dir, 'reports')
  rmSync(reportsDir, { recursive: true, force: true })
  const outside = join(s.dir, '..', `lex-${process.pid}.md`)
  writeFileSync(outside, 'OUT')
  s.withDb((db) => updateRun(db, out.runId, { report_path: outside }))
  const got = s.wrap.report(out.runId)
  assert.equal(got.ok, false)
  assert.equal(got.error, 'report_path_outside')
  rmSync(outside, { force: true })
  void out
})

test('P2 手动 busy：已有 wrap job 排队时 manual 直接拒绝，不重复蒸馏', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, idle: true, disposed: true } } })
  await queueRun(s, {})
  const out = await s.wrap.manual()
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'busy_wrap')
})

test('P2 自动额度只算 idle/disposed；手动/显式不吃后台预算', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, maxRunsPerDay: 2 } } })
  // 两条手动 run（不执行，避免 busy 闸挡住后续 onTrigger 由测试自己清 job）
  for (let i = 0; i < 2; i += 1) {
    const got = await s.wrap.onTrigger({ sessionId: `m${i}`, trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: `mh-${i}`, now: Date.now() / 1000 })
    assert.equal(got.ok, true)
    s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE kind='wrap'").run())
  }
  const auto = await s.wrap.onTrigger({ sessionId: 'auto1', trigger: 'idle', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'ah-1', now: Date.now() / 1000 })
  assert.equal(auto.ok, true, '手动 run 不得消耗自动额度')
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE kind='wrap'").run())
  await s.wrap.onTrigger({ sessionId: 'auto2', trigger: 'idle', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'ah-2', now: Date.now() / 1000 })
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE kind='wrap'").run())
  const blocked = await s.wrap.onTrigger({ sessionId: 'auto3', trigger: 'idle', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'ah-3', now: Date.now() / 1000 })
  assert.equal(blocked.reason, 'rate_limited')
})

test('P2 unsupported 后端：status.enabled 必须 false，manual 501 原因', async (t) => {
  const { dir, db } = fresh(t)
  const config = configOf(dir)
  const keeper = fakeKeeper(db)
  const wrap = installSessionWrap({ effect: (fn) => fn() }, {
    backend: { async write() {} }, config, keeper, log: () => {}, getLlm: () => null, getSelection: () => null,
  })
  const status = wrap.status({})
  assert.equal(status.supported, false)
  assert.equal(status.enabled, false)
  const manual = await wrap.manual()
  assert.equal(manual.ok, false)
  assert.equal(manual.reason, 'unsupported_backend')
})

test('P2 dispose 后启动对账定时器不得再入队', async (t) => {
  const { dir, db } = fresh(t)
  const config = configOf(dir)
  const { backend } = fakeBackend(t, dir, db)
  const keeper = fakeKeeper(db)
  const captureRef = { current: null }
  const wrap = installSessionWrap({ effect: (fn) => fn() }, {
    backend, config, keeper, captureRef, log: () => {}, getLlm: () => null, getSelection: () => null,
    reconcileDelayMs: 60,
  })
  // 造一条 queued run 但没有 spool/job：对账若仍跑会尝试入队或标 failed。
  const runOut = await wrap.onTrigger({ sessionId: 'd1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'dh', now: Date.now() / 1000 })
  assert.equal(runOut.ok, true)
  sDeleteSpool(runOut, keeper, db)
  wrap.dispose()
  await new Promise((resolve) => setTimeout(resolve, 160))
  const jobs = Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='wrap'").get().n)
  assert.equal(jobs, 1, 'dispose 后不得再补 job')
})

function sDeleteSpool(runOut, keeper, db) {
  const job = db.prepare("SELECT payload FROM jobs WHERE kind='wrap' ORDER BY id DESC LIMIT 1").get()
  try {
    const payload = JSON.parse(String(job?.payload || '{}'))
    rmSync(payload.spoolPath, { force: true })
  } catch { /* ignore */ }
  void runOut
}
