/**
 * S4 真产物回归：runReflect → LocalBackend → nodes/writes。
 *
 * 为什么必须锁：单测只断言 backend.write 入参；写入层（layer 透传/payload origin/身份列）
 * 一旦回退，参数级用例仍会全绿。这里从真库读行级事实（铁律 4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { runReflect } from '../../src/core/reflect.js'

const identity = { userId: 'u1', roleId: '', workspace: '/work/ws' }
const config = {
  write: { enabled: true, reviewMode: 'auto' },
  wrap: { ingest: { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true } },
  reflect: { maxItems: 8 },
}

test('runReflect 真库：durable 落 active，身份/layer/source/origin/writes 审计全部对账', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-reflect-ingest-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  try {
    const episodic = await backend.write({
      text: '昨天网关卡在 3982，重启 gateway 后恢复', memory_type: 'episodic', identity,
    })
    assert.equal(episodic.ok, true)

    const llm = {
      async *stream() {
        yield { type: 'text-delta', text: '[{"text":"门禁失败不得发布，基线只在全绿后刷新","type":"procedural"}]' }
      },
    }
    const r = await runReflect({
      backend, llm, selection: { provider: 'p', model: 'm' }, config, identity, sessionId: 's-real', log: () => {},
    })
    assert.equal(r.ok, true)
    assert.equal(r.added, 1)
    assert.equal(r.review, 0)
    assert.equal(r.rejected, 0)

    const node = backend.withDb((db) => db.prepare(
      "SELECT user_id,role_id,workspace,layer,memory_type,source,origin,status,text FROM nodes WHERE origin='reflect'",
    ).get())
    assert.ok(node, '反思结果必须真落 nodes（不是只调 write 参数）')
    assert.equal(node.user_id, 'u1')
    assert.equal(node.role_id, '')
    assert.equal(node.workspace, '/work/ws', '身份必须落会话 workspace，不得为空')
    assert.equal(node.layer, 'lesson', 'procedural → lesson')
    assert.equal(node.memory_type, 'procedural')
    assert.equal(node.source, 'self')
    assert.equal(node.origin, 'reflect')
    assert.equal(node.status, 'active')
    assert.match(node.text, /门禁失败不得发布/)

    const write = backend.withDb((db) => db.prepare(
      "SELECT user_id,role_id,workspace,action,mode,payload FROM writes WHERE json_extract(payload,'$.origin')='reflect' ORDER BY id DESC LIMIT 1",
    ).get())
    assert.ok(write, 'writes 审计行必须带 payload.origin=reflect（可对账）')
    assert.equal(write.user_id, 'u1')
    assert.equal(write.workspace, '/work/ws')
    assert.equal(write.mode, 'auto')
    assert.ok(['ADD', 'MERGE', 'SUPERSEDE'].includes(write.action))
    const payload = JSON.parse(write.payload)
    assert.equal(payload.origin, 'reflect')
    assert.equal(payload.source, 'self')
    assert.equal(payload.layer, 'lesson')
    assert.equal(payload.memory_type, 'procedural')
  } finally { /* t.after 收尾 */ }
})
