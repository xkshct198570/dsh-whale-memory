/**
 * legacy 导入编号口径（R8-01）：不得回落成 17；没有可靠编号走分配器并查墓碑；导入幂等。
 *
 * 只碰临时目录 + 内存 sqlite；不访问真实库、不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { LEGACY_IRON_RULE_ID, importLegacyRule } from '../../src/core/rule-mirror.js'
import { listRules, purgeRule, readTombstones, writeRule } from '../../src/core/rule-store.js'

const NODE_ID = LEGACY_IRON_RULE_ID
const TEXT = '必须先在临时目录验证再覆盖正式库；例外：只读查询不适用。'

/** 临时规则根 + 只有 nodes 表的库。 */
function fresh(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-import-'))
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, text TEXT, text_hash TEXT, text_bigrams TEXT,
    level TEXT, memory_type TEXT, source TEXT, status TEXT, role_id TEXT, user_id TEXT, workspace TEXT,
    tags TEXT, context_note TEXT, weight REAL, hits INTEGER, pinned INTEGER, origin TEXT, trace_id TEXT,
    created_at INTEGER, updated_at INTEGER)`)
  t.after(() => { rmSync(root, { recursive: true, force: true }); db.close() })
  return { root, db, backend: { withDb: (fn) => fn(db) } }
}

function addLegacyNode(db, { id = NODE_ID, text = TEXT, tags = '["iron-rule"]', origin = id } = {}) {
  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
    role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'core','procedural','owner','active','','','',?,?,1.0,0,1,?,'legacy',?,?)`)
    .run(id, text, 'h', '[]', tags, '旧铁律', origin, now, now)
}

test('空仓导入：不回落 17，按分配器取 1（key=iron-rule-1）', (t) => {
  const { root, db, backend } = fresh(t)
  addLegacyNode(db)
  const got = importLegacyRule({ backend, root })
  assert.equal(got.ok, true, got.error)
  assert.equal(got.number, 1, '没有可靠编号必须走分配器，不得回落成 17')
  assert.equal(got.key, 'iron-rule-1')
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.md') && name !== 'README.md'), ['iron-rule-1.md'])
})

test('幂等：同一旧节点连跑两次只留一份文件，第二次 skipped', (t) => {
  const { root, db, backend } = fresh(t)
  addLegacyNode(db)
  const first = importLegacyRule({ backend, root })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.skipped, false)
  const second = importLegacyRule({ backend, root })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.skipped, true, '同一 legacy 节点不得重复生成规则')
  assert.equal(second.path, first.path)
  assert.equal(second.number, first.number)
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.md') && name !== 'README.md'), ['iron-rule-1.md'])
  assert.equal(listRules(root).rules.length, 1)
})

test('查墓碑：1 已彻底删除 → 导入取 2，不复用作废编号', (t) => {
  const { root, db, backend } = fresh(t)
  const front = {
    key: 'iron-rule-1', type: 'iron-rule', number: 1, priority: 'P0', scope: 'global', role: '',
    modality: 'must', action: '', object: '', conditions: [], exceptions: [], status: 'active',
    merged_into: '', superseded_by: '', created: '2026-11-23', updated: '2026-11-23', version: 1, origin: 'unit',
  }
  assert.equal(writeRule(root, { front, text: '必须保留审计日志。' }, { git: false }).ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-1' }, { git: false }).ok, true)
  assert.deepEqual(readTombstones(root).map((item) => item.number), [1])
  addLegacyNode(db)
  const got = importLegacyRule({ backend, root })
  assert.equal(got.ok, true, got.error)
  assert.equal(got.number, 2)
  assert.equal(got.key, 'iron-rule-2')
})

test('墓碑编号被显式指定 → number_retired，绝不复活', (t) => {
  const { root, db, backend } = fresh(t)
  const front = {
    key: 'iron-rule-5', type: 'iron-rule', number: 5, priority: 'P0', scope: 'global', role: '',
    modality: 'must', action: '', object: '', conditions: [], exceptions: [], status: 'active',
    merged_into: '', superseded_by: '', created: '2026-11-23', updated: '2026-11-23', version: 1, origin: 'unit',
  }
  assert.equal(writeRule(root, { front, text: '必须保留审计日志。' }, { git: false }).ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-5' }, { git: false }).ok, true)
  addLegacyNode(db)
  const got = importLegacyRule({ backend, root, number: 5 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'number_retired')
  assert.equal(listRules(root).rules.length, 0, '被拒的导入不得写文件')
})

test('显式 key + 正文无 hint：key 保留、编号走分配器（不猜 17）', (t) => {
  const { root, db, backend } = fresh(t)
  addLegacyNode(db)
  const got = importLegacyRule({ backend, root, key: 'iron-rule-custom' })
  assert.equal(got.ok, true, got.error)
  assert.equal(got.key, 'iron-rule-custom')
  assert.equal(got.number, 1)
  assert.equal(listRules(root).rules[0].front.key, 'iron-rule-custom')
})

test('无 hint 分支也查墓碑 key：显式 key 已 purge → number_retired', (t) => {
  const { root, db, backend } = fresh(t)
  const front = {
    key: 'iron-rule-3', type: 'iron-rule', number: 3, priority: 'P0', scope: 'global', role: '',
    modality: 'must', action: '', object: '', conditions: [], exceptions: [], status: 'active',
    merged_into: '', superseded_by: '', created: '2026-11-23', updated: '2026-11-23', version: 1, origin: 'unit',
  }
  assert.equal(writeRule(root, { front, text: '必须保留审计日志。' }, { git: false }).ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-3' }, { git: false }).ok, true)
  addLegacyNode(db, { text: '必须保留审计日志，不得复活作废规则。' })
  const got = importLegacyRule({ backend, root, key: 'iron-rule-3' })
  assert.equal(got.ok, false, '已作废的 key 不得被迁移复活')
  assert.equal(got.error, 'number_retired')
  assert.equal(listRules(root).rules.length, 0)
})
