/**
 * S1 写入闸/判重夹具（架构书 §7.1/§7.2）：真 SQLite + processEvent，断言真实 nodes/writes 产物。
 *
 * 口径：
 * - 价值闸：D1–D3 active、T1–T5/S1–S2 REJECT（无正文）、A1–A2 CANDIDATE；
 * - 判重：同文 NOOP、字符袋相同→REVIEW、包含→MERGE、近文/疑似改写→CANDIDATE；
 * - 回退：ingest.mode=review / __forceShadow 全部影候选，不落 active；
 * - identity 缺失必须 REJECT 且不写正文；reviewToCandidate 把 REVIEW 转审核。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../../src/core/db.js'
import { contentHash } from '../../src/core/tokenize.js'
import { processEvent } from '../../src/core/writer.js'
import { DURABILITY, classifyDurability, detectAmbiguity } from '../../src/shared/ingest-policy.js'

const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }
const AUTO = { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true, confidence: 0.9 }

function freshDb(t) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-ingest-')))
  t.after(() => closeDb(db))
  return db
}

function event(text, extra = {}) {
  return {
    traceId: 'tr-ingest', source: 'self', identity: IDENT, text, tags: [], origin: 'session-wrap', ...extra,
  }
}

function ingest(db, text, extra = {}, policy = AUTO) {
  return processEvent(db, event(text, { ...extra, __ingest: policy }), { write: { reviewMode: 'shadow' } })
}

const writeOf = (db, action) => db.prepare('SELECT * FROM writes WHERE action=? ORDER BY id DESC LIMIT 1').get(action)
const nodes = (db) => db.prepare('SELECT * FROM nodes ORDER BY created_at').all()

test('classifyDurability：§7.1 十二条夹具分类正确（顺序 stale→task→歧义→durable→uncertain）', () => {
  const fixtures = {
    D1: 'flex-column 布局中滚动子项（如 nav）必须显式设置 flex-shrink:0 和最小高度/盒高；验收要逐页签真机可见可点，不能只测组件函数或文本。',
    D2: '记忆入库应服务于记录、避免再犯和提升下次表现，不应让默认人工审批成为阻塞。',
    D3: 'LLM 流式收集不能同时累加 text-delta 和 block-end，否则 JSON 拼两遍；预算 1200 会被推理思考吃光。',
    T1: '修改记忆插件中“候选必须经我同意”的机制，将其视为功能缺失或设计错误并重新设计。',
    T2: '审查记忆插件实现，明确是否存在缺漏或多余环节，并判断哪些环节应增删。',
    T3: '对比当前记忆插件与 GitHub 来源插件，判断更合适的改进方案。',
    T4: '下个会话先整合本次需求与未完成项，编写架构书和施工清单，再更新相关文件保证交接。',
    T5: '编写下个会话开场指令，确保工程质量。',
    S1: '0.7.3 live 重启后六页签和反思修复均通过真机验证；收尾候选为 0，记忆库 780 节点/active 720。',
    S2: '交接件已就位：架构书、S0–S5 施工计划、下个会话开场指令、四件套已更新；灾备包与 bundle 已列明。',
    A1: '刚才那个方案可能有问题，先看看。',
    A2: '我觉得以后发布前应该多测一轮。',
  }
  const expected = {
    D1: DURABILITY.DURABLE, D2: DURABILITY.DURABLE, D3: DURABILITY.DURABLE,
    T1: DURABILITY.TASK, T2: DURABILITY.TASK, T3: DURABILITY.TASK,
    T4: DURABILITY.TASK, T5: DURABILITY.TASK,
    S1: DURABILITY.STALE, S2: DURABILITY.STALE,
    A1: DURABILITY.UNCERTAIN, A2: DURABILITY.UNCERTAIN,
  }
  for (const [id, text] of Object.entries(fixtures)) {
    assert.equal(classifyDurability(text), expected[id], `${id} 分类错误`)
  }
  // 歧义只返回原因，不改写正文
  assert.deepEqual(detectAmbiguity(fixtures.A1).reasons, ['deictic', 'subjective'])
  assert.deepEqual(detectAmbiguity(fixtures.A2).reasons, ['subjective'])
  assert.deepEqual(detectAmbiguity(fixtures.D1), { ambiguous: false, reasons: [] })
})

test('§7.1 真产物：D1–D3 active；T1–T5/S1–S2 REJECT 无正文；A1–A2 CANDIDATE 留正文', (t) => {
  const db = freshDb(t)
  const durable = [
    'flex-column 布局中滚动子项（如 nav）必须显式设置 flex-shrink:0 和最小高度/盒高；验收要逐页签真机可见可点，不能只测组件函数或文本。',
    '记忆入库应服务于记录、避免再犯和提升下次表现，不应让默认人工审批成为阻塞。',
    'LLM 流式收集不能同时累加 text-delta 和 block-end，否则 JSON 拼两遍；预算 1200 会被推理思考吃光。',
  ]
  for (const text of durable) {
    const res = ingest(db, text)
    assert.equal(res.action, 'ADD', text.slice(0, 12))
  }
  assert.equal(nodes(db).filter((row) => row.status === 'active').length, 3)

  const rejected = [
    '修改记忆插件中“候选必须经我同意”的机制，将其视为功能缺失或设计错误并重新设计。',
    '审查记忆插件实现，明确是否存在缺漏或多余环节，并判断哪些环节应增删。',
    '对比当前记忆插件与 GitHub 来源插件，判断更合适的改进方案。',
    '下个会话先整合本次需求与未完成项，编写架构书和施工清单，再更新相关文件保证交接。',
    '编写下个会话开场指令，确保工程质量。',
    '0.7.3 live 重启后六页签和反思修复均通过真机验证；收尾候选为 0，记忆库 780 节点/active 720。',
    '交接件已就位：架构书、S0–S5 施工计划、下个会话开场指令、四件套已更新；灾备包与 bundle 已列明。',
  ]
  for (const text of rejected) {
    const res = ingest(db, text)
    assert.equal(res.action, 'REJECT', text.slice(0, 12))
    const row = writeOf(db, 'REJECT')
    assert.equal(row.before_text, null, '价值闸 REJECT 不得保存 before_text')
    assert.equal(row.after_text, null, '价值闸 REJECT 不得保存 after_text')
  }
  assert.equal(nodes(db).length, 3, 'REJECT 一律不进 nodes')

  const review = ['刚才那个方案可能有问题，先看看。', '我觉得以后发布前应该多测一轮。']
  for (const text of review) {
    const res = ingest(db, text)
    assert.equal(res.action, 'CANDIDATE')
    const row = writeOf(db, 'CANDIDATE')
    assert.equal(row.before_text, null)
    assert.ok(row.after_text && row.after_text.includes(text.slice(0, 6)), '候选必须留正文作审核证据（NFKC 归一后）')
    assert.match(row.reason, /^gate:/)
    assert.equal(JSON.parse(row.payload).shadowOf, null, '闸产候选不预设落库动作')
  }
  assert.equal(nodes(db).length, 3)
})

test('身份闸：缺 userId/workspace 一律 REJECT identity_required 且无正文', (t) => {
  const db = freshDb(t)
  for (const identity of [{ userId: '', roleId: '', workspace: 'web' }, { userId: 'u1', roleId: '', workspace: '' }]) {
    const res = processEvent(db, event('动库前必须先备份', { identity, __ingest: AUTO }), { write: { reviewMode: 'auto' } })
    assert.equal(res.action, 'REJECT')
    assert.equal(res.reason, 'identity_required')
  }
  const rows = db.prepare("SELECT before_text,after_text FROM writes WHERE reason='identity_required'").all()
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.before_text, null)
    assert.equal(row.after_text, null)
  }
  assert.equal(nodes(db).length, 0)
})

test('低置信/任务句可配：confidence<minConfidence 转审核；dropTaskInstructions=false 时 task 转审核', (t) => {
  const db = freshDb(t)
  const low = ingest(db, '动库前必须先备份', { confidence: 0.3 }, { ...AUTO, confidence: 0.3 })
  assert.equal(low.action, 'CANDIDATE')
  assert.match(writeOf(db, 'CANDIDATE').reason, /gate:low_confidence/)

  const task = ingest(db, '先备份再改代码', {}, { ...AUTO, dropTaskInstructions: false })
  assert.equal(task.action, 'CANDIDATE')
  assert.match(writeOf(db, 'CANDIDATE').reason, /gate:task_review/)
})

test('回退：ingest.mode=review 与 __forceShadow 都只产影候选，不落 active', (t) => {
  const db = freshDb(t)
  const text = '动库前必须先备份并校验备份文件'
  const review = ingest(db, text, {}, { ...AUTO, mode: 'review' })
  assert.equal(review.action, 'CANDIDATE')
  assert.equal(JSON.parse(writeOf(db, 'CANDIDATE').payload).shadowOf, 'ADD')
  assert.equal(JSON.parse(writeOf(db, 'CANDIDATE').payload).level, 'normal')

  const forced = processEvent(db, event('发布前必须跑全量门禁', { __forceShadow: true, __ingest: AUTO }), { write: { reviewMode: 'auto' } })
  assert.equal(forced.action, 'CANDIDATE')
  assert.equal(nodes(db).length, 0, '回退路径不得落节点')
})

test('判重：同文 NOOP；字符袋相同（语序/极性）→ CANDIDATE word_order_ambiguous', (t) => {
  const db = freshDb(t)
  const base = '发布时必须使用 pnpm 而不是 npm'
  assert.equal(ingest(db, base).action, 'ADD')
  const again = ingest(db, base)
  assert.equal(again.action, 'NOOP')
  const node = nodes(db)[0]
  assert.equal(db.prepare('SELECT hits FROM nodes WHERE id=?').get(node.id).hits, 1, 'NOOP 必须记一次命中')

  const reversed = ingest(db, '发布时必须使用 npm 而不是 pnpm')
  assert.equal(reversed.action, 'CANDIDATE', '语序/极性反转不得 NOOP、不得 MERGE')
  const row = writeOf(db, 'CANDIDATE')
  assert.match(row.reason, /word_order_ambiguous/)
  assert.equal(JSON.parse(row.payload).shadowOf, 'REVIEW')
  assert.equal(nodes(db).length, 1)
})

test('判重：包含且旧文≥8 字 → MERGE 同 id + evolution（不受 0.85 限制）；保护面转审核', (t) => {
  const db = freshDb(t)
  const oldText = '门禁失败不得发布'
  const first = ingest(db, oldText)
  assert.equal(first.action, 'ADD')
  const longer = '门禁失败不得发布且基线只在全绿后刷新'
  const merged = ingest(db, longer)
  assert.equal(merged.action, 'MERGE')
  assert.equal(merged.id, first.id, '包含合并必须同 node')
  assert.equal(nodes(db).length, 1)
  assert.equal(nodes(db)[0].text, longer)
  const evo = db.prepare("SELECT * FROM evolution WHERE from_id=? AND field='text'").get(first.id)
  assert.ok(evo, 'MERGE 改写正文必须留 evolution')
  assert.equal(evo.old_value, oldText)
  assert.equal(evo.new_value, longer)

  // 保护面：owner 目标同样包含关系也不得自动改写
  const owner = ingest(db, '动库前必须先备份是铁律', { source: 'owner' })
  assert.equal(owner.action, 'ADD')
  const protectedMerge = ingest(db, '动库前必须先备份是铁律，并且必须校验备份可恢复')
  assert.equal(protectedMerge.action, 'CANDIDATE')
  assert.match(writeOf(db, 'CANDIDATE').reason, /protected_merge/)
})

test('判重：wrap 自产 source=self 后续相似写入可 MERGE（不被 owner 保护面锁死）', (t) => {
  const db = freshDb(t)
  const first = ingest(db, '动库前必须先备份并校验')
  assert.equal(first.action, 'ADD')
  assert.equal(nodes(db)[0].source, 'self', 'wrap 自产来源必须是 self')
  const merged = ingest(db, '动库前必须先备份并校验，且备份文件要能打开')
  assert.equal(merged.action, 'MERGE')
  assert.equal(merged.id, first.id)
})

test('判重：近文 0.85/0.7 无增益 → CANDIDATE（shadowOf=REVIEW），不得静默新增', (t) => {
  const db = freshDb(t)
  const long = '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新，报告归档到文档目录，交接页同步更新，灾备包当天出包'
  assert.equal(ingest(db, long).action, 'ADD')
  const near = ingest(db, long.replace('当天', '当日'))
  assert.equal(near.action, 'CANDIDATE')
  assert.match(writeOf(db, 'CANDIDATE').reason, /near_duplicate/)
  assert.equal(nodes(db).length, 1, '近文不得新增节点')

  const para = ingest(db, '发布前必须跑全量门禁并检查退出码，基线只在全绿后刷新，报告存放到资料目录，交接页同步更新，灾备包当天出包')
  assert.equal(para.action, 'CANDIDATE')
  assert.match(writeOf(db, 'CANDIDATE').reason, /possible_paraphrase/)
  assert.equal(nodes(db).length, 1)
})

test('reviewToCandidate：auto 下 REVIEW 转 CANDIDATE，payload.shadowOf=REVIEW', (t) => {
  const db = freshDb(t)
  // 规则 REVIEW 需要“保护面 + 相似合并”；这里用 owner 目标触发 protected_merge。
  const old = ingest(db, '动库前必须先备份是铁律', { source: 'owner' })
  assert.equal(old.action, 'ADD')
  const res = ingest(db, '动库前必须先备份是铁律，且每周演练恢复')
  assert.equal(res.action, 'CANDIDATE')
  const row = writeOf(db, 'CANDIDATE')
  assert.equal(JSON.parse(row.payload).shadowOf, 'REVIEW', '接受时必须按 REVIEW 建互斥边')
  assert.match(row.reason, /^review:REVIEW/)
})

test('非 ingest 调用（面板/导入）不受价值闸影响，行为与既有写入一致', (t) => {
  const db = freshDb(t)
  const res = processEvent(db, event('先备份再改代码', { __ingest: undefined }), { write: { reviewMode: 'auto' } })
  assert.equal(res.action, 'ADD', '没有 ingestPolicy 时不得套用价值闸')
  assert.ok(db.prepare('SELECT 1 FROM nodes WHERE text_hash=?').get(contentHash('先备份再改代码')))
})
