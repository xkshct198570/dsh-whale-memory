import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReflectPrompt, parseReflectOutput } from '../../src/core/reflect-prompt.js'
import { runReflect, installReflectScheduler } from '../../src/core/reflect.js'

const identity = { userId: 'u1', roleId: '', workspace: '/work/ws' }

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

test('runReflect：读 episodic → llm → 落库带身份/ingestPolicy/layer，日志无正文', async () => {
  const writes = []
  const backend = {
    async listEpisodic(limit, opts) {
      assert.equal(opts.identity.workspace, '/work/ws')
      return [{ text: '昨天查了潮州天气' }, { text: '网关端口 3982' }]
    },
    async write(q) { writes.push(q); return { ok: true, action: 'ADD' } },
  }
  const llm = { async *stream() {
    yield { type: 'text-delta', text: '[{"text":"潮州天气多云","type":"semantic"},' }
    yield { type: 'text-delta', text: '{"text":"网关端口是 3982","type":"procedural"}]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const logs = []
  const r = await runReflect({
    backend, llm, selection: { provider: 'p', model: 'm' }, identity, config: { reflect: { maxItems: 8 } },
    log: (line) => logs.push(line),
  })
  assert.equal(r.ok, true)
  assert.equal(r.added, 2)
  assert.equal(writes.length, 2)
  // 身份显式下传，不靠 Config 现取（S4 §5.5.1）。
  assert.deepEqual(writes[0].identity, identity)
  // ingestPolicy 同源 shared/ingest-policy：auto + confidence 1 + 拒任务句。
  assert.deepEqual(writes[0].ingestPolicy, { mode: 'auto', minConfidence: 0.55, dropTaskInstructions: true, confidence: 1 })
  assert.equal(writes[0].source, 'self')
  assert.equal(writes[0].origin, 'reflect')
  // layer：procedural≈lesson、semantic≈fact（§5.7.2）。
  assert.equal(writes[0].layer, 'fact')
  assert.equal(writes[1].layer, 'lesson')
  // 日志只计数，不含正文。
  const done = logs.find((line) => line.includes('reflect done'))
  assert.match(done, /added=2 review=0 rejected=0/)
  assert.equal(/潮州|3982/.test(String(done)), false)
})

test('runReflect：缺身份一律 identity_required，且零后端/零模型调用', async () => {
  let touched = 0
  const backend = {
    async listEpisodic() { touched += 1; return [] },
    async write() { touched += 1; return { ok: true } },
  }
  const llm = { async *stream() { touched += 1 } }
  const logs = []
  for (const bad of [null, undefined, {}, { userId: 'u1' }, { workspace: 'ws' }, { userId: 'u1', workspace: '  ' }]) {
    const r = await runReflect({ backend, llm, selection: { provider: 'p', model: 'm' }, identity: bad, config: {}, log: (l) => logs.push(l) })
    assert.deepEqual(r, { ok: false, reason: 'identity_required' })
  }
  assert.equal(touched, 0)
  assert.ok(logs.some((line) => line.includes('reflect skip identity_required')))
})

test('runReflect：计数 added/review/rejected 按真实 write 结果（durable/task/歧义）', async () => {
  const backend = {
    async listEpisodic() { return [{ text: '素材' }] },
    async write(q) {
      if (q.text.includes('规则')) return { ok: true, action: 'MERGE' }
      if (q.text.includes('候选')) return { ok: true, action: 'CANDIDATE' }
      return { ok: false, action: 'REJECT', error: 'gate:task' }
    },
  }
  const body = '[{"text":"规则A","type":"procedural"},{"text":"候选B"},{"text":"任务C"}]'
  const llm = { async *stream() { yield { type: 'text-delta', text: body } } }
  const logs = []
  const r = await runReflect({
    backend, llm, selection: { provider: 'p', model: 'm' }, identity, config: {}, log: (line) => logs.push(line),
  })
  assert.equal(r.added, 1)
  assert.equal(r.review, 1)
  assert.equal(r.rejected, 1)
  assert.match(logs.find((line) => line.includes('reflect done')), /added=1 review=1 rejected=1 duplicate=0 failed=0/)
})

test('runReflect：判重命中（NOOP）不计 added；基础设施失败必须 ok:false（不冒充成功）', async () => {
  const body = '[{"text":"重复条目","type":"semantic"},{"text":"超时条目","type":"semantic"}]'
  const llm = { async *stream() { yield { type: 'text-delta', text: body } } }
  const backend = {
    async listEpisodic() { return [{ text: '素材' }] },
    async write(q) {
      if (q.text.includes('重复')) return { ok: true, action: 'NOOP', duplicate: true }
      return { ok: false, action: 'TIMEOUT', reason: 'queue_wait_timeout' }
    },
  }
  const logs = []
  const r = await runReflect({
    backend, llm, selection: { provider: 'p', model: 'm' }, identity, config: {}, log: (line) => logs.push(line),
  })
  assert.equal(r.ok, false, '队列超时是基础设施失败，不能当成功')
  assert.equal(r.reason, 'write_failed')
  assert.equal(r.added, 0)
  assert.equal(r.duplicate, 1)
  assert.equal(r.failed, 1)
  const done = logs.find((line) => line.includes('reflect done'))
  assert.match(done, /added=0 review=0 rejected=0 duplicate=1 failed=1/)
  assert.equal(/重复条目|超时条目/.test(String(done)), false, '日志不得含正文')
})

test('runReflect：早退 reason 有可见日志（llm_unavailable/no_model/memory_pressure 不静默）', async () => {
  const logs = []
  await runReflect({ backend: {}, llm: null, selection: {}, config: {}, identity, log: (l) => logs.push(l) })
  await runReflect({ backend: {}, llm: { async *stream() {} }, selection: {}, config: {}, identity, log: (l) => logs.push(l) })
  assert.ok(logs.some((line) => line.includes('reflect skip reason=llm_unavailable')))
  assert.ok(logs.some((line) => line.includes('reflect skip reason=no_model')))
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
  const r = await runReflect({ backend, llm, selection: { provider: 'p', model: 'm' }, identity, config: { reflect: {} }, log: (line) => logs.push(line) })
  assert.equal(r.ok, true)
  assert.equal(r.added, 1, '双写修复后应解析出 1 条')
  assert.equal(writes.length, 1)
  assert.equal(logs.some((line) => line.includes('reflect parse empty')), false)
})

test('runReflect：无素材/无 llm 不写；有身份才继续', async () => {
  const backend = { async listEpisodic() { return [] }, async write() { throw new Error('no') } }
  // 无 llm：先于取素材失败（既有顺序不变）。
  assert.equal((await runReflect({ backend, llm: {}, selection: {}, config: {}, identity })).reason, 'llm_unavailable')
  // 有 llm 无素材：ok + 零计数。
  const none = await runReflect({
    backend, llm: { async *stream() {} }, selection: { provider: 'p', model: 'm' }, config: {}, identity,
  })
  assert.deepEqual(none, { ok: true, added: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, material: 0, items: 0, reason: 'no_material' })
  assert.equal((await runReflect({ backend, llm: { async *stream() {} }, selection: {}, config: {}, identity })).reason, 'no_model')
})

/** 假事件总线：记录 listener，dispose 后可验证反注册。 */
function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(ev, fn) { handlers.set(ev, fn); return () => handlers.delete(ev) },
    },
  }
}

/** 假 keeper：enqueue 记 payload，status 可编程，runNow 立即 done。 */
function fakeKeeper({ jobs = [], runNowResult = { state: 'done', result: { ok: true, added: 1 } } } = {}) {
  const enqueued = []
  const registered = new Map()
  return {
    enqueued, registered,
    register(kind, fn) { registered.set(kind, fn); return this },
    status() { return { running: 0, queued: 0, failed: 0, jobs } },
    enqueue(kind, payload) { enqueued.push({ kind, payload }); return enqueued.length },
    async runNow(kind, payload) { enqueued.push({ kind, payload }); return runNowResult },
  }
}

const baseConfig = (over = {}) => ({
  reflect: { enabled: true, idleMinutes: 30, maxRunsPerDay: 24, maxItems: 8 },
  maintenance: { suppressWindows: [] },
  ...over,
})

test('scheduleAuto：单一自动闸（enabled/队列/日限/峰时），payload 带身份与 sessionId', () => {
  const { ctx } = fakeCtx()
  const keeper = fakeKeeper()
  const logs = []
  const sched = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig(), getLlm: () => undefined, getSelection: () => undefined, keeper,
    log: (line) => logs.push(line),
  })
  try {
    const out = sched.scheduleAuto({ identity, sessionId: 's1', reason: 'turn_steps' })
    assert.equal(out.ok, true)
    assert.equal(out.scheduled, true)
    assert.deepEqual(keeper.enqueued[0], { kind: 'reflect', payload: { identity, sessionId: 's1', reason: 'turn_steps' } })
    assert.ok(logs.some((line) => /reflect scheduled source=turn_steps/.test(line)))

    // 队列已有 → queued（精确 countActive，不依赖 200 行快照）。
    keeper.countActive = () => 1
    keeper.status = () => ({ running: 0, queued: 0, failed: 0, jobs: [] })
    assert.deepEqual(sched.scheduleAuto({ identity }), { ok: false, reason: 'queued' })
    keeper.countActive = () => 0

    // 日限（本地自然日）：maxRuns=1，第一次已计入。
    keeper.status = () => ({ running: 0, queued: 0, failed: 0, jobs: [] })
    const limited = installReflectScheduler(ctx, {
      backend: {}, config: baseConfig({ reflect: { enabled: true, maxRunsPerDay: 1, idleMinutes: 30 } }),
      getLlm: () => undefined, getSelection: () => undefined, keeper: fakeKeeper(), log: () => {},
    })
    try {
      assert.equal(limited.scheduleAuto({ identity }).ok, true)
      assert.deepEqual(limited.scheduleAuto({ identity }), { ok: false, reason: 'daily_limit' })
    } finally { limited.dispose() }

    // disabled。
    const off = installReflectScheduler(ctx, {
      backend: {}, config: baseConfig({ reflect: { enabled: false } }), getLlm: () => undefined, getSelection: () => undefined, keeper: fakeKeeper(), log: () => {},
    })
    try { assert.deepEqual(off.scheduleAuto({ identity }), { ok: false, reason: 'disabled' }) } finally { off.dispose() }

    // 身份缺失。
    assert.deepEqual(sched.scheduleAuto({ identity: { userId: 'u1', workspace: '' } }), { ok: false, reason: 'identity_required' })
  } finally { sched.dispose() }
})

test('scheduleAuto 峰时：窗口内跳过自动；手动 trigger 绕过窗口/日限/enabled 但仍要求身份', async () => {
  const { ctx } = fakeCtx()
  const keeper = fakeKeeper()
  const logs = []
  // 03:30 本地时间，落在 "00:00-08:00"。
  const at = () => new Date(2026, 10, 27, 3, 30, 0).getTime()
  const sched = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig({ maintenance: { suppressWindows: ['00:00-08:00', 'bad-value'] } }),
    getLlm: () => undefined, getSelection: () => undefined, keeper, log: (line) => logs.push(line), now: at,
  })
  try {
    assert.deepEqual(sched.scheduleAuto({ identity }), { ok: false, reason: 'suppress_window' })
    assert.equal(keeper.enqueued.length, 0)
    assert.ok(logs.some((line) => line.includes('suppressWindows ignored invalid entry="bad-value"')))
    // 坏值只记一次。
    sched.scheduleAuto({ identity })
    assert.equal(logs.filter((line) => line.includes('invalid entry="bad-value"')).length, 1)

    // 手动：显式动作，窗口内照跑；payload 带身份。
    const out = await sched.trigger({ identity, sessionId: 's1', reason: 'manual' })
    assert.equal(out.ok, true)
    assert.equal(keeper.enqueued.at(-1).payload.identity.workspace, '/work/ws')
    assert.equal(keeper.enqueued.at(-1).payload.reason, 'manual')

    // 手动仍要求身份。
    assert.deepEqual(await sched.trigger({ identity: null }), { ok: false, reason: 'identity_required' })
  } finally { sched.dispose() }

  // 跨午夜窗口：23:00-07:00 在 03:30 内、12:00 外。
  const cross = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig({ maintenance: { suppressWindows: ['23:00-07:00'] } }),
    getLlm: () => undefined, getSelection: () => undefined, keeper: fakeKeeper(), log: () => {}, now: at,
  })
  try { assert.equal(cross.scheduleAuto({ identity }).reason, 'suppress_window') } finally { cross.dispose() }
  const noon = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig({ maintenance: { suppressWindows: ['23:00-07:00'] } }),
    getLlm: () => undefined, getSelection: () => undefined, keeper: fakeKeeper(), log: () => {},
    now: () => new Date(2026, 10, 27, 12, 0, 0).getTime(),
  })
  try { assert.equal(noon.scheduleAuto({ identity }).ok, true) } finally { noon.dispose() }
})

test('空闲 tick：只用最近会话身份；没有会话身份就跳过（绝不写共享分区）', async () => {
  const { ctx } = fakeCtx()
  const keeper = fakeKeeper()
  const logs = []
  let t = new Date(2026, 10, 27, 12, 0, 0).getTime()
  const state = { got: { identity, sessionId: 's9' } }
  const sched = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig({ reflect: { enabled: true, idleMinutes: 5, maxRunsPerDay: 24 } }),
    getLlm: () => undefined, getSelection: () => undefined, keeper,
    getSessionIdentity: () => state.got,
    log: (line) => logs.push(line), now: () => t,
  })
  try {
    assert.deepEqual(await sched.tick(), { skipped: 'not_idle' })
    t += 6 * 60_000
    const out = await sched.tick()
    assert.equal(out.ok, true)
    assert.deepEqual(keeper.enqueued[0].payload, { identity, sessionId: 's9', reason: 'idle' })

    // 无最近会话身份：跳过并留可见日志、零入队。
    const before = keeper.enqueued.length
    state.got = null
    t += 6 * 60_000
    const skipped = await sched.tick()
    assert.equal(skipped.skipped, 'identity_required')
    assert.equal(keeper.enqueued.length, before)
    assert.equal(logs.filter((line) => line.includes('no recent session identity')).length, 1, '空闲跳过日志只打一次（不刷屏）')
    // 第二次 tick 仍无身份：不得重复打印同一跳过日志。
    assert.deepEqual(await sched.tick(), { skipped: 'identity_required' })
    assert.equal(logs.filter((line) => line.includes('no recent session identity')).length, 1)
  } finally { sched.dispose() }
})

test('无 keeper 直跑：getLlm 同步抛错不会让 running 永久卡死', async () => {
  const { ctx } = fakeCtx()
  const logs = []
  const sched = installReflectScheduler(ctx, {
    backend: {}, config: baseConfig(), getLlm: () => { throw new Error('llm service unavailable') },
    getSelection: () => undefined, log: (line) => logs.push(line),
  })
  try {
    assert.equal(sched.scheduleAuto({ identity }).ok, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(logs.some((line) => line.includes('reflect run fail-open')))
    assert.equal(sched.scheduleAuto({ identity }).ok, true, 'running 必须释放，不能永久 queued')
  } finally { sched.dispose() }
})

test('keeper handler：基础设施写失败抛出（job 可退避重试），价值闸拒绝仍 done', async () => {
  const { ctx } = fakeCtx()
  const keeper = fakeKeeper()
  const llm = { async *stream() { yield { type: 'text-delta', text: '[{"text":"条目","type":"semantic"}]' } } }
  const sched = installReflectScheduler(ctx, {
    backend: {
      async listEpisodic() { return [{ text: '素材' }] },
      async write() { return { ok: false, action: 'TIMEOUT', reason: 'queue_wait_timeout' } },
    },
    config: {}, getLlm: () => llm, getSelection: () => ({ provider: 'p', model: 'm' }), keeper, log: () => {},
  })
  try {
    const handler = keeper.registered.get('reflect')
    await assert.rejects(() => handler({ identity }), /reflect_write_failed:queue_wait_timeout/)
  } finally { sched.dispose() }
})

test('keeper handler 用 payload 身份执行；payload 缺身份 → identity_required（不现取 Config）', async () => {
  const { ctx } = fakeCtx()
  const keeper = fakeKeeper()
  const sched = installReflectScheduler(ctx, {
    backend: { async listEpisodic() { return [] } },
    config: { identity: { userId: 'cfg-user', workspace: 'cfg-ws' }, reflect: {} },
    getLlm: () => undefined, getSelection: () => undefined, keeper, log: () => {},
  })
  try {
    const handler = keeper.registered.get('reflect')
    assert.equal(typeof handler, 'function')
    const missing = await handler({})
    assert.deepEqual(missing, { ok: false, reason: 'identity_required' })
    // payload 有身份 → 走到 llm_unavailable（说明没被 Config 身份兜底，而是按 payload 继续）。
    const got = await handler({ identity })
    assert.equal(got.reason, 'llm_unavailable')
  } finally { sched.dispose() }
})

test('调度器 pre-step 监听必须返回 next() 的 decision（防 decision.kind 崩）', async () => {
  const { ctx, handlers } = fakeCtx()
  const sched = installReflectScheduler(ctx, {
    backend: { async listEpisodic() { return [] } },
    config: { reflect: { enabled: false } },
    getLlm: () => undefined,
    getSelection: () => undefined,
  })
  try {
    const decision = { kind: 'enter' }
    const ret = await handlers.get('agent/pre-step')({ agent: { session: { id: 's' } } }, async () => decision)
    assert.equal(ret, decision)
    assert.equal(ret.kind, 'enter')
  } finally { sched.dispose() }
})
