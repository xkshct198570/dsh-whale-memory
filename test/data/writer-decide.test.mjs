// 写入决策纯函数与 ADD/NOOP/MERGE/SUPERSEDE/REVIEW 主分支；依赖 writer-harness.mjs 的临时库与事件构造，不 import 其它测试文件。

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

test('slotsOf：只认端口/路径/版本/日期，且端口必须同句含语境词', (t) => {
  assert.deepEqual(
    slotsOf('服务端口是 8080，回调路径 /tmp/x，版本 v1.2，日期 2026-11-22'),
    ['port:8080', 'path:/tmp/x', 'version:1.2', 'date:2026-11-22'],
  )
  // 没有 端口|port|回调|webhook 语境：数字不算端口
  assert.deepEqual(slotsOf('数字 8080 没有语境'), [])
  // URL 协议头不是路径
  assert.deepEqual(slotsOf('地址 http://example.com/a'), [])
  assert.deepEqual(slotsOf(''), [])
  assert.deepEqual(slotsOf(null), [])
})

test('privacyCheck：严格模式拒绝，脱敏模式替换命中片段', (t) => {
  const raw = '联系人 a@b.com 电话 13800138000 身份证 110101199003071234'
  const strict = privacyCheck(raw, { redact: false })
  assert.equal(strict.ok, false)
  assert.equal(strict.reason, 'privacy')
  assert.equal(strict.text, raw, 'redact=false 不改写原文')

  const soft = privacyCheck(`${raw} 密钥 sk-abcdefgh12345678 Bearer abcdefgh12345678 密码=hunter2`)
  assert.equal(soft.ok, true)
  assert.equal(soft.reason, 'privacy_redacted')
  assert.match(soft.text, /\[已脱敏\]/)
  for (const leaked of ['a@b.com', '13800138000', '110101199003071234', 'sk-abcdefgh12345678', 'hunter2']) {
    assert.ok(!soft.text.includes(leaked), `不应残留 ${leaked}`)
  }
  // 干净文本原样返回
  assert.deepEqual(privacyCheck('今天下午开会'), { ok: true, text: '今天下午开会' })
})

test('contradiction：否定对优先，其次同前缀槽位差异；无关文本不冲突', (t) => {
  assert.equal(contradiction({ text: '允许访客访问共享目录' }, '禁止访客访问共享目录'), 'negation')
  assert.equal(contradiction({ text: '这个模块必须双人复核' }, '这个模块不必双人复核'), 'negation')
  assert.equal(
    contradiction({ text: '项目部署在测试环境 端口是 8080' }, '项目部署在测试环境 端口是 9090'),
    'slot',
  )
  assert.equal(contradiction({ text: '项目部署在测试环境 端口是 8080' }, '今天午餐吃了面条'), null)
})

test('timeOverlap：三段式（旧事实先失效 / 新事实先失效 / 重叠）', (t) => {
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: 20 }, { valid_at: 30 }), 'no-overlap')
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: null }, { valid_at: 30, invalid_at: 5 }), 'no-overlap')
  assert.equal(timeOverlap({ valid_at: 10, invalid_at: null }, { valid_at: 30 }), 'overlap')
  // 缺时间戳不能被当成 0（Number(null)===0 会制造假"不重叠"）
  assert.equal(timeOverlap({ valid_at: null, invalid_at: null }, 30), 'overlap')
})

test('ADD：节点字段全填、三隔离列与审计行一致', (t) => {
  const db = freshDb(t)
  const text = '记住项目代号是蓝鲸'
  const r = processEvent(db, event(text, { tags: ['项目'] }), auto())
  assert.equal(r.ok, true)
  assert.equal(r.action, 'ADD')
  assert.match(r.id, /^n\d+_[0-9a-f]{10}$/)

  const row = db.prepare('SELECT * FROM nodes WHERE id=?').get(r.id)
  assert.equal(row.text, text)
  assert.equal(row.text_hash, contentHash(text))
  assert.equal(row.text_bigrams, bigrams(text))
  assert.equal(row.status, 'active')
  assert.equal(row.source, 'self') // 事件 source='chat' → nodes.source 合法值 'self'
  assert.equal(row.level, 'normal')
  assert.equal(row.memory_type, 'semantic')
  assert.equal(row.user_id, 'u1')
  assert.equal(row.role_id, '')
  assert.equal(row.workspace, 'web')
  assert.deepEqual(JSON.parse(row.tags), ['项目'])
  assert.equal(row.origin, 'unit')
  assert.equal(row.trace_id, 'tr-1')
  assert.ok(Number(row.created_at) > 0)
  assert.ok(Number(row.valid_at) > 0)

  const write = db.prepare('SELECT * FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'ADD')
  assert.equal(write.node_id, r.id)
  assert.equal(write.mode, 'auto')
  assert.equal(write.after_text, text)
  assert.equal(write.user_id, 'u1')
  assert.equal(write.trace_id, 'tr-1')
})

test('NOOP：同身份原文重复只记命中，不新增节点', (t) => {
  const db = freshDb(t)
  const first = processEvent(db, event('重复消息只记一次'), auto())
  const second = processEvent(db, event('重复消息只记一次'), auto())
  assert.equal(second.action, 'NOOP')
  assert.equal(second.id, first.id)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  const row = db.prepare('SELECT hits,last_hit_at FROM nodes WHERE id=?').get(first.id)
  assert.equal(Number(row.hits), 1)
  assert.ok(Number(row.last_hit_at) > 0)
  const write = db.prepare('SELECT action,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'NOOP')
  assert.equal(write.node_id, first.id)
})

test('MERGE：信息只增不减时合并到旧节点，不新增节点', (t) => {
  const db = freshDb(t)
  const oldText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const newText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用功能'
  const old = processEvent(db, event(oldText), auto())
  const r = processEvent(db, event(newText), auto())
  assert.equal(r.action, 'MERGE')
  assert.equal(r.id, old.id)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)

  const row = db.prepare('SELECT text,text_hash,text_bigrams,updated_at FROM nodes WHERE id=?').get(old.id)
  assert.equal(row.text, newText)
  assert.equal(row.text_hash, contentHash(newText))
  assert.equal(row.text_bigrams, bigrams(newText))

  const write = db.prepare('SELECT action,before_text,after_text,node_id FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'MERGE')
  assert.equal(write.node_id, old.id)
  assert.equal(write.before_text, oldText)
  assert.equal(write.after_text, newText)
  // 审计 P2-F6：auto MERGE 改写正文必须与影子 accept 同口径留 evolution。
  const evo = db.prepare("SELECT field,old_value,new_value FROM evolution WHERE to_id=? ORDER BY id").all(old.id)
  assert.ok(evo.some((row) => row.field === 'text' && row.old_value === oldText && row.new_value === newText))
})

test('SUPERSEDE：端口槽位冲突取代旧节点，双时态与 supersede 边齐备', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const newText = '项目部署在测试环境 端口是 9090'
  const old = processEvent(db, event(oldText), auto())
  const r = processEvent(db, event(newText), auto())
  assert.equal(r.action, 'SUPERSEDE')
  assert.notEqual(r.id, old.id)

  const oldRow = db.prepare('SELECT status,invalid_at,expired_at,superseded_by FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.status, 'superseded')
  assert.ok(Number(oldRow.invalid_at) > 0)
  assert.ok(Number(oldRow.expired_at) > 0)
  assert.equal(oldRow.superseded_by, r.id)

  const newRow = db.prepare('SELECT status,text FROM nodes WHERE id=?').get(r.id)
  assert.equal(newRow.status, 'active')
  assert.equal(newRow.text, newText)

  const edge = db.prepare("SELECT * FROM edges WHERE etype='supersede' AND from_id=? AND to_id=?").get(old.id, r.id)
  assert.ok(edge, '必须留下 supersede 溯源边')
  assert.equal(Number(edge.conf), 1)

  // A3/A7 留痕：SUPERSEDE 改旧节点的 status（+ 正文被新事实替换）必须写 evolution，
  // old_value 是"改之前"的值，不能拿新行反推。
  const evo = db.prepare("SELECT field,old_value,new_value,from_id,to_id,trace_id FROM evolution WHERE from_id=? ORDER BY id").all(old.id)
  const statusEvo = evo.find((row) => row.field === 'status')
  assert.ok(statusEvo, 'SUPERSEDE 必须写 evolution(field=status)')
  assert.equal(statusEvo.old_value, 'active')
  assert.equal(statusEvo.new_value, 'superseded')
  assert.equal(statusEvo.to_id, r.id)
  const textEvo = evo.find((row) => row.field === 'text')
  assert.ok(textEvo, '正文被新事实替换必须写 evolution(field=text)')
  assert.equal(textEvo.old_value, oldText)
  assert.equal(textEvo.new_value, newText)
  const write = db.prepare('SELECT reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.reason, 'supersede:slot', '原因仍在 writes.reason，evolution 给旧值/新值')
})

test('REVIEW：受保护节点冲突只告警（mutex 边），旧节点保持 active', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const old = processEvent(db, event(oldText, { level: 'core' }), auto())
  const r = processEvent(db, event('项目部署在测试环境 端口是 9090'), auto())
  assert.equal(r.action, 'REVIEW')
  assert.equal(r.reason, 'protected')

  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(r.id).status, 'active')
  const edge = db.prepare("SELECT * FROM edges WHERE etype='mutex' AND from_id=? AND to_id=?").get(old.id, r.id)
  assert.ok(edge, '冲突告警要有 mutex 边')
  const write = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REVIEW')
  assert.equal(write.reason, 'protected')

  // 关掉保护后，同样的冲突回到 SUPERSEDE
  const db2 = freshDb(t)
  processEvent(db2, event(oldText, { level: 'core' }), auto())
  const r2 = processEvent(db2, event('项目部署在测试环境 端口是 9090'), auto({ protect: false }))
  assert.equal(r2.action, 'SUPERSEDE')
})

test('隐私：默认脱敏后落库；严格入口直接 REJECT', (t) => {
  const db = freshDb(t)
  const r = processEvent(db, event('密钥是 sk-abcdefgh12345678 其余内容正常'), auto())
  assert.equal(r.action, 'ADD')
  const row = db.prepare('SELECT text FROM nodes WHERE id=?').get(r.id)
  assert.match(row.text, /\[已脱敏\]/)
  assert.ok(!row.text.includes('sk-abcdefgh12345678'))
  const write = db.prepare('SELECT reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.match(write.reason, /privacy:redacted/)

  const strictEvent = event('联系我 a@b.com')
  const rejected = processEvent(db, strictEvent, auto({ redact: false }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.action, 'REJECT')
  assert.equal(rejected.reason, 'privacy')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
})

test('隐私开关真源：Config.privacy.redact=false 走严格入口（密钥不被替换成占位符）', (t) => {
  const db = freshDb(t)
  // 真实 Config：privacy 组才是面板那一栏，write.redact 在 schema 里根本不存在（审计 P0-1 假开关）。
  const cfg = Config({ write: { reviewMode: 'auto' }, privacy: { redact: false } })
  assert.equal(cfg.privacy.redact.get(), false, 'privacy.redact 是 volatile Ref，必须解包后为 false')
  const r = processEvent(db, event('密钥是 sk-abcdefgh12345678 其余内容正常'), cfg)
  assert.equal(r.ok, false)
  assert.equal(r.action, 'REJECT')
  assert.equal(r.reason, 'privacy')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 0, '严格入口不落库')
  const write = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REJECT')
  assert.doesNotMatch(write.reason, /privacy:redacted/, '没有被"替换后落库"就不该有脱敏标记')

  // 同一 Config 只把 privacy.redact 改回 true：仍然是脱敏落库（证明读的是 privacy 组）。
  const db2 = freshDb(t)
  const soft = processEvent(db2, event('密钥是 sk-abcdefgh12345678 其余内容正常'), Config({ write: { reviewMode: 'auto' } }))
  assert.equal(soft.action, 'ADD')
  assert.match(db2.prepare('SELECT text FROM nodes WHERE id=?').get(soft.id).text, /\[已脱敏\]/)
})

test('每日上限：达到 dailyCap 后新事实被拒（NOOP/REJECT 不占额度）', (t) => {
  const db = freshDb(t)
  const config = auto({ dailyCap: 1 })
  assert.equal(processEvent(db, event('第一条独立记忆内容'), config).action, 'ADD')
  const capped = processEvent(db, event('第二条独立记忆内容'), config)
  assert.equal(capped.ok, false)
  assert.equal(capped.action, 'REJECT')
  assert.equal(capped.reason, 'daily_cap')
  const write = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(write.action, 'REJECT')
  assert.equal(write.reason, 'daily_cap')
})

test('计划/承诺词：冲突只新增，不取代已落地事实', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('服务器端口使用 8080 并开启回调'), auto())
  const r = processEvent(db, event('下周计划把服务器端口改成 9090 并开启回调'), auto())
  assert.equal(r.action, 'ADD')
  assert.match(r.reason, /plan_deferred/)
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(r.id).status, 'active')
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM edges WHERE etype='supersede'").get().n), 0)
})

test('decideWrite：纯决策不落库，返回目标与前后文本', (t) => {
  const db = freshDb(t)
  const oldText = '项目部署在测试环境 端口是 8080'
  const old = processEvent(db, event(oldText), auto())
  const decision = decideWrite(db, event('项目部署在测试环境 端口是 9090'), { mode: 'auto' })
  assert.equal(decision.action, 'SUPERSEDE')
  assert.equal(decision.targetId, old.id)
  assert.equal(decision.beforeText, oldText)
  assert.equal(decision.afterText, '项目部署在测试环境 端口是 9090')
  // 决策阶段不写审计
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM writes').get().n), 1)
})
