#!/usr/bin/env node
/**
 * 上架静态门：E1–E15（计划书 §6 + R9-06 错误码单一真源）+ 禁区扫描 + waterfall 守卫。
 *
 * 为什么要有这一份：市场安装失败大多不是功能问题，而是 manifest/导出/文件清单/
 * 文档产物这类机械问题；这里把可机检的部分前置，让每次改动当场红，而不是到 S5
 * 才发现。判据以计划书 §6 为准，能静态检查的就不放过；缺文件就真红，不用占位文件
 * 把门刷绿。
 *
 * 用法：node scripts/check.mjs   失败项逐条打印 `[gate] EXx FAIL: 原因`，退出码 1。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const rel = (p) => p.slice(root.length + 1)

let failed = 0
const report = (id, reasons) => {
  console.error(`[gate] ${id} FAIL: ${reasons.join('；')}`)
  failed += 1
}

const read = (p) => readFileSync(join(root, p), 'utf8')
/** locale JSON 的嵌套结构平铺成客户端 t() 用的点号键（meta.title 等）。 */
function flattenLocale(node, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(node || {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flattenLocale(value, dotted))
    else out[dotted] = value
  }
  return out
}
const isFile = (p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile()
const isDir = (p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory()
const isNonEmptyDir = (p) => isDir(p) && readdirSync(join(root, p)).some((x) => x !== '.gitkeep')

/** 一个 gate = 一个 E 项；返回原因数组（空数组=通过）。抛错也算失败。 */
const gates = []
const gate = (id, fn) => gates.push([id, fn])

// ---------------------------------------------------------------------------
// 公共解析
// ---------------------------------------------------------------------------

const patchRel = pkg.dsh?.bundle?.patch
const patchText = patchRel && isFile(patchRel) ? read(patchRel) : ''
const insertLineIdx = patchText.split('\n').findIndex((l) => /^-\s+insert:/.test(l))
const insertRows = []
if (insertLineIdx >= 0) {
  const lines = patchText.split('\n').slice(insertLineIdx + 1)
  let row = {}
  for (const line of lines) {
    if (/^-\s/.test(line)) break
    const m = line.match(/^\s+(?:-\s+)?(id|name):\s*(.+?)\s*$/)
    if (m) row[m[1]] = m[2]
  }
  insertRows.push(row)
}
const patchKeyValues = {
  id: [...patchText.matchAll(/^\s+(?:-\s+)?id:\s*(.+?)\s*$/gm)].map((m) => m[1]),
  name: [...patchText.matchAll(/^\s+(?:-\s+)?name:\s*(.+?)\s*$/gm)].map((m) => m[1]),
}

/** exports 目标里允许 `*` 通配：目录存在且至少一个文件匹配末段。 */
function targetExists(target) {
  const t = String(target || '')
  if (!t || t.startsWith('/') || t.includes('..')) return false
  if (!t.includes('*')) return existsSync(join(root, t))
  const parts = t.split('/')
  const last = parts.pop()
  const dir = join(root, parts.join('/'))
  if (!isDir(parts.join('/'))) return false
  const re = new RegExp(
    '^' + last.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$',
  )
  return readdirSync(dir).some((f) => re.test(f))
}

/** 目录 / 文件条目的内容非空判定（`docs` 空目录也算空）。 */
function entryNonEmpty(entry) {
  if (entry.includes('*')) return targetExists(entry)
  const full = join(root, entry)
  if (!existsSync(full)) return false
  if (statSync(full).isDirectory()) return readdirSync(full).some((x) => x !== '.gitkeep')
  return statSync(full).size > 0
}

// ---------------------------------------------------------------------------
// E1 name/version/private
// ---------------------------------------------------------------------------
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

gate('E1', () => {
  const r = []
  if (!pkg.name || !/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) r.push('name 缺失/非法（须为 npm 包名）')
  if (!SEMVER.test(String(pkg.version || ''))) r.push(`version 不是精确 SemVer：${pkg.version}`)
  if (pkg.private === true) r.push('不得 private:true（开源包会被市场拒收）')
  return r
})

// ---------------------------------------------------------------------------
// E2 exports 齐全
// ---------------------------------------------------------------------------
const REQUIRED_EXPORTS = ['.', './client', './locale/*.json', './icon', './package.json']

gate('E2', () => {
  const r = []
  const exports = pkg.exports || {}
  for (const key of REQUIRED_EXPORTS) {
    if (!(key in exports)) r.push(`exports 缺 ${key}`)
  }
  for (const [key, target] of Object.entries(exports)) {
    if (!targetExists(target)) r.push(`exports ${key} -> ${target} 不存在/通配无匹配`)
  }
  return r
})

// ---------------------------------------------------------------------------
// E3 bundle patch：恰好 1 个 insert，id/name 齐且唯一
// ---------------------------------------------------------------------------
gate('E3', () => {
  const r = []
  if (!patchRel) return ['dsh.bundle.patch 未声明']
  if (!isFile(patchRel)) return [`bundle patch 不存在：${patchRel}`]
  const inserts = patchText.split('\n').filter((l) => /^-\s+insert:/.test(l)).length
  if (inserts !== 1) r.push(`patch 必须恰好 1 个 insert，实际 ${inserts}`)
  const row = insertRows[0] || {}
  if (!row.id) r.push('insert 行缺 id')
  if (!row.name) r.push('insert 行缺 name')
  if (row.name && row.name !== pkg.name) r.push(`insert name=${row.name} 与包名 ${pkg.name} 不一致`)
  for (const key of ['id', 'name']) {
    const vals = patchKeyValues[key]
    if (new Set(vals).size !== vals.length) r.push(`patch 内 ${key} 重复：${vals.join(', ')}`)
  }
  return r
})

// ---------------------------------------------------------------------------
// E4 dsh.client：platform/immediately/inject
// ---------------------------------------------------------------------------
gate('E4', () => {
  const r = []
  const client = pkg.dsh?.client || {}
  if (client.platform !== 'web') r.push(`dsh.client.platform 必须为 "web"，实际 ${JSON.stringify(client.platform)}`)
  if (client.immediately !== true) r.push('dsh.client.immediately 必须为 true（首开快）')
  if (!Array.isArray(client.inject) || client.inject.length === 0) {
    r.push('dsh.client.inject 必须为非空数组')
  } else {
    for (const row of client.inject) {
      if (typeof row !== 'string' || !/^@deepseek-ai\/dsh-client-[a-z0-9-]+$/.test(row)) {
        r.push(`inject 只能写宿主 Client 行名，非法项：${JSON.stringify(row)}`)
      }
    }
  }
  return r
})

// ---------------------------------------------------------------------------
// E5 engines
// ---------------------------------------------------------------------------
gate('E5', () => {
  const r = []
  const dsh = String(pkg.engines?.dsh || '')
  if (!dsh) r.push('engines.dsh 必填')
  if (dsh.includes('workspace:')) r.push('engines.dsh 禁止 workspace:')
  if (dsh && !/^>=\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+<\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dsh)) {
    r.push(`engines.dsh 必须是 ">=x.y.z <x.y.z-0" 形式，实际 ${dsh}`)
  }
  const node = String(pkg.engines?.node || '')
  const m = node.match(/^>=\s*(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) r.push(`engines.node 缺失/非法：${node}`)
  else if (Number(m[1]) < 22 || (Number(m[1]) === 22 && Number(m[2]) < 5)) {
    r.push(`engines.node 必须 >=22.5（node:sqlite），实际 ${node}`)
  }
  return r
})

// ---------------------------------------------------------------------------
// E6 Client 产物
// ---------------------------------------------------------------------------
gate('E6', () => {
  const r = []
  if (!isFile('lib/client.js')) return ['lib/client.js（构建产物）不存在']
  const src = read('lib/client.js')
  const load = src.match(/__ModuleLoader__\.load\(\s*\{[\s\S]{0,300}?id:\s*['"]([^'"]+)['"]/)
  if (!load) r.push('lib/client.js 缺 window.__ModuleLoader__.load({id: ...}) 标记')
  else if (load[1] !== pkg.name) r.push(`Client module id=${load[1]} 与包名 ${pkg.name} 不一致`)
  if (/\bfrom\s+['"]@deepseek-ai\/dsh-client/.test(src) || /\brequire\(\s*['"]@deepseek-ai\/dsh-client/.test(src)) {
    r.push('Client 产物不得 import 宿主 Client 包（走 require/factory 与事件契约）')
  }
  if (/<iframe/i.test(src) || /createElement\(\s*['"]iframe/i.test(src)) r.push('Client 产物不得使用 iframe')
  return r
})

// ---------------------------------------------------------------------------
// E7 Config：空对象通过 + volatile 解包 + 无密钥
// ---------------------------------------------------------------------------
gate('E7', async () => {
  const r = []
  const configPath = 'src/host/config.js'
  if (!isFile(configPath)) return ['src/host/config.js 不存在']
  const src = read(configPath)
  if (!/export\s+const\s+Config\s*=\s*z\.object\(/.test(src)) r.push('Config 不是 z.object(...) schema')

  // 空配置能通过：每个顶层分组都有 .default({})，每个 volatile 叶子都有 .default(...)
  const groups = [...src.matchAll(/^\s{2}([a-zA-Z]\w*):\s*z\.object\(\{/gm)]
  for (const [, name] of groups) {
    const block = src.slice(src.indexOf(`\n  ${name}: z.object({`))
    const end = block.indexOf('\n  }).default({})')
    if (end < 0) r.push(`分组 ${name} 缺 .default({})，空配置无法通过校验`)
  }
  const volatileLines = src.split('\n').filter((l) => l.includes('.volatile()'))
  if (volatileLines.length === 0) r.push('Config 无 volatile 字段（面板即时回显依赖 volatile）')
  for (const line of volatileLines) {
    if (!line.includes('.default(')) r.push(`volatile 字段缺默认值：${line.trim()}`)
  }

  // volatile 是 Ref：必须经 config-values 的 .get() 解包，且不得在别处再声明 volatile
  const helperPath = 'src/shared/config-values.js'
  if (!isFile(helperPath)) r.push('缺 src/shared/config-values.js（Ref 解包单一真源）')
  else {
    const helper = read(helperPath)
    if (!/\.get\s*\(\s*\)/.test(helper)) r.push('config-values.js 必须用 .get() 解包 volatile Ref')
    if (!/export\s+function\s+(value|bool|num)\b/.test(helper)) r.push('config-values.js 缺 value/bool/num 解包函数')
  }
  for (const file of walk('src')) {
    if (file === join(root, configPath)) continue
    // 只扫代码，注释里解释 `.volatile()` 是 Ref 属正当文档。
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '')
      .replace(/\/\/.*$/gm, '')
    if (code.includes('.volatile(')) r.push(`${rel(file)} 不得再声明 .volatile()（只在 config.js）`)
  }
  if (/(apiKey|api_key|secret|password|passwd|token)\s*:/i.test(src)) {
    r.push('Config schema 出现密钥类字段（密钥必须走 credentials，不进 Config）')
  }

  // 有依赖时做一次真校验：空配置必须可解析，volatile 叶子必须是 Ref
  let mod
  try {
    mod = await import(pathToFileURL(join(root, configPath)).href)
  } catch (err) {
    console.error(`[gate] E7 note: 跳过运行时校验（依赖不可用：${err.code || err.message}）`)
    return r
  }
  try {
    const out = mod.Config({})
    for (const [, name] of groups) if (!out || !out[name]) r.push(`Config({}) 解析结果缺分组 ${name}`)
    if (typeof out?.identity?.mode?.get !== 'function') r.push('Config({}) 的 volatile 叶子不是 Ref（.get() 缺失）')
  } catch (err) {
    r.push(`Config({}) 空配置未通过校验：${err.message}`)
  }
  return r
})

// ---------------------------------------------------------------------------
// E8 locale en/zh meta
// ---------------------------------------------------------------------------
gate('E8', () => {
  const r = []
  for (const lang of ['en', 'zh']) {
    const p = `locale/${lang}.json`
    if (!isFile(p)) { r.push(`${p} 不存在`); continue }
    let locale
    try { locale = JSON.parse(read(p)) } catch (err) { r.push(`${p} 不是合法 JSON：${err.message}`); continue }
    const meta = locale?.meta || {}
    for (const key of ['title', 'description']) {
      if (typeof meta[key] !== 'string' || meta[key].trim() === '') r.push(`${p} meta.${key} 缺失/空`)
    }
    if (meta.detail !== undefined) {
      if (typeof meta.detail !== 'string' || meta.detail.trim() === '') r.push(`${p} meta.detail 声明了但不是非空字符串`)
      else if (!isFile(meta.detail)) r.push(`${p} meta.detail 指向的文件不存在：${meta.detail}`)
    }
  }
  return r
})

// ---------------------------------------------------------------------------
// E9 docs/DETAIL.md + preview.svg
// ---------------------------------------------------------------------------
/** 单份详情文档：首行特性图 + 包内 SVG 安全/尺寸检查；返回问题列表。 */
function detailProblems(detail) {
  const r = []
  if (!isFile(detail)) return [`${detail} 不存在（详情页必需）`]
  const md = read(detail)
  const imgs = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)]
  if (imgs.length !== 1) r.push(`${detail} 必须恰好一行图，实际 ${imgs.length} 处图片引用`)
  const target = imgs[0]?.[1]
  if (!target) return r
  if (/^(https?:)?\/\//i.test(target) || target.startsWith('/')) r.push(`${detail} 图片必须是包内相对路径，实际 ${target}`)
  const svgPath = join('docs', target)
  if (!target.startsWith('docs/') && !isFile(svgPath)) return [...r, `${svgPath} 不存在`]
  const svgRel = target.startsWith('docs/') ? target : svgPath
  if (!isFile(svgRel)) return [...r, `${svgRel} 不存在`]
  const svg = read(svgRel)
  const vb = svg.match(/\bviewBox\s*=\s*['"]([^'"]+)['"]/)
  const width = svg.match(/\bwidth\s*=\s*['"]([\d.]+)(?:px)?['"]/)
  const height = svg.match(/\bheight\s*=\s*['"]([\d.]+)(?:px)?['"]/)
  if (!vb) r.push(`${svgRel} 缺 viewBox`)
  else {
    const nums = vb[1].trim().split(/[\s,]+/).map(Number)
    if (nums.length !== 4 || nums[2] !== 640 || nums[3] !== 300) r.push(`${svgRel} viewBox 必须是 0 0 640 300，实际 ${vb[1]}`)
  }
  if (width && width[1] !== '640') r.push(`${svgRel} width=${width[1]}，应为 640`)
  if (height && height[1] !== '300') r.push(`${svgRel} height=${height[1]}，应为 300`)
  if (/<text[\s>]/.test(svg)) r.push(`${svgRel} 含 <text>（详情图必须无字）`)
  if (/foreignObject/i.test(svg)) r.push(`${svgRel} 含 foreignObject`)
  if (/<script[\s>]/i.test(svg)) r.push(`${svgRel} 含 <script>`)
  if (/<(?:animate|animateTransform|animateMotion|set)[\s>]/.test(svg)) r.push(`${svgRel} 含动画元素（详情图禁动画）`)
  const noNs = svg.replace(/xmlns(?::\w+)?\s*=\s*['"][^'"]+['"]/g, '')
  if (/(?:href|src)\s*=\s*['"](?:https?:)?\/\//i.test(noNs)) r.push(`${svgRel} 含外链资源`)
  return r
}

gate('E9', () => {
  const r = []
  const files = pkg.files || []
  for (const detail of ['docs/DETAIL.en.md', 'docs/DETAIL.zh.md']) r.push(...detailProblems(detail))
  for (const need of REQUIRED_FILES) if (!files.includes(need)) r.push(`files 必含 ${need}`)
  for (const need of REQUIRED_DOC_FILES) {
    if (!files.includes('docs') && !files.includes(need)) r.push(`files 必含 ${need}（或整目录 docs）`)
  }
  for (const banned of BANNED_FILES) if (files.includes(banned)) r.push(`files 不得含 ${banned}`)
  for (const entry of files) {
    if (entry.startsWith('/') || entry.includes('..')) r.push(`files 条目必须是包内相对路径：${entry}`)
    else if (!entryNonEmpty(entry)) r.push(`files 条目缺失/空：${entry}`)
  }
  if (!isFile('lib/client.js') || statSync(join(root, 'lib/client.js')).size === 0) {
    r.push('lib/client.js（构建产物）必须入库且非空')
  }
  if (isDir('docs') && readdirSync(join(root, 'docs')).filter((x) => x !== '.gitkeep').length === 0) {
    r.push('docs 目录为空（DETAIL + preview.svg 是上架硬门）')
  }
  return r
})

// ---------------------------------------------------------------------------
// E10 icon
// ---------------------------------------------------------------------------
gate('E10', () => {
  const r = []
  const icon = String(pkg.icon || '')
  if (!icon) return ['package.json icon 未声明']
  if (icon.startsWith('/') || icon.includes('..')) r.push(`icon 必须是包内相对路径：${icon}`)
  if (!isFile(icon)) return [...r, `icon 文件不存在：${icon}`]
  const buf = readFileSync(join(root, icon))
  if (buf.length > 256 * 1024) r.push(`icon 超过 256 KiB：${buf.length} bytes`)
  if (buf.length === 0) return [...r, 'icon 为空文件']
  const head = buf.subarray(0, 4096).toString('utf8')
  const isSvg = /<svg[\s>]/i.test(head) || (head.trimStart().startsWith('<?xml') && head.includes('<svg'))
  const isPng = buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG'
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
  const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  if (!isSvg && !isPng && !isJpeg && !isWebp) r.push(`icon 图片头不可识别（需 svg/png/jpeg/webp）：${icon}`)
  return r
})

// ---------------------------------------------------------------------------
// E11 路由回环默认（静态）
// ---------------------------------------------------------------------------
gate('E11', () => {
  const r = []
  const routesPath = 'src/host/routes/router.js'
  if (!isFile(routesPath)) return [`${routesPath} 不存在`]
  const routes = read(routesPath)
  if (!/isLoopback\(/.test(routes)) r.push('routes/router.js 未做回环判定 isLoopback()')
  if (!/not_loopback/.test(routes)) r.push('routes/router.js 缺 not_loopback 错误码')
  if (!/403/.test(routes)) r.push('routes/router.js 非回环未返回 403')
  // 要求 dispatch 运行时闸本身默认 false（不只靠 boundHosts 的第二处 false 满足正则）。
  if (!/const allowRemote = bool\(config\?\.panel\?\.allowRemote,\s*false\)/.test(routes)) {
    r.push('routes/router.js 的 request-time allowRemote 必须默认 false（const allowRemote = bool(..., false)）')
  }
  const configSrc = isFile('src/host/config.js') ? read('src/host/config.js') : ''
  if (!/allowRemote:\s*z\.boolean\(\)\.default\(false\)/.test(configSrc)) {
    r.push('Config panel.allowRemote 默认值必须为 false')
  }
  return r
})

// ---------------------------------------------------------------------------
// E12 生命周期脚本
// ---------------------------------------------------------------------------
gate('E12', () => {
  const r = []
  const scripts = pkg.scripts || {}
  // prepare/postinstall 等是市场安装/发布会执行的钩子，必须为空；prepack 只在开发者 npm pack/publish
  // 时执行，不是安装期脚本，允许用于发布前强制 build --check（P1 起产物由源重建）。
  for (const key of ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly']) {
    if (key in scripts) r.push(`scripts 不得含 ${key}（市场安装/发布会执行生命周期脚本）`)
  }
  return r
})

// ---------------------------------------------------------------------------
// E13 files 精确 + 构建产物入库
// ---------------------------------------------------------------------------
const REQUIRED_FILES = ['index.js', 'src/host', 'src/shared', 'src/core', 'lib/client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'LICENSE', 'CHANGELOG.md']
/** 文档可以整目录打包，也可以显式列文件；两者都算 docs 已发布。 */
const REQUIRED_DOC_FILES = ['docs/DETAIL.en.md', 'docs/DETAIL.zh.md', 'docs/preview.svg']
const BANNED_FILES = ['test', 'test/', 'scripts', 'scripts/', 'node_modules', 'node_modules/', 'src/client', 'src/client/']

gate('E13', () => {
  const r = []
  const files = pkg.files || []
  if (files.length === 0) return ['files 为空（打包会漏文件）']
  for (const need of REQUIRED_FILES) if (!files.includes(need)) r.push(`files 必含 ${need}`)
  for (const need of REQUIRED_DOC_FILES) {
    if (!files.includes('docs') && !files.includes(need)) r.push(`files 必含 ${need}（或整目录 docs）`)
  }
  for (const banned of BANNED_FILES) if (files.includes(banned)) r.push(`files 不得含 ${banned}`)
  for (const entry of files) {
    if (entry.startsWith('/') || entry.includes('..')) r.push(`files 条目必须是包内相对路径：${entry}`)
    else if (!entryNonEmpty(entry)) r.push(`files 条目缺失/空：${entry}`)
  }
  if (!isFile('lib/client.js') || statSync(join(root, 'lib/client.js')).size === 0) {
    r.push('lib/client.js（构建产物）必须入库且非空')
  }
  if (isDir('docs') && readdirSync(join(root, 'docs')).filter((x) => x !== '.gitkeep').length === 0) {
    r.push('docs 目录为空（DETAIL.md + preview.svg 是上架硬门）')
  }
  return r
})

// ---------------------------------------------------------------------------
// E14 不得 private:true / link:
// ---------------------------------------------------------------------------
gate('E14', () => {
  const r = []
  if (pkg.private === true) r.push('市场条目不得 private:true')
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] || {})) {
      if (String(spec).startsWith('link:')) r.push(`${field}.${name} 使用了 link:（市场索引要求 npm 发布版本）`)
    }
  }
  return r
})

// ---------------------------------------------------------------------------
// E15 错误码单一真源（code -> {status, localeKey}）与引用登记
// ---------------------------------------------------------------------------
gate('E15', async () => {
  const r = []
  const tablePath = 'src/shared/error-table.mjs'
  if (!isFile(tablePath)) return ['缺 src/shared/error-table.mjs（错误码单一真源）']
  let mod
  try {
    mod = await import(`${pathToFileURL(join(root, tablePath)).href}?gate=${Date.now()}`)
  } catch (err) {
    return [`error-table.mjs 无法 import：${err.message}`]
  }
  const table = mod.ERROR_TABLE
  if (!table || typeof table !== 'object') return ['error-table.mjs 未导出 ERROR_TABLE']
  // 发布包 files 必须带上 src/shared：漏了 market 安装后路由 import 直接崩。
  if (!Array.isArray(pkg.files) || !pkg.files.includes('src/shared')) {
    r.push('package.json files 必须含 src/shared（error-table 是运行时 import，不是构建期依赖）')
  }
  const dicts = {}
  for (const lang of ['zh', 'en', 'ja']) {
    try { dicts[lang] = flattenLocale(JSON.parse(read(`locale/${lang}.json`))) } catch (err) {
      r.push(`locale/${lang}.json 解析失败：${err.message}`)
    }
  }
  for (const [code, entry] of Object.entries(table)) {
    if (!/^[a-z][a-z0-9_]*$/.test(code)) r.push(`错误码 ${code} 不是 snake_case`)
    if (!Number.isInteger(entry?.status) || entry.status < 100 || entry.status > 599) {
      r.push(`错误码 ${code} 的 status 非法：${JSON.stringify(entry?.status)}`)
    }
    if (entry?.unmapped === true) {
      if (entry.localeKey !== null) r.push(`错误码 ${code} 标了 unmapped 但仍有 localeKey`)
      continue
    }
    if (typeof entry?.localeKey !== 'string' || !entry.localeKey.startsWith('err.')) {
      r.push(`错误码 ${code} 缺 localeKey（无文案须显式 unmapped:true）`)
      continue
    }
    for (const lang of Object.keys(dicts)) {
      if (typeof dicts[lang]?.[entry.localeKey] !== 'string' || !dicts[lang][entry.localeKey].trim()) {
        r.push(`${lang} 缺文案键 ${entry.localeKey}（错误码 ${code}）`)
      }
    }
  }
  // 代码里引用的字面错误码必须已登记（未登记码会落 unknown_error/400）。
  const refs = new Set()
  for (const dir of ['src/host', 'src/core', 'src/shared']) {
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/error:\s*['"]([a-z][a-z0-9_]*)['"]/g)) refs.add(m[1])
      // 计划/提案的失败出口是 failed('code', ...)，同样是对外错误码。
      for (const m of text.matchAll(/\bfailed\(\s*['"]([a-z][a-z0-9_]*)['"]/g)) refs.add(m[1])
    }
  }
  for (const code of [...refs].sort()) {
    if (!Object.prototype.hasOwnProperty.call(table, code)) r.push(`代码引用错误码 ${code} 未在 error-table 登记`)
  }
  // 路由必须查表，不能又长出本地 if 链。
  const routesSrc = read('src/host/rules-routes.js')
  const sfStart = routesSrc.indexOf('function statusForError')
  if (sfStart < 0) r.push('rules-routes.js 缺 statusForError')
  else {
    const sfEnd = routesSrc.indexOf('\n}', sfStart)
    const sf = routesSrc.slice(sfStart, sfEnd < 0 ? undefined : sfEnd)
    if (!/statusOf\(/.test(sf)) r.push('statusForError 未查 error-table（statusOf）')
    if (/code === ['"]/.test(sf)) r.push('statusForError 仍有本地 if 链（状态码未单一真源）')
  }
  // 客户端：422/500 不得折叠 unknown_error；未映射码必须原文透出 [code]。
  const client = read('lib/client.js')
  const scStart = client.indexOf('function statusCode(status)')
  const scEnd = client.indexOf('async function callJson', scStart)
  if (scStart < 0) r.push('client 缺 statusCode()')
  else {
    const sc = client.slice(scStart, scEnd < 0 ? undefined : scEnd)
    if (!/status === 422[\s\S]*?unprocessable/.test(sc)) r.push('client statusCode 未把 422 映射成 unprocessable（禁止折叠 unknown_error）')
    if (!/status === 500[\s\S]*?server_error/.test(sc)) r.push('client statusCode 未把 500 映射成 server_error（禁止折叠 unknown_error）')
  }
  const etStart = client.indexOf('function errText(t, err)')
  const etEnd = client.indexOf('// ------------------------------------------------------------- formatting', etStart)
  if (etStart < 0) r.push('client 缺 errText()')
  else {
    const et = client.slice(etStart, etEnd < 0 ? undefined : etEnd)
    if (!et.includes("'[' + code + ']'")) r.push('client errText 未把未映射码原文透出 [code]')
  }
  return r
})

// ---------------------------------------------------------------------------
// 守卫 1：禁区扫描（本机字面量 / 越界词），保留原有口径
// ---------------------------------------------------------------------------
// 字面量拆成两段写成正则：避免本脚本自己触发禁区扫描（自指例外要显式解释，别靠白名单）
const FORBIDDEN = [
  new RegExp('39' + '82'), new RegExp('al' + 'una'), new RegExp('124' + '6277257'),
  new RegExp('prompt' + '_dsh'), new RegExp('feiyu' + '-mood'),
  new RegExp('/home' + '/hy', 'i'), new RegExp('ai-' + 'router', 'i'),
  // 角色/对话归属独立插件：A 只认 role_id/workspace，出现这些词即越界
  new RegExp('person' + 'a', 'i'), new RegExp('大' + '肥鱼'), new RegExp('阿罗' + '娜'),
  new RegExp('一' + '叶'), new RegExp('dsh-' + 'chat'), new RegExp('/api/v1/' + 'chat'),
  new RegExp('prompt' + '_'),
]

function walk(p) {
  const full = join(root, p)
  if (!existsSync(full)) return []
  if (statSync(full).isDirectory()) {
    return readdirSync(full).flatMap((x) => walk(join(p, x)))
  }
  return p.endsWith('.gitkeep') ? [] : [full]
}

const guardReasons = []
if (!pkg.license) guardReasons.push('license 必填')
for (const relPath of ['index.js', 'lib/client.js', 'locale', 'src']) {
  for (const file of walk(relPath)) {
    const text = readFileSync(file, 'utf8')
    for (const re of FORBIDDEN) {
      if (re.test(text)) guardReasons.push(`禁区命中 ${re} -> ${rel(file)}`)
    }
  }
}

// 守卫 2：agent/pre-step 是 waterfall，裸 listener（不接收 next）会让 decision.kind 崩。
for (const file of walk('src')) {
  const text = readFileSync(file, 'utf8')
  if (/ctx\.on\(\s*['"]agent\/pre-step['"]\s*,\s*\(\s*\)\s*=>/.test(text)) {
    guardReasons.push(`agent/pre-step waterfall 监听缺少 next() -> ${rel(file)}`)
  }
}
if (guardReasons.length) {
  failed += 1
  console.error(`[gate] GUARD FAIL: ${guardReasons.join('；')}`)
}

// 说明书是离线交付物：MD 真源存在、≤250 行、生成块逐字一致（改了 MD 忘了重生成＝用户看旧说明）。
gate('E16', () => {
  const reasons = []
  const manual = join(root, 'docs/MANUAL.zh.md')
  if (!existsSync(manual) || !statSync(manual).isFile()) {
    reasons.push('缺少 docs/MANUAL.zh.md')
  } else {
    const lines = readFileSync(manual, 'utf8').replace(/\r\n/g, '\n').trim().split('\n').length
    if (lines > 250) reasons.push(`docs/MANUAL.zh.md ${lines} 行 > 250（小白手册要短）`)
  }
  try {
    execFileSync(process.execPath, [join(root, 'scripts/manual-build.mjs'), '--check'], { stdio: 'pipe' })
  } catch {
    reasons.push('generated/manual.js 说明书生成块与 docs/MANUAL.*.md 不一致（运行 node scripts/manual-build.mjs --write）')
  }
  return reasons
})

// ---------------------------------------------------------------------------
for (const [id, fn] of gates) {
  try {
    const reasons = (await fn()) || []
    if (reasons.length) report(id, reasons)
  } catch (err) {
    report(id, [err.stack || err.message])
  }
}

if (failed) {
  console.error(`[gate] FAILED：${failed} 项未过（见上）`)
  process.exitCode = 1
} else {
  console.log(`[gate] OK ${pkg.name}@${pkg.version}：E1–E16 全通过（禁区/waterfall 守卫也过）`)
}
