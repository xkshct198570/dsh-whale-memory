#!/usr/bin/env node
/**
 * i18n 校验/生成：locale/{zh,en,ja}.json 是唯一真源，lib/client.js 只保留由它生成的常量块。
 *
 * 用法：
 *   node scripts/i18n-check.mjs          # 默认 --check：三语键集/占位符一致 + 标记块与 JSON 一致
 *   node scripts/i18n-check.mjs --check  # 同上
 *   node scripts/i18n-check.mjs --write  # 从 JSON 重生成 client 标记块
 *
 * 零依赖、零网络；只用 node 原生模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'lib/client.js')
const LANGS = ['zh', 'en', 'ja']
/** 标记块必须逐字一致：生成器与校验器共用这一对常量。 */
const MARK_START = '// >>> locale:generated（由 scripts/i18n-check.mjs --write 生成，勿手改）'
const MARK_END = '// <<< locale:generated'

const args = process.argv.slice(2)
const write = args.includes('--write')
const unknown = args.filter((arg) => arg !== '--write' && arg !== '--check')
if (unknown.length > 0) {
  console.error(`[i18n] 未知参数：${unknown.join(' ')}（只支持 --check / --write）`)
  process.exit(2)
}

/** 把 locale JSON 的嵌套结构平铺成客户端 `t()` 用的点号键（meta.title 等）。 */
function flatten(node, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, dotted))
    } else {
      out[dotted] = value
    }
  }
  return out
}

function readLocale(lang) {
  const file = path.join(ROOT, 'locale', `${lang}.json`)
  try {
    return flatten(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    console.error(`[i18n] 读取 ${path.relative(ROOT, file)} 失败：${err.message}`)
    process.exit(1)
  }
}

const dicts = Object.fromEntries(LANGS.map((lang) => [lang, readLocale(lang)]))
const problems = []

// ① 三语键集完全一致。
const zhKeys = new Set(Object.keys(dicts.zh))
for (const lang of LANGS.slice(1)) {
  const keys = new Set(Object.keys(dicts[lang]))
  const missing = [...zhKeys].filter((key) => !keys.has(key))
  const extra = [...keys].filter((key) => !zhKeys.has(key))
  if (missing.length > 0) problems.push(`${lang} 缺少 ${missing.length} 个键：${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`)
  if (extra.length > 0) problems.push(`${lang} 多出 ${extra.length} 个键：${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ' …' : ''}`)
}

// ② 占位符集合一致（同一个键在三种语言里必须使用相同的 {name}）。
const placed = /\{([A-Za-z0-9_]+)\}/g
function placeholderSet(value) {
  const set = new Set()
  if (typeof value !== 'string') return set
  for (const match of value.matchAll(placed)) set.add(match[1])
  return set
}
const sharedKeys = [...zhKeys].filter((key) => LANGS.every((lang) => Object.prototype.hasOwnProperty.call(dicts[lang], key)))
for (const key of sharedKeys) {
  const reference = placeholderSet(dicts.zh[key])
  const refText = [...reference].sort().join(',')
  for (const lang of LANGS.slice(1)) {
    const got = [...placeholderSet(dicts[lang][key])].sort().join(',')
    if (got !== refText) problems.push(`${key} 的占位符不一致：zh={${refText}} ${lang}={${got}}`)
  }
}

if (problems.length > 0) {
  console.error('[i18n] 校验失败：')
  for (const line of problems) console.error(`  - ${line}`)
  process.exit(1)
}

/** 客户端标记块期望内容（与 --write 生成结果逐字一致）。 */
function expectedBlock() {
  const json = JSON.stringify(dicts, null, 2).replace(/\n/g, '\n    ')
  return `${MARK_START}\n    const dict = ${json}\n    ${MARK_END}`
}

let clientText
try {
  clientText = fs.readFileSync(CLIENT, 'utf8')
} catch (err) {
  console.error(`[i18n] 读取 lib/client.js 失败：${err.message}`)
  process.exit(1)
}

const start = clientText.indexOf(MARK_START)
const end = clientText.indexOf(MARK_END, start + MARK_START.length)
const expected = expectedBlock()

if (start >= 0 && end >= 0) {
  const actual = clientText.slice(start, end + MARK_END.length)
  if (actual === expected) {
    console.log(`[i18n] ok：三语各 ${zhKeys.size} 键，占位符一致，client 标记块与 JSON 一致。`)
    process.exit(0)
  }
  if (!write) {
    console.error('[i18n] client 标记块与 locale JSON 不一致；运行 node scripts/i18n-check.mjs --write 重生成。')
    process.exit(1)
  }
  fs.writeFileSync(CLIENT, clientText.slice(0, start) + expected + clientText.slice(end + MARK_END.length))
  console.log(`[i18n] 已重生成 client 标记块（三语各 ${zhKeys.size} 键）。`)
  process.exit(0)
}

if (start >= 0 || end >= 0) {
  console.error('[i18n] 标记块只出现了一半，请人工修复后再运行。')
  process.exit(1)
}

// 兼容首次迁移：还没有标记块时，--write 可把旧的 `const dict = {...}` 整体替换掉。
if (!write) {
  console.error('[i18n] lib/client.js 缺少 locale:generated 标记块。')
  process.exit(1)
}
const legacyStart = clientText.indexOf('    const dict = ')
const legacyEnd = clientText.indexOf('\n    }\n\n    // ---------------------------------------------------------------- runtime', legacyStart)
if (legacyStart < 0 || legacyEnd < 0) {
  console.error('[i18n] 找不到旧的 const dict 块，无法 --write。')
  process.exit(1)
}
fs.writeFileSync(
  CLIENT,
  clientText.slice(0, legacyStart) + expected + clientText.slice(legacyEnd + '\n    }'.length),
)
console.log(`[i18n] 已用标记块替换旧 dict（三语各 ${zhKeys.size} 键）。`)
