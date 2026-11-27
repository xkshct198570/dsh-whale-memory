// /rules 编辑与历史契约（update/diff/versions/revert + git 提交文案）；依赖 rules-routes-harness.mjs 的独立夹具，不 import 其它测试文件。

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
