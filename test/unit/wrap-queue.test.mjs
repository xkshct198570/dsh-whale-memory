/**
 * S1b 队列代数回归：位次/同会话≤1/全局上限/超时与销毁清理/幂等移除。
 * 纯内存，不碰 DB/keeper（全链路由 hook/session-wrap 用例覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWrapQueue } from '../../src/core/wrap-queue.js'

test('位次按 FIFO：入队返回 1..N，出队后前移', () => {
  const q = createWrapQueue({ maxQueued: 3 })
  assert.deepEqual(q.enqueue({ sessionId: 's1', runId: 1, materialHash: 'h1' }), { ok: true, position: 1 })
  assert.deepEqual(q.enqueue({ sessionId: 's2', runId: 2, materialHash: 'h2' }), { ok: true, position: 2 })
  assert.equal(q.positionOf(2), 2)
  assert.equal(q.head().runId, 1)
  q.removeByRun(1)
  assert.equal(q.positionOf(2), 1)
  assert.equal(q.size(), 1)
})

test('同会话恒 ≤1：同会话第二条直接 session_queue_full，不占队列', () => {
  const q = createWrapQueue({ maxQueued: 8 })
  q.enqueue({ sessionId: 's1', runId: 1, materialHash: 'h1' })
  const dup = q.enqueue({ sessionId: 's1', runId: 2, materialHash: 'h2' })
  assert.deepEqual(dup, { ok: false, reason: 'session_queue_full' })
  assert.equal(q.size(), 1)
  assert.equal(q.hasSession('s1'), true)
})

test('全局上限：满后 busy_queue_full，出队后可再入', () => {
  const q = createWrapQueue({ maxQueued: 2 })
  q.enqueue({ sessionId: 'a', runId: 1, materialHash: 'h1' })
  q.enqueue({ sessionId: 'b', runId: 2, materialHash: 'h2' })
  assert.deepEqual(q.enqueue({ sessionId: 'c', runId: 3, materialHash: 'h3' }), { ok: false, reason: 'busy_queue_full' })
  q.removeBySession('a')
  assert.equal(q.enqueue({ sessionId: 'c', runId: 3, materialHash: 'h3' }).ok, true)
})

test('超时/会话销毁：sweep 返回原因并出队，lastSkip 证据可记', () => {
  const q = createWrapQueue({ maxQueued: 8, timeoutMs: 1000 })
  q.enqueue({ sessionId: 'slow', runId: 1, materialHash: 'h1', at: 0 })
  q.enqueue({ sessionId: 'gone', runId: 2, materialHash: 'h2', at: 1950 })
  const removed = q.sweep({ now: 2000, disposed: (sid) => sid === "gone" })
  assert.deepEqual(removed, [
    { sessionId: 'slow', runId: 1, reason: 'queue_timeout' },
    { sessionId: 'gone', runId: 2, reason: 'session_disposed' },
  ])
  assert.equal(q.size(), 0)
})

test('入队参数校验与 clear/snapshot', () => {
  const q = createWrapQueue({ maxQueued: 8 })
  assert.deepEqual(q.enqueue({ sessionId: '', runId: 1 }), { ok: false, reason: 'invalid_entry' })
  assert.deepEqual(q.enqueue({ sessionId: 's', runId: 0 }), { ok: false, reason: 'invalid_entry' })
  q.enqueue({ sessionId: 's', runId: 5, materialHash: 'h' })
  assert.deepEqual(q.snapshot(), { count: 1, sessions: ['s'] })
  q.clear()
  assert.equal(q.size(), 0)
  assert.equal(q.head(), null)
})
