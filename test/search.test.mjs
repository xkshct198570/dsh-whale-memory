import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb, closeDb, now } from '../src/core/db.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'
import { search } from '../src/core/search.js'

const ALICE = { userId: 'alice', roleId: '', workspace: '' }
let dir
let db

function addNode(id, text, extra = {}) {
  const ts = extra.createdAt ?? now()
  db.prepare(
    `INSERT INTO nodes
       (id, text, text_hash, text_bigrams, level, memory_type, source, status,
        role_id, user_id, workspace, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    text,
    contentHash(text),
    bigrams(text),
    extra.level ?? 'normal',
    extra.type ?? 'semantic',
    extra.source ?? 'self',
    extra.status ?? 'active',
    extra.roleId ?? '',
    extra.userId ?? '',
    extra.workspace ?? '',
    ts,
    ts,
  )
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'whale-search-'))
  db = openDb(dir)
  addNode('n1', '网关 回调 失败 日志', { level: 'core', source: 'owner', type: 'procedural' })
  addNode('n2', 'WSL 断网 修改 resolv.conf 为 8.8.8.8', { level: 'important', source: 'self', type: 'procedural' })
  addNode('n3', '群主转让 需要 冻结 资金', { source: 'group' })
  addNode('n4', 'rdclientax.dll 报错 0xc000007b', { source: 'tool' })
  addNode('n5', '网关 私密 备忘', { userId: 'bob', source: 'owner' })
  addNode('n6', '网关 搜索结果 缓存', { source: 'web' })
  addNode('n7', '回调日志 留档', { source: 'self' })
  addNode('n8', '网关 工作区 备注', { workspace: 'ws1', source: 'self' })
})

after(() => {
  closeDb(db)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('L1 中文短语命中并给出可解释 components', () => {
  const r = search(db, { query: '群主转让 冻结', identity: ALICE })
  assert.equal(r.below_min_n, 0)
  assert.equal(r.hits.length, 1)
  const hit = r.hits[0]
  assert.equal(hit.id, 'n3')
  assert.equal(hit.rel, 1)
  assert.equal(hit.components.rel, 1)
  assert.equal(hit.components.mult, 1)
  assert.equal(hit.components.vec, 0)
  assert.ok(hit.components.gain >= 0.5 && hit.components.gain <= 1)
  assert.ok(Math.abs(hit.score - hit.rel * hit.components.mult * hit.components.gain) < 1e-9)
  assert.equal(typeof r.elapsed_ms, 'number')
})

test('混合查询：标识符与 IPv4 走 trigram，中文兜底', () => {
  const r = search(db, { query: 'WSL 断网 resolv.conf 8.8.8.8', identity: ALICE })
  assert.equal(r.hits[0].id, 'n2')
  assert.equal(r.hits[0].components.rel, 1)
  assert.equal(r.below_min_n, 0)
})

test('2 字查询走 bigram 兜底（trigram 不匹配 2 字）', () => {
  const g = search(db, { query: '网关', identity: ALICE })
  const ids = g.hits.map((h) => h.id)
  assert.ok(ids.includes('n1'))
  assert.ok(ids.includes('n6'))
  assert.ok(!ids.includes('n5'), 'bob 的节点不应出现在 alice 结果里')

  const f = search(db, { query: '冻结', identity: ALICE })
  assert.equal(f.hits[0].id, 'n3')
})

test('身份隔离：userId 非空 ⇒ 仅见共享与本人；不传 ⇒ 全见', () => {
  const all = search(db, { query: '网关' })
  assert.ok(all.hits.some((h) => h.id === 'n5'), '不传身份应看到所有节点')

  const alice = search(db, { query: '网关', identity: ALICE })
  assert.ok(!alice.hits.some((h) => h.id === 'n5'))
  assert.ok(alice.hits.some((h) => h.id === 'n1'), '空共享节点应可见')

  const bob = search(db, { query: '网关', identity: { userId: 'bob' } })
  assert.ok(bob.hits.some((h) => h.id === 'n5'))

  const ws2 = search(db, { query: '网关', identity: { workspace: 'ws2' } })
  assert.ok(!ws2.hits.some((h) => h.id === 'n8'))
  const ws1 = search(db, { query: '网关', identity: { workspace: 'ws1' } })
  assert.ok(ws1.hits.some((h) => h.id === 'n8'))
})

test('minRel 门挡掉低相关候选并计入 below_min_n', () => {
  const r = search(db, { query: '网关 断网 冻结 回调', identity: ALICE })
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].id, 'n1')
  assert.equal(r.hits[0].rel, 0.5)
  assert.equal(r.below_min_n, 5)
  assert.ok(!r.hits.some((h) => h.id === 'n3' || h.id === 'n7'))

  const strict = search(db, { query: '网关 断网 冻结 回调', identity: ALICE, minRel: 0.9 })
  assert.equal(strict.count, 0)
  assert.equal(strict.hits.length, 0)
  assert.equal(strict.below_min_n, 6)
})

test('score 降序：level/source/type 决定 effWeight', () => {
  const r = search(db, { query: '网关', identity: ALICE })
  assert.deepEqual(r.hits.map((h) => h.id), ['n1', 'n8', 'n6'])
  for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score)
  const n1 = r.hits[0]
  assert.ok(Math.abs(n1.components.effWeight - 12) < 0.01)
  assert.ok(n1.components.gain > 0.99)
  assert.deepEqual(Object.keys(n1.components).sort(), ['effWeight', 'gain', 'mult', 'rel', 'vec'])
})

test('意图与 memory_type 一致时 mult=1.5', () => {
  const r = search(db, { query: '怎么 网关 排障', identity: ALICE })
  const n1 = r.hits.find((h) => h.id === 'n1')
  const n6 = r.hits.find((h) => h.id === 'n6')
  assert.ok(n1, 'procedural 节点应命中')
  assert.equal(n1.components.mult, 1.5)
  assert.equal(n6.components.mult, 1)
  assert.ok(n1.score > n6.score)
})

test('IPv4 / 标识符整词直接命中', () => {
  const ip = search(db, { query: '8.8.8.8', identity: ALICE })
  assert.equal(ip.hits[0].id, 'n2')
  assert.equal(ip.hits[0].components.rel, 1)

  const ident = search(db, { query: 'rdclientax.dll', identity: ALICE })
  assert.equal(ident.hits[0].id, 'n4')
})

test('limit 生效；空查询/1 字/纯符号不抛且为空', () => {
  const one = search(db, { query: '网关', identity: ALICE, limit: 1 })
  assert.equal(one.hits.length, 1)
  assert.equal(one.count, 1)

  const zero = search(db, { query: '网关', identity: ALICE, limit: 0 })
  assert.equal(zero.hits.length, 0)

  for (const q of ['', '   ', '网', '!!!', 'a"b']) {
    const r = search(db, { query: q })
    assert.deepEqual(r.hits, [], `query=${JSON.stringify(q)}`)
    assert.equal(r.count, 0)
    assert.equal(r.below_min_n, 0)
  }
})

test('空库：直接空结果，不抛', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'whale-search-empty-'))
  const emptyDb = openDb(emptyDir)
  try {
    const r = search(emptyDb, { query: '网关', identity: ALICE })
    assert.deepEqual(r.hits, [])
    assert.equal(r.count, 0)
    assert.equal(r.below_min_n, 0)
    assert.ok(r.elapsed_ms >= 0)
  } finally {
    closeDb(emptyDb)
    rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('FTS 双表与触发器对齐（写入即可检索）', () => {
  const rows = db.prepare('SELECT count(*) AS c FROM nodes_fts').get()
  const nodes = db.prepare("SELECT count(*) AS c FROM nodes WHERE status = 'active'").get()
  assert.equal(Number(rows.c), Number(nodes.c))
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  assert.equal(String(meta.value), '1')
})
