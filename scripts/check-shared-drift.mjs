#!/usr/bin/env node
// 跨插件共享工具漂移闸（P1 现状）：只读盘点 src/host/http-kit.js 与 src/host/config-values.js
// 的行数与导出符号，作为 P6 差异审计的输入；不建跨插件共享包、不写文件。
//
// 依赖方向：scripts → node 原生模块 + acorn；不 import 业务代码。
// 用法：node scripts/check-shared-drift.mjs [--check]（缺省 --check）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }
const TARGETS = ['src/host/http-kit.js', 'src/host/config-values.js']

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

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--check')) {
  console.error('[shared-drift] 未知参数；用法：node scripts/check-shared-drift.mjs [--check]')
  process.exit(2)
}

const fails = []
for (const file of TARGETS) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) {
    fails.push(`缺少 ${file}`)
    continue
  }
  const text = fs.readFileSync(abs, 'utf8')
  const names = exportedNames(text)
  console.log(`[shared-drift] ${file}：${lineCount(text)} 行 / ${names.length} 个导出（${names.join(', ')}）`)
}

if (fails.length > 0) {
  for (const line of fails) console.error(`[shared-drift] FAIL：${line}`)
  process.exit(1)
}
console.log('[shared-drift] ok（P1 未建跨插件共享包；P6 填充 API/行为差异审计）')
