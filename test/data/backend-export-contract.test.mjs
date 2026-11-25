/**
 * 导出字段契约（P3e seam 回归）：锁住 transfer 的导出白名单与字段保真。
 *
 * why 单独成文件：后端拆分把 NODE_EXPORT_FIELDS 搬到 backend/base.js 后，字段闸只剩
 * “被测试当查询键”的偶然覆盖（删 origin 全绿且往返丢值）。这里用冻结清单锁键集与顺序，
 * 并验 export→import 往返保真；删任一字段 → 键集断言红，导入侧丢值 → 往返断言红。
 *
 * 注意：导出 25 列（`text_bigrams` 是 INSERT 派生列，不在导出白名单）。
 * 已知存量缺陷（P3e 冻结期只登记不修）：导出 `tags` 是 JSON 字符串，导入侧只认数组，
 * 故 export→import 会把 tags 清空；修复需改导入侧类型兼容，单独立项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'

/** 冻结的导出键集（顺序即 JSONL 列顺序；改白名单必须同步本清单与 transfer.js IMPORT_INSERT_SQL）。 */
const EXPECTED_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'pinned', 'hits', 'last_hit_at', 'vector_state',
  'created_at', 'updated_at', 'valid_at', 'invalid_at', 'expired_at', 'superseded_by',
  'origin', 'trace_id', 'text_hash',
]

const ident = { userId: 'u-origin', roleId: '', workspace: 'web' }

/** 临时库 backend + 目录（用例结束删除，铁律 21）。 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-export-'))
  return { backend: new LocalBackend({ dataDir: dir, useWorker: false }), dir }
}

function parseJsonl(jsonl) {
  return String(jsonl || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('导出键集与顺序 == 冻结白名单（25 字段）', async () => {
  const { backend: b, dir } = fresh()
  try {
    const w = await b.write({ text: '导出契约：网关端口规则', identity: ident, origin: 'gateway.py:3982' })
    assert.equal(w.ok, true)
    const rows = parseJsonl(await b.exportJsonl({ identity: ident }))
    assert.equal(rows.length, 1)
    assert.deepEqual(Object.keys(rows[0]), EXPECTED_EXPORT_FIELDS, '导出键集/顺序必须与白名单一致')
  } finally { b.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('export→import 往返保字段（origin/trace_id/状态/双时态/命中/向量态）', async () => {
  const src = fresh()
  const dst = fresh()
  try {
    const w = await src.backend.write({
      text: '导出契约：溯源保真', identity: ident, origin: 'gateway.py:3982', traceId: 'tr-p3e-contract',
      level: 'core', memory_type: 'procedural', source: 'owner', pinned: 1, expired_at: 9999999999,
    })
    assert.equal(w.ok, true)
    src.backend.withDb((db) => db.prepare(
      `UPDATE nodes SET status='archived', valid_at=123, invalid_at=456, superseded_by='sup-x',
        hits=7, last_hit_at=789, vector_state='ready', weight=2.5, context_note='note-1' WHERE id=?`,
    ).run(w.id))

    const row = parseJsonl(await src.backend.exportJsonl({ identity: ident }))[0]
    const r = await dst.backend.importJsonl({ jsonl: await src.backend.exportJsonl({ identity: ident }), identity: ident })
    assert.equal(r.added, 1)
    const got = await dst.backend.getNode(row.id, { identity: ident })
    assert.equal(got.ok, true)
    for (const field of [
      'origin', 'trace_id', 'status', 'valid_at', 'invalid_at', 'superseded_by',
      'hits', 'last_hit_at', 'vector_state', 'weight', 'context_note',
      'level', 'memory_type', 'source', 'pinned', 'expired_at',
    ]) {
      assert.deepEqual(got.node[field], row[field], `${field} 必须往返保真`)
    }
    assert.equal(got.node.origin, 'gateway.py:3982', 'origin 不得回落 import')
    assert.equal(got.node.trace_id, 'tr-p3e-contract', 'trace_id 不得丢')
  } finally { src.backend.dispose(); dst.backend.dispose(); rmSync(src.dir, { recursive: true, force: true }); rmSync(dst.dir, { recursive: true, force: true }) }
})

test('状态枚举 stale 往返不得复活成 active（导入闸不得丢枚举）', async () => {
  const src = fresh()
  const dst = fresh()
  try {
    const w = await src.backend.write({ text: '导出契约：stale 状态往返', identity: ident })
    assert.equal(w.ok, true)
    src.backend.withDb((db) => db.prepare("UPDATE nodes SET status='stale' WHERE id=?").run(w.id))
    const row = parseJsonl(await src.backend.exportJsonl({ identity: ident }))[0]
    assert.equal(row.status, 'stale')
    const r = await dst.backend.importJsonl({ jsonl: await src.backend.exportJsonl({ identity: ident }), identity: ident })
    assert.equal(r.added, 1)
    const got = await dst.backend.getNode(row.id, { identity: ident })
    assert.equal(got.node.status, 'stale', 'stale 必须原样往返，不得回落 active')
  } finally { src.backend.dispose(); dst.backend.dispose(); rmSync(src.dir, { recursive: true, force: true }); rmSync(dst.dir, { recursive: true, force: true }) }
})
