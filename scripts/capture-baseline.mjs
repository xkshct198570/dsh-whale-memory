#!/usr/bin/env node
/**
 * P1 基线捕获：把重构前的可对拍事实固化成 scripts/baseline/ 下的 7 份快照。
 *
 * 设计约束：
 * - 默认不 import 业务模块；只有 --node-import 才动态 import index.js（临时 DSH_HOME + 5s 超时）。
 * - 路由快照走现有 createRoutes 路径（http.createServer + listen(0)），不启动 DSH、不碰 live 库。
 * - locale 对象只做静态解析：acorn 解析表达式后按 AST 转值，禁止动态求值。
 * - 任何快照失败都抛错，由 main 统一 exit 1；不写半成品当前值、不猜。
 *
 * 依赖方向：只依赖 Node 内置模块与 acorn；本文件同时作为 compare-baseline.mjs 的库使用，
 * 因此 import 本文件不得执行 main（见文件末尾守卫）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import { parse as parseJs, parseExpressionAt } from 'acorn'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_DIR = join(ROOT, 'scripts/baseline')
export const CLIENT_FILE = join(ROOT, 'lib/client.js')
const CLIENT_REL = 'lib/client.js'
const INDEX_FILE = join(ROOT, 'index.js')
export const TEST_RESULTS_FILE = join(ROOT, '.test-results.json')

/** 路由快照的固定端点集合：只锁状态码与顶层 JSON 字段集合，不锁值。 */
export const ROUTE_ENDPOINTS = [
  { method: 'GET', path: '/whale-memory/api/version' },
  { method: 'GET', path: '/whale-memory/api/stats' },
  { method: 'GET', path: '/whale-memory/api/config' },
  { method: 'GET', path: '/whale-memory/api/nodes?limit=1' },
  { method: 'GET', path: '/whale-memory/api/recalls' },
  { method: 'POST', path: '/whale-memory/api/search', body: { query: '记忆', limit: 5 } },
  { method: 'POST', path: '/whale-memory/api/recall-test', body: { query: '记忆' } },
]

/** 快照文件名（与任务书写作用域一致）。 */
export const SNAPSHOT_FILES = {
  clientSha: 'client.sha256.p1',
  exports: 'exports.json',
  routes: 'routes-fixture.json',
  schema: 'schema-version.json',
  testCounts: 'test-counts.json',
  locale: 'locale-object.json',
  current: 'current.json',
}

/** @param {string} file @returns {string} 小写十六进制 sha256 */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// 快照先全部算进内存，最后统一落盘：任何一步失败都不留下“新旧混合”的半成品基线。
const pendingSnapshots = []

function queueJson(fileName, value) {
  pendingSnapshots.push({ fileName, text: `${JSON.stringify(value, null, 2)}\n` })
}

function queueRaw(fileName, text) {
  pendingSnapshots.push({ fileName, text })
}

function flushSnapshots() {
  for (const item of pendingSnapshots) {
    writeFileSync(join(BASELINE_DIR, item.fileName), item.text)
  }
}

/**
 * 读 .test-results.json 的 pass/skip/fail；缺文件或字段即抛错（不默认 0）。
 * @returns {{pass:number,skip:number,fail:number}}
 */
export function readTestCounts() {
  if (!existsSync(TEST_RESULTS_FILE)) {
    throw new Error(`test-counts: ${relative(ROOT, TEST_RESULTS_FILE)} 不存在，先跑 npm test（P1 不重跑全量）`)
  }
  let data
  try {
    data = JSON.parse(readFileSync(TEST_RESULTS_FILE, 'utf8'))
  } catch (err) {
    throw new Error(`test-counts: ${relative(ROOT, TEST_RESULTS_FILE)} 解析失败: ${err?.message || err}`)
  }
  const out = {}
  for (const key of ['pass', 'skip', 'fail']) {
    const value = data?.[key]
    if (!Number.isFinite(value)) throw new Error(`test-counts: 缺少数值字段 ${key}`)
    out[key] = value
  }
  return out
}

function scanSchemaVersion(file) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const hit = /(?:export\s+)?(?:const|let|var)\s+SCHEMA_VERSION\s*=\s*(-?\d+)/.exec(source)
  return hit ? Number(hit[1]) : null
}

/**
 * 读测试运行元信息（exitCode/tests）：对拍要证明“这次真跑且成功”，不能只看三元组。
 * 缺文件/字段即抛错，不默认 0。
 * @returns {{exitCode:number,tests:number}}
 */
export function readTestRunMeta() {
  if (!existsSync(TEST_RESULTS_FILE)) {
    throw new Error(`test-run: ${relative(ROOT, TEST_RESULTS_FILE)} 不存在，先跑 npm test`)
  }
  const data = JSON.parse(readFileSync(TEST_RESULTS_FILE, 'utf8'))
  if (!Number.isInteger(data?.exitCode)) throw new Error('test-run: .test-results.json 缺少数值 exitCode')
  if (!Number.isInteger(data?.tests)) throw new Error('test-run: .test-results.json 缺少数值 tests')
  return { exitCode: data.exitCode, tests: data.tests }
}

/**
 * 静态读 SCHEMA_VERSION：先看 src/core/db.js，再沿其本地相对 import 找声明处。
 * 实际常量目前声明在 src/core/schema.js（db.js 只 import），因此 source 记录真实声明文件。
 * @returns {{version:number, source:string}}
 */
export function readSchemaVersion() {
  const dbFile = join(ROOT, 'src/core/db.js')
  const dbVersion = scanSchemaVersion(dbFile)
  if (dbVersion !== null) return { version: dbVersion, source: 'src/core/db.js' }

  let dbSource
  try {
    dbSource = readFileSync(dbFile, 'utf8')
  } catch (err) {
    throw new Error(`schema-version: 读不到 src/core/db.js: ${err?.message || err}`)
  }
  const relImports = [...dbSource.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1])
  const candidates = []
  for (const rel of relImports) {
    const base = resolve(dirname(dbFile), rel)
    candidates.push(base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'))
  }
  const schemaFile = join(ROOT, 'src/core/schema.js')
  candidates.push(schemaFile)
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const version = scanSchemaVersion(file)
    if (version !== null) {
      return { version, source: relative(ROOT, file).split('\\').join('/') }
    }
  }
  throw new Error('schema-version: 在 src/core/db.js 及其本地 import 中找不到 SCHEMA_VERSION 常量')
}

/**
 * 把 acorn 表达式 AST 转成 JS 值；只支持确定性的字面量结构，遇到未知节点直接抛错（不猜）。
 * @param {import('acorn').Node} node
 */
export function nodeToValue(node) {
  if (!node) return null
  switch (node.type) {
    case 'ObjectExpression': {
      const out = {}
      for (const prop of node.properties) {
        if (prop.type !== 'Property') {
          throw new Error(`locale: 不支持的对象成员类型 ${prop.type}`)
        }
        if (prop.kind !== 'init' || prop.method || prop.computed) {
          throw new Error('locale: 不支持 getter/setter/method/计算属性')
        }
        let key
        if (prop.key.type === 'Identifier') key = prop.key.name
        else if (prop.key.type === 'Literal') key = String(prop.key.value)
        else throw new Error(`locale: 不支持的属性键类型 ${prop.key.type}`)
        out[key] = nodeToValue(prop.value)
      }
      return out
    }
    case 'ArrayExpression': {
      return node.elements.map((item) => {
        if (item === null) return null
        if (item.type === 'SpreadElement') throw new Error('locale: 不支持数组展开')
        return nodeToValue(item)
      })
    }
    case 'Literal': {
      if (node.regex) throw new Error('locale: 不支持正则字面量')
      return node.value
    }
    case 'TemplateLiteral': {
      if (node.expressions.length > 0) throw new Error('locale: 不支持带插值的模板字符串')
      return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')
    }
    case 'UnaryExpression': {
      const value = nodeToValue(node.argument)
      switch (node.operator) {
        case '-': return -value
        case '+': return +value
        case '!': return !value
        case 'void': return undefined
        default: throw new Error(`locale: 不支持一元运算符 ${node.operator}`)
      }
    }
    case 'ParenthesizedExpression':
      return nodeToValue(node.expression)
    default:
      throw new Error(`locale: 不支持的 AST 节点 ${node.type}`)
  }
}

function findDictInit(body) {
  for (const node of body) {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id?.name === 'dict' && decl.init) return decl.init
      }
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration
      if (decl.type === 'VariableDeclaration') {
        for (const item of decl.declarations) {
          if (item.id?.name === 'dict' && item.init) return item.init
        }
      }
    }
    if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'ObjectExpression') {
      return node.declaration
    }
  }
  return null
}

function assertLocaleShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('locale: dict 不是对象')
  }
  for (const lang of ['zh', 'en', 'ja']) {
    const table = value[lang]
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`locale: 缺少 ${lang} 语对象`)
    }
  }
  return value
}

/**
 * 取三语 dict：优先 lib/client-src/generated/locale.js（后续阶段生成的源码），
 * 否则从 lib/client.js 的 locale:generated 标记块里静态解析。
 * @returns {{value: Record<string, Record<string,string>>, source: string}}
 */
export function extractLocaleObject() {
  const generated = join(ROOT, 'lib/client-src/generated/locale.js')
  if (existsSync(generated)) {
    const source = readFileSync(generated, 'utf8')
    let ast
    try {
      ast = parseJs(source, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (err) {
      throw new Error(`locale: 解析 lib/client-src/generated/locale.js 失败: ${err?.message || err}`)
    }
    const init = findDictInit(ast.body)
    if (!init) throw new Error('locale: lib/client-src/generated/locale.js 中找不到 dict 对象')
    return {
      value: assertLocaleShape(nodeToValue(init)),
      source: 'lib/client-src/generated/locale.js',
    }
  }

  const source = readFileSync(CLIENT_FILE, 'utf8')
  const begin = '// >>> locale:generated'
  const end = '// <<< locale:generated'
  const start = source.indexOf(begin)
  if (start < 0) throw new Error('locale: lib/client.js 缺少 locale:generated 起始标记')
  const stop = source.indexOf(end, start)
  if (stop < 0) throw new Error('locale: lib/client.js 缺少 locale:generated 结束标记')
  const block = source.slice(start, stop)
  const marker = block.indexOf('const dict')
  if (marker < 0) throw new Error('locale: 标记块内找不到 const dict')
  let expr = block.slice(marker + 'const dict'.length).trimStart()
  if (expr.startsWith('=')) expr = expr.slice(1).trimStart()
  else throw new Error('locale: const dict 后缺少 =')
  expr = expr.replace(/;\s*$/, '').trimEnd()
  let node
  try {
    node = parseExpressionAt(expr, 0, { ecmaVersion: 'latest' })
  } catch (err) {
    throw new Error(`locale: dict 表达式解析失败: ${err?.message || err}`)
  }
  if (node.end !== expr.length) {
    throw new Error(`locale: dict 表达式后有多余内容（偏移 ${node.end}/${expr.length}）`)
  }
  return {
    value: assertLocaleShape(nodeToValue(node)),
    source: 'lib/client.js (locale:generated)',
  }
}

/** @param {{value: object}} locale @returns {{zh:number,en:number,ja:number}} */
export function localeCounts(value) {
  const counts = {}
  for (const lang of ['zh', 'en', 'ja']) counts[lang] = Object.keys(value[lang] || {}).length
  return counts
}

/**
 * 收集 index.js 的导出名（静态 acorn）：
 * - ExportNamedDeclaration：声明名 + specifier 的 exported.name（别名以导出名为准）
 * - ExportDefaultDeclaration → "default"
 * - ExportAllDeclaration → "*"
 * @returns {string[]} 排序后的导出名
 */
export function collectAcornExports() {
  const source = readFileSync(INDEX_FILE, 'utf8')
  const ast = parseJs(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const names = new Set()
  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration
        if (decl.type === 'VariableDeclaration') {
          for (const item of decl.declarations) {
            if (item.id?.type !== 'Identifier') {
              throw new Error(`exports: 不支持的变量解构导出 ${item.id?.type}`)
            }
            names.add(item.id.name)
          }
        } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
          names.add(decl.id.name)
        }
      }
      for (const spec of node.specifiers) {
        if (spec.type !== 'ExportSpecifier') throw new Error(`exports: 不支持的 specifier ${spec.type}`)
        names.add(spec.exported.name ?? spec.exported.value)
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      names.add('default')
    } else if (node.type === 'ExportAllDeclaration') {
      names.add('*')
    }
  }
  return [...names].sort()
}

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'whale-baseline-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    })
}

/**
 * 动态 import index.js 取运行时导出名；临时 DSH_HOME + 5s 超时，失败只返回 errors 不阻塞。
 * @returns {Promise<{node: string[]|null, errors: string[]}>}
 */
export async function importNodeExports(timeoutMs = 5000) {
  return withTempHome(async () => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`动态 import index.js 超时 ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    })
    try {
      const mod = await Promise.race([
        import(`${pathToFileURL(INDEX_FILE).href}?baseline=${Date.now()}`),
        timeout,
      ])
      return { node: Object.keys(mod).sort(), errors: [] }
    } catch (err) {
      return { node: null, errors: [String(err?.message || err)] }
    } finally {
      clearTimeout(timer)
    }
  })
}

function makeStubBackend() {
  /** 固定形状 stub：只服务于路由字段/状态码对拍，不读写任何真实库。 */
  return {
    protocolStatus: null,
    baseUrl: 'http://127.0.0.1:0',
    mode: 'local',
    ready: true,
    async stats() { return { totals: { nodes_total: 0, nodes_active: 0, edges: 0 } } },
    async recent() { return { items: [] } },
    async search() { return { hits: [], count: 0, below_min_n: 0 } },
    async recall() { return { prefix: 'MEM', hits: 0 } },
    async write() { return { ok: true, id: 'fixture' } },
    async nodes() { return { items: [], total: 0 } },
    async recalls() { return { items: [] } },
  }
}

async function hitEndpoint(base, endpoint) {
  const headers = endpoint.body ? { 'content-type': 'application/json' } : undefined
  try {
    const res = await fetch(base + endpoint.path, {
      method: endpoint.method,
      headers,
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
      signal: AbortSignal.timeout(5000),
    })
    const text = await res.text()
    let body = null
    let parseError = null
    try {
      body = JSON.parse(text)
    } catch {
      parseError = 'non_json_body'
    }
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : []
    const record = { method: endpoint.method, path: endpoint.path, status: res.status, ok: res.ok, keys }
    if (parseError) record.error = parseError
    return record
  } catch (err) {
    return {
      method: endpoint.method,
      path: endpoint.path,
      status: 0,
      ok: false,
      keys: [],
      error: String(err?.message || err),
    }
  }
}

/**
 * 用现有 createRoutes 路径跑 7 个固定端点，返回 [{method,path,status,ok,keys}]。
 * 临时 DSH_HOME 与 listen(0) 保证不碰 live 库、不占固定端口。
 */
export async function captureRoutes() {
  return withTempHome(async () => {
    const { createRoutes } = await import(pathToFileURL(join(ROOT, 'src/host/routes.js')).href)
    const config = {
      identity: { mode: 'fixed', userId: 'u1', roleId: '', workspace: '' },
      panel: { allowRemote: false },
      recall: { enabled: true, maxHits: 5, timeoutMs: 1000 },
    }
    const server = http.createServer(createRoutes({ config, backend: makeStubBackend() }))
    try {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
      })
      const base = `http://127.0.0.1:${server.address().port}`
      const records = []
      for (const endpoint of ROUTE_ENDPOINTS) records.push(await hitEndpoint(base, endpoint))
      return records
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  const nodeImport = args.includes('--node-import')
  const unknown = args.filter((arg) => arg !== '--node-import')
  if (unknown.length > 0) {
    console.error(`[baseline] 未知参数: ${unknown.join(' ')}（用法: capture-baseline.mjs [--node-import]）`)
    process.exitCode = 2
    return
  }

  mkdirSync(BASELINE_DIR, { recursive: true })
  pendingSnapshots.length = 0

  // 1) client sha256
  const sha = sha256File(CLIENT_FILE)
  queueRaw(SNAPSHOT_FILES.clientSha, `${sha}  ${CLIENT_REL}\n`)
  console.log(`[baseline] client.sha256.p1: ${sha}  ${CLIENT_REL}`)

  // 2) exports（acorn 恒有；node 段仅 --node-import）
  const acornNames = collectAcornExports()
  let nodeNames = null
  let nodeErrors = []
  if (nodeImport) {
    const result = await importNodeExports()
    nodeNames = result.node
    nodeErrors = result.errors
  }
  queueJson(SNAPSHOT_FILES.exports, { node: nodeNames, acorn: acornNames, errors: nodeErrors })
  console.log(`[baseline] exports.json: acorn=${acornNames.length} node=${nodeNames ? `${nodeNames.length}` : 'skipped'}${nodeErrors.length ? ` errors=${nodeErrors.length}` : ''}`)

  // 3) routes fixture
  const routes = await captureRoutes()
  queueJson(SNAPSHOT_FILES.routes, routes)
  const okCount = routes.filter((item) => item.ok).length
  console.log(`[baseline] routes-fixture.json: ${okCount}/${routes.length} endpoints ok (status/keys)`)

  // 4) schema version
  const schema = readSchemaVersion()
  queueJson(SNAPSHOT_FILES.schema, schema)
  console.log(`[baseline] schema-version.json: v${schema.version} (${schema.source})`)

  // 5) test counts（只读 .test-results.json）
  const counts = readTestCounts()
  queueJson(SNAPSHOT_FILES.testCounts, counts)
  console.log(`[baseline] test-counts.json: pass=${counts.pass} skip=${counts.skip} fail=${counts.fail}`)

  // 6) locale object（三语 dict）
  const locale = extractLocaleObject()
  queueJson(SNAPSHOT_FILES.locale, locale.value)
  const loc = localeCounts(locale.value)
  console.log(`[baseline] locale-object.json: zh=${loc.zh} en=${loc.en} ja=${loc.ja} (from ${locale.source})`)

  // 7) current phase tag
  queueJson(SNAPSHOT_FILES.current, { phase: 'P1' })
  console.log('[baseline] current.json: phase=P1')

  // render-tree：P1 不引 jsdom、不抽渲染树，显式跳过而不是静默缺失。
  console.log('[baseline] render-tree: skipped (no source)')

  flushSnapshots()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[baseline] FAIL: ${err?.message || err}`)
    process.exitCode = 1
  })
}
