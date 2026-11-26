import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installSearchFeed } from '../../src/host/search-feed.js'

function fakeCtx() {
  const handlers = {}
  return { state: handlers, ctx: {
    on(ev, fn) { handlers[ev] = fn; return () => {} },
    effect(fn) { return fn() },
  } }
}

const config = { identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: 'web' },
  write: { enabled: true, searchFeed: true, searchTtlHours: 24 } }

/** 真实工具执行至少带 agent（root call）；搜索反哺按会话身份落分区（架构书 §5.5.1）。 */
const withSession = (exec) => ({
  ...exec,
  agent: { session: { id: 's1', header: { cwd: '/tmp/ws' } } },
})

test('web_search 结果写成 episodic（source=web + TTL + 摘要截断 + 会话身份）', async () => {
  const { ctx, state } = fakeCtx()
  const writes = []
  installSearchFeed(ctx, { backend: { async write(q) { writes.push(q); return { ok: true, id: 'n1' } } }, config })
  state['tools/result'](withSession({
    name: 'web_search', callId: 'c1', arguments: { query: '潮州天气' },
  }), { value: { answer: '多云 26 度', sources: [{ title: '天气网', snippet: '潮州今天多云' }, { title: 'B', snippet: 'x' }] } })
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
  // 写路径必须落会话分区，绝不 workspace=''（S4 §5.5.1）。
  assert.deepEqual(w.identity, { userId: 'u1', roleId: '', workspace: 'web' })
})

test('开关关闭 / 非搜索工具不写', async () => {
  const { ctx, state } = fakeCtx()
  let n = 0
  installSearchFeed(ctx, { backend: { async write() { n += 1; return { ok: true } } },
    config: { ...config, write: { ...config.write, searchFeed: false } } })
  state['tools/result'](withSession({ name: 'web_search', arguments: { query: 'x' } }), { value: { answer: 'y' } })
  installSearchFeed(ctx, { backend: { async write() { n += 1; return { ok: true } } }, config })
  state['tools/result'](withSession({ name: 'read_file', arguments: { path: 'a' } }), { value: { text: 'x' } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(n, 0)
})

test('无 agent/子代理/身份不可判定：跳过且留一次可见日志（不写 workspace=\'\'）', async () => {
  const { ctx, state } = fakeCtx()
  const logs = []
  let n = 0
  installSearchFeed(ctx, {
    backend: { async write() { n += 1; return { ok: true } } }, config, log: (line) => logs.push(line),
  })
  // 无 agent：无法定位会话分区。
  state['tools/result']({ name: 'web_search', arguments: { query: 'a' } }, { value: { answer: 'A' } })
  // 子代理：不是人类会话分区。
  state['tools/result']({
    name: 'web_search', arguments: { query: 'b' },
    agent: { session: { header: { cwd: '/tmp/ws', origin: 'subagent' } } },
  }, { value: { answer: 'B' } })
  // 宿主身份 pending：会话身份不可判定。
  installSearchFeed(ctx, {
    backend: { async write() { n += 1; return { ok: true } } },
    config: { ...config, identity: { mode: 'auto', userId: 'u1', workspace: '' } },
    getHostUserId: () => '',
    getHostIdentityState: () => 'pending',
    log: (line) => logs.push(line),
  })
  state['tools/result'](withSession({ name: 'web_search', arguments: { query: 'c' } }), { value: { answer: 'C' } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(n, 0)
  assert.ok(logs.filter((l) => l.includes('searchFeed skip identity_required')).length >= 1)
})

test('advanced_search 触发；origin = tool:web_search#sha256(查询+本地日期)，同 key 重复事件同 origin', async () => {
  const { ctx, state } = fakeCtx()
  const writes = []
  installSearchFeed(ctx, {
    backend: { async write(q) { writes.push(q); return { ok: true, id: `n${writes.length}` } } }, config,
  })
  const exec = withSession({ name: 'advanced_search', callId: 'c2', arguments: { query: '潮州天气' } })
  state['tools/result'](exec, { value: { answer: '多云 26 度' } })
  state['tools/result'](exec, { value: { answer: '多云转晴 27 度' } })
  state['tools/result'](withSession({ name: 'advanced_search', arguments: { query: '潮州美食' } }), { value: { answer: '牛肉丸' } })
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(writes.length, 3, 'advanced_search 必须在白名单里')
  for (const w of writes) {
    // 16 位 hex 是跨进程稳定的去重键，backend/writer 依此复用同一节点。
    assert.match(w.origin, /^tool:web_search#[0-9a-f]{16}$/)
    assert.deepEqual(w.tags.slice(0, 1), ['web_search'])
  }
  assert.ok(writes[0].tags.includes('潮州天气'), 'tags 必须带查询词')
  assert.equal(writes[0].origin, writes[1].origin, '同查询同日必须撞同一个 key')
  assert.notEqual(writes[0].origin, writes[2].origin, '不同查询必须不同 key')
})

test('research 单独也认；长摘要逐条 ≤80 字、整体仍 ≤200', async () => {
  const { ctx, state } = fakeCtx()
  const writes = []
  installSearchFeed(ctx, { backend: { async write(q) { writes.push(q); return { ok: true, id: 'n1' } } }, config })
  state['tools/result'](withSession({ name: 'research', callId: 'c3', arguments: { query: '长摘要测试' } }), {
    value: {
      answer: 'A'.repeat(200),
      sources: [
        { title: 'T'.repeat(30), snippet: 'S'.repeat(200) },
        { title: '第二来源', snippet: 'B'.repeat(120) },
        { title: '第三来源', snippet: 'C'.repeat(120) },
      ],
    },
  })
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(writes.length, 1, 'research 工具必须触发反哺')
  const w = writes[0]
  assert.ok(w.text.length <= 200)
  const body = w.text.replace(/^搜索「[^」]*」：/, '')
  const parts = body.split('；')
  assert.ok(parts.length >= 2, 'answer 与 source 摘要必须分段')
  for (const part of parts) assert.ok(part.length <= 80, `单条摘要 ${part.length} 字超 80：${part}`)
})
