// 职责：仓库锁导出 + 事务日志/崩溃恢复；依赖：../rule-lock.js、./paths.js、./io.js、./parse.js、./manifest.js、./git.js。
import { REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock } from '../rule-lock.js'
import * as nodeFs from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { baseDir } from './paths.js'
import { durableWriteFile, dirnameOf, existsSyncSafe, fsyncDir, hashText } from './io.js'
import { readRuleSource, ruleKeyOfFile } from './parse.js'
import { regenerateManifest } from './manifest.js'
import { runGit } from './git.js'

// ---------------------------------------------------------------------------
// 常量（事务日志/仓库锁目录）
// ---------------------------------------------------------------------------

/** 应用事务日志目录（短命；启动恢复后删除；不进 git）。 */
export const TXN_DIR = '.txn'
/** 跨进程仓库级写锁目录（生成物，不进 git）。 */
export const LOCK_DIR = '.locks'
/** 仓库级锁名：manifest/commit/编号都是全仓资源，一把锁避免假并发。 */
export const REPO_LOCK = 'repo.lock'

// ---------------------------------------------------------------------------
// 事务日志（.txn/<id>.json）：多文件写前的崩溃恢复锚点
// ---------------------------------------------------------------------------

const TXN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** `.txn/<id>.json` 路径；id 白名单外返回 null（防止越界写）。 */
function txnPathOf(base, id) {
  const text = String(id ?? '').trim()
  return TXN_ID_RE.test(text) ? join(base, TXN_DIR, `${text}.json`) : null
}

/**
 * 落一个事务日志（fsync）：apply 在写第一个文件之前调用。
 *
 * `files[].oldText` 是崩溃恢复的判据：无 commit 时按它原样写回；`oldText === null` 表示
 * 该文件是本事务新建的，恢复即删除。
 *
 * @param {string} root
 * @param {{id:string, planHash?:string, proposalId?:string, createdAt?:string,
 *   files?:Array<{key:string,path:string,oldText:string|null,newText?:string}>}} txn
 * @param {{fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeTxn(root, txn = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, txn?.id)
  if (!path) return { ok: false, error: 'invalid_txn_id' }
  const files = []
  for (const item of Array.isArray(txn?.files) ? txn.files : []) {
    const filePath = String(item?.path ?? '').trim()
    if (!filePath) return { ok: false, error: 'invalid_txn_file' }
    files.push({
      key: String(item?.key ?? ruleKeyOfFile(filePath)).trim(),
      path: filePath,
      oldText: item?.oldText === null || item?.oldText === undefined ? null : String(item.oldText),
      ...(item?.newText === undefined ? {} : { newText: String(item.newText) }),
    })
  }
  if (!files.length) return { ok: false, error: 'invalid_txn_files' }
  const payload = {
    id: String(txn.id).trim(),
    planHash: String(txn?.planHash ?? ''),
    proposalId: String(txn?.proposalId ?? ''),
    createdAt: String(txn?.createdAt ?? new Date().toISOString()),
    // op/tombstone 让恢复器区分 apply 与 purge 两种事务；旧事务没有 op 按 apply 处理。
    ...(txn?.op ? { op: String(txn.op) } : {}),
    ...(txn?.tombstone ? { tombstone: String(txn.tombstone) } : {}),
    ...(txn?.failedAt ? { failedAt: String(txn.failedAt) } : {}),
    ...(Array.isArray(txn?.failures) && txn.failures.length ? { failures: txn.failures.map(String) } : {}),
    files,
  }
  try { fs.mkdirSync(join(base, TXN_DIR), { recursive: true }) } catch (err) {
    return { ok: false, error: `txn_dir_failed:${err?.message || err}` }
  }
  const written = durableWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, { fs })
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, path }
}

/** 读一个事务日志；缺失/坏 JSON 返回 null（恢复流程按"没有待恢复项"处理）。 */
export function readTxn(root, id, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, id)
  if (!path) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 清一个事务日志；不存在视为已清（幂等）。 */
export function clearTxn(root, id, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const path = txnPathOf(base, id)
  if (!path) return { ok: false, error: 'invalid_txn_id' }
  try { fs.unlinkSync(path); return { ok: true } } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true }
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 列出待恢复事务 id（按文件名排序；目录不存在返回空）。 */
export function listTxns(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  try {
    return fs.readdirSync(join(base, TXN_DIR))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
      .filter((id) => TXN_ID_RE.test(id))
      .sort()
  } catch {
    return []
  }
}

/**
 * 探"这个事务是否已提交"：`git log --fixed-strings --grep=<proposalId>` 精确到提交说明，
 * 不扫最近 N 条 subject 猜（猜错会把已发布的新规则回滚掉）。失败一律按"未提交"处理。
 * @param {string} base @param {object} txn @param {{exec?:Function}} opts
 * @returns {boolean}
 */
function txnHasCommit(base, txn, opts = {}) {
  const marker = String(txn?.proposalId ?? '').trim() || String(txn?.id ?? '').trim()
  if (!marker) return false
  const out = runGit(base, [
    'log', '-n1', '--fixed-strings', `--grep=${marker}`, '--pretty=format:%h',
  ], { exec: opts.exec })
  return out.ok && String(out.out ?? '').trim() !== ''
}

/**
 * 启动恢复：把**全部**未完成事务收敛到一致状态（循环处理，不只第一条）。
 *
 * 判据分两层：
 * 1. git 里已有本事务的提交（精确 grep proposalId）→ 事务已发布，只清日志，绝不回滚；
 * 2. 无提交 → 逐文件按 `newText` 的 sha256 复核：**只有当前内容仍等于本事务写下的 newText**
 *    才按 `oldText` 恢复（`oldText=null` 则删除）；内容已变 = 之后有合法写入，只清日志不动文件。
 *
 * 为什么必须有 hash 闸：apply 失败回滚后若 `.txn` 没清（或崩溃在 clearTxn 前），旧实现会把
 * 之后所有合法写入一律按 oldText 覆盖回去。hash 不等即视为"不是本事务的中间态"，只清账。
 *
 * @param {string} root
 * @param {{exec?:Function, log?:Function, fs?:typeof nodeFs}} [opts]
 * @returns {{recovered:boolean, id?:string, ids:string[],
 *   processed:Array<{id:string, committed:boolean, restored:number, deleted:number,
 *   skipped:number, failures:string[]}>}}
 */
/**
 * 记录一次成功恢复（health 可读）：`.txn/.recovered.jsonl` 不是事务文件（不以 .json 结尾），
 * 不参与 listTxns；只保留最近 20 条，避免无限增长。
 * @param {string} base @param {object} entry @param {typeof nodeFs} fs
 */
function writeRecoveryRecord(base, entry, fs) {
  const file = join(base, TXN_DIR, '.recovered.jsonl')
  let lines = []
  try {
    lines = String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean)
  } catch { lines = [] }
  lines.push(JSON.stringify(entry))
  const kept = lines.slice(-20)
  try {
    fs.mkdirSync(join(base, TXN_DIR), { recursive: true })
    fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8')
  } catch { /* 记录失败不影响恢复结论；health 只是少一条证据 */ }
}

/** 恢复失败：保留事务文件并写回失败信息，下一轮启动继续重试。 */
function keepFailedTxn(base, id, txn, failures, fs) {
  try {
    writeTxn(base, {
      ...txn,
      id,
      failedAt: new Date().toISOString(),
      failures,
    }, { fs })
  } catch { /* 写不回失败信息也不能清账；文件原样保留 */ }
}

/**
 * 恢复一个 purge 事务（无 commit 时把“墓碑已写/文件已删”收敛回删前，或补完删除）：
 * - 墓碑在、文件已删、manifest 未重建 → 重建 manifest，视为已完成删除（清事务）；
 * - 墓碑在、文件仍在 → 撤销墓碑 + 还原文件（回到删前，安全优先）；
 * - 墓碑不在、文件不在 → 用 oldText 还原文件。
 * @returns {{restored:number,deleted:number,failures:string[]}}
 */
function recoverPurgeTxn(base, txn, fs) {
  const failures = []
  let restored = 0
  let deleted = 0
  const item = Array.isArray(txn.files) ? txn.files[0] : null
  const raw = String(item?.path ?? '').trim()
  const file = raw ? (isAbsolute(raw) ? raw : join(base, raw)) : ''
  const tomb = String(txn?.tombstone ?? '').trim()
  const tombExists = tomb ? existsSyncSafe(tomb, fs) : false
  const fileExists = file ? (() => { try { return fs.existsSync(file) } catch { return false } })() : false
  if (!file) failures.push('purge:missing_path')
  /** 回到删前时墓碑必须撤销；否则会留下「墓碑号 + 现存同号文件」的红状态。 */
  const dropTomb = () => {
    if (!tombExists) return
    try { fs.unlinkSync(tomb); fsyncDir(dirnameOf(tomb), fs) } catch (err) {
      failures.push(`tombstone:${err?.message || err}`)
    }
  }
  if (file && !fileExists && item?.oldText !== undefined && item?.oldText !== null) {
    const wrote = durableWriteFile(file, String(item.oldText), { fs })
    if (wrote.ok) restored += 1
    else failures.push(`${raw}:${wrote.error}`)
    dropTomb()
  } else if (file && fileExists && tombExists) {
    // 文件还在但墓碑已写：撤销墓碑（不把编号误作废），文件原样保留。
    dropTomb()
  } else if (file && !fileExists && (item?.oldText === undefined || item?.oldText === null)) {
    // 无旧正文证据：只能视为删除已完成，交给 manifest 重建。
    deleted += 1
  }
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
  return { restored, deleted, failures }
}

/**
 * 启动恢复：把**全部**未完成事务收敛到一致状态（循环处理，不只第一条）。
 *
 * 判据分两层：
 * 1. git 里已有本事务的提交（精确 grep proposalId/txn id）→ 事务已发布，只清日志，绝不回滚；
 * 2. 无提交 → apply 逐文件按 `newText` 的 sha256 复核（只有仍是本事务写下的中间态才恢复）；
 *    purge 走 `recoverPurgeTxn`（墓碑/文件/manifest 三态收敛）。
 *
 * **恢复失败必须保留 `.txn`**（写回 failedAt/failures），下一轮启动重试；只有全绿才清账。
 * 成功清账后写一条 `.txn/.recovered.jsonl`，供 `/rules/health` 展示 `recovered_txn`。
 *
 * @param {string} root
 * @param {{exec?:Function, log?:Function, fs?:typeof nodeFs}} [opts]
 * @returns {{recovered:boolean, id?:string, ids:string[],
 *   failed:boolean,
 *   processed:Array<{id:string, op:string, committed:boolean, restored:number, deleted:number,
 *   skipped:number, failures:string[]}>}}
 */
export function recoverPendingTxn(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const base = baseDir(root)
  const ids = listTxns(base, { fs })
  if (!ids.length) return { recovered: false, failed: false, ids: [], processed: [] }
  // 恢复会改动规则文件/manifest：必须与写入口同一把仓库锁。另一个进程正在 apply
  // （txn 已写、文件写到一半）时抢不到锁就跳过本轮，绝不把在飞事务回滚掉。
  const lock = acquireRepoLock(base, {
    fs, timeoutMs: Number.isFinite(opts.lockTimeoutMs) ? Number(opts.lockTimeoutMs) : 250,
  })
  if (!lock.ok) {
    log(`[whale-memory] txn recovery skipped: ${lock.error || 'repo_locked'}`)
    return { recovered: false, failed: false, ids, processed: [], skipped: 'repo_locked' }
  }
  const processed = []
  let recovered = false
  let failed = false
  try {
  for (const id of ids) {
    const txn = readTxn(base, id, { fs })
    if (!txn) {
      // 坏事务日志：保留文件（不能证明安全），health 会报；不静默清。
      failed = true
      processed.push({ id, op: '?', committed: false, restored: 0, deleted: 0, skipped: 0, failures: ['unreadable'] })
      continue
    }
    const op = String(txn?.op || 'apply')
    const committed = txnHasCommit(base, txn, opts)
    let restored = 0
    let deleted = 0
    let skipped = 0
    let failures = []
    if (!committed) {
      if (op === 'purge') {
        const outcome = recoverPurgeTxn(base, txn, fs)
        restored = outcome.restored
        deleted = outcome.deleted
        failures = outcome.failures
        if (restored || deleted) recovered = true
      } else {
        for (const item of Array.isArray(txn.files) ? txn.files : []) {
          const raw = String(item?.path ?? '').trim()
          if (!raw) continue
          const file = isAbsolute(raw) ? raw : join(base, raw)
          const expected = item?.newText === undefined || item?.newText === null ? null : hashText(item.newText)
          // 无法验证（老 txn 没记 newText）→ 不动文件：安全优先于"尽量回滚"。
          if (!expected) { skipped += 1; continue }
          const current = readRuleSource(file, { fs })
          if (item?.oldText === null || item?.oldText === undefined) {
            if (!current.ok) { skipped += 1; continue }
            if (hashText(current.text) !== expected) { skipped += 1; continue }
            try { fs.unlinkSync(file); deleted += 1 } catch (err) {
              if (err?.code !== 'ENOENT') failures.push(`${raw}:${err?.message || err}`)
            }
            continue
          }
          if (!current.ok) { skipped += 1; continue }
          if (hashText(current.text) !== expected) { skipped += 1; continue }
          const wrote = durableWriteFile(file, String(item.oldText), { fs })
          if (wrote.ok) restored += 1
          else failures.push(`${raw}:${wrote.error}`)
        }
        if (restored || deleted) recovered = true
        const manifest = regenerateManifest(base, { fs })
        if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
      }
    }
    if (failures.length) {
      failed = true
      keepFailedTxn(base, id, txn, failures, fs)
      log(`[whale-memory] txn recovery failed id=${id} op=${op} failures=${failures.join(';')}（保留事务，下轮重试）`)
    } else {
      clearTxn(base, id, { fs })
      writeRecoveryRecord(base, {
        id, op, committed, restored, deleted, skipped, at: new Date().toISOString(),
      }, fs)
      if (restored || deleted) {
        log(`[whale-memory] txn recovered id=${id} op=${op} restored=${restored} deleted=${deleted} skipped=${skipped}`)
      } else if (committed) {
        log(`[whale-memory] txn already committed, cleared id=${id}`)
      } else if (skipped) {
        log(`[whale-memory] txn stale (files changed since), cleared id=${id} skipped=${skipped}`)
      }
    }
    processed.push({
      id, op, committed, restored, deleted, skipped,
      failures: failures.length ? failures : [],
    })
  }
  return { recovered, failed, id: processed[0]?.id, ids: processed.map((item) => item.id), processed }
  } finally {
    lock.release?.()
  }
}

export { REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock }
