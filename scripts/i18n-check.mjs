#!/usr/bin/env node
/**
 * i18n 校验/生成：locale/{zh,en,ja}.json 是唯一真源，lib/client.js 只保留由它生成的常量块。
 *
 * 用法：
 *   node scripts/i18n-check.mjs          # 默认 --check：三语键集/占位符一致 + ja 质量门禁 + 标记块与 JSON 一致
 *   node scripts/i18n-check.mjs --check  # 同上
 *   node scripts/i18n-check.mjs --write  # 从 JSON 重生成 client 标记块
 *
 * 校验顺序（任一项失败即 exit 1；③–⑤ 逐条打印可定位的键名，最多 12 个 + 总数）：
 *   ① 三语键集完全一致；
 *   ② 同一键的 {name} 占位符集合三语一致；
 *   ③ ja 不许照抄 en：人类文案值中 ja≡en 的比例 < 5%；
 *   ④ ja 必须真的写成日语：人类文案值中含假名的比例 > 90%；
 *   ⑤ 三语 meta.detail 都是仓库内存在的本语言相对路径（docs/DETAIL.<lang>.md）；
 *   ⑥ client 标记块与 locale JSON 逐字一致（`--write` 重生成）。
 * 「人类文案值」的口径、阈值、排除项都写成本文件的常量与注释（见 isHumanCopy 处），
 * 不在报告或文档里写会漂移的过程数字。
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

// ---------------------------------------------------------------------------
// 「人类文案值」口径（ja 质量门禁的唯一集合定义，必须可复现）
// ---------------------------------------------------------------------------
/**
 * 一个键的值算「人类文案值」当且仅当全部满足：
 *   1. 是字符串（数字 / null / 对象一律不算）；
 *   2. trim 后非空；
 *   3. 含至少一个文字字符——拉丁字母、假名或汉字（`TEXT_RE`），纯数字 / 纯符号如 "—" 不算；
 *   4. 不形如 URL / 仓库内相对路径 / 绝对路径（`NON_COPY_RE`），例如 "docs/DETAIL.en.md"、"/stats"；
 *   5. 不是纯占位符（`PLACEHOLDER_ONLY_RE`），例如 "{total}"；
 *   6. 键名不在 `EXCLUDED_KEYS`——文件路径型值（meta.detail）即使换成看不出路径的形状也一律排除。
 *
 * 集合以 en 为基准（en 是母版文案的来源），对三语同一键使用同一判定。新增键若确实是
 * 品牌 / 命令 / 纯技术 token，只要在 en 里也属于上述 1–6 之外的形状，就不会进集合；
 * 反之进了集合就必须是「人话」，ja 侧要靠翻译而不是照抄来满足门禁。
 */
const TEXT_RE = /[A-Za-z\u3041-\u3096\u30A1-\u30F6\u30FC\u4E00-\u9FFF]/
const KANA_RE = /[\u3041-\u3096\u30A1-\u30F6\u30FC]/
const NON_COPY_RE = [
  /^https?:\/\//i, // URL
  /^(?:[\w.-]+\/)+[\w.-]+\.\w{1,8}$/, // 相对路径：docs/DETAIL.en.md
  /^\/[\w./-]*$/, // 绝对路径 / API 路径：/stats、/rules/health
]
const PLACEHOLDER_ONLY_RE = /^(?:\{[A-Za-z0-9_]+\}\s*)+$/
const EXCLUDED_KEYS = new Set(['meta.detail'])

/** 见上方口径注释：判定一个键值是否属于「人类文案值」。 */
function isHumanCopy(key, value) {
  if (EXCLUDED_KEYS.has(key)) return false
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '') return false
  if (!TEXT_RE.test(text)) return false
  if (PLACEHOLDER_ONLY_RE.test(text)) return false
  if (NON_COPY_RE.some((re) => re.test(text))) return false
  return true
}

/** 门禁阈值：固定常量，不放过程数字。ja≡en 必须严格小于上限，假名覆盖必须严格高于下限。 */
const JA_EN_IDENTICAL_MAX_RATE = 0.05
const JA_KANA_MIN_COVERAGE = 0.9
/** 失败时每个指标最多列出的键名数量（其余只报总数）。 */
const PROBLEM_KEY_LIMIT = 12

const humanKeys = Object.keys(dicts.en).filter((key) => isHumanCopy(key, dicts.en[key]))
const jaIdentical = humanKeys.filter((key) => dicts.ja[key] === dicts.en[key])
const jaNoKana = humanKeys.filter((key) => !KANA_RE.test(String(dicts.ja[key])))
const identicalRate = jaIdentical.length / humanKeys.length
const kanaCoverage = (humanKeys.length - jaNoKana.length) / humanKeys.length
const pct = (value) => `${(value * 100).toFixed(2)}%`
const keyList = (keys) => `${keys.slice(0, PROBLEM_KEY_LIMIT).join(', ')}${keys.length > PROBLEM_KEY_LIMIT ? ' …' : ''}`

// ③ ja 不许照抄 en：人类文案值里 ja 与 en 完全相同的比例必须 < 5%。
if (identicalRate >= JA_EN_IDENTICAL_MAX_RATE) {
  problems.push(
    `ja 与 en 完全相同的文案 ${jaIdentical.length}/${humanKeys.length}（${pct(identicalRate)}），阈值 <${pct(JA_EN_IDENTICAL_MAX_RATE)}；` +
      `应为日语：${keyList(jaIdentical)}`,
  )
}

// ④ ja 必须真的写成日语：人类文案值里含至少一个假名的比例必须 > 90%。
if (kanaCoverage <= JA_KANA_MIN_COVERAGE) {
  problems.push(
    `ja 含假名的文案 ${humanKeys.length - jaNoKana.length}/${humanKeys.length}（${pct(kanaCoverage)}），阈值 >${pct(JA_KANA_MIN_COVERAGE)}；` +
      `不含假名：${keyList(jaNoKana)}`,
  )
}

// ⑤ meta.detail 必须是仓库内真实存在的相对路径，且文件名对应本语言（防止 ja 指到英文页）。
for (const lang of LANGS) {
  const key = 'meta.detail'
  const target = dicts[lang][key]
  if (typeof target !== 'string' || target.trim() === '') {
    problems.push(`${key}（${lang}）必须是仓库内的相对路径，实际为 ${JSON.stringify(target)}`)
    continue
  }
  const detailRe = new RegExp(`(^|/)DETAIL\\.${lang}\\.md$`)
  if (path.isAbsolute(target) || target.includes('..') || !detailRe.test(target)) {
    problems.push(`${key}（${lang}）必须指向本语言的 docs/DETAIL.${lang}.md 相对路径，实际为 ${target}`)
    continue
  }
  if (!fs.existsSync(path.join(ROOT, target)) || !fs.statSync(path.join(ROOT, target)).isFile()) {
    problems.push(`${key}（${lang}）指向的文件不存在：${target}`)
  }
}

if (problems.length > 0) {
  console.error('[i18n] 校验失败：')
  for (const line of problems) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(
  `[i18n] ja 质量：ja≡en ${jaIdentical.length}/${humanKeys.length}（${pct(identicalRate)} < ${pct(JA_EN_IDENTICAL_MAX_RATE)}），` +
    `假名覆盖 ${humanKeys.length - jaNoKana.length}/${humanKeys.length}（${pct(kanaCoverage)} > ${pct(JA_KANA_MIN_COVERAGE)}）。`,
)

/** 客户端标记块期望内容（与 --write 生成结果逐字一致）。 */
function expectedBlock() {
  // 生成块是构建产物，不是人读源码：紧凑 JSON 避免 2.7k 行数据淹没 client.js 的真实逻辑。
  const json = JSON.stringify(dicts)
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
