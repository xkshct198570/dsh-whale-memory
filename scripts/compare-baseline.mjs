#!/usr/bin/env node
/**
 * P1 基线对拍：拿 scripts/baseline/ 的旧快照与当前工作树逐项比较。
 *
 * 用法：node scripts/compare-baseline.mjs [--phase P1|P5b] [--no-tests]
 * - phase 默认读 scripts/baseline/current.json，缺失时按 P1。
 * - 逐项打印 ok / FAIL；任一不一致打印 `[compare] FAIL: ...` 并 exit 1。
 * - render-tree 无源，显式打印 skipped (no source)，不静默。
 *
 * 依赖方向：复用 capture-baseline.mjs 的纯函数；本文件不写任何快照。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BASELINE_DIR,
  CLIENT_FILE,
  SNAPSHOT_FILES,
  captureRoutes,
  collectAcornExports,
  extractLocaleObject,
  importNodeExports,
  localeCounts,
  readSchemaVersion,
  readTestCounts,
  readTestRunMeta,
  sha256File,
} from './capture-baseline.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PHASES = new Set(['P1', 'P5b'])

function readBaseline(fileName) {
  const file = join(BASELINE_DIR, fileName)
  if (!existsSync(file)) throw new Error(`缺少基线 ${fileName}，先跑 node scripts/capture-baseline.mjs`)
  return readFileSync(file, 'utf8')
}

function readBaselineJson(fileName) {
  try {
    return JSON.parse(readBaseline(fileName))
  } catch (err) {
    throw new Error(`基线 ${fileName} 解析失败: ${err?.message || err}`)
  }
}

function diffNames(label, expected, actual) {
  const exp = new Set(expected)
  const act = new Set(actual)
  const missing = expected.filter((name) => !act.has(name))
  const added = actual.filter((name) => !exp.has(name))
  return `${label}: 缺少 [${missing.join(', ')}]，新增 [${added.join(', ')}]`
}

function firstDiff(a, b, path = '$') {
  if (a === b) return null
  if (a === null || b === null) return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  if (typeof a !== typeof b) return `${path}: 类型 ${typeof a} != ${typeof b}`
  if (typeof a !== 'object') return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: 数组/对象不一致`
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: 数组长度 ${a.length} != ${b.length}`
    for (let i = 0; i < a.length; i += 1) {
      const hit = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return `${path}: 键数 ${keysA.length} != ${keysB.length}`
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return `${path}.${key}: 当前值缺失`
    const hit = firstDiff(a[key], b[key], `${path}.${key}`)
    if (hit) return hit
  }
  return null
}

function parseArgs(argv) {
  const options = { phase: null, noTests: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-tests') {
      options.noTests = true
    } else if (arg === '--phase') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--phase 缺少取值（P1|P5b）')
      options.phase = value
      i += 1
    } else if (arg.startsWith('--phase=')) {
      options.phase = arg.slice('--phase='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
}

function resolvePhase(override) {
  if (override) {
    if (!PHASES.has(override)) throw new Error(`非法 phase: ${override}（只认 P1|P5b）`)
    return { phase: override, source: '--phase' }
  }
  try {
    const current = readBaselineJson(SNAPSHOT_FILES.current)
    const phase = current?.phase
    if (PHASES.has(phase)) return { phase, source: 'current.json' }
    throw new Error(`current.json phase 非法: ${JSON.stringify(phase)}`)
  } catch (err) {
    if (existsSync(join(BASELINE_DIR, SNAPSHOT_FILES.current))) throw err
    return { phase: 'P1', source: 'default' }
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[compare] ${err?.message || err}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log('用法: node scripts/compare-baseline.mjs [--phase P1|P5b] [--no-tests]')
    return
  }

  let resolved
  try {
    resolved = resolvePhase(options.phase)
  } catch (err) {
    console.error(`[compare] ${err?.message || err}`)
    process.exitCode = 2
    return
  }
  const phase = resolved.phase
  console.log(`[compare] phase: ${phase} (${resolved.source})`)

  const failures = []
  const fail = (message) => {
    failures.push(message)
    console.log(`[compare] FAIL: ${message}`)
  }
  const ok = (label, detail) => console.log(`[compare] ${label}: ok${detail ? ` (${detail})` : ''}`)

  // 1) client sha
  try {
    const line = readBaseline(SNAPSHOT_FILES.clientSha).split(/\r?\n/, 1)[0]
    const match = /^([0-9a-f]{64})  lib\/client\.js$/.exec(line)
    if (!match) {
      fail(`client-sha: 基线首行格式非法: ${JSON.stringify(line.slice(0, 96))}`)
    } else {
      const current = sha256File(CLIENT_FILE)
      if (match[1] !== current) {
        fail(`client-sha: 基线 ${match[1]} != 当前 ${current}`)
      } else {
        ok('client-sha', current.slice(0, 12))
      }
    }
  } catch (err) {
    fail(`client-sha: ${err?.message || err}`)
  }

  // 2) exports：基线有 node 段且能重取则比 node，否则比 acorn
  try {
    const baseline = readBaselineJson(SNAPSHOT_FILES.exports)
    if (!Array.isArray(baseline?.acorn)) throw new Error('基线 exports.json 缺少 acorn 数组')
    if (Array.isArray(baseline.node)) {
      const result = await importNodeExports()
      if (result.node) {
        if (result.node.join('\n') !== baseline.node.join('\n')) {
          fail(`exports(node): ${diffNames('导出名', baseline.node, result.node)}`)
        } else {
          ok('exports', `node ${result.node.length} names`)
        }
      } else {
        console.log(`[compare] exports: node skipped (${result.errors.join('; ')})`)
        if (collectAcornExports().join('\n') !== baseline.acorn.join('\n')) {
          fail(`exports(acorn): ${diffNames('导出名', baseline.acorn, collectAcornExports())}`)
        } else {
          ok('exports', `acorn ${baseline.acorn.length} names`)
        }
      }
    } else {
      console.log('[compare] exports: node skipped (baseline node=null)')
      const current = collectAcornExports()
      if (current.join('\n') !== baseline.acorn.join('\n')) {
        fail(`exports(acorn): ${diffNames('导出名', baseline.acorn, current)}`)
      } else {
        ok('exports', `acorn ${current.length} names`)
      }
    }
  } catch (err) {
    fail(`exports: ${err?.message || err}`)
  }

  // 3) routes：重跑同一 createRoutes 路径，比 status 与 keys 集合
  try {
    const baseline = readBaselineJson(SNAPSHOT_FILES.routes)
    if (!Array.isArray(baseline)) throw new Error('基线 routes-fixture.json 不是数组')
    const current = await captureRoutes()
    let mismatches = 0
    if (baseline.length !== current.length) {
      fail(`routes: 端点数 ${baseline.length} != ${current.length}`)
      mismatches += 1
    }
    const total = Math.min(baseline.length, current.length)
    for (let i = 0; i < total; i += 1) {
      const before = baseline[i]
      const now = current[i]
      const label = `${before.method} ${before.path}`
      const beforeKeys = Array.isArray(before.keys) ? before.keys : []
      const nowKeys = Array.isArray(now.keys) ? now.keys : []
      let bad = false
      if (before.method !== now.method || before.path !== now.path) {
        fail(`routes[${i}]: 端点元数据变化 ${label} -> ${now.method} ${now.path}`)
        bad = true
      }
      if (before.status !== now.status) {
        fail(`routes[${i}] ${label}: status ${before.status} != ${now.status}`)
        bad = true
      }
      if (beforeKeys.join('\n') !== nowKeys.join('\n')) {
        fail(`routes[${i}] ${label}: keys 集合变化 [${beforeKeys.join(', ')}] != [${nowKeys.join(', ')}]`)
        bad = true
      }
      // ok/error 是失败路径的判据：只比 status/keys 会让“基线被改成 ok:false”静默过关。
      if ((before.ok === true) !== (now.ok === true)) {
        fail(`routes[${i}] ${label}: ok ${before.ok === true} != ${now.ok === true}`)
        bad = true
      }
      const beforeError = before.error ?? null
      const nowError = now.error ?? null
      if (beforeError !== nowError) {
        fail(`routes[${i}] ${label}: error ${JSON.stringify(beforeError)} != ${JSON.stringify(nowError)}`)
        bad = true
      }
      if (bad) mismatches += 1
    }
    if (mismatches === 0) ok('routes', `${current.length}/${current.length} endpoints`)
  } catch (err) {
    fail(`routes: ${err?.message || err}`)
  }

  // 4) schema version
  try {
    const baseline = readBaselineJson(SNAPSHOT_FILES.schema)
    const current = readSchemaVersion()
    if (!Number.isFinite(baseline?.version)) throw new Error('基线 schema-version.json 缺少数值 version')
    if (baseline.version !== current.version) {
      fail(`schema-version: 基线 v${baseline.version} != 当前 v${current.version}`)
    } else {
      ok('schema-version', `v${current.version} (${current.source})`)
    }
  } catch (err) {
    fail(`schema-version: ${err?.message || err}`)
  }

  // 5) locale object 深比较
  try {
    const baseline = readBaselineJson(SNAPSHOT_FILES.locale)
    const { value, source } = extractLocaleObject()
    if (!isDeepStrictEqual(baseline, value)) {
      const detail = firstDiff(baseline, value) || '对象结构不一致'
      fail(`locale-object: 深比较不一致（${detail}；来源 ${source}）`)
    } else {
      const counts = localeCounts(value)
      ok('locale-object', `zh=${counts.zh} en=${counts.en} ja=${counts.ja}`)
    }
  } catch (err) {
    fail(`locale-object: ${err?.message || err}`)
  }

  // 6) test counts
  if (options.noTests) {
    console.log('[compare] test-counts: skipped (--no-tests)')
  } else {
    try {
      const baseline = readBaselineJson(SNAPSHOT_FILES.testCounts)
      const current = readTestCounts()
      const meta = readTestRunMeta()
      for (const key of ['pass', 'skip', 'fail']) {
        if (!Number.isInteger(baseline?.[key])) throw new Error(`基线 test-counts.${key} 不是整数（${JSON.stringify(baseline?.[key])}）`)
      }
      // 口径是“不降”而不是“相等”：重构期新增契约测试会合法抬高 pass，不能把新增当回归。
      // 判据与 posttest 的 check-test-counts 同源：exitCode=0、fail=0、pass≥基线、skip≤基线。
      const diffs = []
      if (meta.exitCode !== 0) diffs.push(`exitCode ${meta.exitCode} != 0`)
      if (!Number.isInteger(meta.tests) || meta.tests < current.pass + current.skip) {
        diffs.push(`tests ${meta.tests} < pass+skip ${current.pass + current.skip}`)
      }
      if (current.fail !== 0) diffs.push(`fail ${current.fail} != 0`)
      if (current.pass < baseline.pass) diffs.push(`pass ${current.pass} < 基线 ${baseline.pass}`)
      if (current.skip > baseline.skip) diffs.push(`skip ${current.skip} > 基线 ${baseline.skip}`)
      if (diffs.length > 0) fail(`test-counts: ${diffs.join('; ')}`)
      else ok('test-counts', `pass=${current.pass}（基线 ${baseline.pass}）skip=${current.skip} fail=${current.fail}`)
    } catch (err) {
      fail(`test-counts: ${err?.message || err}`)
    }
  }

  // 7) render-tree：P1 无源（不引 jsdom、不抽树），显式跳过
  console.log('[compare] render-tree: skipped (no source)')

  if (failures.length > 0) {
    console.log(`[compare] FAIL: ${failures.length} 项不一致`)
    process.exitCode = 1
    return
  }
  console.log(`[compare] ok (phase ${phase})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[compare] FAIL: ${err?.message || err}`)
    process.exitCode = 1
  })
}
