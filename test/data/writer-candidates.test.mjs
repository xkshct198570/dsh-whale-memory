// 03 判重候选扩展的表征基线（0.8.2）：先锁「六分支结论不变 + 三条反例必须 ADD」，
// 实现（并集 + 相似度闸）落地时同一文件补正例；依赖 writer-harness.mjs 的临时库与事件构造。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCandidates, processEvent } from '../../src/core/writer.js'
import { CANDIDATE_UNION_MAX, findCandidatesWithFts } from '../../src/core/writer/decide.js'
import { insertNodeRow } from '../../src/core/writer/process.js'
import { ftsCandidateRows } from '../../src/core/search.js'
import { CANDIDATE_COLUMNS } from '../../src/shared/candidate-fields.js'
import { normalize, similarity } from '../../src/core/tokenize.js'
import { buildPlan } from '../../src/core/queryplan.js'
import { event, freshDb } from './writer-harness.mjs'

/** auto 写入配置：日限放大到 1000，避免批量造数时被当日配额挡住（配额另有专用用例）。 */
const CFG = { write: { reviewMode: 'auto', dailyCap: 1000 } }

/** 真实写入入口（决策 → 落库 → 审计）。 */
function write(db, text, extra = {}) {
  return processEvent(db, event(text, extra), CFG)
}

/** 先落一条基线事实，返回 node id；落库失败即红（夹具不可靠时不许继续断言）。 */
function seed(db, text, extra = {}) {
  const r = write(db, text, extra)
  assert.equal(r.action, 'ADD', `夹具必须先落成 ADD：${text} → ${r.action}/${r.reason}`)
  return r.id
}

/** 与实现一致的口径：queryplan 词项 ∩ 候选正文（相似度闸的共享词计数）。 */
function sharedTerms(query, candidate) {
  const plan = buildPlan(query)
  const terms = [...plan.cjkTerms, ...plan.asciiTerms, ...plan.idents, ...plan.ips]
  return terms.filter((term) => candidate.includes(term))
}

test('六分支结论不变：同文/字符袋/包含/近文/疑似改写/槽位冲突/新增', (t) => {
  const db = freshDb(t)

  // 同文 → NOOP（记命中不新增）
  const baseText = '发布时必须使用 pnpm 而不是 npm'
  const baseId = seed(db, baseText)
  assert.equal(write(db, baseText).action, 'NOOP')
  // 字符袋相同、语序反转 → REVIEW word_order_ambiguous（不得 NOOP/MERGE）
  const reversed = write(db, '发布时必须使用 npm 而不是 pnpm')
  assert.equal(reversed.action, 'REVIEW')
  assert.match(reversed.reason, /word_order_ambiguous/)
  // REVIEW 落新节点但必须以 mutex 边挂住旧节点（不是 NOOP、也不是 MERGE 改写旧正文）
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2)
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(baseId).text, baseText, '旧节点正文不得被改写')

  // 包含且旧文 ≥8 字 → MERGE 同 id
  const containOld = seed(db, '门禁失败不得发布')
  const nodesBefore = Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n)
  const merged = write(db, '门禁失败不得发布且基线只在全绿后刷新')
  assert.equal(merged.action, 'MERGE')
  assert.equal(merged.id, containOld)
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), nodesBefore, 'MERGE 不新增节点')

  // 近文 0.85 / 疑似改写 0.7 且无增益 → REVIEW（不静默新增）
  const long = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新，报告归档到文档目录，交接页同步更新，灾备包当天出包'
  seed(db, long)
  const near = write(db, long.replace('当天', '当日'))
  assert.equal(near.action, 'REVIEW')
  assert.match(near.reason, /near_duplicate/)
  const para = write(db, '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新，报告存放到资料目录，交接页同步更新，灾备包当天出包')
  assert.equal(para.action, 'REVIEW')
  assert.match(para.reason, /possible_paraphrase/)

  // 槽位冲突 → SUPERSEDE；无关新事实 → ADD
  seed(db, '项目部署在测试环境 端口是 8080')
  const superseded = write(db, '项目部署在测试环境 端口是 9090')
  assert.equal(superseded.action, 'SUPERSEDE')
  assert.equal(superseded.reason, 'supersede:slot')
  const fresh = write(db, '今天午餐吃了番茄牛肉面')
  assert.equal(fresh.action, 'ADD')
  assert.equal(fresh.reason, 'new')
})

test('弱相关反例：全量门禁这套流程太慢了 → 仍 ADD（sim≈0.09，共享词仅 1）', (t) => {
  const db = freshDb(t)
  const seedText = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新'
  seed(db, seedText)
  const text = '全量门禁这套流程太慢了'
  const sim = similarity(text, seedText)
  assert.ok(sim < 0.35, `反例相似度必须低于闸门：${sim}`)
  assert.equal(sharedTerms(text, seedText).length, 1, '反例只共享一个检索词')
  const r = write(db, text)
  assert.equal(r.action, 'ADD')
  assert.equal(r.reason, 'new')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2, '弱相关句必须落库，不得降级候选')
})

test('零字面交集真同义句 → 仍 ADD（本轮不解决，限制写入 CHANGELOG）', (t) => {
  const db = freshDb(t)
  const seedText = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新'
  seed(db, seedText)
  const text = '发版之前要先把整套校验都过一遍再说'
  assert.equal(similarity(text, seedText), 0)
  assert.equal(sharedTerms(text, seedText).length, 0)
  const r = write(db, text)
  assert.equal(r.action, 'ADD', '零字面交集的同义句没有词法证据，本轮维持 ADD')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 2)
})

test('共享词不足 2 不降级：sim 0.41 但只共享「检查退出码」→ 仍 ADD', (t) => {
  const db = freshDb(t)
  const seedText = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新'
  seed(db, seedText)
  const text = '发布前要跑全量门禁检查退出码，基线等全绿后再刷新'
  assert.ok(similarity(text, seedText) >= 0.35)
  assert.ok(sharedTerms(text, seedText).length < 2)
  const r = write(db, text)
  assert.equal(r.action, 'ADD', '共享检索词不足 2 时相似度单独不足以降级候选')
})

test('findCandidates 是判定器入口：同身份最近窗口、created_at DESC', (t) => {
  const db = freshDb(t)
  const ids = []
  for (const text of ['周会改到周四下午三点', '备份文件放在数据盘目录', '渲染队列使用独立端口 8188']) {
    ids.push(seed(db, text))
  }
  // created_at 是秒粒度：同一秒内插入的顺序不可辨；夹具显式钉出不同的 created_at 再断言排序。
  ids.forEach((id, i) => db.prepare('UPDATE nodes SET created_at=? WHERE id=?').run(100 + i, id))
  const rows = findCandidates(db, event('任意'))
  assert.deepEqual(rows.map((row) => row.id), [...ids].reverse(), '最近窗口按 created_at DESC')
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['id', 'invalid_at', 'level', 'memory_type', 'source', 'text', 'valid_at'],
      '候选字段集必须含双时态（并集沿用同字段集）',
    )
  }
})

test('正例：sim 0.68 且共享 3 词 → 只产 paraphrase_suspect 候选（不新增节点、不改正文）', (t) => {
  const db = freshDb(t)
  const seedText = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新'
  seed(db, seedText)
  const text = '发布前跑全量门禁并检查退出码这个流程，基线只在全绿后刷新'
  assert.ok(similarity(text, seedText) >= 0.35 && similarity(text, seedText) < 0.7, '正例落在 ADD 与疑似改写之间')
  assert.ok(sharedTerms(text, seedText).length >= 2)
  const r = write(db, text)
  assert.equal(r.action, 'CANDIDATE')
  assert.equal(r.reason, 'paraphrase_suspect')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, '候选不落 nodes')
  assert.equal(db.prepare('SELECT text FROM nodes').get().text, normalize(seedText), '旧节点正文不得被改写')
  const audit = db.prepare('SELECT action,reason,mode FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(audit.action, 'CANDIDATE')
  assert.equal(audit.mode, 'auto', 'auto 模式下也必须是候选而不是自动合并')
  assert.match(audit.reason, /paraphrase_suspect/)
})

test('正例二：sim 0.36 但共享「跑全量门/必须/发布前」3 词 → 候选（闸门不是只看相似度）', (t) => {
  const db = freshDb(t)
  const seedText = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新'
  seed(db, seedText)
  const text = '跑全量门禁并看退出码，基线全绿才刷新，这必须在发布前'
  const sim = similarity(text, seedText)
  assert.ok(sim >= 0.35 && sim < 0.7)
  const r = write(db, text)
  assert.equal(r.action, 'CANDIDATE')
  assert.equal(r.reason, 'paraphrase_suspect')
})

test('03 并集：FTS 补回最近窗口外的旧候选（双时态同字段集），judge 入口仍只吃最近窗口', (t) => {
  const db = freshDb(t)
  const targetText = '灾备包恢复演练每季度一次，演练记录归档到备份目录'
  const target = insertNodeRow(db, event(targetText), targetText, {
    ts: 1, validAt: 1, source: 'self', origin: 'unit', level: 'normal', memoryType: 'semantic', layer: 'semantic', expiredAt: null,
  })
  db.prepare('UPDATE nodes SET invalid_at=1 WHERE id=?').run(target)
  for (let i = 0; i < 305; i += 1) {
    const text = `填充样本 ${i} 号：值班表的轮换顺序与交接清单`
    insertNodeRow(db, event(text), text, {
      ts: 1000 + i, validAt: 1000 + i, source: 'self', origin: 'unit', level: 'normal', memoryType: 'semantic', layer: 'semantic', expiredAt: null,
    })
  }

  const recent = findCandidates(db, event(targetText))
  assert.equal(recent.length, 300, '判定器入口固定最近 300')
  assert.ok(!recent.some((row) => row.id === target), '目标已滑出最近窗口：judge 不该看见它')

  const union = findCandidatesWithFts(db, event(targetText))
  assert.ok(union.length <= CANDIDATE_UNION_MAX, `并集不得超过 ${CANDIDATE_UNION_MAX}`)
  assert.equal(new Set(union.map((row) => row.id)).size, union.length, '按 id 去重')
  assert.deepEqual(union.slice(0, recent.length).map((row) => row.id), recent.map((row) => row.id), '最近在前、顺序不变')
  const hit = union.find((row) => row.id === target)
  assert.ok(hit, 'FTS 必须把窗口外的同文候选补回并集')
  assert.deepEqual(Object.keys(hit).sort(), [...CANDIDATE_COLUMNS].sort(), 'FTS 候选必须是同一字段集')
  assert.equal(hit.invalid_at, 1, '并集必须带双时态（否则已失效旧事实会被当恒重叠）')
})

test('03 FTS 候选：身份分区过滤生效，跨身份旧文不进并集', (t) => {
  const db = freshDb(t)
  const text = '灾备包恢复演练每季度一次，演练记录归档到备份目录'
  insertNodeRow(db, event(text, { identity: { userId: 'other', roleId: '', workspace: 'web' } }), text, {
    ts: 1, validAt: 1, source: 'self', origin: 'unit', level: 'normal', memoryType: 'semantic', layer: 'semantic', expiredAt: null,
  })
  const rows = ftsCandidateRows(db, { query: text, identity: event(text).identity, limit: 12 })
  assert.equal(rows.length, 0, '跨身份候选不得出现在并集')
})
