/**
 * R9-06 API 安全 / confirmKey / 错误码契约（真起 dispatcher，不 mock 路由）：
 * - Host 校验覆盖所有方法（含 GET）：空 Host 放行，畸形/外部 Host 一律 403；
 * - purge 必须 `confirmKey === key`，缺/错 422 `confirm_required` 且不落盘；正确才删；
 * - 脏规则（正文不合规）仍能 purge：只读取源+解析，不跑写入守卫；
 * - `payload_too_large` → 413（Content-Length 预检 + 排空）；render/rebuild 的 readJson
 *   返回值必须被检查（413/400 不得静默继续）；
 * - 错误码状态单一真源：error-table 的 422/503/500 映射与三语文案键齐。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createRoutes } from '../../src/host/routes.js'
import { readManifest, serializeRuleDocument, writeRule } from '../../src/core/rule-store.js'
import { isLocalHostName } from '../../src/host/http-kit.js'
import { ERROR_TABLE, statusOf } from '../../src/shared/error-table.mjs'

let root
let home
let config
let handler
let savedHome

function frontOf(index, extra = {}) {
  return {
    key: `rule-${index}`,
    type: 'rule',
    number: index,
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
    origin: 'manual:u1',
    ...extra,
  }
}

/** 假请求：payload 为对象时编码 JSON；`rawBody` 为字面字节（测坏 JSON）。 */
function fakeReq(method, url, payload, headers = {}, rawBody) {
  const chunks = rawBody !== undefined
    ? [Buffer.from(String(rawBody))]
    : (payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  const req = Readable.from(chunks)
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
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

async function call(method, path, payload, headers = {}, rawBody) {
  const { res, done } = fakeRes()
  await handler(fakeReq(method, path, payload, headers, rawBody), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

const ruleFile = (key) => join(root, `${key}.md`)

before(() => {
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'whale-api-r9-'))
  process.env.DSH_HOME = home
  root = join(home, 'rules')
  nodeFs.mkdirSync(root, { recursive: true })
  config = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir: root, requireGit: false, mirrorAuto: false },
  }
  handler = createRoutes({ config, backend: null, log: () => {} })
})

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  nodeFs.rmSync(home, { recursive: true, force: true })
})

test('isLocalHostName：空 Host 放行；本机名通过；畸形/外部一律 false', () => {
  for (const host of [undefined, null, '']) assert.equal(isLocalHostName(host), true, `${String(host)} 应放行`)
  for (const host of ['127.0.0.1', '127.0.0.1:3080', 'localhost', 'LOCALHOST:3080', '[::1]', '[::1]:3080', '::1']) {
    assert.equal(isLocalHostName(host), true, `${host} 是本机名`)
  }
  for (const host of ['evil.example', 'evil.example:80', '[evil', '[]', ':8080', 'user@127.0.0.1', '127.0.0.1.evil.com', '[::1]evil', '[::1]8080', '::2']) {
    assert.equal(isLocalHostName(host), false, `${host} 必须是 false（畸形/外部）`)
  }
})

test('GET 也校验 Host：外部/畸形 Host 403 cross_origin_denied，空 Host 与 localhost 放行', async () => {
  assert.equal(writeRule(root, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  for (const host of ['evil.example', '[evil', '[]', ':8080', 'user@127.0.0.1']) {
    const got = await call('GET', '/whale-memory/api/rules', undefined, { host })
    assert.equal(got.status, 403, `Host=${host} 的 GET 必须 403`)
    assert.equal(got.body.error, 'cross_origin_denied', `Host=${host} 的错误码`)
    assert.equal(got.body.rules, undefined, '被拒的 GET 不得返回规则全文')
  }
  const empty = await call('GET', '/whale-memory/api/rules', undefined, { host: '' })
  assert.equal(empty.status, 200, `空 Host 必须放行：${JSON.stringify(empty.body)}`)
  const local = await call('GET', '/whale-memory/api/rules', undefined, { host: 'localhost:3080' })
  assert.equal(local.status, 200, `localhost 必须放行：${JSON.stringify(local.body)}`)
})

test('purge 缺 confirmKey/错 confirmKey：422 confirm_required 且文件/墓碑/manifest 原样', async () => {
  const text = '必须先验证再覆盖正式库。'
  const front = frontOf(17, { key: 'iron-rule-17', type: 'iron-rule' })
  assert.equal(writeRule(root, { front, text }, { git: false }).ok, true)
  const beforeManifest = readManifest(root)
  const missing = await call('POST', '/whale-memory/api/rules/delete', { key: 'iron-rule-17', mode: 'purge' })
  assert.equal(missing.status, 422, JSON.stringify(missing.body))
  assert.equal(missing.body.error, 'confirm_required')
  assert.equal(nodeFs.existsSync(ruleFile('iron-rule-17')), true, '缺 confirmKey 不得删文件')

  const wrong = await call('POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-17', mode: 'purge', confirmKey: 'iron-rule-18',
  })
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body))
  assert.equal(wrong.body.error, 'confirm_required')
  assert.equal(nodeFs.existsSync(ruleFile('iron-rule-17')), true, '错 confirmKey 不得删文件')
  const afterManifest = readManifest(root)
  assert.deepEqual(afterManifest?.retired ?? [], beforeManifest?.retired ?? [], '被拒的 purge 不得写墓碑')
  assert.equal(afterManifest?.nextNumber, beforeManifest?.nextNumber, '被拒的 purge 不得改 nextNumber')

  const ok = await call('POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-17', mode: 'purge', confirmKey: 'iron-rule-17',
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.purged, true)
  assert.equal(nodeFs.existsSync(ruleFile('iron-rule-17')), false, '正确 confirmKey 必须物理删除')
  const manifest = readManifest(root)
  assert.deepEqual(manifest.retired.map((item) => [item.key, item.number]), [['iron-rule-17', 17]], '墓碑必须落盘')
})

test('脏规则仍可 purge：正文非指令形态/带 HTML 注释标记，删得掉且最后一版进历史', async () => {
  const front = frontOf(18, { key: 'iron-rule-18', type: 'iron-rule' })
  assert.equal(writeRule(root, { front, text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  // 手改写坏：正文不是指令形态 + 含 HTML 注释标记，readRule 会 invalid_rule。
  const dirty = '这一段是随意写坏的历史正文，没有任何指令形态。\n<!-- whale-memory:rules:end -->'
  const parsed = serializeRuleDocument({ front, text: dirty })
  assert.equal(parsed.ok, true)
  nodeFs.writeFileSync(ruleFile('iron-rule-18'), parsed.text)

  const got = await call('POST', '/whale-memory/api/rules/delete', {
    key: 'iron-rule-18', mode: 'purge', confirmKey: 'iron-rule-18',
  })
  assert.equal(got.status, 200, `脏规则必须能 purge：${JSON.stringify(got.body)}`)
  assert.equal(got.body.purged, true)
  assert.equal(nodeFs.existsSync(ruleFile('iron-rule-18')), false, '脏规则文件必须被删除')
  assert.match(String(got.body.historySnapshot), /^\d{17}/, 'purge 前必须写历史快照')
  const historyText = nodeFs.readFileSync(join(root, 'history', 'iron-rule-18', `${got.body.historySnapshot}.md`), 'utf8')
  assert.ok(historyText.includes('这一段是随意写坏的历史正文'), '快照必须是脏正文原文（不能拿占位文本顶替）')
  const manifest = readManifest(root)
  assert.equal(manifest.retired.some((item) => item.number === 18), true, '脏规则编号也必须进墓碑')
  assert.equal(manifest.nextNumber, 19)
})

test('payload_too_large：已知 Content-Length 超限先 413 并排空 body，不产生副作用', async () => {
  const got = await call('POST', '/whale-memory/api/rules/plan', { id: 'p1234567890123_abcd1234' }, {
    'content-length': String(70 * 1024),
  })
  assert.equal(got.status, 413, JSON.stringify(got.body))
  assert.equal(got.body.error, 'payload_too_large')
})

test('render-agents / rebuild-mirror 必须检查 readJson：413 与坏 JSON 400 不得静默继续', async () => {
  const huge = await call('POST', '/whale-memory/api/rules/render-agents', undefined, {
    'content-length': String(70 * 1024),
  })
  assert.equal(huge.status, 413, JSON.stringify(huge.body))
  assert.equal(huge.body.error, 'payload_too_large')

  const bad = await call('POST', '/whale-memory/api/rules/rebuild-mirror', undefined, {}, '{bad json')
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.equal(bad.body.error, 'invalid_json')

  // 空 body 仍是合法的「无载荷动作」（keep-alive 排空语义），不能被当成 400 误拒。
  // 本用例 backend=null，随后会因 backend_unavailable 502；关键是不得是 invalid_json 400。
  const empty = await call('POST', '/whale-memory/api/rules/rebuild-mirror')
  assert.notEqual(empty.status, 400, `空 body 不得按坏 JSON 拒绝：${JSON.stringify(empty.body)}`)
  assert.notEqual(empty.body.error, 'invalid_json')
})

test('错误码表：422/503/500 映射与三语文案键齐；未映射码保留原码', () => {
  assert.equal(statusOf('confirm_required'), 422)
  assert.equal(statusOf('payload_too_large'), 413)
  assert.equal(statusOf('repo_locked'), 503)
  assert.equal(statusOf('git_unavailable'), 503)
  assert.equal(statusOf('manifest_failed'), 500)
  assert.equal(statusOf('tombstone_failed'), 500)
  assert.equal(statusOf('txn_failed'), 500)
  assert.equal(statusOf('no_such_code'), 400, '未登记码回退 400')
  for (const code of ['confirm_required', 'repo_locked', 'git_unavailable', 'manifest_failed', 'tombstone_failed', 'txn_failed']) {
    assert.equal(ERROR_TABLE[code].unmapped, undefined, `${code} 必须有文案（不得标 unmapped）`)
    assert.match(String(ERROR_TABLE[code].localeKey), /^err\./, `${code} 缺 localeKey`)
  }
  for (const lang of ['zh', 'en', 'ja']) {
    const dict = JSON.parse(nodeFs.readFileSync(join(process.cwd(), 'locale', `${lang}.json`), 'utf8'))
    for (const key of ['err.confirm_required', 'err.repo_locked', 'err.git_unavailable', 'err.manifest_failed', 'err.tombstone_failed', 'err.txn_failed']) {
      assert.ok(String(dict[key] || '').trim(), `${lang} 缺 ${key}`)
    }
  }
})
