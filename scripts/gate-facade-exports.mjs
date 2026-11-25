#!/usr/bin/env node
/**
 * E17 门面纯 re-export 与导出面机检（P6a）：主体逻辑独立成模块，`check.mjs` 只做一行接线。
 *
 * 判据（门面 = 对外 import 路径不变、只 re-export 的装配层）：
 * - 只允许 import 本域子模块（`./<domain>/…`）与 export；本地定义/可执行语句/跨域 import 一律红；
 * - 导出只允许 source 形式，或对已 import 符号的再导出；默认导出/星号导出一律红；
 * - 导出名集合必须严格等于 `scripts/facade-exports.json`（唯一真源），多/少都红。
 *
 * 依赖方向：scripts → node 原生模块 + acorn + 仓内 facade-exports.json；不 import 业务代码。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'

const TABLE = 'scripts/facade-exports.json'
const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }

/**
 * 检查全部门面；返回原因数组（空数组=通过）。
 * @param {string} root 仓库根绝对路径
 * @returns {string[]} 失败原因
 */
export function checkFacadeExports(root) {
  const reasons = []
  const tablePath = join(root, TABLE)
  if (!existsSync(tablePath) || !statSync(tablePath).isFile()) return [`缺少 ${TABLE}（门面导出面唯一真源）`]
  let table
  try {
    table = JSON.parse(readFileSync(tablePath, 'utf8'))
  } catch (err) {
    return [`${TABLE} 解析失败：${err.message}`]
  }
  const facades = Array.isArray(table?.facades) ? table.facades : []
  if (facades.length === 0) return [`${TABLE} 未登记任何门面`]
  for (const entry of facades) {
    const file = entry?.file
    const pinned = entry?.exports
    if (typeof file !== 'string') {
      reasons.push('facade-exports.json 存在无 file 的条目')
      continue
    }
    const abs = join(root, file)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      reasons.push(`${file}：文件不存在`)
      continue
    }
    if (!Array.isArray(pinned) || pinned.length === 0) {
      reasons.push(`${file}：exports 清单不是非空数组`)
      continue
    }
    const domain = file.split('/').pop().replace(/\.js$/, '')
    let ast
    try {
      ast = acorn.parse(readFileSync(abs, 'utf8'), PARSE_OPTS)
    } catch (err) {
      reasons.push(`${file}：解析失败 ${err.message}`)
      continue
    }
    const imported = new Set()
    const exported = []
    const bad = []
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const spec = String(node.source.value)
        if (!spec.startsWith(`./${domain}/`)) bad.push(`import 非本域子模块 ${spec}`)
        for (const specifier of node.specifiers) if (specifier.local) imported.add(specifier.local.name)
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          bad.push('含本地导出声明（门面不得定义函数/常量/类）')
          continue
        }
        if (node.source) {
          const spec = String(node.source.value)
          if (!spec.startsWith(`./${domain}/`)) bad.push(`re-export 非本域子模块 ${spec}`)
          for (const specifier of node.specifiers) exported.push(specifier.exported.name || specifier.exported.value)
        } else {
          for (const specifier of node.specifiers) {
            const local = specifier.local.name || specifier.local.value
            if (!imported.has(local)) bad.push(`导出 ${local} 未来自 import（疑似本地定义/透传）`)
            exported.push(specifier.exported.name || specifier.exported.value)
          }
        }
      } else if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') {
        bad.push('门面不得使用默认导出/星号导出')
      } else {
        bad.push(`门面出现非 import/export 语句 ${node.type}`)
      }
    }
    exported.sort()
    const want = [...pinned].sort()
    if (JSON.stringify(exported) !== JSON.stringify(want)) {
      const missing = want.filter((name) => !exported.includes(name))
      const extra = exported.filter((name) => !want.includes(name))
      bad.push(`导出面与清单不一致（缺 [${missing.join(', ')}]，多 [${extra.join(', ')}]）`)
    }
    if (bad.length > 0) reasons.push(`${file}：${bad.join('；')}`)
  }
  return reasons
}
