import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReflectPrompt, parseReflectOutput, runReflect, installReflectScheduler } from '../../src/core/reflect.js'

test('prompt 含素材与条数上限', () => {
  const p = buildReflectPrompt([{ text: '昨天查了潮州天气' }, { text: '网关端口 3982' }], { maxItems: 3 })
  assert.match(p, /潮州天气/)
  assert.match(p, /3982/)
  assert.match(p, /最多 3 条/)
  assert.match(p, /JSON 数组/)
})

test('parse：剥代码围栏/坏 JSON/超长/未知类型', () => {
  const long = 'x'.repeat(600)
  const out = parseReflectOutput(`\`\`\`json
[{"text":"规则A","type":"procedural"},{"text":"事实B"},{"text":""},{"text":"${long}","type":"other"}]
\`\`\``)
  assert.equal(out.length, 3)
  assert.equal(out[0].type, 'procedural')
  assert.equal(out[1].type, 'semantic')
  assert.equal(out[2].text.length, 500)
  assert.deepEqual(parseReflectOutput('not json'), [])
  assert.deepEqual(parseReflectOutput('[{"bad":1}]'), [])
})

test('runReflect：读 episodic → llm → 写回 semantic/procedural', async () => {
  const writes = []
  const backend = {
    async listEpisodic() { return [{ text: '昨天查了潮州天气' }, { text: '网关端口 3982' }] },
    async write(q) { writes.push(q); return { ok: true } },
  }
  const llm = { async *stream() {
    yield { type: 'text-delta', text: '[{"text":"潮州天气多云","type":"semantic"},' }
    yield { type: 'text-delta', text: '{"text":"网关端口是 3982","type":"procedural"}]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const r = await runReflect({ backend, llm, selection: { provider: 'p', model: 'm' }, config: { reflect: { maxItems: 8 } } })
  assert.equal(r.ok, true)
  assert.equal(r.added, 2)
  assert.equal(writes.length, 2)
  assert.equal(writes[0].source, 'self')
  assert.equal(writes[1].memory_type, 'procedural')
})

test('runReflect：delta+block-end 同发不得把 JSON 拼两遍（真机 items=0 根因）', async () => {
  const writes = []
  const backend = {
    async listEpisodic() { return [{ text: '0.7.1 热修后重启验证' }] },
    async write(q) { writes.push(q); return { ok: true } },
  }
  const body = '[{"text":"热修后需要再次重启才生效","type":"procedural"}]'
  // 适配器同时发增量与整块：旧实现 text-delta + block-end 各加一遍 → 首[到末]跨两段 → 解析 []。
  const llm = { async *stream() {
    yield { type: 'text-delta', text: body }
    yield { type: 'block-end', block: { type: 'text', text: body } }
    yield { type: 'reasoning-delta', text: '思考中' }
  } }
  const logs = []
  const r = await runReflect({ backend, llm, selection: { provider: 'p', model: 'm' }, config: { reflect: {} }, log: (line) => logs.push(line) })
  assert.equal(r.ok, true)
  assert.equal(r.added, 1, '双写修复后应解析出 1 条')
  assert.equal(writes.length, 1)
  assert.equal(logs.some((line) => line.includes('reflect parse empty')), false)
})

test('runReflect：无素材/无 llm 不写', async () => {
  const backend = { async listEpisodic() { return [] }, async write() { throw new Error('no') } }
  assert.deepEqual(await runReflect({ backend, llm: {}, selection: {}, config: {} }), { ok: false, reason: 'llm_unavailable' })
  const r = await runReflect({ backend, llm: { async *stream() {} }, selection: {}, config: {} })
  assert.equal(r.reason, 'no_model')
})


test('调度器 pre-step 监听必须返回 next() 的 decision（防 decision.kind 崩）', async () => {
  let pre = null
  const ctx = {
    on(ev, fn) { if (ev === 'agent/pre-step') pre = fn; return () => {} },
  }
  const sched = installReflectScheduler(ctx, {
    backend: { async listEpisodic() { return [] } },
    config: { reflect: { enabled: false } },
    getLlm: () => undefined,
    getSelection: () => undefined,
  })
  try {
    const decision = { kind: 'enter' }
    const ret = await pre({ agent: { session: { id: 's' } } }, async () => decision)
    assert.equal(ret, decision)
    assert.equal(ret.kind, 'enter')
  } finally { sched.dispose() }
})
