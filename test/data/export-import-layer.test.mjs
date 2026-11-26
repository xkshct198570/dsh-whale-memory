/**
 * v7 `nodes.layer` 数据面：写入白名单、导出/导入保真、MERGE/SUPERSEDE 口径。
 *
 * 判据（架构书 §5.7.1/§5.7.2）：
 * - `backend.write({layer})` 只落 fact/lesson/user，其余（含缺省）NULL；
 * - 导出 JSONL 带 `layer`（追加在末尾），export→import 三值 + NULL 保真，旧 JSONL 缺列按 NULL；
 * - MERGE 保留目标既有 layer（一次写入不升级/清空），SUPERSEDE 的新行用本次事件 layer。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'

const IDENT = { userId: 'u-layer', roleId: '', workspace: 'ws-layer' }

/** 临时库 backend（worker 关：断言同步可读，不引入线程时序）。 */
function fresh(t, prefix = 'whale-layer-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const backend = new LocalBackend({ dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return backend
}

function layerOf(backend, id) {
  return backend.withDb((db) => db.prepare('SELECT layer FROM nodes WHERE id=?').get(id))?.layer ?? null
}

function parseJsonl(jsonl) {
  return String(jsonl || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('写入白名单：三值落列，未知/缺省一律 NULL', async (t) => {
  const backend = fresh(t)
  const cases = [
    ['偏好：基线只在全绿后刷新。', 'user', 'user'],
    ['教训：动库前必须先备份。', 'lesson', 'lesson'],
    ['事实：网关端口是 3982。', 'fact', 'fact'],
    ['未分层：这条没有 kind。', 'topic', null],
    ['未分层：这条没带 layer。', undefined, null],
  ]
  for (const [text, layer, want] of cases) {
    const res = await backend.write({ text, identity: IDENT, ...(layer === undefined ? {} : { layer }) })
    assert.equal(res.ok, true, `写入失败：${text}`)
    assert.equal(layerOf(backend, res.id), want, `${text} 的 layer 必须为 ${want}`)
  }
})

test('导出带 layer；export→import 往返保真（三值 + NULL）；旧 JSONL 缺列按 NULL', async (t) => {
  const src = fresh(t, 'whale-layer-src-')
  const written = {}
  for (const [key, layer] of [['user', 'user'], ['lesson', 'lesson'], ['fact', 'fact'], ['none', undefined]]) {
    const res = await src.write({
      text: `往返保真样本 ${key}：${layer ?? '未分层'}`, identity: IDENT,
      ...(layer === undefined ? {} : { layer }),
    })
    assert.equal(res.ok, true)
    written[key] = res.id
  }

  const jsonl = await src.exportJsonl({ identity: IDENT })
  const rows = parseJsonl(jsonl)
  assert.equal(rows.length, 4)
  for (const row of rows) {
    assert.ok('layer' in row, '导出必须带 layer 键（含 NULL）')
    assert.equal(Object.keys(row).at(-1), 'layer', 'layer 追加在导出字段末尾（旧消费方按前缀读）')
  }
  const byId = new Map(rows.map((row) => [row.id, row.layer]))
  assert.equal(byId.get(written.user), 'user')
  assert.equal(byId.get(written.lesson), 'lesson')
  assert.equal(byId.get(written.fact), 'fact')
  assert.equal(byId.get(written.none), null)

  // 往返：同一份 JSONL 导入新库，layer 必须逐行相等（旧 JSONL 缺列走下一用例）。
  const dst = fresh(t, 'whale-layer-dst-')
  const imported = await dst.importJsonl({ jsonl, identity: IDENT })
  assert.equal(imported.ok, true)
  assert.equal(imported.added, 4)
  for (const row of rows) {
    assert.equal(layerOf(dst, row.id), row.layer, `往返后 ${row.id} 的 layer 必须保真`)
  }

  // 旧 JSONL：去掉 layer 键 → NULL（不得猜成任何一种分层）。
  const legacy = jsonl.split('\n').filter(Boolean)
    .map((line) => { const row = JSON.parse(line); delete row.layer; return JSON.stringify(row) })
    .join('\n')
  const legacyDst = fresh(t, 'whale-layer-legacy-')
  const legacyImport = await legacyDst.importJsonl({ jsonl: legacy, identity: IDENT })
  assert.equal(legacyImport.ok, true)
  assert.equal(legacyImport.added, 4)
  for (const row of rows) assert.equal(layerOf(legacyDst, row.id), null, '旧 JSONL 缺列必须按 NULL')
})

test('MERGE 保留目标既有 layer（不升级/清空），SUPERSEDE 新行用本次事件 layer', async (t) => {
  const backend = fresh(t, 'whale-layer-merge-')
  const first = await backend.write({ text: '门禁失败不得发布', identity: IDENT, layer: 'user' })
  assert.equal(first.action, 'ADD')
  const merged = await backend.write({
    text: '门禁失败不得发布，且基线只在全绿后刷新', identity: IDENT, layer: 'lesson',
  })
  assert.equal(merged.action, 'MERGE')
  assert.equal(merged.id, first.id)
  assert.equal(layerOf(backend, first.id), 'user', 'MERGE 不得把目标 layer 改成事件 layer')

  const oldRow = await backend.write({ text: '项目部署在测试环境 端口是 8080', identity: IDENT, layer: 'fact' })
  assert.equal(oldRow.action, 'ADD')
  const superseded = await backend.write({ text: '项目部署在测试环境 端口是 9090', identity: IDENT, layer: 'lesson' })
  assert.equal(superseded.action, 'SUPERSEDE')
  assert.notEqual(superseded.id, oldRow.id)
  assert.equal(layerOf(backend, superseded.id), 'lesson', 'SUPERSEDE 新行必须用本次事件 layer')
  assert.equal(layerOf(backend, oldRow.id), 'fact', '旧行 layer 留档不得被改')
})
