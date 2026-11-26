/**
 * S2 真宿主注册冒烟：真 cordis Context + 真 dsh-tools 注册表（不是假 registry）。
 *
 * 为什么单独一层：假 registry 只能证明“我们调了 register”，证明不了宿主接受我们的
 * 参数/输出 schema、名字不撞保留位、卸载后真的消失。这里挂真 ToolsService 再断言
 * `ctx.tools.view()` 的可见集合；不启动 DSH、不碰 live 库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import ToolsService from '@deepseek-ai/dsh-tools'
import { createBackend } from '../../src/core/backend.js'
import { installMemoryTools } from '../../src/host/tools.js'
import { inject } from '../../index.js'

const NAMES = ['memory_remember', 'memory_search', 'memory_read', 'memory_update', 'memory_forget']

/** 真宿主上下文：只补插件 inject 声明的服务，其余不提供。 */
async function hostContext(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-tools-host-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  ctx.plugin(ToolsService)
  // 服务注册在插件装载的微任务里完成；等到 tools 可读再断言。
  for (let index = 0; index < 20 && !ctx.get('tools'); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { ctx, backend }
}

test('真注册表：五工具可注册（schema 被宿主接受）、可见、卸载后消失', async (t) => {
  assert.ok(inject.includes('tools'), 'tools 必须是 inject 服务（否则 apply 早于注册表就位）')
  const { ctx, backend } = await hostContext(t)
  const registry = ctx.get('tools')
  assert.ok(registry && typeof registry.register === 'function')

  const installed = installMemoryTools({
    ctx, backend, config: {},
    getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    log: () => {},
  })
  const visible = registry.view(undefined).visible
  for (const name of NAMES) {
    assert.ok(visible.has(name), `${name} 必须出现在真注册表里`)
    assert.equal(visible.get(name).name, name)
  }
  const snapshot = visible.get('memory_update')
  assert.equal(typeof snapshot.execute, 'function')
  assert.equal(snapshot.timeoutMs, undefined, '不得声明 timeoutMs')

  installed.dispose()
  const after = registry.view(undefined).visible
  for (const name of NAMES) assert.equal(after.has(name), false, `${name} 卸载后必须消失`)
})
