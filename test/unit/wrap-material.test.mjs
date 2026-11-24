import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  materialHash, materialText, normalizeMaterial, trimMaterial,
} from '../../src/core/wrap-material.js'

test('normalizeMaterial：过滤非法 role/非字符串/空文本，trim，turn/seq 缺省 0', () => {
  const got = normalizeMaterial({
    turns: [
      { role: 'user', text: '  你好  ', turn: 1, seq: 2 },
      { role: 'assistant', text: '收到' },
      { role: 'system', text: '带外提示' },
      { role: 'tool', text: '工具输出' },
      { role: 'user', text: '   ' },
      { role: 'assistant', text: 42 },
      null,
      { text: '没有角色' },
      'plain string',
    ],
    summary: '被忽略的旧摘要字段',
  })
  assert.equal(got.turns.length, 2)
  assert.deepEqual(got.turns[0], { role: 'user', text: '你好', turn: 1, seq: 2 })
  assert.deepEqual(got.turns[1], { role: 'assistant', text: '收到', turn: 0, seq: 0 })
  assert.equal(got.chars, 4)
})

test('normalizeMaterial：chars 按码点计（代理对算 1），缺省/非法入参不抛', () => {
  assert.equal(normalizeMaterial({ turns: [{ role: 'user', text: '🙂' }] }).chars, 1)
  assert.equal(normalizeMaterial({ turns: [{ role: 'user', text: '中🙂a' }] }).chars, 3)
  assert.deepEqual(normalizeMaterial(), { turns: [], chars: 0 })
  assert.deepEqual(normalizeMaterial({ turns: 'not-array' }), { turns: [], chars: 0 })
  assert.deepEqual(normalizeMaterial(null), { turns: [], chars: 0 })
})

test('materialText：按出现顺序编号 [uN]/[aN]，行以 \\n 连接，空材料为空串', () => {
  const text = materialText({
    turns: [
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: '答一' },
      { role: 'user', text: '第二句' },
      { role: 'assistant', text: '答二' },
    ],
  })
  assert.equal(text, '[u1] 第一句\n[a1] 答一\n[u2] 第二句\n[a2] 答二')
  assert.equal(materialText({}), '')
  assert.equal(materialText({ turns: [{ role: 'user', text: '  去掉空白  ' }] }), '[u1] 去掉空白')
})

test('materialHash：sha256 前 16 位小写 hex、稳定、空材料为空串', () => {
  assert.equal(materialHash({ turns: [{ role: 'user', text: 'abc' }] }), 'b9d21743dce49700')
  const material = { turns: [{ role: 'user', text: '收尾吧' }, { role: 'assistant', text: '好' }] }
  const hash = materialHash(material)
  assert.match(hash, /^[0-9a-f]{16}$/)
  assert.equal(materialHash(structuredClone(material)), hash)
  assert.notEqual(materialHash({ turns: [{ role: 'user', text: '收尾' }] }), hash)
  assert.equal(materialHash({}), '')
  assert.equal(materialHash({ turns: [{ role: 'user', text: '   ' }] }), '')
})

test('trimMaterial：maxTurns 按整轮留最近 N 条', () => {
  const turns = Array.from({ length: 25 }, (_, i) => ({ role: 'user', text: `t${i}` }))
  const kept = trimMaterial(turns, { maxTurns: 20 })
  assert.equal(kept.length, 20)
  assert.equal(kept[0].text, 't5')
  assert.equal(kept[19].text, 't24')
  assert.equal(trimMaterial(turns).length, 20)
})

test('trimMaterial：maxChars 从最旧整条丢弃，绝不切半条', () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ role: 'user', text: String(i).repeat(10) }))
  const kept = trimMaterial(turns, { maxTurns: 20, maxChars: 25 })
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((t) => t.text), ['3333333333', '4444444444'])
  const chars = kept.reduce((sum, t) => sum + Array.from(t.text).length, 0)
  assert.ok(chars <= 25)
  assert.equal(trimMaterial(turns, { maxChars: 30 }).length, 3)
})

test('trimMaterial：单条超预算也保留最后一条', () => {
  const turns = [{ role: 'user', text: 'a'.repeat(50) }, { role: 'assistant', text: 'b'.repeat(50) }]
  const kept = trimMaterial(turns, { maxChars: 10 })
  assert.equal(kept.length, 1)
  assert.equal(kept[0].text, 'b'.repeat(50))
  assert.equal(trimMaterial([], { maxChars: 10 }).length, 0)
})

test('trimMaterial：不修改入参、返回新数组与新元素', () => {
  const turns = [
    { role: 'user', text: '甲'.repeat(20), turn: 1 },
    { role: 'assistant', text: '乙'.repeat(20), turn: 2 },
  ]
  const snapshot = structuredClone(turns)
  const kept = trimMaterial(turns, { maxChars: 20 })
  assert.deepEqual(turns, snapshot)
  assert.notEqual(kept, turns)
  assert.equal(kept.length, 1)
  assert.notEqual(kept[0], turns[1])
  assert.deepEqual(kept[0], turns[1])
})
