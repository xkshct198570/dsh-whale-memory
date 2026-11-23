/**
 * hook 规则注入 / 提案 / 确认（R3b）单测。
 * 全部用临时规则目录 + 假 ctx（不启宿主、不联网）；git 走宿主默认实现，缺 git 时自动降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook, buildRulesPrefix, scopeMatches } from '../../src/host/hook.js'
import { writeRule } from '../../src/core/rule-store.js'
import { RULES_BEGIN, RULES_END } from '../../src/core/rule-render.js'
import { listProposals, proposalNonce, rejectProposal, resetSessionPending } from '../../src/core/rule-proposal.js'

/** 假 ctx：on/systemPrompt/effect/setTimeout/get；定时器同步执行，让提案链路可断言。 */
function fakeCtx({ inlineTimers = true } = {}) {
  const state = { pre: null, context: null, handlers: {} }
  const ctx = {
    on(ev, fn) {
      state.handlers[ev] = fn
      if (ev === 'agent/pre-step') state.pre = fn
      return () => { delete state.handlers[ev]; if (ev === 'agent/pre-step') state.pre = null }
    },
    systemPrompt: { context(def) { state.context = def; return () => {} } },
    effect(fn) { return fn() },
    get() { return null },
    setTimeout(fn) { if (inlineTimers) fn(); return 1 },
  }
  return { ctx, state }
}

function freshHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-hook-rules-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const rulesDir = join(home, 'rules')
  return { home, rulesDir, agentsPath: join(home, 'AGENTS.md') }
}

function cfgOf(rulesDir, identity = {}, rules = {}) {
  return {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '', ...identity },
    recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
    rules: { enabled: true, dir: rulesDir, askMode: 'panel+chat', llm: false, ...rules },
  }
}

function ruleFront(overrides = {}) {
  return {
    key: 'rule-scoped',
    type: 'rule',
    number: 1,
    priority: 'P1',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '',
    object: '',
    conditions: [],
    exceptions: [],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

function seed(root, overrides, text) {
  const got = writeRule(root, { front: ruleFront(overrides), text }, { git: false })
  assert.equal(got.ok, true, JSON.stringify(got.detail || got.error))
}

/** 候选 JSON 文件列表（proposals/ 目录由 ensureRuleRepo 预先建好，所以只看文件）。 */
function jsonProposals(rulesDir) {
  try {
    return readdirSync(join(rulesDir, 'proposals')).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

function userMsg(text) {
  return [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }]
}

function preStepPayload(sessionId, text, header = {}) {
  return { agent: { session: { id: sessionId, header } }, messages: userMsg(text) }
}

const quietBackend = () => ({ async recall() { return { prefix: '【你想到的旧事】某条记忆', hits: 1 } } })

function contextText(state, sid = 's1') {
  return state.context.text({ scope: { session: { id: sid } } })
}

/**
 * 提案检测自 R9-01 起用 `setImmediate` 调度（宿主无关），断言前必须先让排队的 run() 跑完。
 * 这是唯一的调度契约变更：不再依赖假 ctx 同步 `setTimeout`。
 */
function flushProposalScheduler() {
  return new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// buildRulesPrefix（纯函数口径）
// ---------------------------------------------------------------------------

test('scopeMatches：role 严格相等；workspace 精确或前缀目录', () => {
  assert.equal(scopeMatches('role:reviewer', 'reviewer', ''), true)
  assert.equal(scopeMatches('role:reviewer', 'other', ''), false)
  assert.equal(scopeMatches('role:reviewer', '', ''), false)
  assert.equal(scopeMatches('workspace:/tmp/ws', '', '/tmp/ws'), true)
  assert.equal(scopeMatches('workspace:/tmp/ws', '', '/tmp/ws/sub'), true)
  assert.equal(scopeMatches('workspace:/tmp/ws', '', '/tmp/ws2'), false)
  assert.equal(scopeMatches('global', 'reviewer', '/tmp/ws'), false)
})

test('buildRulesPrefix：role/workspace 命中才注入；global 不注入（有 AGENTS 标记块）', (t) => {
  const { home, rulesDir, agentsPath } = freshHome(t)
  writeFileSync(agentsPath, `# A\n${RULES_BEGIN}\n${RULES_END}\n`, 'utf8')
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  seed(rulesDir, { key: 'rule-ws', number: 2, scope: `workspace:${home}/ws` }, '必须先读工作区说明。')
  seed(rulesDir, { key: 'rule-global', number: 3, scope: 'global', type: 'iron-rule', priority: 'P0' }, '必须让全局规则走摘要。')

  const hit = buildRulesPrefix({ identity: { roleId: 'reviewer', workspace: `${home}/ws/sub` }, rulesDir, config: cfgOf(rulesDir) })
  assert.deepEqual(hit.keys, ['rule-role', 'rule-ws'], JSON.stringify(hit))
  assert.match(hit.text, /【规则·role:reviewer】必须只审不施工。/)
  assert.match(hit.text, /【规则·workspace:/)
  assert.equal(hit.text.includes('全局规则走摘要'), false, 'global 不得进每轮注入')

  const none = buildRulesPrefix({ identity: { roleId: '', workspace: '/elsewhere' }, rulesDir, config: cfgOf(rulesDir) })
  assert.equal(none.keys.length, 0)
  assert.equal(none.text, '')
})

test('buildRulesPrefix：AGENTS 缺标记 → 降级注入 global（≤预算）', (t) => {
  const { rulesDir, home } = freshHome(t)
  seed(rulesDir, { key: 'iron-rule-17', number: 17, scope: 'global', type: 'iron-rule', priority: 'P0' }, '删文档前先核对绝对路径。')
  seed(rulesDir, { key: 'rule-normal', number: 18, scope: 'global' }, '必须让普通规则同样可见。')
  const got = buildRulesPrefix({ identity: {}, rulesDir, config: cfgOf(rulesDir) })
  assert.equal(got.hasAgentsMarkers, false)
  assert.equal(got.mode, 'global')
  assert.deepEqual(got.keys, ['iron-rule-17', 'rule-normal'])
  assert.ok(got.chars <= 600)
  assert.equal(existsSync(join(home, 'AGENTS.md')), false, '降级注入不得创建 AGENTS')
})

test('buildRulesPrefix：预算放不下的整条跳过（不截半条），单条超预算才截断', (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-long', number: 1, scope: 'role:r1' }, '必须'.repeat(40))
  seed(rulesDir, { key: 'rule-short', number: 2, scope: 'role:r1' }, '必须保留审计日志。')
  const limited = buildRulesPrefix({
    identity: { roleId: 'r1' }, rulesDir, config: cfgOf(rulesDir, {}, { injectChars: 40 }),
  })
  assert.deepEqual(limited.keys, ['rule-short'], '放不下的整条跳过，放得下的照常注入')
  assert.equal(limited.skipped.length, 1)
  assert.equal(limited.skipped[0].key, 'rule-long')
  const tight = buildRulesPrefix({
    identity: { roleId: 'r1' }, rulesDir, config: cfgOf(rulesDir, {}, { injectChars: 20 }), rules: [{
      front: ruleFront({ key: 'rule-only', scope: 'role:r1' }), text: '必须'.repeat(40),
    }],
    budget: 20,
  })
  assert.equal(tight.keys.length, 1)
  assert.ok(Array.from(tight.text).length <= 20, '单条超预算时按预算截断')
  assert.equal(tight.skipped.length, 1)
})

// ---------------------------------------------------------------------------
// hook 注入
// ---------------------------------------------------------------------------

test('hook：role 规则进 context（与召回同一段文本，规则在前）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, {
    backend: quietBackend(),
    config: cfgOf(rulesDir, { roleId: 'reviewer' }),
  })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '看看这个方案'), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.match(text, /【规则·role:reviewer】必须只审不施工。/)
  assert.match(text, /【你想到的旧事】/)
  assert.ok(text.indexOf('【规则·') < text.indexOf('【你想到的旧事】'), '规则约束必须排在召回证据前')
})

test('hook：workspace 前缀命中工作区规则；不命中不注入', async (t) => {
  const { home, rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-ws', number: 1, scope: `workspace:${home}/ws` }, '必须先读工作区说明。')
  const inside = fakeCtx()
  const hookInside = installHook(inside.ctx, {
    backend: quietBackend(),
    config: cfgOf(rulesDir, { workspace: `${home}/ws/sub` }),
  })
  await inside.state.pre(preStepPayload('s1', '看看'), async () => ({ kind: 'enter' }))
  assert.match(contextText(inside.state), /必须先读工作区说明/)
  hookInside.dispose()

  const outside = fakeCtx()
  const hookOutside = installHook(outside.ctx, {
    backend: quietBackend(),
    config: cfgOf(rulesDir, { workspace: `${home}/other` }),
  })
  await outside.state.pre(preStepPayload('s2', '看看'), async () => ({ kind: 'enter' }))
  assert.equal(contextText(outside.state, 's2').includes('必须先读工作区说明'), false)
  hookOutside.dispose()
})

test('hook：AGENTS 有标记块时 global 不注入；缺标记时降级注入', async (t) => {
  const { home, rulesDir, agentsPath } = freshHome(t)
  seed(rulesDir, { key: 'iron-rule-17', number: 17, scope: 'global', type: 'iron-rule', priority: 'P0' }, '删文档前先核对绝对路径。')

  const withMarkers = fakeCtx()
  writeFileSync(agentsPath, `# A\n${RULES_BEGIN}\n${RULES_END}\n`, 'utf8')
  const h1 = installHook(withMarkers.ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  await withMarkers.state.pre(preStepPayload('s1', '看看'), async () => ({ kind: 'enter' }))
  assert.equal(contextText(withMarkers.state).includes('删文档前先核对绝对路径'), false)
  h1.dispose()

  rmSync(agentsPath)
  const withoutMarkers = fakeCtx()
  const h2 = installHook(withoutMarkers.ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  await withoutMarkers.state.pre(preStepPayload('s2', '看看'), async () => ({ kind: 'enter' }))
  assert.match(contextText(withoutMarkers.state, 's2'), /【规则·global】删文档前先核对绝对路径。/)
  h2.dispose()
  assert.equal(join(home, 'AGENTS.md'), agentsPath)
})

test('hook：规则缓存 30s（同一步重复读目录不重扫），invalidateRulesCache 立即失效', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir, { roleId: 'reviewer' }) })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '一'), async () => ({ kind: 'enter' }))
  assert.ok([...hook.cache.keys()].some((key) => String(key).startsWith('#rules|')))
  assert.ok(hook.invalidateRulesCache() >= 1)
  assert.equal([...hook.cache.keys()].some((key) => String(key).startsWith('#rules|')), false)
  // service.invalidateCache 走 cache.clear()，规则缓存同表 → 一并失效。
  await state.pre(preStepPayload('s1', '二'), async () => ({ kind: 'enter' }))
  hook.cache.clear()
  assert.equal([...hook.cache.keys()].length, 0)
})

// ---------------------------------------------------------------------------
// 提案 / 确认
// ---------------------------------------------------------------------------

test('hook：owner 规则句 → 本轮 context 追加一条候选提示 + 候选落盘', async (t) => {
  const { rulesDir } = freshHome(t)
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  const text = contextText(state)
  assert.equal((text.match(/【规则候选】/g) || []).length, 1, '每会话每轮最多一条')
  // R8-05：提示行由 buildProposalAskLine 生成，必须带可执行 nonce（不是"去问用户"）。
  assert.match(text, /回复「收录 p[0-9a-z]{8}」确认收进铁律/)
  const proposals = listProposals({ rulesDir }).proposals
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].status, 'pending')
})

test('hook：askMode=panel（不含 chat）→ 不自动起草（面板手动 /rules/propose 才提案）', async (t) => {
  const { rulesDir } = freshHome(t)
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir, {}, { askMode: 'panel' }) })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  assert.equal(contextText(state).includes('【规则候选】'), false)
  assert.equal(listProposals({ rulesDir }).proposals.length, 0)
})

test('hook：冷却中的候选只进面板不提示', async (t) => {
  const { rulesDir } = freshHome(t)
  const cfg = cfgOf(rulesDir)
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfg })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  const made = listProposals({ rulesDir }).proposals[0]
  rejectProposal({ id: made.id, reason: '不需要', rulesDir, config: cfg })
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  assert.equal(contextText(state).includes('【规则候选】'), false)
  const cooling = listProposals({ rulesDir }).proposals.find((item) => item.cooling === true)
  assert.ok(cooling, '候选仍在面板可查（cooling:true）')
})

test('hook：确认短语 → 下一轮自动收录，context 给【规则已收录】', async (t) => {
  resetSessionPending()
  const { rulesDir } = freshHome(t)
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  assert.equal(listProposals({ rulesDir }).proposals[0].status, 'pending')
  // R8-05 契约变更：只认「收录 <id8>」nonce（原「确认」断言作废）。
  const nonce = proposalNonce(listProposals({ rulesDir }).proposals[0])
  assert.match(nonce, /^p[0-9a-z]{8}$/)
  await state.pre(preStepPayload('s1', `收录 ${nonce}`), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.match(text, /【规则已收录】/)
  assert.deepEqual(readdirSync(rulesDir).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').length, 1)
})

test('hook：需要改写且无模型 → 【规则待人工处理】并转面板（不阻断）', async (t) => {
  resetSessionPending()
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-src-keep', number: 1, modality: 'must', object: '源文件', exceptions: ['正在被引用的文件'] }, '源文件必须保留。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '源文件必须保留，过程稿归档到临时目录'), async () => ({ kind: 'enter' }))
  await flushProposalScheduler()
  const pending = listProposals({ rulesDir, status: 'pending' }).proposals
  assert.equal(pending.length, 1)
  assert.equal(pending[0].relation.relation, 'merge')
  // R8-05 契约变更：确认句必须带 nonce，否则不会进入 apply。
  await state.pre(preStepPayload('s1', `收录 ${proposalNonce(pending[0])}`), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.match(text, /【规则待人工处理】/)
  assert.match(text, /面板确认/)
  assert.equal(listProposals({ rulesDir }).proposals[0].status, 'needs_manual')
})

test('hook：subagent 会话跳过提案与注入（召回同口径）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  let recallCalls = 0
  const hook = installHook(ctx, {
    backend: { async recall() { recallCalls += 1; return { prefix: 'X', hits: 1 } } },
    config: cfgOf(rulesDir, { roleId: 'reviewer' }),
  })
  t.after(() => hook.dispose())
  await state.pre({
    agent: { session: { id: 's9', header: { origin: 'subagent' } } },
    messages: userMsg('以后都别删源文件'),
  }, async () => ({ kind: 'enter' }))
  assert.equal(recallCalls, 0)
  assert.equal(contextText(state, 's9'), '')
  assert.equal(jsonProposals(rulesDir).length, 0)
})

test('hook：规则目录不可读 → fail-open（召回照常，不抛）', async (t) => {
  const { home } = freshHome(t)
  const rulesDir = join(home, 'not-a-dir')
  writeFileSync(rulesDir, 'i am a file', 'utf8')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir) })
  t.after(() => hook.dispose())
  const decision = { kind: 'enter' }
  assert.equal(await state.pre(preStepPayload('s1', '看看'), async () => decision), decision)
  assert.match(contextText(state), /【你想到的旧事】/)
})

test('hook：rules.enabled=false → 不注入、不提案（召回与旧行为一致）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, {
    backend: quietBackend(),
    config: cfgOf(rulesDir, { roleId: 'reviewer' }, { enabled: false }),
  })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '以后都别删源文件'), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.equal(text.includes('只审不施工'), false)
  assert.equal(text.includes('【规则候选】'), false)
  assert.match(text, /【你想到的旧事】/)
  assert.equal(jsonProposals(rulesDir).length, 0)
})

test('hook：规则写入不破坏采纳结算（recallId/markRecallUsed 仍按原路径工作）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const used = []
  const injected = '网关端口 3982 是回调端口'
  const hook = installHook(ctx, {
    backend: {
      async recall() {
        return { prefix: `【你想到的旧事】${injected}`, hits: 1, recallId: 3, injectedNodes: [{ id: 'n1', text: injected }] }
      },
      markRecallUsed(id, flag) { used.push([id, flag]); return { ok: true } },
    },
    config: cfgOf(rulesDir, { roleId: 'reviewer' }),
  })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '网关端口怎么起'), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.ok(text.includes(injected))
  state.handlers['agent/assistant-stream']({
    agent: { id: 's1' },
    frame: { type: 'chunk', turn: 1, step: 1, chunk: { type: 'text-delta', text: `按记忆：${injected}` } },
  })
  state.handlers['agent/turn-stopping']({ agent: { session: { id: 's1' } } })
  assert.deepEqual(used, [[3, true]])
  assert.equal(readFileSync(join(rulesDir, 'rule-role.md'), 'utf8').includes('只审不施工'), true)
})

// ---------------------------------------------------------------------------
// R8-07：预算关闭 / 排序 / 缓存键 / win32 路径
// ---------------------------------------------------------------------------

test('buildRulesPrefix：injectChars=0 = 关闭注入（不是无限预算）', (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const got = buildRulesPrefix({
    identity: { roleId: 'reviewer' }, rulesDir, config: cfgOf(rulesDir, {}, { injectChars: 0 }),
  })
  assert.equal(got.text, '', '0 预算必须注入空串')
  assert.deepEqual(got.keys, [])
  assert.equal(got.mode, 'off')
  assert.equal(got.disabled, true)
})

test('hook：injectChars=0 时 role 规则不进 context（召回照常）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, {
    backend: quietBackend(),
    config: cfgOf(rulesDir, { roleId: 'reviewer' }, { injectChars: 0 }),
  })
  t.after(() => hook.dispose())
  await state.pre(preStepPayload('s1', '看看'), async () => ({ kind: 'enter' }))
  const text = contextText(state)
  assert.equal(text.includes('【规则·'), false)
  assert.match(text, /【你想到的旧事】/, '关闭规则注入不得连召回一起关掉')
})

test('buildRulesPrefix：排序=铁律编号 → priority → key（priority 真正参与）', (t) => {
  const { rulesDir } = freshHome(t)
  // 直接给规则数组：普通规则 number=null（R8-01 契约），不依赖 store 对无编号规则的写入闸。
  // 普通规则：key 序（a < z）与 priority 序相反，必须 priority 优先。
  const rules = [
    { front: ruleFront({ key: 'rule-a-p2', number: null, scope: 'role:r1', priority: 'P2' }), text: '必须第二执行。' },
    { front: ruleFront({ key: 'rule-z-p0', number: null, scope: 'role:r1', priority: 'P0' }), text: '必须第一执行。' },
    // 铁律：编号序压过 priority。
    { front: ruleFront({ key: 'iron-rule-12', number: 12, type: 'iron-rule', scope: 'role:r1', priority: 'P2' }), text: '必须铁律十二。' },
    { front: ruleFront({ key: 'iron-rule-5', number: 5, type: 'iron-rule', scope: 'role:r1', priority: 'P3' }), text: '必须铁律五。' },
  ]
  const got = buildRulesPrefix({
    identity: { roleId: 'r1' }, rulesDir, rules, config: cfgOf(rulesDir), budget: 4000,
  })
  assert.deepEqual(got.keys, ['iron-rule-5', 'iron-rule-12', 'rule-z-p0', 'rule-a-p2'])
})

test('hook：缓存键含预算 + 规则文件最大 mtime（改预算/原地改正文都生效）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const config = cfgOf(rulesDir, { roleId: 'reviewer' })
  const hook = installHook(ctx, { backend: quietBackend(), config })
  t.after(() => hook.dispose())
  const rulesKeys = () => [...hook.cache.keys()].filter((key) => String(key).startsWith('#rules|'))

  await state.pre(preStepPayload('s1', '一'), async () => ({ kind: 'enter' }))
  assert.match(contextText(state), /必须只审不施工。/)
  const firstKeys = rulesKeys()
  assert.equal(firstKeys.length, 1)

  // 改预算 → 换键（1s 内生效，不需要重启/清缓存）。
  config.rules.injectChars = 20
  await state.pre(preStepPayload('s1', '二'), async () => ({ kind: 'enter' }))
  assert.ok(rulesKeys().length >= 2, '预算必须进缓存键')
  assert.ok(Array.from(contextText(state).replace('【规则·role:reviewer】', '')).length <= 20, '新预算立即生效')

  config.rules.injectChars = 600
  await state.pre(preStepPayload('s1', '三'), async () => ({ kind: 'enter' }))
  // 原地改正文：目录 mtime 不变，只有文件 mtime 变——缓存键必须能发现。
  const file = join(rulesDir, 'rule-role.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('必须只审不施工。', '必须只审不施工并留档。'), 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 10))
  await state.pre(preStepPayload('s1', '四'), async () => ({ kind: 'enter' }))
  assert.match(contextText(state), /并留档/, '文件最大 mtime 必须进缓存键')
})

test('hook：规则缓存 TTL 淘汰（过期 #rules 条目被清扫）', async (t) => {
  const { rulesDir } = freshHome(t)
  seed(rulesDir, { key: 'rule-role', number: 1, scope: 'role:reviewer' }, '必须只审不施工。')
  const { ctx, state } = fakeCtx()
  const hook = installHook(ctx, { backend: quietBackend(), config: cfgOf(rulesDir, { roleId: 'reviewer' }) })
  t.after(() => hook.dispose())
  hook.cache.set('#rules|v2|expired', { text: '过期', exp: Date.now() - 1000, meta: {} })
  await state.pre(preStepPayload('s1', '看看'), async () => ({ kind: 'enter' }))
  assert.equal(hook.cache.has('#rules|v2|expired'), false, 'TTL 过期必须淘汰')
})

test('scopeMatches：win32 大小写/分隔符归一；posix 大小写敏感；软链按 realpath 命中', (t) => {
  const { home } = freshHome(t)
  const win32 = { platform: 'win32', realpath: false }
  assert.equal(scopeMatches('workspace:C:\\Work\\App', '', 'c:/work/app/sub', win32), true)
  assert.equal(scopeMatches('workspace:c:/work/app', '', 'C:\\Work\\App\\sub', win32), true)
  assert.equal(scopeMatches('workspace:C:\\Work\\App', '', 'c:/work/app2', win32), false)
  assert.equal(scopeMatches('workspace:C:\\Work\\App', '', 'c:/work/app/sub', { platform: 'linux', realpath: false }), false,
    '非 win32 不得大小写不敏感')
  assert.equal(scopeMatches('workspace:/tmp/ws\\', '', '/tmp/ws/sub', { realpath: false }), true, '分隔符必须归一')

  const real = join(home, 'real-ws')
  mkdirSync(real, { recursive: true })
  const link = join(home, 'link-ws')
  try {
    symlinkSync(real, link, 'dir')
  } catch {
    return // 平台不允许软链（如无权限的 Windows）：跳过该断言
  }
  assert.equal(scopeMatches(`workspace:${link}`, '', real), true, '软链与真实目录必须视为同一工作区')
})

test('R9-14：AGENTS 块陈旧 → 按无块处理，降级注入 global（避免全局规则零次出现）', (t) => {
  const { rulesDir, agentsPath } = freshHome(t)
  writeFileSync(agentsPath, `# A\n${RULES_BEGIN}\n${RULES_END}\n`, 'utf8')
  seed(rulesDir, { key: 'rule-global', number: 1, scope: 'global', type: 'iron-rule', priority: 'P0' }, '必须让全局规则可见。')
  const fresh = buildRulesPrefix({ identity: {}, rulesDir, config: cfgOf(rulesDir) })
  assert.equal(fresh.keys.includes('rule-global'), false, '块新鲜时 global 走摘要，不重复注入')
  const stale = buildRulesPrefix({ identity: {}, rulesDir, config: cfgOf(rulesDir), agentsStale: true })
  assert.equal(stale.hasAgentsMarkers, false, '陈旧块必须按无块处理')
  assert.equal(stale.mode, 'global')
  assert.deepEqual(stale.keys, ['rule-global'])
})
