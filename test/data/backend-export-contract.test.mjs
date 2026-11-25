/**
 * 导出字段契约（P3e seam 回归）：锁住 transfer 的导出白名单与 origin/trace_id 保真。
 *
 * why 单独成文件：后端拆分把 NODE_EXPORT_FIELDS 搬到 backend/base.js 后，字段闸只剩
 * “被测试当查询键”的偶然覆盖（删 origin 全绿且往返丢值）。这里用冻结清单锁键集与顺序，
 * 并验 export→import 往返；删任一字段 → 键集断言红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'

/** 冻结的导出键集（顺序即 JSONL 列顺序；改白名单必须同步本清单并说明理由）。 */
const EXPECTED_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'pinned', 'hits', 'last_hit_at', 'vector_state',
  'created_at', 'updated_at', 'valid_at', 'invalid_at', 'expired_at', 'superseded_by',
  'origin', 'trace_id', 'text_hash',
]

const ident = { userId: 'u-origin', roleId: '', workspace: 'web' }

function fresh() {
  return new LocalBackend({ dataDir: mkdtempSync(join(tmpdir(), 'whale-export-')), useWorker: false })
}

function parseJsonl(jsonl) {
  return String(jsonl || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('导出键集与顺序 == 冻结白名单（26 字段）', async () => {
  const b = fresh()
  try {
    const w = await b.write({ text: '导出契约：网关端口规则', identity: ident, origin: 'gateway.py:3982' })
    assert.equal(w.ok, true)
    const rows = parseJsonl(await b.exportJsonl({ identity: ident }))
    assert.equal(rows.length, 1)
    assert.deepEqual(Object.keys(rows[0]), EXPECTED_EXPORT_FIELDS, '导出键集/顺序必须与白名单一致')
  } finally { b.dispose() }
})

test('export→import 往返保 origin/trace_id（不得回落 import 默认值）', async () => {
  const src = fresh()
  const dst = fresh()
  try {
    const w = await src.write({
      text: '导出契约：溯源保真', identity: ident, origin: 'gateway.py:3982', traceId: 'tr-p3e-contract',
    })
    assert.equal(w.ok, true)
    const row = parseJsonl(await src.exportJsonl({ identity: ident }))[0]
    assert.equal(row.origin, 'gateway.py:3982')
    assert.equal(row.trace_id, 'tr-p3e-contract')

    const r = await dst.importJsonl({ jsonl: await src.exportJsonl({ identity: ident }), identity: ident })
    assert.equal(r.added, 1)
    const node = await dst.getNode(row.id, { identity: ident })
    assert.equal(node.ok, true)
    assert.equal(node.node.origin, 'gateway.py:3982', 'origin 必须往返，不得回落 import')
    assert.equal(node.node.trace_id, 'tr-p3e-contract', 'trace_id 必须往返')
  } finally { src.dispose(); dst.dispose() }
})
