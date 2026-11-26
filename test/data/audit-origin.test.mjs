/**
 * 审计来源口径（S2）：`updateNode` 的 EDIT/ARCHIVE 行必须与影子候选同形的 `writes.payload`，
 * 且 origin 只由调用方决定（面板=panel / 同步=sync / 工具=tool）。
 *
 * 为什么单独锁：工具面靠 `json_extract(payload,'$.origin')='tool'` 对账；payload 形状或
 * origin 回落一旦漂移，工具写入会静默漏在审计查询之外（看不到失败也算失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'

const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }
const PAYLOAD_KEYS = ['expired_at', 'level', 'memory_type', 'origin', 'shadowOf', 'source', 'tags', 'targetId']

async function freshNode(t, text) {
  const home = mkdtempSync(join(tmpdir(), 'whale-audit-origin-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  const written = await backend.write({ text, identity: IDENT })
  assert.equal(written.ok, true)
  return { backend, id: written.id }
}

/** 最近一条 EDIT 审计行（payload 已解析）。 */
function lastEdit(backend) {
  const row = backend.withDb((db) => db.prepare(
    "SELECT action,reason,payload FROM writes WHERE action='EDIT' ORDER BY id DESC LIMIT 1",
  ).get())
  assert.ok(row?.payload, 'EDIT 行必须带 payload（v2 列），否则审计查询会漏行')
  return { ...row, payload: JSON.parse(row.payload) }
}

test('updateNode：面板编辑 → origin=panel、reason=manual_*、payload 与候选同形', async (t) => {
  const { backend, id } = await freshNode(t, '面板编辑来源口径：写审计必须能看到是谁改的')
  assert.equal((await backend.updateNode(id, { text: '面板编辑来源口径：审计行必须与候选同形', tags: ['审计'] }, { identity: IDENT })).ok, true)
  const edit = lastEdit(backend)
  assert.deepEqual(Object.keys(edit.payload).sort(), PAYLOAD_KEYS)
  assert.equal(edit.payload.origin, 'panel')
  assert.equal(edit.payload.memory_type, 'semantic')
  assert.deepEqual(edit.payload.tags, ['审计'])
  const rows = backend.withDb((db) => db.prepare(
    "SELECT reason,payload FROM writes WHERE action='EDIT' ORDER BY id DESC",
  ).all())
  assert.ok(rows.length >= 2, '正文与 tags 各留一条审计')
  assert.ok(rows.every((row) => JSON.parse(row.payload).origin === 'panel'))
  assert.ok(rows.some((row) => row.reason === 'manual_edit') && rows.some((row) => row.reason === 'manual_tags'))
})

test('updateNode：同步标记 → origin=sync；工具改写 → origin=tool + 自定义归档原因', async (t) => {
  const { backend, id } = await freshNode(t, '同步冲突标记来源口径：mode=sync 的改动要能对账')
  assert.equal((await backend.updateNode(id, { status: 'stale' }, { identity: IDENT, mode: 'sync' })).ok, true)
  const syncArchive = backend.withDb((db) => db.prepare(
    "SELECT reason,payload FROM writes WHERE action='ARCHIVE' ORDER BY id DESC LIMIT 1",
  ).get())
  assert.equal(JSON.parse(syncArchive.payload).origin, 'sync')
  assert.equal(syncArchive.reason, 'sync_archive', '同步来源的审计 reason 必须与 origin 同口径')

  const toolId = (await backend.write({ text: '工具改写来源口径：memory_update 的审计必须可查', identity: IDENT })).id
  assert.equal((await backend.updateNode(toolId, { text: '工具改写来源口径：审计 origin 必须是 tool' }, { identity: IDENT, origin: 'tool' })).ok, true)
  const edit = lastEdit(backend)
  assert.equal(edit.payload.origin, 'tool')
  assert.equal(edit.reason, 'tool_edit')

  assert.equal((await backend.updateNode(toolId, { status: 'archived' }, { identity: IDENT, origin: 'tool', reason: '人工确认后归档' })).ok, true)
  const archive = backend.withDb((db) => db.prepare(
    "SELECT reason,payload FROM writes WHERE action='ARCHIVE' ORDER BY id DESC LIMIT 1",
  ).get())
  assert.equal(archive.reason, '人工确认后归档')
  assert.equal(JSON.parse(archive.payload).origin, 'tool')
})

test('updateNode：无变化不产审计、不推进 updated_at（防幻影版本号）', async (t) => {
  const { backend, id } = await freshNode(t, '无变化编辑口径：同一正文重复提交不得推进版本号')
  const before = backend.withDb((db) => db.prepare('SELECT text,updated_at FROM nodes WHERE id=?').get(id))
  const noop = await backend.updateNode(id, { text: before.text }, { identity: IDENT })
  assert.equal(noop.ok, true)
  assert.equal(Number(noop.updated_at), Number(before.updated_at), '无变化时返回的必须是实际生效的旧时间戳')
  const after = backend.withDb((db) => db.prepare('SELECT updated_at FROM nodes WHERE id=?').get(id))
  assert.equal(Number(after.updated_at), Number(before.updated_at))
  assert.equal(backend.withDb((db) => db.prepare("SELECT count(*) AS n FROM writes WHERE action='EDIT'").get().n), 0)
})
