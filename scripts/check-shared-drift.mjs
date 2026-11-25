#!/usr/bin/env node
/**
 * 跨插件共享工具漂移闸（P6b）：与本仓对侧插件的副本逐项对比行数/导出名/函数参数个数。
 *
 * 为什么不建共享包：见 docs/shared-utils-contract.md §2（tarball 传递依赖、发布顺序、回滚链）；
 * 本闸只做**差异审计**，不判红：drift 判据是「同一工具连续两次出现必须两仓同改」才立 P7（契约 §3）。
 * 但工具本身必须 fail-closed：给了 --peer 却读不到仓/文件 → exit 1；没给 --peer → 显式打印跳过原因（不静默）。
 *
 * 用法：
 *   node scripts/check-shared-drift.mjs                       # 仅盘点本仓，并打印「跨仓差异 skipped」原因
 *   node scripts/check-shared-drift.mjs --peer ~/dsh-persona-hub-refactor   # 与对侧副本逐项对比
 *
 * 依赖方向：scripts → node 原生模块 + acorn；不 import 业务代码、不写文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }

/** 两仓同语义副本的映射（本仓路径 ↔ 对侧仓路径）。 */
export const TARGETS = [
  { label: 'config-values', own: 'src/shared/config-values.js', peer: 'src/host/config-values.js' },
  { label: 'http-kit', own: 'src/host/http-kit.js', peer: 'src/host/http-kit.js' },
]

/**
 * 统计文件行数（末行无换行时不虚增一行）。
 * @param {string} text 文件全文
 * @returns {number} 行数
 */
export function lineCount(text) {
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 提取导出符号名。
 * @param {string} text 源码全文
 * @returns {string[]} 升序导出名（default / * 也计入）
 */
export function exportedNames(text) {
  const ast = acorn.parse(text, PARSE_OPTS)
  const names = new Set()
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      names.add('default')
    } else if (node.type === 'ExportAllDeclaration') {
      names.add('*')
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration
        if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
          if (decl.id?.name) names.add(decl.id.name)
        } else if (decl.type === 'VariableDeclaration') {
          for (const item of decl.declarations) if (item.id?.name) names.add(item.id.name)
        }
      }
      for (const spec of node.specifiers ?? []) {
        const exported = spec.exported?.name ?? spec.exported?.value
        if (exported) names.add(exported)
      }
    }
  }
  return [...names].sort()
}

/**
 * 导出签名：导出名 → 参数个数（函数/箭头/方法）；非函数或无法静态判定不收录。
 * @param {string} text 源码全文
 * @returns {Map<string, number>} 导出名 → 参数个数
 */
export function exportArities(text) {
  const ast = acorn.parse(text, PARSE_OPTS)
  const map = new Map()
  const addDeclaration = (decl) => {
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id?.name) {
      if (decl.type === 'FunctionDeclaration') map.set(decl.id.name, decl.params.length)
      return
    }
    if (decl.type === 'VariableDeclaration') {
      for (const item of decl.declarations) {
        const fn = item.init
        if (item.id?.type === 'Identifier' && (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression')) {
          map.set(item.id.name, fn.params.length)
        }
      }
    }
  }
  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) addDeclaration(node.declaration)
    else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration
      if (decl?.params) map.set('default', decl.params.length)
    }
  }
  return map
}

/**
 * 命令行参数解析。
 * @param {string[]} argv 参数
 * @returns {{peer: string|null, help: boolean}} 选项
 */
function parseArgs(argv) {
  const options = { peer: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') continue
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--peer') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--peer 缺少取值（对侧插件仓根目录）')
      options.peer = value
      i += 1
    } else if (arg.startsWith('--peer=')) {
      options.peer = arg.slice('--peer='.length)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

/**
 * 读一个工具文件；不存在返回 null 与原因。
 * @param {string} base 仓库根
 * @param {string} relPath 仓内相对路径
 * @returns {{text: string|null, reason: string|null}} 文本与失败原因
 */
function readTool(base, relPath) {
  const abs = path.join(base, relPath)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { text: null, reason: `缺少 ${relPath}` }
  return { text: fs.readFileSync(abs, 'utf8'), reason: null }
}

/**
 * 汇总一组差异描述（导出名多/少 + 公共导出参数个数不同）。
 * @param {{ownNames: string[], peerNames: string[], ownArities: Map<string, number>, peerArities: Map<string, number>}} input 两侧盘点
 * @returns {string[]} 差异描述（空数组=对齐）
 */
function describeDiff({ ownNames, peerNames, ownArities, peerArities }) {
  const diffs = []
  const peerSet = new Set(peerNames)
  const ownSet = new Set(ownNames)
  const missing = ownNames.filter((name) => !peerSet.has(name))
  const extra = peerNames.filter((name) => !ownSet.has(name))
  if (missing.length) diffs.push(`对侧缺导出 [${missing.join(', ')}]`)
  if (extra.length) diffs.push(`对侧多导出 [${extra.join(', ')}]`)
  for (const [name, arity] of ownArities) {
    if (!peerArities.has(name)) continue
    if (peerArities.get(name) !== arity) diffs.push(`${name} 参数个数 ${arity} != ${peerArities.get(name)}`)
  }
  return diffs
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[shared-drift] ${err?.message || err}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log('用法：node scripts/check-shared-drift.mjs [--peer <对侧插件仓根>]')
    return
  }

  const fails = []
  const own = new Map()
  for (const target of TARGETS) {
    const { text, reason } = readTool(ROOT, target.own)
    if (text == null) {
      fails.push(`${target.own}：${reason}`)
      continue
    }
    const names = exportedNames(text)
    own.set(target.label, { text, names, arities: exportArities(text) })
    console.log(`[shared-drift] ${target.own}：${lineCount(text)} 行 / ${names.length} 个导出（${names.join(', ')}）`)
  }

  if (!options.peer) {
    console.log('[shared-drift] 跨仓差异：skipped（未提供 --peer；用法 node scripts/check-shared-drift.mjs --peer ~/dsh-persona-hub-refactor）')
    if (fails.length > 0) {
      for (const line of fails) console.error(`[shared-drift] FAIL：${line}`)
      process.exit(1)
    }
    console.log('[shared-drift] ok（仅本仓盘点；未建跨插件共享包）')
    return
  }

  const peerRoot = path.resolve(options.peer)
  if (!fs.existsSync(peerRoot) || !fs.statSync(peerRoot).isDirectory()) {
    console.error(`[shared-drift] FAIL：--peer 目录不存在：${peerRoot}`)
    process.exit(1)
  }
  for (const target of TARGETS) {
    const side = readTool(peerRoot, target.peer)
    if (side.text == null) {
      fails.push(`对侧 ${target.peer}：${side.reason}`)
      continue
    }
    const mine = own.get(target.label)
    if (!mine) continue
    const peerNames = exportedNames(side.text)
    const peerArities = exportArities(side.text)
    const diffs = describeDiff({ ownNames: mine.names, peerNames, ownArities: mine.arities, peerArities })
    console.log(`[shared-drift] ${target.label}：本仓 ${lineCount(mine.text)} 行/${mine.names.length} 导出 ↔ 对侧 ${lineCount(side.text)} 行/${peerNames.length} 导出`)
    if (diffs.length === 0) console.log(`[shared-drift] ${target.label}：API 面对齐（同名导出参数个数一致；实现体差异不计 drift）`)
    else for (const line of diffs) console.log(`[shared-drift] ${target.label}：${line}`)
  }

  if (fails.length > 0) {
    for (const line of fails) console.error(`[shared-drift] FAIL：${line}`)
    process.exit(1)
  }
  console.log('[shared-drift] ok（差异审计完成；判红按契约 §3 连续两次漂移才立 P7）')
}

main()
