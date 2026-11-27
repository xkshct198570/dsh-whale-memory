// 职责：keeper 单实例租约（同一 dataDir 只允许一个进程消费 jobs）；跨进程互斥只靠一个锁文件。
// 依赖方向：零依赖叶模块（node:fs/node:path/process）；scheduler 只 import 本模块。
//
// 为什么不用 DB 行做锁：锁文件能表达「进程是否还活着」，而 DB 行只能表达「上次谁写过」；
// 崩溃残留（kill -9）必须能被下一个进程自动接管，否则 keeper 永远不消费。
// PID 复用是真实坑：只 kill(pid,0) 会把复用同一 PID 的无关进程当成持有者 → 额外比对
// /proc/<pid>/stat 的 starttime（Linux）；读不到时保守判活（宁可只读，不重复消费）。

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bool } from '../../shared/config-values.js'

/** 锁文件名（dataDir 内）。 */
export const KEEPER_LOCK_FILE = 'keeper.lock'
/** 抢占/接管重试次数：并发双进程同时判定 stale 时，只有一方能 wx 成功。 */
const ACQUIRE_RETRIES = 3

/**
 * 读进程启动时间戳（/proc/<pid>/stat 第 22 字段，jiffies since boot）。
 * 用于识别 PID 复用：同一 PID 但 starttime 不同＝不是当初那个进程。
 * @param {number} pid
 * @returns {string|null} 读不到返回 null（非 Linux / 进程已消失）
 */
export function processStartToken(pid) {
  try {
    const raw = readFileSync(`/proc/${Number(pid)}/stat`, 'utf8')
    // comm 字段可能含空格与括号，从最后一个 ')' 之后切分才安全。
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return String(rest[19] ?? '') || null
  } catch {
    return null
  }
}

/**
 * 持有者是否仍活着（本进程恒活）。
 * @param {{ pid?: number|string, startToken?: string|null }} owner
 * @returns {boolean}
 */
export function ownerAlive(owner) {
  const pid = Number(owner?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (err?.code === 'EPERM') return true // 别的用户/权限受限：保守判活
    return false
  }
  // PID 活着：再比对 starttime，挡住 PID 复用。
  const token = processStartToken(pid)
  const expected = owner?.startToken
  if (!token || !expected) return true // 读不到 → 保守判活
  return token === expected
}

/**
 * 取/建 keeper 租约。
 *
 * @param {{ dir: string, log?: (line: string) => void, now?: () => number }} opts
 *   dir＝dataDir（库文件所在目录）；空/不可写时返回 ok:false reason:'no_dir'（调用方按只读处理）。
 * @returns {{ ok: boolean, reason?: string, owner?: object, release: () => void }}
 */
export function acquireKeeperLock({ dir, log = () => {}, now = () => Date.now() } = {}) {
  const noop = { ok: false, reason: 'no_dir', release: () => {} }
  if (!dir) return noop
  const path = join(String(dir), KEEPER_LOCK_FILE)
  const instanceId = `${process.pid}:${Math.random().toString(36).slice(2)}`
  const record = JSON.stringify({
    instanceId, pid: process.pid, startToken: processStartToken(process.pid), acquiredAt: Math.floor(now() / 1000),
  })

  for (let attempt = 0; attempt < ACQUIRE_RETRIES; attempt += 1) {
    try {
      writeFileSync(path, record, { flag: 'wx', mode: 0o600 })
      return {
        ok: true,
        owner: { pid: process.pid, instanceId },
        release() {
          try {
            const current = JSON.parse(readFileSync(path, 'utf8'))
            // 只删自己的锁：别人接管后不能替它解锁（否则同刻出现两个消费者）。
            if (current?.instanceId === instanceId) unlinkSync(path)
          } catch { /* 锁已不在/被别人替换：不必处理 */ }
        },
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        log(`[whale-memory] keeper lock unavailable (${err?.code || err?.message || err}) → read-only mode`)
        return { ok: false, reason: 'lock_error', release: () => {} }
      }
    }

    let current = null
    try { current = JSON.parse(readFileSync(path, 'utf8')) } catch { current = null }
    if (current && ownerAlive(current)) {
      log(`[whale-memory] keeper lock held by pid=${current.pid} → read-only mode (jobs stay queued for the owner)`)
      return { ok: false, reason: 'held', owner: current, release: () => {} }
    }
    // stale（进程已死/文件损坏）：接管。并发接管时只有一方 wx 能成功，失败就再读一轮。
    try { unlinkSync(path) } catch { /* 已被别人接管 */ }
    log(`[whale-memory] keeper lock stale taken over (old pid=${current?.pid ?? '?'} reason=${current ? 'dead' : 'corrupt'})`)
  }
  log('[whale-memory] keeper lock contention: gave up → read-only mode')
  return { ok: false, reason: 'contention', release: () => {} }
}

/**
 * 取 keeper 租约（装配层唯一入口）：把「开关 / dataDir 解析 / 只读原因」全部收敛在这里，
 * scheduler 只关心结果（consume 与否）。
 *
 * @param {{ store?: any, config?: any, log?: (line: string) => void }} [opts]
 * @returns {{ ok: boolean, reason?: string, owner?: object, release: () => void }}
 *   ok=true 表示本进程是 owner（可消费 jobs，可做崩溃补偿）。
 */
export function openKeeperLease({ store, config = {}, log = () => {} } = {}) {
  if (!bool(config?.advanced?.singleInstanceLock, true)) {
    return { ok: true, reason: 'disabled', release: () => {} }
  }
  const dbFile = String(store?.dbFile || '')
  const dir = dbFile ? dirname(dbFile) : String(config?.dataDir || '')
  const lease = acquireKeeperLock({ dir, log })
  if (lease.ok) return lease
  if (lease.reason === 'no_dir') {
    // 无可落锁目录（假 store/嵌入场景）：无从互斥，按单实例继续，但留一行证据。
    log('[whale-memory] keeper lock skipped: no dataDir (single-process assumption)')
    return { ok: true, reason: 'no_dir', release: () => {} }
  }
  log(`[whale-memory] keeper read-only: reason=${lease.reason} owner_pid=${lease.owner?.pid ?? '-'}`)
  return lease
}
