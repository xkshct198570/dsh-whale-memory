/**
 * 规则仓储单测（R3a）：strict YAML 子集、校验、原子写、历史、manifest、git 降级。
 * 只碰临时目录，不访问真实 `$DSH_HOME`、不联网；git 用注入 exec 模拟，不依赖本机安装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HISTORY_KEEP,
  MANIFEST_FILE,
  atomicWriteFile,
  defaultRuleRoot,
  deleteRule,
  ensureRuleRepo,
  listRules,
  nextRuleNumber,
  normalizeRuleDoc,
  parseRuleDocument,
  readHistory,
  readRule,
  readSnapshot,
  regenerateManifest,
  rollbackTo,
  serializeRuleDocument,
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
    [{ number: 0 }, 'invalid_number'],
    [{ number: 6 }, 'number_reserved'],
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
  assert.equal(writeDoc(root, frontOf({ key: 'rule-5', number: 5 }), '必须执行第五项检查。').ok, true)
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
  const badFs = {
    ...nodeFs,
    renameSync() { throw new Error('rename blocked') },
  }
  const failed = writeDoc(root, frontOf({ version: 2 }), '必须替换成第二版正文。', { fs: badFs })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'write_failed')
  assert.match(failed.detail, /rename blocked/)
  const got = readRule(root, 'rule-1')
  assert.equal(got.rule.text, '必须保留第一版正文。')
  assert.deepEqual(readdirSync(root).filter((n) => n.includes('.tmp-')), [])
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
  const rolled = rollbackTo(root, 'rule-1', target.rev, { git: false })
  assert.equal(rolled.ok, true, rolled.error)
  assert.equal(rolled.rolledBackTo, target.rev)
  const got = readRule(root, 'rule-1')
  assert.equal(got.rule.text, snap.rule.text)
  assert.equal(got.rule.front.version, snap.rule.front.version)
  assert.equal(got.rule.front.priority, snap.rule.front.priority)

  const missing = rollbackTo(root, 'rule-1', '20000101000000000', { git: false })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'snapshot_not_found')
})

test('delete：普通规则 force 也只 retired 留文件；候选 force 才物理删', (t) => {
  const root = freshRoot(t)
  assert.equal(writeDoc(root, frontOf(), '必须保留审计行。').ok, true)
  const retired = deleteRule(root, 'rule-1', { force: true, git: false })
  assert.equal(retired.ok, true)
  assert.equal(retired.retired, true)
  const got = readRule(root, 'rule-1')
  assert.equal(got.ok, true)
  assert.equal(got.rule.front.status, 'retired')
  assert.equal(got.rule.front.version, 2)

  const cand = writeRule(root, {
    front: frontOf({ key: 'cand-2', type: 'rule-candidate', number: 2, status: 'proposal' }),
    text: '先观察一周再决定。',
  }, { git: false })
  assert.equal(cand.ok, true, cand.error)
  assert.ok(cand.path.includes('proposals'))
  const deleted = deleteRule(root, 'cand-2', { force: true, git: false })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.deleted, true)
  assert.equal(readRule(root, 'cand-2').error, 'rule_not_found')
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
  writeFileSync(join(root, 'broken.md'), '---\nkey: broken\ntype: rule\nnumber: nope\n---\n\n必须保留。\n', 'utf8')
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
