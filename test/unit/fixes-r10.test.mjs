/**
 * R10 修复回归：把 2026-11-23 审计里"静默失效/数据不变式"类缺陷逐条钉死。
 *
 * 覆盖：v4 同文唯一（含规则镜像豁免）/ withTx 只认嵌套 / 审核身份与状态闸 /
 * enqueue 跨队列终态结算 / FTS 观测与 ready 真探测 / import 崩溃续跑 /
 * duplicate_key + purge 双目录 / 空列表镜像归档 / 默认规则恢复 / 僵尸锁状态 /
 * volatile Ref 保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, openDb } from '../../src/core/db.js'
import { ensureSchema, dedupeActiveHashes } from '../../src/core/schema.js'
import { withTx } from '../../src/core/writer.js'
import { LocalBackend } from '../../src/core/backend.js'
import { search, ftsStats } from '../../src/core/search.js'
import { listRules, purgeRule, writeRule } from '../../src/core/rule-store.js'
import { mirrorRules } from '../../src/core/rule-mirror.js'
import { restoreDefaultRule } from '../../src/core/rule-defaults.js'
import { lockState } from '../../src/core/rule-lock.js'
import { mergePreservingVolatile, isVolatileRef } from '../../src/host/config-values.js'
import { statusOf, localeKeyOf } from '../../src/shared/error-table.mjs'

function tmp(t, prefix = 'whale-r10-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function frontOf(overrides = {}) {
  return {
    key: 'rule-1', type: 'rule', number: 1, priority: 'P1', scope: 'global', role: '',
    modality: 'must', action: '', object: '', conditions: [], exceptions: [],
    status: 'active', merged_into: '', superseded_by: '',
    created: '2026-11-23', updated: '2026-11-23', version: 1, origin: 'unit', ...overrides,
  }
}

/** 直插一条活跃节点（绕过 writer，模拟旧库/竞态现场）。 */
function rawNode(db, { id, text, hash, origin = '', status = 'active', userId = '', roleId = '', workspace = '' }) {
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,status,role_id,user_id,workspace,origin,
    created_at,updated_at) VALUES (?,?,?,'',?,?,?,?,?,?,?)`).run(
    id, text, hash, status, roleId, userId, workspace, origin, 1, 1)
}

test('v4：旧库重复活跃行迁移收敛 + 唯一索引拦截新重复；规则镜像行豁免', (t) => {
  const dir = tmp(t)
  const db = new DatabaseSync(join(dir, 'memory.db'))
  t.after(() => db.close())
  ensureSchema(db)
  // 模拟 v3 遗留脏库：先去掉唯一索引再插重复。
  db.exec('DROP INDEX IF EXISTS idx_nodes_active_hash')
  rawNode(db, { id: 'n1', text: '同文', hash: 'h1', userId: 'u' })
  rawNode(db, { id: 'n2', text: '同文', hash: 'h1', userId: 'u' })

  const deduped = dedupeActiveHashes(db)
  assert.equal(deduped, 1, '同身份同文只保留最早一行')
  const rows = db.prepare("SELECT id,status,superseded_by FROM nodes WHERE text_hash='h1' ORDER BY id").all()
  assert.equal(rows[0].status, 'active')
  assert.equal(rows[1].status, 'superseded')
  assert.equal(rows[1].superseded_by, rows[0].id, '被收敛行必须指向规范行，不物理删')

  const info = ensureSchema(db)
  assert.equal(info.uniqueIndex, true)
  assert.equal(info.deduped, 0, '已收敛后重跑不重复处理')
  assert.throws(() => rawNode(db, { id: 'n3', text: '同文', hash: 'h1', userId: 'u' }),
    /UNIQUE constraint failed/, '新重复必须被索引拦下')

  // 规则镜像（origin=rule:*）不是事实行：允许与用户事实同文共存，不参与唯一约束。
  rawNode(db, { id: 'r1', text: '同文', hash: 'h1', userId: 'u', origin: 'rule:iron-rule-1' })
  assert.equal(db.prepare("SELECT count(*) AS n FROM nodes WHERE status='active' AND text_hash='h1'").get().n, 2)
})

test('withTx：只把“已在事务内”当嵌套；其他 BEGIN 失败必须原样抛出', () => {
  const nested = {
    exec(sql) { if (sql === 'BEGIN IMMEDIATE') throw new Error('cannot start a transaction within a transaction') },
  }
  assert.equal(withTx(nested, () => 42), 42, '嵌套调用照常执行')

  const locked = {
    exec(sql) { if (sql === 'BEGIN IMMEDIATE') throw new Error('database is locked') },
  }
  assert.throws(() => withTx(locked, () => 1), /database is locked/, '锁冲突不能被吞成“无事务执行”')

  // 正常路径：提交/回滚语义不变。
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t(v)')
  withTx(db, () => db.prepare("INSERT INTO t VALUES('a')").run())
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 1)
  assert.throws(() => withTx(db, () => { throw new Error('boom') }), /boom/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 1, '抛错必须回滚')
  db.close()
})

test('审核：跨分区候选/目标一律拒绝；同分区仍可 accept', async (t) => {
  const dataDir = tmp(t, 'whale-r10-review-')
  const backend = new LocalBackend({ dataDir, useWorker: false, config: () => ({ write: { reviewMode: 'shadow' } }) })
  t.after(() => backend.dispose())
  const alice = { userId: 'alice', roleId: '', workspace: '' }
  const bob = { userId: 'bob', roleId: '', workspace: '' }

  const wrote = await backend.write({ text: 'Alice 的候选事实', identity: alice, source: 'self' })
  assert.equal(wrote.ok, true)
  const db = backend.withDb((d) => d)
  const row = db.prepare("SELECT id FROM writes WHERE action='CANDIDATE' AND user_id='alice' ORDER BY id DESC LIMIT 1").get()
  assert.ok(row?.id)

  const cross = backend.reviewWrite(row.id, 'accept', '', { identity: bob })
  assert.equal(cross.ok, false)
  assert.equal(cross.error, 'candidate_not_found', '跨分区 id 必须当不存在')

  const same = backend.reviewWrite(row.id, 'accept', '', { identity: alice })
  assert.equal(same.ok, true, JSON.stringify(same))

  // 目标已失效/跨分区：候选 payload 指向 Bob 的节点时 accept 必须拒绝。
  const bobNode = await backend.write({
    text: 'Bob 的既有事实', identity: bob, source: 'self', level: 'normal',
  })
  const bobId = bobNode.id || bobNode.candidate
  db.prepare(`INSERT INTO writes (ts,trace_id,action,reason,after_text,mode,payload,user_id,role_id,workspace)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    Date.now() / 1000, 'tr', 'CANDIDATE', '', 'Alice 想合并进 Bob', 'shadow',
    JSON.stringify({ shadowOf: 'MERGE', targetId: bobId }), 'alice', '', '')
  const crafted = db.prepare("SELECT id FROM writes WHERE after_text='Alice 想合并进 Bob'").get().id
  const crossed = backend.reviewWrite(crafted, 'accept', '', { identity: alice })
  assert.equal(crossed.ok, false)
  assert.ok(['target_not_active', 'duplicate_active'].includes(crossed.error), JSON.stringify(crossed))
})

test('enqueue：本进程没处理到的 job 也会被终态扫地机结算，不悬挂', async (t) => {
  const dataDir = tmp(t, 'whale-r10-enqueue-')
  const backend = new LocalBackend({ dataDir, useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }) })
  t.after(() => backend.dispose())
  const pending = backend.write({ text: '等待跨队列结算', identity: { userId: 'u', roleId: '', workspace: '' }, source: 'self' })
  const db = backend.withDb((d) => d)
  const job = db.prepare("SELECT id FROM jobs WHERE kind='write' ORDER BY id DESC LIMIT 1").get()
  assert.ok(job?.id)
  // 模拟另一个队列/进程把 job 处理完：扫地机必须结算本进程 waiter。
  db.prepare("UPDATE jobs SET state='done', payload=?, updated_at=? WHERE id=?").run(
    JSON.stringify({ result: { ok: true, action: 'ADD', id: 'n-x' } }), Date.now() / 1000, job.id)
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, action: 'TEST_TIMEOUT' }), 5000)),
  ])
  assert.equal(result.action, 'ADD', 'wait 必须由终态扫地机结算')
  assert.equal(result.id, 'n-x', '结算必须带回 job payload 里的 result 字段')
})

test('FTS 失败可见 + ready 真探测', (t) => {
  const dir = tmp(t)
  const db = openDb(dir)
  t.after(() => closeDb(db))
  rawNode(db, { id: 'n1', text: '检索内容', hash: 'h-fts' })
  const before = ftsStats.errors
  db.exec('DROP TABLE nodes_fts')
  const out = search(db, { query: '检索内容', identity: {} })
  assert.equal(out.hits.length, 0, 'FTS 缺失时 fail-open 空结果')
  assert.ok(ftsStats.errors > before, '失败必须计数（不再静默零命中）')

  // 用一个“父路径是普通文件”的目录：mkdir 必 ENOTDIR，能稳定测 ready=false（别用 /proc，recursive mkdir 会卡住内核）。
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const broken = new LocalBackend({ dataDir: join(blocker, 'memory'), useWorker: false })
  try {
    assert.equal(broken.ready, false, '打不开库时 ready 不得恒 true')
  } finally {
    broken.dispose()
  }
})

test('import：崩溃前 cursor 落库，恢复从断点续跑；状态接口不回传 jsonl', async (t) => {
  const dataDir = tmp(t, 'whale-r10-import-')
  const backend = new LocalBackend({ dataDir, useWorker: false })
  t.after(() => backend.dispose())
  const ident = { userId: 'u', roleId: '', workspace: '' }
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ text: `导入行 ${i}`, level: 'normal' }))
  const db = backend.withDb((d) => d)
  // 模拟“崩溃前已完成前两行”：先把它们真正落库，再以 cursor=2 恢复。
  const firstBatch = await backend.importJsonl({ jsonl: lines.slice(0, 2).join('\n'), identity: ident })
  assert.equal(firstBatch.ok, true)
  const payload = { jsonl: lines.join('\n'), identity: ident, cursor: 2, total: 5, added: 2, skipped: 0, errors: 0, kept: 2, split: 0, rejected: 0, reasons: {}, error_details: [] }
  const created = db.prepare("INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES ('import','queued',0,?,?,?)")
    .run(JSON.stringify(payload), Date.now() / 1000, Date.now() / 1000)
  const jobId = String(created.lastInsertRowid)

  const resumed = await backend.resumeImportJob(jobId)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  const job = await backend.importStatus(jobId)
  assert.equal(job.job.state, 'done')
  assert.equal(job.job.cursor, 5)
  assert.equal(job.job.jsonl, undefined, '状态接口不得把 4MB 正文回传')
  assert.equal(db.prepare("SELECT count(*) AS n FROM nodes WHERE status='active'").get().n, 5)
})

test('duplicate_key：跨根/proposals 同名进红项；purge 两份一起删', (t) => {
  const root = tmp(t, 'whale-r10-rules-')
  const made = writeRule(root, { front: frontOf({ key: 'rule-x', number: null }), text: '必须保留审计日志。' }, { git: false })
  assert.equal(made.ok, true)
  // 旧版 .md 候选与正式规则同名（升级遗留现场）。
  const proposals = join(root, 'proposals')
  mkdirSync(proposals, { recursive: true })
  const dupText = '必须保留审计日志。'
  void frontOf
  const doc = ['---', 'key: rule-x', 'type: rule-candidate', 'priority: P1', 'scope: global',
    'modality: must', 'action: x', 'object: y', 'conditions: []', 'exceptions: []', 'status: active',
    'created: 2026-11-23', 'updated: 2026-11-23', 'version: 1', 'origin: legacy', '---', '', dupText].join('\n')
  writeFileSync(join(proposals, 'rule-x.md'), doc)

  const listed = listRules(root)
  assert.ok(listed.errors.some((item) => item.error === 'duplicate_key'), JSON.stringify(listed.errors))
  assert.equal(listed.rules.filter((rule) => rule.front.key === 'rule-x').length, 1, '列表只保留根目录一份')

  const purged = purgeRule({ root, key: 'rule-x' }, { git: false })
  assert.equal(purged.ok, true, JSON.stringify(purged))
  assert.equal(existsSync(join(root, 'rule-x.md')), false)
  assert.equal(existsSync(join(proposals, 'rule-x.md')), false, '同名旧候选必须一并删除')
})

test('空规则列表也要跑镜像：孤儿规则行归档，不留幽灵', (t) => {
  const dir = tmp(t)
  const db = openDb(dir)
  t.after(() => closeDb(db))
  rawNode(db, { id: 'r1', text: '规则镜像', hash: 'h-rule', origin: 'rule:rule-x' })
  const backend = { withDb: (fn) => fn(db) }
  const out = mirrorRules({ backend, rules: [] })
  assert.equal(out.ok, true, JSON.stringify(out))
  const row = db.prepare("SELECT status,pinned FROM nodes WHERE id='r1'").get()
  assert.equal(row.status, 'archived', '文件没了，镜像行必须归档')
  assert.equal(Number(row.pinned), 0)
})

test('restoreDefaultRule：从包内默认恢复正文并清墓碑', async (t) => {
  const root = tmp(t, 'whale-r10-restore-')
  const first = await restoreDefaultRule({ root, key: 'iron-rule-1', git: false })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.ok(existsSync(join(root, 'iron-rule-1.md')))
  const purged = purgeRule({ root, key: 'iron-rule-1' }, { git: false })
  assert.equal(purged.ok, true, JSON.stringify(purged))
  assert.equal(existsSync(join(root, 'retired', 'iron-rule-1.json')) || existsSync(join(root, 'iron-rule-1.md')), true)
  const again = await restoreDefaultRule({ root, key: 'iron-rule-1', git: false })
  assert.equal(again.ok, true, JSON.stringify(again))
  const listed = listRules(root)
  assert.equal(listed.rules.filter((rule) => rule.front.key === 'iron-rule-1').length, 1)
})

test('lockState：活 pid + 超龄锁报 stale（可观测，不自动抢）', (t) => {
  const root = tmp(t, 'whale-r10-lock-')
  const lock = join(root, '.locks', 'repo.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, ts: Date.now() - 10 * 60_000, nonce: 'x' }))
  // 不传 staleMs 也必须能读（默认阈值来自 rule-lock，不能是未定义变量）。
  assert.equal(lockState(root).held, true)
  const state = lockState(root, { staleMs: 60_000 })
  assert.equal(state.held, true)
  assert.equal(state.stale, true)
  assert.equal(state.owner.pid, process.pid)
})

test('volatile Ref 保留：保存配置不改引用身份，只更新值', () => {
  const writeSymbol = Symbol.for('cosmokit.volatile.write')
  let value = true
  const ref = Object.freeze({ get: () => value, [writeSymbol]: (next) => { value = next } })
  assert.equal(isVolatileRef(ref), true)
  const config = { recall: { enabled: ref, maxHits: 5 } }
  mergePreservingVolatile(config.recall, { enabled: false, maxHits: 7 })
  assert.equal(config.recall.enabled, ref, 'Ref 引用身份必须保留')
  assert.equal(config.recall.enabled.get(), false)
  assert.equal(config.recall.maxHits, 7)
})

test('A1：quick_check 遇到忙锁不隔离健康库（防双库分叉）', async (t) => {
  const dir = tmp(t, 'whale-r10-busy-')
  const seed = openDb(dir)
  seed.exec('CREATE TABLE IF NOT EXISTS probe(v)')
  closeDb(seed)
  const holder = new DatabaseSync(join(dir, 'memory.db'))
  try {
    holder.exec('BEGIN EXCLUSIVE')
    assert.throws(() => { const d = openDb(dir); closeDb(d) }, /locked|busy/i)
  } finally {
    holder.exec('ROLLBACK')
    holder.close()
  }
  const leftovers = nodeFs.readdirSync(dir).filter((name) => name.startsWith('memory.corrupt-'))
  assert.deepEqual(leftovers, [], '忙锁不得把健康库改名隔离')
  const again = openDb(dir)
  t.after(() => closeDb(again))
  assert.equal(String(again.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '4')
})

test('A2：同名非唯一索引会被拆除并重建为唯一索引，health 依据 sqlite_master 实读', (t) => {
  const dir = tmp(t, 'whale-r10-index-')
  const db = openDb(dir)
  t.after(() => closeDb(db))
  db.exec('DROP INDEX IF EXISTS idx_nodes_active_hash')
  db.exec('CREATE INDEX idx_nodes_active_hash ON nodes(text_hash, user_id, role_id, workspace)')
  const info = ensureSchema(db)
  assert.equal(info.uniqueIndex, true)
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_nodes_active_hash'").get()
  assert.match(String(idx.sql), /UNIQUE\s+INDEX/i, '同名索引必须升级成 UNIQUE，而不是 silently no-op')
})

test('A3：expectedUpdatedAt 不一致拒绝，一致才落库', async (t) => {
  const dataDir = tmp(t, 'whale-r10-cas-')
  const backend = new LocalBackend({ dataDir, useWorker: false, config: () => ({ write: { reviewMode: 'auto' } }) })
  t.after(() => backend.dispose())
  const ident = { userId: 'cas', roleId: '', workspace: '' }
  const added = await backend.write({ text: 'CAS 目标事实', identity: ident, source: 'self' })
  assert.equal(added.ok, true)
  const db = backend.withDb((d) => d)
  const row = db.prepare('SELECT id, updated_at, status FROM nodes WHERE id=?').get(added.id)
  const stale = Number(row.updated_at) - 1
  const rejected = await backend.updateNode(row.id, { text: 'CAS 新事实' }, { identity: ident, expectedUpdatedAt: stale })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'node_changed')
  const ok = await backend.updateNode(row.id, { text: 'CAS 新事实' }, {
    identity: ident, expectedUpdatedAt: Number(row.updated_at),
  })
  assert.equal(ok.ok, true, JSON.stringify(ok))
})

test('A6/A7：导入失败批 cursor 回退；进度写小 meta，jobs.payload 不重写', async (t) => {
  const dataDir = tmp(t, 'whale-r10-import2-')
  const backend = new LocalBackend({ dataDir, useWorker: false })
  t.after(() => backend.dispose())
  const ident = { userId: 'imp', roleId: '', workspace: '' }
  // 打坏 FTS：触发器仍在但目标表缺失 → 首批 INSERT 必失败。
  backend.withDb((d) => d).exec('DROP TABLE nodes_fts')
  const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({ text: `失败导入 ${i}`, level: 'normal' }))
  const started = await backend.startImport({ jsonl: lines.join('\n'), identity: ident })
  const db = backend.withDb((d) => d)
  const payloadBefore = db.prepare('SELECT payload FROM jobs WHERE id=?').get(Number(started.jobId)).payload
  let status = null
  for (let i = 0; i < 40; i += 1) {
    status = await backend.importStatus(started.jobId)
    if (status.job.state === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(status.job.state, 'failed')
  assert.equal(status.job.cursor, 0, '失败批 cursor 必须回退到批首，重试不能跳批')
  const payloadAfter = db.prepare('SELECT payload FROM jobs WHERE id=?').get(Number(started.jobId)).payload
  assert.equal(String(payloadAfter), String(payloadBefore), 'jobs.payload 只能在入队时写一次')
  assert.ok(String(payloadBefore).includes('失败导入 0'))
})

test('A4：新错误码的状态/文案由单一真源给出（409 + err.*）', () => {
  for (const code of ['node_changed', 'duplicate_active', 'target_not_active']) {
    assert.equal(statusOf(code), 409, `${code} 必须是 409`)
    assert.equal(localeKeyOf(code), `err.${code}`, `${code} 必须有文案键`)
  }
})
