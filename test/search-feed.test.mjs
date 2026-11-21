import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSearchFeed } from '../src/host/search-feed.js'

function fakeCtx() {
  const handlers = {}
  return { state: handlers, ctx: {
    on(ev, fn) { handlers[ev] = fn; return () => {} },
    effect(fn) { return fn() },
  } }
}

const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: 'web' },
  write: { enabled: true, searchFeed: true, searchTtlHours: 24 } }

test('web_search 结果写成 episodic（source=web + TTL + 摘要截断）', async () => {
  const { ctx, state } = fakeCtx()
  const writes = []
  installSearchFeed(ctx, { backend: { async write(q) { writes.push(q); return { ok: true, id: 'n1' } } }, config })
  state['tools/result']({
    name: 'web_search', callId: 'c1', arguments: { query: '潮州天气' },
  }, { value: { answer: '多云 26 度', sources: [{ title: '天气网', snippet: '潮州今天多云' }, { title: 'B', snippet: 'x' }] } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(writes.length, 1)
  const w = writes[0]
  assert.equal(w.memory_type, 'episodic')
  assert.equal(w.source, 'web')
  assert.match(w.text, /潮州天气/)
  assert.match(w.text, /多云/)
  assert.ok(w.text.length <= 200)
  assert.ok(w.expired_at > Date.now() / 1000)
  assert.deepEqual(w.tags.slice(0, 1), ['web_search'])
})

test('开关关闭 / 非搜索工具不写', async () => {
  const { ctx, state } = fakeCtx()
  let n = 0
  installSearchFeed(ctx, { backend: { async write() { n += 1; return { ok: true } } },
    config: { ...config, write: { ...config.write, searchFeed: false } } })
  state['tools/result']({ name: 'web_search', arguments: { query: 'x' } }, { value: { answer: 'y' } })
  installSearchFeed(ctx, { backend: { async write() { n += 1; return { ok: true } } }, config })
  state['tools/result']({ name: 'read_file', arguments: { path: 'a' } }, { value: { text: 'x' } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(n, 0)
})
