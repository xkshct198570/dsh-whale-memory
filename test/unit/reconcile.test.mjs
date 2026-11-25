/**
 * S3 整合纯函数回归：提示词/容错解析/决策硬判据（op 白名单、target 必须是邻居、
 * 证据逐字命中、改写文本去主观前缀/相对指代/超长、同候选多决策拒绝）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECONCILE_OPS, buildReconcilePrompt, parseReconcileOutput, validateDecisions,
} from '../../src/core/reconcile.js'

const ITEMS = [
  { kind: 'fact', text: '生产库端口改为 4090', evidence: '端口改为 4090' },
  { kind: 'lesson', text: '收尾前必须先备份', evidence: '先备份' },
]
const NEIGHBORS = [
  { id: 'n1', itemIndex: 0, text: '生产库端口为 3080，改端口要同步网关', level: 'important', updated_at: 2 },
  { id: 'n2', itemIndex: 0, text: '生产库连接池上限 200', level: 'normal', updated_at: 1 },
]

test('buildReconcilePrompt：候选与各自邻居分组，op 白名单与硬规则写明', () => {
  const prompt = buildReconcilePrompt(ITEMS, NEIGHBORS)
  assert.match(prompt, /候选 0/)
  assert.match(prompt, /邻居 n1/)
  for (const op of RECONCILE_OPS) assert.match(prompt, new RegExp(op))
  assert.match(prompt, /≤200 字/)
})

test('parseReconcileOutput：围栏/前后废话容错；形状错返回 bad_json/bad_shape', () => {
  const wrapped = '说明\n```json\n{"decisions":[{"item":0,"op":"update","targetId":"n1","afterText":"端口改为 4090"}]}\n```'
  const ok = parseReconcileOutput(wrapped)
  assert.equal(ok.ok, true)
  assert.equal(ok.decisions[0].op, 'UPDATE')
  assert.equal(parseReconcileOutput('not json').error, 'bad_json')
  assert.equal(parseReconcileOutput('{"decisions":"x"}').error, 'bad_shape')
})

test('validateDecisions：op 白名单 / target 必须是邻居 / evidence 逐字命中', () => {
  const decided = [
    { item: 0, op: 'UPDATE', targetId: 'n1', afterText: '生产库端口改为 4090，同步网关', reason: '更新', evidence: '端口' },
    { item: 0, op: 'DROP', targetId: 'n1', afterText: 'x', reason: '', evidence: '' },
    { item: 0, op: 'MERGE', targetId: 'n9', afterText: '端口 4090', reason: '', evidence: '' },
    { item: 1, op: 'ADD', targetId: '', afterText: '收尾前必须先备份', reason: '', evidence: '备份' },
    { item: 1, op: 'MERGE', targetId: 'n1', afterText: '收尾前必须先备份', reason: '', evidence: '这段原文不在素材里' },
  ]
  const { valid, rejected } = validateDecisions(decided, { items: ITEMS, neighbors: NEIGHBORS })
  assert.equal(valid.length, 2)
  assert.deepEqual(valid.map((row) => row.op), ['UPDATE', 'ADD'])
  const errors = rejected.map((row) => row.error).sort()
  assert.deepEqual(errors, ['bad_op', 'evidence_mismatch', 'target_not_neighbor'])
})

test('validateDecisions：主观前缀/相对指代/超长 afterText 拒绝；ARCHIVE 只认 target', () => {
  const base = { item: 0, targetId: 'n2', reason: '作废' }
  const cases = [
    { ...base, op: 'ARCHIVE', afterText: '', evidence: '' },
    { ...base, op: 'UPDATE', afterText: '大概端口是 4090', evidence: '' },
    { ...base, op: 'UPDATE', afterText: '这次端口改成 4090', evidence: '' },
    { ...base, op: 'UPDATE', afterText: '长'.repeat(201), evidence: '' },
  ]
  const { valid, rejected } = validateDecisions(cases, { items: ITEMS, neighbors: NEIGHBORS })
  assert.equal(valid.length, 1)
  assert.equal(valid[0].op, 'ARCHIVE')
  assert.deepEqual(rejected.map((row) => row.error).sort(), ['text_hedge', 'text_relative', 'text_too_long'])
})

test('S4：跨候选 MERGE（mergeItems）合成为 1 条；校正建议白名单', () => {
  const items = [
    { kind: 'lesson', text: '收尾前先备份甲', evidence: '先备份' },
    { kind: 'lesson', text: '收尾前先备份乙', evidence: '备份乙' },
    { kind: 'lesson', text: '收尾前先备份丙', evidence: '备份丙' },
  ]
  const decisions = [
    { item: 0, op: 'MERGE', targetId: '', mergeItems: [1, 2], afterText: '收尾前必须先备份', reason: '同主题', evidence: '备份乙', level: 'important', memoryType: 'procedural', tags: ['运维'] },
    { item: 0, op: 'MERGE', targetId: '', mergeItems: [1], afterText: '端口 4090', reason: '', evidence: '', level: 'bad-level' },
  ]
  const { valid, rejected } = validateDecisions(decisions, { items, neighbors: [] })
  assert.equal(valid.length, 1)
  assert.deepEqual(valid[0].mergeItems, [1, 2])
  assert.equal(valid[0].level, 'important')
  assert.equal(rejected[0].error, 'bad_level')
  // 合并没有 target 时必须有 mergeItems。
  const noMerge = validateDecisions([{ item: 0, op: 'MERGE', targetId: '', mergeItems: [], afterText: '收尾前必须先备份', evidence: '' }], { items, neighbors: [] })
  assert.equal(noMerge.rejected[0].error, 'target_required')
})
