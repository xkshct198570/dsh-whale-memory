/**
 * 规则路由契约（R3a）：列表/详情/git-status/rebuild/import 的 JSON 形状。
 * 用 stub backend + 临时规则目录 + 假 req/res 调 createRoutes，不启真 HTTP 服务器。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { closeDb, openDb } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { writeRule } from '../../src/core/rule-store.js'
import { LEGACY_IRON_RULE_ID } from '../../src/core/rule-mirror.js'
import { Config } from '../../src/host/config.js'
import { CONFIG_GROUPS, createRoutes } from '../../src/host/routes.js'
import {
  importLegacyPayload,
  rebuildMirrorPayload,
  ruleDetailPayload,
  rulesListPayload,
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
  root = mkdtempSync(join(tmpdir(), 'whale-rules-routes-'))
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
  nodeFs.rmSync(root, { recursive: true, force: true })
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
  assert.equal(body.manifest.total, 2)
  assert.equal(body.manifest.nextNumber, 3)
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
  assert.equal(first.body.key, 'iron-rule-17')
  assert.equal(first.body.legacy, true)
  assert.equal(first.body.skipped, false)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-17.md')), true)

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
  const imported = importLegacyPayload({ root, config, backend, key: 'iron-rule-17' })
  assert.equal(imported.ok, true)
  assert.equal(imported.skipped, true, '已有文件时幂等跳过')
})
