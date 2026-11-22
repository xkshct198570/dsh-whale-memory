/**
 * 会话 workspace 维度（lead 追加）：从 `agent.session.header.cwd` 派生 workspace，
 * 让不同 DSH 工作区落不同记忆分区；现网 Config workspace='web' 非空 ⇒ 行为不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveIdentity, deriveWorkspace } from '../../src/host/identity.js'
import { Config } from '../../src/host/config.js'
import { installHook } from '../../src/host/hook.js'

function fakeCtx() {
  const state = { pre: null, context: null }
  const ctx = {
    on(ev, fn) { if (ev === 'agent/pre-step') state.pre = fn; return () => {} },
    systemPrompt: { context(def) { state.context = def; return () => {} } },
    effect(fn) { return fn() },
  }
  return { ctx, state }
}

const userMsg = [{ source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] }]

test('deriveWorkspace：绝对路径、不同工作区不撞名、无 cwd 返回空', () => {
  const a = deriveWorkspace({ cwd: '/home/hy/hy' })
  const b = deriveWorkspace({ cwd: '/home/hy/网页端聊天' })
  assert.equal(a, '/home/hy/hy')
  assert.equal(b, '/home/hy/网页端聊天')
  assert.notEqual(a, b)
  assert.equal(deriveWorkspace({}), '')
  assert.equal(deriveWorkspace(null), '')
  assert.equal(deriveWorkspace({ cwd: '  ' }), '')
  // 相对路径规范化为绝对路径（不再用 basename，避免 /home/hy 与 /home/hy/hy 撞名）。
  assert.equal(deriveWorkspace({ cwd: 'sub/dir' }), `${process.cwd()}/sub/dir`)
})

test('deriveWorkspace：超长路径稳定压缩到 ≤64（sha256 前 16 位 + 尾部）', () => {
  const long = `/tmp/${'深度目录'.repeat(30)}/leaf`
  const first = deriveWorkspace({ cwd: long })
  const second = deriveWorkspace({ cwd: long })
  assert.equal(first.length, 64)
  assert.match(first, /^h:[0-9a-f]{16}:/)
  const hash = createHash('sha256').update(long).digest('hex').slice(0, 16)
  assert.ok(first.startsWith(`h:${hash}:`))
  assert.equal(first, second, '同一路径必须得到同一压缩串')
  assert.notEqual(first, deriveWorkspace({ cwd: long + '2' }))
})

test('resolveIdentity：workspace 空时按会话派生，source=session；不同会话 workspace 不同', () => {
  const cfg = Config({ identity: { mode: 'auto', workspace: '' } }).identity
  const one = resolveIdentity(cfg, null, '', '/home/hy/hy')
  const two = resolveIdentity(cfg, null, '', '/home/hy/网页端聊天')
  assert.equal(one.identity.workspace, '/home/hy/hy')
  assert.equal(two.identity.workspace, '/home/hy/网页端聊天')
  assert.notEqual(one.identity.workspace, two.identity.workspace)
  assert.equal(one.source, 'session')
  assert.equal(one.sources.workspace, 'session')

  // 宿主 userId 存在时，汇总 source 仍标 session（记忆分区看 workspace），userId 来源留在 sources。
  const withHost = resolveIdentity(cfg, null, 'host-user', '/home/hy/hy')
  assert.equal(withHost.identity.userId, 'host-user')
  assert.equal(withHost.identity.workspace, '/home/hy/hy')
  assert.equal(withHost.source, 'session')
  assert.equal(withHost.sources.userId, 'host')
  assert.equal(withHost.sources.workspace, 'session')
})

test('resolveIdentity：cfg.workspace 非空（现网 web）不被会话覆盖；hint 优先', () => {
  const cfg = Config({ identity: { mode: 'auto', workspace: 'web' } }).identity
  const ident = resolveIdentity(cfg, null, '', '/home/hy/hy')
  assert.equal(ident.identity.workspace, 'web')
  assert.equal(ident.sources.workspace, 'config')
  assert.equal(ident.source, 'config')

  const hinted = resolveIdentity(cfg, { workspace: 'explicit' }, '', '/home/hy/hy')
  assert.equal(hinted.identity.workspace, 'explicit')
  assert.equal(hinted.sources.workspace, 'hint')
})

test('hook：pre-step 用会话 cwd 派生 workspace 传给召回；cfg.workspace 非空时不变', async () => {
  const seen = []
  const config = { identity: { mode: 'auto', workspace: '' }, recall: { enabled: true, timeoutMs: 1000 } }
  const { ctx, state } = fakeCtx()
  const identityState = {}
  installHook(ctx, {
    backend: { async recall(args) { seen.push(args.identity); return { prefix: 'P', hits: 1 } } },
    config,
    getHostUserId: () => 'host-1',
    identityState,
  })

  await state.pre({ agent: { session: { id: 's1', header: { cwd: '/home/hy/hy' } } }, messages: userMsg }, async () => ({ kind: 'enter' }))
  await state.pre({ agent: { session: { id: 's2', header: { cwd: '/home/hy/网页端聊天' } } }, messages: userMsg }, async () => ({ kind: 'enter' }))
  assert.equal(seen.length, 2)
  assert.equal(seen[0].userId, 'host-1')
  assert.equal(seen[0].workspace, '/home/hy/hy')
  assert.equal(seen[1].workspace, '/home/hy/网页端聊天')
  assert.notEqual(seen[0].workspace, seen[1].workspace)
  // 面板读不到会话 header：hook 把最近一次真正用的身份写进共享 state。
  assert.equal(identityState.lastRecall.workspace, '/home/hy/网页端聊天')
  assert.equal(identityState.lastRecall.workspaceSource, 'session')
  assert.equal(identityState.lastRecall.userId, 'host-1')

  // 现网配置 workspace='web'：会话维度不得改变已有召回分区。
  const fixedConfig = { identity: { mode: 'auto', workspace: 'web' }, recall: { enabled: true, timeoutMs: 1000 } }
  const seen2 = []
  const second = fakeCtx()
  installHook(second.ctx, {
    backend: { async recall(args) { seen2.push(args.identity); return { prefix: 'P', hits: 1 } } },
    config: fixedConfig,
    getHostUserId: () => 'host-1',
  })
  await second.state.pre({ agent: { session: { id: 's3', header: { cwd: '/home/hy/网页端聊天' } } }, messages: userMsg }, async () => ({ kind: 'enter' }))
  assert.equal(seen2[0].workspace, 'web')
})
