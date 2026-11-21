#!/usr/bin/env node
/**
 * S1 静态门：包形态 + 禁区扫描（CI/收尾共用）。
 *
 * 为什么要有这一份：市场安装失败大多不是功能问题，而是 manifest/导出/文件清单
 * 与"本机字面量泄漏"这类机械问题；这里把可机检的部分前置，避免到 S5 才发现。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fail = (m) => { console.error('[check] FAIL:', m); process.exitCode = 1 }

if (!pkg.name || !pkg.version || !pkg.dsh?.bundle?.patch) fail('name/version/dsh.bundle.patch 必填')
if (pkg.private === true) fail('开源包不得 private:true')
if (!pkg.license) fail('license 必填')
if (!/^>=?\d+\.\d+\.\d+/.test(String(pkg.engines?.dsh || ''))) fail('engines.dsh 必须是 SemVer range（且非 workspace:）')
if (String(pkg.engines?.dsh || '').includes('workspace:')) fail('engines.dsh 禁止 workspace:')

const patch = pkg.dsh?.bundle?.patch
if (!existsSync(join(root, patch))) fail(`bundle patch 不存在：${patch}`)
if (patch && !readFileSync(join(root, patch), 'utf8').includes('insert:')) fail('patch 必须含 insert 行')

for (const [name, target] of Object.entries(pkg.exports || {})) {
  if (!name.includes('*') && !existsSync(join(root, target))) fail(`exports ${name} -> ${target} 不存在`)
}

for (const f of pkg.files || []) {
  if (f.includes('*')) {
    const dir = join(root, dirname(f))
    if (!existsSync(dir) || readdirSync(dir).filter((x) => x !== '.gitkeep').length === 0) fail(`files glob 无内容：${f}`)
  } else if (!existsSync(join(root, f))) fail(`files 条目不存在：${f}`)
}

// 字面量拆成两段写成正则：避免本脚本自己触发禁区扫描（自指例外要显式解释，别靠白名单）
const FORBIDDEN = [
  new RegExp('39' + '82'), new RegExp('al' + 'una'), new RegExp('124' + '6277257'),
  new RegExp('prompt' + '_dsh'), new RegExp('feiyu' + '-mood'),
  new RegExp('/home' + '/hy', 'i'), new RegExp('ai-' + 'router', 'i'),
]
const scanRoots = ['index.js', 'lib/client.js', 'locale', 'src']
const walk = (p) => {
  if (!existsSync(p)) return []
  const st = statSync(p)
  if (st.isDirectory()) return readdirSync(p).flatMap((x) => walk(join(p, x)))
  return p.endsWith('.gitkeep') ? [] : [p]
}
for (const rel of scanRoots) {
  for (const file of walk(join(root, rel))) {
    const text = readFileSync(file, 'utf8')
    for (const re of FORBIDDEN) if (re.test(text)) fail(`禁区命中 ${re} -> ${file.slice(root.length + 1)}`)
  }
}

if (!process.exitCode) console.log(`[check] OK ${pkg.name}@${pkg.version}（manifest/exports/files/禁区 全通过）`)
