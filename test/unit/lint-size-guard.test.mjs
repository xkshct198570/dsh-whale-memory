/**
 * lint-size CLI 守卫回归：通过 symlink 调用脚本时门禁必须仍然执行。
 *
 * 为什么锁：旧判据 `import.meta.url === pathToFileURL(resolve(argv[1]))` 在包管理器/CI 用 symlink
 * 包装脚本时会 false → 门禁静默不跑（fail-open）。本用例建一个 symlink 直接跑，必须看到 ok 行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))

test('symlink 调用 scripts/lint-size.mjs 仍执行检查（不静默跳过）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-size-link-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = join(dir, 'lint-size-link.mjs')
  symlinkSync(join(ROOT, 'scripts/lint-size.mjs'), link)
  const direct = spawnSync(process.execPath, [join(ROOT, 'scripts/lint-size.mjs')], { cwd: ROOT, encoding: 'utf8' })
  const linked = spawnSync(process.execPath, [link], { cwd: ROOT, encoding: 'utf8' })
  // 断言「真的跑了」而不是「此刻全绿」：基线红时两者都应红，且退出码一致。
  assert.match(direct.stdout, /\[lint-size\]/, '直接调用应输出检查结果')
  assert.match(linked.stdout, /\[lint-size\]/, `symlink 调用必须真的跑检查，实际输出：${linked.stdout}`)
  assert.equal(linked.status, direct.status, 'symlink 与直接调用必须走同一判据（退出码一致）')
})
