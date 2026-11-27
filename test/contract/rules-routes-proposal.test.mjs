// /rules 提案制写入口契约（propose/apply/reject/render-agents + payload 守卫）；依赖 rules-routes-harness.mjs 的临时夹具，不 import 其它测试文件。

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
import {
  callWith, fakeGit, fakeReq, fakeRes, freshFixture, frontOf, gitInstalled, listRulesLen, readManifestSync,
  seedNumbered, startSharedFixture, stopSharedFixture,
} from './rules-routes-harness.mjs'

let root
let db
let backend
let handler
let config

before(() => {
  const fx = startSharedFixture()
  root = fx.root
  db = fx.db
  backend = fx.backend
  handler = fx.handler
  config = fx.config
})

after(() => {
  stopSharedFixture({ root, db })
})

const call = (method, path, payload) => callWith(handler, method, path, payload)

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
