// 规则路由契约共享夹具（临时根/DB/stub backend/假 req-res/git 注入）；被 rules-routes-*.test.mjs 单向依赖，不 import 测试文件。
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { closeDb, openDb } from '../../src/core/db.js'
import { writeRule } from '../../src/core/rule-store.js'
import { createRoutes } from '../../src/host/routes.js'

export function frontOf(index, extra = {}) {
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

export function fakeReq(method, url, payload) {
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

export function fakeRes() {
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

/**
 * 共享只读夹具：独立临时规则根 + 独立 DB + 两条基线规则（rule-1 铁律 / rule-2 普通）。
 * @returns {{root: string, db: object, backend: object, config: object, handler: Function}}
 */
export function startSharedFixture() {
  // 规则根必须是独立临时目录（dirname(root) 就是 AGENTS.md 的位置）：
  // 直接用 mkdtemp 会让 AGENTS 落到系统 /tmp，污染别的东西也让自己被别的 AGENTS 干扰。
  const root = join(mkdtempSync(join(tmpdir(), 'whale-rules-routes-')), 'rules')
  nodeFs.mkdirSync(root, { recursive: true })
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-rules-routes-db-')))
  const backend = { withDb: (fn) => fn(db) }
  const config = {
    identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
    panel: { allowRemote: false },
    rules: { enabled: true, dir: root, requireGit: false, mirrorAuto: true },
  }
  assert.equal(writeRule(root, { front: frontOf(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  assert.equal(writeRule(root, { front: frontOf(2), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const handler = createRoutes({ config, backend, log: () => {} })
  return { root, db, backend, config, handler }
}

/**
 * 关闭共享夹具：先关库再整目录删除（含 AGENTS.md 所在父目录）。
 * @param {{root: string, db: object}} fx
 */
export function stopSharedFixture({ root, db }) {
  closeDb(db)
  nodeFs.rmSync(dirname(root), { recursive: true, force: true })
}

export function freshFixture(t, extraRules = {}) {
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

export async function callWith(routeHandler, method, path, payload) {
  const { res, done } = fakeRes()
  await routeHandler(fakeReq(method, path, payload), res)
  await done
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

export function fakeGit() {
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

export function gitInstalled() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function seedNumbered(fx, { max = 17, skip = 6 } = {}) {
  for (let n = 1; n <= max; n += 1) {
    if (n === skip) continue
    const text = n === 13 ? '必须保留本机专用规则正文。' : `必须保留第 ${n} 条规则。`
    // 编号只属于 iron-rule：要铺满 1–17 必须写成铁律，普通 rule 不占号（R8 契约）。
    const front = frontOf(n, { type: 'iron-rule', key: `iron-rule-${n}` })
    assert.equal(writeRule(fx.dir, { front, text }, { git: false }).ok, true, `写入第 ${n} 条失败`)
  }
}

export function readManifestSync(dir) {
  return JSON.parse(nodeFs.readFileSync(join(dir, 'manifest.json'), 'utf8'))
}

export function listRulesLen(dir) {
  return nodeFs.readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD')
    .length
}
