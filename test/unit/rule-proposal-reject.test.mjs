/**
 * rejectProposal 的会话清理回归（P3c3 复核盲区）：
 * 拒绝候选必须清掉该候选对应的会话 pending。真实走 reject 路径（真候选文件 + 真冷却日志），
 * 不 mock clearSessionPending。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProposal,
  rejectProposal,
  readProposal,
  setSessionPending,
  getSessionPending,
  resetSessionPending,
} from '../../src/core/rule-proposal.js'

const IDENTITY = { userId: 'u1', roleId: 'reviewer', workspace: '' }
const CONFIG = { rules: {} }

test('rejectProposal：拒绝候选后清掉该会话 pending（真实 reject 路径）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'whale-proposal-reject-'))
  resetSessionPending()
  t.after(() => {
    resetSessionPending()
    rmSync(root, { recursive: true, force: true })
  })

  const made = createProposal({
    text: '以后都别删源文件',
    source: 'owner',
    identity: IDENTITY,
    rulesDir: root,
    config: CONFIG,
    sessionId: 'sess-reject',
    now: 1000,
  })
  assert.equal(made.ok, true, made.code)
  const id = made.proposal.id
  assert.equal(setSessionPending('sess-reject', id, 1100), true)
  assert.equal(getSessionPending('sess-reject', 1200)?.proposalId, id)

  const rejected = rejectProposal({ id, reason: '不需要', identity: IDENTITY, rulesDir: root, config: CONFIG, now: 1300 })
  assert.equal(rejected.ok, true, rejected.error)
  assert.equal(getSessionPending('sess-reject', 1400), null)

  assert.equal(rejected.proposal.status, 'rejected')
  const onDisk = readProposal({ rulesDir: root, config: CONFIG, id })
  assert.equal(onDisk.ok, true, onDisk.error)
  assert.equal(onDisk.proposal.status, 'rejected')

  const rejectedFile = join(root, 'proposals', '.rejected.jsonl')
  assert.equal(existsSync(rejectedFile), true)
  const entries = readFileSync(rejectedFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(entries.some((entry) => entry.hash === made.proposal.hash))
})
