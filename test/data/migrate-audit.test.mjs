/**
 * scripts/migrate-audit.mjs 回归（迁移审计 + 边迁移）。
 *
 * 全部用 mkdtemp 造迷你库，不碰真实网关库/插件库：
 * - Python 兼容库：memory_nodes / memory_edges / memory_fts / memory_fts_bi / memory_meta；
 * - 插件库：ensureSchema 建全量 schema，按 text_hash（sha256(normalize)）导入节点；
 * - dry-run 只读、不写边、不备份；apply 写 similar/manual 边、生成备份、二次 apply 幂等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { ensureSchema } from '../../src/core/schema.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { EDGE_ETYPE, EDGE_SOURCE, MAX_BACKUPS, parseArgs, runAudit } from '../../scripts/migrate-audit.mjs'

const SCRIPT = new URL('../../scripts/migrate-audit.mjs', import.meta.url).pathname
const sha1raw = (text) => createHash('sha1').update(String(text), 'utf8').digest('hex')

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `whale-audit-${label}-`))
}

function createPythonDb(dir) {
  const path = join(dir, 'whale.db')
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE memory_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE memory_nodes (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      text_bigrams TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      tags_flat TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'normal',
      memory_type TEXT NOT NULL DEFAULT 'semantic',
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'chat',
      weight REAL NOT NULL DEFAULT 1,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      text_hash TEXT NOT NULL
    );
    CREATE TABLE memory_edges (
      role_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      weight REAL NOT NULL,
      etype TEXT NOT NULL DEFAULT 'similar',
      source TEXT NOT NULL DEFAULT 'bigram',
      conf REAL NOT NULL DEFAULT 0.5,
      PRIMARY KEY(role_id, user_id, a, b)
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      text, tags_flat, content='memory_nodes', content_rowid='rowid', tokenize='trigram'
    );
    CREATE VIRTUAL TABLE memory_fts_bi USING fts5(
      text_bigrams, content='memory_nodes', content_rowid='rowid', tokenize='unicode61'
    );
  `)
  db.prepare("INSERT INTO memory_meta (k, v) VALUES ('schema_version', '4')").run()

  const nodes = [
    { id: 'p1', role_id: 'aluna', user_id: 'u1', text: '群主转让 冻结期 规则：群主转让有冻结期。', status: 'active' },
    { id: 'p2', role_id: 'aluna', user_id: 'u1', text: '灾备 备份包 上传 流程（旧归档）', status: 'archived' },
    { id: 'p3', role_id: 'aluna', user_id: 'u1', text: '未导入节点：火星殖民计划预算', status: 'active' },
    { id: 'p4', role_id: 'aluna', user_id: 'u1', text: '熔断 Phase2 待批 状态', status: 'active' },
    { id: 'p5', role_id: 'aluna', user_id: 'u1', text: '审计 TTL 清理 规则', status: 'active' },
    { id: 'p6', role_id: 'aluna', user_id: 'u2', text: '表情包 图库 收集', status: 'active' },
  ]
  const ts = 1_700_000_000
  const insertNode = db.prepare(`
    INSERT INTO memory_nodes (id, role_id, user_id, text, text_bigrams, tags_flat, status, created_at, updated_at, text_hash)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
  `)
  for (const node of nodes) {
    insertNode.run(node.id, node.role_id, node.user_id, node.text, bigrams(node.text), node.status, ts, ts, sha1raw(node.text))
  }
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')")
  db.exec("INSERT INTO memory_fts_bi(memory_fts_bi) VALUES('rebuild')")

  const insertEdge = db.prepare(`
    INSERT INTO memory_edges (role_id, user_id, a, b, weight, etype, source) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const edges = [
    ['aluna', 'u1', 'p1', 'p4', 0.8, 'topic', 'tag'],      // 已存在同向 similar（插件侧预置）→ skippedExisting
    ['aluna', 'u1', 'p2', 'p4', 1.2, 'similar', 'tag'],    // 新增，conf clamp 到 1
    ['aluna', 'u1', 'p3', 'p4', 0.7, 'topic', 'tag'],      // p3 未导入 → skippedUnmappedEndpoint
    ['aluna', 'u1', 'p4', 'p2', 0.9, 'mutex', 'tag'],      // supersede/mutex 不迁
    ['aluna', 'u1', 'p1', 'p2', 0.9, 'supersede', 'decision'],
    ['aluna', 'u1', 'p4', 'p4', 0.6, 'topic', 'tag'],      // 自环 → skippedSelfLoop
    ['aluna', 'u1', 'p6', 'p4', 0.5, 'topic', 'tag'],      // p6 在插件是 u2 → 跨分区
    ['aluna', 'u1', 'p2', 'p1', 0.5, 'topic', 'tag'],      // 新增
    ['aluna', 'u1', 'p5', 'p1', 0.4, 'topic', 'tag'],      // 新增（p5 是直接 hash 命中）
  ]
  for (const edge of edges) insertEdge.run(...edge)
  db.close()
  return path
}

function createPluginDb(dir) {
  const path = join(dir, 'memory.db')
  const db = new DatabaseSync(path)
  ensureSchema(db)
  const insert = db.prepare(`
    INSERT INTO nodes (id, text, text_hash, text_bigrams, source, status, role_id, user_id, workspace, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'import', ?, ?, ?, 'web', ?, ?)
  `)
  const ts = 1_700_000_100
  const nodes = [
    { id: 'p1', role_id: 'aluna', user_id: 'u1', text: '群主转让 冻结期 规则：群主转让有冻结期。', status: 'active' },
    { id: 'p2', role_id: 'aluna', user_id: 'u1', text: '灾备 备份包 上传 流程（旧归档）', status: 'archived' },
    { id: 'p4', role_id: 'aluna', user_id: 'u1', text: '熔断 Phase2 待批 状态', status: 'active' },
    { id: 'p5', role_id: 'aluna', user_id: 'u1', text: '审计 TTL 清理 规则', status: 'active' },
    { id: 'p6', role_id: 'aluna', user_id: 'u2', text: '表情包 图库 收集', status: 'active' },
    { id: 'px', role_id: 'aluna', user_id: 'u1', text: '插件自建：交响乐谱排版', status: 'active' },
  ]
  for (const node of nodes) {
    // p5 保留 Python 的 sha1(raw) 哈希，覆盖「直接等值」分支；其余用插件 sha256(normalize)。
    const hash = node.id === 'p5' ? sha1raw(node.text) : contentHash(node.text)
    insert.run(node.id, node.text, hash, bigrams(node.text), node.status, node.role_id, node.user_id, ts, ts)
  }
  db.prepare("INSERT INTO edges (from_id, to_id, etype, source, conf, weight, created_at) VALUES ('p1', 'p4', ?, 'tag', 0.6, 0.6, ?)")
    .run(EDGE_ETYPE, ts)
  db.close()
  return path
}

function fixtureDirs(label) {
  const root = tempDir(label)
  const pyPath = createPythonDb(root)
  const pluginPath = createPluginDb(root)
  return { root, pyPath, pluginPath, report: join(root, 'report.md'), backupDir: join(root, 'backups') }
}

function auditOpts(dirs, overrides = {}) {
  return {
    ...parseArgs([]),
    pythonDb: dirs.pyPath,
    pluginDb: dirs.pluginPath,
    report: dirs.report,
    backupDir: dirs.backupDir,
    topN: 5,
    ...overrides,
  }
}

function edgeRows(pluginPath) {
  const db = new DatabaseSync(pluginPath, { readOnly: true })
  try {
    return db.prepare('SELECT from_id, to_id, etype, source, conf, weight FROM edges ORDER BY from_id, to_id').all()
  } finally {
    db.close()
  }
}

test('参数：默认 dry-run；--apply-edges 必须配 --apply；未知参数报错', () => {
  const opts = parseArgs([])
  assert.equal(opts.apply, false)
  assert.equal(opts.applyEdges, false)
  assert.equal(opts.backup, true)
  assert.match(opts.pythonDb, /whale\.db$/)
  assert.match(opts.pluginDb, /whale-memory\/memory\.db$/)
  assert.throws(() => parseArgs(['--apply-edges']), /--apply/)
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /不能同时/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--topn=0']), /1\.\.50/)
  assert.equal(parseArgs(['--no-backup']).backup, false)
})

test('dry-run：计数/映射/FTS/双读齐全，且不写边、不备份', async () => {
  const dirs = fixtureDirs('dry')
  try {
    const { report, markdown } = await runAudit(auditOpts(dirs))
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.python.schemaVersion, '4')
    assert.equal(report.plugin.schemaVersion, '3')
    assert.equal(report.python.nodes.total, 6)
    assert.equal(report.python.nodes.active, 5)
    assert.equal(report.python.nodes.archived, 1)
    assert.equal(report.plugin.nodes.total, 6)
    assert.equal(report.python.fts.aligned, true)
    assert.equal(report.plugin.fts.aligned, true)
    assert.equal(report.python.edges.total, 9)
    assert.equal(report.plugin.edges.total, 1)

    // 1 条直接 hash（p5）+ 4 条插件口径重算 = 5/6；p3 未导入。
    assert.equal(report.mapping.directHashMatches, 1)
    assert.equal(report.mapping.computedHashMatches, 4)
    assert.equal(report.mapping.hashMapped, 5)
    assert.equal(report.mapping.unmapped, 1)
    assert.equal(report.mapping.hashSuccessRate, 83.33)
    assert.equal(report.mapping.samples[0].pythonId, 'p3')

    assert.equal(report.edgeMigration.applied, false)
    assert.equal(report.edgeMigration.planned, 3)
    assert.equal(report.edgeMigration.skippedExisting, 1)
    assert.equal(report.edgeMigration.skippedByType, 2)
    assert.equal(report.edgeMigration.skippedUnmappedEndpoint, 1)
    assert.equal(report.edgeMigration.skippedPartition, 1)
    assert.equal(report.edgeMigration.skippedSelfLoop, 1)

    assert.equal(report.dualRead.cases.length, 32)
    const q01 = report.dualRead.cases.find((item) => item.id === 'q01')
    assert.ok(q01.pluginCount > 0)
    assert.ok(q01.pythonCount > 0)
    assert.ok(q01.intersection >= 1)
    const q27 = report.dualRead.cases.find((item) => item.id === 'q27')
    assert.match(q27.pythonNote, /requires_ge3/)

    assert.equal(report.backup.performed, false)
    assert.deepEqual(edgeRows(dirs.pluginPath).length, 1)
    assert.equal(existsSync(dirs.backupDir), false)
    assert.match(markdown, /dry-run（未写库）/)
    assert.match(markdown, /不迁 supersede\/mutex/)
    assert.match(markdown, /回滚/)
    assert.ok(existsSync(dirs.report))
    assert.ok(existsSync(dirs.report.replace(/\.md$/, '.json')))
  } finally {
    rmSync(dirs.root, { recursive: true, force: true })
  }
})

test('apply + apply-edges：备份、写边口径、幂等、备份保留', async () => {
  const dirs = fixtureDirs('apply')
  try {
    const first = await runAudit(auditOpts(dirs, { apply: true, applyEdges: true }))
    assert.equal(first.report.mode, 'apply')
    assert.equal(first.report.edgeMigration.applied, true)
    assert.equal(first.report.edgeMigration.added, 3)
    assert.equal(first.report.backup.performed, true)
    assert.ok(existsSync(first.report.backup.path))
    assert.match(first.report.backup.path.split('/').pop(), /^whale-\d{17}\.db$/)

    const rows = edgeRows(dirs.pluginPath)
    assert.equal(rows.length, 4) // 1 条预置 + 3 条新增
    const p2p4 = rows.find((row) => row.from_id === 'p2' && row.to_id === 'p4')
    assert.deepEqual(
      { etype: p2p4.etype, source: p2p4.source, conf: p2p4.conf, weight: p2p4.weight },
      { etype: EDGE_ETYPE, source: EDGE_SOURCE, conf: 1, weight: 1.2 },
    )
    const p5p1 = rows.find((row) => row.from_id === 'p5' && row.to_id === 'p1')
    assert.equal(p5p1.conf, 0.4)
    assert.equal(p5p1.weight, 0.4)

    // 二次 apply：一条不重、不重复备份覆盖同名文件。
    const second = await runAudit(auditOpts(dirs, { apply: true, applyEdges: true }))
    assert.equal(second.report.edgeMigration.added, 0)
    assert.equal(edgeRows(dirs.pluginPath).length, 4)
    assert.ok(existsSync(second.report.backup.path))
    assert.notEqual(second.report.backup.path, first.report.backup.path)

    // 预置 6 份旧备份，下一次 apply 后只留最新 MAX_BACKUPS 份。
    mkdirSync(dirs.backupDir, { recursive: true })
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(join(dirs.backupDir, `whale-2026010100000000${i}.db`), 'old')
    }
    const third = await runAudit(auditOpts(dirs, { apply: true, applyEdges: true }))
    const backups = readdirSync(dirs.backupDir).filter((name) => /^whale-\d{14,17}\.db$/.test(name))
    assert.equal(backups.length, MAX_BACKUPS)
    assert.ok(backups.includes(third.report.backup.path.split('/').pop()))
  } finally {
    rmSync(dirs.root, { recursive: true, force: true })
  }
})

test('CLI：dry-run 打印「未写库」，--report - 只打 stdout', () => {
  const dirs = fixtureDirs('cli')
  try {
    const run = spawnSync(process.execPath, [
      SCRIPT,
      '--python-db', dirs.pyPath,
      '--plugin-db', dirs.pluginPath,
      '--report', '-',
      '--no-backup',
    ], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /dry-run（未写库）/)
    assert.match(run.stdout, /text_hash 映射 5\/6/)
    assert.match(run.stdout, /边迁移：可写 3/)
    assert.equal(edgeRows(dirs.pluginPath).length, 1)

    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /--apply-edges/)
  } finally {
    rmSync(dirs.root, { recursive: true, force: true })
  }
})

test('报告 JSON/Markdown 都能被读回，字段可机检', async () => {
  const dirs = fixtureDirs('report')
  try {
    const result = await runAudit(auditOpts(dirs))
    const jsonPath = dirs.report.replace(/\.md$/, '.json')
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.edgeMigration.total, 9)
    assert.equal(parsed.mapping.hashMapped, 5)
    assert.equal(parsed.dualRead.summary.cases, 32)
    assert.equal(result.report.mapping.hashMapped, parsed.mapping.hashMapped)
    const md = readFileSync(dirs.report, 'utf8')
    assert.match(md, /## 4\. text_hash 映射/)
    assert.match(md, /## 6\. 边迁移/)
    assert.match(md, /## 7\. 备份与回滚/)
  } finally {
    rmSync(dirs.root, { recursive: true, force: true })
  }
})
