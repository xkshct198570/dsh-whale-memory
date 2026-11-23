/**
 * 规则启动自愈接线（R8-06/R8-10）：恢复 → 播种（后台）→ 镜像 → 摘要。
 * 关键口径：镜像只受 rules.mirrorAuto、摘要只受 rules.renderAgents 控制；
 * recoverPendingTxn 未落地时静默跳过、落地时被调用；每一步失败 fail-open。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs'
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, openDb } from '../../src/core/db.js'
import * as ruleStore from '../../src/core/rule-store.js'
import { runRulesSelfHeal } from '../../index.js'
import { RULES_BEGIN, RULES_END, agentsPathOf } from '../../src/core/rule-render.js'

/** 临时规则仓 + 临时 SQLite；`.seeded.json` 预置避免默认播种干扰计数。 */
function fresh(t, { seeded = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'whale-selfheal-'))
  const rulesDir = join(home, 'rules')
  const dbDir = mkdtempSync(join(tmpdir(), 'whale-selfheal-db-'))
  nodeFs.mkdirSync(rulesDir, { recursive: true })
  if (!seeded) {
    const db = openDb(dbDir)
    t.after(() => {
      closeDb(db)
      nodeFs.rmSync(home, { recursive: true, force: true })
      nodeFs.rmSync(dbDir, { recursive: true, force: true })
    })
    return { home, rulesDir, db, backend: { withDb: (fn) => fn(db) } }
  }
  // 有效播种 marker（契约 §2.9：version+keys 参与判据）：keys 记全部默认 key，
  // 自愈播种据此判「已播」，避免测试被 16 条默认铁律污染计数。
  const defaultsDir = fileURLToPath(new URL('../../defaults/rules', import.meta.url))
  const defaultKeys = readdirSync(defaultsDir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3))
  writeFileSync(join(rulesDir, '.seeded.json'), `${JSON.stringify({
    version: 1, seededAt: '2026-11-22T00:00:00.000Z', source: 'defaults', keys: defaultKeys, invalid: [],
  })}\n`, 'utf8')
  const db = openDb(dbDir)
  t.after(() => {
    closeDb(db)
    nodeFs.rmSync(home, { recursive: true, force: true })
    nodeFs.rmSync(dbDir, { recursive: true, force: true })
  })
  return { home, rulesDir, db, backend: { withDb: (fn) => fn(db) } }
}

/** 写一条合法铁律文件（不经过 writeRule，避免依赖 store 的写锁/git 状态）。 */
function writeRuleFile(rulesDir, { key = 'iron-rule-1', number = 1, text = '必须保留审计日志。' } = {}) {
  const front = [
    '---',
    `key: ${key}`,
    'type: iron-rule',
    `number: ${number}`,
    'priority: P0',
    'scope: global',
    'role: ""',
    'modality: must',
    'action: 保留',
    'object: 审计日志',
    'conditions: []',
    'exceptions: []',
    'status: active',
    'merged_into: ""',
    'superseded_by: ""',
    'created: 2026-11-22',
    'updated: 2026-11-22',
    'version: 1',
    'origin: unit',
    '---',
    '',
    text,
    '',
  ].join('\n')
  writeFileSync(join(rulesDir, `${key}.md`), front, 'utf8')
}

function agentsFile(home, body = '- 旧行') {
  const path = join(home, 'AGENTS.md')
  const content = ['# 说明书', '', RULES_BEGIN, body, RULES_END, '', '尾行', ''].join('\n')
  writeFileSync(path, content, 'utf8')
  return { path, content }
}

function cfgOf(rulesDir, rules = {}) {
  return { rules: { enabled: true, dir: rulesDir, ...rules } }
}

test('runRulesSelfHeal：mirrorAuto/renderAgents 都为真 → 镜像行 + AGENTS 摘要都更新', async (t) => {
  const { home, rulesDir, db, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const { path } = agentsFile(home)
  const before = nodeFs.readFileSync(path, 'utf8')

  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend })
  assert.equal(result.rules, 1)
  assert.equal(result.mirror?.ok, true, result.mirror?.error)
  assert.equal(result.agents?.ok, true, result.agents?.code)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin='rule:iron-rule-1'").get().n, 1)
  const after = nodeFs.readFileSync(path, 'utf8')
  assert.notEqual(after, before)
  assert.match(after, /- 铁律1 · 保留审计日志/)
})

test('runRulesSelfHeal：mirrorAuto=false 只跳过镜像，摘要照常（不互相绑死）', async (t) => {
  const { home, rulesDir, db, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const { path } = agentsFile(home)
  const before = nodeFs.readFileSync(path, 'utf8')

  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir, { mirrorAuto: false, renderAgents: true }), backend })
  assert.equal(result.mirror, null, '关镜像时不得调用 mirrorRules')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 0)
  assert.equal(result.agents?.ok, true)
  assert.notEqual(nodeFs.readFileSync(path, 'utf8'), before)
})

test('runRulesSelfHeal：renderAgents=false 只跳过摘要，镜像照常', async (t) => {
  const { home, rulesDir, db, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const { path, content } = agentsFile(home)

  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir, { mirrorAuto: true, renderAgents: false }), backend })
  assert.equal(result.agents, null, '关摘要时不得调用 renderAgentsDigest')
  assert.equal(nodeFs.readFileSync(path, 'utf8'), content, '关摘要时必须一个字节都不动')
  assert.equal(result.mirror?.ok, true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin='rule:iron-rule-1'").get().n, 1)
})

test('runRulesSelfHeal：两个开关都关 → 不动镜像也不动摘要', async (t) => {
  const { home, rulesDir, db, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const { path, content } = agentsFile(home)
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir, { mirrorAuto: false, renderAgents: false }), backend })
  assert.equal(result.mirror, null)
  assert.equal(result.agents, null)
  assert.equal(nodeFs.readFileSync(path, 'utf8'), content)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE origin LIKE 'rule:%'").get().n, 0)
})

test('runRulesSelfHeal：rules.enabled=false → 整段跳过（不起恢复/播种/镜像/摘要）', async (t) => {
  const { home, rulesDir, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const { path, content } = agentsFile(home)
  let recovered = 0
  const store = { ...ruleStore, recoverPendingTxn: () => { recovered += 1 } }
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir, { enabled: false }), backend, store })
  assert.equal(result.skipped, 'rules_disabled')
  assert.equal(recovered, 0)
  assert.equal(nodeFs.readFileSync(path, 'utf8'), content)
})

test('runRulesSelfHeal：recoverPendingTxn 接线（store 落地后被调用，失败 fail-open）', async (t) => {
  const { rulesDir, backend } = fresh(t)
  writeRuleFile(rulesDir)
  const calls = []
  const store = {
    ...ruleStore,
    recoverPendingTxn: (dir, opts) => {
      calls.push([dir, typeof opts?.log])
      return { recovered: true, id: 'txn-1' }
    },
  }
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend, store })
  assert.deepEqual(calls, [[rulesDir, 'function']])
  assert.equal(result.recovered?.recovered, true)

  let threw = 0
  const broken = {
    ...ruleStore,
    recoverPendingTxn: () => { threw += 1; throw new Error('boom') },
  }
  const second = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend, store: broken })
  assert.equal(threw, 1)
  assert.equal(second.mirror?.ok, true, '恢复失败不得阻断镜像自愈')
})

test('runRulesSelfHeal：播种在自愈内后台执行（有 marker 时判已播，不重写规则）', async (t) => {
  const { rulesDir, backend } = fresh(t)
  writeRuleFile(rulesDir, { key: 'iron-rule-1', number: 1, text: '必须保留审计日志。' })
  const before = nodeFs.readFileSync(join(rulesDir, 'iron-rule-1.md'), 'utf8')
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir, { mirrorAuto: false, renderAgents: false }), backend })
  assert.equal(result.seeded?.skipped, 'already_seeded')
  assert.equal(nodeFs.readFileSync(join(rulesDir, 'iron-rule-1.md'), 'utf8'), before)
  assert.equal(existsSync(agentsPathOf(rulesDir)), false, '自愈不得创建宿主 AGENTS 资产')
})

// ---------------------------------------------------------------------------
// 干净安装 P1：宿主没有 AGENTS.md 时，启动自愈创建最小管理块
// ---------------------------------------------------------------------------

test('runRulesSelfHeal：空机（无 AGENTS.md）→ 创建最小管理块，默认铁律可见', async (t) => {
  const { home, rulesDir, backend } = fresh(t)
  writeRuleFile(rulesDir, { key: 'iron-rule-1', number: 1, text: '必须保留审计日志。' })
  const agentsPath = join(home, 'AGENTS.md')
  assert.equal(existsSync(agentsPath), false)

  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend })
  assert.equal(result.agents?.ok, true, result.agents?.code)
  assert.equal(result.agents?.created, true)
  assert.equal(existsSync(agentsPath), true, '干净安装必须创建 AGENTS.md')
  const content = nodeFs.readFileSync(agentsPath, 'utf8')
  assert.ok(content.startsWith(`${RULES_BEGIN}\n`))
  assert.ok(content.endsWith(`${RULES_END}\n`))
  assert.match(content, /- 铁律1 · 保留审计日志/)
})

test('runRulesSelfHeal：rules.createAgentsIfMissing=false → 空机不创建；true 默认开', async (t) => {
  const { home, rulesDir, backend } = fresh(t)
  writeRuleFile(rulesDir, { key: 'iron-rule-1', number: 1 })
  const agentsPath = join(home, 'AGENTS.md')

  const off = await runRulesSelfHeal({
    config: cfgOf(rulesDir, { createAgentsIfMissing: false }), backend,
  })
  assert.equal(off.agents?.ok, false)
  assert.equal(off.agents?.code, 'no_markers')
  assert.equal(existsSync(agentsPath), false, '开关关闭时不得创建')

  // 默认（未配该键）必须开：干净安装的验收口径。
  const on = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend })
  assert.equal(on.agents?.created, true)
  assert.equal(existsSync(agentsPath), true)
})

test('runRulesSelfHeal：规则目录为空时不自愈出空壳 AGENTS', async (t) => {
  const { home, rulesDir, backend } = fresh(t)
  const agentsPath = join(home, 'AGENTS.md')
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend })
  assert.equal(result.rules, 0)
  assert.equal(result.agents, null)
  assert.equal(existsSync(agentsPath), false)
})

test('干净安装 E2E：无 marker 空仓 → 播种 16 条默认铁律 → AGENTS 自动创建且全部可见', async (t) => {
  const { home, rulesDir, backend } = fresh(t, { seeded: false })
  const agentsPath = join(home, 'AGENTS.md')
  const result = await runRulesSelfHeal({ config: cfgOf(rulesDir), backend })
  assert.equal(result.seeded?.seeded, 16, '空仓应播种 16 条默认铁律')
  assert.equal(result.rules, 16)
  assert.equal(result.agents?.created, true, result.agents?.code)
  const content = nodeFs.readFileSync(agentsPath, 'utf8')
  const lines = content.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines.length, 16, '16 条默认铁律必须全部进 AGENTS 摘要')
  assert.match(content, /- iron-rule-safety /)
  assert.match(content, /- 铁律1 · /)
  assert.match(content, /^<!-- whale-memory:rules:begin -->\n/, '最小管理块从 begin 开始')
  assert.match(content, /<!-- whale-memory:rules:end -->\n$/, '以 end 结束')
})
