#!/usr/bin/env node
/**
 * 测试三元组闸：posttest 唯一判据。只读 `.test-results.json` 与基线，不重跑测试。
 *
 * 判据：fail=0、pass≥基线 pass、skip≤基线 skip。缺任一文件即红，不目测、不猜。
 * 依赖方向：scripts → scripts/baseline/*.json，无业务代码。
 * 用法：node scripts/check-test-counts.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = path.join(ROOT, '.test-results.json')
const BASELINE = path.join(ROOT, 'scripts/baseline/test-counts.json')

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`[test-counts] 缺少 ${label}：${path.relative(ROOT, file)}`)
    process.exit(1)
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`[test-counts] ${label} 解析失败：${err.message}`)
    process.exit(1)
  }
}

const current = readJson(RESULTS, '.test-results.json（先跑 npm test）')
const baseline = readJson(BASELINE, 'scripts/baseline/test-counts.json')

const reasons = []
if (current.exitCode !== 0) reasons.push(`测试进程 exitCode=${current.exitCode}（必须为 0；失败运行不得当绿）`)
if (!Number.isInteger(current.tests) || current.tests < current.pass + current.skip) {
  reasons.push(`tests=${current.tests} < pass+skip=${Number(current.pass) + Number(current.skip)}（计数不自洽）`)
}
if (!Number.isInteger(current.pass) || !Number.isInteger(current.fail) || !Number.isInteger(current.skip)) {
  reasons.push(`.test-results.json 三元组不完整：pass=${current.pass} skip=${current.skip} fail=${current.fail}`)
} else {
  if (current.fail !== 0) reasons.push(`fail=${current.fail}（必须为 0）`)
  if (current.pass < baseline.pass) reasons.push(`pass=${current.pass} < 基线 ${baseline.pass}`)
  if (current.skip > baseline.skip) reasons.push(`skip=${current.skip} > 基线 ${baseline.skip}`)
}

if (reasons.length > 0) {
  console.error(`[test-counts] FAIL：${reasons.join('；')}`)
  process.exit(1)
}
console.log(
  `[test-counts] ok：pass ${current.pass} / skip ${current.skip} / fail ${current.fail}` +
    `（基线 pass ${baseline.pass} / skip ${baseline.skip} / fail ${baseline.fail}）`,
)
