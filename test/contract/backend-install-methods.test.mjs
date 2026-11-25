/**
 * installMethods 契约（P3e seam 回归）：域方法装回原型时描述符/查重/getter 不得变样。
 *
 * why 必须有：后端拆分用 `installMethods` 把三个方法域装到 LocalBackend 原型，
 * 若实现退化成 Object.assign/循环赋值，方法会变可枚举、同名域静默覆盖、getter 被压平；
 * 全量用例未必红（实测 Object.assign 注入 19 文件全绿）。这里把 seam 本身钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMethods } from '../../src/core/backend/base.js'

test('装配后方法描述符与 class 方法一致：enumerable:false / writable / configurable', () => {
  class Probe {}
  installMethods(Probe, { stats() { return 1 } })
  const d = Object.getOwnPropertyDescriptor(Probe.prototype, 'stats')
  assert.deepEqual(
    { enumerable: d.enumerable, writable: d.writable, configurable: d.configurable },
    { enumerable: false, writable: true, configurable: true },
  )
  assert.equal(Object.getOwnPropertyNames(Probe.prototype).includes('stats'), true)
  // 顺序无关：原型成员名按集合比较（装配顺序只影响自有属性枚举序，不影响可见集）。
  assert.deepEqual(Object.getOwnPropertyNames(Probe.prototype).sort(), ['constructor', 'stats'])
})

test('getter 不被压平：装后仍是 get，不变成字段/可写值', () => {
  class Probe {}
  const methods = { get ready() { return true } }
  installMethods(Probe, methods)
  const d = Object.getOwnPropertyDescriptor(Probe.prototype, 'ready')
  assert.equal(typeof d.get, 'function')
  assert.equal(d.set, undefined)
  assert.equal(new Probe().ready, true)
})

test('同名成员当场抛错（底座已有 → 域覆盖；两域同名 → 后装覆盖）', () => {
  class Probe { write() { return 'base' } }
  assert.throws(() => installMethods(Probe, { write() { return 'domain' } }), /duplicate member write/)
  class Empty {}
  assert.throws(() => installMethods(Empty, { search() {} }, { search() {} }), /duplicate member search/)
  assert.equal(Object.prototype.hasOwnProperty.call(Empty.prototype, 'search'), false, '抛错时不得半装')
})

test('constructor 键显式拒绝（不得静默跳过）', () => {
  class Probe {}
  assert.throws(() => installMethods(Probe, { constructor() {} }), /constructor not allowed/)
})

test('入参必须是类；返回入参类（可链式）', () => {
  assert.throws(() => installMethods(null, {}), /Class required/)
  assert.throws(() => installMethods({}, {}), /Class required/)
  class Probe {}
  assert.equal(installMethods(Probe, { a() {} }), Probe)
})
