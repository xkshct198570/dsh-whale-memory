#!/usr/bin/env node
/**
 * S3 网关迁移桥：把 Python 网关（~/ai-router-microservice）里的活跃记忆导成
 * A 包（whale-memory）可导入的 JSONL，并在导出后就地校验。
 *
 * 为什么要有这一份：A 只吃 JSONL（UI「导入」按钮负责入库），而网关侧的导出入口是
 * Python 运维工具 `python -m tools.mem_export export`。中间少一层壳的话，迁移手册
 * 就变成「复制三条命令 → 手工数行数 → 手工抽检 JSON」，每次都要人肉判断有没有坏行。
 * 这里把这层壳收敛成一个脚本：调 Python 导出 → 读文件 → 逐行校验 → 打印机器可读摘要。
 *
 * 红线：
 * 1. 不写数据库：入库由 A 的 UI「导入」按钮做（导入要过 text_hash 去重与备份锁）。
 * 2. 不写 $DSH_HOME：产物只落 --out 指定的临时路径。
 * 3. 导出走 Python 的 `mode=ro` 只读连接，本脚本只读文件、只 spawn，不动网关进程。
 * 4. text > 500 只告警不阻断（历史记忆长度不可控，挡住等于永远导不完）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULTS = {
  out: null,
  role: 'aluna',
  user: '1246277257',
  gatewayDir: '/home/hy/ai-router-microservice',
  dryRun: false,
  includeOwner: true,
  timeoutMs: 120_000,
}

/** text 上限：A 的写入契约与 UI 展示都按 500 字截断，超长只提示不阻断。 */
export const TEXT_LIMIT = 500

/**
 * 纯函数校验：JSONL 文本 → 统计结果。不碰文件系统，便于单测。
 *
 * 行口径：空行（含纯空白）跳过，不计入 lines、不算错——Python 导出末尾会留换行。
 * valid：parse 成功且 `text` 为非空字符串的行数（trim 后非空才算）。
 * tooLong：valid 行里 text 长度 > TEXT_LIMIT 的行数（仅告警）。
 * errors：最多前 5 条问题行，含行号与原样片段，方便人工定位。
 */
export function validateJsonl(text) {
  const rawLines = String(text ?? '').split('\n')
  const result = { lines: 0, valid: 0, invalid: 0, tooLong: 0, errors: [] }
  const pushError = (lineNo, reason, sample) => {
    if (result.errors.length < 5) result.errors.push({ line: lineNo, reason, sample })
  }
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].replace(/\r$/, '')
    if (line.trim() === '') continue
    result.lines += 1
    let row
    try {
      row = JSON.parse(line)
    } catch (err) {
      result.invalid += 1
      pushError(i + 1, `bad_json: ${err.message}`, line.slice(0, 120))
      continue
    }
    const body = row && typeof row === 'object' && typeof row.text === 'string' ? row.text : null
    if (body === null || body.trim() === '') {
      result.invalid += 1
      pushError(i + 1, 'empty_text', line.slice(0, 120))
      continue
    }
    result.valid += 1
    if (body.length > TEXT_LIMIT) result.tooLong += 1
  }
  return result
}

/** `--key=value` 与 `--key value` 两种写法都认；未知参数直接报错，避免静默跑错库。 */
export function parseArgs(argv) {
  const known = new Set(['out', 'role', 'user', 'gateway-dir', 'dry-run', 'no-owner'])
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!known.has(key)) throw new Error(`未知参数：--${key}（支持 --out/--role/--user/--gateway-dir/--dry-run/--no-owner）`)
    if (key === 'no-owner') {
      if (eq !== -1) throw new Error('--no-owner 不带值')
      opts.includeOwner = false
      continue
    }
    if (key === 'dry-run') {
      if (eq !== -1) throw new Error('--dry-run 不带值')
      opts.dryRun = true
      continue
    }
    let value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1)
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--${key} 缺少值`)
    if (key === 'gateway-dir') opts.gatewayDir = value
    else opts[key] = value
  }
  if (!opts.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    opts.out = `/tmp/whale-memory-migration-${ts}.jsonl`
  }
  opts.out = resolve(opts.out)
  opts.gatewayDir = resolve(opts.gatewayDir)
  return opts
}

/** 组装要跑的 argv（不含可执行文件本身），dry-run 与真实执行共用同一份，杜绝两套口径。 */
export function buildCommand(opts) {
  return ['-m', 'tools.mem_export', 'export', `--role=${opts.role}`, `--user=${opts.user}`, `--out=${opts.out}`]
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)

/** stdout/stderr 只透传摘要：默认全量会刷屏，行数多时只留头尾。 */
function digest(label, text, maxLines = 8) {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean)
  if (lines.length === 0) return `${label}: (空)`
  if (lines.length <= maxLines) return `${label}:\n${lines.map((l) => `  ${l}`).join('\n')}`
  const head = lines.slice(0, 3)
  const tail = lines.slice(-3)
  return `${label}（${lines.length} 行，只留头尾）:\n${head.map((l) => `  ${l}`).join('\n')}\n  ...\n${tail.map((l) => `  ${l}`).join('\n')}`
}

function runExport(opts) {
  const python = resolve(opts.gatewayDir, '.venv/bin/python')
  if (!existsSync(python)) {
    const err = new Error(`找不到 Python 解释器：${python}（检查 --gateway-dir）`)
    err.code = 'python_missing'
    throw err
  }
  const args = buildCommand(opts)
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      python,
      args,
      { cwd: opts.gatewayDir, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const e = new Error(
            error.killed
              ? `导出超时（>${opts.timeoutMs}ms），已终止子进程`
              : `导出失败：${error.message}`,
          )
          e.code = error.killed ? 'timeout' : 'export_failed'
          e.stdout = stdout
          e.stderr = stderr
          return rejectPromise(e)
        }
        resolvePromise({ stdout, stderr })
      },
    )
  })
}

/**
 * 把 `user_id='owner'` 的活跃节点映射为共享（`user_id=''`）并拼接。
 *
 * 为什么：现网有 10 条 owner 规则的 `user_id` 存的是字面量 "owner"，不是 QQ 号；
 * 直接按 QQ 号导出会静默漏掉它们。A 的身份过滤是 `(列='' OR 列=值)`，
 * 所以把它们映射为共享才能在网页端召回，且不冒充任何用户。
 */
export function normalizeOwnerLines(text) {
  const out = []
  let mapped = 0
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row && row.user_id === 'owner') { row.user_id = ''; mapped += 1 }
    out.push(JSON.stringify(row))
  }
  return { text: out.join('\n') + (out.length ? '\n' : ''), mapped, lines: out.length }
}

function printSummary(payload) {
  // 固定五个键，方便迁移手册 diff 与 CI 摘取；问题行细节走 stderr。
  console.log(
    JSON.stringify({
      file: payload.file,
      lines: payload.lines,
      bytes: payload.bytes,
      valid: payload.valid,
      tooLong: payload.tooLong,
      ownerMerged: payload.ownerMerged ?? 0,
    }),
  )
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`[migrate] 参数错误：${err.message}`)
    return 1
  }

  const python = resolve(opts.gatewayDir, '.venv/bin/python')
  const args = buildCommand(opts)
  const printable = [python, ...args].map(shellQuote).join(' ')

  if (opts.dryRun) {
    console.log(`[migrate] dry-run（只打印，不执行）：\n  ${printable}`)
    console.log(`[migrate] cwd=${opts.gatewayDir} timeout=${opts.timeoutMs}ms`)
    return 0
  }

  console.log(`[migrate] 开始导出 → ${opts.out}`)
  let run
  try {
    run = await runExport(opts)
  } catch (err) {
    if (err.stdout) console.error(digest('[python stdout]', err.stdout))
    if (err.stderr) console.error(digest('[python stderr]', err.stderr))
    console.error(`[migrate] ${err.message}`)
    return 1
  }
  if (run.stdout) console.log(digest('[python stdout]', run.stdout))
  if (run.stderr) console.error(digest('[python stderr]', run.stderr))

  if (!existsSync(opts.out)) {
    console.error(`[migrate] 导出结束但没有产物文件：${opts.out}`)
    return 1
  }

  // 合并 owner 共享节点：第二遍导出 --user=owner，映射 user_id='' 后追加。
  let ownerMerged = 0
  if (opts.includeOwner && opts.user !== 'owner') {
    const ownerOut = `${opts.out}.owner`
    try {
      await runExport({ ...opts, user: 'owner', out: ownerOut })
      if (existsSync(ownerOut)) {
        const merged = normalizeOwnerLines(readFileSync(ownerOut, 'utf8'))
        ownerMerged = merged.mapped
        if (merged.lines) {
          const mainText = readFileSync(opts.out, 'utf8')
          writeFileSync(opts.out, mainText.replace(/\n?$/, '\n') + merged.text, 'utf8')
        }
      }
    } catch (err) {
      console.error(`[migrate] 告警：owner 共享节点合并失败（${err.message}）；主文件仍可用`)
    }
  }

  const bytes = statSync(opts.out).size
  const report = validateJsonl(readFileSync(opts.out, 'utf8'))
  printSummary({ file: opts.out, lines: report.lines, bytes, valid: report.valid, tooLong: report.tooLong, ownerMerged })

  for (const e of report.errors) console.error(`[migrate] 问题行 ${e.line} ${e.reason} … ${e.sample}`)
  if (report.tooLong > 0) console.error(`[migrate] 告警：${report.tooLong} 行 text > ${TEXT_LIMIT} 字（不阻断；导入时 A 侧对 >500 单规则会拒绝并计 errors，不做静默截断）`)
  if (report.lines === 0) {
    console.error('[migrate] 失败：产物 0 行（检查 role/user/status 过滤条件）')
    return 1
  }
  if (report.invalid > 0) {
    console.error(`[migrate] 失败：${report.invalid} 行不可用（坏 JSON 或 text 为空）`)
    return 1
  }
  console.log(`[migrate] OK：${report.valid} 行可导入（入库请走 A UI 的「导入」按钮，本脚本不写库）`)
  return 0
}

// 仅在作为入口直接执行时跑 main：被测试 import 时不产生副作用。
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1])))
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => { console.error('[migrate] 未捕获异常：', err); process.exitCode = 1 },
  )
}
