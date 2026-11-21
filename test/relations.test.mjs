/**
 * 关系层单测（架构书 §7）：边幂等、扩散可解释、context_note 永不破 200。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../src/core/db.js'
import {
  NOTE_MAX, applyNeighborNotes, evolutionNote, expandOneHop, linkMutex, linkSupersede,
  parseTags, passDiffusion, rebuildTagEdges, relationStats, upsertEdge,
} from '../src/core/relations.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'

const ident = { userId: 'u1', roleId: '', workspace: 'web' }

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-rel-'))
  return openDb(dir)
}

let seq = 0
function node(db, { text, tags = [], note = '', level = 'normal', type = 'semantic', identity = ident }) {
  seq += 1
  const id = `nr${Date.now()}_${seq}`
  const ts = now()
  db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,1,0,'none','test','',?,?)`).run(
    id, text, contentHash(text), bigrams(text), level, type, 'owner',
    String(identity.roleId || ''), String(identity.userId || ''), String(identity.workspace || ''),
    JSON.stringify(tags), note, ts, ts,
  )
  return id
}

test('evolutionNote：去重追加，10 次回填后恒 ≤200 字且保留最新标签', () => {
  let note = ''
  for (let i = 0; i < 10; i += 1) note = evolutionNote(note, [`标签${i}`])
  assert.ok(note.length <= NOTE_MAX)
  assert.ok(note.includes('标签9'), '最新标签必须还在')
  assert.equal(note.split(' · ').filter(Boolean).length, note.split(' · ').length)
})

test('evolutionNote：重复标签不重复追加；超长注记按上限截断', () => {
  const once = evolutionNote('', ['端口'])
  const twice = evolutionNote(once, ['端口'])
  assert.equal(twice, once)
  const long = evolutionNote('', ['z'.repeat(250)])
  assert.ok(long.length <= NOTE_MAX)
  assert.ok(long.endsWith('…'))
  const dropped = evolutionNote('x'.repeat(180), ['y'.repeat(30)])
  assert.ok(dropped.length <= NOTE_MAX)
  assert.ok(dropped.includes('y'.repeat(30)))
})

test('passDiffusion：只放行 topic/reference 且 conf≥门限；mutex 永不扩散', () => {
  assert.equal(passDiffusion({ etype: 'topic', conf: 0.6 }), true)
  assert.equal(passDiffusion({ etype: 'reference', conf: 1 }), true)
  assert.equal(passDiffusion({ etype: 'topic', conf: 0.59 }), false)
  assert.equal(passDiffusion({ etype: 'mutex', conf: 1 }), false)
  assert.equal(passDiffusion({ etype: 'similar', conf: 1 }), false)
  assert.equal(passDiffusion(null), false)
})

test('upsertEdge：同边幂等且置信只升不降；坏枚举拒绝', () => {
  const db = freshDb()
  try {
    const a = node(db, { text: '节点甲', tags: ['端口'] })
    const b = node(db, { text: '节点乙', tags: ['端口'] })
    assert.equal(upsertEdge(db, { fromId: a, toId: b, etype: 'topic', source: 'reflect', conf: 0.5 }).ok, true)
    assert.equal(upsertEdge(db, { fromId: a, toId: b, etype: 'topic', source: 'reflect', conf: 0.8 }).ok, true)
    assert.equal(upsertEdge(db, { fromId: a, toId: b, etype: 'topic', source: 'reflect', conf: 0.2 }).ok, true)
    const row = db.prepare('SELECT conf FROM edges WHERE from_id=? AND to_id=? AND etype=?').get(a, b, 'topic')
    assert.equal(Number(row.conf), 0.8)
    const count = db.prepare('SELECT count(*) AS n FROM edges').get().n
    assert.equal(Number(count), 1)
    assert.equal(upsertEdge(db, { fromId: a, toId: b, etype: 'bogus' }).ok, false)
    assert.equal(upsertEdge(db, { fromId: a, toId: b, etype: 'topic', source: 'bogus' }).ok, false)
  } finally { closeDb(db) }
})

test('rebuildTagEdges：同 tag 小群体连 similar；大众 tag（df>门槛）不连', () => {
  const db = freshDb()
  try {
    const a = node(db, { text: '甲规则', tags: ['端口', '网关'] })
    const b = node(db, { text: '乙规则', tags: ['端口'] })
    const c = node(db, { text: '丙规则', tags: ['端口'] })
    node(db, { text: '大众丁', tags: ['杂项'] })
    node(db, { text: '大众戊', tags: ['杂项'] })
    const stat = rebuildTagEdges(db, { dfMax: 3 })
    assert.ok(stat.edges >= 1)
    // 端口有 3 个成员（≤dfMax=3）→ 连边；网关只有 1 个成员 → 不连。
    const pairs = db.prepare("SELECT from_id,to_id FROM edges WHERE etype='similar'").all()
    const flat = pairs.map((p) => `${p.from_id}|${p.to_id}`)
    assert.ok(flat.some((x) => x.includes(a) && x.includes(b)))
    assert.ok(stat.tags >= 2)
    assert.equal(linkMutex(db, a, c).ok, true)
    const st = relationStats(db)
    assert.ok(st.edges >= 2)
    assert.ok(st.by_type.some((t) => t.etype === 'mutex'))
  } finally { closeDb(db) }
})

test('1 跳扩散：只沿 topic/reference，conf 过门；mutex 与 supersede 不扩', () => {
  const db = freshDb()
  try {
    const seed = node(db, { text: '种子节点 端口规则', tags: ['端口'] })
    const topic = node(db, { text: '主题邻居 网关规则', tags: ['网关'] })
    const mutex = node(db, { text: '冲突邻居 端口占用', tags: ['端口'] })
    const old = node(db, { text: '旧节点 端口为 3982', tags: ['端口'] })
    upsertEdge(db, { fromId: seed, toId: topic, etype: 'topic', source: 'reflect', conf: 0.7 })
    linkMutex(db, seed, mutex)
    linkSupersede(db, old, seed)
    const out = expandOneHop(db, { seeds: [{ id: seed }], minConf: 0.6, identity: ident })
    const ids = out.map((x) => x.id)
    assert.ok(ids.includes(topic))
    assert.equal(ids.includes(mutex), false)
    assert.equal(ids.includes(old), false)
    assert.equal(out[0].hops, 1)
    // search.js 的扩散分要乘这条边置信，expandOneHop 必须把它带出来。
    assert.equal(Number(out[0].via_conf), 0.7)
    const strict = expandOneHop(db, { seeds: [{ id: seed }], minConf: 0.95, identity: ident })
    assert.equal(strict.length, 0)
  } finally { closeDb(db) }
})

test('邻居注记：10 次加注后 ≤200 字，正文与 tags 不变，演化留痕', () => {
  const db = freshDb()
  try {
    const first = node(db, { text: '邻居记忆正文', tags: ['共享'], level: 'core' })
    for (let i = 0; i < 10; i += 1) {
      const n = node(db, { text: `新节点 ${i}`, tags: ['共享', `轮次${i}`] })
      applyNeighborNotes(db, { id: n, tags: ['共享', `轮次${i}`], identity: ident }, { topK: 3 })
    }
    const row = db.prepare('SELECT text, tags, context_note FROM nodes WHERE id=?').get(first)
    assert.equal(row.text, '邻居记忆正文')
    assert.deepEqual(JSON.parse(row.tags), ['共享'])
    assert.ok(String(row.context_note).length <= NOTE_MAX)
    const evo = db.prepare('SELECT count(*) AS n FROM evolution WHERE to_id=?').get(first)
    assert.ok(Number(evo.n) >= 10)
    assert.deepEqual(parseTags(row.tags), ['共享'])
  } finally { closeDb(db) }
})

test('邻居注记：跨工作区不互写（隔离面）', () => {
  const db = freshDb()
  try {
    const other = node(db, { text: 'QQ 端专属', tags: ['共享'], identity: { userId: 'u1', roleId: '', workspace: 'qq' } })
    const mine = node(db, { text: '网页端节点', tags: ['共享'], identity: ident })
    applyNeighborNotes(db, { id: mine, tags: ['共享'], identity: ident }, { topK: 3 })
    const row = db.prepare('SELECT context_note FROM nodes WHERE id=?').get(other)
    assert.equal(String(row.context_note), '')
  } finally { closeDb(db) }
})
