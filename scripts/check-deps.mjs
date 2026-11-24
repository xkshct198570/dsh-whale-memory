#!/usr/bin/env node
// 解耦闸：解析 index.js 与 src/** 的 import/export 图，拦反向依赖、跨域摸内部、环。
//
// 规则（命中且不在 scripts/decouple-baseline.json 的 allowedEdges 即 FAIL）：
//   1) src/core/** → src/host/**
//   2) src/shared/** → src/host/** 或 src/core/**
//   3) src/host/** → src/core/<域>/<子模块>.js（只允许 src/core/<域>.js 或 src/core/<域>/index.js 门面）
//   4) src/core/<域A>/** → src/core/<域B>/<子模块>.js（A≠B 且目标非 index.js，只允许门面）
//   5) 内部 import 图出现环
//
// 包名 import（不以 . 开头）忽略；相对路径先解析到仓库相对 POSIX 路径，再按 pathMigrations 迁移。
// 依赖方向：scripts → node 原生模块 + acorn；不 import 业务代码。
// 用法：node scripts/check-deps.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'scripts/decouple-baseline.json')
const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }

// 只扫源码入口与 src；test/scripts/lib/client.js 不在依赖图内。
const SCAN_ROOTS = [path.join(ROOT, 'index.js'), path.join(ROOT, 'src')]

/**
 * 递归收集 .js/.mjs 源文件。
 * @param {string} dir 绝对目录
 * @param {string[]} out 累积结果
 * @returns {string[]} 绝对路径
 */
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(abs, out)
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(abs)) {
      out.push(abs)
    }
  }
  return out
}

/** @param {string} abs @returns {string} 仓库相对 POSIX 路径 */
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')

/** 收集扫描范围内的文件并按路径排序。 */
function scanFiles() {
  const files = []
  for (const root of SCAN_ROOTS) {
    if (root.endsWith('.js') || root.endsWith('.mjs')) {
      if (fs.existsSync(root) && fs.statSync(root).isFile()) files.push(root)
    } else {
      walk(root, files)
    }
  }
  return [...new Set(files.map(rel))].sort()
}

/**
 * 解析模块，取出 import/export 的模块说明符。
 * @param {string} file 仓库相对路径
 * @returns {string[]} 模块说明符
 */
function collectDynamicImports(node, out) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'ImportExpression') {
    if (node.source && node.source.type === 'Literal' && typeof node.source.value === 'string') {
      out.push(node.source.value)
    }
    return
  }
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) collectDynamicImports(item, out)
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      collectDynamicImports(value, out)
    }
  }
}

function specifiersOf(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const ast = acorn.parse(text, PARSE_OPTS)
  const specs = []
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') specs.push(node.source.value)
    else if (node.type === 'ExportNamedDeclaration' && node.source) specs.push(node.source.value)
    else if (node.type === 'ExportAllDeclaration') specs.push(node.source.value)
  }
  // 动态 import('../host/x.js') 同样是反向依赖，必须进图。
  collectDynamicImports(ast, specs)
  return specs
}

/**
 * 相对说明符 → 仓库相对路径（含扩展名补全与 pathMigrations 迁移）。
 * @param {string} importer 仓库相对路径
 * @param {string} spec 模块说明符
 * @param {Record<string, string>} migrations 迁移表
 * @returns {string|null} 解析结果；包名/解析不到时为 null
 */
function resolveSpec(importer, spec, migrations) {
  if (!spec.startsWith('.')) return null
  const abs = path.resolve(path.dirname(path.join(ROOT, importer)), spec)
  let target = rel(abs)
  if (target.startsWith('..')) return null
  if (Object.prototype.hasOwnProperty.call(migrations, target)) target = migrations[target]
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}/index.js`, `${target}/index.mjs`]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(ROOT, candidate)) && fs.statSync(path.join(ROOT, candidate)).isFile()) {
      return Object.prototype.hasOwnProperty.call(migrations, candidate) ? migrations[candidate] : candidate
    }
  }
  return null
}

/**
 * 规则 1-4：返回违规描述或 null。
 * @param {string} file 依赖方（仓库相对）
 * @param {string} dep 被依赖方（仓库相对）
 * @returns {string|null}
 */
function ruleViolation(file, dep) {
  const inCore = file.startsWith('src/core/')
  const inHost = file.startsWith('src/host/')
  const inShared = file.startsWith('src/shared/')
  const depCore = dep.startsWith('src/core/')
  const depHost = dep.startsWith('src/host/')

  if (inCore && depHost) return `core 不得 import host（${file} → ${dep}）`
  if (inShared && (depHost || depCore)) return `shared 不得 import ${depHost ? 'host' : 'core'}（${file} → ${dep}）`

  if (inHost && depCore) {
    const parts = dep.split('/') // src/core/<域>[/...]
    const facade = parts.length === 3 || (parts.length === 4 && parts[3] === 'index.js')
    if (!facade) return `host 摸 core 内部（只允许 ${parts[2]}.js 或 ${parts[2]}/index.js）：${file} → ${dep}`
  }

  if (inCore && depCore) {
    const fp = file.split('/')
    const dp = dep.split('/')
    const fileDomain = fp.length >= 4 ? fp[2] : null
    const depDomain = dp.length >= 4 ? dp[2] : null
    if (fileDomain && depDomain && fileDomain !== depDomain && dp.length >= 4 && dp[dp.length - 1] !== 'index.js') {
      return `跨域摸内部（${fileDomain} → ${depDomain}/${dp.slice(3).join('/')}）：${file} → ${dep}`
    }
  }
  return null
}

/**
 * DFS 找环，返回环路径列表（每个环形如 a → b → a）。
 * @param {Map<string, string[]>} graph 邻接表
 * @returns {string[][]}
 */
function findCycles(graph) {
  const cycles = []
  const state = new Map() // 0=未访问 1=在栈 2=完成
  const stack = []
  const stackIndex = new Map()

  const visit = (node) => {
    state.set(node, 1)
    stackIndex.set(node, stack.length)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        cycles.push([...stack.slice(stackIndex.get(next)), next])
      } else if (!state.has(next)) {
        visit(next)
      }
    }
    stack.pop()
    stackIndex.delete(node)
    state.set(node, 2)
  }

  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node)
  }
  return cycles
}

function main() {
  if (!fs.existsSync(BASELINE)) {
    console.error(`[check-deps] FAIL：缺少基线 ${rel(BASELINE)}`)
    process.exit(1)
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const allowed = new Set((baseline.allowedEdges ?? []).map((e) => `${e.file} → ${e.target}`))
  const migrations = baseline.pathMigrations ?? {}

  const files = scanFiles()
  const fileSet = new Set(files)
  const fails = []
  const edges = []
  const graph = new Map()

  for (const file of files) {
    let specs
    try {
      specs = specifiersOf(file)
    } catch (err) {
      fails.push(`解析失败 ${file}：${err.message}`)
      continue
    }
    const deps = []
    for (const spec of specs) {
      const dep = resolveSpec(file, spec, migrations)
      if (!dep) {
        // 相对 import 解析不到就是依赖图缺口（拼错/漏文件/指向未跟踪产物）：必须红，不能 warn 放行。
        if (spec.startsWith('.')) fails.push(`无法解析相对 import：${file} → ${spec}（目标不存在）`)
        continue
      }
      edges.push({ file, dep })
      if (!fileSet.has(dep)) continue
      deps.push(dep)
      const violation = ruleViolation(file, dep)
      if (violation && !allowed.has(`${file} → ${dep}`)) fails.push(violation)
    }
    graph.set(file, [...new Set(deps)].sort())
  }

  // allowed used：基线边在现图中仍存在的条数（消失不报错，只少用）。
  let used = 0
  for (const edge of allowed) {
    const [file, dep] = edge.split(' → ')
    if (edges.some((e) => e.file === file && e.dep === dep)) used += 1
  }

  const cycles = findCycles(graph)
  for (const cycle of cycles) fails.push(`循环依赖：${cycle.join(' → ')}`)

  if (fails.length > 0) {
    for (const line of fails) console.error(`[check-deps] FAIL: ${line}`)
    process.exit(1)
  }
  console.log(
    `[check-deps] ok：files ${files.length} / edges ${edges.length} / allowed used ${used}/${allowed.size} / cycles 0`,
  )
}

main()
