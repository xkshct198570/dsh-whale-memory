import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pullFromGateway, pushToGateway, normalizeOwnerJsonl } from '../src/core/sync.js'

const identity = { userId: 'u1', roleId: '', workspace: 'web' }

test('pull dryRun：调 transport 并统计导入差异', async () => {
  const calls = []
  const backend = { async importJsonl(q) { calls.push(q); return { added: 2, skipped: 1, errors: 0, dryRun: true } } }
  const transport = { async pull() { return '{"text":"a"}\n{"text":"b"}\n{"text":"c"}\n' } }
  const out = await pullFromGateway({ backend, transport, identity, dryRun: true })
  assert.equal(out.ok, true)
  assert.equal(out.lines, 3)
  assert.equal(out.added, 2)
  assert.equal(calls[0].dryRun, true)
})

test('pull 真跑：走 startImport 返回 jobId', async () => {
  const backend = { async startImport(q) { return { async: true, jobId: '7', total: 3 } } }
  const transport = { async pull() { return '{"text":"a"}\n{"text":"b"}\n{"text":"c"}\n' } }
  const out = await pullFromGateway({ backend, transport, identity, dryRun: false })
  assert.equal(out.jobId, '7')
})

test('push：导出后交给 transport.push', async () => {
  let got = ''
  const backend = { async exportJsonl() { return '{"text":"local"}\n' } }
  const transport = { async push(text) { got = text; return { added: 1 } } }
  const out = await pushToGateway({ backend, transport, identity, dryRun: false })
  assert.equal(out.ok, true)
  assert.equal(out.lines, 1)
  assert.match(got, /local/)
})

test('transport 失败返回 ok:false 不抛', async () => {
  const t = { async pull() { throw new Error('ECONNREFUSED') } }
  const out = await pullFromGateway({ backend: {}, transport: t, identity, dryRun: true })
  assert.equal(out.ok, false)
  assert.match(out.error, /ECONNREFUSED/)
})


test('pull 前把 user_id=owner 归一为共享', async () => {
  assert.equal(normalizeOwnerJsonl('{"text":"a","user_id":"owner"}\n'), '{"text":"a","user_id":""}\n')
  let got = ''
  const backend = { async importJsonl(q) { got = q.jsonl; return { added: 1 } } }
  const transport = { async pull() { return '{"text":"a","user_id":"owner"}\n' } }
  await pullFromGateway({ backend, transport, identity, dryRun: true })
  assert.equal(got.includes('"owner"'), false)
})
