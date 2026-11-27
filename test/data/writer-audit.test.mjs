// 写入审计/来源升级/保护面/时间与忽略规则回归；依赖 writer-harness.mjs 的临时库，不 import 其它测试文件。

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

test('recordWrite：审计行字段（mode/身份/trace/前后文本）完整可查', (t) => {
  const db = freshDb(t)
  const id = recordWrite(db, event('审计行专用文本', { traceId: 'tr-audit' }), {
    action: 'ADD', reason: 'manual', beforeText: '', afterText: '审计行专用文本', mode: 'auto',
  })
  assert.ok(Number.isInteger(id) && id > 0)
  const row = db.prepare('SELECT * FROM writes WHERE id=?').get(id)
  assert.equal(row.action, 'ADD')
  assert.equal(row.reason, 'manual')
  assert.equal(row.mode, 'auto')
  assert.equal(row.trace_id, 'tr-audit')
  assert.equal(row.user_id, 'u1')
  assert.equal(row.role_id, '')
  assert.equal(row.workspace, 'web')
  assert.equal(row.before_text, '')
  assert.equal(row.after_text, '审计行专用文本')
})

test('Ref 解包：真实 Config 的 reviewMode/maxChars/dailyCap 在 writer 生效', (t) => {
  const db = freshDb(t)
  const cfg = new Config({ write: { reviewMode: 'auto', maxChars: 20, dailyCap: 1 } })

  // maxChars=20：21 字必须拒绝（Ref 未解包时 finite(Ref) 恒 NaN → 上限恒 500）
  const tooLong = processEvent(db, event('x'.repeat(21)), cfg)
  assert.equal(tooLong.action, 'REJECT')
  assert.equal(tooLong.reason, 'text_too_long')

  // reviewMode=auto：真落库（Ref 未解包时恒 shadow → CANDIDATE）
  const first = processEvent(db, event('y'.repeat(20)), cfg)
  assert.equal(first.ok, true)
  assert.equal(first.action, 'ADD')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  // dailyCap=1：第二条新事实拒绝
  const capped = processEvent(db, event('z'.repeat(20)), cfg)
  assert.equal(capped.action, 'REJECT')
  assert.equal(capped.reason, 'daily_cap')

  // 默认 Config 仍是保守 shadow（不能因为解包把默认值弄丢）
  const shadowDb = freshDb(t)
  const shadow = processEvent(shadowDb, event('默认配置下的影子候选'), new Config({}))
  assert.equal(shadow.action, 'CANDIDATE')
  assert.equal(Number(shadowDb.prepare('SELECT count(*) AS n FROM nodes').get().n), 0)
})

test('NOOP → 来源升级：web 先写、owner 再写同文 → source 升 owner 且审计 source_upgrade', (t) => {
  const db = freshDb(t)
  const text = '同一事实但来源可信度不同'
  const web = processEvent(db, event(text, { source: 'web' }), auto())
  assert.equal(web.action, 'ADD')
  assert.equal(db.prepare('SELECT source FROM nodes WHERE id=?').get(web.id).source, 'web')

  const owner = processEvent(db, event(text, { source: 'owner' }), auto())
  assert.equal(owner.action, 'MERGE')
  assert.equal(owner.reason, 'source_upgrade')
  assert.equal(owner.id, web.id, '来源升级是原地更新，不新增节点')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
  assert.equal(db.prepare('SELECT source FROM nodes WHERE id=?').get(web.id).source, 'owner')

  const write = db.prepare('SELECT action,reason,before_text,after_text,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'MERGE')
  assert.equal(write.reason, 'source_upgrade')
  assert.equal(write.node_id, web.id)
  assert.equal(write.before_text, text)
  assert.equal(write.after_text, text)

  // 反向（owner 先、web 后）不得降级：仍是 NOOP
  const db2 = freshDb(t)
  const ownerFirst = processEvent(db2, event('owner 事实不允许被降级', { source: 'owner' }), auto())
  const webAfter = processEvent(db2, event('owner 事实不允许被降级', { source: 'web' }), auto())
  assert.equal(webAfter.action, 'NOOP')
  assert.equal(webAfter.reason, 'duplicate')
  assert.equal(db2.prepare('SELECT source FROM nodes WHERE id=?').get(ownerFirst.id).source, 'owner')

  // web 与 tool 同级（架构书 §6.3）：同级不算升级，仍 NOOP
  const db3 = freshDb(t)
  processEvent(db3, event('web 与 tool 同级不升级', { source: 'web' }), auto())
  const toolAfter = processEvent(db3, event('web 与 tool 同级不升级', { source: 'tool' }), auto())
  assert.equal(toolAfter.action, 'NOOP')
  assert.equal(db3.prepare('SELECT source FROM nodes WHERE id=?').get(toolAfter.id).source, 'web')
})

test('MERGE 保护面：core 节点不被自动改写，改走 REVIEW(protected_merge)+mutex', (t) => {
  const db = freshDb(t)
  const oldText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const newText = `${oldText}功能`
  const old = processEvent(db, event(oldText, { level: 'core' }), auto())

  const r = processEvent(db, event(newText), auto())
  assert.equal(r.action, 'REVIEW')
  assert.match(r.reason, /protected_merge/)

  const oldRow = db.prepare('SELECT text,status FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.text, oldText, '旧节点正文一行不动')
  assert.equal(oldRow.status, 'active')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(r.id).status, 'active')
  const edge = db.prepare("SELECT * FROM edges WHERE etype='mutex' AND from_id=? AND to_id=?").get(old.id, r.id)
  assert.ok(edge, '保护面合并必须留下 mutex 告警边')

  const write = db.prepare('SELECT action,reason,payload FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REVIEW')
  assert.match(write.reason, /protected_merge/)
  assert.equal(JSON.parse(write.payload).targetId, old.id, 'REVIEW 必须保留被保护的 targetId')

  // protect=false 时同样的文本回到普通 MERGE
  const db2 = freshDb(t)
  const old2 = processEvent(db2, event(oldText, { level: 'core' }), auto())
  const merged = processEvent(db2, event(newText), auto({ protect: false }))
  assert.equal(merged.action, 'MERGE')
  assert.equal(merged.id, old2.id)
})

test('origin 复写：同身份同 origin 不同摘要 → MERGE 更新正文并续 TTL；跨 origin/分区不合并', (t) => {
  const db = freshDb(t)
  const origin = 'tool:web_search#0123456789abcdef'
  const firstTtl = now() + 3600
  const nextTtl = firstTtl + 7200

  const first = processEvent(db, event('同查询摘要第一版', {
    origin, source: 'tool', memory_type: 'episodic', expired_at: firstTtl,
  }), auto())
  assert.equal(first.action, 'ADD')

  const second = processEvent(db, event('同查询摘要第二版更完整', {
    origin, source: 'tool', memory_type: 'episodic', expired_at: nextTtl,
  }), auto())
  assert.equal(second.action, 'MERGE')
  assert.equal(second.reason, 'origin_merge')
  assert.equal(second.id, first.id)
  const node = db.prepare('SELECT text,expired_at,status FROM nodes WHERE id=?').get(first.id)
  assert.equal(node.text, '同查询摘要第二版更完整')
  assert.equal(Number(node.expired_at), nextTtl, '同 origin 复写必须续 TTL')
  assert.equal(node.status, 'active')
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM nodes WHERE status='active'").get().n), 1)
  const audit = db.prepare('SELECT action,reason,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(audit.action, 'MERGE')
  assert.equal(audit.reason, 'origin_merge')
  assert.equal(audit.node_id, first.id)

  // 同 origin 且文本完全相同时也走 MERGE（优先级高于同 hash NOOP），不新增节点
  const third = processEvent(db, event('同查询摘要第二版更完整', {
    origin, source: 'tool', memory_type: 'episodic', expired_at: nextTtl + 1,
  }), auto())
  assert.equal(third.action, 'MERGE')
  assert.equal(third.id, first.id)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  // 不同 origin：不合并
  const db2 = freshDb(t)
  processEvent(db2, event('摘要甲', { origin: 'tool:web_search#aaaaaaaaaaaaaaaa', source: 'tool' }), auto())
  const other = processEvent(db2, event('摘要乙', { origin: 'tool:web_search#bbbbbbbbbbbbbbbb', source: 'tool' }), auto())
  assert.equal(other.action, 'ADD')
  assert.equal(Number(db2.prepare("SELECT count(*) AS n FROM nodes WHERE status='active'").get().n), 2)

  // 跨 workspace：同 origin 也不合并
  const db3 = freshDb(t)
  const web = processEvent(db3, event('跨分区同 origin 摘要', {
    origin, source: 'tool', identity: { userId: 'u1', roleId: '', workspace: 'web' },
  }), auto())
  assert.equal(web.action, 'ADD')
  const qq = processEvent(db3, event('跨分区同 origin 摘要', {
    origin, source: 'tool', identity: { userId: 'u1', roleId: '', workspace: 'qq' },
  }), auto())
  assert.equal(qq.action, 'ADD')
  assert.equal(Number(db3.prepare("SELECT count(*) AS n FROM nodes WHERE status='active'").get().n), 2)
})

test('reference_time：事件时间进 valid_at，created_at 仍是系统时间（未来时间回落 now）', (t) => {
  const db = freshDb(t)
  const ts = now()
  // 历史事实：事件时间 2020-01-01，不能被改写成"今天为真"。
  const r = processEvent(db, event('历史事件：2020 年已验证的规则', { referenceTime: 1577836800, traceId: 'tr-ref' }), { write: { reviewMode: 'auto' } })
  const row = db.prepare('SELECT valid_at,created_at FROM nodes WHERE id=?').get(r.id)
  assert.equal(Number(row.valid_at), 1577836800)
  assert.ok(Number(row.created_at) > 1577836800)
  // 未来时间（时钟漂移/脏输入）不允许把事实标成"未来才成立"。
  const r2 = processEvent(db, event('未来时间脏输入回落系统时间', { referenceTime: ts + 86400, traceId: 'tr-fut' }), { write: { reviewMode: 'auto' } })
  const row2 = db.prepare('SELECT valid_at,created_at FROM nodes WHERE id=?').get(r2.id)
  assert.equal(Number(row2.valid_at), Number(row2.created_at))
})

test('忽略规则：命中正则不落节点只记 REJECT/ignored；坏正则不阻断其它写入', (t) => {
  const db = freshDb(t)
  const cfg = auto({ ignorePatterns: ['密码是\\d+'] })
  const hit = processEvent(db, event('密码是123456'), cfg)
  assert.equal(hit.action, 'REJECT')
  assert.equal(hit.reason, 'ignored')
  assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get().n, 0)
  const row = db.prepare('SELECT action, reason FROM writes ORDER BY ts DESC LIMIT 1').get()
  assert.equal(String(row.action), 'REJECT')
  assert.match(String(row.reason), /ignored/)

  // 非法正则只跳过该条：一条写错的规则不能挡住全部写入。
  const ok = processEvent(db, event('今天天气是晴'), auto({ ignorePatterns: ['(['] }))
  assert.equal(ok.action, 'ADD')
})
