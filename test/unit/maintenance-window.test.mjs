import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileSuppressWindows, inSuppressWindow, localDayKey } from '../../src/shared/maintenance-window.js'

const at = (h, m = 0) => new Date(2026, 10, 27, h, m, 0)

test('compile：合法窗口/跨午夜/坏值分离（坏值不拖垮整个列表）', () => {
  const got = compileSuppressWindows(['00:00-08:00', '12:30-13:30', '23:00-07:00', 'bad', '24:00-01:00', '09:00-09:00', ' 10:00 - 11:00 '])
  assert.equal(got.windows.length, 4)
  assert.deepEqual(got.invalid, ['bad', '24:00-01:00', '09:00-09:00'])
  assert.deepEqual(got.windows[2], { start: 23 * 60, end: 7 * 60, text: '23:00-07:00' })
  assert.equal(got.windows[3].text, '10:00 - 11:00', '两侧空白合法')
  // 非数组容忍：未配置/字符串都不得抛。
  assert.deepEqual(compileSuppressWindows(undefined), { windows: [], invalid: [] })
  assert.equal(compileSuppressWindows('00:00-08:00').windows.length, 1)
  assert.deepEqual(compileSuppressWindows(null), { windows: [], invalid: [] })
})

test('inSuppressWindow：普通窗口左闭右开；跨午夜两侧都命中，边界不含 end', () => {
  const plain = compileSuppressWindows(['00:00-08:00']).windows
  assert.equal(inSuppressWindow(plain, at(0, 0)), true, '00:00 命中')
  assert.equal(inSuppressWindow(plain, at(7, 59)), true)
  assert.equal(inSuppressWindow(plain, at(8, 0)), false, 'end 不含')
  assert.equal(inSuppressWindow(plain, at(12, 0)), false)

  const cross = compileSuppressWindows(['23:00-07:00']).windows
  assert.equal(inSuppressWindow(cross, at(23, 0)), true, '跨午夜起点命中')
  assert.equal(inSuppressWindow(cross, at(6, 59)), true, '跨午夜终点前命中')
  assert.equal(inSuppressWindow(cross, at(7, 0)), false, '跨午夜 end 不含')
  assert.equal(inSuppressWindow(cross, at(12, 0)), false)
  assert.equal(inSuppressWindow([], at(12, 0)), false)
  assert.equal(inSuppressWindow(compileSuppressWindows(['bad']).windows, at(3, 0)), false)
})

test('localDayKey：本地自然日（不是 UTC）', () => {
  assert.equal(localDayKey(at(0, 5)), '2026-11-27')
  assert.equal(localDayKey(at(23, 55)), '2026-11-27')
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01')
})
