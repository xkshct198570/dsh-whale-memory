/**
 * 规则仓库级写锁（R9-04 协议）：只接管已死进程、rename 认领、短等待、不续租。
 *
 * 为什么单独成模块：锁是全仓唯一资源，语义必须与事务/编号解耦；旧实现把“按时间判死”
 * 和“rmSync 盲删”混在 store 主流程里，实测可让两个进程同时进临界区（后写者覆盖前写者）。
 *
 * 协议（与架构书 v3.10 §2.7 一致）：
 * 1. `owner.json` 记 `{pid, nonce, ts}`；持锁者不续租——同步临界区里 Node 定时器无法触发，
 *    “2s 续租”在设计上不可实现。
 * 2. 只有 owner pid **已死**（或 owner 不可读且目录 mtime 超过 10s）才允许接管；活 pid 的
 *    旧锁一律返回 `repo_locked`，由面板/人工处置，绝不抢。
 * 3. 接管在独立 `reaping` 互斥内完成：`rename(repo.lock -> repo.lock.reap-<nonce>)` 是唯一
 *    认领动作，rename 失败即别人先抢到；禁止 `rmSync` 盲删（会删掉别人刚建的新锁）。
 * 4. 等待上限默认 250ms（同步 `Atomics.wait`），避免把宿主事件循环卡 5s。
 *
 * 边界：只依赖 `node:fs`/`node:crypto`/`node:path`；不读规则、不跑 git、不写 manifest。
 * `fs`/`isPidAlive`/`now` 可注入，故障注入测试能构造“死 pid / 活 pid / 抢锁竞态”。
 */
import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'

/** 默认等待上限：250ms。超过即返回 repo_locked，让面板重试。 */
export const REPO_LOCK_WAIT_MS = 250
/**
 * 锁龄阈值（默认 120s）：只用于 health 黄灯判定“疑似僵尸锁”，不自动抢锁。
 * 真源在本模块；rule-store 只做旧导出名转出（调用方无需改 import）。
 */
export const REPO_LOCK_STALE_MS = 120_000
/** owner 不可读时，目录 mtime 超过该值才允许接管（只兜“刚 mkdir 就崩”的窗口）。 */
export const UNREADABLE_LOCK_STALE_MS = 10_000
/** reaping 互斥的 stale：reaping 只持毫秒级；超过 5s 视为崩溃遗留。 */
export const REAPING_STALE_MS = 5_000
/** 等待退避步长（同步）。 */
const POLL_MS = 15

/**
 * 锁状态只读视图（health 用）：held=目录存在；stale=owner 活着但锁龄超过阈值。
 *
 * 为什么只报告不自动抢：临界区是毫秒级同步写，活 pid + 超龄锁的两种成因（pid 复用、
 * 进程卡死）无法从锁文件区分；贸然接管会双写规则仓。这里把它变成可观测红灯/黄灯，
 * 由面板或人工处置（审计 P1：过去 staleMs 是死参数、僵尸锁永不解且全绿）。
 *
 * @param {string} root
 * @param {{fs?: typeof nodeFs, now?: () => number, staleMs?: number}} [opts]
 * @returns {{held: boolean, stale: boolean, ageMs: number, owner: object|null}}
 */
export function lockState(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const staleMs = Number.isFinite(opts.staleMs) ? Number(opts.staleMs) : REPO_LOCK_STALE_MS
  const base = baseDir(root)
  const lock = join(base, '.locks', 'repo.lock')
  const ownerFile = join(lock, 'owner.json')
  const owner = readOwner(ownerFile, fs)
  const held = (() => { try { return fs.existsSync(lock) } catch { return false } })()
  const heldAt = Number.isFinite(Number(owner?.ts)) ? Number(owner.ts) : dirMtimeMs(lock, fs)
  const ageMs = held ? Math.max(0, now() - heldAt) : 0
  const alive = owner?.pid !== undefined ? isProcessAlive(Number(owner.pid)) : null
  return { held, stale: held && (alive === true || alive === null) && ageMs > staleMs, ageMs, owner }
}

/** @param {string} root @returns {string} */
function baseDir(root) {
  return String(root ?? '').trim() || process.cwd()
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
}

/**
 * pid 存活探针：ESRCH=死；EPERM=活着但无权限（按活处理）。
 * 不用 `kill(pid, 0)` 抛错类型做平台判断：Linux/macOS/Windows 的 Node 都支持。
 * @param {number} pid @returns {boolean}
 */
export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** @param {string} file @param {typeof nodeFs} fs @returns {object|null} */
function readOwner(file, fs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 目录 mtime（owner.json 没写成时判活）；读不到按 0（= 很旧，允许接管）。 */
function dirMtimeMs(dir, fs) {
  try { return Number(fs.statSync(dir).mtimeMs) || 0 } catch { return 0 }
}

/** @param {string} dir @param {typeof nodeFs} fs */
function removeDir(dir, fs) {
  try {
    if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true })
    else fs.rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

/**
 * 抢 reaping 互斥（mkdir 原子）。拿不到时若持有者已死/超 stale 则清理后重试一次；
 * 活 pid 不抢，直接返回 null（由调用方回到主循环等待/超时）。
 * @param {string} lockRoot @param {typeof nodeFs} fs @param {() => number} now
 * @returns {{release:Function}|null}
 */
function acquireReaping(lockRoot, fs, now) {
  const dir = join(lockRoot, 'reaping')
  const ownerFile = join(dir, 'owner.json')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = { pid: process.pid, nonce: randomBytes(8).toString('hex'), ts: now() }
    try {
      fs.mkdirSync(dir)
      try { fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8') } catch {
        removeDir(dir, fs)
        return null
      }
      return {
        release() {
          const held = readOwner(ownerFile, fs)
          if (!held || held.nonce !== owner.nonce) return false
          removeDir(dir, fs)
          return true
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') return null
      const held = readOwner(ownerFile, fs)
      const heldAt = Number.isFinite(Number(held?.ts)) ? Number(held.ts) : dirMtimeMs(dir, fs)
      const dead = held?.pid !== undefined && !isProcessAlive(held.pid)
      const stale = now() - heldAt > REAPING_STALE_MS
      if (!dead && !stale) return null
      removeDir(dir, fs)
    }
  }
  return null
}

/**
 * 在 reaping 互斥内接管死锁：rename 认领 + nonce 复核。
 *
 * 为什么 rename 而不是 rmSync：rename 是原子且只有一个成功者；rmSync 先读后删，
 * 期间别人可能刚建了新锁，删掉的就是活锁（ABA，实测三个持有者）。
 *
 * @param {{lock: string, lockRoot: string, fs: typeof nodeFs, now: () => number,
 *   isPidAlive: (pid:number)=>boolean, observed: object|null, log: Function}} args
 * @returns {'taken'|'race'|'busy'}
 */
function reapStaleLock({ lock, lockRoot, fs, now, isPidAlive, observed, log }) {
  const reaping = acquireReaping(lockRoot, fs, now)
  if (!reaping) return 'busy'
  try {
    // 互斥内重读：外面的 observed 可能已过期。
    const fresh = readOwner(join(lock, 'owner.json'), fs)
    if (fresh?.pid !== undefined && isPidAlive(fresh.pid)) return 'race'
    if (!fresh && now() - dirMtimeMs(lock, fs) <= UNREADABLE_LOCK_STALE_MS) return 'race'
    const nonce = String(fresh?.nonce || observed?.nonce || randomBytes(8).toString('hex'))
    const reapingDir = `${lock}.reap-${nonce}`
    try {
      fs.renameSync(lock, reapingDir)
    } catch (err) {
      if (err?.code === 'ENOENT') return 'race'
      log?.(`[whale-memory] repo lock rename failed: ${err?.message || err}`)
      return 'race'
    }
    // rename 成功=认领成功；再核一次被移动目录的 nonce，防“读后被人重建”。
    const moved = readOwner(join(reapingDir, 'owner.json'), fs)
    if (moved && fresh && moved.nonce !== fresh.nonce) {
      // 移走的是别人新锁：原路径为空时还原，否则记日志放弃（不能让活锁凭空消失）。
      try {
        if (!fs.existsSync(lock)) fs.renameSync(reapingDir, lock)
      } catch { /* 还原失败只能留日志，交给 health/人工 */ }
      log?.('[whale-memory] repo lock claim raced with a fresh owner; restored')
      return 'race'
    }
    removeDir(reapingDir, fs)
    return 'taken'
  } finally {
    reaping.release()
  }
}

/**
 * 获取仓库级写锁。
 *
 * @param {string} root 规则仓根
 * @param {{fs?: typeof nodeFs, timeoutMs?: number, now?: () => number,
 *   isPidAlive?: (pid:number)=>boolean, log?: Function}} [opts]
 * @returns {{ok:true, owner:object, release:Function, verify:Function} |
 *   {ok:false, error:string, owner?:object|null}}
 */
export function acquireRepoLock(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const lockRoot = join(base, '.locks')
  const lock = join(lockRoot, 'repo.lock')
  const ownerFile = join(lock, 'owner.json')
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : REPO_LOCK_WAIT_MS
  // staleMs 只影响"owner 不可读"的接管阈值（可读且 pid 活着的锁绝不抢）；默认沿用 10s。
  const unreadableStaleMs = Number.isFinite(opts.staleMs) ? Number(opts.staleMs) : UNREADABLE_LOCK_STALE_MS
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const isPidAlive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : isProcessAlive
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const started = now()
  try { fs.mkdirSync(lockRoot, { recursive: true }) } catch (err) {
    return { ok: false, error: `lock_dir_failed:${err?.message || err}` }
  }

  for (;;) {
    const owner = { pid: process.pid, ts: now(), nonce: randomBytes(8).toString('hex') }
    try {
      fs.mkdirSync(lock)
      try { fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8') } catch (err) {
        removeDir(lock, fs)
        return { ok: false, error: `lock_owner_failed:${err?.message || err}` }
      }
      return {
        ok: true,
        owner,
        release() {
          const held = readOwner(ownerFile, fs)
          if (!held || held.nonce !== owner.nonce) return false
          try { fs.unlinkSync(ownerFile) } catch { /* owner 可能已被接管 */ }
          try { fs.rmdirSync(lock) } catch { /* 已被清理/权限变化：不掩盖写入结果 */ }
          return true
        },
        /** 不可逆点复核：nonce 变化=锁已被接管，调用方必须中止并回滚。 */
        verify() {
          const held = readOwner(ownerFile, fs)
          return Boolean(held && held.nonce === owner.nonce)
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, error: `lock_failed:${err?.message || err}` }
      const observed = readOwner(ownerFile, fs)
      const observedPid = Number(observed?.pid)
      const alive = Number.isInteger(observedPid) && observedPid > 0
        ? isPidAlive(observedPid)
        : null
      // 活 pid：即使 ts 很旧也不抢——抢锁造成双写比“稍后重试”严重得多。
      if (alive === true) {
        if (now() - started > timeoutMs) return { ok: false, error: 'repo_locked', owner: observed }
        sleepSync(POLL_MS)
        continue
      }
      const staleUnreadable = alive === null && now() - dirMtimeMs(lock, fs) > unreadableStaleMs
      if (alive === false || staleUnreadable) {
        const result = reapStaleLock({ lock, lockRoot, fs, now, isPidAlive, observed, log })
        if (result === 'taken') continue
        // 别人先抢到/刚重建：回到主循环重抢，不在这里删任何东西。
        if (now() - started > timeoutMs) return { ok: false, error: 'repo_locked', owner: readOwner(ownerFile, fs) }
        sleepSync(POLL_MS)
        continue
      }
      if (now() - started > timeoutMs) return { ok: false, error: 'repo_locked', owner: observed }
      sleepSync(POLL_MS)
    }
  }
}

/**
 * 在仓库锁内执行同步函数；抛错也释放。
 * @template T
 * @param {string} root @param {() => T} fn @param {object} [opts]
 * @returns {T | {ok:false, error:string, owner?:object|null}}
 */
export function withRepoLock(root, fn, opts = {}) {
  const lock = acquireRepoLock(root, opts)
  if (!lock.ok) return { ok: false, error: lock.error, owner: lock.owner || null }
  try {
    return fn(lock)
  } finally {
    lock.release()
  }
}

/** 稳定哈希（测试/诊断用）：不参与业务。 @param {string} text */
export function hashNonce(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12)
}
