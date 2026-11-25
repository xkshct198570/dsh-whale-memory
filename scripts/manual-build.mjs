#!/usr/bin/env node
/**
 * 说明书生成/校验：docs/MANUAL.<lang>.md 是唯一真源，lib/client-src/generated/manual.js 只保留生成块。
 *
 * 用法：
 *   node scripts/manual-build.mjs           # 默认 --check
 *   node scripts/manual-build.mjs --check   # 生成块与 MD 不一致则 exit 1
 *   node scripts/manual-build.mjs --write   # 从 MD 重生成 generated/manual.js，再调用 build-client
 *
 * 为什么零构建：说明书必须离线可读；面板运行时不能读文件，只能读打进 client 的常量。
 * 与 locale 生成块同一模式：唯一真源 + 标记块 + 逐字校验，避免"改了 MD 面板没更新"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'lib/client-src/generated/manual.js')
const BUILD = path.join(ROOT, 'scripts/build-client.mjs')
const LANGS = ['zh', 'en', 'ja']
const MARK_START = '// >>> manual:generated（由 scripts/manual-build.mjs 生成，勿手改）'
const MARK_END = '// <<< manual:generated'
const SOURCE = (lang) => path.join(ROOT, 'docs', `MANUAL.${lang}.md`)

const args = process.argv.slice(2)
const write = args.includes('--write')
const unknown = args.filter((arg) => arg !== '--write' && arg !== '--check')
if (unknown.length > 0) {
  console.error(`[manual] 未知参数：${unknown.join(' ')}（只支持 --check / --write）`)
  process.exit(2)
}

const docs = {}
for (const lang of LANGS) {
  try {
    docs[lang] = fs.readFileSync(SOURCE(lang), 'utf8').replace(/\r\n/g, '\n').trim()
  } catch {
    docs[lang] = ''
  }
}

if (!docs.zh) {
  console.error('[manual] docs/MANUAL.zh.md 缺失或为空：中文说明书是必须交付物，不能生成空块')
  process.exit(1)
}

const block = `${MARK_START}\n    const MANUAL_DOC = ${JSON.stringify(docs, null, 2).replace(/\n/g, '\n    ')}\n    ${MARK_END}`
const client = fs.readFileSync(CLIENT, 'utf8')
const start = client.indexOf(MARK_START)
const end = start < 0 ? -1 : client.indexOf(MARK_END, start + MARK_START.length)

if (write) {
  if (start < 0 || end < start) {
    console.error('[manual] generated/manual.js 缺少 manual:generated 标记块；先跑 scripts/split-client.mjs 生成源片段。')
    process.exit(1)
  }
  const lineEnd = client.indexOf('\n', end) + 1
  const next = client.slice(0, start) + block + '\n' + client.slice(lineEnd)
  fs.writeFileSync(CLIENT, next)
  console.log(`[manual] 已重生成 generated/manual.js 标记块（zh ${docs.zh.split('\n').length} 行）`)
  try {
    execFileSync(process.execPath, [BUILD], { stdio: 'inherit' })
  } catch {
    console.error('[manual] 生成后 build-client 失败')
    process.exit(1)
  }
} else {
  if (start < 0 || end < start) {
    console.error('[manual] generated/manual.js 缺少 manual:generated 标记块；运行 node scripts/manual-build.mjs --write')
    process.exit(1)
  }
  const lineEnd = client.indexOf('\n', end) + 1
  if (client.slice(start, lineEnd) !== `${block}\n`) {
    console.error('[manual] 生成块与 docs/MANUAL.*.md 不一致；运行 node scripts/manual-build.mjs --write')
    process.exit(1)
  }
  console.log(`[manual] ok：zh ${docs.zh.split('\n').length} 行，生成块一致`)
}
