/**
 * R8-09 规则写接口安全闸 + 新端点契约：
 * - 非 JSON Content-Type → 415；跨源 Origin / 外部 Host → 403；本机 curl（无 Origin）放行。
 * - 拒绝必须发生在副作用之前（text/plain + Origin: evil 打 purge 不得删文件）。
 * - GET /rules 带 origin + capabilities；proposals 支持 pending,needs_manual；
 *   /rules/plan 与 /rules/restore-default：能力可探测且在线时按契约返回真实产物；模块缺失才显式 501。
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
import { rulesCapabilities } from '../../src/host/rules-routes.js'

let root
let config
let handler

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

function fakeReq(method, url, payload, headers = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
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

async function call(method, path, payload, headers = {}) {
  const { res, done } = fakeRes()
  await handler(fakeReq(method, path, payload, headers), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

const ruleFile = (key) => join(root, `${key}.md`)

/** serializeRuleDocument 返回 {ok,text}；测试里只关心正文。 */
function docText(doc) {
  const out = serializeRuleDocument(doc)
  assert.equal(out.ok, true, out.error)
  return out.text
}

before(() => {
  root = join(mkdtempSync(join(tmpdir(), 'whale-rules-security-')), 'rules')
  nodeFs.mkdirSync(root, { recursive: true })
  config = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir: root, requireGit: false, mirrorAuto: false },
  }
  assert.equal(writeRule(root, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  handler = createRoutes({ config, backend: null, log: () => {} })
})

after(() => {
  nodeFs.rmSync(dirname(root), { recursive: true, force: true })
})

test('非 JSON Content-Type：所有规则写端点 415 且无副作用', async () => {
  for (const path of [
    '/whale-memory/api/rules/create',
    '/whale-memory/api/rules/delete',
    '/whale-memory/api/rules/update',
    '/whale-memory/api/rules/revert',
    '/whale-memory/api/rules/apply',
    '/whale-memory/api/rules/reject',
    '/whale-memory/api/rules/plan',
    '/whale-memory/api/rules/render-agents',
    '/whale-memory/api/rules/rebuild-mirror',
    '/whale-memory/api/rules/import-legacy',
  ]) {
    const got = await call('POST', path, { key: 'rule-1', mode: 'purge', id: 'p1234567890123_abcd1234' }, {
      'content-type': 'text/plain',
      origin: 'http://evil.example',
    })
    assert.equal(got.status, 415, `${path} 必须拒绝 text/plain`)
    assert.equal(got.body.error, 'unsupported_media_type')
  }
  // 请求体没有 Content-Type（跨源简单请求常见）同样拒绝。
  const noType = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'purge' }, {
    'content-type': '',
  })
  assert.equal(noType.status, 415)
  assert.equal(nodeFs.existsSync(ruleFile('rule-1')), true, 'text/plain purge 不得产生副作用')
})

test('跨源 Origin / 外部 Host：JSON 写请求 403 且不落盘', async () => {
  const evilOrigin = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'purge' }, {
    origin: 'http://evil.example',
  })
  assert.equal(evilOrigin.status, 403)
  assert.equal(evilOrigin.body.error, 'cross_origin_denied')

  const evilHost = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'purge' }, {
    host: 'evil.example',
  })
  assert.equal(evilHost.status, 403)
  assert.equal(evilHost.body.error, 'cross_origin_denied')

  const nullOrigin = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'purge' }, {
    origin: 'null',
  })
  assert.equal(nullOrigin.status, 403, 'file:// 的 Origin: null 必须拒绝')
  assert.equal(nodeFs.existsSync(ruleFile('rule-1')), true, '被拦的 purge 不得删文件')
})

test('本机 GUI 源放行：127.0.0.1 / localhost / ::1，无 Origin 的本机 curl 也放行', async () => {
  for (const origin of ['http://127.0.0.1:3080', 'http://localhost:3080', 'http://[::1]:3080']) {
    const got = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'retire' }, {
      origin,
      host: '127.0.0.1:3080',
    })
    assert.equal(got.status, 200, `${origin} 应放行：${JSON.stringify(got.body)}`)
    assert.equal(got.body.status, 'retired')
    const back = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'reactivate' }, {
      origin,
      host: '127.0.0.1:3080',
    })
    assert.equal(back.status, 200, `${origin} 重新启用应放行`)
  }
  const curl = await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'retire' }, {
    host: '127.0.0.1:3982',
  })
  assert.equal(curl.status, 200, '无 Origin 的本机 curl 必须放行')
  await call('POST', '/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'reactivate' }, { host: '127.0.0.1:3982' })
})

test('GET /rules：每条规则带 origin，响应带 capabilities', async () => {
  const got = await call('GET', '/whale-memory/api/rules')
  assert.equal(got.status, 200)
  assert.ok(Array.isArray(got.body.rules))
  const row = got.body.rules.find((item) => item.key === 'rule-1')
  assert.ok(row, '列表缺少 rule-1')
  assert.equal(row.origin, 'manual:u1', '列表 origin 必须回显（默认徽标判据）')
  assert.ok(got.body.capabilities && typeof got.body.capabilities === 'object')
  const caps = await rulesCapabilities()
  assert.deepEqual(got.body.capabilities, caps, 'capabilities 必须与能力探测同源')
  assert.equal(typeof caps.plan, 'boolean')
  // 动态 import 路径必须真解析到 rule-defaults：写错时能力静默 false、restore 走 501。
  assert.equal(caps.restoreDefault, true, 'restoreDefault 能力必须可用（loadDefaultRestore 路径正确）')
})

test('GET /rules/proposals：status=pending,needs_manual 同时返回；单值过滤仍生效', async () => {
  // 先真实提案，再把候选 JSON 改成 needs_manual（避免依赖 LLM 路径）。
  const made = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都先写测试再改实现' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const pendingId = made.body.proposal.id
  const file = join(root, 'proposals', `${pendingId}.json`)
  const doc = JSON.parse(nodeFs.readFileSync(file, 'utf8'))
  doc.status = 'needs_manual'
  doc.needsManual = { code: 'rule_guard_failed', at: '2026-11-23T00:00:00.000Z', failures: [{ code: 'modality_lost', key: 'rule-1' }] }
  nodeFs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)

  const both = await call('GET', '/whale-memory/api/rules/proposals?status=pending,needs_manual')
  assert.equal(both.status, 200)
  assert.ok(both.body.items.some((item) => item.id === pendingId), 'needs_manual 候选必须出现在面板列表')
  const manual = both.body.items.find((item) => item.id === pendingId)
  assert.equal(manual.status, 'needs_manual')
  assert.equal(manual.needsManual.code, 'rule_guard_failed')
  assert.deepEqual(manual.needsManual.failures, [{ code: 'modality_lost', key: 'rule-1' }], '失败项必须回显供改写重试')
  assert.equal(manual.guard.ok, false)

  const pendingOnly = await call('GET', '/whale-memory/api/rules/proposals?status=pending')
  assert.equal(pendingOnly.body.items.some((item) => item.id === pendingId), false, '单值过滤不得混入 needs_manual')

  const again = await call('GET', '/whale-memory/api/rules/proposals?status=pending,needs_manual')
  assert.equal(again.body.items.length >= 1, true)
})

test('POST /rules/plan：非法/缺失 id 404；能力在线必须 200 返回 plan（静默降级即红）', async () => {
  const missing = await call('POST', '/whale-memory/api/rules/plan', { id: 'p1234567890123_abcd1234' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'proposal_not_found')

  const made = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都先写测试再改实现' })
  assert.equal(made.status, 200)
  // 能力必须按当前树实测在线：模块路径搬家/缺失时 existsSync 会变 false，静默 501 即红。
  const caps = await rulesCapabilities()
  assert.equal(caps.plan, true, 'rule-plan.js 必须可探测（路径搬家不得静默降级）')
  const got = await call('POST', '/whale-memory/api/rules/plan', { id: made.body.proposal.id })
  assert.equal(got.status, 200, JSON.stringify(got.body))
  assert.notEqual(got.body.degraded, true, '能力在线不得返回降级标记')
  assert.ok(got.body.plan && typeof got.body.plan === 'object', '能力在线必须返回 plan')
  assert.equal(typeof got.body.plan.planHash, 'string')
  assert.ok(Array.isArray(got.body.plan.files))
})

test('POST /rules/restore-default：能力在线 200；非法 key 422；未登记 key 404', async () => {
  const caps = await rulesCapabilities()
  assert.equal(caps.restoreDefault, true, 'rule-defaults.js 必须可探测（路径搬家不得静默降级）')
  const badKey = await call('POST', '/whale-memory/api/rules/restore-default', { key: '../etc/passwd' })
  assert.equal(badKey.status, 422)
  assert.equal(badKey.body.error, 'invalid_key')

  const unknown = await call('POST', '/whale-memory/api/rules/restore-default', { key: 'iron-rule-999' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'default_not_found')

  const got = await call('POST', '/whale-memory/api/rules/restore-default', { key: 'iron-rule-7' })
  assert.equal(got.status, 200, JSON.stringify(got.body))
  assert.equal(got.body.ok, true)
})

test('import-legacy 错误码分级：非法 key 422（不再一律 403）', async () => {
  const got = await call('POST', '/whale-memory/api/rules/import-legacy', { key: '../etc/passwd' })
  assert.equal(got.status, 422)
  assert.equal(got.body.error, 'invalid_key')
})

test('通用写端点（write/import/config/search PATCH）同样先过闸：text/plain 一律 415', async () => {
  const cases = [
    ['POST', '/whale-memory/api/write', { text: '不该写入' }],
    ['POST', '/whale-memory/api/import', { jsonl: '{"text":"不该导入"}' }],
    ['POST', '/whale-memory/api/config', { config: { rules: { enabled: false } } }],
    ['POST', '/whale-memory/api/recall-test', { query: 'x' }],
    ['PATCH', '/whale-memory/api/nodes/n1', { patch: { status: 'archived' } }],
  ]
  for (const [method, path, payload] of cases) {
    const got = await call(method, path, payload, { 'content-type': 'text/plain', origin: 'http://evil.example' })
    assert.equal(got.status, 415, `${path} 未过 JSON 闸`)
    assert.equal(got.body.error, 'unsupported_media_type')
  }
})

test('render-agents：rules.renderAgents=false 时手动渲染也跳过（403 render_disabled）', async () => {
  const offHandler = createRoutes({
    config: { ...config, rules: { ...config.rules, renderAgents: false } },
    backend: null,
    log: () => {},
  })
  const { res, done } = fakeRes()
  await offHandler(fakeReq('POST', '/whale-memory/api/rules/render-agents', {}), res)
  await done
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error, 'render_disabled')
})

test('写成功清召回缓存：context service.invalidateCache 被调用，失败/读请求不触发', async () => {
  let cleared = 0
  const ctx = { get: (name) => (name === 'whaleMemory' ? { invalidateCache: () => { cleared += 1 } } : null) }
  const local = createRoutes({ config, backend: null, ctx, log: () => {} })
  const post = async (path, payload) => {
    const { res, done } = fakeRes()
    await local(fakeReq('POST', path, payload), res)
    await done
    return res
  }
  const ok = await post('/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'retire' })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(cleared, 1, '写成功后必须清召回缓存')
  const bad = await post('/whale-memory/api/rules/delete', { key: '../etc/passwd' })
  assert.equal(bad.statusCode, 400)
  assert.equal(cleared, 1, '失败写不得清缓存')
  const read = fakeRes()
  await local(fakeReq('GET', '/whale-memory/api/rules'), read.res)
  await read.done
  assert.equal(cleared, 1, '读请求不得清缓存')
  const back = await post('/whale-memory/api/rules/delete', { key: 'rule-1', mode: 'reactivate' })
  assert.equal(back.statusCode, 200)
  assert.equal(cleared, 2)
})

test('GET /rules/health：健康库 ok:true；文件/manifest/墓碑/编号漂移全部报 failures 且 200', async () => {
  const healthy = await call('GET', '/whale-memory/api/rules/health')
  assert.equal(healthy.status, 200)
  assert.equal(healthy.body.ok, true, JSON.stringify(healthy.body.failures))
  assert.deepEqual(healthy.body.failures, [])
  assert.equal(typeof healthy.body.counts.rules, 'number')

  // 复制一份隔离的坏库，避免污染全局 fixture。
  const badRoot = join(mkdtempSync(join(tmpdir(), 'whale-rules-health-')), 'rules')
  nodeFs.mkdirSync(join(badRoot, 'retired'), { recursive: true })
  const baseFront = frontOf(1, { key: 'iron-rule-1', type: 'iron-rule' })
  const secondFront = frontOf(2, { key: 'iron-rule-2', type: 'iron-rule' })
  assert.equal(writeRule(badRoot, { front: baseFront, text: '必须先验证再覆盖。' }, { git: false }).ok, true)
  // 编号重复：第二个文件手写同号 #1（writeRule 会拦，所以直接落盘）。
  nodeFs.writeFileSync(join(badRoot, 'iron-rule-2.md'), docText({ front: { ...secondFront, number: 1 }, text: '必须保留审计日志。' }), 'utf8')
  // key≠文件名：改名触发 key_mismatch。
  nodeFs.writeFileSync(join(badRoot, 'renamed.md'), docText({ front: baseFront, text: '必须先验证再覆盖。' }), 'utf8')
  // manifest 漂移：手改 nextNumber/total。
  const manifest = JSON.parse(nodeFs.readFileSync(join(badRoot, 'manifest.json'), 'utf8'))
  nodeFs.writeFileSync(join(badRoot, 'manifest.json'), JSON.stringify({ ...manifest, total: 99, nextNumber: 99 }, null, 2))
  // retired 墓碑只落盘不进 manifest。
  nodeFs.writeFileSync(join(badRoot, 'retired', 'iron-rule-9.json'), JSON.stringify({ key: 'iron-rule-9', number: 9, at: '2026-11-23', reason: 'purge' }))
  // 墓碑编号被现存铁律复活。
  nodeFs.writeFileSync(join(badRoot, 'iron-rule-9.md'), docText({ front: frontOf(9, { key: 'iron-rule-9', number: 9, type: 'iron-rule' }), text: '必须保留审计日志。' }), 'utf8')

  const badHandler = createRoutes({
    config: { ...config, rules: { ...config.rules, dir: badRoot } },
    backend: null,
    log: () => {},
  })
  const { res, done } = fakeRes()
  await badHandler(fakeReq('GET', '/whale-memory/api/rules/health'), res)
  await done
  assert.equal(res.statusCode, 200, '巡检业务失败也回 200，用 ok/failures 表达')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  const codes = new Set(body.failures.map((item) => item.code))
  for (const code of ['duplicate_number', 'key_mismatch', 'manifest_total_mismatch', 'manifest_next_number_mismatch', 'retired_mismatch', 'retired_number_reused']) {
    assert.ok(codes.has(code), `health 缺 ${code}：${[...codes].join(',')}`)
  }
  assert.ok(body.failures.every((item) => typeof item.code === 'string' && item.code.length > 0))
})

test('POST /rules/apply：planHash 错→409 plan_hash_mismatch；正确→200 落盘', async () => {
  const made = await call('POST', '/whale-memory/api/rules/propose', { text: '以后都别用云端存日志' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const id = made.body.proposal.id
  const planned = await call('POST', '/whale-memory/api/rules/plan', { id })
  assert.equal(planned.status, 200, JSON.stringify(planned.body))
  const planHash = planned.body.plan.planHash
  assert.equal(typeof planHash, 'string')

  const wrong = await call('POST', '/whale-memory/api/rules/apply', { id, planHash: 'deadbeefdeadbeef' })
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body))
  assert.equal(wrong.body.error, 'plan_hash_mismatch')

  const ok = await call('POST', '/whale-memory/api/rules/apply', { id, planHash })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.proposal.status, 'accepted')
})

test('编号顺延可见：plan.numberAdjusted / applied.numberAdjusted 都回给面板', async () => {
  // 独立裸库：避免与前面的 apply 用例互相占号/改关系，顺延原因必须可复现。
  const freshRoot = join(mkdtempSync(join(tmpdir(), 'whale-rules-adjust-')), 'rules')
  nodeFs.mkdirSync(freshRoot, { recursive: true })
  const freshHandler = createRoutes({
    config: { ...config, rules: { ...config.rules, dir: freshRoot } },
    backend: null,
    log: () => {},
  })
  const post = async (path, payload) => {
    const { res, done } = fakeRes()
    await freshHandler(fakeReq('POST', path, payload), res)
    await done
    return { status: res.statusCode, body: JSON.parse(res.body) }
  }
  const made = await post('/whale-memory/api/rules/propose', { text: '以后都别把日志写到外部服务' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const proposal = made.body.proposal
  const id = proposal.id
  const draftNumber = Number(proposal.candidate.number)
  assert.ok(Number.isInteger(draftNumber) && draftNumber > 0, '该候选应被编译成占号铁律')
  // 提案生成后先把它的号占掉，迫使 plan 顺延。
  const created = await post('/whale-memory/api/rules/create', {
    draft: { text: `必须保留第 ${draftNumber} 条铁律。`, type: 'iron-rule', priority: 'P0' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const planned = await post('/whale-memory/api/rules/plan', { id })
  assert.equal(planned.status, 200, JSON.stringify(planned.body))
  const adjusted = planned.body.plan.numberAdjusted
  assert.ok(adjusted && adjusted.from === draftNumber && adjusted.to > draftNumber, JSON.stringify(planned.body.plan))
  assert.equal(typeof adjusted.reason, 'string')

  const applied = await post('/whale-memory/api/rules/apply', { id, planHash: planned.body.plan.planHash })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  assert.deepEqual(applied.body.applied.numberAdjusted, adjusted, 'apply 必须回同一份 numberAdjusted')
})

test('GET /rules/health：合并/取代链断链、环、终点非 active 都进 failures', async () => {
  const chainRoot = join(mkdtempSync(join(tmpdir(), 'whale-rules-chain-')), 'rules')
  nodeFs.mkdirSync(chainRoot, { recursive: true })
  const base = { priority: 'P1', scope: 'global', role: '', modality: 'must', action: '', object: '', conditions: [], exceptions: [], status: 'active', merged_into: '', superseded_by: '', created: '2026-11-22', updated: '2026-11-22', version: 1, origin: 'contract' }
  const put = (key, number, extra = {}) => {
    const got = writeRule(chainRoot, {
      front: { ...base, key, type: 'iron-rule', number, ...extra },
      text: `必须保留第 ${number} 条规则。`,
    }, { git: false })
    assert.equal(got.ok, true, `${key}: ${JSON.stringify(got.detail)}`)
  }
  put('iron-rule-1', 1, { merged_into: 'iron-rule-missing' }) // 断链
  put('iron-rule-2', 2, { merged_into: 'iron-rule-3' }) // 环 B→C→B
  put('iron-rule-3', 3, { merged_into: 'iron-rule-2' })
  put('iron-rule-4', 4, { merged_into: 'iron-rule-5' }) // 终点已停用
  put('iron-rule-5', 5, { status: 'retired' })

  const chainHandler = createRoutes({
    config: { ...config, rules: { ...config.rules, dir: chainRoot } },
    backend: null,
    log: () => {},
  })
  const { res, done } = fakeRes()
  await chainHandler(fakeReq('GET', '/whale-memory/api/rules/health'), res)
  await done
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  const codes = body.failures.map((item) => item.code)
  assert.ok(codes.includes('chain_broken'), `缺 chain_broken：${codes.join(',')}`)
  assert.ok(codes.includes('chain_cycle'), `缺 chain_cycle：${codes.join(',')}`)
  assert.ok(codes.includes('chain_target_inactive'), `缺 chain_target_inactive：${codes.join(',')}`)
  const broken = body.failures.find((item) => item.code === 'chain_broken')
  assert.equal(broken.missingKey, 'iron-rule-missing')
  assert.equal(body.failures.filter((item) => item.code === 'chain_cycle').length, 1, '同一环只报一次')
})
