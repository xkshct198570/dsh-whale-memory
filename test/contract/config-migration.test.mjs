/**
 * 旧配置迁移（架构书 §10.3）：env → Config 的一次性迁移。
 *
 * 临时目录 / 内存 sqlite / 假 configEditor；不碰真实 profile、不碰真实库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getMeta } from '../../src/core/db.js'
import {
  cleanupDeprecatedConfig, installConfigMigration, migrationFilePath, readLegacyEnv,
} from '../../src/host/config-migration.js'
import { Config } from '../../src/host/config.js'

const LEGACY_ENV = {
  AI_ROUTER_GATEWAY: 'http://127.0.0.1:4999',
  AI_ROUTER_HUB_TIMEOUT_MS: '1500',
  AI_ROUTER_HUB_RECALL_TIMEOUT_MS: '900',
  AI_ROUTER_HUB_ROLE_ID: 'role-a',
  AI_ROUTER_HUB_USER_ID: 'u-42',
  AI_ROUTER_HUB_ALLOW_REMOTE: '1',
}

/** 内存库：只有 meta 表（迁移只碰 marker）。 */
function memDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function fakeEditor(initial) {
  const state = { current: structuredClone(initial), edits: [], entry: null, calls: 0 }
  const ctx = {
    fiber: { entry: { id: 'whale-memory' } },
    get(name) {
      if (name !== 'configEditor') return undefined
      return {
        configuration() {
          return [{ entry: ctx.fiber.entry, inherited: {}, override: structuredClone(state.current) }]
        },
        async edit(entry, fn) {
          state.calls += 1
          state.entry = entry
          const next = fn(structuredClone(state.current))
          state.current = next
          state.edits.push(next)
          return next
        },
      }
    },
    effect(fn) { return fn() },
  }
  return { ctx, state }
}

const initialConfig = () => ({
  dataDir: '',
  backend: { mode: 'local', url: '', timeoutMs: 3000 },
  identity: { mode: 'auto', userId: '', roleId: '', workspace: 'web' },
  recall: { timeoutMs: 2000, maxHits: 7 },
  panel: { allowRemote: false, pollMs: 60000 },
  write: { dailyCap: 123 },
})

test('迁移映射：6 个旧 env → 对应叶子；local 切 http；其余字段原样保留', async () => {
  const db = memDb()
  const backend = { withDb(fn) { return fn(db) } }
  const { ctx, state } = fakeEditor(initialConfig())
  const logs = []
  const mig = installConfigMigration(ctx, { backend, env: LEGACY_ENV, log: (line) => logs.push(line) })
  await mig.run()

  assert.equal(state.calls, 1)
  assert.deepEqual(state.entry, { id: 'whale-memory' })
  const saved = state.edits[0]
  assert.equal(saved.backend.url, LEGACY_ENV.AI_ROUTER_GATEWAY)
  assert.equal(saved.backend.mode, 'http', 'local + 网关地址 ⇒ 切 http')
  assert.equal(saved.backend.timeoutMs, 1500)
  assert.equal(saved.recall.timeoutMs, 900)
  assert.equal(saved.identity.mode, 'fixed')
  assert.equal(saved.identity.roleId, 'role-a')
  assert.equal(saved.identity.userId, 'u-42')
  assert.equal(saved.identity.workspace, 'web', '未映射字段不得被组覆盖')
  assert.equal(saved.panel.allowRemote, true)
  assert.equal(saved.panel.pollMs, 60000)
  assert.equal(saved.recall.maxHits, 7)
  assert.equal(saved.write.dailyCap, 123)
  assert.doesNotThrow(() => Config(saved), '迁移产物必须能过 Config 校验，否则保存会被 schema 拒绝')

  assert.equal(mig.state.migratedFrom, 'hub-0.2.0')
  assert.equal(mig.state.pending, false)
  assert.match(String(mig.state.migratedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(getMeta(db, 'migrated_from'), 'hub-0.2.0')
  assert.ok(getMeta(db, 'migrated_at'))
  assert.ok(logs.some((line) => /已从旧版迁移/.test(line) && /可删除旧 env/.test(line)))
})

test('只执行一次：第二次启动读 meta marker，不再 edit', async () => {
  const db = memDb()
  const backend = { withDb(fn) { return fn(db) } }
  const first = fakeEditor(initialConfig())
  const one = installConfigMigration(first.ctx, { backend, env: LEGACY_ENV, log: () => {} })
  await one.run()
  assert.equal(first.state.calls, 1)

  const second = fakeEditor(first.state.current)
  const two = installConfigMigration(second.ctx, { backend, env: LEGACY_ENV, log: () => {} })
  await two.run()
  assert.equal(second.state.calls, 0, '已有 marker ⇒ 第二次不得再 edit')
  assert.equal(two.state.migratedFrom, 'hub-0.2.0')
  assert.equal(two.state.pending, false)
  assert.deepEqual(second.state.current, first.state.current, '配置不得被第二次改写')
})

test('没有旧 env：什么都不做（不读 marker、不 edit、不写 meta）', async () => {
  const db = memDb()
  let withDbCalls = 0
  const backend = { withDb(fn) { withDbCalls += 1; return fn(db) } }
  const { ctx, state } = fakeEditor(initialConfig())
  const mig = installConfigMigration(ctx, { backend, env: {}, log: () => {} })
  await mig.run()
  assert.equal(state.calls, 0)
  assert.equal(withDbCalls, 0, '无旧 env 不得碰本地库')
  assert.equal(getMeta(db, 'migrated_from'), null)
  assert.equal(mig.state.migratedFrom, null)
  assert.equal(mig.state.pending, false)
})

test('纯 http（backend 无 withDb）：落 $DSH_HOME/whale-memory/migration.json，第二次幂等', async () => {
  const home = mkdtempSync(join(tmpdir(), 'whale-mig-'))
  const env = { AI_ROUTER_GATEWAY: 'http://127.0.0.1:4999', AI_ROUTER_HUB_USER_ID: 'u-42' }
  const first = fakeEditor(initialConfig())
  const one = installConfigMigration(first.ctx, { backend: {}, env, dshHome: home, log: () => {} })
  await one.run()
  assert.equal(first.state.calls, 1)
  assert.equal(first.state.edits[0].backend.mode, 'http')

  const file = migrationFilePath({ dshHome: home })
  assert.equal(file, join(home, 'whale-memory', 'migration.json'))
  assert.ok(existsSync(file))
  const marker = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(marker.migratedFrom, 'hub-0.2.0')
  assert.match(String(marker.migratedAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(one.state.migratedFrom, 'hub-0.2.0')

  const second = fakeEditor(first.state.current)
  const two = installConfigMigration(second.ctx, { backend: {}, env, dshHome: home, log: () => {} })
  await two.run()
  assert.equal(second.state.calls, 0)
  assert.equal(two.state.migratedFrom, 'hub-0.2.0')
})

test('无 configEditor：标记 pending、不抛、不写 marker（下次启动重试）', async () => {
  const db = memDb()
  const backend = { withDb(fn) { return fn(db) } }
  const ctx = { fiber: { entry: { id: 'whale-memory' } }, get() { return undefined }, effect(fn) { return fn() } }
  const logs = []
  const mig = installConfigMigration(ctx, { backend, env: LEGACY_ENV, log: (line) => logs.push(line) })
  await mig.run()
  assert.equal(mig.state.pending, true)
  assert.equal(mig.state.migratedFrom, null)
  assert.equal(getMeta(db, 'migrated_from'), null)
  assert.ok(logs.some((line) => /迁移待执行/.test(line)))
})

test('非法/越界 env：数值夹到 schema 范围，布尔只认明确值，其余忽略', () => {
  const patch = readLegacyEnv({
    AI_ROUTER_HUB_TIMEOUT_MS: '',
    AI_ROUTER_HUB_RECALL_TIMEOUT_MS: 'not-a-number',
    AI_ROUTER_HUB_ALLOW_REMOTE: 'maybe',
    AI_ROUTER_HUB_USER_ID: '  ',
    AI_ROUTER_GATEWAY: '',
  })
  assert.equal(patch, null, '全部不可迁移 ⇒ null（什么都不做）')

  const partial = readLegacyEnv({ AI_ROUTER_HUB_TIMEOUT_MS: '999999', AI_ROUTER_HUB_ALLOW_REMOTE: 'off' })
  assert.equal(partial.patch.backend.timeoutMs, 30000)
  assert.equal(partial.patch.panel.allowRemote, false)
  assert.equal(partial.patch.identity, undefined)
})

test('已删配置键幂等清理：wrap.autoAccept 存在时 edit 一次并记 config_migrated；第二次零写入', async () => {
  const { ctx, state } = fakeEditor({ wrap: { enabled: true, autoAccept: true, idle: true } })
  const logs = []
  const cleaned = await cleanupDeprecatedConfig(ctx, { log: (line) => logs.push(line) })
  assert.deepEqual(cleaned, ['config_migrated:wrap.autoAccept'])
  assert.equal(state.calls, 1)
  assert.equal('autoAccept' in state.current.wrap, false, '旧键必须从持久化配置删除')
  assert.equal(state.current.wrap.idle, true, '其余叶子原样保留')
  assert.ok(logs.includes('[whale-memory] config_migrated:wrap.autoAccept'))

  const again = await cleanupDeprecatedConfig(ctx, { log: () => {} })
  assert.deepEqual(again, [])
  assert.equal(state.calls, 1, '幂等：第二次不得再写配置')
})

test('已删配置键清理：配置里没有旧键时零写入（不无脑 edit）', async () => {
  const { ctx, state } = fakeEditor({ wrap: { enabled: true, ingest: { mode: 'auto' } } })
  const cleaned = await cleanupDeprecatedConfig(ctx, { log: () => {} })
  assert.deepEqual(cleaned, [])
  assert.equal(state.calls, 0)
})
