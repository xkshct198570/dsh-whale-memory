/**
 * R9 存储不变式回归（R9-02 / R9-03）：
 * - 非法 front 的 `iron-rule-<n>.md` 仍占号，分配器不得复用/覆盖（编号永不复用）；
 * - 写失败（manifest/commit）不留半写：文件/manifest/history/index 四处回滚；
 * - 正文与 history 快照走 durable 写（fsync），不再只是 rename 原子。
 *
 * 全部用临时目录 + git:false（不联网、不碰真实规则仓）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  createRule, fileRuleNumbers, listRules, occupancy, purgeRule, readManifest, readRule, regenerateManifest,
  readTombstones, recoverPendingTxn, writeRule, writeTombstone, writeTxn, validateRule, TXN_DIR,
} from '../../src/core/rule-store.js'
import { createProposal } from '../../src/core/rule-proposal.js'

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-r9-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function ironFront(n, overrides = {}) {
  return {
    key: `iron-rule-${n}`,
    type: 'iron-rule',
    number: n,
    priority: 'P0',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '',
    object: '',
    conditions: [],
    exceptions: [],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-23',
    updated: '2026-11-23',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

/** 非法 front（正文超 500 码点）：文件名合法、内容解析被拒。 */
function writeInvalidRuleFile(root, n) {
  const text = `---\nkey: iron-rule-${n}\ntype: iron-rule\nnumber: ${n}\npriority: P0\nscope: global\nmodality: must\nstatus: active\ncreated: 2026-11-23\nupdated: 2026-11-23\nversion: 1\n---\n必须做某事。${'x'.repeat(600)}\n`
  writeFileSync(join(root, `iron-rule-${n}.md`), text, 'utf8')
  return text
}

test('R9-02：非法 iron-rule-<n>.md 仍占号，create 顺延且绝不覆盖原文件', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: ironFront(17), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const invalidText = writeInvalidRuleFile(root, 18)
  assert.equal(listRules(root).errors.length, 1, '坏文件必须进 errors')

  assert.deepEqual([...fileRuleNumbers(root)].sort((a, b) => a - b), [17, 18], '文件名证据要算占号（合法 17 + 坏文件 18）')
  assert.equal(occupancy(root).has(18), true)

  const created = createRule({ root, draft: { type: 'iron-rule', text: '必须先验证再覆盖正式库。' } })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.number, 19, '18 已被坏文件占用，必须发 19')
  assert.equal(created.key, 'iron-rule-19')
  assert.equal(readFileSync(join(root, 'iron-rule-18.md'), 'utf8'), invalidText, '坏文件正文不得被覆盖')
  assert.equal(existsSync(join(root, 'history', 'iron-rule-18')), false, '坏文件不得产生快照')
  assert.equal(readManifest(root).nextNumber, 20, 'manifest 与分配器同口径')
})

test('R9-03：manifest 写失败 → create 不留幻影规则/快照，manifest 可重建', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: ironFront(1), text: '必须保留审计日志。' }, { git: false }).ok, true)
  // manifest.json 换成目录：regenerateManifest 必失败。
  rmSync(join(root, 'manifest.json'))
  nodeFs.mkdirSync(join(root, 'manifest.json'))

  const created = createRule({ root, draft: { type: 'iron-rule', text: '必须先验证再覆盖正式库。' } })
  assert.equal(created.ok, false)
  assert.equal(created.error, 'manifest_failed')
  // 文件/快照能回滚；manifest 路径本身坏着，重建必然继续失败——必须如实报，不许假装 rolledBack。
  assert.ok(
    Array.isArray(created.rollbackFailures) && created.rollbackFailures.some((item) => item.startsWith('manifest:')),
    `回滚失败清单要含 manifest，实际 ${JSON.stringify(created.rollbackFailures)}`,
  )
  assert.equal(existsSync(join(root, 'iron-rule-2.md')), false, '不得留幻影规则文件')
  assert.equal(existsSync(join(root, 'history', 'iron-rule-2')), false, '不得留幻影快照')
  assert.deepEqual(listRules(root).rules.map((doc) => doc.front.key), ['iron-rule-1'])

  // 修好 manifest 路径后可重建，且 nextNumber 不因失败写回退。
  rmSync(join(root, 'manifest.json'), { recursive: true, force: true })
  const rebuilt = regenerateManifest(root)
  assert.equal(rebuilt.ok, true, rebuilt.error)
  assert.equal(rebuilt.manifest.total, 1)
  assert.equal(rebuilt.manifest.nextNumber, 2)
})

test('R9-03：update 在 manifest 失败时正文回到旧版、快照不增（四处回滚）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: ironFront(1), text: '必须先验证再覆盖正式库。' }, { git: false }).ok, true)
  const historyBefore = existsSync(join(root, 'history', 'iron-rule-1')) ? readdirSync(join(root, 'history', 'iron-rule-1')) : []

  let renames = 0
  const badFs = {
    ...nodeFs,
    renameSync(from, to) {
      renames += 1
      // 顺序：1=ensure manifest、2=history、3=目标正文、4=manifest 重建。
      if (renames === 4) throw new Error('manifest rename blocked')
      return nodeFs.renameSync(from, to)
    },
  }
  const failed = writeRule(
    root,
    { front: ironFront(1, { version: 2 }), text: '必须替换成第二版正文。' },
    { fs: badFs, git: false },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'manifest_failed')
  assert.equal(failed.rolledBack, true, JSON.stringify(failed.rollbackFailures))
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须先验证再覆盖正式库。')
  assert.equal(readRule(root, 'iron-rule-1').rule.front.version, 1)
  assert.deepEqual(
    existsSync(join(root, 'history', 'iron-rule-1')) ? readdirSync(join(root, 'history', 'iron-rule-1')) : [],
    historyBefore,
    '失败写不得多出快照',
  )
  assert.deepEqual(readManifest(root).keys, ['iron-rule-1'])
})

test('R9-03：正文与 history 快照 fsync（不是只有 rename 原子）', (t) => {
  const root = freshRoot(t)
  const counter = { fsync: 0 }
  const fsSpy = { ...nodeFs, fsyncSync: (...args) => { counter.fsync += 1; return nodeFs.fsyncSync(...args) } }
  assert.equal(writeRule(root, { front: ironFront(1), text: '必须先验证再覆盖正式库。' }, { fs: fsSpy, git: false }).ok, true)
  const afterCreate = counter.fsync
  // 新建：正文 fsync + 目录 fsync（manifest 仍走 atomicWriteFile，不计入）。
  assert.ok(afterCreate >= 2, `新建至少要 fsync 文件+目录，实际 ${afterCreate}`)

  assert.equal(writeRule(root, { front: ironFront(1, { version: 2 }), text: '必须替换成第二版正文。' }, { fs: fsSpy, git: false }).ok, true)
  // 更新：快照文件 fsync + 快照目录 fsync + 正文 fsync + 正文目录 fsync。
  assert.ok(counter.fsync - afterCreate >= 4, `更新快照也要 fsync，增量 ${counter.fsync - afterCreate}`)
})

test('R9-03：非降级 commit 失败 → commit_failed + 四处回滚（不再 ok:true 丢提交）', (t) => {
  const root = freshRoot(t)
  const front = ironFront(1)
  assert.equal(writeRule(root, { front, text: '必须先验证再覆盖正式库。' }, { git: true }).ok, true)
  const badExec = (cmd, args, opts) => {
    // 只拦 commit：init/add/rm/diff/reset 仍走真 git，这样 index 清理才是真验证。
    if (/(^| )commit( |$)/.test(args.join(' '))) {
      const err = new Error('fatal: commit denied')
      err.stderr = 'fatal: commit denied'
      throw err
    }
    return execFileSync(cmd, args, opts)
  }
  const failed = writeRule(
    root,
    { front: { ...front, version: 2 }, text: '必须替换成第二版正文。' },
    { exec: badExec },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'commit_failed')
  assert.equal(failed.rolledBack, true, JSON.stringify(failed.rollbackFailures))
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须先验证再覆盖正式库。')
  assert.equal(readRule(root, 'iron-rule-1').rule.front.version, 1)
  assert.deepEqual(
    existsSync(join(root, 'history', 'iron-rule-1')) ? readdirSync(join(root, 'history', 'iron-rule-1')) : [],
    [],
    '失败的提交不得留下快照',
  )
  // index 必须清干净（staged 为空）；worktree 的 manifest.updatedAt 会因回滚重建而变动，不算残留。
  const staged = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()
  assert.equal(staged, '', `index 必须清干净，实际 staged=${staged}`)
  assert.equal(readManifest(root).total, 1)
})


test('R9-02：>999 的文件名编号不得锁死分配（不占号、manifest 不越界）', (t) => {
  const root = freshRoot(t)
  writeFileSync(join(root, 'iron-rule-1000.md'), 'garbage', 'utf8')
  assert.equal(fileRuleNumbers(root).has(1000), false, '非法大号不占号')
  const created = createRule({ root, draft: { type: 'iron-rule', text: '必须先验证再覆盖正式库。' } })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.number, 1)
  const manifest = readManifest(root)
  assert.equal(manifest.nextNumber, 2)
  assert.ok(manifest.nextNumber <= 999)
})

test('R9-02：提案期编号与 manifest/create 同口径（非标准文件名的 inactive 铁律也占号）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: ironFront(1), text: '必须保留审计日志。' }, { git: false }).ok, true)
  assert.equal(writeRule(root, { front: ironFront(2), text: '必须归档过程稿。' }, { git: false }).ok, true)
  // 合法但文件名不规整的铁律：key=iron-rule-legacy，number=3，已停用。
  // 文件名不匹配 /^iron-rule-<n>\.md$/，只能靠"全量 rules 的 front 号"占位。
  const legacy = { ...ironFront(3), key: 'iron-rule-legacy', status: 'retired' }
  assert.equal(writeRule(root, { front: legacy, text: '必须保留历史版本。' }, { git: false }).ok, true)
  assert.equal(readManifest(root).nextNumber, 4)
  const made = createProposal({
    text: '以后都别删源文件',
    identity: { userId: 'u1', roleId: '', workspace: '' },
    rulesDir: root,
    config: { rules: {} },
  })
  assert.equal(made.ok, true, made.code)
  assert.equal(made.proposal.draft.number, 4, '提案期不得再承诺已被 inactive 文件占用的 3 号')
})

test('R9-20：writeRule 编号校验含墓碑 → number_retired（连自己的墓碑号也不得复活）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeRule(root, { front: ironFront(1), text: '必须保留审计日志。' }, { git: false }).ok, true)
  const purged = purgeRule({ root, key: 'iron-rule-1' }, { git: false })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(occupancy(root).has(1), true, '墓碑必须进唯一占用入口')
  assert.equal(readManifest(root).nextNumber, 2)

  // 同一 key 重建：墓碑号即使是自己的也拒绝（编号永不复用），错误码必须是 number_retired。
  const same = writeRule(root, { front: ironFront(1), text: '必须保留审计日志。' }, { git: false })
  assert.equal(same.ok, false)
  assert.equal(same.error, 'invalid_rule')
  assert.equal(same.detail.some((item) => item.code === 'number_retired'), true, JSON.stringify(same.detail))
  assert.equal(existsSync(join(root, 'iron-rule-1.md')), false, '墓碑号不得落盘')

  // 换 key 但复用墓碑号也必须拒绝（编号占用与 key 无关）。
  const other = writeRule(root, { front: ironFront(1, { key: 'iron-rule-legacy' }), text: '必须保留历史版本。' }, { git: false })
  assert.equal(other.ok, false)
  assert.equal(other.error, 'invalid_rule')
  assert.equal(other.detail.some((item) => item.code === 'number_retired'), true, JSON.stringify(other.detail))

  // create 走 occupancy()：墓碑后必须发 2，不得回收 1。
  const created = createRule({ root, draft: { type: 'iron-rule', text: '必须先验证再覆盖正式库。' } })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.number, 2)
  assert.equal(created.key, 'iron-rule-2')
})

test('R9-20：validateRule 收到墓碑标记 map → number_retired（不是 duplicate_number）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeTombstone(root, { key: 'iron-rule-4', number: 4 }).ok, true)
  // 写入口自己会带墓碑；这里直接锁 validateRule 的错误码语义，避免未来有人把它改回撞号。
  assert.equal(existsSync(join(root, 'retired', 'iron-rule-4.json')), true)
  const numbers = new Map([[4, 'retired:iron-rule-4']])
  const check = validateRule(ironFront(4), '必须保留审计日志。', { numbers })
  assert.equal(check.ok, false)
  assert.equal(check.errors.some((item) => item.code === 'number_retired'), true, JSON.stringify(check.errors))
  assert.equal(check.errors.some((item) => item.code === 'duplicate_number'), false)
})


// ---------------------------------------------------------------------------
// R9-21：purge 事务锚点 + 恢复失败保留 txn
// ---------------------------------------------------------------------------

test('R9-21：purge 事务在墓碑后/删文件前崩溃 → 恢复撤销墓碑并保留文件', (t) => {
  const root = freshRoot(t)
  const created = createRule({ root, draft: { text: '必须保留审计日志。', type: 'iron-rule' } }, { git: false })
  assert.equal(created.ok, true)
  const file = created.path
  const oldText = readFileSync(file, 'utf8')
  const tomb = writeTombstone(root, { key: created.key, number: created.number, reason: 'purge' })
  assert.equal(tomb.ok, true)
  const txn = writeTxn(root, {
    id: 'purge-sim-1',
    op: 'purge',
    proposalId: `rule: purge ${created.key} (#${created.number})`,
    createdAt: new Date().toISOString(),
    files: [{ key: created.key, path: file, oldText }],
    tombstone: tomb.path,
  })
  assert.equal(txn.ok, true)
  // 文件仍在（模拟“墓碑已写、git rm 前 kill -9”）
  const out = recoverPendingTxn(root, { log: () => {} })
  assert.equal(out.failed, false)
  assert.equal(existsSync(file), true, '文件必须保留/还原')
  assert.equal(readTombstones(root).length, 0, '恢复删前状态必须撤销墓碑')
  assert.equal(existsSync(join(root, TXN_DIR, 'purge-sim-1.json')), false, '成功后清事务')
  const health = listRules(root)
  assert.equal(health.rules.length, 1)
})

test('R9-21：purge 事务在文件已删/manifest 未重建时崩溃 → 恢复还原文件并重建 manifest', (t) => {
  const root = freshRoot(t)
  const created = createRule({ root, draft: { text: '必须保留审计日志。', type: 'iron-rule' } }, { git: false })
  const file = created.path
  const oldText = readFileSync(file, 'utf8')
  const tomb = writeTombstone(root, { key: created.key, number: created.number, reason: 'purge' })
  rmSync(file)
  assert.equal(writeTxn(root, {
    id: 'purge-sim-2',
    op: 'purge',
    proposalId: `rule: purge ${created.key} (#${created.number})`,
    files: [{ key: created.key, path: file, oldText }],
    tombstone: tomb.path,
  }).ok, true)
  const out = recoverPendingTxn(root, { log: () => {} })
  assert.equal(out.failed, false)
  assert.equal(existsSync(file), true, '无 commit 必须还原文件')
  assert.equal(readTombstones(root).length, 0, '还原文件必须撤销墓碑')
  const manifest = readManifest(root)
  assert.equal(manifest.total, 1, 'manifest 必须由恢复重建')
})

test('R9-21：坏事务日志不得静默清除，failed=true 且文件保留', (t) => {
  const root = freshRoot(t)
  const txnDir = join(root, TXN_DIR)
  const { mkdirSync } = nodeFs
  mkdirSync(txnDir, { recursive: true })
  writeFileSync(join(txnDir, 'broken.json'), 'not-json', 'utf8')
  const out = recoverPendingTxn(root, { log: () => {} })
  assert.equal(out.failed, true)
  assert.equal(existsSync(join(txnDir, 'broken.json')), true, '无法证明安全时必须保留锚点')
})
