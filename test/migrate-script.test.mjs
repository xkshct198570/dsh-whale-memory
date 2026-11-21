import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { validateJsonl, parseArgs, buildCommand, TEXT_LIMIT } from '../scripts/migrate-from-gateway.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/migrate-from-gateway.mjs', import.meta.url))
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

// 轻量：只跑 --dry-run 与纯函数，不 spawn Python、不读真实库、不写 $DSH_HOME。
test('dry-run：退出 0，打印的命令含 mem_export export', () => {
  const r = run(['--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /mem_export export/)
  assert.match(r.stdout, /--role=aluna/)
  assert.match(r.stdout, /--user=1246277257/)
  assert.match(r.stdout, /--out=/)
  assert.equal(r.stderr.trim(), '')
})

test('参数缺省与覆盖：默认 out 落 /tmp，gateway-dir 可覆盖', () => {
  const opts = parseArgs([])
  assert.match(opts.out, /^\/tmp\/whale-memory-migration-.+\.jsonl$/)
  const cmd = buildCommand(opts)
  assert.deepEqual(cmd.slice(0, 3), ['-m', 'tools.mem_export', 'export'])
  const overridden = parseArgs(['--gateway-dir=/tmp/gw', '--role=r1', '--user=u1'])
  assert.equal(overridden.gatewayDir, '/tmp/gw')
  assert.deepEqual(buildCommand(overridden).slice(3, 5), ['--role=r1', '--user=u1'])
  assert.throws(() => parseArgs(['--role']), /缺少值/)
  assert.throws(() => parseArgs(['--nope=1']), /未知参数/)
})

test('校验：正常两行全通过', () => {
  const text = [JSON.stringify({ text: '第一行' }), JSON.stringify({ text: 'second' })].join('\n') + '\n'
  const r = validateJsonl(text)
  assert.equal(r.lines, 2)
  assert.equal(r.valid, 2)
  assert.equal(r.invalid, 0)
  assert.equal(r.tooLong, 0)
})

test('校验：空行不计入 lines、不算错', () => {
  const text = '\n' + JSON.stringify({ text: 'a' }) + '\n   \n\n' + JSON.stringify({ text: 'b' }) + '\n'
  const r = validateJsonl(text)
  assert.equal(r.lines, 2)
  assert.equal(r.valid, 2)
  assert.equal(r.invalid, 0)
})

test('校验：坏 JSON 计入 invalid 并留行号', () => {
  const text = [JSON.stringify({ text: 'ok' }), '{not json', JSON.stringify({ text: 'ok2' })].join('\n')
  const r = validateJsonl(text)
  assert.equal(r.lines, 3)
  assert.equal(r.valid, 2)
  assert.equal(r.invalid, 1)
  assert.equal(r.errors[0].line, 2)
  assert.match(r.errors[0].reason, /bad_json/)
})

test('校验：text 为空/缺失算无效', () => {
  const text = [JSON.stringify({ text: '   ' }), JSON.stringify({ text: 1 }), JSON.stringify({ nope: true })].join('\n')
  const r = validateJsonl(text)
  assert.equal(r.lines, 3)
  assert.equal(r.valid, 0)
  assert.equal(r.invalid, 3)
  assert.match(r.errors[0].reason, /empty_text/)
})

test('校验：超 500 只计 tooLong，不算无效', () => {
  const long = 'x'.repeat(TEXT_LIMIT + 1)
  const text = [JSON.stringify({ text: 'short' }), JSON.stringify({ text: long })].join('\n')
  const r = validateJsonl(text)
  assert.equal(r.lines, 2)
  assert.equal(r.valid, 2)
  assert.equal(r.invalid, 0)
  assert.equal(r.tooLong, 1)
})
