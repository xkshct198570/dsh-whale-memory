#!/usr/bin/env node
/**
 * 客户端构建：按 lib/client-src/MANIFEST.json 的顺序逐字节拼接成 lib/client.js。
 *
 * 为什么不引 bundler：DSH 只加载单文件 bundle，源片段是同一 factory 作用域内的文本；
 * 构建只做“读片段 → 拼接 → 语法预检 → 原子写”。不加头尾/分隔符/编码转换。
 * 产物与 generated/** 都入库；`--check` 只读比较，是 pretest/CI 的过期与手改闸。
 *
 * 用法：
 *   node scripts/build-client.mjs            # 重建产物（原子写）
 *   node scripts/build-client.mjs --check    # 只读：产物与源拼接逐字节比较
 *
 * 依赖方向：scripts → acorn + lib/client-src/MANIFEST.json；不 import 业务代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'lib/client-src')
const MANIFEST = path.join(SRC_DIR, 'MANIFEST.json')
const OUTPUT = path.join(ROOT, 'lib/client.js')
const check = process.argv.includes('--check')
const unknown = process.argv.slice(2).filter((a) => a !== '--check')
if (unknown.length) {
  console.error(`[build] 未知参数：${unknown.join(' ')}（只支持 --check）`)
  process.exit(2)
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 读 MANIFEST 并校验形状：构建唯一真源，缺项/路径越界一律停。 */
function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`[build] 缺少 ${path.relative(ROOT, MANIFEST)}`)
    process.exit(1)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  } catch (err) {
    console.error(`[build] MANIFEST.json 解析失败：${err.message}`)
    process.exit(1)
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('[build] MANIFEST.json 必须是非空数组')
    process.exit(1)
  }
  const seen = new Set()
  for (const [i, entry] of manifest.entries()) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.responsibility !== 'string') {
      console.error(`[build] MANIFEST 第 ${i + 1} 项必须含 file/responsibility 字符串`)
      process.exit(1)
    }
    if (entry.file.startsWith('/') || entry.file.includes('..') || entry.file.includes('\\')) {
      console.error(`[build] MANIFEST 路径必须是 lib/client-src/ 内相对 POSIX 路径：${entry.file}`)
      process.exit(1)
    }
    if (seen.has(entry.file)) {
      console.error(`[build] MANIFEST 重复文件：${entry.file}`)
      process.exit(1)
    }
    seen.add(entry.file)
  }
  return manifest
}

const manifest = readManifest()
const parts = []
for (const entry of manifest) {
  const file = path.join(SRC_DIR, entry.file)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error(`[build] 片段不存在：${entry.file}`)
    process.exit(1)
  }
  parts.push({ file: entry.file, buf: fs.readFileSync(file) })
}
const built = Buffer.concat(parts.map((p) => p.buf))
const text = built.toString('utf8')

// 语法预检：只编译不执行；失败绝不写盘。
try {
  new Function(text) // eslint-disable-line no-new-func
} catch (err) {
  console.error(`[build] 拼接产物语法预检失败：${err.message}`)
  process.exit(1)
}

/** 顶层声明唯一性：只对完整拼接产物查一次，不要求片段独立可解析。 */
function duplicateTopLevelDeclarations(code) {
  let ast
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })
  } catch (err) {
    return [`完整产物 acorn 解析失败：${err.message}`]
  }
  const call = ast.body.find((n) => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression')
  const obj = call && call.expression.arguments[0]
  const factoryProp = obj && obj.type === 'ObjectExpression'
    ? obj.properties.find((p) => (p.key.name || p.key.value) === 'factory')
    : null
  const factory = factoryProp && factoryProp.value
  const body = factory && factory.body && factory.body.type === 'BlockStatement' ? factory.body.body : null
  if (!body) return ['完整产物里找不到 factory 块体，无法查顶层声明唯一性']
  const names = new Map()
  const add = (name, node) => {
    names.set(name, [...(names.get(name) || []), node.type])
  }
  for (const node of body) {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) if (decl.id.type === 'Identifier') add(decl.id.name, node)
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      add(node.id.name, node)
    }
  }
  return [...names.entries()].filter(([, types]) => types.length > 1).map(([name, types]) => `${name} 重复声明 ${types.length} 次（${types.join('/')}）`)
}
const duplicates = duplicateTopLevelDeclarations(text)
if (duplicates.length) {
  console.error(`[build] 顶层声明重复：${duplicates.join('；')}`)
  process.exit(1)
}

const builtSha = sha(built)
if (check) {
  if (!fs.existsSync(OUTPUT)) {
    console.error(`[build] 产物不存在：${path.relative(ROOT, OUTPUT)}`)
    process.exit(1)
  }
  const current = fs.readFileSync(OUTPUT)
  const currentSha = sha(current)
  if (Buffer.compare(current, built) !== 0) {
    console.error(`[build] FAIL：产物与源拼接不一致（产物 ${currentSha} / 重建 ${builtSha}，${current.length} vs ${built.length} bytes）`)
    console.error('[build] 产物勿手改；先修源片段/生成器，再重建。')
    process.exit(1)
  }
  console.log(`[build] ok：${manifest.length} 片 → lib/client.js ${built.length} bytes，sha256 ${builtSha}`)
  process.exit(0)
}

// 原子写：同目录 tmp + rename，避免半截产物被 DSH 加载。
const tmp = path.join(path.dirname(OUTPUT), `.client.js.tmp-${process.pid}`)
fs.writeFileSync(tmp, built)
fs.renameSync(tmp, OUTPUT)
console.log(`[build] 已写 lib/client.js：${manifest.length} 片 → ${built.length} bytes，sha256 ${builtSha}`)
