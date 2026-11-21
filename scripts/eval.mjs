#!/usr/bin/env node
/**
 * 记忆检索黄金评测（CLI + 纯函数）。
 *
 * 为什么单独做一份：面板/开关看得见的效果只有"检索到底能不能召回该召回的节点"。
 * 这里把 32 条黄金用例（cjk/mixed/ident/twochar + 空集防幻觉）固定下来，用只读连接
 * 对真实库跑同一个 search()，让"改打分/改门限/换库"这类改动有可复现的红绿结论；
 * 评测只读，不改库、不写 recall/writes，也不碰生产进程。
 *
 * 用法：
 *   node scripts/eval.mjs --db <数据目录或 memory.db 路径> [--role <id>] [--user <id>]
 *                         [--workspace <ws>] [--topn 3] [--min 0.90] [--json]
 *
 * 打开语义：--db 交给 openDb(dir, { readOnly: true })。openDb 固定打开 `<dir>/memory.db`，
 * 所以传文件路径时只接受文件名 memory.db（取 dirname）；传目录则直接用该目录。
 * 不传 --db 时走 openDb 的默认数据目录（$DSH_HOME/whale-memory 或 ~/.dsh/whale-memory）。
 *
 * 判定口径：
 * - 一条用例的 must_hit_keywords 全部作为子串出现在 topN 命中文本的并集里才算通过；
 * - 检索固定 minRel=0：评测看的是召回与排序，不能靠门限把未命中"调"成通过；
 * - 空集用例（kind=empty / expect_empty）反过来判定：topN 必须 0 命中（防幻觉注入）；
 *   空集不进 precision 分母（没有"期望节点"）：precision 只看有关键词的检索用例，
 *   空集误召回由 zeroInjectionRate 与空集明细单独暴露，避免两套指标互相污染；
 * - 退出码：precision >= --min → 0，否则 1；参数/库/数据错误 → 2；--json 时 stdout 只有 JSON。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DB_FILE, openDb, closeDb } from '../src/core/db.js'
import { search } from '../src/core/search.js'
import { normalize } from '../src/core/tokenize.js'

const FIXTURE_URL = new URL('../test/fixtures/eval.json', import.meta.url)
const DEFAULTS = Object.freeze({ topN: 3, min: 0.9 })

/**
 * 解析 CLI 参数（支持 `--key value` 与 `--key=value`；未知参数直接报错）。
 * @param {string[]} argv 不含 node/脚本名的参数
 * @returns {{ db: string, role: string, user: string, workspace: string, topN: number, min: number, json: boolean, help: boolean }}
 */
export function parseArgs(argv = []) {
  const opts = { db: '', role: '', user: '', workspace: '', topN: DEFAULTS.topN, min: DEFAULTS.min, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '')
    if (arg === '--help' || arg === '-h') {
      opts.help = true
      continue
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`)

    const eq = arg.indexOf('=')
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim()
    if (!['db', 'role', 'user', 'workspace', 'topn', 'min'].includes(key)) throw new Error(`未知参数：--${key}`)
    let value
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
      value = String(next)
      i += 1
    }

    switch (key) {
      case 'db':
      case 'role':
      case 'user':
      case 'workspace':
        opts[key] = value.trim()
        break
      case 'topn': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error(`--topn 必须是 1..50 的整数，收到 ${value}`)
        opts.topN = n
        break
      }
      case 'min': {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--min 必须是 0..1 的小数，收到 ${value}`)
        opts.min = n
        break
      }
      default:
        throw new Error(`未知参数：--${key}`)
    }
  }
  return opts
}

/**
 * 把 --db 归一成 openDb 需要的数据目录（openDb 只认 `<dir>/memory.db`）。
 * @param {string} dbArg 目录或 memory.db 文件路径；空串表示 openDb 默认目录
 * @returns {string} 数据目录（空串原样返回，交给 openDb 默认口径）
 */
export function resolveDbDir(dbArg) {
  const raw = String(dbArg ?? '').trim()
  if (!raw) return ''
  const path = resolve(raw)
  let info
  try {
    info = statSync(path)
  } catch {
    throw new Error(`库路径不存在：${raw}`)
  }
  if (info.isDirectory()) return path
  if (!info.isFile()) throw new Error(`--db 不是文件或目录：${raw}`)
  if (basename(path) !== DB_FILE) {
    throw new Error(`--db 文件必须是 ${DB_FILE}（openDb 固定打开 <dir>/${DB_FILE}），收到 ${basename(path)}`)
  }
  return dirname(path)
}

/**
 * 读取 fixture（默认 test/fixtures/eval.json）。
 * @param {string} [file] 显式文件路径
 * @returns {Array<object>} cases
 */
export function loadCases(file = fileURLToPath(FIXTURE_URL)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`评测集读取失败（${file}）：${err?.message || err}`)
  }
  if (!parsed || !Array.isArray(parsed.cases)) throw new Error(`评测集缺少 cases 数组：${file}`)
  return parsed.cases
}

/**
 * 跑一轮评测（纯函数：不写库、不打印、不改 process 状态）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   cases: Array<{ id?: string, kind?: string, query?: string, must_hit_keywords?: string[], expect_empty?: boolean }>,
 *   topN?: number,
 *   identity?: { userId?: string, roleId?: string, workspace?: string }
 * }} input
 * @returns {{
 *   total: number, keywordTotal: number, passed: number, precision: number,
 *   identTotal: number, identPassed: number, identHitRate: number,
 *   zeroTotal: number, zeroRate: number, emptyTotal: number, emptyClean: number,
 *   rows: Array<{ id: string, kind: string, query: string, passed: boolean,
 *     hits: Array<{ id: string, text: string }>, missing: string[] }>
 * }}
 */
export function runEval({ db, cases, topN = DEFAULTS.topN, identity } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('runEval: 需要已打开的 db')
  if (!Array.isArray(cases)) throw new TypeError('runEval: cases 必须是数组')

  const limit = Number.isFinite(Number(topN)) ? Math.max(1, Math.min(50, Math.floor(Number(topN)))) : DEFAULTS.topN
  const rows = []
  let keywordTotal = 0
  let passed = 0
  let identTotal = 0
  let identPassed = 0
  let zeroTotal = 0
  let emptyTotal = 0
  let emptyClean = 0

  for (const item of cases) {
    const query = String(item?.query ?? '')
    const keywords = (Array.isArray(item?.must_hit_keywords) ? item.must_hit_keywords : [])
      .map((k) => String(k))
      .filter((k) => k.length > 0)

    // minRel:0 —— 评测拒绝"门限调参"，只看 topN 里有没有该有的词。
    const result = search(db, { query, limit, identity, minRel: 0 })
    const hits = (result?.hits ?? []).slice(0, limit).map((hit) => ({ id: String(hit.id), text: String(hit.text) }))
    const haystacks = hits.map((hit) => normalize(hit.text))
    const missing = keywords.filter((keyword) => {
      const needle = normalize(keyword)
      return !haystacks.some((text) => text.includes(needle))
    })

    let ok = false
    const isEmptyCase = keywords.length === 0 && (item?.expect_empty === true || item?.kind === 'empty')
    if (keywords.length > 0) {
      keywordTotal += 1
      ok = missing.length === 0
      if (ok) passed += 1
    } else if (isEmptyCase) {
      // 空集用例：没有可命中的关键词，通过条件就是"什么都没注入"。
      ok = hits.length === 0
      emptyTotal += 1
      if (ok) emptyClean += 1
    }

    if (item?.kind === 'ident') {
      identTotal += 1
      if (ok) identPassed += 1
    }
    if (hits.length === 0) zeroTotal += 1

    rows.push({
      id: String(item?.id ?? ''),
      kind: String(item?.kind ?? ''),
      query,
      passed: ok,
      hits,
      missing,
    })
  }

  const total = cases.length
  return {
    total,
    keywordTotal,
    passed,
    precision: keywordTotal > 0 ? passed / keywordTotal : 0,
    identTotal,
    identPassed,
    identHitRate: identTotal > 0 ? identPassed / identTotal : 0,
    zeroTotal,
    zeroRate: total > 0 ? zeroTotal / total : 0,
    emptyTotal,
    emptyClean,
    rows,
  }
}

/** @param {string} value @param {number} width */
function pad(value, width) {
  const text = String(value ?? '')
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/**
 * 打人读表（只打评测行，不打印整库内容）。
 * @param {ReturnType<typeof runEval>} result
 * @param {{ topN: number, min: number }} opts
 */
function printHuman(result, { topN, min }) {
  const width = {
    id: Math.max(2, ...result.rows.map((r) => r.id.length)),
    kind: Math.max(4, ...result.rows.map((r) => r.kind.length)),
  }
  console.log(`${pad('id', width.id)}  ${pad('kind', width.kind)}  ${pad('命中', 4)}  ${pad('结果', 4)}  query  缺词`)
  for (const row of result.rows) {
    const missing = row.missing.length > 0 ? row.missing.join('|') : '-'
    console.log(
      `${pad(row.id, width.id)}  ${pad(row.kind, width.kind)}  ${pad(row.hits.length, 4)}  ${pad(row.passed ? 'PASS' : 'FAIL', 4)}  ${row.query}  ${missing}`,
    )
  }
  console.log('')
  console.log(`precision@${topN} = ${result.precision.toFixed(4)}（${result.passed}/${result.keywordTotal} 条检索用例） 门限 ${min} → ${result.precision >= min ? 'PASS' : 'FAIL'}`)
  console.log(`identHitRate = ${result.identHitRate.toFixed(4)}（${result.identPassed}/${result.identTotal}）`)
  console.log(`zeroInjectionRate = ${result.zeroRate.toFixed(4)}（${result.zeroTotal}/${result.total} 条 0 命中）`)
  console.log(`空集防幻觉 = ${result.emptyClean.toFixed(0)}/${result.emptyTotal}（期望 0 命中）`)
  const failed = result.rows.filter((row) => !row.passed).map((row) => row.id)
  console.log(`未过用例 = ${failed.length > 0 ? failed.join(', ') : '无'}`)
}

/**
 * CLI 主流程（参数/库/数据错误统一 exit 2；评测结论按 precision 定 0/1）。
 * @param {string[]} [argv]
 * @returns {Promise<number>} 退出码（同时写入 process.exitCode）
 */
export async function main(argv = process.argv.slice(2)) {
  let db
  try {
    const opts = parseArgs(argv)
    if (opts.help) {
      console.error('用法：node scripts/eval.mjs --db <数据目录或 memory.db 路径> [--role <id>] [--user <id>] [--workspace <ws>] [--topn 3] [--min 0.90] [--json]')
      process.exitCode = 0
      return 0
    }

    const cases = loadCases()
    const dir = resolveDbDir(opts.db)
    db = openDb(dir, { readOnly: true })

    const identity = { userId: opts.user, roleId: opts.role, workspace: opts.workspace }
    const result = runEval({ db, cases, topN: opts.topN, identity })

    if (opts.json) {
      console.log(JSON.stringify(result))
    } else {
      printHuman(result, opts)
    }

    const code = result.precision >= opts.min ? 0 : 1
    process.exitCode = code
    return code
  } catch (err) {
    console.error(`[eval] 失败：${err?.message || err}`)
    process.exitCode = 2
    return 2
  } finally {
    closeDb(db)
  }
}

// 只有直接执行才跑 CLI；被测试 import 时保持零副作用。
const invokedDirectly = (() => {
  const script = process.argv[1]
  if (!script) return false
  try {
    return import.meta.url === pathToFileURL(script).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[eval] 未捕获错误：${err?.message || err}`)
    process.exitCode = 2
  })
}
