#!/usr/bin/env node
/**
 * 一次性源拆分器：把 lib/client.js 按 AST 顶层语句边界切成 lib/client-src/ 文本片段。
 *
 * 为什么不用 bundler：DSH 客户端只加载单文件 bundle，片段是同一 factory 作用域内的
 * 文本，构建只需按 MANIFEST 逐字节拼接。本脚本是“源→产物”单向链路的第一步，
 * 首跑必须把产物字节 100% 还原；不插注释、不格式化、不丢一个空格。
 *
 * 边界规则：
 * - 语句切点用 acorn AST 取 factory 函数体顶层声明/语句；UTF-16 字符索引 → src.slice → Buffer.from。
 * - 切点落在语句所在行的行首；行内缩进归后一片，语句后的空行/注释归前一片。
 * - 生成块（locale/manual）按生成器标记识别为不透明整片，不参与 AST 切分。
 *
 * 用法：
 *   node scripts/split-client.mjs                 # 默认 --dry-run：只打印切点表
 *   node scripts/split-client.mjs --dry-run
 *   node scripts/split-client.mjs --write         # 落盘片段 + MANIFEST.json
 *   node scripts/split-client.mjs --opaque locale,manual --loader window.__ModuleLoader__.load --factory-path factory
 *
 * 依赖方向：scripts → acorn（devDependency，钉死 8.14.0）；不 import 业务代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'lib/client.js')
const SRC_DIR = path.join(ROOT, 'lib/client-src')
const ACORN_EXPECTED = '8.14.0'

const argv = process.argv.slice(2)
const KNOWN = new Set(['write', 'dry-run', 'opaque', 'loader', 'factory-path'])
const options = {}
const bare = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    bare.push(arg)
    continue
  }
  const eq = arg.indexOf('=')
  if (eq > 0) {
    options[arg.slice(2, eq)] = arg.slice(eq + 1)
    continue
  }
  const next = argv[i + 1]
  if (next !== undefined && !next.startsWith('--')) {
    options[arg.slice(2)] = next
    i += 1
  } else {
    options[arg.slice(2)] = true
  }
}
const unknown = [...Object.keys(options).filter((k) => !KNOWN.has(k)), ...bare]
if (unknown.length) {
  console.error(`[split] 未知参数：${unknown.join(' ')}`)
  process.exit(2)
}
const write = options.write === true
const dryRun = options['dry-run'] === true || !write
const opaque = new Set(String(options.opaque || 'locale,manual').split(',').map((x) => x.trim()).filter(Boolean))
for (const name of opaque) {
  if (!['locale', 'manual'].includes(name)) {
    console.error(`[split] --opaque 只支持 locale,manual，实际：${name}`)
    process.exit(2)
  }
}
const loaderPath = String(options.loader || 'window.__ModuleLoader__.load')
const factoryPath = String(options['factory-path'] || 'factory')

if (acorn.version !== ACORN_EXPECTED) {
  console.error(`[split] acorn 版本不符：期望 ${ACORN_EXPECTED}，实际 ${acorn.version}（钉死依赖，防解析行为漂移）`)
  process.exit(1)
}

const src = fs.readFileSync(SOURCE, 'utf8')
const original = fs.readFileSync(SOURCE)

/** 语句所在行的行首偏移；行首到语句之间必须只有空白。 */
function lineStartOf(pos) {
  const i = src.lastIndexOf('\n', pos - 1)
  const start = i < 0 ? 0 : i + 1
  if (src.slice(start, pos).trim() !== '') return pos
  return start
}

function lineOf(pos) {
  return src.slice(0, pos).split('\n').length
}

let ast
try {
  ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })
} catch (err) {
  console.error(`[split] 源文件 acorn 解析失败：${err.message}`)
  process.exit(1)
}

const call = ast.body.find((node) => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression')
if (!call) {
  console.error('[split] 找不到 `window.__ModuleLoader__.load({...})` 顶层调用')
  process.exit(1)
}
const calleeText = src.slice(call.expression.callee.start, call.expression.callee.end)
if (calleeText !== loaderPath) {
  console.error(`[split] loader 不匹配：期望 ${loaderPath}，实际 ${calleeText}`)
  process.exit(1)
}
const argObj = call.expression.arguments[0]
if (!argObj || argObj.type !== 'ObjectExpression') {
  console.error('[split] load() 第一个实参不是对象字面量')
  process.exit(1)
}
const factoryProp = argObj.properties.find((p) => (p.key.name || p.key.value) === factoryPath)
if (!factoryProp) {
  console.error(`[split] 对象里找不到 ${factoryPath}（期望 FunctionExpression）`)
  process.exit(1)
}
const factory = factoryProp.value
if (factory.type !== 'FunctionExpression' && factory.type !== 'ArrowFunctionExpression') {
  console.error(`[split] factory 节点类型不支持：${factory.type}`)
  process.exit(1)
}
const body = factory.body.type === 'BlockStatement' ? factory.body.body : null
if (!body) {
  console.error('[split] factory 不是块体函数，无法按语句切分')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 生成块（不透明整片）：只认生成器标记；marker 缺失/只出现一半立即停。
// ---------------------------------------------------------------------------
const MARKS = {
  locale: ['// >>> locale:generated', '// <<< locale:generated'],
  manual: ['// >>> manual:generated', '// <<< manual:generated'],
}
const RUNTIME_COMMENT = '// ---------------------------------------------------------------- runtime'
const runtimeStart = src.indexOf(RUNTIME_COMMENT)
if (runtimeStart < 0) {
  console.error('[split] 找不到 runtime 分节注释（生成块之后的第一处非生成内容边界）')
  process.exit(1)
}
function opaqueRange(name) {
  const [startMark, endMark] = MARKS[name]
  const s = src.indexOf(startMark)
  const e = src.indexOf(endMark)
  if (s < 0 || e < 0 || e < s) {
    console.error(`[split] ${name} 生成块标记缺失或不完整（start=${s} end=${e}）`)
    process.exit(1)
  }
  return { from: lineStartOf(s), end: e + endMark.length }
}
const localeRange = opaque ? opaqueRange('locale') : null
const manualRange = opaque ? opaqueRange('manual') : null

// 生成块边界必须按出现顺序；生成块之间不得夹业务语句。
if (localeRange && manualRange && localeRange.end > manualRange.from) {
  console.error('[split] locale/manual 生成块顺序异常')
  process.exit(1)
}
if (localeRange && manualRange) {
  const tailStart = src.lastIndexOf('\n', localeRange.end)
  if (!/^\s*$/.test(src.slice(tailStart < 0 ? localeRange.end : tailStart, manualRange.from))) {
    console.error('[split] locale 与 manual 生成块之间夹了业务内容；拒绝切分')
    process.exit(1)
  }
}

/**
 * 片段计划：语句序数为 factory 函数体 1-based 序号。
 * from/to 都是闭区间；to=null 表示直到 EOF。
 */
const PLAN = [
  { file: '00-core.js', responsibility: '客户端前缀：文件头注释 + __ModuleLoader__.load(id) + factory 头与顶层常量（React/h/NS/PANEL_ID/TABS 等）', prefix: true, boundary: '文件头' },
  ...(opaque.has('locale') ? [{ file: 'generated/locale.js', responsibility: '生成块：locale 三语字典（scripts/i18n-check.mjs --write 生成，勿手改）', generated: 'locale' }] : []),
  ...(opaque.has('manual') ? [{ file: 'generated/manual.js', responsibility: '生成块：离线说明书（scripts/manual-build.mjs 生成，勿手改）', generated: 'manual' }] : []),
  // 10-format 起点不是语句行首，而是生成块之后的 `// ---- runtime` 分节 banner 行首：
  // banner 属于 runtime 段，不能被装进生成块；这是唯一一处非语句行首的业务切点。
  { file: '10-format.js', responsibility: '运行时 hook（locale/可见性）+ 格式化与观测 helper（状态码/日期/指标）', from: 13, to: 48, banner: true },
  { file: '20-ui-kit.js', responsibility: '通用 UI 原子：Card/Switch/输入/字段/滚动/焦点/图标/简易 Markdown', from: 49, to: 75 },
  { file: '30-panel.js', responsibility: '面板壳：页头、页签导航、弹层与公共事件', from: 76, to: 76 },
  { file: '50-overview.js', responsibility: '概览页：KPI、趋势、失败作业、收尾卡', from: 77, to: 77 },
  { file: '60-memory.js', responsibility: '记忆库页：检索、表格、新增表单、详情抽屉', from: 78, to: 82 },
  { file: '70-rules-01.js', responsibility: '规则页 helper 第 1 段：Git 状态/列表筛选/摘要/字段文本/版本 diff', from: 83, to: 110 },
  { file: '70-rules-02.js', responsibility: '规则页 helper 第 2 段：编辑/校验/提案决策与草稿', from: 111, to: 139 },
  { file: '70-rules-03.js', responsibility: '规则页 UI 第 1 段：规则视图与提案徽标/风险/编辑器', from: 140, to: 150 },
  { file: '70-rules-04.js', responsibility: '规则页 UI 第 2 段：规则表/空态/Git 指南/新建弹层', from: 151, to: 161 },
  { file: '70-rules-05.js', responsibility: '规则页 UI 第 3 段：编辑弹层与详情抽屉', from: 162, to: 163 },
  { file: '80-recall.js', responsibility: '召回页：命中解释与召回记录', from: 164, to: 165 },
  { file: '90-writes.js', responsibility: '写入与关系页：审计流水、候选审核、边统计', from: 166, to: 166 },
  { file: '95-settings-01.js', responsibility: '设置元数据与配置归一第 1 段', from: 167, to: 183 },
  { file: '95-settings-02.js', responsibility: '设置页第 2 段：问题提示、分组卡、设置页主体', from: 184, to: 186 },
  { file: '99-css.js', responsibility: '全局样式对象（整片，不拆 CSS）', from: 187, to: 187 },
  { file: '999-footer.js', responsibility: 'factory 收尾：导出/注册页签/return 与闭合', from: 188, to: null },
]

/** 把语句序数换算成字节计划（UTF-16 偏移）。 */
function offsetFor(entry, side) {
  if (entry.from === 13 && side === 'from') return lineStartOf(runtimeStart)
  if (side === 'from') {
    const node = body[entry.from - 1]
    if (!node) throw new Error(`语句序数越界：${entry.from}`)
    return lineStartOf(node.start)
  }
  if (entry.to === null) return src.length
  const node = body[entry.to] // to 之后的下一条语句，作为开区间终点
  if (!node) throw new Error(`语句序数越界：${entry.to}`)
  return lineStartOf(node.start)
}

// 生成块片段的终点由下一片起点决定：
// locale → manual 起点；manual → runtime 起点。这样空行归生成片，生成器 --write 原样保留。
const ranges = []
let prev = 0
for (const entry of PLAN) {
  let from
  let to
  if (entry.prefix) {
    from = 0
    to = localeRange ? localeRange.from : manualRange ? manualRange.from : lineStartOf(runtimeStart)
  } else if (entry.generated === 'locale') {
    from = localeRange.from
    to = manualRange ? manualRange.from : lineStartOf(runtimeStart)
  } else if (entry.generated === 'manual') {
    from = manualRange.from
    to = lineStartOf(runtimeStart)
  } else {
    from = offsetFor(entry, 'from')
    to = offsetFor(entry, 'to')
  }
  if (from !== prev) {
    console.error(`[split] 片段不连续：${entry.file} 起点 ${from}，上一片结束 ${prev}`)
    process.exit(1)
  }
  ranges.push({ ...entry, from, to })
  prev = to
}
if (prev !== src.length) {
  console.error(`[split] 片段未覆盖到 EOF：最后结束 ${prev}，文件长度 ${src.length}`)
  process.exit(1)
}

// 字节重建闸：任何边界错误都在这里暴露，绝不写盘。
const fragments = ranges.map((r) => ({ ...r, text: src.slice(r.from, r.to) }))
const rebuilt = Buffer.concat(fragments.map((f) => Buffer.from(f.text, 'utf8')))
if (Buffer.compare(rebuilt, original) !== 0) {
  console.error('[split] 内存重建与源文件不是逐字节相等，拒绝继续（先修边界/编码，不许逻辑等价放行）')
  process.exit(1)
}
const rebuiltSha = crypto.createHash('sha256').update(rebuilt).digest('hex')
const sourceSha = crypto.createHash('sha256').update(original).digest('hex')

/** 有效行口径与 lint-size 一致：非空、非纯注释、非块注释内。 */
function effectiveLines(text) {
  let n = 0
  let inBlock = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
      continue
    }
    if (!t || t.startsWith('//')) continue
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      continue
    }
    n += 1
  }
  return n
}

const truncate = (text) => {
  const first = text.split('\n')[0]
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

console.log(`[split] acorn ${acorn.version} · factory 语句 ${body.length} 条 · 片段 ${fragments.length} 片`)
console.log('片段 | UTF-16 范围 | 字节 | 行数 | 有效行 | 首行 | 边界')
for (const f of fragments) {
  const bytes = Buffer.byteLength(f.text, 'utf8')
  const lines = f.text.split('\n').length
  const eff = effectiveLines(f.text)
  const flag = lines > 1200 ? ' ⚠子切候选' : ''
  console.log(`${f.file} | ${f.from}-${f.to} | ${bytes} | ${lines} | ${eff} | ${JSON.stringify(truncate(f.text))} | ${f.generated ? '生成块整片' : f.boundary || 'AST 顶层语句行首'}${flag}`)
}
console.log(`[split] 重建 sha256 ${rebuiltSha}（源 ${sourceSha}）`)
const shaFile = path.join(ROOT, 'scripts/baseline/client.sha256.p1')
if (fs.existsSync(shaFile)) {
  const baselineSha = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]
  console.log(`[split] 基线 sha256 ${baselineSha} · ${baselineSha === rebuiltSha ? '一致' : '不一致（禁止落盘）'}`)
  if (baselineSha !== rebuiltSha) process.exit(1)
}
const first = fragments[0].text
const last = fragments[fragments.length - 1].text
console.log(`[split] 00-core 头 200 字符：${JSON.stringify(first.slice(0, 200))}`)
console.log(`[split] 999-footer 尾 200 字符：${JSON.stringify(last.slice(-200))}`)

if (dryRun) {
  console.log('[split] dry-run：未创建/覆盖任何 lib/client-src 文件；人工确认切点后再 --write')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 落盘：片段 + MANIFEST（构建唯一真源）。不写 lib/client.js（由 build-client 负责）。
// ---------------------------------------------------------------------------
const manifest = ranges.map((r) => ({ file: r.file, responsibility: r.responsibility }))
fs.mkdirSync(path.join(SRC_DIR, 'generated'), { recursive: true })
for (const f of fragments) {
  const target = path.join(SRC_DIR, f.file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(f.text, 'utf8'))
}
fs.writeFileSync(path.join(SRC_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[split] 已写 ${fragments.length} 片 + MANIFEST.json 到 lib/client-src/`)
