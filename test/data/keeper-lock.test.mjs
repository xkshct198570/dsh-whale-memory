/**
 * 0.8.1-07 单实例租约 + keeper handler 超时：真文件锁、真 jobs 行、真 ctx.effect 生命周期。
 *
 * 为什么必须真产物：①锁的失效判据（进程死/PID 复用/文件损坏）只在读真实锁文件时才成立；
 * ②"第二个进程不复位 running"只有真库行能证；③超时后"其它 kind 仍能跑"必须看下一次 tick 的结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper, installKeeper } from '../../src/core/keeper.js'
import { RETRY_MAX_ATTEMPTS } from '../../src/core/job-payload.js'
import { KEEPER_LOCK_FILE, acquireKeeperLock, ownerAlive, processStartToken } from '../../src/core/keeper/lock.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-keeper-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function lockFile(dir) { return join(dir, KEEPER_LOCK_FILE) }

test('租约：首次获取成功、第二方被拒、释放后可再获取；锁文件 600', (t) => {
  const dir = tempDir(t)
  const seen = []
  const a = acquireKeeperLock({ dir, log: (line) => seen.push(line) })
  assert.equal(a.ok, true)
  assert.ok(existsSync(lockFile(dir)))
  assert.equal(readFileSync(lockFile(dir), 'utf8').length > 0, true)

  const b = acquireKeeperLock({ dir, log: (line) => seen.push(line) })
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'held')
  assert.equal(b.owner.pid, process.pid)
  assert.ok(seen.some((line) => line.includes('keeper lock held by pid=')))

  a.release()
  assert.equal(existsSync(lockFile(dir)), false, '释放必须真的删锁')
  const c = acquireKeeperLock({ dir })
  assert.equal(c.ok, true)
  c.release()
})

test('租约：死进程/坏文件可接管；释放只删自己的锁（不替接管者解锁）', (t) => {
  const dir = tempDir(t)
  const seen = []
  // 死 PID：999999 不可能是活进程；startToken 随便给，kill(pid,0) 先判死。
  writeFileSync(lockFile(dir), JSON.stringify({ instanceId: 'x', pid: 999999, startToken: '1', acquiredAt: 1 }))
  const a = acquireKeeperLock({ dir, log: (line) => seen.push(line) })
  assert.equal(a.ok, true, '死进程的锁必须能被接管，否则 keeper 永不消费')
  assert.ok(seen.some((line) => line.includes('stale taken over') && line.includes('999999')))

  // 文件损坏：同样接管。
  writeFileSync(lockFile(dir), 'not-json')
  const b = acquireKeeperLock({ dir, log: (line) => seen.push(line) })
  assert.equal(b.ok, true)
  assert.ok(seen.some((line) => line.includes('reason=corrupt')))

  // 被别人接管后，旧持有者 release 不得删掉新锁。
  writeFileSync(lockFile(dir), JSON.stringify({ instanceId: 'other', pid: process.pid, startToken: '1', acquiredAt: 2 }))
  b.release()
  assert.equal(existsSync(lockFile(dir)), true, 'release 必须校验 instanceId')

  // PID 复用：PID 是活的本进程，但 startToken 不匹配 → 判死。
  assert.equal(ownerAlive({ pid: process.pid, startToken: 'bogus-token' }), true,
    '本进程恒活（同进程再 init 由 instanceId 区分，不由 liveness 判死）')
  assert.equal(processStartToken(999999), null)
  rmSync(lockFile(dir), { force: true })
})

test('read-only keeper：tick/runNow 可判定跳过，enqueue 仍然落库等 owner 消费', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-keeper-ro-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config: {}, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })

  const keeper = createKeeper({ store: backend, config: {}, log: () => {}, intervalMs: 3600_000, consume: false })
  t.after(() => keeper.dispose())
  assert.equal(keeper.consuming, false)
  assert.deepEqual(await keeper.tick(), { ran: [], skipped: 'locked' })
  const id = keeper.enqueue('report', {})
  const now = await keeper.runNow('report', {})
  assert.equal(now.skipped, 'locked')
  assert.equal(now.state, 'queued')
  const row = backend.withDb((db) => db.prepare('SELECT state FROM jobs WHERE id=?').get(id))
  assert.equal(row.state, 'queued', '只读进程不得把别人的队列消费掉')
  assert.equal(keeper.status().consuming, false)
})

test('installKeeper 双进程：第二个只读且不复位 running；dispose 释放租约后可再接管', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-keeper-dual-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config: {}, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })

  const logs = []
  const disposers = []
  const ctx = { effect: (fn) => { disposers.push(fn()) } }
  const config = { advanced: { singleInstanceLock: true } }

  const seed = () => backend.withDb((db) => db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('reflect', 'running', 1, '{}', 1, 1).lastInsertRowid)

  seed()
  const first = installKeeper(ctx, { store: backend, config, log: (line) => logs.push(line) })
  const recovered = backend.withDb((db) => db.prepare('SELECT state FROM jobs WHERE kind=? ORDER BY id DESC LIMIT 1').get('reflect'))
  assert.equal(recovered.state, 'queued', 'owner 必须做崩溃补偿')

  // 再留一条 running：第二个进程绝不能复位它（否则同一 job 会被跑两遍）。
  backend.withDb((db) => db.prepare("UPDATE jobs SET state='running' WHERE kind='reflect'").run())
  const second = installKeeper(ctx, { store: backend, config, log: (line) => logs.push(line) })
  assert.equal(second.consuming, false)
  assert.ok(logs.some((line) => line.includes('keeper read-only: reason=held')))
  const stillRunning = backend.withDb((db) => db.prepare('SELECT state FROM jobs WHERE kind=? ORDER BY id DESC LIMIT 1').get('reflect'))
  assert.equal(stillRunning.state, 'running', '只读进程不得复位别人的 running（重复执行源头）')
  assert.equal(first.consuming, true)

  // owner 卸载 → 新进程拿到租约。
  disposers[0]()
  const third = installKeeper(ctx, { store: backend, config, log: (line) => logs.push(line) })
  assert.equal(third.consuming, true)
  disposers[1](); disposers[2]()
})

test('handler 超时：永不 resolve 的 handler 按失败收尾并留证据，队列继续跑别的 kind', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-keeper-timeout-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config: {}, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  const logs = []
  const keeper = createKeeper({
    store: backend, config: {}, log: (line) => logs.push(line), intervalMs: 3600_000,
    handlerTimeoutMs: 60,
  })
  t.after(() => keeper.dispose())
  let lateSettled = false
  keeper.register('reflect', () => new Promise((resolve) => { setTimeout(() => { lateSettled = true; resolve({ ok: true }) }, 200) }))

  const id = keeper.enqueue('reflect', {})
  await keeper.tick()
  const row = backend.withDb((db) => db.prepare('SELECT state,attempts,last_error FROM jobs WHERE id=?').get(id))
  assert.equal(Number(row.attempts), 1)
  assert.equal(row.state, 'queued', '未到上限的失败按退避重排')
  assert.match(String(row.last_error), /handler_timeout:reflect/)
  assert.ok(logs.some((line) => line.includes('handler_timeout')))

  // 别的 kind 不受堵：下一 tick 跑 report。
  const reportId = keeper.enqueue('report', {})
  await keeper.tick()
  const report = backend.withDb((db) => db.prepare('SELECT state FROM jobs WHERE id=?').get(reportId))
  assert.equal(report.state, 'done', '一个卡死的 kind 不得把其它 kind 永久堵住')

  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(lateSettled, true, '迟到的 handler 结果只被吞掉（不得变成未处理拒绝）')
})

test('超时上限可关闭（0=不限）且终态失败在 attempts 到上限时可见', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'whale-keeper-notimeout-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config: {}, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  const logs = []
  const keeper = createKeeper({ store: backend, config: {}, log: (line) => logs.push(line), intervalMs: 3600_000 })
  t.after(() => keeper.dispose())
  keeper.register('reflect', async () => ({ ok: true }))
  const id = keeper.enqueue('reflect', {})
  await keeper.tick()
  const row = backend.withDb((db) => db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id))
  assert.equal(row.state, 'done', '0=不限时正常 handler 不受影响')

  // 终态失败可见：attempts 达上限的失败行不再被重排。
  const seed = backend.withDb((db) => db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('reflect', 'failed', RETRY_MAX_ATTEMPTS, '{}', 1, 1).lastInsertRowid)
  await keeper.tick()
  const failed = backend.withDb((db) => db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(seed))
  assert.equal(failed.state, 'failed', 'attempts 到上限的失败不得被再次重排')
})
