/**
 * Config 契约回归（架构书 §10.2/§18.1）：
 * 1) 空配置必须通过 Config 校验，文档字段存在且默认值正确；
 * 2) /config GET 回显全部组（值解 Ref），POST 只按叶子深合并，未提交字段不回落默认；
 * 3) 保存失败必须 501，不许伪成功。
 *
 * 全部用 fake configEditor + 临时 HTTP server，不碰真实 profile/库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Config } from '../../src/host/config.js'
import { CONFIG_GROUPS, createRoutes, deepMergeLeaf } from '../../src/host/routes.js'
import { resolveIdentity } from '../../src/host/identity.js'

const read = (v) => (v && typeof v.get === 'function' ? v.get() : v)

test('空配置通过 Config 校验，文档要求的字段与默认值齐全', () => {
  const cfg = Config({})

  assert.equal(read(cfg.dataDir), '')
  assert.equal(read(cfg.backend.id), '')
  assert.equal(read(cfg.backend.mode), 'local')

  assert.deepEqual(read(cfg.recall.injectLevels), ['core', 'important'])
  assert.equal(read(cfg.recall.showSources), true)

  assert.equal(read(cfg.write.model), '')
  assert.deepEqual(read(cfg.write.ignorePatterns), [])

  assert.equal(read(cfg.sync.mode), 'off')
  assert.equal(read(cfg.sync.intervalMin), 15)
  assert.equal(read(cfg.sync.httpTimeoutMs), 800)
  assert.equal(read(cfg.sync.batch), 100)

  // 现有字段不得被删/改默认
  assert.equal(read(cfg.recall.charBudget), 1500)
  assert.equal(read(cfg.write.dailyCap), 200)
  assert.equal(read(cfg.write.judge), 'rules')
  assert.equal(read(cfg.write.searchTtlHours), 24)
  assert.equal(read(cfg.reflect.maxItems), 8)
})

test('volatile/长度上限约束：identity 四字段、reflect.maxItems、advanced.traceId', () => {
  const cfg = Config({})
  for (const key of ['mode', 'userId', 'roleId', 'workspace']) {
    assert.equal(typeof cfg.identity[key].get, 'function', `identity.${key} 必须 .volatile()`)
  }
  assert.equal(typeof cfg.reflect.maxItems.get, 'function', 'reflect.maxItems 必须 .volatile()')

  assert.doesNotThrow(() => Config({ identity: { userId: 'u'.repeat(128), roleId: 'r'.repeat(64), workspace: 'w'.repeat(64) } }))
  assert.throws(() => Config({ identity: { userId: 'u'.repeat(129) } }))
  assert.throws(() => Config({ identity: { roleId: 'r'.repeat(65) } }))
  assert.throws(() => Config({ identity: { workspace: 'w'.repeat(65) } }))

  assert.doesNotThrow(() => Config({ advanced: { traceId: 't'.repeat(64) } }))
  assert.throws(() => Config({ advanced: { traceId: 't'.repeat(65) } }))

  assert.throws(() => Config({ sync: { mode: 'bogus' } }))
  assert.throws(() => Config({ recall: { injectLevels: ['bogus'] } }))
})

test('identity Ref 解包：Config 输出经 resolveIdentity 后是纯字符串', () => {
  const fixed = Config({ identity: { mode: 'fixed', userId: 'u1', roleId: 'r1', workspace: 'w1' } })
  assert.deepEqual(resolveIdentity(fixed.identity), {
    ok: true,
    identity: { userId: 'u1', roleId: 'r1', workspace: 'w1' },
    source: 'config',
    sources: { userId: 'config', roleId: 'config', workspace: 'config' },
  })

  assert.deepEqual(resolveIdentity(Config({}).identity), {
    ok: true,
    identity: { userId: 'local', roleId: '', workspace: '' },
    source: 'default',
    sources: { userId: 'default', roleId: 'default', workspace: 'default' },
  })

  assert.deepEqual(resolveIdentity(fixed.identity, { userId: 'u2', roleId: '' }), {
    ok: true,
    identity: { userId: 'u2', roleId: '', workspace: 'w1' },
    source: 'hint',
    sources: { userId: 'hint', roleId: 'hint', workspace: 'config' },
  })

  const missing = Config({ identity: { mode: 'fixed', userId: '' } })
  assert.deepEqual(resolveIdentity(missing.identity), { ok: false, error: 'identity_required' })
})

test('deepMergeLeaf：对象递归、数组/标量替换、未提交叶子保留', () => {
  const merged = deepMergeLeaf(
    { write: { dailyCap: 200, reviewMode: 'shadow', tags: ['a'] }, sync: { bridgeUrl: 'http://bridge' } },
    { write: { tags: ['b'], enabled: false } },
  )
  assert.deepEqual(merged.write, { dailyCap: 200, reviewMode: 'shadow', tags: ['b'], enabled: false })
  assert.equal(merged.sync.bridgeUrl, 'http://bridge')
})

/** fake configEditor：edit 用回调合并 current，configuration() 供回读。 */
function fakeEditor(initial) {
  const state = { current: structuredClone(initial), edits: 0, entry: null }
  const ctx = {
    fiber: { entry: { id: 'whale-memory' } },
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        async edit(entry, change) {
          state.edits += 1
          state.entry = entry
          state.current = change(state.current)
        },
        configuration() {
          return [{ entry: state.entry, inherited: {}, override: state.current }]
        },
      }
    },
  }
  return { ctx, state }
}

const identity = { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' }

function baseConfig(overrides = {}) {
  return {
    identity: { ...identity },
    panel: { allowRemote: false },
    ...overrides,
  }
}

function startServer(config, ctx) {
  return new Promise((resolve) => {
    const server = http.createServer(createRoutes({ config, backend: {}, ctx, log: () => {} }))
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

async function getConfig(base) {
  const res = await fetch(`${base}/whale-memory/api/config`)
  assert.equal(res.status, 200)
  return await res.json()
}

async function postConfig(base, config) {
  const res = await fetch(`${base}/whale-memory/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config }),
  })
  return { status: res.status, body: await res.json() }
}

test('GET /config：回显全部组，值解 Ref 且含文档字段', async () => {
  // 用真实 Config 输出（volatile 字段是 Ref）验证解 Ref 链路
  const runtime = Config({
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    write: { dailyCap: 120, enabled: true },
    sync: { bridgeUrl: 'http://127.0.0.1:3999/bridge' },
  })
  const { base, close } = await startServer(runtime, fakeEditor({}).ctx)
  try {
    const body = await getConfig(base)
    assert.equal(body.ok, true)
    for (const group of CONFIG_GROUPS) assert.ok(body.config[group] && typeof body.config[group] === 'object', `缺少组 ${group}`)
    assert.equal(body.config.dataDir, '')
    assert.deepEqual(body.config.recall.injectLevels, ['core', 'important'])
    assert.equal(body.config.recall.showSources, true)
    assert.equal(body.config.recall.charBudget, 1500)
    assert.equal(body.config.write.model, '')
    assert.deepEqual(body.config.write.ignorePatterns, [])
    assert.equal(body.config.write.dailyCap, 120)
    assert.equal(body.config.sync.mode, 'off')
    assert.equal(body.config.sync.intervalMin, 15)
    assert.equal(body.config.sync.httpTimeoutMs, 800)
    assert.equal(body.config.sync.batch, 100)
    assert.equal(body.config.sync.bridgeUrl, 'http://127.0.0.1:3999/bridge')
    assert.equal(body.config.privacy.redact, true)
    assert.equal(body.config.embed.enabled, false)
    assert.equal(body.config.panel.pollMs, 60000)
    assert.equal(body.config.advanced.traceId, '')
    // 冲突标注已从 API 删除：只保留真实契约，不把内部文档冲突暴露给调用方。
    assert.equal(body.notes, undefined)
  } finally { await close() }
})

test('POST /config：只带 {write:{enabled:false}} 时 dailyCap/reviewMode 仍在', async () => {
  const runtime = baseConfig({ write: { enabled: true, reviewMode: 'shadow', dailyCap: 120 } })
  const { ctx, state } = fakeEditor({ write: { enabled: true, reviewMode: 'shadow', dailyCap: 120 } })
  const { base, close } = await startServer(runtime, ctx)
  try {
    const saved = await postConfig(base, { write: { enabled: false } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.equal(state.edits, 1)
    assert.equal(state.current.write.enabled, false)

    const body = await getConfig(base)
    assert.equal(body.config.write.enabled, false)
    assert.equal(body.config.write.dailyCap, 120, 'dailyCap 不得回落默认 200')
    assert.equal(body.config.write.reviewMode, 'shadow', 'reviewMode 不得回落默认')
  } finally { await close() }
})

test('POST /config：只带 {sync:{enabled:true}} 时 bridgeUrl/dryRun 不丢', async () => {
  const runtime = baseConfig({ sync: { enabled: false, bridgeUrl: 'http://127.0.0.1:3999/bridge', dryRun: false } })
  const { ctx } = fakeEditor({ sync: { enabled: false } })
  const { base, close } = await startServer(runtime, ctx)
  try {
    const saved = await postConfig(base, { sync: { enabled: true } })
    assert.equal(saved.status, 200)
    const body = await getConfig(base)
    assert.equal(body.config.sync.enabled, true)
    assert.equal(body.config.sync.bridgeUrl, 'http://127.0.0.1:3999/bridge')
    assert.equal(body.config.sync.dryRun, false)
  } finally { await close() }
})

test('POST /config：数组按替换处理（不与被覆盖数组逐项合并）', async () => {
  const runtime = baseConfig({ write: { ignorePatterns: ['旧'] } })
  const { ctx } = fakeEditor({ write: { ignorePatterns: ['旧', '旧二'] } })
  const { base, close } = await startServer(runtime, ctx)
  try {
    const saved = await postConfig(base, { write: { ignorePatterns: ['新'] } })
    assert.equal(saved.status, 200)
    const body = await getConfig(base)
    assert.deepEqual(body.config.write.ignorePatterns, ['新'])
  } finally { await close() }
})

test('POST /config：无 configEditor -> 501 config_save_unavailable（不伪成功）', async () => {
  const runtime = baseConfig()
  const { base, close } = await startServer(runtime, undefined)
  try {
    const saved = await postConfig(base, { write: { enabled: false } })
    assert.equal(saved.status, 501)
    assert.equal(saved.body.ok, false)
    assert.equal(saved.body.error, 'config_save_unavailable')
  } finally { await close() }
})

test('POST /config：editor 抛错 -> 501 config_save_failed', async () => {
  const runtime = baseConfig()
  const ctx = {
    fiber: { entry: { id: 'whale-memory' } },
    get: () => ({ async edit() { throw new Error('loader_busy') } }),
  }
  const { base, close } = await startServer(runtime, ctx)
  try {
    const saved = await postConfig(base, { write: { enabled: false } })
    assert.equal(saved.status, 501)
    assert.equal(saved.body.error, 'config_save_failed')
  } finally { await close() }
})

test('POST /config：非对象/无白名单键 -> 400 invalid_config', async () => {
  const runtime = baseConfig()
  const { base, close } = await startServer(runtime, fakeEditor({}).ctx)
  try {
    for (const bad of [[], 'x', 42, { bogus: 1 }]) {
      const saved = await postConfig(base, bad)
      assert.equal(saved.status, 400, `非法载荷 ${JSON.stringify(bad)} 应 400`)
      assert.equal(saved.body.error, 'invalid_config')
    }
  } finally { await close() }
})

test('tools 组：GET 回显默认值、POST 可保存且不丢其它组（白名单必须含 tools）', async () => {
  const runtime = baseConfig({ write: { enabled: true, dailyCap: 120 }, tools: { enabled: true, maxWritesPerTurn: 5 } })
  const { ctx, state } = fakeEditor({ write: { enabled: true, dailyCap: 120 }, tools: { enabled: true, maxWritesPerTurn: 5 } })
  const { base, close } = await startServer(runtime, ctx)
  try {
    const body = await getConfig(base)
    assert.deepEqual(body.config.tools, { enabled: true, maxWritesPerTurn: 5 })

    const saved = await postConfig(base, { tools: { enabled: false, maxWritesPerTurn: 3 } })
    assert.equal(saved.status, 200, `tools 组保存被拒：${JSON.stringify(saved.body)}`)
    assert.equal(saved.body.ok, true)
    const after = await getConfig(base)
    assert.deepEqual(after.config.tools, { enabled: false, maxWritesPerTurn: 3 })
    assert.equal(after.config.write.dailyCap, 120, 'tools 组保存不得把别的组回落默认')
    assert.equal(state.edits, 1)
  } finally { await close() }
})

test('Config 的每个可选组都必须登记在 CONFIG_GROUPS（防新组漏白名单=设置页存不了）', () => {
  const groups = Object.keys(Config({})).filter((key) => key !== 'dataDir')
  const missing = groups.filter((key) => !CONFIG_GROUPS.includes(key))
  assert.deepEqual(missing, [], `CONFIG_GROUPS 缺少 Config 组：${missing.join(',')}`)
})
