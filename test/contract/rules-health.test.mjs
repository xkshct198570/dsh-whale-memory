/**
 * R9-14：`/rules/health` 黄灯契约（非红）——
 * 摘要预算截断、最近一次注入跳过、AGENTS 管理块陈旧，都必须以 warnings 回报而不是静默。
 * 只读磁盘 + 进程内注入统计；不启真 HTTP、不碰真实规则仓。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rulesHealthPayload } from '../../src/host/rules-routes.js'
import { writeRule } from '../../src/core/rule-store.js'
import { recordInjection, resetInjectionStats } from '../../src/host/inject-stats.js'
import { RULES_BEGIN, RULES_END } from '../../src/core/rule-render.js'

function freshRoot(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-health-'))
  t.after(() => { resetInjectionStats(); rmSync(home, { recursive: true, force: true }) })
  const rulesDir = join(home, 'rules')
  mkdirSync(rulesDir, { recursive: true })
  return { home, rulesDir }
}

function ruleFront(key, number, priority = 'P1') {
  return {
    key, type: 'rule', number, priority, scope: 'global', role: '', modality: 'must',
    action: '', object: '', conditions: [], exceptions: [], status: 'active',
    merged_into: '', superseded_by: '', created: '2026-11-23', updated: '2026-11-23',
    version: 1, origin: 'unit',
  }
}

test('R9-14：摘要超预算 → health warnings=summary_budget_skipped（ok 仍为 true）', (t) => {
  const { rulesDir } = freshRoot(t)
  assert.equal(writeRule(rulesDir, { front: ruleFront('rule-a', 1), text: '必须保留审计日志并在写入后核对快照。' }, { git: false }).ok, true)
  assert.equal(writeRule(rulesDir, { front: ruleFront('rule-b', 2, 'P3'), text: '必须每周清理冷却日志，避免无限增长。' }, { git: false }).ok, true)
  const payload = rulesHealthPayload({ root: rulesDir, config: { rules: { dir: rulesDir, summaryBudgetChars: 70 } } })
  assert.equal(payload.ok, true, '黄灯不改变 ok（红才是阻断）')
  const warning = payload.warnings.find((item) => item.code === 'summary_budget_skipped')
  assert.ok(warning, JSON.stringify(payload.warnings))
  assert.ok(Array.isArray(warning.keys) && warning.keys.length >= 1)
  assert.match(warning.detail, /预算/)
})

test('R9-14：最近一次注入有跳过 → health warnings=inject_skipped', (t) => {
  const { rulesDir } = freshRoot(t)
  const payloadBefore = rulesHealthPayload({ root: rulesDir, config: { rules: { dir: rulesDir } } })
  assert.equal((payloadBefore.warnings || []).some((item) => item.code === 'inject_skipped'), false, '没有注入事实时不得报黄')
  recordInjection({ mode: 'scope', keys: ['rule-a'], skipped: [{ key: 'rule-b', chars: 999 }], chars: 10, cached: false })
  const payload = rulesHealthPayload({ root: rulesDir, config: { rules: { dir: rulesDir } } })
  const warning = payload.warnings.find((item) => item.code === 'inject_skipped')
  assert.ok(warning, JSON.stringify(payload.warnings))
  assert.deepEqual(warning.keys, ['rule-b'])
})

test('R9-14：AGENTS 管理块旧于规则 → health warnings=agents_block_stale', (t) => {
  const { home, rulesDir } = freshRoot(t)
  const agentsPath = join(home, 'AGENTS.md')
  writeFileSync(agentsPath, `# A\n${RULES_BEGIN}\n${RULES_END}\n`, 'utf8')
  // 先写块再写规则：规则 mtime 更新 → 块陈旧。
  const written = writeRule(rulesDir, { front: ruleFront('rule-a', 1), text: '必须保留审计日志。' }, { git: false })
  assert.equal(written.ok, true, written.error)
  const payload = rulesHealthPayload({ root: rulesDir, config: { rules: { dir: rulesDir } } })
  const warning = payload.warnings.find((item) => item.code === 'agents_block_stale')
  assert.ok(warning, JSON.stringify(payload.warnings))
  assert.equal(warning.file, agentsPath)
  assert.equal(dirname(agentsPath), home)
})
