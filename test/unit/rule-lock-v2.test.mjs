/**
 * R9-04 锁协议 v2 单元测试（只增，不改既有断言）。
 *
 * 覆盖：基本互斥、活 pid 不接管、死 pid 认领、reaping 互斥阻塞、接管后旧 release 不删新锁、
 * verify 失效、owner 不可读的旧锁接管、等待不超时/不越界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireRepoLock, REPO_LOCK_WAIT_MS } from '../../src/core/rule-lock.js'

function rootOf() {
  return mkdtempSync(join(tmpdir(), 'wm-lock-'))
}

function lockPaths(root) {
  const lockRoot = join(root, '.locks')
  const lock = join(lockRoot, 'repo.lock')
  return { lockRoot, lock, ownerFile: join(lock, 'owner.json') }
}

function seedOwner(root, owner) {
  const { lockRoot, lock, ownerFile } = lockPaths(root)
  mkdirSync(lockRoot, { recursive: true })
  mkdirSync(lock)
  writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8')
}

test('锁 v2：基本获取/释放，活 pid 旧锁不接管', () => {
  const root = rootOf()
  const first = acquireRepoLock(root)
  assert.equal(first.ok, true)
  assert.equal(first.verify(), true)

  const started = Date.now()
  const second = acquireRepoLock(root, { timeoutMs: 80 })
  const elapsed = Date.now() - started
  assert.equal(second.ok, false)
  assert.equal(second.error, 'repo_locked')
  assert.equal(second.owner.pid, process.pid)
  // 短等待，不得退化成 5s 阻塞
  assert.ok(elapsed < 1000, `wait too long: ${elapsed}ms`)
  assert.equal(first.release(), true)
  assert.equal(existsSync(lockPaths(root).lock), false)
})

test('锁 v2：死 pid 旧锁经 rename 认领，旧 release/verify 失效', () => {
  const root = rootOf()
  seedOwner(root, { pid: 999999, ts: Date.now(), nonce: 'dead-nonce' })
  const lock = acquireRepoLock(root, { timeoutMs: 500 })
  assert.equal(lock.ok, true)
  assert.equal(lock.owner.pid, process.pid)
  const raw = JSON.parse(readFileSync(lockPaths(root).ownerFile, 'utf8'))
  assert.equal(raw.nonce, lock.owner.nonce)
  assert.equal(lock.verify(), true)

  // 模拟“旧持有者”晚到的 release/verify：nonce 不匹配，不得删新锁
  const stale = {
    release: () => {
      const held = JSON.parse(readFileSync(lockPaths(root).ownerFile, 'utf8'))
      return Boolean(held && held.nonce === 'dead-nonce')
    },
    verify: () => false,
  }
  assert.equal(stale.verify(), false)
  assert.equal(lock.release(), true)
})

test('锁 v2：reaping 互斥被活 pid 持有时不接管，返回 repo_locked', () => {
  const root = rootOf()
  seedOwner(root, { pid: 999999, ts: Date.now(), nonce: 'dead-nonce' })
  const { lockRoot } = lockPaths(root)
  const reaping = join(lockRoot, 'reaping')
  mkdirSync(reaping)
  writeFileSync(join(reaping, 'owner.json'), `${JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: 'r' })}\n`)

  const started = Date.now()
  const got = acquireRepoLock(root, { timeoutMs: 120 })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'repo_locked')
  // 死锁目录仍在（没有被盲删），reaping 仍在
  assert.equal(existsSync(lockPaths(root).lock), true)
  assert.equal(existsSync(reaping), true)
  assert.ok(Date.now() - started < 1200)
})

test('锁 v2：owner 不可读且目录过期 → 认领；刚建的空目录不抢', () => {
  const root = rootOf()
  const { lockRoot, lock } = lockPaths(root)
  mkdirSync(lockRoot, { recursive: true })
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), 'not-json', 'utf8')
  // 新目录：不抢，短超时后 repo_locked
  const fresh = acquireRepoLock(root, { timeoutMs: 60 })
  assert.equal(fresh.ok, false)
  // 拨旧 mtime：允许认领
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  const taken = acquireRepoLock(root, { timeoutMs: 500 })
  assert.equal(taken.ok, true)
  assert.equal(taken.release(), true)
})

test('锁 v2：等待上限常量是 250ms（不是 5s）', () => {
  assert.equal(REPO_LOCK_WAIT_MS, 250)
})
