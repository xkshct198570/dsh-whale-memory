/**
 * 规则路由契约（R3a 读接口 + R3b 提案写入口 + R5 编辑/版本/回滚）的 JSON 形状。
 * 用 stub backend + 临时规则目录 + 假 req/res 调 createRoutes，不启真 HTTP 服务器。
 * R5 段每个用例自建临时规则根 + 独立 DB：审计/镜像断言按 origin 过滤，
 * 共用 DB 会让别的根的同 key 规则污染计数。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { closeDb, openDb } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { readHistory, readRule, serializeRuleDocument, writeRule } from '../../src/core/rule-store.js'
import { LEGACY_IRON_RULE_ID } from '../../src/core/rule-mirror.js'
import { Config } from '../../src/host/config.js'
import { CONFIG_GROUPS, createRoutes } from '../../src/host/routes.js'
import {
  createPayload,
  deletePayload,
  importLegacyPayload,
  rebuildMirrorPayload,
  revertPayload,
  ruleDetailPayload,
  rulesListPayload,
  updatePayload,
} from '../../src/host/rules-routes.js'

let root
let db
let backend
let handler
let config

function frontOf(index, extra = {}) {
  return {
    key: `rule-${index}`,
    type: index === 1 ? 'iron-rule' : 'rule',
    number: index,
    priority: index === 1 ? 'P0' : 'P2',
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
    origin: 'contract',
    ...extra,
  }
}

function fakeReq(method, url, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const req = Readable.from(chunks)
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function fakeRes() {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(body) {
      this.body = body
      this.headersSent = true
      this.writableEnded = true
      resolveDone(this)
    },
  }
  return { res, done }
}

async function call(method, path, payload) {
  const { res, done } = fakeRes()
  await handler(fakeReq(method, path, payload), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

before(() => {
  // 规则根必须是独立临时目录（dirname(root) 就是 AGENTS.md 的位置）：
  // 直接用 mkdtemp 会让 AGENTS 落到系统 /tmp，污染别的东西也让自己被别的 AGENTS 干扰。
  root = join(mkdtempSync(join(tmpdir(), 'whale-rules-routes-')), 'rules')
  nodeFs.mkdirSync(root, { recursive: true })
  db = openDb(mkdtempSync(join(tmpdir(), 'whale-rules-routes-db-')))
  backend = { withDb: (fn) => fn(db) }
  config = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir: root, requireGit: false, mirrorAuto: true },
  }
  assert.equal(writeRule(root, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(root, { front: frontOf(2), text: '必须保留审计日志。' }, { git: false }).ok, true)
  handler = createRoutes({ config, backend, log: () => {} })
})

after(() => {
  closeDb(db)
  nodeFs.rmSync(dirname(root), { recursive: true, force: true })
})

test('GET /rules：dir/git/rules/manifest 形状完整，规则字段齐全', async () => {
  const { status, body } = await call('GET', '/whale-memory/api/rules')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.dir, root)
  for (const key of ['available', 'version', 'required', 'checkedAt']) assert.ok(key in body.git, `git.${key}`)
  assert.equal(body.git.required, false)
  assert.equal(body.rules.length, 2)
  const fields = ['key', 'type', 'number', 'priority', 'scope', 'role', 'status', 'updated', 'title', 'excerpt', 'chars']
  for (const rule of body.rules) for (const field of fields) assert.ok(field in rule, `rules[].${field}`)
  assert.equal(body.rules[0].key, 'rule-1')
  assert.equal(body.rules[0].type, 'iron-rule')
  assert.equal(body.rules[0].priority, 'P0')
  assert.equal(body.rules[0].status, 'active')
  assert.equal(body.rules[0].chars, Array.from('必须先验证再覆盖正式库。').length)
  assert.match(body.rules[0].excerpt, /必须/)
  assert.deepEqual(body.manifest.byStatus, { active: 2 })
  // 编号契约（R8）：只有 iron-rule 占号；普通 rule 的 number=null，不计入 total/nextNumber。
  assert.equal(body.manifest.total, 1, 'manifest.total 只数铁律编号')
  assert.equal(body.manifest.nextNumber, 2)
})

test('GET /rules/:key：front/text/bodyStart + history 数组', async () => {
  const { status, body } = await call('GET', '/whale-memory/api/rules/rule-1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.rule.front.key, 'rule-1')
  assert.equal(body.rule.front.number, 1)
  assert.equal(body.rule.text, '必须先验证再覆盖正式库。')
  // 规范嵌套 front + 扁平字段并存（客户端直接读 rule.number/rule.origin）。
  assert.equal(body.rule.number, 1)
  assert.equal(body.rule.type, 'iron-rule')
  assert.equal(body.rule.origin, 'contract')
  assert.match(body.rule.path, /rule-1\.md$/)
  assert.equal(typeof body.rule.bodyStart, 'number')
  assert.ok(body.rule.bodyStart > 0)
  assert.ok(Array.isArray(body.history))
  for (const key of ['available', 'version', 'required', 'checkedAt']) assert.ok(key in body.git)

  const missing = await call('GET', '/whale-memory/api/rules/no-such-key')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error, 'rule_not_found')
})

test('GET /rules/git-status：强制刷新仍返回同一 git 形状', async () => {
  const { status, body } = await call('GET', '/whale-memory/api/rules/git-status')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  for (const key of ['available', 'version', 'required', 'checkedAt']) assert.ok(key in body.git)
})

test('GET /rules/proposals：候选清单形状（客户端软降级入口）', async () => {
  const empty = await call('GET', '/whale-memory/api/rules/proposals')
  assert.equal(empty.status, 200)
  assert.equal(empty.body.ok, true)
  assert.ok(Array.isArray(empty.body.proposals))
  assert.deepEqual(empty.body.proposals, empty.body.items)
  assert.equal(empty.body.proposals.length, 0)
})

test('POST /rules/rebuild-mirror：写镜像并回 status；重复触发幂等', async () => {
  const first = await call('POST', '/whale-memory/api/rules/rebuild-mirror')
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.mirror.created, 2)
  assert.equal(first.body.status.mirrored, 2)
  assert.equal(first.body.status.missing, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 2)

  const second = await call('POST', '/whale-memory/api/rules/rebuild-mirror')
  assert.equal(second.body.mirror.created, 0)
  assert.equal(second.body.mirror.updated, 2)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 2)
})

test('POST /rules/import-legacy：铁律节点→文件；第二次 skipped', async () => {
  const text = '必须先在临时目录验证再覆盖正式库；例外：只读查询不适用。'
  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
    role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
    VALUES (?,?,?,?,'core','procedural','owner','active','','','',?,?,1.0,0,1,?,'legacy',?,?)`)
    .run(LEGACY_IRON_RULE_ID, text, contentHash(text), bigrams(text), '["iron-rule"]', '旧铁律', LEGACY_IRON_RULE_ID, now, now)

  const first = await call('POST', '/whale-memory/api/rules/import-legacy', {})
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  // 编号契约（R8）：legacy 导入不再回落历史号 17，由仓储分配器取号（本仓已有 iron-rule-1 → 2）。
  assert.equal(first.body.key, 'iron-rule-2')
  assert.equal(first.body.legacy, true)
  assert.equal(first.body.skipped, false)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-2.md')), true)

  const second = await call('POST', '/whale-memory/api/rules/import-legacy', {})
  assert.equal(second.body.ok, true)
  assert.equal(second.body.skipped, true)
})

test('requireGit=true 且 git 缺失：写动作硬拦 git_required；读仍可用', async () => {
  const missing = () => ({ available: false, version: '', error: 'git_not_installed', checkedAt: 1 })
  const list = rulesListPayload({ root, config: { ...config, rules: { ...config.rules, requireGit: true } }, detect: missing })
  assert.equal(list.ok, true, '读列表不因 git 缺失失败')
  assert.equal(list.git.required, true)
  assert.equal(list.git.available, false)

  const blocked = rebuildMirrorPayload({
    root,
    config: { ...config, rules: { ...config.rules, requireGit: true } },
    backend,
    detect: missing,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'git_required')

  const disabled = rebuildMirrorPayload({
    root,
    config: { ...config, rules: { ...config.rules, enabled: false } },
    backend,
    detect: () => ({ available: true, version: '2.43.0', error: null, checkedAt: 1 }),
  })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error, 'rules_disabled')
})

test('错误形状与 method 白名单：405/404 都是 {ok:false,error}', async () => {
  const wrong = await call('POST', '/whale-memory/api/rules')
  assert.equal(wrong.status, 405)
  assert.equal(wrong.body.ok, false)
  assert.equal(wrong.body.error, 'method_not_allowed')
  assert.equal(wrong.headers.allow, 'GET')

  const buildGet = await call('GET', '/whale-memory/api/rules/rebuild-mirror')
  assert.equal(buildGet.status, 405)
  assert.equal(buildGet.body.error, 'method_not_allowed')

  const unknown = await call('GET', '/whale-memory/api/rules/a/b')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'not_found')
})

test('panel.tab 接受 rules（规则页签可设为默认，不被 schema 拒绝）', () => {
  const parsed = Config({ panel: { tab: 'rules' } })
  assert.equal(parsed.panel.tab, 'rules')
  assert.ok(CONFIG_GROUPS.includes('rules'), 'CONFIG_GROUPS 必须含 rules（新组保存/回读白名单）')
})

test('GET /config 含 rules 组与 R3a 默认值', async () => {
  const { status, body } = await call('GET', '/whale-memory/api/config')
  assert.equal(status, 200)
  assert.ok(body.config.rules && typeof body.config.rules === 'object')
  assert.equal(body.config.rules.enabled, true)
  assert.equal(body.config.rules.requireGit, false)
  assert.equal(body.config.rules.askMode, 'panel+chat')
  assert.equal(body.config.rules.maxProposals, 20)
  assert.equal(body.config.rules.guardStrict, true)
  assert.equal(body.config.rules.mirrorAuto, true)
  assert.equal(body.config.rules.askCooldownDays, 30)
})

test('纯函数详情：坏的 key 直接 rule_not_found，不抛', () => {
  const got = ruleDetailPayload({ root, config, key: '../etc/passwd' })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'invalid_key')
  // 幂等按 origin=`legacy:<node id>` 判定：同一旧节点再次导入必须 skipped（不再重新取号）。
  const imported = importLegacyPayload({ root, config, backend })
  assert.equal(imported.ok, true)
  assert.equal(imported.skipped, true, '同一 legacy 节点再次导入应幂等跳过')
})

// ---------------------------------------------------------------------------
// R3b：提案制写入口的 POST 契约（propose/apply/reject/render-agents）
// ---------------------------------------------------------------------------

test('POST /rules/propose：面板手动提案返回客户端视图（relation 字符串 + candidate/source）', async () => {
  const { status, body } = await call('POST', '/whale-memory/api/rules/propose', {
    text: '以后都别删源文件',
    source: 'owner',
  })
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.cooling, false)
  assert.equal(typeof body.proposal.relation, 'string', '客户端按字符串渲染关系徽标')
  // 仓里已有规则时，"比对过、无关系"是 unrelated；两者下游动作相同（可直接提案）。
  assert.ok(['new', 'unrelated'].includes(body.proposal.relation), body.proposal.relation)
  assert.equal(body.proposal.status, 'pending')
  for (const key of ['text', 'key', 'type', 'number', 'priority', 'scope', 'modality', 'conditions', 'exceptions', 'chars']) {
    assert.ok(key in body.proposal.candidate, `candidate.${key}`)
  }
  assert.equal(body.proposal.source.text, '以后都别删源文件')
  assert.equal(body.proposal.guard.ok, true)
  assert.ok(Array.isArray(body.proposal.affected))

  const listed = await call('GET', '/whale-memory/api/rules/proposals?status=pending')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length >= 1, true)
  assert.ok(listed.body.items.some((item) => item.id === body.proposal.id))
  const filtered = await call('GET', '/whale-memory/api/rules/proposals?status=accepted')
  assert.equal(filtered.body.items.some((item) => item.id === body.proposal.id), false, 'status 过滤必须生效')
})

test('POST /rules/propose：隐私/空文本/规则关闭分别给 400/400/403', async () => {
  const privacy = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都记住手机号 13800138000' })
  assert.equal(privacy.status, 400)
  assert.equal(privacy.body.error, 'privacy')
  const empty = await call('POST', '/whale-memory/api/rules/propose', { text: '  ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error, 'empty_text')

  const saved = config.rules.enabled
  config.rules.enabled = false
  try {
    const off = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都别删源文件' })
    assert.equal(off.status, 403)
    assert.equal(off.body.error, 'rules_disabled')
    const applyOff = await call('POST', '/whale-memory/api/rules/apply', { id: 'p1234567890123_abcd1234' })
    assert.equal(applyOff.status, 403)
    assert.equal(applyOff.body.error, 'rules_disabled')
  } finally {
    config.rules.enabled = saved
  }
})

test('POST /rules/apply：未知候选 404；正常候选落盘并回 applied（含 agents 状态）', async () => {
  const missing = await call('POST', '/whale-memory/api/rules/apply', { id: 'p1234567890123_deadbeef' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'proposal_not_found')

  const proposed = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都别用云端存日志' })
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body))
  const id = proposed.body.proposal.id
  const applied = await call('POST', '/whale-memory/api/rules/apply', { id })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.ok, true)
  assert.equal(applied.body.proposal.status, 'accepted')
  assert.equal(typeof applied.body.applied.key, 'string')
  assert.equal(Number(applied.body.applied.number) > 0, true)
  assert.ok(applied.body.applied.agents, 'AGENTS 渲染状态必须回给面板（ok/code）')
  const detail = await call('GET', `/whale-memory/api/rules/${encodeURIComponent(applied.body.applied.key)}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.rule.key, applied.body.applied.key)

  const again = await call('POST', '/whale-memory/api/rules/apply', { id })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'proposal_not_pending')
})

test('POST /rules/reject：写冷却并回 rejected；已裁定候选不可再拒', async () => {
  const proposed = await call('POST', '/whale-memory/api/rules/propose', { text: '必须让临时件先归档到临时目录' })
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body))
  const id = proposed.body.proposal.id
  const rejected = await call('POST', '/whale-memory/api/rules/reject', { id, reason: '不需要' })
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
  assert.equal(rejected.body.proposal.status, 'rejected')
  const again = await call('POST', '/whale-memory/api/rules/reject', { id })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'proposal_not_pending')
})

test('POST /rules/render-agents：无标记 ok:false code:no_markers；有标记才改块内', async () => {
  const noMarkers = await call('POST', '/whale-memory/api/rules/render-agents')
  assert.equal(noMarkers.status, 200)
  assert.equal(noMarkers.body.ok, false)
  assert.equal(noMarkers.body.code, 'no_markers')

  const agents = join(dirname(root), 'AGENTS.md')
  const before = `# A\n\n块外\n<!-- whale-memory:rules:begin -->\n旧\n<!-- whale-memory:rules:end -->\n尾\n`
  nodeFs.writeFileSync(agents, before, 'utf8')
  try {
    const rendered = await call('POST', '/whale-memory/api/rules/render-agents')
    assert.equal(rendered.status, 200)
    assert.equal(rendered.body.ok, true, JSON.stringify(rendered.body))
    assert.equal(rendered.body.code, '')
    assert.ok(rendered.body.count >= 1)
    const after = nodeFs.readFileSync(agents, 'utf8')
    assert.match(after, /^# A\n\n块外\n/, '块外开头不得被改')
    assert.match(after, /尾\n$/, '块外结尾不得被改')
    assert.match(after, /## 规则摘要（自动生成，勿手改）/)
  } finally {
    nodeFs.rmSync(agents, { force: true })
  }
})

test('规则守卫拒绝（payload 层）：改写丢例外 → rule_guard_failed + 422 语义', async () => {
  const { applyPayload } = await import('../../src/host/rules-routes.js')
  const { createProposal } = await import('../../src/core/rule-proposal.js')
  const { writeRule } = await import('../../src/core/rule-store.js')
  const local = mkdtempSync(join(tmpdir(), 'whale-rules-guard-'))
  try {
    const front = frontOf(1, { key: 'rule-keep', scope: 'global', modality: 'must', object: '源文件', exceptions: ['正在被引用的文件'] })
    assert.equal(writeRule(local, { front, text: '源文件必须保留。' }, { git: false }).ok, true)
    const made = createProposal({
      text: '源文件必须保留，过程稿归档到临时目录',
      rulesDir: local,
      config: { rules: {} },
      identity: { userId: 'u1', roleId: '', workspace: '' },
    })
    assert.equal(made.ok, true, made.code)
    const payload = await applyPayload({
      root: local,
      config: { rules: {} },
      body: { id: made.proposal.id, decisions: { text: '源文件必须保留，过程稿归档到临时目录。' } },
      git: false,
    })
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'rule_guard_failed')
    assert.equal(payload.status, 'needs_manual')
    assert.ok(payload.failures.some((item) => item.code === 'dropped_exception'))
  } finally {
    nodeFs.rmSync(local, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R5：编辑 / 版本 diff / 回滚（update / diff / versions / revert）
// ---------------------------------------------------------------------------

/** R5 用例的独立夹具：规则根 + 独立 DB + 独立 handler（避免共享状态串味）。 */
function freshFixture(t, extraRules = {}) {
  const base = mkdtempSync(join(tmpdir(), 'whale-rules-r5-'))
  const dir = join(base, 'rules')
  nodeFs.mkdirSync(dir, { recursive: true })
  const localDb = openDb(join(base, 'db'))
  const localBackend = { withDb: (fn) => fn(localDb) }
  const localConfig = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir, requireGit: false, mirrorAuto: true, renderAgents: true, ...extraRules },
  }
  t.after(() => {
    closeDb(localDb)
    nodeFs.rmSync(base, { recursive: true, force: true })
  })
  return {
    base,
    dir,
    db: localDb,
    backend: localBackend,
    config: localConfig,
    handler: createRoutes({ config: localConfig, backend: localBackend, log: () => {} }),
    agents: join(base, 'AGENTS.md'),
  }
}

async function callWith(routeHandler, method, path, payload) {
  const { res, done } = fakeRes()
  await routeHandler(fakeReq(method, path, payload), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

function fakeGit() {
  const calls = []
  const exec = (file, args) => {
    const argv = Array.isArray(args) ? args : []
    calls.push({ file, argv })
    if (argv.includes('rev-parse')) return 'true\n'
    if (argv.includes('--cached')) {
      const err = new Error('staged diff')
      err.status = 1
      throw err
    }
    if (argv.includes('commit')) return 'committed\n'
    return ''
  }
  return {
    exec,
    calls,
    commitMessages: () => calls
      .filter((call) => call.argv.includes('commit'))
      .map((call) => call.argv[call.argv.indexOf('-m') + 1]),
  }
}

function gitInstalled() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('POST /rules/update：正文编辑 version+1，镜像/AGENTS/审计全部落地', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(fx.dir, {
    front: frontOf(2, { type: 'iron-rule', priority: 'P1' }),
    text: '必须保留审计日志。',
  }, { git: false }).ok, true)
  // 普通 rule 不进 AGENTS 摘要：摘要数量必须仍是 2。
  assert.equal(writeRule(fx.dir, { front: frontOf(3, { type: 'rule' }), text: '必须每周归档一次。' }, { git: false }).ok, true)
  nodeFs.writeFileSync(
    fx.agents,
    '# A\n\n块外\n<!-- whale-memory:rules:begin -->\n旧\n<!-- whale-memory:rules:end -->\n尾\n',
    'utf8',
  )

  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'rule-1',
    patch: { text: '必须先备份再覆盖正式库。' },
    identity: { userId: 'u9' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.ok, true)
  assert.equal(body.changed, true)
  assert.equal(body.version, 2)
  assert.equal(body.previousVersion, 1)
  assert.equal(body.rule.version, 2)
  assert.equal(body.rule.front.version, 2)
  assert.equal(body.rule.text, '必须先备份再覆盖正式库。')
  assert.match(body.rule.path, /rule-1\.md$/)
  assert.equal(body.agents.ok, true, JSON.stringify(body.agents))
  assert.equal(body.agents.count, 3, 'global active 全收（铁律+普通规则）')
  assert.equal(body.mirror.ok, true)
  assert.equal(body.audit.ok, true)

  const agents = nodeFs.readFileSync(fx.agents, 'utf8')
  assert.equal((agents.match(/^- 铁律\d+/gm) || []).length, 2, '摘要行数 = active global 铁律数')
  assert.match(agents, /必须先备份再覆盖正式库。/)
  assert.match(agents, /^# A\n\n块外\n/, '块外开头不得被改')
  assert.match(agents, /尾\n$/, '块外结尾不得被改')

  const mirrored = fx.db.prepare("SELECT text, status FROM nodes WHERE origin = 'rule:rule-1'").get()
  assert.equal(mirrored.text, '必须先备份再覆盖正式库。')
  assert.equal(mirrored.status, 'active')

  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_edit' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_edit')
  assert.equal(audit.action, 'MERGE')
  assert.equal(audit.user_id, 'u9')
  assert.equal(audit.before_text, '必须先验证再覆盖正式库。')
  assert.equal(audit.after_text, '必须先备份再覆盖正式库。')
  assert.equal(JSON.parse(audit.payload).toVersion, 2)
  const evo = fx.db.prepare('SELECT * FROM evolution ORDER BY id DESC LIMIT 1').get()
  assert.equal(evo.old_value, '必须先验证再覆盖正式库。')
  assert.equal(evo.new_value, '必须先备份再覆盖正式库。')
})

test('POST /rules/update：改 key→400/未知字段→400/非法 scope→422，文件不动', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)

  const immutable = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'rule-1',
    patch: { key: 'rule-2' },
  })
  assert.equal(immutable.status, 400)
  assert.equal(immutable.body.error, 'immutable_field')
  assert.equal(immutable.body.detail.field, 'key')

  const unknown = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'rule-1',
    patch: { title: '偷偷改标题' },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error, 'invalid_patch')

  const scope = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'rule-1',
    patch: { scope: 'workspace:relative/path' },
  })
  assert.equal(scope.status, 422)
  assert.equal(scope.body.error, 'invalid_rule')
  assert.ok(scope.body.detail.some((item) => item.code === 'scope_workspace_relative'))

  const missing = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'no-such-key',
    patch: { text: '必须存在。' },
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'rule_not_found')

  const noKey = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/update', { patch: { text: '必须存在。' } })
  assert.equal(noKey.status, 400)
  assert.equal(noKey.body.error, 'invalid_key')

  const got = readRule(fx.dir, 'rule-1')
  assert.equal(got.rule.text, '必须先验证再覆盖正式库。')
  assert.equal(got.rule.front.version, 1)
})

test('update/revert：rules_disabled 与 git_required 闸门同 apply 一致', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  const entry = readHistory(fx.dir, 'rule-1').entries

  const disabled = updatePayload({
    root: fx.dir,
    config: { rules: { enabled: false, dir: fx.dir } },
    backend: fx.backend,
    body: { key: 'rule-1', patch: { text: '必须保留审计行。' } },
  })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error, 'rules_disabled')
  const disabledRevert = revertPayload({
    root: fx.dir,
    config: { rules: { enabled: false, dir: fx.dir } },
    body: { key: 'rule-1', rev: entry[0]?.rev || '20260101000000000' },
  })
  assert.equal(disabledRevert.error, 'rules_disabled')

  const missing = () => ({ available: false, version: '', error: 'git_not_installed', checkedAt: 1 })
  const blocked = updatePayload({
    root: fx.dir,
    config: { rules: { enabled: true, dir: fx.dir, requireGit: true } },
    body: { key: 'rule-1', patch: { text: '必须保留审计行。' } },
    detect: missing,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'git_required')
  const blockedRevert = revertPayload({
    root: fx.dir,
    config: { rules: { enabled: true, dir: fx.dir, requireGit: true } },
    body: { key: 'rule-1', rev: '20260101000000000' },
    detect: missing,
  })
  assert.equal(blockedRevert.error, 'git_required')
})

test('GET /rules/diff：行 diff 同/删/加正确；rev/key 缺失各自错误码', async (t) => {
  const fx = freshFixture(t)
  const v1 = '必须验证第一项。\n必须保留第二项。'
  const v2 = '必须验证第一项。\n必须删除第二项。'
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: v1 }, { git: false }).ok, true)
  assert.equal(writeRule(fx.dir, { front: frontOf(1, { version: 2 }), text: v2 }, { git: false }).ok, true)
  const entry = readHistory(fx.dir, 'rule-1').entries[0]

  const res = await callWith(
    fx.handler,
    'GET',
    `/whale-memory/api/rules/diff?key=rule-1&rev=${encodeURIComponent(entry.rev)}`,
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.key, 'rule-1')
  assert.equal(res.body.rev, entry.rev)
  assert.equal(res.body.source, 'history')
  assert.equal(res.body.oldText, v1)
  assert.equal(res.body.newText, v2)
  assert.deepEqual(res.body.diff, [
    { type: 'same', text: '必须验证第一项。' },
    { type: 'del', text: '必须保留第二项。' },
    { type: 'add', text: '必须删除第二项。' },
  ])
  for (const key of ['available', 'version', 'required', 'checkedAt']) assert.ok(key in res.body.git, `git.${key}`)

  const missingRev = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/diff?key=rule-1&rev=20000101000000000')
  assert.equal(missingRev.status, 404)
  assert.equal(missingRev.body.error, 'rev_not_found')
  const badRev = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/diff?key=rule-1&rev=not-a-rev')
  assert.equal(badRev.status, 400)
  assert.equal(badRev.body.error, 'invalid_rev')
  const noKey = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/diff?rev=20260101000000000')
  assert.equal(noKey.status, 400)
  assert.equal(noKey.body.error, 'invalid_key')
  const noRule = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/diff?key=no-such&rev=20260101000000000')
  assert.equal(noRule.status, 404)
  assert.equal(noRule.body.error, 'rule_not_found')
})

test('GET /rules/diff：超过 5000 行拒绝（413 diff_too_large）', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须保留审计行。' }, { git: false }).ok, true)
  // 手工快照可以比 500 字正文上限长得多（历史文件是生成物，不保证当时有长度闸）；
  // 这里直接落一份超长快照，验证"长度限制"真的在 diff 入口生效。
  const huge = Array.from({ length: 5001 }, (_, i) => `第 ${i + 1} 行`).join('\n')
  const serialized = serializeRuleDocument({ front: frontOf(1), text: huge })
  const rev = '20260101000000000'
  const historyDir = join(fx.dir, 'history', 'rule-1')
  nodeFs.mkdirSync(historyDir, { recursive: true })
  nodeFs.writeFileSync(join(historyDir, `${rev}.md`), serialized.text, 'utf8')

  const res = await callWith(fx.handler, 'GET', `/whale-memory/api/rules/diff?key=rule-1&rev=${rev}`)
  assert.equal(res.status, 413)
  assert.equal(res.body.error, 'diff_too_large')
  assert.equal(res.body.detail.limit, 5000)
  assert.ok(res.body.detail.oldLines > 5000)
})

test('POST /rules/revert：旧版本写回成新版本，审计 reason=rule_revert', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(fx.dir, { front: frontOf(1, { version: 2 }), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const entry = readHistory(fx.dir, 'rule-1').entries[0]

  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/revert', { key: 'rule-1', rev: entry.rev })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.version, 3)
  assert.equal(res.body.previousVersion, 2)
  assert.equal(res.body.revertedTo, entry.rev)
  assert.equal(res.body.source, 'history')
  assert.equal(res.body.rule.text, '必须先验证再覆盖正式库。')
  const got = readRule(fx.dir, 'rule-1')
  assert.equal(got.rule.text, '必须先验证再覆盖正式库。')
  assert.equal(got.rule.front.version, 3)
  assert.equal(readHistory(fx.dir, 'rule-1').entries.length, 2, '回滚作为新版本留快照，旧历史不删')

  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_revert' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_revert')
  assert.equal(audit.before_text, '必须保留审计日志。')
  assert.equal(audit.after_text, '必须先验证再覆盖正式库。')
  assert.equal(JSON.parse(audit.payload).revertTo, entry.rev)

  const missing = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/revert', {
    key: 'rule-1',
    rev: '20000101000000000',
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'rev_not_found')
})

test('GET /rules/versions：当前+历史（+git 提交）列表字段齐全', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(fx.dir, { front: frontOf(1, { version: 2 }), text: '必须保留审计日志。' }, { git: false }).ok, true)

  const res = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/versions?key=rule-1')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true)
  assert.equal(res.body.current.version, 2)
  assert.equal(res.body.versions[0].kind, 'current')
  const fields = ['kind', 'rev', 'version', 'ts', 'source', 'commit']
  for (const row of res.body.versions) for (const field of fields) assert.ok(field in row, `versions[].${field}`)
  const historyRows = res.body.versions.filter((row) => row.kind === 'history')
  assert.equal(historyRows.length, 1)
  assert.equal(historyRows[0].version, 1)
  assert.match(historyRows[0].ts, /^\d{4}-\d{2}-\d{2}T/)

  const missing = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/versions?key=no-such-key')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'rule_not_found')

  // git 提交条目依赖真实 git；本机没有 git 时跳过该断言（读接口本身照常返回历史）。
  if (!gitInstalled()) return
  const gitFx = freshFixture(t)
  assert.equal(writeRule(gitFx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, {}).ok, true)
  const committed = await callWith(gitFx.handler, 'POST', '/whale-memory/api/rules/update', {
    key: 'rule-1',
    patch: { text: '必须先备份再覆盖正式库。' },
  })
  assert.equal(committed.status, 200, JSON.stringify(committed.body))
  assert.equal(committed.body.commit, 'rule: update rule-1 v2', 'commit 是消息字符串（面板直接展示）')
  assert.equal(committed.body.commitInfo.ok, true, JSON.stringify(committed.body.commitInfo))
  const withGit = await callWith(gitFx.handler, 'GET', '/whale-memory/api/rules/versions?key=rule-1')
  assert.equal(withGit.status, 200, JSON.stringify(withGit.body))
  const gitRows = withGit.body.versions.filter((row) => row.kind === 'git')
  assert.ok(gitRows.length >= 1, 'git 提交必须进 versions')
  assert.match(gitRows[0].commit, /^[0-9a-f]{7,40}$/)
})

test('updatePayload/revertPayload：本地 git 提交文案 rule: update/revert（注入 exec）', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(fx.dir, { front: frontOf(1, { version: 2 }), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const entry = readHistory(fx.dir, 'rule-1').entries[0]
  const fake = fakeGit()

  const updated = updatePayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { key: 'rule-1', patch: { text: '必须先备份再覆盖正式库。' } },
    exec: fake.exec,
  })
  assert.equal(updated.ok, true, updated.error)
  assert.equal(updated.commit, 'rule: update rule-1 v3', 'commit 是消息字符串')
  assert.equal(updated.commitInfo.ok, true)

  const reverted = revertPayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { key: 'rule-1', rev: entry.rev },
    exec: fake.exec,
  })
  assert.equal(reverted.ok, true, reverted.error)
  assert.equal(reverted.commit, `rule: revert rule-1 to ${entry.rev}`)
  assert.deepEqual(fake.commitMessages(), [
    'rule: update rule-1 v3',
    `rule: revert rule-1 to ${entry.rev}`,
  ])
})

// ---------------------------------------------------------------------------
// R6：新建 / 停用 / 恢复（create / delete）
// ---------------------------------------------------------------------------

/** 铺满编号 1–17（跳过空号 6）：新建规则应当从 18 起。 */
function seedNumbered(fx, { max = 17, skip = 6 } = {}) {
  for (let n = 1; n <= max; n += 1) {
    if (n === skip) continue
    const text = n === 13 ? '必须保留本机专用规则正文。' : `必须保留第 ${n} 条规则。`
    // 编号只属于 iron-rule：要铺满 1–17 必须写成铁律，普通 rule 不占号（R8 契约）。
    const front = frontOf(n, { type: 'iron-rule', key: `iron-rule-${n}` })
    assert.equal(writeRule(fx.dir, { front, text }, { git: false }).ok, true, `写入第 ${n} 条失败`)
  }
}

function readManifestSync(dir) {
  return JSON.parse(nodeFs.readFileSync(join(dir, 'manifest.json'), 'utf8'))
}

test('POST /rules/create：铁律编号从 18 起、key 形状、渲染/镜像/审计落地', async (t) => {
  const fx = freshFixture(t)
  seedNumbered(fx)
  nodeFs.writeFileSync(fx.agents, '# A\n\n<!-- whale-memory:rules:begin -->\n<!-- whale-memory:rules:end -->\n尾\n', 'utf8')

  const draft = {
    text: '禁止把默认铁律播种到非规则目录。',
    type: 'iron-rule',
    priority: 'P0',
    scope: 'global',
  }
  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft,
    identity: { userId: 'u9' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.ok, true)
  assert.equal(body.key, 'iron-rule-18')
  assert.equal(body.number, 18, '1–17 已占（空号 6 不算），新建从 18 起')
  assert.equal(body.type, 'iron-rule')
  assert.equal(body.version, 1)
  assert.match(body.rule.front.created, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(body.rule.front.created, body.rule.front.updated)
  assert.equal(body.rule.front.status, 'active')
  assert.equal(body.rule.front.origin, 'manual:u9')
  assert.equal(body.rule.front.modality, 'must_not', '模态从正文推断（禁止→must_not）')
  assert.equal(body.rule.text, draft.text)
  assert.match(body.rule.path, /iron-rule-18\.md$/)
  assert.equal(body.commit, 'rule: create iron-rule-18 (#18)')
  assert.equal(body.commitInfo.ok, true)
  assert.equal(body.mirror.ok, true)
  assert.equal(body.audit.ok, true)
  assert.equal(nodeFs.existsSync(join(fx.dir, 'iron-rule-18.md')), true, '规则文件必须真的落盘')

  // 渲染：新建铁律进 AGENTS 摘要块内。
  const agents = nodeFs.readFileSync(fx.agents, 'utf8')
  assert.match(agents, /铁律18/)
  assert.match(agents, /禁止把默认铁律播种到非规则目录/)
  assert.match(agents, /^# A\n\n/, '块外开头不得被改')
  assert.match(agents, /尾\n$/, '块外结尾不得被改')

  // 镜像：active + pinned 1（铁律参与召回）。
  const row = fx.db.prepare("SELECT text, status, pinned FROM nodes WHERE origin = 'rule:iron-rule-18'").get()
  assert.ok(row, '镜像必须有 rule:iron-rule-18')
  assert.equal(row.text, draft.text)
  assert.equal(row.status, 'active')
  assert.equal(row.pinned, 1)

  // 审计：writes.reason=rule_create，before_text 为空（新建没有旧正文）。
  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_create' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_create')
  assert.equal(audit.action, 'MERGE')
  assert.equal(audit.user_id, 'u9')
  assert.equal(audit.before_text, null)
  assert.equal(audit.after_text, draft.text)
  const payload = JSON.parse(audit.payload)
  assert.equal(payload.number, 18)
  assert.equal(payload.type, 'iron-rule')
  assert.equal(payload.origin, 'manual:u9')
})

test('POST /rules/create：普通规则 key=rule-<domain>-<hash8>；同正文重建报 duplicate_rule', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)

  const draft = { text: '必须在记忆入库前先去重。', type: 'rule' }
  const first = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', { draft })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.match(first.body.key, /^rule-memory-[0-9a-f]{8}$/, 'key 形状 rule-<domain>-<hash8>')
  // 编号契约（R8）：普通规则不占号，响应 number=null。
  assert.equal(first.body.number, null, '普通规则 number=null')
  assert.equal(first.body.rule.front.type, 'rule')
  assert.equal(first.body.rule.front.priority, 'P1')
  assert.equal(first.body.rule.front.origin, 'manual:', '无身份时 origin=manual:')

  const dup = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', { draft })
  assert.equal(dup.status, 409, JSON.stringify(dup.body))
  assert.equal(dup.body.error, 'duplicate_rule')
  assert.equal(dup.body.detail.key, first.body.key)
  assert.equal(listRulesLen(fx.dir), 2, '撞 key 不得覆盖已有规则、不得多出文件')
})

function listRulesLen(dir) {
  return nodeFs.readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD')
    .length
}

test('POST /rules/create：invalid_draft / invalid_rule / 403 / 405 各自错误码', async (t) => {
  const fx = freshFixture(t)
  const cases = [
    [{ draft: { text: '必须保留审计日志。', number: 9 } }, 422, 'invalid_draft'],
    [{ draft: { text: '   ' } }, 422, 'invalid_draft'],
    [{ draft: { text: '必须保留审计日志。', type: 'rule-candidate' } }, 422, 'invalid_draft'],
    [{ draft: null }, 422, 'invalid_draft'],
    [{ draft: { text: '必须保留审计日志。', conditions: '不是数组' } }, 422, 'invalid_draft'],
  ]
  for (const [payload, status, error] of cases) {
    const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', payload)
    assert.equal(res.status, status, `${JSON.stringify(payload)} -> ${JSON.stringify(res.body)}`)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error, error)
  }
  const unknownField = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: '必须保留审计日志。', number: 9 },
  })
  assert.deepEqual(unknownField.body.detail.fields, ['number'], 'number 是仓储盖章字段，面板不可指定')

  // 内容问题交给 validateRule：超长 / 铁律模糊词 → invalid_rule + 错误数组。
  const tooLong = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: `必须保留${'甲'.repeat(500)}` },
  })
  assert.equal(tooLong.status, 422)
  assert.equal(tooLong.body.error, 'invalid_rule')
  assert.deepEqual(tooLong.body.detail.map((item) => item.code), ['body_too_long'])

  const vague = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: '必须尽量保留审计日志。', type: 'iron-rule' },
  })
  assert.equal(vague.status, 422)
  assert.equal(vague.body.error, 'invalid_rule')
  assert.ok(vague.body.detail.some((item) => item.code === 'vague_word'))

  // 写闸门：rules.enabled=false / requireGit 且 git 缺失。
  const disabled = freshFixture(t, { enabled: false })
  const off = await callWith(disabled.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: '必须保留审计日志。' },
  })
  assert.equal(off.status, 403)
  assert.equal(off.body.error, 'rules_disabled')

  const needGit = freshFixture(t, { requireGit: true })
  const gitRequired = createPayload({
    root: needGit.dir,
    config: needGit.config,
    backend: needGit.backend,
    body: { draft: { text: '必须保留审计日志。' } },
    detect: () => ({ available: false, version: '', error: 'git_not_installed', checkedAt: 1 }),
  })
  assert.equal(gitRequired.ok, false)
  assert.equal(gitRequired.error, 'git_required')

  const wrongMethod = await callWith(fx.handler, 'GET', '/whale-memory/api/rules/create')
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.error, 'method_not_allowed')
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('POST /rules/delete retire：status=retired、镜像 pinned 0、列表含 retired、编号不复用', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(readManifestSync(fx.dir).nextNumber, 2)

  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-1',
    mode: 'retire',
    identity: { userId: 'u3' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.ok, true)
  assert.equal(body.key, 'rule-1')
  assert.equal(body.mode, 'retire')
  assert.equal(body.status, 'retired')
  assert.equal(body.changed, true)
  assert.equal(body.version, 2)
  assert.equal(body.previousVersion, 1)
  assert.equal(body.rule.front.status, 'retired')
  assert.equal(body.commit, 'rule: update rule-1 v2')
  assert.equal(body.audit.ok, true)

  // 文件保留（停用不是删除文件），编号不变。
  assert.equal(nodeFs.existsSync(join(fx.dir, 'rule-1.md')), true)
  const kept = readRule(fx.dir, 'rule-1')
  assert.equal(kept.ok, true)
  assert.equal(kept.rule.front.number, 1)
  assert.equal(kept.rule.text.trim(), '必须先验证再覆盖正式库。', '停用不改正文')

  // 镜像：retired → archived + pinned 0（不参与召回，但行保留可审计）。
  const row = fx.db.prepare("SELECT text, status, pinned FROM nodes WHERE origin = 'rule:rule-1'").get()
  assert.ok(row, '镜像行必须保留（不物理删）')
  assert.equal(row.status, 'archived')
  assert.equal(row.pinned, 0)

  // 列表含 retired 条目。
  const list = await callWith(fx.handler, 'GET', '/whale-memory/api/rules')
  const item = list.body.rules.find((rule) => rule.key === 'rule-1')
  assert.ok(item, '列表必须含已停用规则')
  assert.equal(item.status, 'retired')

  // 编号永不复用：停用不回收编号，nextNumber 不回退。
  assert.equal(readManifestSync(fx.dir).nextNumber, 2)
  const next = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: '必须保留审计日志。', type: 'iron-rule' },
  })
  assert.equal(next.status, 200, JSON.stringify(next.body))
  assert.equal(next.body.number, 2, '停用后新规则仍从 2 起（1 已被停用规则永久占用）')

  // 审计：writes.reason=rule_retire。
  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_retire' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_retire')
  assert.equal(audit.user_id, 'u3')
  assert.equal(audit.before_text, '必须先验证再覆盖正式库。')
  assert.equal(audit.after_text, '必须先验证再覆盖正式库。')
  assert.equal(JSON.parse(audit.payload).mode, 'retire')

  // 幂等动作的"没动"要显式报：已停用再停用 → 409。
  const again = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'retire' })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'already_retired')
  assert.equal(again.body.status, 'retired')
})

test('POST /rules/delete reactivate：恢复 active、镜像 pinned 1、审计 reason=rule_reactivate', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(1, { status: 'retired' }), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)

  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-1',
    mode: 'reactivate',
    identity: { userId: 'u4' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.ok, true)
  assert.equal(body.mode, 'reactivate')
  assert.equal(body.status, 'active')
  assert.equal(body.version, 2)
  assert.equal(body.rule.front.status, 'active')
  assert.equal(body.commit, 'rule: update rule-1 v2')

  const row = fx.db.prepare("SELECT status, pinned FROM nodes WHERE origin = 'rule:rule-1'").get()
  assert.ok(row)
  assert.equal(row.status, 'active')
  assert.equal(row.pinned, 1)

  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_reactivate' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_reactivate')
  assert.equal(audit.user_id, 'u4')
  assert.equal(JSON.parse(audit.payload).mode, 'reactivate')

  // 未停用却恢复 → 409 not_retired（幂等动作显式报"没动"）。
  const again = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'reactivate' })
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'not_retired')
  assert.equal(again.body.status, 'active')
})

test('POST /rules/delete purge：删文件、墓碑编号不复用、镜像归档、审计 rule_purge、返回 retiredNumbers/nextNumber', async (t) => {
  const fx = freshFixture(t)
  const text = '必须先验证再覆盖正式库。'
  const front = frontOf(17, { key: 'iron-rule-17', type: 'iron-rule' })
  assert.equal(writeRule(fx.dir, { front, text }, { git: false }).ok, true)
  assert.equal(readManifestSync(fx.dir).nextNumber, 18)

  // 先镜像出 active 行，purge 才有"孤儿"可归档（不先建行就测不到归档路径）。
  const mirrored = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/rebuild-mirror')
  assert.equal(mirrored.status, 200, JSON.stringify(mirrored.body))
  const beforeRow = fx.db.prepare("SELECT status, pinned FROM nodes WHERE origin = 'rule:iron-rule-17'").get()
  assert.equal(beforeRow.status, 'active')
  assert.equal(beforeRow.pinned, 1)

  const res = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-17',
    mode: 'purge',
    identity: { userId: 'u9' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.ok, true)
  assert.equal(body.key, 'iron-rule-17')
  assert.equal(body.mode, 'purge')
  assert.equal(body.status, 'deleted')
  assert.equal(body.purged, true)
  assert.equal(body.deleted, true)
  assert.equal(body.number, 17)
  assert.equal(body.version, 1)
  assert.match(String(body.historySnapshot), /^\d{17}/)
  assert.deepEqual(body.retiredNumbers, [17])
  assert.equal(body.nextNumber, 18)
  assert.equal(body.audit.ok, true)

  // 文件物理删除 + 最后一版 history 仍可追溯。
  assert.equal(nodeFs.existsSync(join(fx.dir, 'iron-rule-17.md')), false)
  assert.equal(readRule(fx.dir, 'iron-rule-17').error, 'rule_not_found')
  const history = readHistory(fx.dir, 'iron-rule-17')
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0].rev, body.historySnapshot)
  assert.ok(history.entries[0].text.includes(text))

  // manifest 墓碑；列表彻底消失（不再出现，也不进"已退役"筛选的数据源）。
  const manifest = readManifestSync(fx.dir)
  assert.deepEqual(manifest.retired.map((item) => [item.key, item.number]), [['iron-rule-17', 17]])
  assert.equal(manifest.nextNumber, 18)
  const list = await callWith(fx.handler, 'GET', '/whale-memory/api/rules')
  assert.equal(list.body.rules.some((rule) => rule.key === 'iron-rule-17'), false)

  // 镜像：文件没了 → 孤儿归档 archived + pinned 0（不物理删）。
  const row = fx.db.prepare("SELECT text, status, pinned FROM nodes WHERE origin = 'rule:iron-rule-17'").get()
  assert.ok(row, '镜像行必须保留（不物理删）')
  assert.equal(row.status, 'archived')
  assert.equal(row.pinned, 0)
  assert.ok(String(row.text).includes('必须先验证'))

  // 审计：reason=rule_purge，after_text=null，payload 带编号/墓碑；evolution 记 status→deleted。
  const audit = fx.db.prepare("SELECT * FROM writes WHERE reason = 'rule_purge' ORDER BY id DESC LIMIT 1").get()
  assert.ok(audit, 'writes 必须留 reason=rule_purge')
  assert.equal(audit.user_id, 'u9')
  assert.equal(audit.before_text, text)
  assert.equal(audit.after_text, null)
  const payload = JSON.parse(audit.payload)
  assert.equal(payload.mode, 'purge')
  assert.equal(payload.number, 17)
  assert.equal(payload.purged, true)
  assert.deepEqual(payload.retiredNumbers, [17])
  assert.equal(payload.nextNumber, 18)
  const evolution = fx.db.prepare("SELECT * FROM evolution WHERE field = 'status' ORDER BY id DESC LIMIT 1").get()
  assert.ok(evolution, 'evolution 必须记 status 变化')
  assert.equal(evolution.old_value, 'active')
  assert.equal(evolution.new_value, 'deleted')

  // 删除不回收编号：新建铁律仍是 18；再删 18 后仍是 19。
  const created = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/create', {
    draft: { text: '必须保留审计日志。', type: 'iron-rule' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.number, 18)
  const purgedAgain = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-18',
    mode: 'purge',
  })
  assert.equal(purgedAgain.status, 200, JSON.stringify(purgedAgain.body))
  assert.deepEqual(purgedAgain.body.retiredNumbers, [17, 18])
  assert.equal(purgedAgain.body.nextNumber, 19)

  // 重复删除同一 key → 404 rule_not_found（文件已不存在，不是"再停用"语义）。
  const again = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-18',
    mode: 'purge',
  })
  assert.equal(again.status, 404)
  assert.equal(again.body.error, 'rule_not_found')

  // 已停用规则也可彻底删除（停用不是删除，删除路径不依赖 status）。
  assert.equal(writeRule(fx.dir, {
    front: frontOf(3, { key: 'rule-3', status: 'retired' }),
    text: '必须保留审计行。',
  }, { git: false }).ok, true)
  const retiredPurged = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-3',
    mode: 'purge',
  })
  assert.equal(retiredPurged.status, 200, JSON.stringify(retiredPurged.body))
  assert.equal(nodeFs.existsSync(join(fx.dir, 'rule-3.md')), false)
  const afterPurgeList = await callWith(fx.handler, 'GET', '/whale-memory/api/rules')
  assert.equal(afterPurgeList.body.rules.some((rule) => rule.key === 'rule-3'), false)
})

test('POST /rules/delete purge 错误码：git_required/rules_disabled；retire/reactivate 行为不变', async (t) => {
  const fx = freshFixture(t)
  assert.equal(writeRule(fx.dir, { front: frontOf(5), text: '必须保留审计日志。' }, { git: false }).ok, true)

  const missing = () => ({ available: false, version: '', error: 'git_not_installed', checkedAt: 1 })
  const blocked = deletePayload({
    root: fx.dir,
    config: { ...fx.config, rules: { ...fx.config.rules, requireGit: true } },
    backend: fx.backend,
    body: { key: 'rule-5', mode: 'purge' },
    detect: missing,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'git_required')
  assert.equal(nodeFs.existsSync(join(fx.dir, 'rule-5.md')), true, '闸门拒绝后文件必须原样保留')

  const disabled = freshFixture(t, { enabled: false })
  const off = await callWith(disabled.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-5',
    mode: 'purge',
  })
  assert.equal(off.status, 403)
  assert.equal(off.body.error, 'rules_disabled')

  // retire/reactivate 不受 purge 影响：停用仍保留文件，恢复仍回 active。
  const retired = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-5',
    mode: 'retire',
  })
  assert.equal(retired.status, 200, JSON.stringify(retired.body))
  assert.equal(retired.body.status, 'retired')
  assert.equal(nodeFs.existsSync(join(fx.dir, 'rule-5.md')), true, '停用仍必须保留文件')
  const reactivated = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-5',
    mode: 'reactivate',
  })
  assert.equal(reactivated.status, 200, JSON.stringify(reactivated.body))
  assert.equal(reactivated.body.status, 'active')
  assert.equal(readManifestSync(fx.dir).retired.some((item) => item.number === 5), false, '停用/恢复不写墓碑')
})

test('deletePayload purge：单 commit 文案 rule: purge <key> (#n)（注入 exec，不依赖真实 git）', async (t) => {
  const fx = freshFixture(t)
  const fake = fakeGit()
  const created = createPayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { draft: { text: '必须在改动前先备份。', type: 'iron-rule' } },
    exec: fake.exec,
  })
  assert.equal(created.ok, true, JSON.stringify(created.detail))
  const purged = deletePayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { key: created.key, mode: 'purge' },
    exec: fake.exec,
  })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(purged.commit, `rule: purge ${created.key} (#${created.number})`, 'purge 是一次性单 commit')
  assert.deepEqual(fake.commitMessages(), [
    `rule: create ${created.key} (#${created.number})`,
    `rule: purge ${created.key} (#${created.number})`,
  ])
  // 假 git 不会真删文件；这里锁"删文件动作走 git rm"（真实删除由上面的端点用例断言）。
  assert.equal(fake.calls.some((call) => call.argv.includes('rm')), true, 'git 可用时必须走 git rm')
})

test('POST /rules/delete 错误码：rule_not_found/invalid_key/invalid_mode/rules_disabled', async (t) => {
  const fx = freshFixture(t)
  const missing = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', { key: 'rule-nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'rule_not_found')

  const badKey = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', { key: '../etc/passwd' })
  assert.equal(badKey.status, 400)
  assert.equal(badKey.body.error, 'invalid_key')

  const badMode = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'rule-1',
    mode: 'hard-delete',
  })
  assert.equal(badMode.status, 400)
  assert.equal(badMode.body.error, 'invalid_mode')
  assert.deepEqual(badMode.body.detail.allowed, ['retire', 'reactivate', 'purge'])

  const disabled = freshFixture(t, { enabled: false })
  const off = await callWith(disabled.handler, 'POST', '/whale-memory/api/rules/delete', { key: 'rule-1' })
  assert.equal(off.status, 403)
  assert.equal(off.body.error, 'rules_disabled')

  // 默认 mode=retire：body 不带 mode 也按停用处理（client 显式二次确认后才发请求）。
  assert.equal(writeRule(fx.dir, { front: frontOf(5), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const byDefault = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', { key: 'rule-5' })
  assert.equal(byDefault.status, 200, JSON.stringify(byDefault.body))
  assert.equal(byDefault.body.mode, 'retire')
  assert.equal(byDefault.body.status, 'retired')
  assert.equal(deletePayload({
    root: fx.dir,
    config: { ...fx.config, rules: { ...fx.config.rules, enabled: false } },
    backend: fx.backend,
    body: { key: 'rule-5' },
  }).error, 'rules_disabled')
})

test('createPayload/deletePayload：单 commit 文案 rule: create/update（注入 exec）', async (t) => {
  const fx = freshFixture(t)
  const fake = fakeGit()
  const created = createPayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { draft: { text: '必须在改动前先备份。', type: 'iron-rule' } },
    exec: fake.exec,
  })
  assert.equal(created.ok, true, JSON.stringify(created.detail))
  assert.equal(created.key, 'iron-rule-1')
  assert.equal(created.commit, 'rule: create iron-rule-1 (#1)', '新建是一次性单 commit')
  assert.deepEqual(fake.commitMessages(), ['rule: create iron-rule-1 (#1)'], '不得逐文件/逐步骤重复提交')

  const retired = deletePayload({
    root: fx.dir,
    config: fx.config,
    backend: fx.backend,
    body: { key: 'iron-rule-1', mode: 'retire' },
    exec: fake.exec,
  })
  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.commit, 'rule: update iron-rule-1 v2', '停用复用 R5 提交文案')
  assert.deepEqual(fake.commitMessages(), ['rule: create iron-rule-1 (#1)', 'rule: update iron-rule-1 v2'])
})

test('写端点只看回环：非 loopback 直接 403 not_loopback（create/delete 同门）', async (t) => {
  const fx = freshFixture(t)
  for (const [method, path] of [
    ['POST', '/whale-memory/api/rules/create'],
    ['POST', '/whale-memory/api/rules/delete'],
  ]) {
    const { res, done } = fakeRes()
    const req = fakeReq(method, path, method === 'POST' ? { draft: { text: '必须保留审计日志。' }, key: 'rule-1' } : undefined)
    req.socket = { remoteAddress: '10.1.2.3' }
    await fx.handler(req, res)
    await done
    assert.equal(res.statusCode, 403, `${path} 必须回环-only`)
    assert.equal(JSON.parse(res.body).error, 'not_loopback')
  }
  assert.equal(nodeFs.existsSync(join(fx.dir, 'README.md')) && listRulesLen(fx.dir) > 0, false, '被拦的请求不得建规则仓')
})
