/**
 * A 阶段安全回归：远端读面收口（P1-04）、导入身份强制（P1-02）、
 * 导入 job / 收尾报告按身份作用域（P1-03）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_READ_DENY_GET, remoteReadable } from '../../src/host/routes/router.js'
import { LocalBackend } from '../../src/core/backend.js'
import { reportRead } from '../../src/host/session-wrap/report.js'

test('P1-04：allowRemote 远端只读面不含 config/writes/import 状态/整库导出', () => {
  for (const suffix of ['/export', '/config', '/writes', '/import/status', '/wrap/status', '/wrap/report']) {
    assert.ok(REMOTE_READ_DENY_GET.has(`/whale-memory/api${suffix}`), `${suffix} 必须拒绝远端读`)
    assert.equal(remoteReadable('GET', `/whale-memory/api${suffix}`), false)
  }
  assert.equal(remoteReadable('GET', '/whale-memory/api/nodes'), true, '面板浏览列表仍允许')
  assert.equal(remoteReadable('POST', '/whale-memory/api/search'), true)
  assert.equal(remoteReadable('POST', '/whale-memory/api/write'), false)
})

test('P1-02：HTTP 导入强制请求身份，行内身份不能植入他分区', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-sec-a-'))
  const backend = new LocalBackend({ dataDir: dir, useWorker: false })
  try {
    const identity = { userId: 'owner', roleId: '', workspace: 'web' }
    const jsonl = JSON.stringify({ text: '导入分区探针：不得写进 bob 分区', user_id: 'bob', workspace: 'qq' })
    const r = await backend.importJsonl({ jsonl, identity, forceIdentity: true })
    assert.equal(r.added, 1)
    const rows = await backend.nodes({ limit: 10, identity })
    assert.equal(rows.items.length, 1)
    assert.equal(rows.items[0].workspace, 'web')
    assert.equal(rows.items[0].user_id, 'owner')
    const bob = await backend.nodes({ limit: 10, identity: { userId: 'bob', roleId: '', workspace: 'qq' } })
    assert.equal(bob.items.length, 0, '他分区不得出现该行')
  } finally { backend.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('P1-03：导入 job 状态按登记身份作用域，跨身份按不存在返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-sec-b-'))
  const backend = new LocalBackend({ dataDir: dir, useWorker: false })
  try {
    const identity = { userId: 'owner', roleId: '', workspace: 'web' }
    const lines = Array.from({ length: 51 }, (_, i) => JSON.stringify({ text: `批量导入探针 ${i}：用于异步 job 状态作用域断言` })).join('\n')
    const started = await backend.startImport({ jsonl: lines, identity, forceIdentity: true })
    assert.equal(started.ok, true)
    const own = await backend.importStatus(started.jobId, { identity })
    assert.equal(own.ok, true)
    const other = await backend.importStatus(started.jobId, { identity: { userId: 'bob', roleId: '', workspace: 'qq' } })
    assert.equal(other.ok, false)
    assert.equal(other.error, 'job_not_found')
  } finally { backend.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('P1-03：wrap 报告显式身份不一致按缺失返回（不按 id 跨分区直读）', () => {
  const run = {
    id: 7, report_path: '/tmp/x/reports/run-7.md',
    user_id: 'owner', role_id: '', workspace: 'web',
  }
  const got = reportRead({
    runId: 7,
    withDb: (fn) => fn({ prepare: () => ({ get: () => run }) }),
    reportDir: '/tmp/x/reports',
    identity: { userId: 'owner', roleId: '', workspace: 'qq' },
  })
  assert.equal(got.ok, false)
  assert.equal(got.error, 'report_missing')
})
