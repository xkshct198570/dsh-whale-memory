import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { openDb, closeDb, now } from '../../src/core/db.js'
import { SCHEMA_VERSION } from '../../src/core/schema.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { search } from '../../src/core/search.js'
import { linkMutex, linkSupersede, upsertEdge } from '../../src/core/relations.js'
import { DbWorkerClient } from '../../src/core/workers/client.js'

const ALICE = { userId: 'alice', roleId: '', workspace: '' }
let dir
let db

function addNodeTo(target, id, text, extra = {}) {
  const ts = extra.createdAt ?? now()
  target.prepare(
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

function addNode(id, text, extra = {}) {
  addNodeTo(db, id, text, extra)
}

/** 独立临时库（扩散相关用例不污染共享库，避免影响既有精确命中断言）。 */
function freshSearchDb(prefix = 'whale-search-diff-') {
  const d = mkdtempSync(join(tmpdir(), prefix))
  return { d, db: openDb(d), dbPath: join(d, 'memory.db') }
}

function disposeSearchDb(f) {
  closeDb(f.db)
  rmSync(f.d, { recursive: true, force: true })
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
  assert.deepEqual(Object.keys(n1.components).sort(), ['effWeight', 'gain', 'matched', 'mult', 'path', 'rel', 'vec'])
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
  assert.equal(String(meta.value), String(SCHEMA_VERSION))
})

test('扩散分乘边置信：同种子 conf 1.0 的邻居分数高于 conf 0.6；mutex/supersede 不扩散', () => {
  const f = freshSearchDb()
  try {
    addNodeTo(f.db, 's', '扩散种子 网关 规则', { source: 'self' })
    addNodeTo(f.db, 'hi', '邻居高分 端口 备忘', { source: 'self' })
    addNodeTo(f.db, 'lo', '邻居低分 端口 备忘', { source: 'self' })
    addNodeTo(f.db, 'mx', '冲突邻居 端口 占用', { source: 'self' })
    addNodeTo(f.db, 'old', '旧节点 端口 3982', { source: 'self' })
    upsertEdge(f.db, { fromId: 's', toId: 'hi', etype: 'topic', source: 'reflect', conf: 1.0 })
    upsertEdge(f.db, { fromId: 's', toId: 'lo', etype: 'topic', source: 'reflect', conf: 0.6 })
    linkMutex(f.db, 's', 'mx')
    linkSupersede(f.db, 'old', 's')

    const r = search(f.db, { query: '扩散种子', identity: ALICE, minRel: 0.3 })
    const hi = r.hits.find((h) => h.id === 'hi')
    const lo = r.hits.find((h) => h.id === 'lo')
    assert.ok(hi, '高置信 topic 邻居必须被扩散命中')
    assert.ok(lo, 'conf=0.6 的邻居在 minRel=0.3 下应保留')
    assert.equal(hi.components.path, 'diffusion')
    assert.equal(hi.components.hops, 1)
    assert.equal(hi.components.via, 's')
    assert.equal(hi.components.conf, 1)
    assert.equal(lo.components.conf, 0.6)
    // 种子 rel=1 → hi: 1×0.6×1.0；lo: 1×0.6×0.6。扩散分必须真乘 conf。
    assert.ok(Math.abs(hi.rel - 0.6) < 1e-9, `hi.rel=${hi.rel}`)
    assert.ok(Math.abs(lo.rel - 0.36) < 1e-9, `lo.rel=${lo.rel}`)
    assert.ok(hi.score > lo.score)
    assert.equal(r.hits.some((h) => h.id === 'mx'), false, 'mutex 永不扩散')
    assert.equal(r.hits.some((h) => h.id === 'old'), false, 'supersede 永不扩散')
  } finally { disposeSearchDb(f) }
})

test('diffusion=false 关闭扩散；minConf 提高边门限后低置信邻居退出', () => {
  const f = freshSearchDb()
  try {
    addNodeTo(f.db, 's', '扩散开关 种子 规则', { source: 'self' })
    addNodeTo(f.db, 'mid', '开关邻居 甲 备忘', { source: 'self' })
    addNodeTo(f.db, 'weak', '开关邻居 乙 备忘', { source: 'self' })
    upsertEdge(f.db, { fromId: 's', toId: 'mid', etype: 'topic', source: 'reflect', conf: 0.8 })
    upsertEdge(f.db, { fromId: 's', toId: 'weak', etype: 'topic', source: 'reflect', conf: 0.4 })

    const off = search(f.db, { query: '扩散开关', identity: ALICE, diffusion: false })
    assert.deepEqual(off.hits.map((h) => h.id), ['s'], 'diffusion=false 必须连扩散都不跑')

    const strict = search(f.db, { query: '扩散开关', identity: ALICE, minRel: 0.1, minConf: 0.6 })
    assert.ok(strict.hits.some((h) => h.id === 'mid'))
    assert.equal(strict.hits.some((h) => h.id === 'weak'), false, 'conf<0.6 的边不得过门')

    const loose = search(f.db, { query: '扩散开关', identity: ALICE, minRel: 0.1, minConf: 0.2 })
    assert.ok(loose.hits.some((h) => h.id === 'weak'), 'minConf 放宽后低置信边参与扩散')
  } finally { disposeSearchDb(f) }
})

test('worker 路径透传 diffusion/minConf（advanced.worker=true 时开关真生效）', async () => {
  const f = freshSearchDb('whale-search-worker-')
  const client = new DbWorkerClient({ timeoutMs: 6000 })
  try {
    addNodeTo(f.db, 's', '扩散种子 worker 规则', { source: 'self' })
    addNodeTo(f.db, 'neighbor', '邻居高分 端口 备忘', { source: 'self' })
    addNodeTo(f.db, 'neighbor2', '低置信邻居 端口 备忘', { source: 'self' })
    upsertEdge(f.db, { fromId: 's', toId: 'neighbor', etype: 'topic', source: 'reflect', conf: 1.0 })
    upsertEdge(f.db, { fromId: 's', toId: 'neighbor2', etype: 'topic', source: 'reflect', conf: 0.5 })

    // 若 client/db-worker 丢了 diffusion 字段，worker 会按默认开扩散 → 这条断言必挂。
    const off = await client.search({
      dbPath: f.dbPath, query: '扩散种子', limit: 5, identity: ALICE, diffusion: false, minRel: 0,
    })
    assert.ok(off && Array.isArray(off.hits), 'worker 必须返回搜索结果')
    assert.equal(off.hits.some((h) => h.components?.path === 'diffusion'), false)

    const on = await client.search({
      dbPath: f.dbPath, query: '扩散种子', limit: 5, identity: ALICE, minRel: 0,
    })
    assert.ok(on.hits.some((h) => h.id === 'neighbor'), '默认扩散路径仍应命中邻居')
    assert.equal(on.hits.some((h) => h.id === 'neighbor2'), false, '默认 minConf=0.6 应挡掉 conf=0.5 的边')

    // 若 minConf 被丢，worker 仍用默认 0.6，低置信邻居不会出现。
    const loose = await client.search({
      dbPath: f.dbPath, query: '扩散种子', limit: 5, identity: ALICE, minConf: 0.4, minRel: 0,
    })
    assert.ok(loose.hits.some((h) => h.id === 'neighbor2'), 'minConf 必须透传到 worker')
  } finally {
    client.dispose()
    disposeSearchDb(f)
  }
})

test('worker 源码成对透传 diffusion/minConf（静态防回归）', () => {
  const clientSrc = readFileSync(new URL('../../src/core/workers/client.js', import.meta.url), 'utf8')
  const workerSrc = readFileSync(new URL('../../src/core/workers/db-worker.js', import.meta.url), 'utf8')
  assert.match(clientSrc, /diffusion,\s*minConf\s*\}\s*=\s*\{\}/)
  assert.match(clientSrc, /_send\('search',\s*\{[^}]*diffusion[^}]*minConf/s)
  assert.match(workerSrc, /diffusion:\s*msg\?\.diffusion/)
  assert.match(workerSrc, /minConf:\s*msg\?\.minConf/)
})

// ---------------------------------------------------------------------------
// R8-08：召回候选集排除规则镜像（origin rule:*）
// ---------------------------------------------------------------------------

test('召回排除规则镜像行：FTS 命中与扩散都不得返回 origin rule:*', () => {
  const f = freshSearchDb('whale-search-rule-')
  try {
    const text = '网关 回调 失败 日志'
    addNodeTo(f.db, 'n1', text, { level: 'core', source: 'owner', type: 'procedural' })
    const ts = now()
    // 镜像行：正文与普通节点完全相同，唯一区别是 origin 前缀（v3.7 的召回污染复现场景）。
    f.db.prepare(`INSERT INTO nodes
      (id,text,text_hash,text_bigrams,level,memory_type,source,status,
       role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
      VALUES (?,?,?,?,'core','procedural','owner','active','','','',?,?,1.0,0,1,?,'rules',?,?)`)
      .run('nrule', text, contentHash(text), bigrams(text), '[]', '规则镜像', 'rule:iron-rule-13', ts, ts)
    // 扩散边：普通节点 → 规则镜像行；扩散路径也必须被排除。
    upsertEdge(f.db, { fromId: 'n1', toId: 'nrule', etype: 'topic', source: 'reflect', conf: 1.0 })

    const r = search(f.db, { query: text, identity: ALICE, minRel: 0.3 })
    assert.equal(r.hits.some((hit) => hit.id === 'nrule'), false, '规则镜像不得进召回')
    assert.equal(r.hits.some((hit) => hit.id === 'n1'), true, '普通记忆照常召回')
  } finally {
    disposeSearchDb(f)
  }
})
