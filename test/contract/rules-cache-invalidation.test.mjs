/**
 * 清召回缓存契约（P4a3 复核缺口补测）：apply / restore-default 成功后必须 invalidateCache，
 * 失败与读请求不得触发。判据来自 P4a3 新 seam——afterWrite 由 handleRules 经 ctx 传给组 handler。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createRoutes } from '../../src/host/routes.js'
import { writeRule } from '../../src/core/rule-store.js'

let root
let config
let handler
let cleared

function fakeReq(method, url, payload) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
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
  return {
    res: {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writableEnded: false,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value },
      end(body) { this.body = body; this.headersSent = true; this.writableEnded = true; resolveDone(this) },
    },
    done,
  }
}

/** POST 并返回 {status, body}；同时复用同一个 ctx 计数实例。 */
async function post(path, payload) {
  const { res, done } = fakeRes()
  await handler(fakeReq('POST', path, payload), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

/** GET 并返回 {status, body}。 */
async function get(path) {
  const { res, done } = fakeRes()
  await handler(fakeReq('GET', path), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

before(() => {
  root = join(mkdtempSync(join(tmpdir(), 'whale-rules-cache-')), 'rules')
  nodeFs.mkdirSync(root, { recursive: true })
  config = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir: root, requireGit: false, mirrorAuto: false },
  }
  const front = {
    key: 'rule-1', type: 'rule', number: 1, priority: 'P1', scope: 'global', role: '', modality: 'must',
    action: '', object: '', conditions: [], exceptions: [], status: 'active', merged_into: '',
    superseded_by: '', created: '2026-11-22', updated: '2026-11-22', version: 1, origin: 'manual:u1',
  }
  assert.equal(writeRule(root, { front, text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  cleared = 0
  const ctx = { get: (name) => (name === 'whaleMemory' ? { invalidateCache: () => { cleared += 1 } } : null) }
  handler = createRoutes({ config, backend: null, ctx, log: () => {} })
})

after(() => nodeFs.rmSync(dirname(root), { recursive: true, force: true }))

test('apply 成功后清缓存并落盘，plan_hash_mismatch 不清', async () => {
  cleared = 0
  const mdCount = () => nodeFs.readdirSync(root).filter((name) => name.endsWith('.md')).length
  const before = mdCount()
  const made = await post('/whale-memory/api/rules/propose', { text: '以后都别把召回缓存当持久层' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const id = made.body.proposal.id
  const planned = await post('/whale-memory/api/rules/plan', { id })
  assert.equal(planned.status, 200, JSON.stringify(planned.body))
  // hash 必须先在 pending 状态下打错：accepted 后 apply 会先被 status 拦成 proposal_not_pending。
  const bad = await post('/whale-memory/api/rules/apply', { id, planHash: 'deadbeefdeadbeef' })
  assert.equal(bad.status, 409, JSON.stringify(bad.body))
  assert.equal(bad.body.error, 'plan_hash_mismatch', JSON.stringify(bad.body))
  assert.equal(cleared, 0, 'apply 失败不得清缓存')
  const ok = await post('/whale-memory/api/rules/apply', { id, planHash: planned.body.plan.planHash })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const appliedFile = join(root, `${ok.body.applied.key}.md`)
  assert.equal(nodeFs.existsSync(appliedFile), true, 'apply 必须回写落盘 key')
  assert.ok(nodeFs.readFileSync(appliedFile, 'utf8').includes('召回缓存'), 'apply 落盘必须是候选正文，不能是空文件')
  assert.equal(mdCount(), before + 1, 'apply 成功必须真落盘一条规则（不是只清缓存）')
  assert.equal(cleared, 1, 'apply 成功后必须清召回缓存')
})

test('restore-default 成功后清缓存并落盘，非法 key 不清', async () => {
  cleared = 0
  const target = join(root, 'iron-rule-9.md')
  nodeFs.rmSync(target, { force: true })
  const ok = await post('/whale-memory/api/rules/restore-default', { key: 'iron-rule-9' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.restored.key, 'iron-rule-9', 'restore 必须回写恢复的规则')
  assert.equal(nodeFs.existsSync(target), true, 'restore 成功必须真写盘（不是只回 ok）')
  assert.ok(nodeFs.readFileSync(target, 'utf8').includes('iron-rule-9'), 'restore 落盘必须是默认规则正文，不能是空文件')
  assert.equal(cleared, 1, 'restore-default 成功后必须清召回缓存')
  const bad = await post('/whale-memory/api/rules/restore-default', { key: '../etc/passwd' })
  assert.equal(bad.status, 422)
  assert.equal(cleared, 1, 'restore-default 失败不得清缓存')
})

test('update 成功后清缓存并落盘，坏字段不清', async () => {
  cleared = 0
  const target = join(root, 'rule-1.md')
  const before = nodeFs.readFileSync(target, 'utf8')
  const ok = await post('/whale-memory/api/rules/update', { key: 'rule-1', patch: { text: '必须先验证再覆盖正式库（更新）。' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.notEqual(nodeFs.readFileSync(target, 'utf8'), before, 'update 必须实际改文件')
  assert.ok(nodeFs.readFileSync(target, 'utf8').includes('（更新）'), 'update 必须真落盘正文')
  assert.equal(cleared, 1, 'update 成功后必须清召回缓存')
  const bad = await post('/whale-memory/api/rules/update', { key: 'rule-1', patch: { nope: 1 } })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.equal(cleared, 1, 'update 失败不得清缓存')
})

test('revert 成功后清缓存并落盘，空 rev 不清', async () => {
  cleared = 0
  const detail = await get('/whale-memory/api/rules/rule-1')
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  const preText = detail.body.rule.text
  const upd = await post('/whale-memory/api/rules/update', { key: 'rule-1', patch: { text: '必须先验证再覆盖正式库（回滚前）。' } })
  assert.equal(upd.status, 200, JSON.stringify(upd.body))
  const versions = await get('/whale-memory/api/rules/versions?key=rule-1')
  assert.equal(versions.status, 200, JSON.stringify(versions.body))
  const history = versions.body.versions.find((item) => item.kind === 'history')
  assert.ok(history?.rev, 'update 必须产生历史版本供回滚')
  cleared = 0
  const rev = await post('/whale-memory/api/rules/revert', { key: 'rule-1', rev: history.rev })
  assert.equal(rev.status, 200, JSON.stringify(rev.body))
  assert.equal(rev.body.rule.text, preText, 'revert 必须把历史正文原样写回')
  assert.equal(cleared, 1, 'revert 成功后必须清召回缓存')
  const empty = await post('/whale-memory/api/rules/revert', { key: 'rule-1', rev: '' })
  assert.equal(empty.status, 400, JSON.stringify(empty.body))
  assert.equal(empty.body.error, 'invalid_rev')
  assert.equal(cleared, 1, '空 rev 不得清缓存')
})
