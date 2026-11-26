/**
 * 首轮画像取数（backend.profileLayers）契约：分组上限、排序、身份过滤、NULL/未知 layer 排除。
 *
 * 用真 LocalBackend + 临时库直接造行（不经 writer）：排序判据（pinned/weight/updated_at）
 * 需要精确控制，走写入路径会被判重/合并干扰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'

const IDENT = { userId: 'u1', roleId: '', workspace: '/ws/a' }

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-profile-layers-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return backend
}

let seq = 0
/** 直接造节点行：字段全填，便于精确控制排序/分区/分层。 */
function insertNode(backend, row) {
  seq += 1
  const id = row.id || `p${String(seq).padStart(4, '0')}`
  backend.withDb((db) => db.prepare(`INSERT INTO nodes
    (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
     context_note,weight,pinned,layer,hits,vector_state,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'normal','semantic','self',?,?,?,?,'[]','',?,?,?,0,'none','','',?,?)`).run(
    id, row.text, `h${id}`, '', row.status || 'active',
    row.roleId ?? '', row.userId ?? 'u1', row.workspace ?? '/ws/a',
    row.weight ?? 1, row.pinned ?? 0, row.layer ?? null,
    row.createdAt ?? 1, row.updatedAt ?? 1,
  ))
  return id
}

test('分组取数：user5/lesson5/fact3 上限，顺序 pinned DESC, weight DESC, updated_at DESC', async (t) => {
  const backend = fresh(t)
  // user：7 条 → 只取 5；pinned 一条必须排第一。
  const pinnedUser = insertNode(backend, { text: '偏好：置顶项', layer: 'user', pinned: 1, weight: 0.1, updatedAt: 1 })
  const heavy = insertNode(backend, { text: '偏好：高权重', layer: 'user', weight: 9, updatedAt: 1 })
  const newest = insertNode(backend, { text: '偏好：最新', layer: 'user', weight: 1, updatedAt: 99 })
  for (let i = 0; i < 4; i += 1) insertNode(backend, { text: `偏好：普通 ${i}`, layer: 'user', weight: 1, updatedAt: 10 + i })
  // lesson：6 条 → 5；fact：4 条 → 3。
  for (let i = 0; i < 6; i += 1) insertNode(backend, { text: `教训：样本 ${i}`, layer: 'lesson', weight: 1, updatedAt: 10 + i })
  for (let i = 0; i < 4; i += 1) insertNode(backend, { text: `事实：样本 ${i}`, layer: 'fact', weight: 1, updatedAt: 10 + i })

  const got = await backend.profileLayers({ user: 5, lesson: 5, fact: 3 }, { identity: IDENT })
  assert.equal(got.user.length, 5)
  assert.equal(got.lesson.length, 5)
  assert.equal(got.fact.length, 3)
  assert.equal(got.user[0].id, pinnedUser, 'pinned 必须优先于权重/时间')
  assert.equal(got.user[1].id, heavy, '其次按 weight')
  assert.equal(got.user[2].id, newest, '再次按 updated_at')
  for (const row of got.user) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'layer', 'text'], '只读 id/text/layer，不外带正文以外字段')
    assert.equal(row.layer, 'user')
  }
})

test('身份过滤：只取同身份 + 共享（user_id/workspace 为空），跨分区不可见', async (t) => {
  const backend = fresh(t)
  const mine = insertNode(backend, { text: '教训：本分区', layer: 'lesson' })
  const sharedUser = insertNode(backend, { text: '教训：共享分区', layer: 'lesson', userId: '', workspace: '' })
  insertNode(backend, { text: '教训：别的用户', layer: 'lesson', userId: 'u2' })
  insertNode(backend, { text: '教训：别的目录', layer: 'lesson', workspace: '/ws/b' })

  const got = await backend.profileLayers({ user: 5, lesson: 5, fact: 3 }, { identity: IDENT })
  const ids = got.lesson.map((row) => row.id)
  assert.deepEqual(ids.sort(), [mine, sharedUser].sort(), '同身份 + 共享可见，跨用户/跨目录不可见')
})

test('NULL/未知 layer 与失效状态不参与画像；未请求的分组返回空数组', async (t) => {
  const backend = fresh(t)
  insertNode(backend, { text: '未分层：旧节点', layer: null })
  insertNode(backend, { text: '脏分层：topic', layer: 'topic' })
  insertNode(backend, { text: '已归档的偏好', layer: 'user', status: 'archived' })
  const active = insertNode(backend, { text: '偏好：有效项', layer: 'user' })

  const got = await backend.profileLayers({ user: 5 }, { identity: IDENT })
  assert.deepEqual(got.user.map((row) => row.id), [active])
  assert.deepEqual(got.lesson, [])
  assert.deepEqual(got.fact, [])

  // limit=0/缺省不取：显式 0 与不传同口径（不查空集合）。
  const none = await backend.profileLayers({ user: 0, lesson: 0, fact: 0 }, { identity: IDENT })
  assert.deepEqual(none, { user: [], lesson: [], fact: [] })
})

test('identity=null 是内部管理查询（不过滤）；给身份对象时空串只命中共享分区', async (t) => {
  const backend = fresh(t)
  const a = insertNode(backend, { text: '偏好：A 分区', layer: 'user', userId: 'u1', workspace: '/ws/a' })
  const b = insertNode(backend, { text: '偏好：B 分区', layer: 'user', userId: 'u2', workspace: '/ws/b' })
  const shared = insertNode(backend, { text: '偏好：共享', layer: 'user', userId: '', workspace: '' })

  const all = await backend.profileLayers({ user: 5 }, { identity: null })
  assert.deepEqual(all.user.map((row) => row.id).sort(), [a, b, shared].sort(), '无身份对象=管理查询，不按分区过滤')

  const sharedOnly = await backend.profileLayers({ user: 5 }, { identity: { userId: '', roleId: '', workspace: '' } })
  assert.deepEqual(sharedOnly.user.map((row) => row.id), [shared], '空串是分区值：只命中共享分区，绝不全库可见')
})
