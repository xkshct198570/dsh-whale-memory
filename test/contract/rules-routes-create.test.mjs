// /rules 新建契约（create 编号/普通规则/错误码 + create commit）；依赖 rules-routes-harness.mjs 的独立夹具，不 import 其它测试文件。

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
