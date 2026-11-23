/**
 * 默认铁律播种单测（rule-defaults）：首播/幂等/不覆盖/坏文件跳过/撞号/marker 判据/git 一次提交，
 * 以及"无编号铁律（安全行 number=0）"的仓储口径（validateRule 只放行 iron-rule-safety；
 * nextRuleNumber/computeManifest 不受 0 影响）。
 *
 * 只碰临时目录：默认目录用临时 `defaults` 目录构造（不依赖包内 16 条内容），
 * git 用注入 exec 模拟（不依赖本机安装、不联网）。最后一条用例才读包内真实默认目录，
 * 验"装好的包能整批播种"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEED_MARKER,
  SEED_VERSION,
  readSeedMarker,
  defaultRulesAvailable,
  defaultRulesDir,
  seedDefaultRules,
} from '../../src/core/rule-defaults.js'
import {
  MANIFEST_FILE,
  computeManifest,
  createRule,
  listRules,
  purgeRule,
  readManifest,
  nextRuleNumber,
  readRule,
  serializeRuleDocument,
  validateRule,
} from '../../src/core/rule-store.js'

/** 每个用例独立临时根（规则根 + 可选 defaults 目录都在里面）。 */
function freshRoot(t, prefix = 'whale-seed-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 默认规则 front（与 defaults/rules 同形状；字段顺序由 serialize 固定）。 */
function frontOf(over = {}) {
  return {
    key: 'iron-rule-1',
    type: 'iron-rule',
    number: 1,
    priority: 'P0',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '验证',
    object: '真机产物',
    conditions: [],
    exceptions: [],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'default:iron-rule-1',
    ...over,
  }
}

/** 在 defaults 目录写一条规则文件（走与仓储同一个序列化器，形状不会漂）。 */
function writeDefault(dir, front, text) {
  const serialized = serializeRuleDocument({ front, text })
  assert.equal(serialized.ok, true, `serialize 失败：${serialized.error}`)
  writeFileSync(join(dir, `${front.key}.md`), serialized.text, 'utf8')
}

/** 三个合法默认文件（编号 1/2/3）。 */
function threeDefaults(dir) {
  writeDefault(dir, frontOf({ key: 'iron-rule-1', number: 1 }), '必须先验证再覆盖正式库。')
  writeDefault(dir, frontOf({ key: 'iron-rule-2', number: 2, origin: 'default:iron-rule-2' }), '必须保留审计日志。')
  writeDefault(dir, frontOf({ key: 'iron-rule-3', number: 3, origin: 'default:iron-rule-3' }), '禁止删除未归档的报告。')
}

/**
 * 假 git：记录每次子命令。`repo:false` 模拟"不是 git 仓库"，`diff` 用退出码 1 模拟"有改动"，
 * 这样 gitCommit 会真的走到 `commit`（否则空改动不提交，测不到"一次提交"）。
 */
function gitStub({ repo = true } = {}) {
  const calls = []
  const exec = (_cmd, args = []) => {
    const joined = args.join(' ')
    calls.push(joined)
    if (joined.includes('--version')) return 'git version 2.42.0\n'
    if (joined.includes('rev-parse --is-inside-work-tree')) {
      if (!repo) {
        const err = new Error('not a git repository')
        err.status = 128
        err.stderr = 'fatal: not a git repository'
        throw err
      }
      return 'true\n'
    }
    if (joined.includes('diff --cached --quiet')) {
      const err = new Error('changes staged')
      err.status = 1
      err.stderr = ''
      throw err
    }
    if (joined.includes(' commit ')) return '[main abc1234] ok\n'
    return ''
  }
  const commits = () => calls.filter((line) => line.includes(' commit '))
  return { exec, calls, commits }
}

test('defaultRulesDir：指向包根 defaults/rules，且与 defaultRulesAvailable 同判据', () => {
  const expected = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'defaults', 'rules'))
  assert.equal(resolve(defaultRulesDir()), expected)
  assert.equal(defaultRulesAvailable(), existsSync(expected))
  assert.equal(defaultRulesAvailable(join(expected, 'no-such-dir')), false)
})

test('首播 3 个默认文件：写文件 + manifest + marker + 返回形状', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults, log: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, 3)
  assert.equal(result.count, 3)
  assert.equal(result.skippedInvalid, 0)
  assert.deepEqual(result.invalid, [])

  const listed = listRules(rulesRoot)
  assert.equal(listed.errors.length, 0)
  assert.deepEqual(listed.rules.map((doc) => doc.front.number), [1, 2, 3])
  assert.deepEqual(listed.rules.map((doc) => doc.front.key), ['iron-rule-1', 'iron-rule-2', 'iron-rule-3'])
  // 逐文件内容原样落盘（不是空占位）。
  assert.equal(readFileSync(join(rulesRoot, 'iron-rule-2.md'), 'utf8').includes('必须保留审计日志。'), true)

  const manifest = JSON.parse(readFileSync(join(rulesRoot, MANIFEST_FILE), 'utf8'))
  assert.equal(manifest.nextNumber, 4)
  assert.equal(manifest.total, 3)

  const marker = JSON.parse(readFileSync(join(rulesRoot, SEED_MARKER), 'utf8'))
  assert.equal(marker.source, 'defaults')
  assert.equal(marker.count, 3)
  assert.equal(marker.version, 1)
  assert.match(String(marker.seededAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(readSeedMarker(rulesRoot), marker)
})

test('幂等：第二次播种返回 already_seeded 且不改文件', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)

  assert.equal((await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })).seeded, 3)
  const before = readFileSync(join(rulesRoot, SEED_MARKER), 'utf8')
  const second = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, 'already_seeded')
  assert.equal(second.count, 0)
  assert.equal(readFileSync(join(rulesRoot, SEED_MARKER), 'utf8'), before)
})

test('已有规则：不覆盖、不新增默认文件，marker 记 existing_rules', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(rulesRoot, { recursive: true })
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  // 用户自己的规则：与默认同一编号，内容不同。
  writeDefault(rulesRoot, frontOf({ key: 'iron-rule-1', number: 1, origin: 'manual:u1' }), '必须只做用户自己那条。')

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'existing_rules')
  assert.equal(result.count, 0)
  assert.deepEqual(readdirSync(rulesRoot).filter((name) => name.endsWith('.md')), ['iron-rule-1.md'])
  assert.equal(readRule(rulesRoot, 'iron-rule-1').rule.text.trim(), '必须只做用户自己那条。')
  const marker = JSON.parse(readFileSync(join(rulesRoot, SEED_MARKER), 'utf8'))
  assert.equal(marker.skipped, 'existing_rules')
  assert.match(String(marker.at), /^\d{4}-\d{2}-\d{2}T/)
})

test('用户删光默认规则后重启：marker 是判据，不重新播种', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)

  assert.equal((await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })).seeded, 3)
  for (const name of readdirSync(rulesRoot).filter((item) => item.endsWith('.md'))) {
    rmSync(join(rulesRoot, name))
  }
  assert.equal(listRules(rulesRoot).rules.length, 0, '删光后目录确实为空（否则这条用例测不到判据）')

  const restart = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(restart.ok, true)
  assert.equal(restart.skipped, 'already_seeded')
  assert.equal(listRules(rulesRoot).rules.length, 0, '重启不得把用户删掉的默认铁律灌回来')
})

test('坏文件跳过不阻断：缺 front matter 的进 invalid，其余照播', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  writeFileSync(join(defaults, 'broken.md'), '没有 front matter 的正文，应当被跳过。\n', 'utf8')

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, 3)
  assert.equal(result.skippedInvalid, 1)
  assert.equal(result.invalid.length, 1)
  assert.equal(result.invalid[0].file, join(defaults, 'broken.md'))
  assert.equal(result.invalid[0].errors[0].code, 'parse_failed')
  assert.equal(existsSync(join(rulesRoot, 'broken.md')), false)
})

test('校验不过的默认文件跳过：保留空号 6 被拒，其余编号照播', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  writeDefault(defaults, frontOf({ key: 'iron-rule-6', number: 6, origin: 'default:iron-rule-6' }), '禁止占用保留空号。')
  writeDefault(defaults, frontOf({ key: 'iron-rule-7', number: 7, origin: 'default:iron-rule-7' }), '必须留出空号。')

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(result.seeded, 1)
  assert.equal(result.skippedInvalid, 1)
  assert.deepEqual(result.invalid[0].errors.map((item) => item.code), ['number_reserved'])
  assert.deepEqual(listRules(rulesRoot).rules.map((doc) => doc.front.number), [7])
})

test('默认文件之间撞号：后来的跳过（duplicate_number），不写半成品', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  // a-*.md 会先于 b-*.md 处理（文件名排序），所以 a 占号、b 撞号。
  writeDefault(defaults, frontOf({ key: 'iron-rule-a', number: 3, origin: 'default:a' }), '必须先验证再覆盖正式库。')
  writeDefault(defaults, frontOf({ key: 'iron-rule-b', number: 3, origin: 'default:b' }), '必须保留审计日志。')

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(result.seeded, 1)
  assert.equal(result.skippedInvalid, 1)
  assert.deepEqual(result.invalid[0].errors.map((item) => item.code), ['duplicate_number'])
  assert.deepEqual(listRules(rulesRoot).rules.map((doc) => doc.front.key), ['iron-rule-a'])
})

test('git 可用：整批只提交一次，消息带数量（注入 exec）', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  const git = gitStub()

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { exec: git.exec })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, 3)
  assert.equal(result.commit.ok, true)
  assert.equal(result.commit.committed, true)
  assert.equal(result.commit.message, 'rules: seed defaults (3)')
  const commits = git.commits()
  assert.equal(commits.length, 1, `应当只有一个 commit，实际：${commits.join(' | ')}`)
  assert.match(commits[0], /rules: seed defaults \(3\)/)
})

test('git 不可用：文件照写、commit 降级跳过（fail-open）', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  const exec = () => {
    const err = new Error('spawn git ENOENT')
    err.code = 'ENOENT'
    throw err
  }

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { exec })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, 3)
  assert.equal(result.commit.ok, false)
  assert.equal(result.commit.error, 'git_unavailable')
  assert.equal(listRules(rulesRoot).rules.length, 3, 'git 缺失不得影响规则落盘')
  assert.equal(existsSync(join(rulesRoot, SEED_MARKER)), true)
})

test('包内默认目录不存在：skipped=defaults_missing 且不写 marker（将来能播就播）', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: join(base, 'nope') })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'defaults_missing')
  assert.equal(result.count, 0)
  assert.equal(existsSync(join(rulesRoot, SEED_MARKER)), false)
})

test('默认文件全部非法：all_invalid + 不写 marker（下次仍会尝试）', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  writeFileSync(join(defaults, 'broken.md'), '还是没有 front matter。\n', 'utf8')

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'all_invalid')
  assert.equal(result.seeded, 0)
  assert.equal(result.skippedInvalid, 1)
  assert.equal(existsSync(join(rulesRoot, SEED_MARKER)), false)
})

test('无编号安全行（number=0）：validateRule 只放行 iron-rule-safety，其余 key 仍拒', async (t) => {
  const safetyFront = frontOf({
    key: 'iron-rule-safety', number: 0, modality: 'only', action: '存放', object: '认证凭据',
    origin: 'default:iron-rule-safety',
  })
  const safetyText = '认证凭据只准走环境变量；禁止明文落盘。'
  const ok = validateRule(safetyFront, safetyText)
  assert.equal(ok.ok, true, `安全行不该被拒：${JSON.stringify(ok.errors)}`)

  const wrongKey = validateRule({ ...safetyFront, key: 'iron-rule-0', origin: 'x' }, safetyText)
  assert.equal(wrongKey.ok, false)
  assert.deepEqual(wrongKey.errors.map((item) => item.code), ['invalid_number'])
  const alsoWrong = validateRule({ ...safetyFront, key: 'rule-general-abcdef12', number: 0 }, safetyText)
  assert.deepEqual(alsoWrong.errors.map((item) => item.code), ['invalid_number'])
})

test('number=0 不占号：nextRuleNumber/computeManifest 不受影响，manifest 记 unnumbered', async (t) => {
  assert.equal(nextRuleNumber([0, 17]), 18)
  assert.equal(nextRuleNumber([0]), 1)

  const rules = []
  for (let n = 1; n <= 17; n += 1) {
    if (n === 6) continue
    rules.push({ front: frontOf({ key: `iron-rule-${n}`, number: n }), text: '必须保留编号。' })
  }
  rules.push({
    front: frontOf({ key: 'iron-rule-safety', number: 0, modality: 'only', action: '存放', object: '认证凭据' }),
    text: '认证凭据只准走环境变量；禁止明文落盘。',
  })
  const manifest = computeManifest(rules)
  assert.equal(manifest.nextNumber, 18)
  assert.equal(manifest.total, 16, '0 不计入编号总数（1–17 去掉空号 6 = 16 条）')
  assert.equal(manifest.unnumbered, 1)
})

test('播种真实默认目录：整批无非法、safety 无编号、本地专用 13 不播', async (t) => {
  const base = freshRoot(t, 'whale-seed-real-')
  const rulesRoot = join(base, 'rules')
  const defaults = defaultRulesDir()
  const files = readdirSync(defaults).filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD')
  assert.ok(files.length >= 10, `默认目录应当有成批规则，实际 ${files.length}`)

  // git:false：这条用例验内容口径，不依赖本机 git。
  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(result.ok, true)
  assert.equal(result.seeded, files.length)
  assert.equal(result.skippedInvalid, 0, `默认文件不该有非法项：${JSON.stringify(result.invalid)}`)

  const listed = listRules(rulesRoot)
  assert.equal(listed.errors.length, 0)
  const safety = readRule(rulesRoot, 'iron-rule-safety')
  assert.equal(safety.ok, true, '通用默认里必须含「安全·密钥纪律」行')
  assert.equal(safety.rule.front.number, 0)
  assert.equal(safety.rule.front.type, 'iron-rule')

  const manifest = computeManifest(listed.rules)
  assert.equal(manifest.nextNumber, 18, '1–17 已占（含空号 6），下一条从 18 起')
  assert.equal(manifest.unnumbered, 1)
  // rules-local/ 是独立目录（本机专用），默认播种不得把它搬过来。
  assert.equal(existsSync(join(rulesRoot, 'iron-rule-13.md')), false)
})

test('git 仓库不存在：先 init（不提交）再单次提交，首启只有一个 commit', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  const git = gitStub({ repo: false })

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { exec: git.exec })
  assert.equal(result.ok, true, JSON.stringify(result.invalid))
  assert.equal(result.seeded, 3)
  assert.equal(result.commit.ok, true)
  assert.equal(result.commit.committed, true)
  const commits = git.commits()
  assert.equal(commits.length, 1, `首启应当只有一个 commit，实际：${commits.join(' | ')}`)
  assert.match(commits[0], /rules: seed defaults \(3\)/)
  assert.equal(git.calls.some((line) => line.includes('init -q')), true, '仓库不存在时必须先 git init')
  assert.equal(
    git.calls.some((line) => line.includes('rules: init repository')),
    false,
    '不得先做一次 init commit（那会让 history 多一条只有 README 的噪音）',
  )
})

// ---------------------------------------------------------------------------
// R8-10：播种版本化 + invalid 重试 + 升级补播
// ---------------------------------------------------------------------------

test('坏默认文件下轮重试：invalid 进 marker，修好后只补播缺失 key', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  writeFileSync(join(defaults, 'iron-rule-9.md'), '没有 front matter 的坏文件。\n', 'utf8')

  const first = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(first.ok, true, first.error)
  assert.equal(first.seeded, 3)
  assert.equal(first.skippedInvalid, 1)
  const marker = readSeedMarker(rulesRoot)
  assert.equal(marker.version, SEED_VERSION, 'marker 必须记 SEED_VERSION')
  assert.deepEqual(marker.keys, ['iron-rule-1', 'iron-rule-2', 'iron-rule-3'])
  assert.deepEqual(marker.invalid.map((item) => item.key), ['iron-rule-9'], 'invalid 必须进 marker 供下轮重试')

  // 修好坏文件：下轮只补这条，已播的不重播。
  writeDefault(defaults, frontOf({ key: 'iron-rule-9', number: 9, origin: 'default:iron-rule-9' }), '必须保留审计日志。')
  const second = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.seeded, 1, '只补上轮 invalid 的那一条')
  assert.equal(second.skippedInvalid, 0)
  assert.deepEqual(second.invalid, [])
  assert.deepEqual(readSeedMarker(rulesRoot).invalid, [])
  assert.deepEqual(listRules(rulesRoot).rules.map((doc) => doc.front.key).sort(), ['iron-rule-1', 'iron-rule-2', 'iron-rule-3', 'iron-rule-9'])
})

test('升级新增默认 key：只补新增项，不覆盖已有正文', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  assert.equal((await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })).seeded, 3)

  // 用户手改第一条正文：升级补播不得覆盖它。
  const edited = join(rulesRoot, 'iron-rule-1.md')
  writeFileSync(edited, readFileSync(edited, 'utf8').replace('必须先验证再覆盖正式库。', '必须只做用户自己那条。'), 'utf8')
  // 包升级新增一条默认规则。
  writeDefault(defaults, frontOf({ key: 'iron-rule-4', number: 4, origin: 'default:iron-rule-4' }), '必须保留审计日志。')
  const upgraded = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(upgraded.ok, true, upgraded.error)
  assert.equal(upgraded.seeded, 1, '升级只补新增 key，不重播旧 key')
  assert.equal(readRule(rulesRoot, 'iron-rule-1').rule.text.trim(), '必须只做用户自己那条。')
  assert.equal(listRules(rulesRoot).rules.length, 4)
})

test('SEED_VERSION 参与判据：marker 版本落后 → 即使无新文件也升级写回', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(defaults, { recursive: true })
  threeDefaults(defaults)
  assert.equal((await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })).seeded, 3)

  const markerFile = join(rulesRoot, SEED_MARKER)
  const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
  marker.version = SEED_VERSION - 1
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')

  const again = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(again.ok, true, again.error)
  assert.equal(again.skipped, 'already_seeded')
  assert.equal(again.seeded, 0)
  assert.equal(readSeedMarker(rulesRoot).version, SEED_VERSION, '落后的 marker 必须被升级，版本号不能只写不读')
})

test('首播不复活墓碑：purge #17 后（无 marker）重播跳过 17，编号不回退', async (t) => {
  const base = freshRoot(t)
  const rulesRoot = join(base, 'rules')
  const defaults = join(base, 'defaults', 'rules')
  mkdirSync(rulesRoot, { recursive: true })
  mkdirSync(defaults, { recursive: true })
  writeDefault(defaults, frontOf({ key: 'iron-rule-1', number: 1 }), '必须先验证再覆盖正式库。')
  writeDefault(defaults, frontOf({ key: 'iron-rule-17', number: 17, origin: 'default:iron-rule-17' }), '必须保留审计日志。')
  // 用户先装了 17 又彻底删除（墓碑 17），随后 marker 不存在（新装/换机/手删 marker）。
  writeDefault(rulesRoot, frontOf({ key: 'iron-rule-17', number: 17, origin: 'default:iron-rule-17' }), '必须保留审计日志。')
  assert.equal(purgeRule({ root: rulesRoot, key: 'iron-rule-17' }, { git: false }).ok, true)
  assert.equal(existsSync(join(rulesRoot, SEED_MARKER)), false)

  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.seeded, 1, '墓碑 key 必须跳过')
  assert.equal(result.tombstoned, 1)
  assert.equal(existsSync(join(rulesRoot, 'iron-rule-17.md')), false, '首播不得复活已 purge 的默认铁律')
  assert.equal(readManifest(rulesRoot).nextNumber, 18, '已作废的 17 继续占号')

  const created = createRule({ root: rulesRoot, draft: { text: '必须保留审计日志。', type: 'iron-rule' } }, { git: false })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.number, 18, '重播后新规则仍从 18 起，不复用 17')
})


test('R9-21：manifest 重建失败 → 不写 .seeded.json（下轮重试，health 红）', async (t) => {
  const rulesRoot = mkdtempSync(join(tmpdir(), 'whale-seed-mf-'))
  t.after(() => rmSync(rulesRoot, { recursive: true, force: true }))
  const defaults = join(rulesRoot, '__defaults__')
  mkdirSync(defaults, { recursive: true })
  writeDefault(defaults, frontOf({ key: 'iron-rule-1', number: 1 }), '必须先验证再覆盖正式库。')
  // 只让 manifest.json 的原子 rename 失败，其它文件写入保持真实。
  const fakeFs = { ...nodeFs }
  fakeFs.renameSync = (from, to) => {
    if (String(to).endsWith(MANIFEST_FILE)) {
      const err = new Error('ENOSPC: manifest write failed')
      err.code = 'ENOSPC'
      throw err
    }
    return nodeFs.renameSync(from, to)
  }
  const result = await seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false, fs: fakeFs })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'manifest_failed')
  assert.equal(existsSync(join(rulesRoot, SEED_MARKER)), false, 'manifest 失败不得写 marker')
})

test('R9-21b：首播逐文件让出事件循环——首个 immediate 时不可能已写完默认目录', async (t) => {
  const base = freshRoot(t, 'whale-seed-yield-')
  const rulesRoot = join(base, 'rules')
  const defaults = defaultRulesDir()
  const total = readdirSync(defaults).filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD').length
  assert.ok(total >= 10, `默认目录应当有成批规则，实际 ${total}`)

  // 播种前先排一个 immediate：它若在"全部文件写完"之后才跑到，说明播种根本没让出事件循环。
  let filesAtFirstImmediate = -1
  const probe = new Promise((done) => {
    setImmediate(() => {
      filesAtFirstImmediate = listRules(rulesRoot).rules.length
      done()
    })
  })
  const task = seedDefaultRules({ root: rulesRoot, defaultsDir: defaults }, { git: false })
  await probe
  assert.notEqual(filesAtFirstImmediate, -1)
  assert.ok(filesAtFirstImmediate < total, `首个 immediate 时已写 ${filesAtFirstImmediate}/${total} 条：播种在同一个 tick 里跑完了`)

  const result = await task
  assert.equal(result.ok, true)
  assert.equal(result.seeded, total, '让出事件循环不能漏播')
})
