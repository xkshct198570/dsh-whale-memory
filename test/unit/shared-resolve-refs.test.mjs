/**
 * resolveRefsDeep 契约：把 Ref 树解成正本值，对象/数组递归，标量原样。
 *
 * routes 回显与 config-migration 写值共用该实现，本文件锁行为边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRefsDeep } from '../../src/shared/resolve-refs.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function fakeRef(initial) {
  return { get: () => initial, [VOLATILE_WRITE]: () => {} }
}

test('标量与数组：标量原样，数组递归且返回新数组', () => {
  for (const scalar of [null, undefined, 0, 'x', true]) assert.equal(resolveRefsDeep(scalar), scalar)
  const source = [1, fakeRef('a'), { nested: fakeRef(2) }]
  const out = resolveRefsDeep(source)
  assert.deepEqual(out, [1, 'a', { nested: 2 }])
  assert.notEqual(out, source)
  assert.notEqual(out[2], source[2])
})

test('对象递归：Ref 叶子解包，普通对象返回新对象，键序保留', () => {
  const source = { a: fakeRef(1), b: { c: fakeRef({ deep: true }), d: 2 }, e: null }
  const out = resolveRefsDeep(source)
  assert.deepEqual(out, { a: 1, b: { c: { deep: true }, d: 2 }, e: null })
  assert.notEqual(out, source)
  assert.notEqual(out.b, source.b)
})

test('Ref 指向对象/数组时继续递归解包', () => {
  assert.deepEqual(resolveRefsDeep({ x: fakeRef({ y: fakeRef([1, fakeRef(2)]) }) }), { x: { y: [1, 2] } })
  assert.equal(resolveRefsDeep(fakeRef(3)), 3)
})
