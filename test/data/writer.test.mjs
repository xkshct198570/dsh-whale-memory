/**
 * 写入决策与队列的单测（架构书 §6.2/§7.3）：只碰临时库，不访问真实数据目录/网络。
 *
 * 覆盖口径：
 * - 四个纯函数（隐私/槽位/冲突/时间重叠）先单验，再验过程（ADD/NOOP/MERGE/SUPERSEDE/REVIEW/CANDIDATE）。
 * - 落库断言查真实列值（双时态、三隔离列、text_bigrams/text_hash），不只信返回值。
 * - 队列断言查 jobs 行状态 + payload 里的 result，确认"先落盘再处理"与崩溃补偿。
 */
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

const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }

/** 临时库：每个用例独立目录，结束时关闭。 */
function freshDb(t) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-writer-')))
  t.after(() => closeDb(db))
  return db
}

/** 造事件（缺省值对齐真实写入入口）。 */
function event(text, extra = {}) {
  return {
    traceId: 'tr-1',
    source: 'chat',
    identity: IDENT,
    text,
    tags: [],
    at: 0,
    candidateType: 'fact',
    origin: 'unit',
    level: 'normal',
    memory_type: 'semantic',
    ...extra,
  }
}

/** auto 模式配置（可覆盖 write 段）。 */
function auto(write = {}) {
  return { write: { reviewMode: 'auto', ...write } }
}

/** 内存 store：队列只需要 withDb 同步入口。 */
function storeOf(db) {
  return { withDb: (fn) => fn(db) }
}

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

test('queue：先落盘再处理，enqueue 的 Promise 在 job done 时 resolve', async (t) => {
  const db = freshDb(t)
  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())

  const pendingPromise = q.enqueue(event('队列持久化记忆'))
  const jobRow = db.prepare('SELECT id,state,kind FROM jobs').get()
  assert.equal(jobRow.kind, 'write')
  assert.equal(jobRow.state, 'queued')
  assert.equal(q.pending(), 1)

  const p1 = q.drain()
  const p2 = q.drain()
  assert.equal(p1, p2, 'drain 必须单飞（同一 Promise）')
  const { processed } = await p1
  assert.equal(processed, 1)

  const result = await pendingPromise
  assert.equal(result.action, 'ADD')
  assert.match(result.id, /^n\d+_[0-9a-f]{10}$/)

  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobRow.id)
  assert.equal(job.state, 'done')
  assert.equal(Number(job.attempts), 1)
  assert.match(String(job.payload), /"result":\{"action":"ADD"/)
  assert.equal(q.pending(), 0)

  const duplicate = await q.enqueue(event('队列持久化记忆'))
  assert.equal(duplicate.action, 'NOOP')
  assert.equal(duplicate.duplicate, true)
})

test('queue 崩溃补偿：遗留 running job 复位 queued 后 drain 跑完', async (t) => {
  const db = freshDb(t)
  const payload = JSON.stringify(event('崩溃前遗留的记忆'))
  const jobId = Number(db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('write', 'running', 0, payload, now(), now()).lastInsertRowid)

  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'queued')

  const { processed } = await q.drain()
  assert.equal(processed, 1)
  const job = db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(jobId)
  assert.equal(job.state, 'done')
  assert.equal(Number(job.attempts), 1)
  const node = db.prepare('SELECT text FROM nodes').get()
  assert.equal(node.text, '崩溃前遗留的记忆')
})

test('queue：单条坏 payload 记 REJECT 后继续处理同批', async (t) => {
  const db = freshDb(t)
  const insert = db.prepare('INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  insert.run('write', 'queued', 0, '{不是 JSON', now(), now())
  insert.run('write', 'queued', 0, JSON.stringify(event('坏 job 之后仍要处理')), now(), now())

  const q = createWriteQueue({ store: storeOf(db), config: auto() })
  t.after(() => q.dispose())
  const { processed } = await q.drain()
  assert.equal(processed, 2)
  const states = db.prepare('SELECT state FROM jobs ORDER BY id').all().map((r) => r.state)
  assert.deepEqual(states, ['done', 'done'])
  assert.ok(db.prepare('SELECT text FROM nodes').get())
})

test('review：accept 落节点并改审计为 ADD；reject 改 REJECT；找不到候选报错', (t) => {
  const db = freshDb(t)
  const shadow = { write: { reviewMode: 'shadow' } }
  const q = createWriteQueue({ store: storeOf(db), config: shadow })
  t.after(() => q.dispose())

  processEvent(db, event('待审核的候选记忆'), shadow)
  const candidate = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const accepted = q.review(candidate.id, 'accept')
  assert.equal(accepted.ok, true)
  assert.match(accepted.id, /^n\d+_[0-9a-f]{10}$/)

  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(accepted.id)
  assert.equal(node.text, candidate.after_text)
  assert.equal(node.source, 'self')
  // 契约变更（R12）：accept 保留候选原始 origin，不再统一改写 shadow-review，便于回查来源。
  assert.equal(node.origin, 'unit')
  assert.equal(node.status, 'active')
  assert.equal(node.user_id, 'u1')
  assert.equal(node.workspace, 'web')
  const afterAccept = db.prepare('SELECT action,node_id FROM writes WHERE id=?').get(candidate.id)
  assert.equal(afterAccept.action, 'ADD')
  assert.equal(afterAccept.node_id, accepted.id)

  const rejectedCandidate = processEvent(db, event('要被驳回的候选记忆'), shadow)
  assert.equal(rejectedCandidate.action, 'CANDIDATE')
  const rejectRow = db.prepare("SELECT * FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get()
  const rejected = q.review(rejectRow.id, 'reject', '重复冲突')
  assert.equal(rejected.ok, true)
  const afterReject = db.prepare('SELECT action,reason FROM writes WHERE id=?').get(rejectRow.id)
  assert.equal(afterReject.action, 'REJECT')
  assert.match(afterReject.reason, /review:reject:重复冲突/)

  assert.deepEqual(q.review(999999, 'accept'), { ok: false, error: 'candidate_not_found' })
  assert.deepEqual(q.review(candidate.id, 'accept'), { ok: false, error: 'candidate_not_found' })
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1)
})

// ---------------------------------------------------------------------------
// 审计缺陷回归（P0）：Ref 解包 / 来源升级 / 保护面合并 / 影子载荷 / origin 复写
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 判定器（write.judge='llm'）端到端：候选短 id → fake llm → 裁决 → 既有落库分支。
// 每条断言都先验证"规则会走别的分支"，证明结果确实来自裁决而不是巧合。
// ---------------------------------------------------------------------------

/** 判定器配置（auto 模式；judge=llm 由配置驱动，队列按 liveConfig 读取）。 */
function judgeWrite(write = {}) {
  return { write: { reviewMode: 'auto', judge: 'llm', ...write } }
}

/** fake llm：记录调用参数，逐字 yield 模型原文（解析失败/超时由后续用例覆盖）。 */
function fakeLlm(reply, calls) {
  return {
    async *stream(opts) {
      calls?.push(opts)
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** 判定器队列：llm/selection 由用例注入；缺省 llm 用 fakeLlm(reply)。 */
function judgeQueue(t, db, { reply = '', calls = [], write = {}, llm, selection = { provider: 'p', model: 'm' }, log } = {}) {
  const q = createWriteQueue({
    store: storeOf(db),
    config: judgeWrite(write),
    getLlm: () => (llm === undefined ? fakeLlm(reply, calls) : llm),
    getSelection: () => selection,
    log,
  })
  t.after(() => q.dispose())
  return q
}

test('findCandidates：同身份 active 候选（规则与判定器共用同一口径）', (t) => {
  const db = freshDb(t)
  const first = processEvent(db, event('候选口径第一条'), auto())
  const second = processEvent(db, event('候选口径第二条'), auto())
  // 跨分区与已失效节点都不是候选
  processEvent(db, { ...event('别人分区的候选'), identity: { userId: 'u2', roleId: '', workspace: 'web' } }, auto())
  const stale = processEvent(db, event('候选口径第三条'), auto())
  db.prepare("UPDATE nodes SET status='superseded' WHERE id=?").run(stale.id)

  const ids = findCandidates(db, event('新事件')).map((r) => String(r.id))
  assert.deepEqual(ids.sort(), [first.id, second.id].sort())
  const row = findCandidates(db, event('新事件')).find((r) => String(r.id) === second.id)
  for (const col of ['text', 'level', 'memory_type', 'source', 'valid_at', 'invalid_at']) {
    assert.ok(col in row, `候选行缺列 ${col}（判定器提示词/保护面都靠它）`)
  }
})

test('judge=llm：候选重复 → NOOP（规则会 ADD，裁决优先）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  assert.equal(old.action, 'ADD')
  const rules = decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '基线必须是 ADD，否则证明不了裁决生效')

  const calls = []
  const logs = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP","reason":"重复事实"}',
    calls,
    log: (line) => logs.push(line),
  })
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.action, 'NOOP')
  assert.equal(result.reason, 'judge_noop')
  assert.deepEqual(result.judge, { used: true, action: 'NOOP', targetId: old.id })
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, 'NOOP 不新增节点')
  assert.equal(Number(db.prepare('SELECT hits FROM nodes WHERE id=?').get(old.id).hits), 1, 'NOOP 记命中')

  assert.equal(calls.length, 1, '有候选才调模型')
  assert.equal(calls[0].model, 'm', 'write.model 为空时用默认选择')
  assert.deepEqual(calls[0].messages[0].content[0].text.includes(old.id), false, '提示词不得暴露真实节点 id')
  assert.match(calls[0].messages[0].content[0].text, /候选记忆/)
  assert.ok(logs.some((line) => line.includes('judge used=true action=NOOP')), '成功日志口径')
  // 裁决理由落审计？reason 是 judge_noop（裁决理由只进日志/解析结果，不覆盖落库口径）
  const audit = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(audit.action, 'NOOP')
  assert.equal(audit.reason, 'judge_noop')
})

test('judge=llm：矛盾 → SUPERSEDE（旧节点失效 + supersede 边 + evolution）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('配色偏好是深色主题'), auto())
  const rules = decideWrite(db, event('配色偏好改成浅色主题'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '规则只看到弱相似，基线是 ADD')

  const q = judgeQueue(t, db, { reply: '{"id":1,"action":"SUPERSEDE","reason":"同一偏好被新决定矛盾取代"}' })
  const result = await q.enqueue(event('配色偏好改成浅色主题'))
  assert.equal(result.action, 'SUPERSEDE')
  assert.equal(result.judge?.used, true)
  assert.equal(result.judge?.action, 'SUPERSEDE')
  assert.equal(result.judge?.targetId, old.id)

  const oldRow = db.prepare('SELECT status,superseded_by,invalid_at,expired_at FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.status, 'superseded')
  assert.equal(oldRow.superseded_by, result.id)
  assert.ok(Number(oldRow.invalid_at) > 0)
  assert.ok(Number(oldRow.expired_at) > 0)
  assert.equal(db.prepare("SELECT text FROM nodes WHERE id=?").get(result.id).text, '配色偏好改成浅色主题')
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM edges WHERE etype='supersede'").get().n), 1)
  const evo = db.prepare("SELECT field,old_value,new_value FROM evolution WHERE from_id=? ORDER BY id").all(old.id)
  assert.ok(evo.some((row) => row.field === 'status' && row.new_value === 'superseded'), '状态迁移留痕')
  assert.ok(evo.some((row) => row.field === 'text' && row.old_value === '配色偏好是深色主题'), '正文替换留痕')
})

test('judge=llm：补充同一事实 → MERGE（改目标正文，不新增节点）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const rules = decideWrite(db, event('回调端口 3982 只接受 POST 请求'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '相似度不足，规则基线是 ADD')

  const q = judgeQueue(t, db, { reply: '{"id":1,"action":"MERGE","reason":"同一端口的补充说明"}' })
  const result = await q.enqueue(event('回调端口 3982 只接受 POST 请求'))
  assert.equal(result.action, 'MERGE')
  assert.equal(result.id, old.id)
  assert.equal(result.judge?.action, 'MERGE')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, 'MERGE 不新增节点')
  const row = db.prepare('SELECT text,text_hash FROM nodes WHERE id=?').get(old.id)
  assert.equal(row.text, '回调端口 3982 只接受 post 请求', 'normalize 会把英文小写（落库口径不变）')
  assert.equal(row.text_hash, contentHash('回调端口 3982 只接受 post 请求'), '正文与 hash 同步更新')
})

test('judge=llm：模型缺失/抛错/坏 JSON → 回落规则（结果与 rules 一致）', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  // 每个子用例用不同正文：回落的 ADD 会落库，复用同一正文会让后续用例命中同 hash NOOP。
  const rulesOf = (text) => decideWrite(db, event(text), { mode: 'auto' })
  const cases = [
    ['场景甲 网关回调端口是 3982', { llm: null }, 'judge_fallback:llm_unavailable', '模型缺失'],
    ['场景乙 网关回调端口是 3982', { reply: '我认为应该合并' }, 'judge_fallback:no_json', '坏 JSON'],
    ['场景丙 网关回调端口是 3982', { llm: { async *stream() { throw new Error('boom') } } }, 'judge_fallback:llm_error', '模型抛错'],
    ['场景丁 网关回调端口是 3982', { reply: '{"id":1,"action":"NOOP"}', selection: {} }, 'judge_fallback:no_model', '无可用模型'],
    ['场景戊 网关回调端口是 3982', { reply: '{"id":99,"action":"NOOP","reason":"幻觉编号"}' }, 'judge_fallback:unknown_target', '越界编号'],
  ]
  for (const [text, opts, expectedError, why] of cases) {
    const base = rulesOf(text)
    assert.equal(base.action, 'ADD', `${why}：基线必须是规则 ADD`)
    const q = judgeQueue(t, db, opts)
    const result = await q.enqueue(event(text))
    assert.equal(result.action, base.action, `${why}：回落规则后动作与 rules 一致`)
    assert.equal(result.reason, base.reason, `${why}：回落规则后 reason 与 rules 一致`)
    assert.equal(result.judge?.used, false, `${why}：judge.used=false`)
    assert.equal(result.judge?.error, expectedError, `${why}：judge 错误码`)
  }
})

test('judge=llm：受保护 owner 目标 → 回落规则并记 judge_fallback:protected_target', async (t) => {
  const db = freshDb(t)
  const owner = processEvent(db, event('网关回调端口是 3982', { source: 'owner' }), auto())
  assert.equal(owner.action, 'ADD')
  assert.equal(db.prepare('SELECT source FROM nodes WHERE id=?').get(owner.id).source, 'owner')

  const logs = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP","reason":"重复"}',
    log: (line) => logs.push(line),
  })
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.judge?.used, false)
  assert.equal(result.judge?.error, 'judge_fallback:protected_target')
  // 规则口径不变：弱相似 → ADD，owner 正文一行不动
  assert.equal(result.action, 'ADD')
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(owner.id).text, '网关回调端口是 3982')
  assert.ok(logs.some((line) => line.includes('judge fallback reason=judge_fallback:protected_target')), '回落日志口径')
})

test('judge=llm：模型超时（2s AbortController）→ 回落规则，不拖死队列', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const calls = []
  const hang = {
    async *stream(opts) {
      calls.push(opts)
      // 永不产出：靠队列侧 2s 超时 abort + finish(timeout) 结束
      await new Promise((resolve) => {
        if (opts.signal?.aborted) { resolve(); return }
        opts.signal?.addEventListener('abort', () => resolve())
      })
    },
  }
  const rulesAction = decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' }).action
  const q = judgeQueue(t, db, { llm: hang })
  const started = Date.now()
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.judge?.error, 'judge_fallback:timeout')
  assert.equal(result.action, rulesAction)
  assert.ok(calls[0].signal instanceof AbortSignal, '必须把 AbortController.signal 交给模型')
  assert.ok(Date.now() - started >= 1800, '超时口径是秒级（不是立即回落）')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
})

test('judge=rules 零模型调用；judge=llm 无候选直接 ADD 也不调模型', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  let calls = 0
  const llm = { async *stream() { calls += 1; yield { type: 'text-delta', text: '{"id":1,"action":"NOOP"}' } } }
  const rulesQ = createWriteQueue({
    store: storeOf(db),
    config: auto(), // judge 缺省 = rules
    getLlm: () => llm,
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => rulesQ.dispose())
  const r = await rulesQ.enqueue(event('网关回调端口 3982'))
  assert.equal(calls, 0, 'judge=rules 时零 llm 调用')
  assert.equal(r.judge, undefined, 'rules 路径结果不带 judge 字段（旧契约不变）')
  assert.equal(r.action, 'ADD')

  // judge=llm 但库为空：无候选不花模型钱，直接按规则 ADD
  const emptyDb = freshDb(t)
  let emptyCalls = 0
  let getLlmCalls = 0
  const emptyQ = createWriteQueue({
    store: storeOf(emptyDb),
    config: judgeWrite(),
    getLlm: () => { getLlmCalls += 1; return { async *stream() { emptyCalls += 1 } } },
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => emptyQ.dispose())
  const added = await emptyQ.enqueue(event('空库里的第一条记忆'))
  assert.equal(added.action, 'ADD')
  assert.equal(emptyCalls, 0)
  assert.equal(getLlmCalls, 0)
  assert.equal(added.judge, undefined, '未调模型就没有 judge 元信息')
})

test('judge=llm：write.model 非空时作为 modelOverride', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  const calls = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP"}',
    calls,
    write: { model: 'judge-model-x' },
    selection: { provider: 'p', model: 'default-model' },
  })
  await q.enqueue(event('网关回调端口 3982'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'judge-model-x')
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].temperature, 0)
})

test('decideWrite judgeVerdict：合法裁决按既有分支执行（含影子降级）', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())

  const noop = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: old.id, action: 'NOOP' },
  })
  assert.equal(noop.action, 'NOOP')
  assert.deepEqual(noop.judge, { used: true, action: 'NOOP', targetId: old.id })

  const add = decideWrite(db, event('完全无关的第四条事实'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: null, action: 'ADD' },
  })
  assert.equal(add.action, 'ADD')
  assert.equal(add.reason, 'judge_add')
  assert.deepEqual(add.judge, { used: true, action: 'ADD', targetId: null })

  // 影子模式：裁决的动作仍按 CANDIDATE 降级，judge.action 报告语义动作（面板可解释）
  const shadow = decideWrite(db, event('回调端口 3982 只接受 POST 请求'), {
    mode: 'shadow', judgeVerdict: { ok: true, targetId: old.id, action: 'MERGE' },
  })
  assert.equal(shadow.action, 'CANDIDATE')
  assert.equal(shadow.shadowOf, 'MERGE')
  assert.equal(shadow.judge?.used, true)
  assert.equal(shadow.judge?.action, 'MERGE')
  assert.equal(shadow.beforeText, '网关回调端口是 3982')
})

test('decideWrite judgeVerdict：目标不可用/受保护/越权分区/坏裁决 → 回落规则并记 reason', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const base = () => decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' })

  const missing = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: 'n0_notthere', action: 'NOOP' },
  })
  assert.equal(missing.action, base().action)
  assert.deepEqual(missing.judge, { used: false, error: 'judge_fallback:target_unavailable' })

  const badAction = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: old.id, action: 'REVIEW' },
  })
  assert.equal(badAction.action, base().action)
  assert.equal(badAction.judge?.error, 'judge_fallback:bad_action')

  const failed = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: false, error: 'judge_fallback:timeout' },
  })
  assert.equal(failed.action, base().action)
  assert.deepEqual(failed.judge, { used: false, error: 'judge_fallback:timeout' })

  // 跨身份分区：目标在 u2，事件属于 u1 → 不可见（判定器不能越权改写别人的记忆）
  const other = processEvent(db, { ...event('别人分区的记忆'), identity: { userId: 'u2', roleId: '', workspace: 'web' } }, auto())
  const cross = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: other.id, action: 'NOOP' },
  })
  assert.equal(cross.judge?.error, 'judge_fallback:target_unavailable')

  // 受保护 owner：判定器说 MERGE 也不许改正文，回落规则走 REVIEW(protected_merge)
  const ownerText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const owner = processEvent(db, event(ownerText, { source: 'owner' }), auto())
  const prot = decideWrite(db, event(`${ownerText}功能`), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: owner.id, action: 'MERGE' },
  })
  assert.equal(prot.judge?.error, 'judge_fallback:protected_target')
  assert.equal(prot.action, 'REVIEW', '保护面由规则口径兜住')
  assert.match(prot.reason, /protected_merge/)
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(owner.id).text, ownerText)
})

test('createBackend 透传 getLlm/getSelection：直连 LocalBackend 的 judge=llm 也走判定器', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-judge-backend-'))
  const calls = []
  const backend = createBackend({ mode: 'local' }, {
    dataDir: dir,
    useWorker: false,
    log: () => {},
    config: { write: { reviewMode: 'auto', judge: 'llm', model: 'wired-model' } },
    getLlm: () => fakeLlm('{"id":1,"action":"NOOP","reason":"重复事实"}', calls),
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => backend.dispose())

  const first = await backend.write({ text: '网关回调端口是 3982', identity: IDENT, source: 'manual' })
  assert.equal(first.ok, true)
  assert.equal(first.action, 'ADD')
  const second = await backend.write({ text: '网关回调端口 3982', identity: IDENT, source: 'manual' })
  assert.equal(second.ok, true)
  assert.equal(second.action, 'NOOP', '规则会 ADD，NOOP 证明后端把模型入口透传到了队列')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'wired-model', 'write.model 经 LocalBackend 透传到判定器')
  assert.equal(Number(backend.withDb((db) => db.prepare('SELECT count(*) AS n FROM nodes').get().n)), 1)
})

test('judge Ref 解包：真实 Config 的 write.judge=llm 生效（面板开关不再是假开关）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const cfg = Config({ write: { judge: 'llm', reviewMode: 'auto', model: 'panel-model' } })
  assert.equal(cfg.write.judge.get(), 'llm', 'schema 里 judge 是 volatile Ref，必须解包后生效')
  const calls = []
  const q = createWriteQueue({
    store: storeOf(db),
    config: cfg,
    getLlm: () => fakeLlm('{"id":1,"action":"NOOP","reason":"重复"}', calls),
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => q.dispose())
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.action, 'NOOP', 'Ref 未解包时开关恒假，会回落规则 ADD')
  assert.equal(result.judge?.targetId, old.id)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'panel-model')
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


test('keeper 不接管 write job；写队列 drain 才是唯一消费者（数据丢失回归）', async (t) => {
  const db = freshDb(t)
  const store = { withDb: (fn) => fn(db), dbFile: join(tmpdir(), 'unused.db') }
  // 模拟崩溃遗留：一条 queued 写 job 已在库里，但没有内存 waiter。
  const event = { text: '崩溃遗留写入', identity: IDENT, source: 'owner', traceId: 't-crash' }
  const jobId = Number(db.prepare(`INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at)
    VALUES ('write','queued',0,?,?,?)`).run(JSON.stringify(event), now(), now()).lastInsertRowid)

  const keeper = createKeeper({ store, config: {}, pressure: () => ({ stress: false }), nowFn: () => now() })
  t.after(() => keeper.dispose())
  const r = await keeper.tick()
  assert.deepEqual(r, { ran: [], skipped: 'no_job' }, 'keeper 必须跳过 write job')
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'queued')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 0)

  const q = createWriteQueue({ store, config: { write: { reviewMode: 'auto' } } })
  t.after(() => q.dispose())
  const drained = await q.drain()
  assert.equal(drained.processed, 1)
  assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state, 'done')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, '遗留事件必须真正落库')
})

// ---------------------------------------------------------------------------
// Session Wrap 接缝（R12）：单条强制 shadow + 候选 accept 保留原始 origin
// ---------------------------------------------------------------------------

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
