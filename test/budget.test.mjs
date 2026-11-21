/**
 * 注入预算单测（架构书 §5.4）：意图分档是唯一表，裁剪顺序不可换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENT_TABLE, NODE_INJECT_CAP, clipForInject, forIntent, inferIntent, planBudget, trimHits,
} from '../src/core/budget.js'

test('意图推断：画图链路优先于一切；episodic 优先于 procedural', () => {
  assert.equal(inferIntent('帮我画一张网关拓扑图'), 'creative')
  assert.equal(inferIntent('这个报错怎么修，顺便出图'), 'creative')
  assert.equal(inferIntent('上次说的端口规则'), 'episodic')
  assert.equal(inferIntent('网关端口怎么配置'), 'procedural')
  assert.equal(inferIntent('今天天气不错'), 'chat')
  assert.equal(inferIntent(''), 'chat')
})

test('预算表：chat 3/1200、procedural 5/2500、episodic 4/1600、creative 0/0', () => {
  assert.deepEqual(forIntent('chat'), { intent: 'chat', maxHits: 3, charBudget: 1200 })
  assert.deepEqual(forIntent('procedural'), { intent: 'procedural', maxHits: 5, charBudget: 2500 })
  assert.deepEqual(forIntent('episodic'), { intent: 'episodic', maxHits: 4, charBudget: 1600 })
  assert.deepEqual(forIntent('creative'), { intent: 'creative', maxHits: 0, charBudget: 0 })
  assert.deepEqual(INTENT_TABLE.creative, { maxHits: 0, charBudget: 0 })
})

test('预算与用户配置取小；关掉 intentBudget 则用固定值', () => {
  assert.deepEqual(forIntent('chat', { maxHits: 2, charBudget: 800 }), { intent: 'chat', maxHits: 2, charBudget: 800 })
  // 面板默认 charBudget=1500：分档是上限，全局上限优先
  assert.deepEqual(forIntent('procedural', { maxHits: 5, charBudget: 1500 }), { intent: 'procedural', maxHits: 5, charBudget: 1500 })
  assert.deepEqual(forIntent('procedural', { maxHits: 10, charBudget: 3000 }), { intent: 'procedural', maxHits: 5, charBudget: 2500 })
  assert.deepEqual(forIntent('procedural', { intentBudget: false, maxHits: 10, charBudget: 3000 }),
    { intent: 'procedural', maxHits: 10, charBudget: 3000 })
  assert.equal(planBudget('画图').maxHits, 0)
})

test('单条截断：≤300 原样；>300 优先句读收尾并加省略号', () => {
  const short = 'a'.repeat(NODE_INJECT_CAP)
  assert.equal(clipForInject(short), short)
  const long = '第一句规则说明。' + 'x'.repeat(400)
  const clipped = clipForInject(long)
  assert.ok(clipped.length <= NODE_INJECT_CAP + 1)
  assert.ok(clipped.endsWith('…'))
  assert.ok(clipped.startsWith('第一句规则说明。'))
})

test('trimHits：按 maxHits 截条数，超字符预算先砍低分 normal', () => {
  const hits = [
    { id: 'a', text: '一'.repeat(400), level: 'core', score: 0.9 },
    { id: 'b', text: '二'.repeat(400), level: 'normal', score: 0.5 },
    { id: 'c', text: '三'.repeat(400), level: 'important', score: 0.4 },
    { id: 'd', text: '四'.repeat(50), level: 'normal', score: 0.3 },
  ]
  const r = trimHits(hits, { maxHits: 3, charBudget: 700 })
  // 每条裁到 ≤301；核心一条保留，预算超时先砍 normal，再砍 important
  assert.ok(r.hits.length < 3)
  assert.ok(r.hits.every((hit) => hit.text.length <= NODE_INJECT_CAP + 1))
  assert.ok(r.chars <= 700)
  assert.equal(r.hits[0].id, 'a')
  assert.ok(hits[0].text.length === 400, '原对象不得被改写')
})

test('trimHits：核心条目不因层级豁免而突破预算硬顶', () => {
  const hits = Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, text: '核'.repeat(290), level: 'core' }))
  const r = trimHits(hits, { maxHits: 5, charBudget: 400 })
  assert.ok(r.chars <= 400)
  assert.ok(r.hits.length <= 2)
})
