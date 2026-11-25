/**
 * S2 prefs 回归：skipAuto 落库、重开仍生效、缺表/坏键回落 false。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSchema } from '../../src/core/schema.js'
import { setSkipAuto, skipAutoMap, skipAutoOf } from '../../src/core/wrap-prefs.js'

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-prefs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'memory.db')
  const db = new DatabaseSync(file)
  ensureSchema(db)
  t.after(() => { try { db.close() } catch { /* 已关闭 */ } })
  return { db, file, dir }
}

test('setSkipAuto：写入即读回；1→0 幂等更新；跨重开仍生效（S2 判据）', (t) => {
  const { db, file } = freshDb(t)
  assert.equal(skipAutoOf(db, 's1'), false, '缺行默认不跳过')
  assert.deepEqual(setSkipAuto(db, 's1', true, 10), { ok: true, sessionId: 's1', skipAuto: true })
  assert.equal(skipAutoOf(db, 's1'), true)
  assert.deepEqual(setSkipAuto(db, 's1', false, 11), { ok: true, sessionId: 's1', skipAuto: false })
  assert.equal(skipAutoOf(db, 's1'), false)
  setSkipAuto(db, 's2', true, 12)
  db.close()
  const again = new DatabaseSync(file)
  t.after(() => again.close())
  assert.equal(skipAutoOf(again, 's2'), true, '重启后 skip 必须保持')
})

test('非法会话键拒绝；skipAutoMap 只回 id→bool', (t) => {
  const { db } = freshDb(t)
  assert.equal(setSkipAuto(db, '', true).ok, false)
  assert.equal(setSkipAuto(db, '   ', true).ok, false)
  setSkipAuto(db, 'a', true)
  const map = skipAutoMap(db)
  assert.equal(map.get('a'), true)
  assert.equal(map.size, 1)
})
