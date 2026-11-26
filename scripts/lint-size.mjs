#!/usr/bin/env node
// 体量闸：把铁律 23 的 800/1200/2000 落成机检，统计手写逻辑有效行并对照旧源码基线。
//
// 有效行判据：按 \n 切行；trim 后空行不计；纯 // 行不计；块注释内的行（含行首星号与结束行）不计；
// 其余计 1。字符串/模板字面量里的注释记号不算注释（acorn onComment 精确切注释区间）。
// 分组：source=src/**/*.{js,mjs}；clientSrc=lib/client-src/**/*.js（排除 generated）；
// tests=test/**/*.mjs；scripts=scripts/**/*.mjs（门禁脚本只列数字、不套阈值）。
// 产物 lib/client.js、node_modules、generated、vendored 一律排除。
//
// 依赖方向：scripts → node 原生模块 + acorn；不 import 业务代码。
// 用法：node scripts/lint-size.mjs [--write|--check]（缺省 --check）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'scripts/baseline/lint-size.json')
const THRESHOLDS = { plan: 800, freeze: 1200, split: 2000 }
const PRUNE_DIRS = new Set(['node_modules', 'generated', 'vendored', '.git'])
const PRODUCED = new Set(['lib/client.js'])

// 门禁脚本自身不设体量阈值：它们是装配层/构建入口，只随基线列数字。
const EXEMPT_SCRIPTS = new Set([
  'scripts/build-client.mjs',
  'scripts/split-client.mjs',
  'scripts/capture-baseline.mjs',
  'scripts/compare-baseline.mjs',
  'scripts/lint-size.mjs',
  'scripts/check-deps.mjs',
  'scripts/run-tests.mjs',
  'scripts/check-test-counts.mjs',
  'scripts/check-shared-drift.mjs',
])

/**
 * 递归收集匹配文件；跳过 node_modules/generated/vendored 等目录。
 * @param {string} dir 绝对目录
 * @param {(abs: string) => boolean} match 文件名判据
 * @param {string[]} out 累积结果
 * @returns {string[]} 绝对路径列表
 */
function walk(dir, match, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue
      walk(abs, match, out)
    } else if (entry.isFile() && match(abs)) {
      out.push(abs)
    }
  }
  return out
}

/** @param {string} abs @returns {string} 仓库相对 POSIX 路径 */
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')

// 有效行＝去掉注释后仍有代码字符的行：用 acorn 的 onComment 精确切出注释区间，
// 避免字符串/正则里的 // 与 /* 被误当注释（逐字符扫描会卡在未配对引号上）。
const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }

/**
 * 统计一段源码的手写逻辑有效行。
 * @param {string} text 源码全文
 * @param {string} [label] 文件标识（解析失败告警用）
 * @returns {number} 有效行数
 */
export function effectiveLines(text, label = '<memory>', fragment = false) {
  const lines = text.split('\n')
  // client-src 是同一 factory 作用域内的文本片段，本来就不保证独立可 parse（首片/尾片故意不平衡）；
  // 对它们统一用行级口径，避免把“片段不可独立解析”误报成解析失败。
  if (fragment) return fallbackLines(lines)
  /** @type {{start: number, end: number}[]} */
  const comments = []
  try {
    acorn.parse(text, { ...PARSE_OPTS, onComment: comments })
  } catch (err) {
    // 不静默（铁律 22）：告警后回退到行级启发式，字符串内的注释记号无法区分。
    console.error(`[lint-size] warn：${label} 解析失败，回退行级计行（${err.message}）`)
    return fallbackLines(lines)
  }
  const isCode = new Uint8Array(text.length).fill(1)
  for (const comment of comments) isCode.fill(0, comment.start, comment.end)
  let count = 0
  let offset = 0
  for (const line of lines) {
    if (line.trim() !== '') {
      let hasCode = false
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (ch === ' ' || ch === '\t' || ch === '\r') continue
        if (isCode[offset + i] === 1) {
          hasCode = true
          break
        }
      }
      if (hasCode) count += 1
    }
    offset += line.length + 1
  }
  return count
}

/**
 * 解析失败时的回退计行：切掉行注释与块注释后再判有无代码。
 * @param {string[]} lines 按 \n 切开的行
 * @returns {number} 有效行数
 */
function fallbackLines(lines) {
  let inBlock = false
  let count = 0
  for (const raw of lines) {
    let line = raw
    let code = ''
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end < 0) {
          line = ''
          break
        }
        inBlock = false
        line = line.slice(end + 2)
      } else {
        const lineComment = line.indexOf('//')
        const blockStart = line.indexOf('/*')
        if (blockStart >= 0 && (lineComment < 0 || blockStart < lineComment)) {
          code += line.slice(0, blockStart)
          inBlock = true
          line = line.slice(blockStart + 2)
        } else if (lineComment >= 0) {
          code += line.slice(0, lineComment)
          line = ''
        } else {
          code += line
          line = ''
        }
      }
    }
    if (code.trim() !== '') count += 1
  }
  return count
}

/**
 * 统计一组文件的有效行。
 * @param {string[]} files 绝对路径
 * @returns {Map<string, number>} 仓库相对路径 → 有效行（按路径排序）
 */
function countGroup(files) {
  const map = new Map()
  for (const abs of files.sort()) {
    const fileRel = rel(abs)
    if (PRODUCED.has(fileRel)) continue
    map.set(fileRel, effectiveLines(fs.readFileSync(abs, 'utf8'), fileRel, fileRel.startsWith('lib/client-src/')))
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

/** 收集四组当前体量。 */
function collect() {
  return {
    source: countGroup(walk(path.join(ROOT, 'src'), (abs) => /\.(?:js|mjs)$/.test(abs))),
    clientSrc: countGroup(walk(path.join(ROOT, 'lib/client-src'), (abs) => /\.js$/.test(abs))),
    tests: countGroup(walk(path.join(ROOT, 'test'), (abs) => /\.mjs$/.test(abs))),
    scripts: countGroup(walk(path.join(ROOT, 'scripts'), (abs) => /\.mjs$/.test(abs))),
  }
}

/**
 * 打印一组的分列统计。
 * @param {string} label 组名
 * @param {Map<string, number>} map 文件体量
 */
function report(label, map) {
  const over = [...map.entries()].filter(([, n]) => n > THRESHOLDS.plan).sort((a, b) => b[1] - a[1])
  const max = map.size === 0 ? 0 : Math.max(...map.values())
  console.log(`[lint-size] ${label}: ${map.size} 个文件，最大 ${max} 行，>800 共 ${over.length} 个${label === 'clientSrc' ? '（文本片段按行级口径）' : ''}`)
  for (const [file, n] of over) console.log(`  ${String(n).padStart(5)}  ${file}`)
}

/** 把 Map 转成按路径排序的普通对象（写基线用）。 */
function toObject(map) {
  const obj = {}
  for (const [file, n] of map) obj[file] = n
  return obj
}

/**
 * --write：把旧源码三组体量写入基线（不写 clientSrc，基线只列旧源码）。
 * @param {ReturnType<typeof collect>} groups
 */
function writeBaseline(groups) {
  const data = {
    generatedAt: new Date().toISOString(),
    thresholds: THRESHOLDS,
    source: toObject(groups.source),
    tests: toObject(groups.tests),
    scripts: toObject(groups.scripts),
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`[lint-size] 已写基线 ${rel(BASELINE)}：source ${groups.source.size} / tests ${groups.tests.size} / scripts ${groups.scripts.size}`)
}

/**
 * --check：对照基线判增长/新增超限/绝对上限，违规逐条 FAIL。
 * @param {ReturnType<typeof collect>} groups
 * @returns {string[]} 违规描述
 */
function check(groups) {
  if (!fs.existsSync(BASELINE)) {
    return [`缺少基线 ${rel(BASELINE)}：先跑 node scripts/lint-size.mjs --write`]
  }
  let baseline
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  } catch (err) {
    return [`基线 ${rel(BASELINE)} 解析失败：${err.message}`]
  }

  const fails = []
  // clientSrc 永远不在基线里：新增手写文件必须 ≤800，>1200 绝对违规。
  for (const [file, n] of groups.clientSrc) {
    if (n > THRESHOLDS.plan) {
      const limit = n > THRESHOLDS.freeze ? `${THRESHOLDS.freeze}（client-src 绝对上限）` : `${THRESHOLDS.plan}（client-src 新增上限）`
      fails.push(`${file} ${n} > ${limit}`)
    }
  }
  for (const group of ['source', 'tests', 'scripts']) {
    const base = baseline[group] ?? {}
    for (const [file, n] of groups[group]) {
      if (group === 'scripts' && EXEMPT_SCRIPTS.has(file)) continue
      if (Object.prototype.hasOwnProperty.call(base, file)) {
        if (n > base[file]) fails.push(`${file} ${n} > ${base[file]}（增长，存量只减不增）`)
      } else if (n > THRESHOLDS.split) {
        fails.push(`${file} ${n} > ${THRESHOLDS.split}（新增绝对超限）`)
      } else if (n > THRESHOLDS.plan) {
        fails.push(`${file} ${n} > ${THRESHOLDS.plan}（新增超限）`)
      }
    }
  }
  return fails
}

/** CLI 入口：只在被直接执行时跑；被测试 import 时只导出 effectiveLines。 */
function main() {
  const args = process.argv.slice(2)
  const known = new Set(['--write', '--check'])
  for (const arg of args) {
    if (!known.has(arg)) {
      console.error(`[lint-size] 未知参数 ${arg}；用法：node scripts/lint-size.mjs [--write|--check]`)
      process.exit(2)
    }
  }
  const mode = args.includes('--write') ? 'write' : 'check'

  const groups = collect()
  report('source', groups.source)
  report('clientSrc', groups.clientSrc)
  report('tests', groups.tests)
  report('scripts', groups.scripts)

  if (mode === 'write') {
    writeBaseline(groups)
    process.exit(0)
  }

  const fails = check(groups)
  if (fails.length > 0) {
    for (const line of fails) console.error(`[lint-size] FAIL: ${line}`)
    process.exit(1)
  }
  console.log(
    `[lint-size] ok：source ${groups.source.size} / clientSrc ${groups.clientSrc.size} / tests ${groups.tests.size} / scripts ${groups.scripts.size} 个文件，0 违规`,
  )
}

/**
 * 是否被直接执行：两侧都先 realpath 再比。
 * 为什么不能只比 `import.meta.url === pathToFileURL(resolve(argv[1]))`：包管理器/CI 常用 symlink
 * 包装脚本，argv[1] 是链接路径而 import.meta.url 是真实路径，直比会 false → 门禁静默不跑（fail-open）。
 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    const self = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href
    const entry = pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href
    return self === entry
  } catch {
    return false
  }
}
if (isMainModule()) main()
