/**
 * 规则仓储 R8 不变式单测：墓碑/编号/仓库锁/事务恢复/git 卫生/解析闸。
 *
 * 只碰临时目录；git 用注入 exec 模拟（不依赖本机安装、不联网）。每个用例独立仓。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MANIFEST_FILE,
  RULE_FILE_MAX,
  RULE_NUMBER_MAX,
  acquireRepoLock,
  acquireRuleLock,
  atomicWriteFile,
  clearTxn,
  commitRuleChanges,
  createRule,
  ensureRuleRepo,
  gitCommit,
  listRules,
  listTxns,
  parseRuleDocument,
  purgeRule,
  readManifest,
  readHistory,
  readRule,
  readTombstones,
  readTxn,
  recoverPendingTxn,
  resetGitIndex,
  regenerateManifest,
  updateRule,
  validateRule,
  withRepoLock,
  writeRule,
  writeTombstone,
  writeTxn,
} from '../../src/core/rule-store.js'

function freshRoot(t, prefix = 'whale-r8-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }))
  return root
}

function frontOf(overrides = {}) {
  return {
    key: 'iron-rule-1',
    type: 'iron-rule',
    number: 1,
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

function writeDoc(root, front, text, opts = {}) {
  return writeRule(root, { front, text }, { git: false, ...opts })
}

/**
 * 假 git：rev-parse 恒真、add/rm/reset 成功、`diff --cached --quiet` 用退出码 1 表示有改动、
 * commit 可注入失败、log 返回注入的 subject。
 */
function fakeGit({ failCommit = false, logSubjects = [] } = {}) {
  const calls = []
  const exec = (_cmd, args = []) => {
    const joined = Array.isArray(args) ? args.join(' ') : ''
    calls.push(joined)
    if (joined.includes('--version')) return 'git version 2.42.0\n'
    if (joined.includes('rev-parse --is-inside-work-tree')) return 'true\n'
    if (joined.includes('log ')) {
      const grepArg = args.find((arg) => String(arg).startsWith('--grep='))
      const needle = grepArg ? String(grepArg).slice('--grep='.length) : ''
      const hits = needle ? logSubjects.filter((subject) => String(subject).includes(needle)) : logSubjects
      // 恢复探针只取 %h：命中返回短 sha，未命中返回空串（真实 grep 的语义）。
      return hits.length ? `${hits.map(() => 'abc1234').join('\n')}\n` : ''
    }
    // 模拟 git rm 的副作用：fake git 必须真的删文件，否则 commit 会把它当"仍在盘上"再 add。
    if (/(^| )rm (?:-q|-f|--ignore-unmatch| )/.test(joined) && joined.includes(' -- ')) {
      // 仓库根在 args 的 `-C <dir>` 里（exec 的 _cmd 固定是 'git'）。
      const dir = args[args.indexOf('-C') + 1]
      const paths = joined.slice(joined.indexOf(' -- ') + 4).split(' ').filter(Boolean)
      for (const rel of paths) {
        try { nodeFs.unlinkSync(join(dir, rel)) } catch { /* 已不存在 */ }
      }
      return ''
    }
    if (joined.includes('diff --cached --quiet')) {
      const err = new Error('changes staged')
      err.status = 1
      err.stderr = ''
      throw err
    }
    if (joined.includes('commit ')) {
      if (failCommit) {
        const err = new Error('commit blocked')
        err.status = 1
        err.stderr = 'fatal: commit blocked'
        throw err
      }
      return '[main abc1234] ok\n'
    }
    return ''
  }
  return {
    exec,
    calls,
    commitMessages: () => calls
      .filter((line) => line.includes('commit -m'))
      .map((line) => line.slice(line.indexOf('-m ') + 3)),
  }
}

// ---------------------------------------------------------------------------
// 墓碑 / manifest 可重建
// ---------------------------------------------------------------------------

test('墓碑：writeTombstone 落盘可读、坏 JSON 跳过、同一 key 重写保留更早 at', (t) => {
  const root = freshRoot(t)
  const first = writeTombstone(root, { key: 'iron-rule-9', number: 9, at: '2026-11-20T00:00:00.000Z', reason: 'purge' })
  assert.equal(first.ok, true, first.error)
  assert.equal(nodeFs.existsSync(join(root, 'retired', 'iron-rule-9.json')), true)
  // 后写 at 更晚：墓碑记录"何时作废"，保留更早的时间。
  assert.equal(writeTombstone(root, { key: 'iron-rule-9', number: 9, at: '2026-11-23T00:00:00.000Z' }).ok, true)
  writeFileSync(join(root, 'retired', 'broken.json'), '{not json', 'utf8')
  writeTombstone(root, { key: 'iron-rule-10', number: 10, at: '2026-11-21T00:00:00.000Z' })
  const tombs = readTombstones(root)
  assert.deepEqual(tombs.map((item) => [item.number, item.key]), [[9, 'iron-rule-9'], [10, 'iron-rule-10']])
  assert.equal(tombs[0].at, '2026-11-20T00:00:00.000Z')
})

test('manifest 可重建：删 manifest.json 后 nextNumber 不回退（墓碑仍是真源）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-17', number: 17 }), '必须先验证再覆盖正式库。').ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-17' }, { git: false }).ok, true)
  assert.equal(readManifest(root).nextNumber, 18)
  nodeFs.unlinkSync(join(root, MANIFEST_FILE))
  const rebuilt = regenerateManifest(root)
  assert.equal(rebuilt.ok, true, rebuilt.error)
  assert.equal(rebuilt.manifest.nextNumber, 18, '删 manifest 后由墓碑目录重建，不得回落到 1')
  assert.deepEqual(rebuilt.manifest.retired.map((item) => item.number), [17])
})

test('regenerateManifest 单调闸：旧 manifest 里的非法墓碑会让新集合"变小" → retired_shrink 拒绝写', (t) => {
  const root = freshRoot(t)
  mkdirSync(root, { recursive: true })
  // 旧 manifest 带一条无法归一（key 空）的墓碑：归一后被丢掉，新集合不再是旧集合超集。
  writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ nextNumber: 1, retired: [{ key: '', number: 9, at: 'x' }] }, null, 2), 'utf8')
  const got = regenerateManifest(root)
  assert.equal(got.ok, false)
  assert.equal(got.error, 'retired_shrink')
  assert.deepEqual(got.detail.missing.map((item) => item.number), [9])
})

// ---------------------------------------------------------------------------
// 编号不变式 / key=文件名闸
// ---------------------------------------------------------------------------

test('只有 iron-rule 占号：createRule 普通规则 number=null，nextNumber 不被普通规则抬高', (t) => {
  const root = freshRoot(t)
  const iron = createRule({ root, draft: { text: '必须先验证再覆盖正式库。', type: 'iron-rule' } }, { git: false })
  assert.equal(iron.ok, true, iron.error)
  assert.equal(iron.number, 1)
  const plain = createRule({ root, draft: { text: '必须在记忆入库前先去重。', type: 'rule' } }, { git: false })
  assert.equal(plain.ok, true, plain.error)
  assert.equal(plain.number, null, '普通规则不得占号')
  assert.equal(readManifest(root).nextNumber, 2)
  assert.equal(readManifest(root).total, 1)
  const next = createRule({ root, draft: { text: '必须保留审计日志。', type: 'iron-rule' } }, { git: false })
  assert.equal(next.number, 2, '普通规则 number=null 不参与分配')
})

test('key=文件名闸：手改文件名 → readRule 报 key_mismatch，listRules 跳过并标记', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-3', number: 3 }), '必须保留审计日志。').ok, true)
  nodeFs.renameSync(join(root, 'iron-rule-3.md'), join(root, 'wrong-name.md'))
  const got = readRule(root, 'wrong-name')
  assert.equal(got.ok, false)
  assert.equal(got.error, 'key_mismatch')
  assert.equal(got.detail.frontKey, 'iron-rule-3')
  const list = listRules(root)
  assert.equal(list.rules.length, 0, '文件名≠key 的规则不得进入合法列表')
  assert.equal(list.errors.some((item) => item.error === 'key_mismatch'), true)
})

// ---------------------------------------------------------------------------
// 仓库级锁
// ---------------------------------------------------------------------------

test('仓库锁：第二写者超时被拒 repo_locked；释放后可再取', (t) => {
  const root = freshRoot(t)
  const first = acquireRepoLock(root, { timeoutMs: 100 })
  assert.equal(first.ok, true, first.error)
  assert.equal(nodeFs.existsSync(join(root, '.locks', 'repo.lock', 'owner.json')), true)
  const second = acquireRepoLock(root, { timeoutMs: 50 })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'repo_locked')
  assert.equal(Number(second.owner.pid), process.pid)
  first.release()
  const third = acquireRepoLock(root, { timeoutMs: 100 })
  assert.equal(third.ok, true, third.error)
  third.release()
})

test('仓库锁 stale：owner.json 超 120s → 允许接管', (t) => {
  const root = freshRoot(t)
  mkdirSync(join(root, '.locks', 'repo.lock'), { recursive: true })
  writeFileSync(join(root, '.locks', 'repo.lock', 'owner.json'), `${JSON.stringify({ pid: 99999, ts: Date.now() - 130000 })}\n`, 'utf8')
  const got = acquireRepoLock(root, { timeoutMs: 200 })
  assert.equal(got.ok, true, got.error)
  got.release()
})

test('锁 nonce：stale 接管后旧持有者 release 不得删新锁', (t) => {
  const root = freshRoot(t)
  const first = acquireRepoLock(root, { timeoutMs: 50 })
  assert.equal(first.ok, true)
  const ownerFile = join(root, '.locks', 'repo.lock', 'owner.json')
  // 模拟"持锁进程卡住超过 stale"：owner.ts 拨到 130s 前，第二写者接管。
  const staleOwner = JSON.parse(readFileSync(ownerFile, 'utf8'))
  staleOwner.ts = Date.now() - 130000
  writeFileSync(ownerFile, `${JSON.stringify(staleOwner)}\n`, 'utf8')
  const second = acquireRepoLock(root, { timeoutMs: 200 })
  assert.equal(second.ok, true, second.error)
  assert.notEqual(second.owner.nonce, first.owner.nonce, '接管必须换新 nonce')
  const released = first.release()
  assert.equal(released, false, '旧持有者的 release 必须识别出锁已被接管')
  const third = acquireRepoLock(root, { timeoutMs: 50 })
  assert.equal(third.ok, false, '新持有者的锁不得被旧 release 删掉')
  assert.equal(second.release(), true)
})

test('per-key 锁 nonce：stale 接管后旧 release 不删新锁', (t) => {
  const root = freshRoot(t)
  const first = acquireRuleLock(root, 'iron-rule-1', { timeoutMs: 50, staleMs: 1000 })
  assert.equal(first.ok, true, first.error)
  const ownerFile = join(root, '.locks', 'iron-rule-1.lock', 'owner.json')
  const staleOwner = JSON.parse(readFileSync(ownerFile, 'utf8'))
  staleOwner.ts = Date.now() - 5000
  writeFileSync(ownerFile, `${JSON.stringify(staleOwner)}\n`, 'utf8')
  const second = acquireRuleLock(root, 'iron-rule-1', { timeoutMs: 300, staleMs: 1000 })
  assert.equal(second.ok, true, second.error)
  assert.equal(first.release(), false)
  const third = acquireRuleLock(root, 'iron-rule-1', { timeoutMs: 50, staleMs: 1000 })
  assert.equal(third.ok, false, '旧 release 不得删新锁')
  assert.equal(second.release(), true)
})

test('withRepoLock：抛错也释放；lockHeld:true 的 writeRule 不再抢锁', (t) => {
  const root = freshRoot(t)
  assert.throws(() => withRepoLock(root, () => { throw new Error('boom') }), /boom/)
  const after = acquireRepoLock(root, { timeoutMs: 50 })
  assert.equal(after.ok, true, '抛错后锁必须已释放')
  after.release()
  const inside = withRepoLock(root, () => writeDoc(root, frontOf(), '必须先验证再覆盖正式库。', { lockHeld: true }))
  assert.equal(inside.ok, true, inside.error)
})

test('跨进程：持锁期间 createRule 超时 → repo_locked，不写文件', async (t) => {
  const root = freshRoot(t)
  const lock = acquireRepoLock(root, { timeoutMs: 100 })
  assert.equal(lock.ok, true)
  const moduleUrl = pathToFileURL(join(fileURLToPath(new URL('../..', import.meta.url)), 'src/core/rule-store.js')).href
  const script = [
    `import { createRule } from ${JSON.stringify(moduleUrl)}`,
    'const r = createRule({ root: process.argv[1], draft: { text: "必须保留审计日志。", type: "iron-rule" } }, { git: false, timeoutMs: 150 })',
    'console.log(JSON.stringify({ ok: r.ok, error: r.error }))',
  ].join('\n')
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))))
  })
  lock.release()
  assert.equal(JSON.parse(out).error, 'repo_locked')
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.md')), [], '被拒的写不得留下文件')
})

test('并发 create：两进程各自取号，编号不撞、规则都落盘', async (t) => {
  const root = freshRoot(t)
  const moduleUrl = pathToFileURL(join(fileURLToPath(new URL('../..', import.meta.url)), 'src/core/rule-store.js')).href
  const script = [
    `import { createRule } from ${JSON.stringify(moduleUrl)}`,
    'const r = createRule({ root: process.argv[1], draft: { text: process.argv[2], type: "iron-rule" } }, { git: false })',
    'console.log(JSON.stringify({ ok: r.ok, number: r.number, key: r.key }))',
  ].join('\n')
  const run = (text) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, text], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))))
  })
  const [a, b] = await Promise.all([run('必须先验证再覆盖正式库。'), run('必须保留审计日志。')])
  assert.deepEqual([a.ok, b.ok], [true, true])
  assert.deepEqual([a.number, b.number].sort((x, y) => x - y), [1, 2], '两个进程不得分到同一编号')
  assert.equal(listRules(root).rules.length, 2)
})

test('并发 purge：两进程各删一条，两个墓碑都保留（锁内串行，不丢墓碑）', async (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-1', number: 1 }), '必须先验证再覆盖正式库。').ok, true)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-2', number: 2 }), '必须保留审计日志。').ok, true)
  const moduleUrl = pathToFileURL(join(fileURLToPath(new URL('../..', import.meta.url)), 'src/core/rule-store.js')).href
  const script = [
    `import { purgeRule } from ${JSON.stringify(moduleUrl)}`,
    'const r = purgeRule({ root: process.argv[1], key: process.argv[2] }, { git: false })',
    'console.log(JSON.stringify({ ok: r.ok, error: r.error }))',
  ].join('\n')
  const run = (key) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, key], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))))
  })
  const [a, b] = await Promise.all([run('iron-rule-1'), run('iron-rule-2')])
  assert.deepEqual([a.ok, b.ok], [true, true], JSON.stringify([a, b]))
  assert.deepEqual(readTombstones(root).map((item) => item.number), [1, 2], '并发 purge 不得互相覆盖墓碑')
  assert.deepEqual(readManifest(root).retired.map((item) => item.number), [1, 2])
  assert.equal(readManifest(root).nextNumber, 3, '已删编号继续占位')
  assert.deepEqual(readdirSync(root).filter((name) => /^iron-rule-\d+\.md$/.test(name)), [])
})

/** 本机有无 git（真实 git 用例在无 git 环境跳过，不阻塞基线）。 */
function gitInstalled() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('真实 git：purge 单 commit 同时记录删除与墓碑（paths 不含已删文件，走 git rm）', { skip: gitInstalled() ? false : 'git 未安装' }, (t) => {
  const root = freshRoot(t)
  assert.equal(ensureRuleRepo({ root }).ok, true)
  assert.equal(writeRule(root, { front: frontOf({ key: 'iron-rule-4', number: 4 }), text: '必须保留审计日志。' }).ok, true)
  const before = execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const purged = purgeRule({ root, key: 'iron-rule-4' })
  assert.equal(purged.ok, true, purged.error)
  const after = execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  assert.equal(after.length, before.length + 1, 'purge 必须只出一个提交')
  assert.match(after[0], /rule: purge iron-rule-4 \(#4\)/)
  const show = execFileSync('git', ['-C', root, 'show', '--name-status', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
  assert.match(show, /D\s+iron-rule-4\.md/, `提交必须含删除：${show}`)
  assert.match(show, /A\s+retired\/iron-rule-4\.json/, `提交必须含墓碑：${show}`)
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'purge 后工作树必须干净（墓碑/候选/快照不得漏提交）')
})

test('并发 purge 后同 key 再次 purge：墓碑累积编号、number 留最早、nextNumber 不回落', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-3', number: 3 }), '必须保留审计日志。').ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-3' }, { git: false }).ok, true)
  // 同 key 以新编号重建（等于同一条规则第二次作废）：墓碑不得覆盖旧编号。
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-3', number: 5 }), '必须保留审计日志。').ok, true)
  assert.equal(purgeRule({ root, key: 'iron-rule-3' }, { git: false }).ok, true)
  const tombs = readTombstones(root)
  assert.deepEqual(tombs.map((item) => item.number), [3, 5], '同 key 两次 purge 的编号必须都保留')
  const raw = JSON.parse(readFileSync(join(root, 'retired', 'iron-rule-3.json'), 'utf8'))
  assert.equal(raw.number, 3, 'number 必须是较早的那个')
  assert.deepEqual(raw.numbers, [3, 5])
  assert.deepEqual(readManifest(root).retired.map((item) => item.number), [3, 5])
  assert.equal(readManifest(root).nextNumber, 7, 'max(3,5)+1=6 是保留空号，跳到 7；作废编号继续占位')
})

test('真实 git：recover 用 --grep 精确识别已提交事务（只清日志，不回滚）', { skip: gitInstalled() ? false : 'git 未安装' }, (t) => {
  const root = freshRoot(t)
  assert.equal(ensureRuleRepo({ root }).ok, true)
  assert.equal(writeRule(root, { front: frontOf(), text: '必须保留已发布正文。' }).ok, true)
  const id = 'p9999999999999_fffffff9'
  const newText = readFileSync(join(root, 'iron-rule-1.md'), 'utf8')
  writeTxn(root, {
    id, proposalId: id,
    files: [{ key: 'iron-rule-1', path: 'iron-rule-1.md', oldText: '旧正文', newText }],
  })
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
  manifest.marker = 'recover-probe'
  writeFileSync(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const committed = commitRuleChanges(root, `rule: apply ${id} iron-rule-1 (#1)`, { paths: [MANIFEST_FILE] })
  assert.equal(committed.committed, true, committed.error)
  const got = recoverPendingTxn(root)
  assert.equal(got.processed[0].committed, true, '--grep 必须命中本事务的提交说明')
  assert.equal(got.recovered, false)
  assert.deepEqual(listTxns(root), [])
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须保留已发布正文。', '有提交不得回滚')
})

test('recoverPendingTxn：文件内容已变（之后合法写入）→ 只清日志，不覆盖', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计日志。').ok, true)
  const id = 'p3333333333333_ccccccc3'
  writeTxn(root, {
    id, proposalId: id,
    files: [{
      key: 'iron-rule-1',
      path: 'iron-rule-1.md',
      oldText: '---\nkey: iron-rule-1\ntype: iron-rule\nnumber: 1\n---\n\n必须保留旧正文。\n',
      newText: '---\nkey: iron-rule-1\ntype: iron-rule\nnumber: 1\n---\n\n事务中间态正文。\n',
    }],
  })
  // 事务之后又有一次合法写入：文件既不是 oldText 也不是 newText。
  assert.equal(writeDoc(root, frontOf(), '必须保留审计日志。').ok, true)
  const got = recoverPendingTxn(root, { exec: fakeGit().exec })
  assert.equal(got.recovered, false, 'hash 不等时不得回滚')
  assert.equal(got.processed[0].skipped, 1)
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须保留审计日志。')
  assert.deepEqual(listTxns(root), [], '只清日志')
})

test('recoverPendingTxn：循环处理全部待恢复事务（不只第一条）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留旧正文。').ok, true)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-2', number: 2 }), '必须保留旧正文。').ok, true)
  const txn = (id, key, oldText, newText) => ({ id, proposalId: id, files: [{ key, path: `${key}.md`, oldText, newText }] })
  const old1 = readFileSync(join(root, 'iron-rule-1.md'), 'utf8')
  const old2 = readFileSync(join(root, 'iron-rule-2.md'), 'utf8')
  const new1 = old1.replace('必须保留旧正文。', '事务中间态一。')
  const new2 = old2.replace('必须保留旧正文。', '事务中间态二。')
  writeTxn(root, txn('p4444444444444_ddddddd4', 'iron-rule-1', old1, new1))
  writeTxn(root, txn('p5555555555555_eeeeeee5', 'iron-rule-2', old2, new2))
  atomicWriteFile(join(root, 'iron-rule-1.md'), new1)
  atomicWriteFile(join(root, 'iron-rule-2.md'), new2)
  const got = recoverPendingTxn(root, { exec: fakeGit().exec })
  assert.equal(got.recovered, true)
  assert.deepEqual(got.ids, ['p4444444444444_ddddddd4', 'p5555555555555_eeeeeee5'])
  assert.deepEqual(got.processed.map((item) => item.restored), [1, 1])
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须保留旧正文。')
  assert.equal(readRule(root, 'iron-rule-2').rule.text, '必须保留旧正文。')
  assert.deepEqual(listTxns(root), [])
})

test('真实 git：commit 只含显式 paths，预暂存 stray 不得混入提交', { skip: gitInstalled() ? false : 'git 未安装' }, (t) => {
  const root = freshRoot(t)
  assert.equal(ensureRuleRepo({ root }).ok, true)
  writeFileSync(join(root, 'stray.md'), 'stray\n', 'utf8')
  execFileSync('git', ['-C', root, 'add', '--', 'stray.md'])
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
  manifest.marker = 'probe'
  writeFileSync(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const done = commitRuleChanges(root, 'rules: explicit only', { paths: [MANIFEST_FILE] })
  assert.equal(done.ok, true, done.error)
  assert.equal(done.committed, true)
  const names = execFileSync('git', ['-C', root, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  assert.deepEqual(names, [MANIFEST_FILE], `提交必须只含显式 paths，实际：${names.join(',')}`)
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.match(status, /A\s+stray\.md/, '预暂存的 stray.md 必须仍在暂存区、未进提交')
})

// ---------------------------------------------------------------------------
// 事务日志 / 崩溃恢复
// ---------------------------------------------------------------------------

test('事务日志：write/read/list/clear 幂等；坏 id 拒绝', (t) => {
  const root = freshRoot(t)
  const written = writeTxn(root, {
    id: 'p1234567890123_deadbeef',
    proposalId: 'p1234567890123_deadbeef',
    createdAt: '2026-11-23T00:00:00.000Z',
    files: [{ key: 'iron-rule-1', path: 'iron-rule-1.md', oldText: '旧正文' }],
  })
  assert.equal(written.ok, true, written.error)
  assert.deepEqual(listTxns(root), ['p1234567890123_deadbeef'])
  assert.equal(readTxn(root, 'p1234567890123_deadbeef').files[0].oldText, '旧正文')
  assert.equal(writeTxn(root, { id: '../evil', files: [{ path: 'x.md' }] }).error, 'invalid_txn_id')
  assert.equal(clearTxn(root, 'p1234567890123_deadbeef').ok, true)
  assert.deepEqual(listTxns(root), [])
  assert.equal(clearTxn(root, 'p1234567890123_deadbeef').ok, true, '重复清理幂等')
})

test('recoverPendingTxn：有 commit 只清日志，不动已发布文件', (t) => {
  const root = freshRoot(t)
  const id = 'p1111111111111_aaaaaaa1'
  assert.equal(writeDoc(root, frontOf(), '必须保留已发布的新正文。').ok, true)
  const newText = readFileSync(join(root, 'iron-rule-1.md'), 'utf8')
  writeTxn(root, {
    id, proposalId: id,
    files: [{ key: 'iron-rule-1', path: 'iron-rule-1.md', oldText: '旧正文', newText }],
  })
  const git = fakeGit({ logSubjects: [`rule: apply ${id} iron-rule-1 (#1)`] })
  const got = recoverPendingTxn(root, { exec: git.exec })
  assert.equal(got.recovered, false)
  assert.equal(got.ids[0], id)
  assert.deepEqual(listTxns(root), [])
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须保留已发布的新正文。', '有 commit 时不得按 oldText 回滚')
})

test('recoverPendingTxn：无 commit 按 oldText 恢复文件、删除新建文件并重建 manifest', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留旧正文。').ok, true)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-2', number: 2 }), '必须保留审计日志。').ok, true)
  const id = 'p2222222222222_bbbbbbb2'
  // 模拟"写到一半崩了"：rule-1 被改成新正文、rule-2 是本事务新建、manifest 也改了。
  atomicWriteFile(join(root, 'iron-rule-1.md'), readFileSync(join(root, 'iron-rule-1.md'), 'utf8').replace('必须保留旧正文。', '必须保留新正文。'))
  atomicWriteFile(join(root, 'iron-rule-2.md'), readFileSync(join(root, 'iron-rule-2.md'), 'utf8'))
  const oldFile1 = readFileSync(join(root, 'iron-rule-1.md'), 'utf8').replace('必须保留旧正文。', '必须保留新正文。')
  const newFile2 = readFileSync(join(root, 'iron-rule-2.md'), 'utf8')
  writeTxn(root, {
    id,
    proposalId: id,
    files: [
      { key: 'iron-rule-1', path: 'iron-rule-1.md', oldText: '---\nkey: iron-rule-1\ntype: iron-rule\nnumber: 1\npriority: P0\nscope: global\nmodality: must\nstatus: active\ncreated: 2026-11-23\nupdated: 2026-11-23\nversion: 1\n---\n\n必须保留旧正文。\n', newText: oldFile1 },
      { key: 'iron-rule-2', path: 'iron-rule-2.md', oldText: null, newText: newFile2 },
    ],
  })
  nodeFs.unlinkSync(join(root, 'iron-rule-2.md'))
  const git = fakeGit({ logSubjects: ['rules: iron-rule-1 v2'] })
  const got = recoverPendingTxn(root, { exec: git.exec })
  assert.equal(got.recovered, true)
  assert.equal(got.id, id)
  assert.deepEqual(listTxns(root), [])
  assert.equal(got.processed[0].restored, 1, '只有 hash 等于 newText 的文件才回滚')
  const restored = readRule(root, 'iron-rule-1')
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.rule.text, '必须保留旧正文。')
  assert.equal(manifestOf(root).keys.includes('iron-rule-2'), false, '新事务残留文件必须被删')
})

function manifestOf(root) {
  return JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
}

// ---------------------------------------------------------------------------
// git 卫生：显式路径 / purge 单 commit / commit 失败回滚
// ---------------------------------------------------------------------------

test('purgeRule：显式路径单 commit（墓碑 + manifest），已删文件走 git rm 不撞 pathspec', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-5', number: 5 }), '必须保留审计日志。').ok, true)
  const git = fakeGit()
  const purged = purgeRule({ root, key: 'iron-rule-5' }, { exec: git.exec })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(git.commitMessages().length, 1, `purge 必须只有一个提交，实际 ${git.commitMessages().join(' | ')}`)
  assert.match(git.commitMessages()[0], /rule: purge iron-rule-5 \(#5\)/)
  assert.equal(git.calls.some((line) => line.includes('rm --ignore-unmatch')), true, '已删路径必须走 git rm 记录删除')
  assert.equal(git.calls.some((line) => line.includes('add -A')), false, '不得使用 add -A')
  assert.equal(nodeFs.existsSync(join(root, 'retired', 'iron-rule-5.json')), true)
})

test('commit 失败回滚：createRule 删新文件并复原 manifest；返回 commit_failed', (t) => {
  const root = freshRoot(t)
  const git = fakeGit({ failCommit: true })
  const created = createRule({ root, draft: { text: '必须先验证再覆盖正式库。', type: 'iron-rule' } }, { exec: git.exec })
  assert.equal(created.ok, false)
  assert.equal(created.error, 'commit_failed')
  assert.equal(created.rolledBack, true)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-1.md')), false, '提交失败不得留下半条规则')
  assert.equal(readManifest(root).nextNumber, 1)
  assert.equal(git.calls.some((line) => line.includes('reset -q')), true, '必须清 git index')
})

test('commit 失败回滚：purgeRule 恢复文件、删墓碑、复原 manifest', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-7', number: 7 }), '必须保留审计日志。').ok, true)
  const git = fakeGit({ failCommit: true })
  const purged = purgeRule({ root, key: 'iron-rule-7' }, { exec: git.exec })
  assert.equal(purged.ok, false)
  assert.equal(purged.error, 'commit_failed')
  assert.equal(purged.rolledBack, true)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-7.md')), true, '提交失败必须恢复被删文件')
  assert.equal(nodeFs.existsSync(join(root, 'retired', 'iron-rule-7.json')), false, '回滚必须删掉本次墓碑')
  assert.equal(readRule(root, 'iron-rule-7').rule.text, '必须保留审计日志。')
  assert.deepEqual(readManifest(root).retired, [])
  assert.equal(readManifest(root).nextNumber, 8)
})

test('commit 失败回滚：updateRule 正文/版本复原、本事务快照删除', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const git = fakeGit({ failCommit: true })
  const updated = updateRule({ root, key: 'iron-rule-1', patch: { text: '必须保留审计日志。' } }, { exec: git.exec })
  assert.equal(updated.ok, false)
  assert.equal(updated.error, 'commit_failed')
  assert.equal(readRule(root, 'iron-rule-1').rule.text, '必须先验证再覆盖正式库。')
  assert.equal(readRule(root, 'iron-rule-1').rule.front.version, 1)
  const history = readdirSync(join(root, 'history', 'iron-rule-1')).filter((name) => name.endsWith('.md'))
  assert.deepEqual(history, [], '提交失败不得留下幻影历史快照')
})

test('resetGitIndex：显式 paths 清 index、空 paths 不调用 git、越界路径被归一丢弃', (t) => {
  const root = freshRoot(t)
  const git = fakeGit()
  const none = resetGitIndex(root, [], { exec: git.exec })
  assert.equal(none.ok, true)
  assert.deepEqual(none.paths, [])
  assert.equal(git.calls.length, 0, '空 paths 不得调用 git reset')

  const got = resetGitIndex(root, ['iron-rule-1.md', '../escape.md', 'manifest.json'], { exec: git.exec })
  assert.equal(got.ok, true, got.error)
  assert.deepEqual(got.paths, ['iron-rule-1.md', 'manifest.json'], '越界路径必须丢弃')
  const resets = git.calls.filter((line) => line.includes('reset -q'))
  assert.equal(resets.length, 1)
  assert.match(resets[0], /reset -q -- iron-rule-1\.md manifest\.json/)
  assert.equal(git.calls.some((line) => line.includes('reset --hard')), false, '禁止 reset --hard')
})

test('gitCommit：无 paths 一律不提交（add -A 已删除，不再兜底）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计日志。').ok, true)
  const git = fakeGit()
  const none = gitCommit(root, 'rules: noop', { exec: git.exec })
  assert.equal(none.ok, true)
  assert.equal(none.committed, false)
  assert.equal(git.calls.length, 0, '缺 paths 时不得 add -A，也不得调用任何 git 子命令')
})

test('commitRuleChanges：paths 为空不提交；相对路径归一；reject 越界路径', (t) => {
  const root = freshRoot(t)
  const git = fakeGit()
  const none = commitRuleChanges(root, 'rules: noop', { exec: git.exec, paths: [] })
  assert.equal(none.ok, true)
  assert.equal(none.committed, false)
  assert.equal(git.calls.length, 0, '空 paths 不得调用任何 git 子命令')
  assert.equal(writeDoc(root, frontOf(), '必须保留审计日志。').ok, true)
  const bad = commitRuleChanges(root, 'rules: x', { exec: git.exec, paths: ['../escape.md'] })
  assert.equal(bad.committed, false, '越界路径必须被归一掉，不得提交')
})

// ---------------------------------------------------------------------------
// 解析/写入闸（R8-06/14）
// ---------------------------------------------------------------------------

test('解析闸：块标量/锚点拒绝、>64KB 拒绝、坏 UTF-8 报 invalid_encoding', (t) => {
  const block = parseRuleDocument('---\nkey: x\ntype: rule\nconditions: |\n---\n\n必须保留。\n')
  assert.equal(block.ok, false)
  assert.match(block.error, /^block_scalar_unsupported:/)
  const anchor = parseRuleDocument('---\nkey: x\ntype: rule\nconditions: &a [x]\n---\n\n必须保留。\n')
  assert.equal(anchor.ok, false)
  assert.match(anchor.error, /^unsupported_value:/)

  const root = freshRoot(t)
  const big = join(root, 'huge.md')
  writeFileSync(big, `---\nkey: huge\ntype: rule\n---\n\n${'必'.repeat(Math.ceil(RULE_FILE_MAX / 3) + 10)}\n`, 'utf8')
  assert.ok(readFileSync(big).length > RULE_FILE_MAX)
  assert.equal(readRule(root, 'huge').error, 'file_too_large')

  const broken = join(root, 'badutf8.md')
  writeFileSync(broken, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]))
  assert.equal(readRule(root, 'badutf8').error, 'invalid_encoding')
})

test('校验闸：number>999 拒绝、summary>120 拒绝、正文含 HTML 注释标记拒绝', () => {
  const tooBig = validateRule({ ...frontOf({ type: 'iron-rule' }), number: RULE_NUMBER_MAX + 1 }, '必须保留审计日志。')
  assert.deepEqual(tooBig.errors.map((err) => err.code), ['number_too_large'])
  const longSummary = validateRule({ ...frontOf(), summary: '摘'.repeat(121) }, '必须保留审计日志。')
  assert.deepEqual(longSummary.errors.map((err) => err.code), ['summary_too_long'])
  const marker = validateRule(frontOf(), '必须保留审计日志。<!-- whale-memory:rules:end -->')
  assert.deepEqual(marker.errors.map((err) => err.code), ['html_comment_marker'])
})

test('baseDir 非字符串抛 TypeError（不把对象写成 [object Object] 目录）', (t) => {
  const root = freshRoot(t)
  assert.throws(() => readRule({ bad: true }, 'iron-rule-1'), TypeError)
  assert.throws(() => listRules([root]), TypeError)
  assert.throws(() => createRule({ root: { bad: true }, draft: { text: '必须保留审计日志。' } }, { git: false }), TypeError)
})

test('history 同毫秒排序按（戳,序号）数值：-10 不比 -2 旧', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计日志。').ok, true)
  const dir = join(root, 'history', 'iron-rule-1')
  mkdirSync(dir, { recursive: true })
  const stamp = '20261123010203000'
  for (const [rev, text] of [[stamp, '旧'], [`${stamp}-2`, '中间'], [`${stamp}-10`, '最新']]) {
    writeFileSync(join(dir, `${rev}.md`), `---\nkey: iron-rule-1\ntype: iron-rule\nnumber: 1\npriority: P0\nscope: global\nmodality: must\nstatus: active\ncreated: 2026-11-23\nupdated: 2026-11-23\nversion: 1\n---\n\n${text}\n`, 'utf8')
  }
  const revs = readHistory(root, 'iron-rule-1').entries.map((entry) => entry.rev)
  assert.deepEqual(revs, [`${stamp}-10`, `${stamp}-2`, stamp], '同毫秒序号必须数值比较（10 > 2）')
})
