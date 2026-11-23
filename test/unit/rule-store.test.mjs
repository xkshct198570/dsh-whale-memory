/**
 * 规则仓储单测（R3a + R5）：strict YAML 子集、校验、原子写、历史、manifest、git 降级，
 * 以及编辑/版本 diff/按版本回写（updateRule / diffLines / resolveRevision / revertRule）。
 * 只碰临时目录，不访问真实 `$DSH_HOME`、不联网；git 用注入 exec 模拟，不依赖本机安装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HISTORY_KEEP,
  IMMUTABLE_RULE_FIELDS,
  MANIFEST_FILE,
  atomicWriteFile,
  createRule,
  defaultRuleRoot,
  diffLines,
  ensureRuleRepo,
  listRules,
  nextRuleNumber,
  normalizeRuleDoc,
  parseRuleDocument,
  purgeRule,
  readHistory,
  readManifest,
  readRule,
  readSnapshot,
  regenerateManifest,
  resolveRevision,
  revertRule,
  serializeRuleDocument,
  updateRule,
  validateRule,
  writeRule,
} from '../../src/core/rule-store.js'

/** 每个用例独立临时仓库。 */
function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-rules-'))
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }))
  return root
}

function frontOf(overrides = {}) {
  return {
    key: 'rule-1',
    type: 'rule',
    number: 1,
    priority: 'P1',
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
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

function writeDoc(root, front, text, opts = {}) {
  return writeRule(root, { front, text }, { git: false, ...opts })
}

test('front matter 全字段 round-trip：引号/数字/null/bool/行内数组都不丢', () => {
  const front = frontOf({
    key: 'rule-9',
    number: 9,
    priority: 'P2',
    scope: 'workspace:/tmp/ws-9',
    role: 'reviewer',
    modality: 'must_not',
    action: '删除源文件',
    object: '过程稿',
    conditions: ['仅限临时目录', '保留 sha256'],
    exceptions: ['只读检查', '人工确认'],
    status: 'active',
    merged_into: 'rule-8',
    superseded_by: '',
    version: 3,
    origin: 'owner:chat',
  })
  const body = '禁止删除源文件。'
  const encoded = serializeRuleDocument({ front, text: body })
  assert.equal(encoded.ok, true, encoded.error)
  const parsed = parseRuleDocument(encoded.text)
  assert.equal(parsed.ok, true, parsed.error)
  assert.deepEqual(parsed.front, front)
  assert.equal(parsed.text, body)
  assert.equal(typeof parsed.bodyStart, 'number')
  assert.ok(parsed.bodyStart > 0)
})

test('parser 支持注释、单引号、null/true/false/~ 与行内数字数组', () => {
  const source = [
    '---',
    '# 手写注释不算字段',
    'key: rule-2',
    "type: 'rule'",
    'number: 2',
    'priority: P0',
    'scope: global',
    'role: null',
    'modality: must',
    'conditions: [1, "带,逗号", true, null]',
    'status: active',
    'created: 2026-11-22',
    'updated: 2026-11-22',
    'version: 1',
    'origin: ~',
    '---',
    '',
    '必须保留审计行。',
    '',
  ].join('\n')
  const parsed = parseRuleDocument(source)
  assert.equal(parsed.ok, true, parsed.error)
  assert.equal(parsed.front.role, null)
  assert.equal(parsed.front.origin, null)
  assert.deepEqual(parsed.front.conditions, [1, '带,逗号', true, null])
  assert.equal(parsed.text, '必须保留审计行。')
})

test('未知字段不静默丢弃：序列化与校验都明确报 unknown_field', () => {
  const front = frontOf({ legacy: true })
  const encoded = serializeRuleDocument({ front, text: '必须保留审计行。' })
  assert.equal(encoded.ok, false)
  assert.match(encoded.error, /unknown_field/)
  const check = validateRule(normalizeRuleDoc(front, '必须保留审计行。').front, '必须保留审计行。')
  assert.equal(check.ok, false)
  assert.ok(check.errors.some((e) => e.code === 'unknown_field' && e.field === 'legacy'))
})

test('坏枚举/保留号/非法 scope → 各自明确错误码', () => {
  const cases = [
    [{ type: 'law' }, 'invalid_type'],
    [{ modality: 'should' }, 'invalid_modality'],
    [{ priority: 'P9' }, 'invalid_priority'],
    [{ status: 'weird' }, 'invalid_status'],
    [{ type: 'iron-rule', number: 0 }, 'invalid_number'],
    [{ type: 'iron-rule', number: 6 }, 'number_reserved'],
    [{ scope: 'workspace:relative/path' }, 'scope_workspace_relative'],
    [{ scope: 'role:' }, 'scope_role_invalid'],
    [{ version: 0 }, 'invalid_version'],
  ]
  for (const [patch, code] of cases) {
    const doc = normalizeRuleDoc(frontOf(patch), '必须保留审计行。')
    const check = validateRule(doc.front, doc.text)
    assert.equal(check.ok, false, `${JSON.stringify(patch)} 应失败`)
    assert.ok(check.errors.some((e) => e.code === code), `${JSON.stringify(patch)} 应报 ${code}，实际 ${JSON.stringify(check.errors)}`)
  }
})

test('正文校验：空/超长/模糊词/理由句/隐私/非指令各自拒绝', () => {
  const vague = validateRule(normalizeRuleDoc(frontOf({ type: 'iron-rule' }), '必须尽量每天备份。').front, '必须尽量每天备份。')
  assert.ok(vague.errors.some((e) => e.code === 'vague_word'))
  const reason = validateRule(normalizeRuleDoc(frontOf({ type: 'iron-rule' }), '必须每天备份，因为磁盘会坏。').front, '必须每天备份，因为磁盘会坏。')
  assert.ok(reason.errors.some((e) => e.code === 'reason_sentence'))
  const privacy = validateRule(normalizeRuleDoc(frontOf(), '必须保存 sk-abcd1234 这条密钥。').front, '必须保存 sk-abcd1234 这条密钥。')
  assert.ok(privacy.errors.some((e) => e.code === 'privacy'))
  const long = `必须${'备'.repeat(520)}`
  const tooLong = validateRule(normalizeRuleDoc(frontOf(), long).front, long)
  assert.ok(tooLong.errors.some((e) => e.code === 'body_too_long'))
  const descriptive = validateRule(normalizeRuleDoc(frontOf(), '今天下午开会。').front, '今天下午开会。')
  assert.ok(descriptive.errors.some((e) => e.code === 'not_imperative'))
  const empty = validateRule(normalizeRuleDoc(frontOf(), '').front, '')
  assert.ok(empty.errors.some((e) => e.code === 'body_empty'))
})

test('manifest 编号：已有 17 → 18；空号 6 永不分配；空仓从 1 开始', (t) => {
  assert.equal(nextRuleNumber([]), 1)
  assert.equal(nextRuleNumber([5]), 7, 'max=5 时下一个是 6，但 6 是保留空号')
  assert.equal(nextRuleNumber([1, 5]), 7)
  assert.equal(nextRuleNumber([17]), 18)

  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'rule-5', type: 'iron-rule', number: 5 }), '必须执行第五项检查。').ok, true)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-17', type: 'iron-rule', number: 17 }), '必须先验证再覆盖正式库。').ok, true)
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
  assert.equal(manifest.nextNumber, 18)
  assert.equal(manifest.total, 2)
  assert.deepEqual(manifest.byStatus, { active: 2 })
  assert.deepEqual(manifest.keys, ['rule-5', 'iron-rule-17'])
})

test('同 key 并发/连续写不产生半文件，历史每次一份', async (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先做第一版检查。').ok, true)
  const writes = Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => writeDoc(
    root,
    frontOf({ version: i + 2 }),
    `必须先做第 ${i + 2} 版检查。`,
  )))
  const results = await Promise.all(writes)
  for (const result of results) assert.equal(result.ok, true, result.error)
  const got = readRule(root, 'rule-1')
  assert.equal(got.ok, true)
  assert.match(got.rule.text, /^必须先做第 \d 版检查。$/)
  const history = readHistory(root, 'rule-1')
  assert.equal(history.ok, true)
  assert.equal(history.entries.length, 8, '首版 + 7 次覆盖 = 8 份快照')
})

test('跨进程并发写同一 key：锁内串行，文件始终完整、快照不丢', async (t) => {
  const root = freshRoot(t)
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const moduleUrl = pathToFileURL(join(repoRoot, 'src/core/rule-store.js')).href
  const script = [
    `import { writeRule } from ${JSON.stringify(moduleUrl)}`,
    'const root = process.argv[1]',
    'const v = Number(process.argv[2])',
    "const r = writeRule(root, { front: { key: 'rule-1', type: 'rule', number: 1, priority: 'P1',",
    "  scope: 'global', modality: 'must', status: 'active', created: '2026-11-22',",
    "  updated: '2026-11-22', version: v, origin: 'unit' }, text: '必须先做第 ' + v + ' 版检查。' },",
    '  { git: false })',
    "if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1) }",
  ].join('\n')
  const runs = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, String(i + 1)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stderr }))
  })))
  for (const run of runs) assert.equal(run.code, 0, run.stderr)
  const got = readRule(root, 'rule-1')
  assert.equal(got.ok, true, JSON.stringify(got.detail))
  assert.match(got.rule.text, /^必须先做第 [1-4] 版检查。$/)
  const history = readHistory(root, 'rule-1')
  assert.equal(history.entries.length, 3, '4 个进程串行覆盖 = 3 份旧版快照')
})

test('原子写失败不破坏旧文件；tmp 被清理', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留第一版正文。').ok, true)
  // 按目标文件名定位失败点（不数调用序号）：只有写目标正文那一次 rename 落 `rule-1.md`。
  const badFs = {
    ...nodeFs,
    renameSync(from, to) {
      if (String(to).endsWith('/rule-1.md')) throw new Error('rename blocked')
      return nodeFs.renameSync(from, to)
    },
  }
  const failed = writeDoc(root, frontOf({ version: 2 }), '必须替换成第二版正文。', { fs: badFs })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'write_failed')
  assert.match(failed.detail, /rename blocked/)
  const got = readRule(root, 'rule-1')
  assert.equal(got.rule.text, '必须保留第一版正文。')
  assert.deepEqual(readdirSync(root).filter((n) => n.includes('.tmp-')), [])
  // R9-03：失败的写尝试不得留下"幻影快照"（history 里没有本次 rev）。
  const historyDir = join(root, 'history', 'rule-1')
  assert.deepEqual(existsSync(historyDir) ? readdirSync(historyDir) : [], [])
})

test('atomicWriteFile：正常写覆盖、失败保留原内容', (t) => {
  const root = freshRoot(t)
  const file = join(root, 'x.md')
  writeFileSync(file, 'old', 'utf8')
  assert.equal(atomicWriteFile(file, 'new').ok, true)
  assert.equal(readFileSync(file, 'utf8'), 'new')
  const bad = atomicWriteFile(file, 'bad', { fs: { ...nodeFs, renameSync() { throw new Error('no rename') } } })
  assert.equal(bad.ok, false)
  assert.equal(readFileSync(file, 'utf8'), 'new')
})

test('历史只保留 20 份；rollback 恢复正文与 front', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须执行第 1 版检查。').ok, true)
  assert.equal(writeDoc(root, frontOf({ version: 2 }), '必须执行第 2 版检查。').ok, true)
  for (let v = 3; v <= 25; v += 1) {
    assert.equal(writeDoc(root, frontOf({ version: v, priority: v % 2 ? 'P0' : 'P2' }), `必须执行第 ${v} 版检查。`).ok, true)
  }
  const history = readHistory(root, 'rule-1')
  assert.equal(history.ok, true)
  assert.equal(history.entries.length, HISTORY_KEEP)

  const target = history.entries[3]
  const snap = readSnapshot(root, 'rule-1', target.rev)
  assert.equal(snap.ok, true, snap.error)
  assert.ok(snap.rule.front.version >= 1, '快照必须能还原出对应版本的 front')
  assert.match(snap.rule.text, /必须执行第 \d+ 版检查。/)
})

test('purgeRule：删文件 + 最后一版 history 快照 + 墓碑，nextNumber 不回收（删17→18，删18→19）', (t) => {
  const root = freshRoot(t)
  const text = '必须先验证再覆盖正式库。'
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-17', type: 'iron-rule', number: 17 }), text).ok, true)
  assert.equal(readManifest(root).nextNumber, 18)

  const purged = purgeRule({ root, key: 'iron-rule-17', now: Date.UTC(2026, 10, 22, 15, 30, 0) }, { git: false })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(purged.key, 'iron-rule-17')
  assert.equal(purged.number, 17)
  assert.equal(purged.version, 1)
  assert.match(purged.historySnapshot, /^\d{17}/, '必须返回 history 快照 rev')

  // 文件物理删除；详情接口回到 rule_not_found。
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-17.md')), false)
  assert.equal(readRule(root, 'iron-rule-17').error, 'rule_not_found')

  // 删除前最后一版仍在 history，可追溯。
  const history = readHistory(root, 'iron-rule-17')
  assert.equal(history.ok, true)
  assert.equal(history.entries.length, 1)
  assert.equal(history.entries[0].rev, purged.historySnapshot)
  assert.ok(history.entries[0].text.includes(text))

  // 墓碑进 manifest；编号继续占位，删最高号也不回落。
  const manifest = readManifest(root)
  assert.deepEqual(manifest.retired.map((item) => [item.key, item.number]), [['iron-rule-17', 17]])
  assert.equal(manifest.nextNumber, 18)
  assert.equal(manifest.total, 0, '墓碑不是规则，不能虚增 total')

  // 删 17 后新建仍分配 18（不回收到 1 或 17）。
  const created = createRule({ root, draft: { text: '必须保留审计日志。', type: 'iron-rule' } }, { git: false })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.number, 18)
  assert.equal(created.key, 'iron-rule-18')

  // 再删新建的 18：下一个编号仍是 19（墓碑 17/18 都占位）。
  const purgedAgain = purgeRule({ root, key: 'iron-rule-18' }, { git: false })
  assert.equal(purgedAgain.ok, true, purgedAgain.error)
  assert.equal(readManifest(root).nextNumber, 19)
  assert.deepEqual(readManifest(root).retired.map((item) => item.number), [17, 18])
  const next = createRule({ root, draft: { text: '必须保留审计行。', type: 'iron-rule' } }, { git: false })
  assert.equal(next.ok, true, next.error)
  assert.equal(next.number, 19, '连续 purge 后编号仍单调递增')
})

test('purgeRule：安全行 number=0 只删文件、不写墓碑、不压回 nextNumber', (t) => {
  const root = freshRoot(t)
  const safety = frontOf({
    key: 'iron-rule-safety',
    type: 'iron-rule',
    number: 0,
    modality: 'only',
    action: '存放',
    object: '认证凭据（token）',
    conditions: ['认证凭据存用'],
  })
  const text = '认证凭据（token）只准走环境变量或 DPAPI；禁止落在台账／脚本／日志明文里。'
  assert.equal(writeDoc(root, safety, text).ok, true)
  assert.equal(readManifest(root).nextNumber, 1)

  const purged = purgeRule({ root, key: 'iron-rule-safety' }, { git: false })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(purged.number, 0)
  assert.equal(nodeFs.existsSync(join(root, 'iron-rule-safety.md')), false)
  const manifest = readManifest(root)
  assert.deepEqual(manifest.retired, [], 'number=0 无编号，不进墓碑')
  assert.equal(manifest.nextNumber, 1, '安全行不占号，nextNumber 不得因删除被压成 2')
  assert.equal(manifest.unnumbered, 0)
})

test('purgeRule：git 不可用降级 fs.unlinkSync；文件照样删除、commit 记录降级原因', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'rule-4', type: 'iron-rule', number: 4 }), '必须保留审计行。').ok, true)
  const noGit = () => {
    const err = new Error('spawn git ENOENT')
    err.code = 'ENOENT'
    throw err
  }
  const purged = purgeRule({ root, key: 'rule-4' }, { exec: noGit })
  assert.equal(purged.ok, true, purged.error)
  assert.equal(nodeFs.existsSync(join(root, 'rule-4.md')), false)
  assert.equal(purged.commit.ok, false)
  assert.equal(purged.commit.error, 'git_unavailable')
  assert.equal(readManifest(root).retired[0].number, 4)
})

test('purgeRule：重复 purge → rule_not_found，墓碑不重复堆积', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'rule-2', type: 'iron-rule', number: 2 }), '必须保留审计行。').ok, true)
  assert.equal(purgeRule({ root, key: 'rule-2' }, { git: false }).ok, true)
  const again = purgeRule({ root, key: 'rule-2' }, { git: false })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'rule_not_found')
  assert.equal(readManifest(root).retired.length, 1)
})

test('ensureRuleRepo：建目录/README/manifest；git 缺失只降级不抛', (t) => {
  const root = freshRoot(t)
  const noGit = () => { const err = new Error('spawn git ENOENT'); err.code = 'ENOENT'; throw err }
  const result = ensureRuleRepo({ root, exec: noGit })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.git.available, false)
  assert.equal(result.git.error, 'git_unavailable')
  assert.equal(nodeFs.existsSync(join(root, 'proposals')), true)
  assert.equal(nodeFs.existsSync(join(root, 'history')), true)
  assert.equal(nodeFs.existsSync(join(root, 'README.md')), true)
  assert.equal(nodeFs.existsSync(join(root, MANIFEST_FILE)), true)
})

test('defaultRuleRoot：DSH_HOME 优先，否则 ~/.dsh/rules', () => {
  assert.equal(defaultRuleRoot({ env: { DSH_HOME: '/tmp/dsh-home-x' }, home: '/tmp/home-x' }), '/tmp/dsh-home-x/rules')
  assert.equal(defaultRuleRoot({ env: {}, home: '/tmp/home-x' }), '/tmp/home-x/.dsh/rules')
})

test('key 是路径安全边界：越界 key 在建目录/加锁前就被拒绝', (t) => {
  const root = freshRoot(t)
  const bad = writeDoc(root, frontOf({ key: '../evil' }), '必须保留审计行。')
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'invalid_rule')
  assert.equal(nodeFs.existsSync(join(root, '..', 'evil.md')), false)
  assert.equal(readHistory(root, '../evil').error, 'invalid_key')
  assert.equal(readRule(root, '../evil').error, 'invalid_key')
})

test('listRules：坏文件进 errors，不拖垮合法规则', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计行。').ok, true)
  writeFileSync(join(root, 'broken.md'), '---\nkey: broken\ntype: iron-rule\nnumber: nope\n---\n\n必须保留。\n', 'utf8')
  const list = listRules(root)
  assert.equal(list.ok, true)
  assert.equal(list.rules.length, 1)
  assert.equal(list.errors.length, 1)
  assert.equal(list.errors[0].file.endsWith('broken.md'), true)
})

test('regenerateManifest 幂等：两次生成 keys/byStatus 稳定', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计行。').ok, true)
  const a = regenerateManifest(root)
  const b = regenerateManifest(root)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.deepEqual(a.manifest.keys, b.manifest.keys)
  assert.deepEqual(a.manifest.byStatus, b.manifest.byStatus)
})

// ---------------------------------------------------------------------------
// R5：编辑 / 版本 diff / 回滚（updateRule / diffLines / resolveRevision / revertRule）
// ---------------------------------------------------------------------------

/**
 * 假 git：rev-parse 回答"在仓库里"；diff --cached 用退出码 1 表示有暂存差异；
 * commit 记下 `-m` 消息。全部经 execFileSync 同签名注入，测试不依赖本机 git 配置。
 */
function fakeGit() {
  const calls = []
  const exec = (file, args) => {
    const argv = Array.isArray(args) ? args : []
    calls.push({ file, argv })
    if (argv.includes('rev-parse')) return 'true\n'
    if (argv.includes('--cached')) {
      const err = new Error('staged diff')
      err.status = 1
      throw err
    }
    if (argv.includes('commit')) return 'committed\n'
    return ''
  }
  return {
    exec,
    commitMessages: () => calls
      .filter((call) => call.argv.includes('commit'))
      .map((call) => call.argv[call.argv.indexOf('-m') + 1]),
  }
}

test('updateRule：正文编辑 version+1、写前历史快照、返回新规则', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const updated = updateRule({ root, key: 'rule-1', patch: { text: '必须先备份再覆盖正式库。' } }, { git: false })
  assert.equal(updated.ok, true, updated.error)
  assert.equal(updated.changed, true)
  assert.equal(updated.previousVersion, 1)
  assert.equal(updated.version, 2)
  assert.equal(updated.rule.front.version, 2)
  assert.equal(updated.rule.text, '必须先备份再覆盖正式库。')
  const onDisk = readRule(root, 'rule-1')
  assert.equal(onDisk.rule.front.version, 2)
  assert.equal(onDisk.rule.text, '必须先备份再覆盖正式库。')
  const history = readHistory(root, 'rule-1')
  assert.equal(history.entries.length, 1, '写前旧版必须留快照')
  assert.equal(readSnapshot(root, 'rule-1', history.entries[0].rev).rule.text, '必须先验证再覆盖正式库。')
})

test('updateRule：git 提交消息为 rule: update <key> v<n>（注入 exec，不依赖真实 git）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const fake = fakeGit()
  const updated = updateRule({ root, key: 'rule-1', patch: { text: '必须保留审计行。' } }, { exec: fake.exec })
  assert.equal(updated.ok, true, updated.error)
  assert.deepEqual(updated.commit, { ok: true, committed: true, message: 'rule: update rule-1 v2' })
  assert.deepEqual(fake.commitMessages(), ['rule: update rule-1 v2'])
})

test('updateRule：key/type/number/created 一律 immutable_field，文件不动', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf({ key: 'iron-rule-1', type: 'iron-rule' }), '必须先验证再覆盖正式库。').ok, true)
  for (const field of IMMUTABLE_RULE_FIELDS) {
    const updated = updateRule({ root, key: 'iron-rule-1', patch: { [field]: field === 'number' ? 2 : 'x' } }, { git: false })
    assert.equal(updated.ok, false, `${field} 必须拒绝`)
    assert.equal(updated.error, 'immutable_field')
    assert.equal(updated.detail.field, field)
  }
  const got = readRule(root, 'iron-rule-1')
  assert.equal(got.rule.front.number, 1)
  assert.equal(got.rule.front.version, 1)
})

test('updateRule：未知字段/非对象补丁 → invalid_patch', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const unknown = updateRule({ root, key: 'rule-1', patch: { title: '偷偷改标题' } }, { git: false })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, 'invalid_patch')
  assert.equal(unknown.detail.field, 'title')
  for (const patch of [null, [], 'text']) {
    const bad = updateRule({ root, key: 'rule-1', patch }, { git: false })
    assert.equal(bad.ok, false, JSON.stringify(patch))
    assert.equal(bad.error, 'invalid_patch')
  }
  const missing = updateRule({ root, key: 'rule-404', patch: { text: '必须存在。' } }, { git: false })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'rule_not_found')
})

test('updateRule：非法 scope / 铁律模糊词 / 超长正文都走同一 validateRule → invalid_rule', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const scope = updateRule({ root, key: 'rule-1', patch: { scope: 'workspace:relative/path' } }, { git: false })
  assert.equal(scope.ok, false)
  assert.equal(scope.error, 'invalid_rule')
  assert.ok(scope.detail.some((item) => item.code === 'scope_workspace_relative'))

  const ironRoot = freshRoot(t)
  assert.equal(writeDoc(ironRoot, frontOf({ key: 'iron-1', type: 'iron-rule', number: 1 }), '必须先验证再覆盖正式库。').ok, true)
  const vague = updateRule({ root: ironRoot, key: 'iron-1', patch: { text: '必须尽量每天备份。' } }, { git: false })
  assert.equal(vague.ok, false)
  assert.equal(vague.error, 'invalid_rule')
  assert.ok(vague.detail.some((item) => item.code === 'vague_word'))

  const long = `必须${'备'.repeat(520)}`
  const tooLong = updateRule({ root, key: 'rule-1', patch: { text: long } }, { git: false })
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.detail.some((item) => item.code === 'body_too_long'))
  assert.equal(readRule(root, 'rule-1').rule.front.version, 1, '失败不得推进版本')
})

test('updateRule：status 只允许 active↔retired，superseded 由合并链路写', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const retired = updateRule({ root, key: 'rule-1', patch: { status: 'retired' } }, { git: false })
  assert.equal(retired.ok, true, retired.error)
  assert.equal(retired.rule.front.status, 'retired')
  assert.equal(retired.version, 2)
  assert.equal(readRule(root, 'rule-1').ok, true, '退役不得物理删除文件')

  const back = updateRule({ root, key: 'rule-1', patch: { status: 'active' } }, { git: false })
  assert.equal(back.ok, true, back.error)
  assert.equal(back.rule.front.status, 'active')
  assert.equal(back.version, 3)

  const superseded = updateRule({ root, key: 'rule-1', patch: { status: 'superseded' } }, { git: false })
  assert.equal(superseded.ok, false)
  assert.equal(superseded.error, 'invalid_patch')
  assert.equal(superseded.detail.reason, 'invalid_status_transition')
})

test('updateRule：无实质修改返回 changed:false 且不推进版本/不写快照', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const same = updateRule({ root, key: 'rule-1', patch: { text: '必须先验证再覆盖正式库。' } }, { git: false })
  assert.equal(same.ok, true, same.error)
  assert.equal(same.changed, false)
  assert.equal(same.version, 1)
  assert.equal(same.commit, null)
  assert.equal(readHistory(root, 'rule-1').entries.length, 0)
})

test('updateRule：git 不可用时只写文件（commit 降级，不抛）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const noGit = () => { const err = new Error('spawn git ENOENT'); err.code = 'ENOENT'; throw err }
  const updated = updateRule({ root, key: 'rule-1', patch: { text: '必须保留审计行。' } }, { exec: noGit })
  assert.equal(updated.ok, true, updated.error)
  assert.equal(updated.commit.ok, false)
  assert.equal(updated.commit.committed, false)
  assert.equal(updated.commit.error, 'git_unavailable')
  assert.equal(readRule(root, 'rule-1').rule.text, '必须保留审计行。')
})

test('updateRule：中途失败用写前快照回滚（manifest 失败场景）', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  // 失败点按语义定位：正文已写、history 已有快照之后再重建 manifest ——
  // 那次 rename 落 `manifest.json` 即抛（不依赖 ensure 是否先写过 manifest 的调用序号）。
  const badFs = {
    ...nodeFs,
    renameSync(from, to) {
      const historyDir = join(root, 'history', 'rule-1')
      const hasSnapshot = existsSync(historyDir) && readdirSync(historyDir).length > 0
      if (String(to).endsWith('/manifest.json') && hasSnapshot) {
        throw new Error('manifest rename blocked')
      }
      return nodeFs.renameSync(from, to)
    },
  }
  const failed = updateRule({ root, key: 'rule-1', patch: { text: '必须替换成第二版正文。' } }, { fs: badFs, git: false })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'manifest_failed')
  assert.equal(failed.rolledBack, true)
  const got = readRule(root, 'rule-1')
  assert.equal(got.rule.text, '必须先验证再覆盖正式库。')
  assert.equal(got.rule.front.version, 1)
  // 四处回滚的证据：history 不增、manifest 与磁盘一致（R9-03 断言补强）。
  const historyDir = join(root, 'history', 'rule-1')
  assert.deepEqual(existsSync(historyDir) ? readdirSync(historyDir) : [], [])
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.keys, ['rule-1'], 'manifest 必须回到写前（只剩原规则）')
})

test('updateRule：连续编辑同 key 得到 2,3,4…，互不覆盖且每次一份快照', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须执行第 1 版检查。').ok, true)
  const results = [2, 3, 4, 5].map((n) => updateRule(
    { root, key: 'rule-1', patch: { text: `必须执行第 ${n} 版检查。` } },
    { git: false },
  ))
  for (const result of results) assert.equal(result.ok, true, result.error)
  assert.deepEqual(results.map((r) => r.version), [2, 3, 4, 5])
  const got = readRule(root, 'rule-1')
  assert.equal(got.rule.front.version, 5)
  assert.equal(got.rule.text, '必须执行第 5 版检查。')
  const versions = readHistory(root, 'rule-1').entries.map((entry) => entry.version).sort()
  assert.deepEqual(versions, [1, 2, 3, 4], '4 次编辑 = 4 份旧版快照')
})

test('diffLines：增/删/同 顺序正确，空正文不造幽灵行', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'x' },
    { type: 'same', text: 'c' },
  ])
  assert.deepEqual(diffLines('', '新增一行'), [{ type: 'add', text: '新增一行' }])
  assert.deepEqual(diffLines('旧的一行', ''), [{ type: 'del', text: '旧的一行' }])
  assert.deepEqual(diffLines('a\nb', 'a\nb'), [
    { type: 'same', text: 'a' },
    { type: 'same', text: 'b' },
  ])
  assert.deepEqual(diffLines('', ''), [])
  // 尾部新增：公共后缀为空，只补 add，不把旧行误判成 del。
  assert.deepEqual(diffLines('a\nb', 'a\nb\nc'), [
    { type: 'same', text: 'a' },
    { type: 'same', text: 'b' },
    { type: 'add', text: 'c' },
  ])
})

test('resolveRevision：快照时间戳/.md/ISO/git 短 sha 都能定位，缺失与非法各自报错', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  assert.equal(writeDoc(root, frontOf({ version: 2 }), '必须保留审计日志。').ok, true)
  const entry = readHistory(root, 'rule-1').entries[0]
  assert.equal(entry.version, 1)

  const byStamp = resolveRevision({ root, key: 'rule-1', rev: entry.rev })
  assert.equal(byStamp.ok, true, byStamp.error)
  assert.equal(byStamp.source, 'history')
  assert.equal(byStamp.rule.text, '必须先验证再覆盖正式库。')

  const byMd = resolveRevision({ root, key: 'rule-1', rev: `${entry.rev}.md` })
  assert.equal(byMd.ok, true, byMd.error)
  assert.equal(byMd.rev, entry.rev)
  const byIso = resolveRevision({ root, key: 'rule-1', rev: entry.ts })
  assert.equal(byIso.ok, true, byIso.error)

  const missing = resolveRevision({ root, key: 'rule-1', rev: '20000101000000000' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'rev_not_found')

  const invalid = resolveRevision({ root, key: 'rule-1', rev: 'not-a-rev' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error, 'invalid_rev')

  // git 短 sha：注入 exec 返回该快照文件全文，验证 git 路径解析（不依赖真实仓库）。
  const source = readFileSync(join(root, 'history', 'rule-1', `${entry.rev}.md`), 'utf8')
  const fake = {
    exec: (file, args) => {
      const argv = Array.isArray(args) ? args : []
      if (argv.includes('show')) return source
      throw new Error(`unexpected git: ${argv.join(' ')}`)
    },
  }
  const bySha = resolveRevision({ root, key: 'rule-1', rev: 'abc1234' }, fake)
  assert.equal(bySha.ok, true, bySha.error)
  assert.equal(bySha.source, 'git')
  assert.equal(bySha.rev, 'abc1234')
  assert.equal(bySha.rule.text, '必须先验证再覆盖正式库。')
})

test('revertRule：旧快照写回成新版本，正文一致、历史不删、git 消息带 rev', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  assert.equal(writeDoc(root, frontOf({ version: 2 }), '必须保留审计日志。').ok, true)
  const entry = readHistory(root, 'rule-1').entries[0]
  const fake = fakeGit()
  const reverted = revertRule({ root, key: 'rule-1', rev: entry.rev }, { exec: fake.exec })
  assert.equal(reverted.ok, true, reverted.error)
  assert.equal(reverted.version, 3)
  assert.equal(reverted.previousVersion, 2)
  assert.equal(reverted.revertedTo, entry.rev)
  assert.equal(reverted.rule.text, '必须先验证再覆盖正式库。')
  assert.equal(readRule(root, 'rule-1').rule.text, '必须先验证再覆盖正式库。')
  assert.equal(readRule(root, 'rule-1').rule.front.version, 3)
  assert.equal(readHistory(root, 'rule-1').entries.length, 2, '回滚也留快照（新版本可再回滚）')
  assert.deepEqual(fake.commitMessages(), [`rule: revert rule-1 to ${entry.rev}`])
})

test('revertRule：rev 不存在 → rev_not_found；文件保持当前版本', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须先验证再覆盖正式库。').ok, true)
  const missing = revertRule({ root, key: 'rule-1', rev: '20000101000000000' }, { git: false })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'rev_not_found')
  assert.equal(readRule(root, 'rule-1').rule.front.version, 1)
})
