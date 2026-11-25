/**
 * Session Wrap 对外返回契约：installSessionWrap 必须暴露完整的 11 个键与函数。
 *
 * P2c 拆分后门面仍返回同一组方法；本测试锁住契约，防止再次拆分时漏掉 execute/onTrigger 等键。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSessionWrap } from '../../src/host/session-wrap.js'

test('返回契约：installSessionWrap 暴露 13 个键（含 sessions/pumpQueue/execute/onTrigger/sweepStorage）', () => {
  const wrap = installSessionWrap({}, { backend: null, config: {} })
  assert.equal(wrap.supported, false)
  const expected = [
    'onTrigger', 'manual', 'status', 'sessions', 'report', 'sweepSpool', 'sweepStorage', 'pumpQueue',
    'reconcile', 'execute', 'canAutoTrigger', 'supported', 'dispose',
  ]
  assert.deepEqual(Object.keys(wrap).sort(), expected.sort())
  for (const key of ['onTrigger', 'manual', 'status', 'report', 'sweepSpool', 'sweepStorage', 'reconcile', 'execute', 'canAutoTrigger', 'dispose']) {
    assert.equal(typeof wrap[key], 'function', `${key} 必须是函数`)
  }
})
