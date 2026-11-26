/**
 * S2 模型记忆工具面：注册/激活条件/身份闸/跨分区/保护面/CAS/每回合限次/错误码/审计/渲染（架构书 §5.2）。
 *
 * 口径：
 * - 用真 `defineTool` 编译定义 + 真 JSON Schema 校验（参数与成功输出都验）；
 * - 用真 LocalBackend + 临时库验落库产物（nodes/writes 行、payload.origin）与跨分区不可见；
 * - 工具注册走假 registry（只记录 definition/options），但 `when` 的求值语义按宿主 ToolActivationContext 构造；
 * - 每回合限次用假 ctx 的事件表模拟 `agent/pre-step`，不依赖宿主运行时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createBackend } from '../../src/core/backend.js'
import { createMemoryToolDefinitions, installMemoryTools, WRITE_TOOL_NAMES } from '../../src/host/tools.js'
import { createWriteRateLimiter } from '../../src/host/tool-rate-limit.js'
import { TOOL_ERROR } from '../../src/host/tool-errors.js'

const WORK_DIR = join(tmpdir(), 'whale-tool-ws-a')

/** 会话 header：真实宿主里 cwd 是绝对路径；deriveWorkspace 对它做 resolve。 */
function agentOf(id = 's1', header = { cwd: WORK_DIR }) {
  return { session: { id, header } }
}

/** 工具执行上下文（defineTool.execute 只读 agent；其余字段按宿主形状补齐，证明不误用）。 */
function execOf(agent = agentOf()) {
  return {
    agent,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('exec'),
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

/** 能力齐备的假后端（只用于定义/注册面测试，不落库）。 */
function stubBackend() {
  return {
    mode: 'local',
    write: async () => ({ ok: true, action: 'ADD', id: 'n_stub', reason: 'new' }),
    search: async () => ({ hits: [] }),
    getNode: async () => ({ ok: false, error: 'node_not_found' }),
    updateNode: async () => ({ ok: true, id: 'n_stub', updated_at: 1 }),
  }
}

/** 假 ctx：记录事件 listener 与 register 调用，并暴露 tools 服务。 */
function fakeHost({ config = {}, registry = null } = {}) {
  const listeners = new Map()
  const registered = []
  const logs = []
  const toolsService = registry || {
    register(definition, options) {
      registered.push({ definition, options })
      return () => {
        const index = registered.findIndex((item) => item.definition === definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const ctx = {
    get(name) {
      return name === 'tools' ? toolsService : undefined
    },
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
  }
  const host = {
    ctx,
    config,
    registered,
    logs,
    /** 真 waterfall 形状：逐个 listener 传 next（本插件 listener 必须原样透传 decision）。 */
    async preStep(agent, turn = 1) {
      const payload = { agent, turn, step: 1, messages: [], signal: new AbortController().signal }
      let decision = { kind: 'enter' }
      for (const handler of listeners.get('agent/pre-step') || []) {
        const current = decision
        decision = await handler(payload, async () => current)
      }
      return decision
    },
    disposeAgent(agent) {
      for (const handler of listeners.get('agent/disposed') || []) handler({ agent })
    },
    install(overrides = {}) {
      return installMemoryTools({
        ctx,
        backend: overrides.backend || stubBackend(),
        config: overrides.config || config,
        getIdentityCfg: () => ({ mode: 'auto' }),
        getIdentityHint: () => null,
        getHostUserId: () => 'u1',
        log: (line) => logs.push(String(line)),
      })
    },
  }
  return host
}

/** 临时库后端（worker 关：搜索走同步实现，断言不引入线程时序）。 */
function freshBackend(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-tools-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, log: () => {} })
  t.after(() => backend.dispose())
  return backend
}

/** 直接执行一个已编译工具（defineTool 会先做参数校验，失败抛 ToolArgsError）。 */
function definitionOf(definitions, name) {
  const found = definitions.find((item) => item.name === name)
  assert.ok(found, `缺工具定义 ${name}`)
  return found
}

async function run(definitions, name, args, exec = execOf()) {
  return definitionOf(definitions, name).execute(args, exec)
}

/** 输出必须满足自身 output schema（成功形状只在声明里；漂移即红）。 */
function assertOutput(definitions, name, value) {
  const violations = validateJsonSchemaValue(definitionOf(definitions, name).output.schema, value, '')
  assert.deepEqual(violations, [], `输出不符合 ${name} output schema`)
}

/** 等待错误：断言失败码稳定（HarnessError.code），不是文案匹配。 */
async function rejectsWith(promise, code) {
  try {
    await promise
  } catch (err) {
    assert.equal(err?.code, code, `期望 ${code}，实际 ${err?.code}：${err?.message}`)
    assert.equal(err?.name, 'HarnessError')
    return err
  }
  assert.fail(`期望抛 ${code}，实际成功`)
}

test('定义面：五工具、schema 可编译、写工具显式非并发安全、不声明 timeoutMs', () => {
  const host = fakeHost()
  const installed = host.install()
  const names = installed.definitions.map((definition) => definition.name).sort()
  assert.deepEqual(names, ['memory_forget', 'memory_read', 'memory_remember', 'memory_search', 'memory_update'])
  assert.equal(host.registered.length, 5, '五工具都必须真注册')
  for (const definition of installed.definitions) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters), `${definition.name} 参数 schema 不支持`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), `${definition.name} 输出 schema 不支持`)
    assert.equal(definition.timeoutMs, undefined, '写队列不可取消：不得声明 timeoutMs')
    if (WRITE_TOOL_NAMES.includes(definition.name)) {
      assert.equal(definition.isConcurrencySafe?.({}), false, `${definition.name} 必须显式非并发安全`)
    }
  }
  assert.equal(typeof definitionOf(installed.definitions, 'memory_search').output.render, 'function')
})

test('激活条件：tools.enabled=false 或子代理会话 → when=false；普通会话 true；volatile Ref 也认', () => {
  const enabledRef = { get: () => false }
  const disabled = fakeHost({ config: { tools: { enabled: enabledRef } } })
  disabled.install()
  const when = disabled.registered[0].options.when
  assert.equal(when({ agent: agentOf() }), false, 'enabled=false 时不得出现在 step 工具集')

  const host = fakeHost()
  host.install()
  const whenOn = host.registered[0].options.when
  assert.equal(whenOn({ agent: agentOf() }), true)
  assert.equal(whenOn({ agent: agentOf('s2', { cwd: WORK_DIR, origin: 'subagent' }) }), false, '子代理不可见')
  assert.equal(whenOn({ agent: agentOf('s3', { cwd: WORK_DIR, delegationDepth: 1 }) }), false, '只看 delegationDepth 的子代理也不可见')
})

test('缺 tools 服务：不抛、零注册、留日志证据（fail-open 但可见）', () => {
  const listeners = new Map()
  const logs = []
  const ctx = { get: () => undefined, on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) } }
  const installed = installMemoryTools({
    ctx, backend: null, config: {},
    getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    log: (line) => logs.push(String(line)),
  })
  assert.deepEqual(installed.definitions, [])
  assert.doesNotThrow(() => installed.dispose())
  assert.ok(logs.some((line) => line.includes('tools service unavailable')), '降级必须留可判定证据')
})

test('身份闸：无 agent / 无 header / header 无 cwd → IDENTITY_REQUIRED，且不调用后端', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  const calls = []
  const counting = { getNode: (...args) => { calls.push(args); return backend.getNode(...args) } }

  const defs = createMemoryToolDefinitions({
    backend: counting, config: {},
    getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    limiter: createWriteRateLimiter({ ctx: { on: () => () => {} } }),
  })
  await rejectsWith(run(defs, 'memory_remember', { text: '必须显式设置 flex-shrink:0' }, { ...execOf(), agent: undefined }), TOOL_ERROR.IDENTITY_REQUIRED)
  await rejectsWith(run(defs, 'memory_remember', { text: '必须显式设置 flex-shrink:0' }, { ...execOf(), agent: { session: { id: 's1', header: {} } } }), TOOL_ERROR.IDENTITY_REQUIRED)
  assert.deepEqual(calls, [], '身份闸必须前置于任何后端调用')
  // 定义仍可用（install 只是接线；这里只证明闸口存在）。
  assert.equal(host.registered.length, 5)
})

test('remember：durable → ADD active，nodes.source/origin=tool，writes.payload.origin=tool，渲染含 id', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)

  const text = '门禁失败不得发布，且基线只在全绿后刷新'
  const out = await run(definitions, 'memory_remember', { text, level: 'important', tags: ['门禁', '门禁'] })
  assert.deepEqual(Object.keys(out).sort(), ['action', 'id', 'ok', 'reason'])
  assertOutput(definitions, 'memory_remember', out)
  assert.equal(out.ok, true)
  assert.equal(out.action, 'ADD')
  assert.ok(out.id)

  const node = backend.withDb((db) => db.prepare('SELECT * FROM nodes WHERE id=?').get(out.id))
  assert.match(node.text, /基线只在全绿后刷新/, '正文按写入入口归一后落库')
  assert.equal(node.source, 'tool')
  assert.equal(node.origin, 'tool')
  assert.equal(node.level, 'important')
  assert.equal(node.workspace, WORK_DIR)
  assert.deepEqual(JSON.parse(node.tags), ['门禁'])

  const audit = backend.withDb((db) => db.prepare('SELECT action,payload,user_id,workspace FROM writes ORDER BY id DESC LIMIT 1').get())
  const payload = JSON.parse(audit.payload)
  assert.equal(audit.action, 'ADD')
  assert.equal(payload.origin, 'tool')
  assert.equal(payload.source, 'tool')
  assert.equal(audit.workspace, WORK_DIR)

  const rendered = definitionOf(definitions, 'memory_remember').output.render({}, out)
  assert.match(rendered[0].text, new RegExp(out.id))
})

test('remember：任务句/一次性状态 → NOT_MEMORY（门禁 REJECT，不留正文）；歧义 → CANDIDATE（id=null）', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)

  await rejectsWith(run(definitions, 'memory_remember', { text: '下个会话先整合本次需求并更新交接文档' }), TOOL_ERROR.NOT_MEMORY)
  await rejectsWith(run(definitions, 'memory_remember', { text: '0.8.0-beta1 已装，PID 576417，重启后生效' }), TOOL_ERROR.NOT_MEMORY)

  const rejected = backend.withDb((db) => db.prepare("SELECT action,reason,before_text,after_text FROM writes WHERE action='REJECT' ORDER BY id DESC").all())
  assert.ok(rejected.length >= 2)
  for (const row of rejected) {
    assert.equal(row.before_text, null, '价值闸 REJECT 不得留正文')
    assert.equal(row.after_text, null)
  }

  const out = await run(definitions, 'memory_remember', { text: '刚才那个方案可能有问题，先看看' })
  assertOutput(definitions, 'memory_remember', out)
  assert.equal(out.action, 'CANDIDATE')
  assert.equal(out.id, null, 'CANDIDATE 不落 nodes')
  assert.match(out.reason, /ambiguous|subjective/)
  const candidate = backend.withDb((db) => db.prepare("SELECT action,payload FROM writes WHERE action='CANDIDATE' ORDER BY id DESC LIMIT 1").get())
  assert.equal(JSON.parse(candidate.payload).origin, 'tool')
})

test('search/read：同会话命中、输出 schema 合法、跨分区 id 按不存在处理', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)

  const text = '发布前必须跑全量门禁，基线只在全绿后刷新'
  const remembered = await run(definitions, 'memory_remember', { text })
  const other = await backend.write({
    text: '别的分区：周末团建改到灵隐寺',
    identity: { userId: 'u1', roleId: '', workspace: 'other-ws' },
    origin: 'panel',
  })
  assert.equal(other.ok, true)

  const found = await run(definitions, 'memory_search', { query: '全量门禁', limit: 5 })
  assertOutput(definitions, 'memory_search', found)
  assert.ok(found.hits.some((hit) => hit.id === remembered.id), '必须命中本分区节点')
  assert.ok(found.hits.every((hit) => hit.id !== other.id), '跨分区节点不得出现在检索结果')
  const hit = found.hits.find((item) => item.id === remembered.id)
  assert.equal(hit.memory_type, 'semantic')
  assert.equal(typeof hit.score, 'number')
  assert.match(definitionOf(definitions, 'memory_search').output.render({}, found)[0].text, /全量门禁/)

  const detail = await run(definitions, 'memory_read', { id: remembered.id })
  assertOutput(definitions, 'memory_read', detail)
  assert.match(detail.node.text, /全量门禁/, 'read 必须回真实正文（写入入口会归一标点）')
  // CAS 基线必须进模型可见渲染：render 是唯一出口，canonical value 模型看不到。
  assert.match(definitionOf(definitions, 'memory_read').output.render({}, detail)[0].text,
    new RegExp(`updatedAt=${detail.node.updated_at}`), 'read 渲染必须给出 updatedAt')
  assert.deepEqual(detail.node.tags, [])

  await rejectsWith(run(definitions, 'memory_read', { id: other.id }), TOOL_ERROR.NODE_NOT_FOUND)
  await rejectsWith(run(definitions, 'memory_search', { query: '   ' }), TOOL_ERROR.INVALID_ARGS)
})

test('update/forget：CAS → NODE_CHANGED、保护面 → PROTECTED_TARGET、正常改写落 tool 审计', async (t) => {
  const backend = freshBackend(t)
  // 本用例覆盖的是 CAS/保护面语义，把写限次放宽到不干扰（限次有独立用例）。
  const host = fakeHost({ config: { tools: { maxWritesPerTurn: 20 } } })
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)

  const remembered = await run(definitions, 'memory_remember', { text: '记忆默认免审入库，但价值闸先拦任务句' })
  const before = (await run(definitions, 'memory_read', { id: remembered.id })).node

  await rejectsWith(run(definitions, 'memory_update', {
    id: remembered.id, text: '已被并发写入改过的新正文', expectedUpdatedAt: Number(before.updated_at) - 1,
  }), TOOL_ERROR.NODE_CHANGED)

  const updated = await run(definitions, 'memory_update', {
    id: remembered.id, text: '记忆默认免审入库，但价值闸先拦任务句与一次性状态', tags: ['价值闸'],
    expectedUpdatedAt: Number(before.updated_at),
  })
  assertOutput(definitions, 'memory_update', updated)
  assert.ok(updated.updatedAt > Number(before.updated_at))
  const edits = backend.withDb((db) => db.prepare("SELECT action,reason,payload FROM writes WHERE action='EDIT' ORDER BY id DESC LIMIT 3").all())
  assert.ok(edits.length > 0)
  for (const row of edits) {
    assert.equal(JSON.parse(row.payload).origin, 'tool')
    assert.match(row.reason, /^tool_/)
  }
  assert.ok(edits.some((row) => row.reason === 'tool_edit') && edits.some((row) => row.reason === 'tool_tags'))

  const forgotten = await run(definitions, 'memory_forget', { id: remembered.id, reason: '已被新规则取代' })
  assertOutput(definitions, 'memory_forget', forgotten)
  const archived = backend.withDb((db) => db.prepare('SELECT status FROM nodes WHERE id=?').get(remembered.id))
  assert.equal(archived.status, 'archived', 'forget 只归档不物理删')
  const archiveRow = backend.withDb((db) => db.prepare("SELECT action,reason,mode,payload FROM writes WHERE action='ARCHIVE' ORDER BY id DESC LIMIT 1").get())
  assert.equal(archiveRow.reason, '已被新规则取代')
  assert.equal(JSON.parse(archiveRow.payload).origin, 'tool')

  // 保护面：先升到 core（updateNode 允许非保护目标改等级），之后工具改写/归档都必须拒。
  const core = await backend.write({ text: '核心记忆：所有文件改动必须留审计', identity: { userId: 'u1', roleId: '', workspace: WORK_DIR } })
  assert.equal(core.ok, true)
  assert.equal((await backend.updateNode(core.id, { level: 'core' }, { identity: { userId: 'u1', roleId: '', workspace: WORK_DIR } })).ok, true)
  await rejectsWith(run(definitions, 'memory_update', { id: core.id, text: '试图改写核心记忆' }), TOOL_ERROR.PROTECTED_TARGET)
  await rejectsWith(run(definitions, 'memory_forget', { id: core.id, reason: '试图归档' }), TOOL_ERROR.PROTECTED_TARGET)
})

test('update：正文与另一活跃记忆重复 → DUPLICATE_ACTIVE（不静默覆盖）', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)
  const first = await run(definitions, 'memory_remember', { text: '门禁失败不得发布会阻断流水线' })
  const second = await run(definitions, 'memory_remember', { text: '全量门禁绿之后才允许刷新基线文件，基线必须校验 fail=0' })
  await rejectsWith(run(definitions, 'memory_update', { id: second.id, text: '门禁失败不得发布会阻断流水线' }), TOOL_ERROR.DUPLICATE_ACTIVE)
  assert.ok(first.id)
})

test('每回合写限次：第 6 次 RATE_LIMITED；turn 变化清零；maxWritesPerTurn 即时生效', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  const agent = agentOf()
  await host.preStep(agent, 1)

  for (let index = 0; index < 5; index += 1) {
    const out = await run(definitions, 'memory_remember', { text: `第 ${index} 条长期规则：任何批量测试都必须独立看 exit code` }, execOf(agent))
    assert.equal(out.ok, true)
  }
  await rejectsWith(run(definitions, 'memory_remember', { text: '第六条写入必须被限次' }, execOf(agent)), TOOL_ERROR.RATE_LIMITED)
  // 读工具不限次：限次只覆盖写路径。
  assert.equal((await run(definitions, 'memory_search', { query: '批量测试' }, execOf(agent))).ok, true)

  await host.preStep(agent, 2)
  const nextTurn = await run(definitions, 'memory_remember', { text: '下一回合：基线只在测试全绿后刷新' }, execOf(agent))
  assert.equal(nextTurn.ok, true, 'turn 变化必须清零')

  // 配置为 volatile Ref 也要即时生效（面板改 maxWritesPerTurn 不用重挂）。
  const cramped = fakeHost({ config: { tools: { maxWritesPerTurn: { get: () => 2 } } } })
  const tight = cramped.install({ backend })
  await cramped.preStep(agent, 1)
  await run(tight.definitions, 'memory_remember', { text: '上限二：第一条' }, execOf(agent))
  await run(tight.definitions, 'memory_remember', { text: '上限二：第二条' }, execOf(agent))
  await rejectsWith(run(tight.definitions, 'memory_remember', { text: '上限二：第三条应被拒' }, execOf(agent)), TOOL_ERROR.RATE_LIMITED)

  // agent/disposed 清槽由独立用例断言（同一实例 1→0），这里不重复造一个空 limiter 冒充验证。
  cramped.disposeAgent(agent)
})

test('每回合限次器自身：attempt 计数、超限、dispose 释放监听', () => {
  const listeners = new Map()
  const ctx = {
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event) },
  }
  const limiter = createWriteRateLimiter({ ctx })
  assert.equal(limiter.attempt('s9', 1).allowed, true)
  assert.deepEqual(limiter.attempt('s9', 1), { allowed: false, count: 2, max: 1 })
  assert.equal(limiter.size(), 1)
  limiter.dispose()
  assert.equal(limiter.size(), 0)
  assert.equal(listeners.size, 0, 'dispose 必须反注册 pre-step/disposed 监听')
})

test('卸载：dispose 逐个反注册工具并清监听', () => {
  const host = fakeHost()
  const installed = host.install()
  assert.equal(host.registered.length, 5)
  installed.dispose()
  assert.equal(host.registered.length, 0)
})

test('后端能力闸：缺 getNode/updateNode 的 http 后端不注册工具面，并留日志证据', () => {
  const host = fakeHost()
  const logs = []
  const installed = installMemoryTools({
    ctx: host.ctx,
    backend: { mode: 'http', write: async () => ({ ok: true, action: 'ok' }), search: async () => ({ hits: [] }) },
    config: {},
    getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    log: (line) => logs.push(String(line)),
  })
  assert.deepEqual(installed.definitions, [])
  assert.equal(host.registered.length, 0, '无读改能力的后端不得暴露写工具')
  assert.ok(logs.some((line) => line.includes('lacks') && line.includes('getNode')), '能力闸必须留可判定日志')
})

test('后端异常收敛：非 node_not_found 的读失败/后端抛错/null 检索结果 → BACKEND_FAILED（不是“不存在”）', async (t) => {
  const limiter = createWriteRateLimiter({ ctx: { on: () => () => {} } })
  const exec = execOf()
  const make = (backend) => createMemoryToolDefinitions({
    backend, config: {},
    getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    limiter,
  })

  // 1) getNode 返回非 node_not_found 的业务失败：不得伪装成 NODE_NOT_FOUND。
  const failing = make({
    mode: 'local',
    write: async () => ({ ok: false, error: 'write_disabled' }),
    search: async () => ({ hits: [] }),
    getNode: async () => ({ ok: false, error: 'schema_corrupt' }),
    updateNode: async () => ({ ok: true }),
  })
  await rejectsWith(run(failing, 'memory_read', { id: 'n1' }, exec), TOOL_ERROR.BACKEND_FAILED)

  // 2) 后端抛原始异常（如已释放）：收敛成 HarnessError，不让 TypeError 冒出工具边界。
  const broken = make({
    mode: 'local',
    write: async () => { throw new Error('backend_disposed') },
    search: async () => { throw new Error('backend_disposed') },
    getNode: async () => { throw new Error('backend_disposed') },
    updateNode: async () => { throw new Error('backend_disposed') },
  })
  await rejectsWith(run(broken, 'memory_search', { query: '门禁' }, exec), TOOL_ERROR.BACKEND_FAILED)
  await rejectsWith(run(broken, 'memory_read', { id: 'n1' }, exec), TOOL_ERROR.BACKEND_FAILED)

  // 3) 检索返回 null：不得当“零命中成功”（fail-open）。
  const nullSearch = make({
    mode: 'local',
    write: async () => ({ ok: true }),
    search: async () => null,
    getNode: async () => ({ ok: false, error: 'node_not_found' }),
    updateNode: async () => ({ ok: true }),
  })
  await rejectsWith(run(nullSearch, 'memory_search', { query: '门禁' }, exec), TOOL_ERROR.BACKEND_FAILED)
})

test('参数边界：tags>32 → INVALID_ARGS（不静默截断）；remember/update 同口径', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost({ config: { tools: { maxWritesPerTurn: 20 } } })
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)
  const tags = Array.from({ length: 33 }, (_, index) => `t${index}`)
  await rejectsWith(run(definitions, 'memory_remember', { text: '标签上限必须显式拒绝而不是静默截断', tags }), TOOL_ERROR.INVALID_ARGS)
  const node = await run(definitions, 'memory_remember', { text: '标签边界验证必须先有一条正常记忆' })
  await rejectsWith(run(definitions, 'memory_update', { id: node.id, tags }), TOOL_ERROR.INVALID_ARGS)
})

test('forget 幂等：已归档节点再忘 → ok、零新审计行、留 noop 日志（不静默改写）', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)
  const node = await run(definitions, 'memory_remember', { text: '幂等归档：重复 forget 不得重复审计' })
  assert.equal((await run(definitions, 'memory_forget', { id: node.id, reason: '第一次归档' })).ok, true)
  const before = backend.withDb((db) => db.prepare("SELECT count(*) AS n FROM writes WHERE action='ARCHIVE'").get().n)
  const again = await run(definitions, 'memory_forget', { id: node.id, reason: '第二次归档' })
  assert.equal(again.ok, true)
  assert.equal(again.status, 'archived')
  const after = backend.withDb((db) => db.prepare("SELECT count(*) AS n FROM writes WHERE action='ARCHIVE'").get().n)
  assert.equal(after, before, '重复归档不得再造审计行')
  assert.ok(host.logs.some((line) => line.includes('memory_forget noop')), '幂等跳过必须留证据')
})

test('跨分区同文对照：同正文写进别的 workspace，search/read 均不可见（真锻炼 identityFilter）', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)
  const text = '发布前必须跑全量门禁，基线只在全绿后刷新'
  const mine = await run(definitions, 'memory_remember', { text })
  const other = await backend.write({
    text: '发布前必须跑全量门禁，基线只在全绿后刷新',
    identity: { userId: 'u1', roleId: '', workspace: 'other-ws' },
  })
  assert.equal(other.ok, true)
  const found = await run(definitions, 'memory_search', { query: '全量门禁', limit: 20 })
  assert.ok(found.hits.some((hit) => hit.id === mine.id))
  assert.ok(found.hits.every((hit) => hit.id !== other.id), '同文跨分区节点不得命中')
  await rejectsWith(run(definitions, 'memory_read', { id: other.id }), TOOL_ERROR.NODE_NOT_FOUND)
})

test('执行闸兜底：子代理 exec（origin 或 delegationDepth）调任何记忆工具 → SUBAGENT_FORBIDDEN', async (t) => {
  const backend = freshBackend(t)
  const host = fakeHost()
  const { definitions } = host.install({ backend })
  await host.preStep(agentOf(), 1)
  const byOrigin = execOf(agentOf('sub-a', { cwd: WORK_DIR, origin: 'subagent' }))
  const byDepth = execOf(agentOf('sub-b', { cwd: WORK_DIR, delegationDepth: 1 }))
  for (const exec of [byOrigin, byDepth]) {
    await rejectsWith(run(definitions, 'memory_search', { query: '门禁' }, exec), TOOL_ERROR.SUBAGENT_FORBIDDEN)
    await rejectsWith(run(definitions, 'memory_remember', { text: '子代理不得写入长期记忆' }, exec), TOOL_ERROR.SUBAGENT_FORBIDDEN)
  }
  // 与身份闸同序：执行闸先于后端调用（后端不被摸到）。
  const calls = []
  const defs = createMemoryToolDefinitions({
    backend: {
      mode: 'local',
      write: async () => { calls.push('write'); return { ok: true, action: 'ADD', id: 'x' } },
      search: async () => { calls.push('search'); return { hits: [] } },
      getNode: async () => { calls.push('getNode'); return { ok: false, error: 'node_not_found' } },
      updateNode: async () => { calls.push('updateNode'); return { ok: true } },
    },
    config: {}, getIdentityCfg: () => ({ mode: 'auto' }), getIdentityHint: () => null, getHostUserId: () => 'u1',
    limiter: createWriteRateLimiter({ ctx: { on: () => () => {} } }),
  })
  await rejectsWith(run(defs, 'memory_search', { query: '门禁' }, byOrigin), TOOL_ERROR.SUBAGENT_FORBIDDEN)
  assert.deepEqual(calls, [], '执行闸必须前置，后端零调用')
})
