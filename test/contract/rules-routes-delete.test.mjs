// /rules 停用·恢复·彻底删除契约（delete retire/reactivate/purge + 墓碑/错误码/回环门）；依赖 rules-routes-harness.mjs 的独立夹具，不 import 其它测试文件。

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
    confirmKey: 'iron-rule-17',
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
    confirmKey: 'iron-rule-18',
  })
  assert.equal(purgedAgain.status, 200, JSON.stringify(purgedAgain.body))
  assert.deepEqual(purgedAgain.body.retiredNumbers, [17, 18])
  assert.equal(purgedAgain.body.nextNumber, 19)

  // 重复删除同一 key → 404 rule_not_found（文件已不存在，不是"再停用"语义）。
  const again = await callWith(fx.handler, 'POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-18',
    mode: 'purge',
    confirmKey: 'iron-rule-18',
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
    confirmKey: 'rule-3',
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
    body: { key: created.key, mode: 'purge', confirmKey: created.key },
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
