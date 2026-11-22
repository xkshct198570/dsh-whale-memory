/**
 * 采纳信号落库单测（审计 backlog P1「used 恒 0」）：断言真实 recalls 行的 used 列，
 * 以及 hook → backend 全链路的回写结果——不是"接口没报错"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../src/core/backend.js'
import { installHook } from '../../src/host/hook.js'

const ident = { userId: 'u1', roleId: '', workspace: 'web' }
const NODE_TEXT = '网关端口 3982 是回调端口，出站走 3002'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-adopt-'))
  return new LocalBackend({
    dataDir: dir, useWorker: false,
    config: () => ({ write: { enabled: true, reviewMode: 'auto', maxChars: 500, dailyCap: 200 } }),
  })
}

const recallRow = (backend, id) => backend.withDb(
  (db) => db.prepare('SELECT * FROM recalls WHERE id=?').get(id),
)

test('recall 返回 recallId 与最终注入节点；markRecallUsed 把 used 写回真实行', async () => {
  const b = fresh()
  try {
    await b.write({ text: NODE_TEXT, identity: ident })
    const r = await b.recall({ query: '网关端口 3982 怎么起', maxHits: 3, identity: ident })
    assert.ok(r.recallId > 0, '有注入的召回必须带回审计行 id')
    assert.ok(Array.isArray(r.injectedNodes) && r.injectedNodes.length >= 1)
    assert.ok(r.injectedNodes.some((n) => n.text.includes('3982')), '判定素材是注入节点的真实正文')

    const before = recallRow(b, r.recallId)
    assert.equal(Number(before.used), 0, '库里初始是「尚未判定」，不是「未采纳」')

    const res = b.markRecallUsed(r.recallId, true)
    assert.deepEqual(res, { ok: true, updated: 1 })
    const after = recallRow(b, r.recallId)
    assert.equal(Number(after.used), 1, 'used 必须落到真实 recalls 行')
    assert.equal(Number(after.injected), 1, '回写 used 不许改动注入事实')
    assert.equal(after.query, before.query)
  } finally { b.dispose() }
})

test('零命中/预算 0：不回 used 信号（没有可采纳对象）', async () => {
  const b = fresh()
  try {
    const r = await b.recall({ query: '完全不存在zzz词条', maxHits: 3, identity: ident })
    assert.equal(r.prefix, '')
    assert.deepEqual(r.injectedNodes, [], '零命中没有可采纳节点')
    assert.equal(Number(recallRow(b, r.recallId).injected), 0)
    const zero = await b.recall({ query: '画个图', maxHits: 3, charBudget: 0, intentBudget: false, identity: ident })
    assert.ok(!zero.recallId)
  } finally { b.dispose() }
})

test('markRecallUsed 非法 id 不抛、不改任何行', async () => {
  const b = fresh()
  try {
    assert.deepEqual(b.markRecallUsed(0), { ok: false, updated: 0 })
    assert.deepEqual(b.markRecallUsed('abc'), { ok: false, updated: 0 })
    assert.deepEqual(b.markRecallUsed(99999), { ok: true, updated: 0 })
  } finally { b.dispose() }
})

/** 真 backend + 假 ctx：注入 → 回复引用 → used=1，一条链路验到底。 */
test('hook → backend 全链路：引用注入节点的回复让 recalls.used 变 1', async () => {
  const b = fresh()
  try {
    await b.write({ text: NODE_TEXT, identity: ident })
    const state = { handlers: {}, pre: null, context: null }
    const ctx = {
      on(ev, fn) { state.handlers[ev] = fn; if (ev === 'agent/pre-step') state.pre = fn; return () => {} },
      systemPrompt: { context(def) { state.context = def; return () => {} } },
      effect(fn) { return fn() },
    }
    const hook = installHook(ctx, {
      backend: b,
      config: { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: 'web' }, recall: { enabled: true, maxHits: 3, timeoutMs: 1000 } },
    })
    await state.pre({
      agent: { session: { id: 'sess-1' } },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '网关端口 3982 怎么起' }] }],
      turn: 1, step: 1,
    }, async () => ({ kind: 'enter' }))
    assert.match(state.context.text({ scope: { session: { id: 'sess-1' } } }), /旧事/)

    state.handlers['agent/assistant-stream']({
      agent: { id: 'sess-1' },
      frame: { type: 'chunk', turn: 1, step: 1, chunk: { type: 'text-delta', text: `按记忆：${NODE_TEXT}，用 start-gateway.sh 起。` } },
    })
    state.handlers['agent/turn-stopping']({ agent: { session: { id: 'sess-1' } } })

    const rows = b.withDb((db) => db.prepare('SELECT * FROM recalls ORDER BY id').all())
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].injected), 1)
    assert.equal(Number(rows[0].used), 1, '全链路的采纳信号必须落到库，不是只写内存')
    hook.dispose()
  } finally { b.dispose() }
})
