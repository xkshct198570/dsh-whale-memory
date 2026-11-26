/**
 * 身份 auto（审计 §4 P1）：宿主登录态 userId 的读取、缓存、回落与 source 标记。
 *
 * 全部用假 ctx + 假 deepseekAccount，不碰真实登录态/库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { installIdentitySource } from '../../src/host/identity-source.js'
import { isDelegatedHeader, resolveIdentity, sessionIdentityOf } from '../../src/host/identity.js'
import { Config } from '../../src/host/config.js'
import { createRoutes } from '../../src/host/routes.js'

/** @param {any} account */
function fakeCtx(account) {
  const state = { effects: 0 }
  const ctx = {
    get(name) { return name === 'deepseekAccount' ? account : undefined },
    effect(fn) { state.effects += 1; return fn() },
  }
  return { ctx, state }
}

const flush = async () => { await new Promise((resolve) => setImmediate(resolve)) }

test('identity source：auto 用宿主 userId，并缓存（TTL 内不重复读登录态）', async () => {
  let t = 1_000
  const account = {
    calls: 0,
    async getDeviceIdentity() { this.calls += 1; return { deviceId: 'dev', userId: 'host-user', osVersion: 'linux' } },
  }
  const { ctx } = fakeCtx(account)
  const source = installIdentitySource(ctx, { log: () => {}, now: () => t, ttlMs: 300_000 })
  // install 已后台刷新一次；await 拿到同一 in-flight 结果。
  const userId = await source.refresh()
  assert.equal(userId, 'host-user')
  assert.equal(source.getUserId(), 'host-user')
  assert.equal(account.calls, 1)

  t += 299_000
  assert.equal(source.getUserId(), 'host-user')
  assert.equal(account.calls, 1, 'TTL 内 getUserId 不得重复读登录态')

  t += 2_000
  source.getUserId() // 过期 → 后台刷新
  await flush()
  assert.equal(account.calls, 2, 'TTL 过期后必须后台重读')

  const ident = resolveIdentity(Config({ identity: { mode: 'auto' } }).identity, null, source.getUserId())
  assert.equal(ident.ok, true)
  assert.equal(ident.identity.userId, 'host-user')
  assert.equal(ident.source, 'host')
  assert.equal(ident.sources.userId, 'host')
})

test('identity source：未登录（userId 缺失）/服务缺失/读失败 一律回落空串且不抛', async () => {
  const logs = []
  const unsigned = installIdentitySource(fakeCtx({ async getDeviceIdentity() { return { osVersion: 'linux' } } }).ctx, { log: (l) => logs.push(l) })
  assert.equal(await unsigned.refresh(), '')

  const missing = installIdentitySource(fakeCtx(undefined).ctx, { log: () => {} })
  assert.equal(await missing.refresh(), '')

  const broken = installIdentitySource(fakeCtx({ async getDeviceIdentity() { throw new Error('boom') } }).ctx, { log: (l) => logs.push(l) })
  assert.equal(await broken.refresh(), '')
  assert.equal(broken.getUserId(), '')
  assert.ok(logs.some((line) => /identity source fail-open/.test(line)))
})

test('identity source：dispose 后不再返回值，也不触发刷新', async () => {
  const account = { calls: 0, async getDeviceIdentity() { this.calls += 1; return { userId: 'u1', osVersion: 'linux' } } }
  const source = installIdentitySource(fakeCtx(account).ctx, { log: () => {} })
  assert.equal(await source.refresh(), 'u1')
  source.dispose()
  assert.equal(source.getUserId(), '')
  assert.equal(await source.refresh(), '')
})

test('resolveIdentity auto：userId 优先级 hint > 宿主 > Config > local（hostState 缺省=旧链）', () => {
  const cfg = Config({ identity: { mode: 'auto', userId: 'cfg-user', roleId: 'cfg-role', workspace: 'web' } }).identity
  assert.equal(resolveIdentity(cfg, null, 'host-user').identity.userId, 'host-user')
  assert.equal(resolveIdentity(cfg, null, 'host-user').source, 'host')
  assert.equal(resolveIdentity(cfg, { userId: 'hint-user' }, 'host-user').identity.userId, 'hint-user')
  assert.equal(resolveIdentity(cfg, { userId: 'hint-user' }, 'host-user').source, 'hint')
  assert.equal(resolveIdentity(cfg, null, '').identity.userId, 'cfg-user')
  assert.equal(resolveIdentity(cfg, null, '').source, 'config')
  assert.equal(resolveIdentity(Config({}).identity, null, '').identity.userId, 'local')
  assert.equal(resolveIdentity(Config({}).identity, null, '').source, 'default')
  // 宿主身份不得挤掉 Config 的 role/workspace。
  const hostOnly = resolveIdentity(cfg, null, 'host-user')
  assert.equal(hostOnly.identity.roleId, 'cfg-role')
  assert.equal(hostOnly.identity.workspace, 'web')
  assert.deepEqual(hostOnly.sources, { userId: 'host', roleId: 'config', workspace: 'config' })
})

test('resolveIdentity auto 四态（S4 §5.5.1）：absent 才回落；pending/empty 拒；ready 用宿主', () => {
  const cfg = Config({ identity: { mode: 'auto', userId: 'cfg-user', workspace: 'web' } }).identity
  // absent（无账号服务）：Config 是稳定身份，允许回落。
  assert.equal(resolveIdentity(cfg, null, '', 'ws', 'absent').identity.userId, 'cfg-user')
  // pending/empty：身份未知，不回落出临时分区。
  assert.deepEqual(resolveIdentity(cfg, null, '', 'ws', 'pending'), { ok: false, error: 'identity_required' })
  assert.deepEqual(resolveIdentity(cfg, null, '', 'ws', 'empty'), { ok: false, error: 'identity_required' })
  // 对象形态（identity-source getState 可返回 { phase }）同样识别。
  assert.deepEqual(resolveIdentity(cfg, null, '', 'ws', { phase: 'pending' }), { ok: false, error: 'identity_required' })
  // ready：宿主 id 优先于 Config。
  assert.equal(resolveIdentity(cfg, null, 'host-user', 'ws', 'ready').identity.userId, 'host-user')
  // ready 但没有 id 是状态机不一致：按未就绪拒，不得回落。
  assert.deepEqual(resolveIdentity(cfg, null, '', 'ws', 'ready'), { ok: false, error: 'identity_required' })
  // hint.userId 是显式身份声明，即使宿主 pending 也生效（不是回落）。
  assert.equal(
    resolveIdentity(cfg, { userId: 'hint-user' }, '', 'ws', 'pending').identity.userId,
    'hint-user',
  )
})

test('identity source getState 四态：ready/empty/absent；读取异常保持 pending', async () => {
  const ready = installIdentitySource(fakeCtx({ async getDeviceIdentity() { return { userId: 'u1' } } }).ctx, { log: () => {} })
  assert.equal(ready.getState(), 'pending')
  assert.equal(await ready.refresh(), 'u1')
  assert.equal(ready.getState(), 'ready')

  const empty = installIdentitySource(fakeCtx({ async getDeviceIdentity() { return { osVersion: 'linux' } } }).ctx, { log: () => {} })
  assert.equal(await empty.refresh(), '')
  assert.equal(empty.getState(), 'empty')

  const absent = installIdentitySource(fakeCtx(undefined).ctx, { log: () => {} })
  assert.equal(absent.getState(), 'absent')
  assert.equal(await absent.refresh(), '')

  const broken = installIdentitySource(fakeCtx({ async getDeviceIdentity() { throw new Error('boom') } }).ctx, { log: () => {} })
  assert.equal(await broken.refresh(), '')
  assert.equal(broken.getState(), 'pending', '读取异常是未落定，不得冒充 empty（否则会被回落出临时分区）')
})

test('resolveIdentity fixed：行为不变，宿主 userId 不参与；缺 userId 仍报 identity_required', () => {
  const fixed = Config({ identity: { mode: 'fixed', userId: 'u1', roleId: 'r1', workspace: 'w1' } }).identity
  const ident = resolveIdentity(fixed, null, 'host-user')
  assert.equal(ident.identity.userId, 'u1')
  assert.equal(ident.source, 'config')

  const empty = Config({ identity: { mode: 'fixed', userId: '' } }).identity
  assert.deepEqual(resolveIdentity(empty, null, 'host-user'), { ok: false, error: 'identity_required' })
})

/** 起一个临时 server；返回 base + close。 */
async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('/stats：identity 带 source/workspaceSource 与 migration 只读字段，不泄漏正文', async () => {
  const seen = []
  const backend = {
    async stats() { return { totals: { nodes_total: 3 } } },
    async search(args) { seen.push(args.identity); return { hits: [], count: 0 } },
  }
  const migration = { state: { migratedFrom: 'hub-0.2.0', migratedAt: '2026-01-02T03:04:05.000Z', pending: false } }
  const config = { identity: { mode: 'auto', workspace: 'web' }, panel: { allowRemote: false } }
  const identityState = { lastRecall: { workspace: '/home/hy/hy', workspaceSource: 'session', userId: 'host-9', roleId: '', at: 1 } }
  const handler = createRoutes({ config, backend, getHostUserId: () => 'host-9', identityState, migration, log: () => {} })
  const { base, close } = await serve(handler)
  try {
    const res = await fetch(`${base}/whale-memory/api/stats`)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.identity, {
      mode: 'auto', userId: 'host-9', roleId: '', workspace: 'web', source: 'host', workspaceSource: 'config',
      // 会话维度只在 hook 里生效；路由读不到 header，只能回显最近一次召回真正用的 workspace。
      runtimeWorkspace: '/home/hy/hy', runtimeWorkspaceSource: 'session',
    })
    assert.deepEqual(body.migration, migration.state)
    assert.equal(JSON.stringify(body).includes('memory text'), false)

    // /config 也回 runtimeIdentity：面板页头用它显示会话 workspace（而不是 Config 值）。
    const cfgRes = await fetch(`${base}/whale-memory/api/config`)
    const cfgBody = await cfgRes.json()
    assert.equal(cfgRes.status, 200)
    assert.equal(cfgBody.runtimeIdentity.runtimeWorkspace, '/home/hy/hy')
    assert.equal(cfgBody.runtimeIdentity.runtimeWorkspaceSource, 'session')

    // 搜索请求显式带 workspace 时优先请求值；不带保持 Config。
    await fetch(`${base}/whale-memory/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', workspace: 'explicit' }),
    })
    await fetch(`${base}/whale-memory/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
    })
    assert.equal(seen[0].workspace, 'explicit')
    assert.equal(seen[1].workspace, 'web')
  } finally {
    await close()
  }
})


test('会话身份唯一判据：header 矩阵与 identity_required（工具/画像共用）', () => {
  const deps = {
    getIdentityCfg: () => ({ mode: 'auto' }),
    getIdentityHint: () => null,
    getHostUserId: () => 'u-host',
  }
  // 子代理判据矩阵：origin / delegationDepth / 两者 / 都不是。
  assert.equal(isDelegatedHeader({ origin: 'subagent' }), true)
  assert.equal(isDelegatedHeader({ delegationDepth: 1 }), true)
  assert.equal(isDelegatedHeader({ origin: 'subagent', delegationDepth: 2 }), true)
  assert.equal(isDelegatedHeader({ cwd: '/tmp/x' }), false)
  assert.equal(isDelegatedHeader(null), false)

  // 会话身份：缺 header / 缺 cwd / fixed 缺 userId → identity_required；正常 → host+session 来源。
  assert.deepEqual(sessionIdentityOf({ header: null, ...deps }), { ok: false, error: 'identity_required' })
  assert.deepEqual(sessionIdentityOf({ header: {}, ...deps }), { ok: false, error: 'identity_required' })
  assert.deepEqual(
    sessionIdentityOf({ header: { cwd: '/tmp/ws' }, ...deps, getIdentityCfg: () => ({ mode: 'fixed' }) }),
    { ok: false, error: 'identity_required' },
  )
  const got = sessionIdentityOf({ header: { cwd: '/tmp/ws' }, ...deps })
  assert.equal(got.ok, true)
  assert.equal(got.identity.userId, 'u-host')
  assert.equal(got.identity.workspace, '/tmp/ws')
  assert.equal(got.sources.userId, 'host')
  assert.equal(got.sources.workspace, 'session')

  // S4：宿主身份 pending/empty 时会话身份不可判定，即使 Config 有 userId 也不回落。
  const cfgWithUser = { getIdentityCfg: () => ({ mode: 'auto', userId: 'cfg-user' }), getIdentityHint: () => null, getHostUserId: () => '' }
  for (const phase of ['pending', 'empty']) {
    assert.deepEqual(
      sessionIdentityOf({ header: { cwd: '/tmp/ws' }, ...cfgWithUser, getHostIdentityState: () => phase }),
      { ok: false, error: 'identity_required' },
      `${phase} 不得回落 Config 分区`,
    )
  }
  // absent（老宿主无账号服务）按原链落 Config，且 workspace 仍是会话 cwd。
  const absent = sessionIdentityOf({ header: { cwd: '/tmp/ws' }, ...cfgWithUser, getHostIdentityState: () => 'absent' })
  assert.equal(absent.ok, true)
  assert.equal(absent.identity.userId, 'cfg-user')
  assert.equal(absent.identity.workspace, '/tmp/ws')
})
