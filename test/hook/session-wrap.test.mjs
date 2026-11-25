/**
 * Session Wrap 编排集成单测（真 SQLite 临时库 + 假 keeper/模型）。
 *
 * 覆盖：入队即幂等/日志不含正文、单次蒸馏→候选 shadow→报告→清洁→可切会话、
 * 无模型可重试、断点续跑不重复调模型、写失败不标 done、规则只提案、TTL 清扫、启动对账。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    tickCount: 0,
    tick() { this.tickCount += 1; return Promise.resolve({ ran: [] }) },
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

function setup(t, { overrides = {}, llm = llmOf(VALID_OUTPUT), selection = { provider: 'p', model: 'm' }, logLines = null } = {}) {
  const { dir, db } = fresh(t)
  const config = configOf(dir, overrides)
  const { backend, writes } = fakeBackend(t, dir, db)
  const keeper = fakeKeeper(db)
  const captureRef = { current: { advanceCalls: [], advance(sid, seq) { this.advanceCalls.push([sid, seq]) }, async triggerRecent() { return { ok: true, runId: 99 } } } }
  const wrap = installSessionWrap({ effect: (fn) => fn() }, {
    backend, config, keeper, captureRef, log: logLines ? (line) => logLines.push(String(line)) : () => {},
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

  assert.ok(s.keeper.tickCount >= 1, '入队后必须主动踢一次 keeper（立即收尾不能等 10 分钟 tick）')
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

test('TTL 清扫：只删超期 spool；对账：queued 不续跑（queue_cleared）、running 才补 job', async (t) => {
  const s = setup(t)
  const { out, job } = await queueRun(s, {})
  // 模拟“入队后进程死掉、job 丢了” + 内存队列清空（重启）。
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id))
  const recon = s.wrap.reconcile()
  assert.equal(recon.abandoned, 1, 'queued 且无活 job 必须按队列已清理处理')
  assert.equal(recon.requeued, 0, 'S1b 不再静默续跑 queued')
  const cleared = s.withDb((db) => getRun(db, out.runId))
  assert.equal(cleared.state, 'failed')
  assert.equal(cleared.error, 'queue_cleared')
  assert.equal(existsSync(job.payload.spoolPath), false, '清理必须删 spool')

  // running（执行中进程被杀）仍要补 job（铁律 3 的续跑面）。
  const second = await queueRun(s, { sessionId: 's-running' })
  s.withDb((db) => db.prepare("UPDATE wrap_runs SET state='running' WHERE id=?").run(second.out.runId))
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(second.job.id))
  const recon2 = s.wrap.reconcile()
  assert.equal(recon2.requeued, 1)
  assert.equal(s.keeper.jobs.filter((item) => item.kind === 'wrap').length >= 2, true)

  const old = Date.now() / 1000 - 48 * 3600
  const { utimesSync } = await import('node:fs')
  utimesSync(second.job.payload.spoolPath, old, old)
  const swept = s.wrap.sweepSpool({ ttlHours: 24 })
  assert.equal(swept.deleted, 1)
  assert.equal(existsSync(second.job.payload.spoolPath), false)
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

test('S1b 手动不再 busy_wrap：运行中可回答，且不重复蒸馏（busy_wrap 错误码删除）', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, idle: true, disposed: true } } })
  await queueRun(s, {})
  const before = s.withDb((db) => Number(db.prepare('SELECT count(*) AS n FROM wrap_runs').get().n))
  const out = await s.wrap.manual()
  assert.equal(out.reason === 'busy_wrap', false, 'busy_wrap 已删除：运行中点击不得报“已有任务在跑”')
  assert.equal(s.withDb((db) => Number(db.prepare('SELECT count(*) AS n FROM wrap_runs').get().n)), before, '不得重复建 run')
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


test('保留策略：只删超期终态 run 与不再被引用的旧报告；queued/running 与在册报告不动', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, retentionDays: 2 } } })
  const { utimesSync } = await import('node:fs')
  const now = Date.now() / 1000
  const oldAt = now - 5 * 86400
  // 旧 done run + 旧报告（不在册）
  const oldRun = s.withDb((db) => db.prepare(`INSERT INTO wrap_runs
    (session_id,material_hash,state,trigger,phase,candidates,report_path,created_at,updated_at)
    VALUES ('old','old','done','idle','done',1,?,?,?)`).run(
    join(s.dir, 'reports', 'session-wrap-old.md'), oldAt, oldAt).lastInsertRowid)
  mkdirSync(join(s.dir, 'reports'), { recursive: true })
  const oldReport = join(s.dir, 'reports', 'session-wrap-old.md')
  writeFileSync(oldReport, '# old')
  utimesSync(oldReport, oldAt, oldAt)
  // 旧 done run 但报告仍被保留记录引用：报告不得删
  const keptReport = join(s.dir, 'reports', 'session-wrap-kept.md')
  writeFileSync(keptReport, '# kept')
  utimesSync(keptReport, oldAt, oldAt)
  const keptRun = s.withDb((db) => db.prepare(`INSERT INTO wrap_runs
    (session_id,material_hash,state,trigger,phase,report_path,created_at,updated_at)
    VALUES ('kept','kept','queued','idle','created',?,?,?)`).run(keptReport, oldAt, oldAt).lastInsertRowid)
  // 新 done run：不删
  const newRun = s.withDb((db) => db.prepare(`INSERT INTO wrap_runs
    (session_id,material_hash,state,trigger,phase,created_at,updated_at)
    VALUES ('new','new','done','idle','done',?,?)`).run(now, now).lastInsertRowid)

  const swept = s.wrap.sweepStorage()
  assert.equal(swept.runs, 1, '只删超期且终态的 run')
  assert.equal(swept.reports, 1, '只删不在册的旧报告')
  assert.equal(s.withDb((db) => db.prepare('SELECT count(*) n FROM wrap_runs WHERE id=?').get(oldRun).n), 0)
  assert.equal(existsSync(oldReport), false)
  assert.equal(existsSync(keptReport), true, '仍在册（queued）的报告不得删')
  assert.equal(s.withDb((db) => db.prepare('SELECT count(*) n FROM wrap_runs WHERE id=?').get(keptRun).n), 1)
  assert.equal(s.withDb((db) => db.prepare('SELECT count(*) n FROM wrap_runs WHERE id=?').get(newRun).n), 1)
})

// ---------------------------------------------------------------------------
// S1b 点击即排队：202/200/409、位次、队首推进、重启清空
// ---------------------------------------------------------------------------

test('S1b 连点同材料：1 个 run/job，后两次 existing（不重复建）', async (t) => {
  const s = setup(t)
  const first = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'same-h', now: Date.now() / 1000 })
  assert.equal(first.queued, true, '首次点击必须 202 语义入队')
  assert.ok(Number.isInteger(first.position) && first.position >= 1)
  const jobCount = () => s.keeper.jobs.filter((item) => item.kind === 'wrap').length
  assert.equal(jobCount(), 1)
  for (let i = 0; i < 2; i += 1) {
    const again = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'same-h', now: Date.now() / 1000 })
    assert.equal(again.existing, true)
    assert.equal(again.ok, true)
  }
  assert.equal(s.withDb((db) => Number(db.prepare('SELECT count(*) AS n FROM wrap_runs').get().n)), 1)
  assert.equal(jobCount(), 1, '幂等点击不得新增 job')
})

test('S1b 同会话第二条不同材料 → session_queue_full；全局满 → busy_queue_full', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, maxQueued: 1 } } })
  // 第一条开跑（job 已在跑）→ 队列空；第二条不同材料进队列；第三条撞全局上限。
  const first = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'h-a', now: Date.now() / 1000 })
  assert.equal(first.queued, true)
  const second = await s.wrap.onTrigger({ sessionId: 's1', trigger: 'manual', material: { ...MATERIAL, seqTo: 9 }, identity: { userId: 'u1' }, header: {}, hash: 'h-b', now: Date.now() / 1000 })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'session_queue_full')

  const other = await s.wrap.onTrigger({ sessionId: 's2', trigger: 'manual', material: { ...MATERIAL, seqTo: 11 }, identity: { userId: 'u1' }, header: {}, hash: 'h-c', now: Date.now() / 1000 })
  assert.equal(other.ok, true, '不同会话应能排队')
  const third = await s.wrap.onTrigger({ sessionId: 's3', trigger: 'manual', material: { ...MATERIAL, seqTo: 12 }, identity: { userId: 'u1' }, header: {}, hash: 'h-d', now: Date.now() / 1000 })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'busy_queue_full')
})

test('S1b status.queued：有排队时 count/position/phase=null；无排队为 null', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, maxQueued: 2 } } })
  await s.wrap.onTrigger({ sessionId: 'run-a', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'h1', now: Date.now() / 1000 })
  assert.equal(s.wrap.status().queued, null, '首条已开跑，队列为空')
  await s.wrap.onTrigger({ sessionId: 'queue-b', trigger: 'manual', material: { ...MATERIAL, seqTo: 8 }, identity: { userId: 'u1' }, header: {}, hash: 'h2', now: Date.now() / 1000 })
  const queued = s.wrap.status().queued
  assert.equal(queued.count, 1)
  assert.equal(queued.position, 1)
  assert.equal(queued.phase, null)
  assert.ok(queued.materialHash.length > 0)
  assert.deepEqual(s.wrap.status().auto, { enabled: false, idleMinutes: 0 }, 'S1b auto 固定 false/0')
})

test('S1b 队首完成后自动推进下一条（handler finally → pump）', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, maxQueued: 2 } }, llm: llmOf(VALID_OUTPUT) })
  const a = await s.wrap.onTrigger({ sessionId: 'a', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'ha', now: Date.now() / 1000 })
  const b = await s.wrap.onTrigger({ sessionId: 'b', trigger: 'manual', material: { ...MATERIAL, seqTo: 8 }, identity: { userId: 'u1' }, header: {}, hash: 'hb', now: Date.now() / 1000 })
  assert.equal(b.queued, true)
  const jobA = s.keeper.jobs.find((item) => item.kind === 'wrap' && item.payload.runId === a.runId)
  await s.keeper.handlers.get('wrap')(jobA.payload, { jobId: jobA.id, log: () => {}, now: () => Date.now() / 1000 })
  // 真 keeper 会在 handler resolve 后把 job 置 done；这里显式模拟，再等 finally 的 setImmediate。
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(jobA.id))
  await new Promise((resolve) => setImmediate(resolve))
  const jobB = s.keeper.jobs.find((item) => item.kind === 'wrap' && item.payload.runId === b.runId)
  assert.ok(jobB, 'A 完成后必须自动踢 B')
})

test('S1b 日志证据：入队日志含 run id 与位次，且不含正文（与 status.latest.id 对得上）', async (t) => {
  const logLines = []
  const s = setup(t, { logLines })
  const out = await s.wrap.onTrigger({ sessionId: 'grep-s1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'gh', now: Date.now() / 1000 })
  const line = logLines.find((item) => item.includes('wrap queued run='))
  assert.ok(line, '必须留可以 grep 的入队日志')
  assert.match(line, new RegExp(`wrap queued run=${out.runId} `))
  assert.match(line, /position=1/)
  assert.equal(logLines.some((item) => item.includes('动库前先备份')), false, '日志不得含正文')
  const latest = s.wrap.status().latest
  assert.equal(latest.id, out.runId)
})

test('S1b 重启后 queued 清空：reconcile 标 queue_cleared，status.lastSkip 可见', async (t) => {
  const s = setup(t, { overrides: { wrap: { ...configOf('/tmp').wrap, maxQueued: 2 } } })
  const a = await s.wrap.onTrigger({ sessionId: 'q1', trigger: 'manual', material: MATERIAL, identity: { userId: 'u1' }, header: {}, hash: 'q-h1', now: Date.now() / 1000 })
  // 模拟重启：job 丢失、状态仍是 queued。
  s.withDb((db) => db.prepare("UPDATE jobs SET state='done' WHERE kind='wrap'").run())
  const recon = s.wrap.reconcile()
  assert.equal(recon.abandoned, 1)
  const status = s.wrap.status()
  assert.equal(status.queued, null, '队列必须清空')
  assert.equal(status.lastSkip.reason, 'queue_cleared')
  const run = s.withDb((db) => getRun(db, a.runId))
  assert.equal(run.state, 'failed')
  assert.equal(run.error, 'queue_cleared')
})
