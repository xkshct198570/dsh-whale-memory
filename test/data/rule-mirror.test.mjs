/**
 * 规则镜像数据层测试（R3a）：文件→nodes 行、孤儿归档、幂等、状态比对、旧铁律导入。
 * 每个用例临时库 + 临时规则目录；不碰真实 dataDir/网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, openDb } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { listRules, writeRule, writeTombstone } from '../../src/core/rule-store.js'
import {
  LEGACY_IRON_RULE_ID,
  importLegacyRule,
  mirrorRules,
  mirrorStatus,
} from '../../src/core/rule-mirror.js'

function fresh(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-mirror-rules-'))
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-mirror-db-')))
  t.after(() => {
    closeDb(db)
    nodeFs.rmSync(root, { recursive: true, force: true })
  })
  return { root, db, backend: { withDb: (fn) => fn(db) } }
}

function frontOf(overrides = {}) {
  return {
    key: 'rule-1',
    type: 'rule',
    number: 1,
    priority: 'P1',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '',
    object: '',
    conditions: [],
    exceptions: [],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

function addRule(root, index, overrides = {}) {
  const saved = writeRule(root, {
    front: frontOf({
      key: `rule-${index}`,
      number: index,
      priority: overrides.priority || (index === 1 ? 'P0' : 'P1'),
      ...overrides,
    }),
    text: `必须执行第 ${index} 项检查。`,
  }, { git: false })
  assert.equal(saved.ok, true, JSON.stringify(saved.detail))
  return saved
}

function addManualNode(db) {
  const text = '人工记录：周五复盘会改到下午。'
  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
    role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'important','semantic','owner','active','','','',?,?,1.0,0,0,?,'manual',?,?)`)
    .run('n1_manual', text, contentHash(text), bigrams(text), '[]', '人工事实', 'manual:one', now, now)
  return text
}

test('3 个规则文件 → 3 行 origin rule:*；字段/tags/pinned/level/weight 正确', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1, { type: 'iron-rule' })
  addRule(root, 2)
  addRule(root, 3, { priority: 'P2' })
  const docs = listRules(root).rules
  const result = mirrorRules({ backend, rules: docs })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.created, 3)
  assert.equal(result.mirrored, 3)

  const rows = db.prepare("SELECT * FROM nodes WHERE origin LIKE 'rule:%' ORDER BY origin").all()
  assert.equal(rows.length, 3)

  const iron = rows.find((row) => row.origin === 'rule:rule-1')
  assert.equal(iron.level, 'core')
  assert.equal(iron.memory_type, 'procedural')
  assert.equal(iron.source, 'owner')
  assert.equal(iron.status, 'active')
  assert.equal(iron.pinned, 1)
  assert.equal(iron.weight, 1.0)

  const p2 = rows.find((row) => row.origin === 'rule:rule-3')
  assert.equal(p2.level, 'important')
  assert.equal(p2.weight, 0.6, 'P2 权重 0.6')
  const tags = JSON.parse(p2.tags)
  assert.deepEqual(tags, [
    'rule', 'rule-key:rule-3', 'rule-type:rule',
    'rule-scope:global', 'rule-priority:P2',
  ], '普通规则无 number：不得出现 rule-no:null')
  assert.match(p2.context_note, /global/)
  assert.match(p2.context_note, /updated:2026-11-22/)
  assert.ok(p2.context_note.length <= 200)
  assert.equal(p2.text, '必须执行第 3 项检查。')
  assert.equal(p2.text_hash, contentHash(p2.text))
})

test('重复 mirror 幂等；不覆盖/不删除非 rule 节点', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1)
  addRule(root, 2)
  const manualText = addManualNode(db)
  const docs = listRules(root).rules

  assert.equal(mirrorRules({ backend, rules: docs }).ok, true)
  const before = db.prepare('SELECT id, origin, updated_at FROM nodes ORDER BY id').all()
  const again = mirrorRules({ backend, rules: root }) // 也接受根目录
  assert.equal(again.ok, true, again.error)
  assert.equal(again.created, 0)
  assert.equal(again.updated, 2)
  const after = db.prepare('SELECT id, origin, updated_at FROM nodes ORDER BY id').all()
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), '不得新增行')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 2)

  const manual = db.prepare("SELECT * FROM nodes WHERE origin='manual:one'").get()
  assert.equal(manual.text, manualText)
  assert.equal(manual.status, 'active')
  assert.equal(manual.level, 'important')
})

test('文件删除 → 孤儿行 status=archived、pinned=0，不物理删', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1)
  addRule(root, 2)
  addRule(root, 3)
  assert.equal(mirrorRules({ backend, rules: listRules(root).rules }).ok, true)

  unlinkSync(join(root, 'rule-2.md'))
  const result = mirrorRules({ backend, rules: listRules(root).rules })
  assert.equal(result.ok, true)
  assert.equal(result.orphaned, 1)

  const orphan = db.prepare("SELECT * FROM nodes WHERE origin='rule:rule-2'").get()
  assert.ok(orphan, '孤儿行必须保留')
  assert.equal(orphan.status, 'archived')
  assert.equal(orphan.pinned, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 3)

  const status = mirrorStatus({ backend, rules: listRules(root).rules })
  assert.equal(status.ok, true)
  assert.equal(status.mirrored, 2)
  assert.equal(status.missing, 0)
  assert.equal(status.stale, 0)
  assert.equal(status.orphaned, 1)
  assert.equal(status.totalFiles, 2)
  assert.equal(status.totalRows, 3)
})

test('mirrorStatus：手工改文件正文 → stale；重建镜像后回 0', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1)
  assert.equal(mirrorRules({ backend, rules: listRules(root).rules }).ok, true)

  const file = join(root, 'rule-1.md')
  const original = nodeFs.readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('必须执行第 1 项检查。', '必须执行第 1 项检查并留存日志。'), 'utf8')
  const stale = mirrorStatus({ backend, rules: listRules(root).rules })
  assert.equal(stale.stale, 1)
  assert.equal(stale.mirrored, 0)

  assert.equal(mirrorRules({ backend, rules: listRules(root).rules }).ok, true)
  const fixed = mirrorStatus({ backend, rules: listRules(root).rules })
  assert.equal(fixed.stale, 0)
  assert.equal(fixed.mirrored, 1)
})

test('backend 无 withDb → 明确 backend_unavailable，不抛', () => {
  const a = mirrorRules({ backend: {}, rules: [] })
  const b = mirrorStatus({ backend: {}, rules: [] })
  assert.equal(a.ok, false)
  assert.equal(a.error, 'backend_unavailable')
  assert.equal(b.ok, false)
  assert.equal(b.error, 'backend_unavailable')
})

test('legacy 导入：空仓按分配器取 1（不再回落 17），例外拆出；再跑幂等跳过', (t) => {
  const { root, db, backend } = fresh(t)
  const text = '必须先在临时目录验证再覆盖正式库；例外：只读查询不适用。'
  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
    role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'core','procedural','owner','active','','','',?,?,1.0,0,1,?,'legacy-import',?,?)`)
    .run(LEGACY_IRON_RULE_ID, text, contentHash(text), bigrams(text), '["iron-rule"]', '旧铁律', LEGACY_IRON_RULE_ID, now, now)

  const first = importLegacyRule({ backend, root })
  assert.equal(first.ok, true, first.error)
  // R8-01/R8-14 契约变更：没有「回落 17」——空仓从分配器取第一个可用号 1。
  assert.equal(first.key, 'iron-rule-1')
  assert.equal(first.number, 1)
  assert.equal(first.legacy, true)
  assert.equal(first.skipped, false)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-1.md')), true)

  const parsed = listRules(root).rules.find((doc) => doc.front.key === 'iron-rule-1')
  assert.ok(parsed)
  assert.equal(parsed.front.type, 'iron-rule')
  assert.deepEqual(parsed.front.exceptions, ['只读查询不适用'])
  assert.equal(parsed.front.origin, `legacy:${LEGACY_IRON_RULE_ID}`)
  assert.equal(parsed.text, '必须先在临时目录验证再覆盖正式库。')

  const second = importLegacyRule({ backend, root })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.path, first.path)
  assert.equal(listRules(root).rules.length, 1, '幂等不得重复生成文件')
})

test('legacy 导入：墓碑占号不复用（1 已 purge → 新导入取 2）', (t) => {
  const { root, db, backend } = fresh(t)
  const tomb = writeTombstone(root, { key: 'iron-rule-1', number: 1, at: Date.now(), reason: 'unit' })
  assert.equal(tomb.ok, true, tomb.error)
  const text = '必须先核对绝对路径再删除。'
  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
    role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'core','procedural','owner','active','','','',?,?,1.0,0,1,?,'legacy-import',?,?)`)
    .run(LEGACY_IRON_RULE_ID, text, contentHash(text), bigrams(text), '["iron-rule"]', '旧铁律', LEGACY_IRON_RULE_ID, now, now)
  const got = importLegacyRule({ backend, root })
  assert.equal(got.ok, true, got.error)
  assert.equal(got.number, 2, '墓碑号 1 永不复用')
  assert.equal(got.key, 'iron-rule-2')
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-1.md')), false)
})

test('legacy 导入：越界 key 直接 invalid_key，不落任何文件', (t) => {
  const { root, backend } = fresh(t)
  const result = importLegacyRule({ backend, root, key: '../evil' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid_key')
  assert.equal(nodeFs.existsSync(join(root, '..', 'evil.md')), false)
})

test('legacy 导入：节点不存在 → legacy_not_found', (t) => {
  const { root, backend } = fresh(t)
  const result = importLegacyRule({ backend, root })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'legacy_not_found')
})

// ---------------------------------------------------------------------------
// R8-08：候选不镜像 / scope 列 / front 漂移
// ---------------------------------------------------------------------------

test('候选不镜像；已有候选行按孤儿归档；mirrorStatus 不把候选记为 missing', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1)
  const docs = [
    ...listRules(root).rules,
    {
      front: frontOf({ key: 'rule-cand', type: 'rule-candidate', number: null, status: 'proposal' }),
      text: '候选正文，尚未裁定。',
    },
  ]
  const result = mirrorRules({ backend, rules: docs })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.created, 1)
  assert.equal(result.mirrored, 1)
  assert.equal(result.candidatesSkipped, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin='rule:rule-cand'").get().n, 0)

  const status = mirrorStatus({ backend, rules: docs })
  assert.equal(status.ok, true)
  assert.equal(status.missing, 0, '候选不该被算成缺失镜像')
  assert.equal(status.mirrored, 1)
  assert.equal(status.totalFiles, 1)
})

test('镜像 role_id/workspace 按 front.scope 落值（global 留空）', (t) => {
  const { root, db, backend } = fresh(t)
  const docs = [
    { front: frontOf({ key: 'rule-ws', scope: 'workspace:/tmp/ws/' }), text: '必须先读工作区说明。' },
    { front: frontOf({ key: 'rule-role', scope: 'role:reviewer' }), text: '必须只审不施工。' },
    { front: frontOf({ key: 'rule-global', scope: 'global' }), text: '必须全局可见。' },
  ]
  const result = mirrorRules({ backend, rules: docs })
  assert.equal(result.ok, true, result.error)
  const ws = db.prepare("SELECT * FROM nodes WHERE origin='rule:rule-ws'").get()
  assert.equal(ws.workspace, '/tmp/ws', 'workspace 作用域落 workspace 列（去尾斜杠）')
  assert.equal(ws.role_id, '')
  const role = db.prepare("SELECT * FROM nodes WHERE origin='rule:rule-role'").get()
  assert.equal(role.role_id, 'reviewer')
  assert.equal(role.workspace, '')
  const global = db.prepare("SELECT * FROM nodes WHERE origin='rule:rule-global'").get()
  assert.equal(global.role_id, '')
  assert.equal(global.workspace, '', 'global 必须留空')
  assert.equal(mirrorStatus({ backend, rules: docs }).mirrored, 3, 'scope 列一致 → 不算漂移')
})

test('mirrorStatus：只改 front.scope/priority/status（正文不变）→ stale，重建后回 0', (t) => {
  const { root, db, backend } = fresh(t)
  addRule(root, 1, { priority: 'P1' })
  assert.equal(mirrorRules({ backend, rules: listRules(root).rules }).ok, true)

  const file = join(root, 'rule-1.md')
  const original = nodeFs.readFileSync(file, 'utf8')

  const cases = [
    ['scope', /^scope: global$/m, 'scope: workspace:/tmp/ws'],
    ['priority', /^priority: P1$/m, 'priority: P2'],
    ['status', /^status: active$/m, 'status: retired'],
  ]
  for (const [label, pattern, replacement] of cases) {
    nodeFs.writeFileSync(file, original.replace(pattern, replacement), 'utf8')
    const drifted = mirrorStatus({ backend, rules: listRules(root).rules })
    assert.equal(drifted.stale, 1, `只改 ${label} 也必须判 stale`)
    assert.equal(drifted.mirrored, 0)
  }

  nodeFs.writeFileSync(file, original.replace(/^scope: global$/m, 'scope: workspace:/tmp/ws'), 'utf8')
  assert.equal(mirrorRules({ backend, rules: listRules(root).rules }).ok, true)
  const fixed = mirrorStatus({ backend, rules: listRules(root).rules })
  assert.equal(fixed.stale, 0)
  assert.equal(fixed.mirrored, 1)
  const row = db.prepare("SELECT tags, workspace FROM nodes WHERE origin='rule:rule-1'").get()
  assert.match(row.tags, /rule-scope:workspace:\/tmp\/ws/)
  assert.equal(row.workspace, '/tmp/ws')
})
