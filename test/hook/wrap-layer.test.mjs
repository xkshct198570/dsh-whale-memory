/**
 * v7 收尾分流 → layer 映射回归：四类 kind 落对应 layer，rule 只产提案、open_loop 不落 nodes。
 *
 * 断言真实产物：真 LocalBackend + 临时库，读 `nodes.layer` 列与 run 条目状态；
 * createProposal 用桩只为隔离规则提案链路（该链路的规则文件口径已有独立回归）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { closeDb, openDb } from '../../src/core/db.js'
import { createRun } from '../../src/core/wrap-runs.js'
import { dispatchPhase, LAYER_OF_KIND } from '../../src/host/session-wrap/dispatch.js'

const IDENT = { userId: 'u-wrap-layer', roleId: '', workspace: 'ws-wrap-layer' }
const INGEST = { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true }

/** 价值闸放行的 durable 文本（与架构书 §7.1 夹具同源，避免把测试结论建立在分类运气上）。 */
const TEXTS = {
  lesson: 'flex-column 布局中滚动子项（如 nav）必须显式设置 flex-shrink:0 和最小高度/盒高；验收要逐页签真机可见可点，不能只测组件函数或文本。',
  decision: '记忆入库应服务于记录、避免再犯和提升下次表现，不应让默认人工审批成为阻塞。',
  preference: 'LLM 流式收集不能同时累加 text-delta 和 block-end，否则 JSON 拼两遍；预算 1200 会被推理思考吃光。',
  fact: '记忆库默认落在 DSH_HOME/whale-memory，库文件名 memory.db。',
  rule: '以后动库前必须备份。',
}

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-wrap-layer-'))
  const db = openDb(dir)
  const backend = createBackend({ mode: 'local' }, { dataDir: dir, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); closeDb(db); rmSync(dir, { recursive: true, force: true }) })
  const run = createRun(db, {
    sessionId: 's-layer', materialHash: 'h-layer', trigger: 'manual', identity: IDENT, now: Date.now() / 1000,
  }).run
  return { db, backend, run, withDb: (fn) => fn(db) }
}

test('LAYER_OF_KIND：四类 kind 有映射，rule/open_loop 无映射', () => {
  assert.deepEqual({ ...LAYER_OF_KIND }, {
    lesson: 'lesson', decision: 'fact', fact: 'fact', preference: 'user',
  })
  assert.equal(LAYER_OF_KIND.rule, undefined)
  assert.equal(LAYER_OF_KIND.open_loop, undefined)
})

test('dispatch：lesson→lesson、decision/fact→fact、preference→user；rule 不落 nodes', async (t) => {
  const { db, backend, run, withDb } = fresh(t)
  const items = [
    { kind: 'lesson', text: TEXTS.lesson, confidence: 0.9, tags: [] },
    { kind: 'decision', text: TEXTS.decision, confidence: 0.9, tags: [] },
    { kind: 'preference', text: TEXTS.preference, confidence: 0.9, tags: [] },
    { kind: 'fact', text: TEXTS.fact, confidence: 0.9, tags: [] },
    { kind: 'rule', text: TEXTS.rule, confidence: 0.9, tags: [] },
    { kind: 'open_loop', text: '补一条备份校验脚本', confidence: 0.6, tags: [] },
  ]
  const out = await dispatchPhase({
    items,
    distilled: { items, dropped: [], counts: {} },
    spool: { identity: IDENT, sessionId: 's-layer' },
    runId: run.id,
    config: { write: { enabled: true }, rules: { enabled: true } },
    backend,
    ingest: INGEST,
    withDb,
    createProposal: ({ text }) => ({ ok: true, proposal: { id: 'prop-1', text } }),
    log: () => {},
  })

  const written = out.items.filter((item) => item.status === 'ingested')
  assert.equal(written.length, 4, `四类记忆必须入库（实际 ${JSON.stringify(out.items.map((i) => [i.kind, i.status]))}）`)
  const layerOf = (nodeId) => db.prepare('SELECT layer FROM nodes WHERE id=?').get(nodeId)?.layer ?? null
  const byKind = new Map(out.items.map((item) => [item.kind, item]))
  assert.equal(layerOf(byKind.get('lesson').nodeId), 'lesson')
  assert.equal(layerOf(byKind.get('decision').nodeId), 'fact')
  assert.equal(layerOf(byKind.get('preference').nodeId), 'user')
  assert.equal(layerOf(byKind.get('fact').nodeId), 'fact')

  // 规则只产提案、待办不落库：nodes 只多出上面 4 行，且没有任何文本等于规则条目。
  assert.equal(byKind.get('rule').status, 'proposal')
  assert.equal(byKind.get('open_loop').status, 'open_loop')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 4)
  assert.equal(db.prepare('SELECT 1 FROM nodes WHERE text=?').get(TEXTS.rule), undefined, '规则条目不得落 nodes')
})
