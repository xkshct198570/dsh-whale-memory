/**
 * git 探测单测（R3a）：未安装/损坏/正常、60s 缓存、强制刷新、安装提示、requireGit 闸门。
 * exec 全部注入，不依赖本机是否安装 git，也不 spawn 真进程。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GIT_CACHE_MS,
  detectGit,
  gitProbeCount,
  gitRequired,
  installHint,
  refreshGit,
  resetGitCache,
} from '../../src/host/git-detector.js'

/** @param {string} out */
function okExec(out) {
  return () => out
}

/** @param {string} code @param {string} [stderr] */
function failExec(code, stderr = '') {
  return () => {
    const err = new Error(stderr || `exec failed ${code}`)
    if (code === 'ENOENT') err.code = 'ENOENT'
    else { err.status = Number(code) || 1; err.stderr = stderr }
    throw err
  }
}

beforeEach(() => resetGitCache())

test('未安装（ENOENT）→ available=false、error=git_not_installed', () => {
  const info = detectGit({ exec: failExec('ENOENT') })
  assert.equal(info.available, false)
  assert.equal(info.version, '')
  assert.equal(info.error, 'git_not_installed')
  assert.equal(typeof info.checkedAt, 'number')
})

test('损坏/非 0 退出 → available=false，error 保留 stderr', () => {
  const info = detectGit({ exec: failExec('128', 'fatal: detected dubious ownership') })
  assert.equal(info.available, false)
  assert.match(info.error, /dubious ownership/)
})

test('正常 2.x → available=true 且版本号解析正确', () => {
  const info = detectGit({ exec: okExec('git version 2.43.0\n') })
  assert.equal(info.available, true)
  assert.equal(info.version, '2.43.0')
  assert.equal(info.error, null)
})

test('输出不可识别（裁剪版 git）不赌可用', () => {
  const info = detectGit({ exec: okExec('something else') })
  assert.equal(info.available, false)
  assert.equal(info.error, 'unrecognized_version')
})

test('60s 缓存：重复探测不重复 spawn；force 绕过；refreshGit 强制重探', () => {
  let calls = 0
  const exec = () => { calls += 1; return 'git version 2.40.1\n' }
  assert.equal(detectGit({ exec }).available, true)
  assert.equal(detectGit({ exec }).available, true)
  assert.equal(calls, 1, '缓存期内只 spawn 一次')
  assert.equal(gitProbeCount(), 1)
  detectGit({ exec, force: true })
  assert.equal(calls, 2)
  refreshGit({ exec })
  assert.equal(calls, 3)
  assert.equal(GIT_CACHE_MS >= 60_000, true)
})

test('缓存 TTL 可按参数缩短（测试/特殊场景）', () => {
  let calls = 0
  const exec = () => { calls += 1; return 'git version 2.40.1\n' }
  detectGit({ exec, ttlMs: 1 })
  detectGit({ exec, ttlMs: 0 })
  assert.equal(calls, 2)
})

test('installHint：三平台都有命令与官方下载地址', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const hint = installHint(platform)
    assert.equal(hint.platform, platform)
    assert.ok(Array.isArray(hint.commands) && hint.commands.length > 0)
    for (const item of hint.commands) assert.ok(item.label && item.command, `${platform} 命令缺字段`)
    assert.match(hint.download, /^https:\/\//)
    assert.ok(hint.note)
  }
  assert.match(installHint('darwin').commands[0].command, /brew install git/)
  assert.match(installHint('win32').commands[0].command, /winget install/)
  assert.match(installHint('linux').commands[0].command, /apt-get install/)
})

test('gitRequired：false 降级放行；true 缺失硬拦 git_required；true 可用放行', () => {
  const missing = { available: false, version: '', error: 'git_not_installed', checkedAt: 1 }
  const present = { available: true, version: '2.43.0', error: null, checkedAt: 1 }

  const degraded = gitRequired({ rules: { requireGit: false } }, () => missing)
  assert.equal(degraded.required, false)
  assert.equal(degraded.ok, true)
  assert.equal(degraded.degraded, true)

  const blocked = gitRequired({ rules: { requireGit: true } }, () => missing)
  assert.equal(blocked.required, true)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'git_required')

  const allowed = gitRequired({ rules: { requireGit: true } }, () => present)
  assert.equal(allowed.ok, true)
  assert.equal(allowed.degraded, false)

  // 直接传探测结果也可（已有缓存时避免再 spawn）
  const fromInfo = gitRequired({ rules: { requireGit: true } }, present)
  assert.equal(fromInfo.ok, true)
})
