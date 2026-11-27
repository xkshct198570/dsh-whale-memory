// 影子候选落库与 review accept/reject（含 session-wrap origin 保真）；依赖 writer-harness.mjs 的临时库，不 import 其它测试文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { Config } from '../../src/host/config.js'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper } from '../../src/core/keeper.js'
import {
  contradiction, createWriteQueue, decideWrite, findCandidates, privacyCheck, processEvent,
  recordWrite, slotsOf, timeOverlap,
} from '../../src/core/writer.js'
import { IDENT, auto, event, fakeLlm, freshDb, judgeQueue, judgeWrite, storeOf } from './writer-harness.mjs'

test('shadow：会落库的动作降级为 CANDIDATE，nodes 一行不写', (t) => {
  const db = freshDb(t)
  const r = processEvent(db, event('影子模式下的候选记忆'), { write: { reviewMode: 'shadow' } })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'CANDIDATE')
  assert.equal(r.id, undefined)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 0)

  const write = db.prepare('SELECT * FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'CANDIDATE')
  assert.equal(write.node_id, null)
  assert.match(write.reason, /shadow:ADD/)
  assert.equal(write.after_text, '影子模式下的候选记忆')
  assert.equal(write.mode, 'shadow')
})

test('shadow 载荷：accept 还原 source/memory_type/tags/expired_at', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  const expires = now() + 3600
  const r = processEvent(db, event('影子候选里的网页摘要', {
    source: 'web', memory_type: 'episodic', tags: ['网页', '摘要'], expired_at: expires,
  }), shadow)
  assert.equal(r.action, 'CANDIDATE')

  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const payload = JSON.parse(candidate.payload)
  assert.equal(payload.source, 'web')
  assert.equal(payload.memory_type, 'episodic')
  assert.deepEqual(payload.tags, ['网页', '摘要'])
  assert.equal(payload.shadowOf, 'ADD')
  assert.equal(payload.targetId, null)
  assert.equal(Number(payload.expired_at), expires)

  const accepted = q.review(candidate.id, 'accept')
  assert.equal(accepted.ok, true)
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(accepted.id)
  assert.equal(node.text, '影子候选里的网页摘要')
  assert.equal(node.source, 'web')
  assert.equal(node.memory_type, 'episodic')
  assert.deepEqual(JSON.parse(node.tags), ['网页', '摘要'])
  assert.equal(Number(node.expired_at), expires, 'TTL 必须随载荷还原')
  // 契约变更（R12）：候选原始 origin 保真落库。
  assert.equal(node.origin, 'unit')
  assert.equal(node.user_id, 'u1')
  assert.equal(node.workspace, 'web')
})

test('shadow SUPERSEDE：accept 后旧节点失效、双时态齐备并有 supersede 边', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  const old = processEvent(db, event('项目部署在测试环境 端口是 8080'), auto())
  const candidateRun = processEvent(db, event('项目部署在测试环境 端口是 9090'), shadow)
  assert.equal(candidateRun.action, 'CANDIDATE')

  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const payload = JSON.parse(candidate.payload)
  assert.equal(payload.shadowOf, 'SUPERSEDE')
  assert.equal(payload.targetId, old.id)

  const accepted = q.review(candidate.id, 'accept')
  assert.equal(accepted.ok, true)
  assert.notEqual(accepted.id, old.id)

  const oldRow = db.prepare('SELECT status,invalid_at,expired_at,superseded_by FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.status, 'superseded')
  assert.ok(Number(oldRow.invalid_at) > 0)
  assert.ok(Number(oldRow.expired_at) > 0)
  assert.equal(oldRow.superseded_by, accepted.id)
  const edge = db.prepare("SELECT * FROM edges WHERE etype='supersede' AND from_id=? AND to_id=?").get(old.id, accepted.id)
  assert.ok(edge, 'shadow SUPERSEDE 接受后必须补 supersede 边')

  const after = db.prepare('SELECT action,node_id FROM writes WHERE id=?').get(candidate.id)
  assert.equal(after.action, 'SUPERSEDE')
  assert.equal(after.node_id, accepted.id)

  // 影子 accept 是延迟落地的 SUPERSEDE：同样必须留演化痕（否则审核通道成了审计盲区）。
  const evo = db.prepare("SELECT field,old_value,new_value FROM evolution WHERE from_id=? ORDER BY id").all(old.id)
  const statusEvo = evo.find((row) => row.field === 'status')
  assert.ok(statusEvo, 'shadow accept 必须写 evolution(field=status)')
  assert.equal(statusEvo.old_value, 'active')
  assert.equal(statusEvo.new_value, 'superseded')
  assert.ok(evo.find((row) => row.field === 'text'), 'shadow accept 替换正文必须写 evolution(field=text)')
})

test('shadow MERGE：目标已被标为核心 → accept 拒绝 protected_target 且不落库', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  const oldText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const newText = `${oldText}功能`
  const old = processEvent(db, event(oldText), auto())
  const r = processEvent(db, event(newText), shadow)
  assert.equal(r.action, 'CANDIDATE')
  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  assert.equal(JSON.parse(candidate.payload).shadowOf, 'MERGE')

  db.prepare("UPDATE nodes SET level='core' WHERE id=?").run(old.id)
  const rejected = q.review(candidate.id, 'accept')
  assert.deepEqual({ ok: rejected.ok, error: rejected.error }, { ok: false, error: 'protected_target' })
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(old.id).text, oldText)
  assert.equal(db.prepare('SELECT action FROM writes WHERE id=?').get(candidate.id).action, 'CANDIDATE')
})

test('forceShadow：全局 auto 下单条事件仍落 CANDIDATE；未标记的照旧落库', (t) => {
  const db = freshDb(t)
  const cfg = auto()
  // 同一批配置下：普通事件直接 ADD；带 __forceShadow 的事件必须只留候选。
  const direct = processEvent(db, event('全局 auto 下的普通事实'), cfg)
  assert.equal(direct.action, 'ADD')
  const forced = processEvent(db, event('会话收尾的候选事实', {
    origin: 'session-wrap', __forceShadow: true,
  }), cfg)
  assert.equal(forced.action, 'CANDIDATE')
  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  assert.equal(JSON.parse(candidate.payload).origin, 'session-wrap')
  const nodeCount = Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n)
  assert.equal(nodeCount, 1, '强制 shadow 不得写节点')
})

test('shadow accept：origin 从候选载荷保真落库（不再一律改写 shadow-review）', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  const res = processEvent(db, event('对话收尾提炼的教训', {
    origin: 'session-wrap', level: 'important', memory_type: 'procedural',
  }), shadow)
  assert.equal(res.action, 'CANDIDATE')
  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const accepted = q.review(candidate.id, 'accept')
  assert.equal(accepted.ok, true)
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(accepted.id)
  assert.equal(node.origin, 'session-wrap', '候选来源必须可回查')
  assert.equal(node.level, 'important')
  assert.equal(node.memory_type, 'procedural')

  // 旧候选（载荷无 origin）仍回落 shadow-review，不制造空 origin。
  const legacy = processEvent(db, event('旧候选来源缺失', { origin: '' }), shadow)
  assert.equal(legacy.action, 'CANDIDATE')
  const legacyRow = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  assert.notEqual(legacyRow.id, candidate.id, '必须取到旧候选那一行')
  const legacyAccepted = q.review(legacyRow.id, 'accept')
  assert.equal(legacyAccepted.ok, true)
  const legacyNode = db.prepare('SELECT id,text,origin FROM nodes WHERE id=?').get(legacyAccepted.id)
  assert.equal(legacyNode.origin, 'shadow-review',
    `legacyRow.payload=${legacyRow.payload} accepted=${JSON.stringify(legacyAccepted)} node=${JSON.stringify(legacyNode)}`)
})
