/**
 * config-values 纯函数契约：Ref 解包与 volatile 合并的输入/输出边界。
 *
 * 这些函数是“配置取值单一真源”，P2a 从 src/host 搬进 src/shared；本文件先把旧行为锁住，
 * 搬家后只允许 import 路径变化，不允许断言变化（行为等价证据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bool,
  isVolatileRef,
  mergePreservingVolatile,
  num,
  value,
} from '../../src/shared/config-values.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 构造一个 cosmokit Volatile 形状的 Ref（get + 写协议），并记录写入次数。 */
function fakeRef(initial) {
  const state = { value: initial, writes: 0 }
  const ref = {
    get: () => state.value,
    [VOLATILE_WRITE]: (next) => {
      state.value = next
      state.writes += 1
    },
  }
  return { ref, state }
}

test('value：普通值原样、undefined 回退、Ref 走 get()', () => {
  assert.equal(value(7, 1), 7)
  assert.equal(value(false, true), false)
  assert.equal(value(null, 'fallback'), null)
  assert.equal(value(undefined, 'fallback'), 'fallback')
  const { ref } = fakeRef('from-ref')
  assert.equal(value(ref, 'fallback'), 'from-ref')
  const { ref: emptyRef } = fakeRef(undefined)
  assert.equal(value(emptyRef, 'fallback'), 'fallback')
})

test('bool：只认 boolean，其余回退（Ref 先解包）', () => {
  assert.equal(bool(true, false), true)
  assert.equal(bool(false, true), false)
  for (const raw of ['true', 1, 0, null, {}, []]) assert.equal(bool(raw, true), true, `raw=${JSON.stringify(raw)}`)
  const { ref } = fakeRef(false)
  assert.equal(bool(ref, true), false)
  const { ref: empty } = fakeRef(undefined)
  assert.equal(bool(empty, true), true)
  assert.equal(bool(undefined, false), false)
})

test('num：有限数/数字字符串可用，NaN/Infinity/非数回退', () => {
  assert.equal(num(5, 0), 5)
  assert.equal(num('3.5', 0), 3.5)
  assert.equal(num(-2, 0), -2)
  assert.equal(num(NaN, 9), 9)
  assert.equal(num(Infinity, 9), 9)
  assert.equal(num('-Infinity', 9), 9)
  assert.equal(num('abc', 9), 9)
  assert.equal(num(undefined, 9), 9)
  const { ref } = fakeRef('4')
  assert.equal(num(ref, 0), 4)
})

test('isVolatileRef：只认带写协议符号的对象', () => {
  const { ref } = fakeRef(1)
  assert.equal(isVolatileRef(ref), true)
  assert.equal(isVolatileRef(null), false)
  assert.equal(isVolatileRef(undefined), false)
  assert.equal(isVolatileRef({}), false)
  assert.equal(isVolatileRef({ get: () => 1 }), false)
  assert.equal(isVolatileRef(Object.create({ [VOLATILE_WRITE]: () => {} })), true)
})

test('mergePreservingVolatile：对象递归合并，数组复制，undefined 跳过', () => {
  const target = { recall: { enabled: true, maxHits: 5, levels: ['normal'] }, name: 'x' }
  const patch = { recall: { maxHits: 7, levels: ['core'], intent: undefined }, extra: 1 }
  const merged = mergePreservingVolatile(target, patch)

  assert.equal(merged, target, '必须优先原地合并并返回 target')
  assert.equal(target.recall.maxHits, 7)
  assert.equal(target.recall.enabled, true)
  assert.equal(target.extra, 1)
  assert.deepEqual(target.recall.levels, ['core'])
  assert.notEqual(target.recall.levels, patch.recall.levels, '数组必须复制，不能共享外部引用')
  assert.equal(Object.prototype.hasOwnProperty.call(target.recall, 'intent'), false, 'undefined 叶子不得写入')
  assert.equal(target.name, 'x')
})

test('mergePreservingVolatile：保留嵌套 Ref 身份，通过写协议更新值', () => {
  const { ref: enabled, state } = fakeRef(true)
  const target = { recall: { enabled }, other: 1 }
  const before = target.recall.enabled

  mergePreservingVolatile(target, { recall: { enabled: false, maxHits: 9 } })

  assert.equal(target.recall.enabled, before, 'Ref 对象身份不得被替换')
  assert.equal(isVolatileRef(target.recall.enabled), true)
  assert.equal(state.value, false, '值必须写进原 Ref')
  assert.equal(state.writes, 1)
  assert.equal(target.recall.maxHits, 9)
})

test('mergePreservingVolatile：同值不触发写协议；顶层 Ref 只写值并返回原对象', () => {
  const { ref, state } = fakeRef({ a: 1 })
  mergePreservingVolatile({ child: ref }, { child: { a: 1 } })
  assert.equal(state.writes, 0, 'JSON 相等时不应无谓写入')

  const top = fakeRef({ mode: 'a' })
  const patch = { mode: 'b' }
  const returned = mergePreservingVolatile(top.ref, patch)
  assert.equal(returned, top.ref, '顶层 Ref 必须返回同一个 Ref')
  assert.equal(top.state.writes, 1)
  assert.deepEqual(top.state.value, patch)
})

test('mergePreservingVolatile：非对象 patch 原样返回；空目标建新对象', () => {
  // 顶层标量/null/数组都是“整组替换”，按现有契约原样返回（纯搬家期不改行为）。
  for (const patch of [7, 'x', null]) {
    assert.equal(mergePreservingVolatile({ keep: 1 }, patch), patch)
  }
  const list = [1, 2]
  assert.equal(mergePreservingVolatile({ keep: 1 }, list), list)
  const built = mergePreservingVolatile(null, { a: { b: 2 } })
  assert.deepEqual(built, { a: { b: 2 } })
  assert.equal(mergePreservingVolatile(undefined, { a: 1 }).a, 1)
})
