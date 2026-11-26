/**
 * 历史收尾候选迁移脚本：dry-run 零副作用、apply 备份 + 重放、两遍幂等、MIGRATED 语义。
 * 只碰临时库；不读真实 ~/.dsh。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../../src/core/db.js'
import { run, parseArgs } from '../../scripts/migrate-wrap-candidates.mjs'

function seedDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-migrate-'))
  const db = openDb(dir)
  const insert = (action, text, payload, reason = 'shadow:ADD', identity = { userId: 'u1', roleId: '', workspace: 'web' }) => {
    const ts = now()
    db.prepare(`INSERT INTO writes
      (ts,trace_id,action,node_id,reason,before_text,after_text,mode,payload,user_id,role_id,workspace)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ts, 'wrap:9', action, null, reason, null, text, 'shadow', JSON.stringify(payload),
      identity.userId, identity.roleId, identity.workspace,
    )
  }
  // durable → 应自动入库
  insert('CANDIDATE', '动库前必须先备份并校验备份可恢复', { origin: 'session-wrap', shadowOf: 'ADD', source: 'self' })
  // 真实旧 payload 一律 source='owner'（0.7.3 硬编码）：迁移必须归一到 self，否则落保护面。
  insert('CANDIDATE', '发布前必须跑全量门禁并检查退出码', { origin: 'session-wrap', shadowOf: 'ADD', source: 'owner' })
  // stale → 应 REJECT
  insert('CANDIDATE', '0.7.3 live 重启后六页签验证通过', { origin: 'session-wrap', shadowOf: 'ADD', source: 'self' })
  // 歧义 → 仍是审核候选（且第二遍不得重复处理）
  insert('CANDIDATE', '刚才那个方案可能有问题', { origin: 'session-wrap', shadowOf: 'ADD', source: 'self' })
  // ARCHIVE 审核项 → 跳过不重放
  insert('CANDIDATE', '', { origin: 'session-wrap', shadowOf: 'ARCHIVE', source: 'self' }, 'reconcile_archive:x')
  // 无身份 → 跳过
  insert('CANDIDATE', '动库前必须先备份', { origin: 'session-wrap', shadowOf: 'ADD' }, 'shadow:ADD', { userId: '', roleId: '', workspace: '' })
  // 历史手工处置的 REJECT → 归一 MIGRATED
  insert('REJECT', '旧版本候选已手工入库', { origin: 'session-wrap', shadowOf: 'ADD' }, 'auto_ingested:ADD:n-old')
  const path = join(dir, 'memory.db')
  closeDb(db)
  return { dir, path }
}

const rowsOf = (path) => {
  const db = openDb(join(path, '..'))
  try { return db.prepare('SELECT id,trace_id,action,node_id,reason FROM writes ORDER BY id').all() } finally { closeDb(db) }
}
const nodesOf = (path) => {
  const db = openDb(join(path, '..'))
  try { return db.prepare('SELECT id,text,source,status FROM nodes ORDER BY created_at').all() } finally { closeDb(db) }
}

test('parseArgs：默认 dry-run，--apply 显式开启，未知参数报错', () => {
  assert.equal(parseArgs([]).apply, false)
  assert.equal(parseArgs(['--apply']).apply, true)
  assert.equal(parseArgs(['--db', '/tmp/x.db']).db, '/tmp/x.db')
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('dry-run：只读、零副作用；apply：备份+重放+MIGRATED；第二遍幂等', (t) => {
  const { dir, path } = seedDb(t)
  const before = rowsOf(path)

  const dry = run({ db: path, apply: false })
  assert.equal(dry.candidates, 6, '全部 CANDIDATE 都进计划（ARCHIVE/无身份在计划阶段显式跳过）')
  assert.equal(dry.skipped, 2, 'ARCHIVE 与无身份必须可见地跳过')
  assert.equal(dry.migrated, 0)
  assert.equal(dry.backup, '')
  assert.deepEqual(rowsOf(path), before, 'dry-run 不得写库')

  const applied = run({ db: path, apply: true })
  assert.ok(applied.backup && existsSync(applied.backup), 'apply 必须先备份')
  assert.ok(statSync(applied.backup).size > 0)
  assert.equal(applied.migrated, 4, 'durable×2/stale/歧义四条被重放')
  assert.equal(applied.skipped, 2)
  assert.equal(applied.rejected, 1, 'stale 落 REJECT 且原行 MIGRATED')
  assert.equal(applied.review, 1, '歧义仍产审核候选')
  assert.equal(applied.normalized, 1, '历史 auto_ingested REJECT 归一 MIGRATED')

  const after = rowsOf(path)
  const migrated = after.filter((row) => row.action === 'MIGRATED')
  assert.equal(migrated.length, 5, '四条候选原行 + 1 条历史 auto_ingested REJECT 归一 MIGRATED')
  const rejects = after.filter((row) => row.action === 'REJECT')
  assert.ok(rejects.every((row) => String(row.trace_id || '').startsWith('migrate:')), '只允许迁移重放产生的 REJECT 审计行')
  assert.ok(migrated.some((row) => String(row.reason).startsWith('migrated:ADD:') && row.node_id))
  assert.ok(migrated.some((row) => row.reason === 'migrated:REJECT:-'))
  assert.ok(migrated.some((row) => row.reason === 'migrated:CANDIDATE:-'))
  assert.ok(after.some((row) => row.action === 'CANDIDATE' && String(row.trace_id ?? '').startsWith('migrate:')),
    '歧义候选由迁移重建，并带 migrate: 前缀供幂等排除')

  const landed = nodesOf(path).filter((row) => row.status === 'active')
  assert.equal(landed.length, 2, '两条 durable 各落 1 条 active')
  assert.ok(landed.every((row) => row.source === 'self'), '迁移落库一律 source=self（旧 owner payload 必须归一）')

  const second = run({ db: path, apply: true })
  assert.equal(second.candidates, 2, '第二遍只剩 ARCHIVE/无身份两条（仍可见地跳过）')
  assert.equal(second.skipped, 2)
  assert.equal(second.migrated, 0)
  assert.equal(second.normalized, 0)
  assert.deepEqual(rowsOf(path), after, '第二遍计数不变、行不变')
  void dir
})
