#!/usr/bin/env node
/**
 * 测试执行器：真跑 `node --test`，捕获 TAP 汇总写入 `.test-results.json`。
 *
 * 为什么单独一层：测试三元组（pass/skip/fail）必须由真实执行产出、单一来源；
 * pretest 阶段还没有结果，比对只能放 posttest。TAP 输出原样透传到 stdout，
 * 人看到的仍是完整测试日志；本脚本只多写一份机器可读汇总。
 *
 * 依赖方向：scripts → node 原生模块，不 import 业务代码。
 * 用法：node scripts/run-tests.mjs [glob ...]（缺省=全部 suite）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.test-results.json')
const DEFAULT_GLOBS = [
  'test/unit/*.test.mjs',
  'test/contract/*.test.mjs',
  'test/hook/*.test.mjs',
  'test/data/*.test.mjs',
  'test/worker/*.test.mjs',
  'test/lifecycle/*.test.mjs',
  'test/sync/*.test.mjs',
  'test/client/*.test.mjs',
  'test/integration/*.test.mjs',
]
const globs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_GLOBS

const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...globs], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
})

let tap = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  tap += chunk
  process.stdout.write(chunk)
})

/** 解析 TAP 末尾的汇总块；取最后一次出现，避免子进程/多文档重复。 */
function parseSummary(text) {
  const summary = {}
  for (const line of text.split('\n')) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line.trim())
    if (match) summary[match[1]] = Number(match[2])
  }
  return summary
}

child.on('close', (code) => {
  const summary = parseSummary(tap)
  const result = {
    tests: summary.tests ?? null,
    pass: summary.pass ?? null,
    skip: summary.skipped ?? null,
    fail: summary.fail ?? null,
    cancelled: summary.cancelled ?? null,
    todo: summary.todo ?? null,
    exitCode: code,
    ranAt: new Date().toISOString(),
    globs,
  }
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
  if (result.pass === null || result.fail === null) {
    console.error('[run-tests] TAP 汇总缺失（tests/pass/fail 至少一项没解析到）；结果不完整，按失败处理')
    process.exit(code === 0 ? 1 : code)
  }
  if (result.tests === 0) {
    console.error('[run-tests] 0 个测试被执行（glob 可能写错/文件不存在）；按失败处理')
    process.exit(code === 0 ? 1 : code)
  }
  console.log(`[run-tests] 已写 ${path.relative(ROOT, OUT)}：tests ${result.tests} / pass ${result.pass} / skip ${result.skip} / fail ${result.fail}`)
  process.exit(code)
})
