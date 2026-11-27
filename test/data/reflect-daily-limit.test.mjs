/**
 * 0.8.1-09 反思自动日限落库：按本地自然日从 jobs 汇总 reason∈{turn_steps,idle}，
 * 重启后同日不超限；查询故障回落进程内计数并留可见日志。
 *
 * 为什么必须真库：旧实现是进程内 autoDay/autoRuns，重启即清零——单测若只测内存计数
 * 会把这个回归全绿放行；这里造 jobs 行并新建 scheduler 实例，证明「重启后仍受限」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper } from '../../src/core/keeper.js'
import { installReflectScheduler } from '../../src/core/reflect.js'
import { localDayStart } from '../../src/shared/maintenance-window.js'

const identity = { userId: 'u1', roleId: '', workspace: '/work/ws' }
const ctx = { on: () => () => {} }

function makeBackend(t) {
  const home = mkdtempSync(join(tmpdir(), 'whale-reflect-daily-'))
  const backend = createBackend({ mode: 'local' }, { dataDir: home, useWorker: false, config: {}, log: () => {} })
  t.after(() => { backend.dispose(); rmSync(home, { recursive: true, force: true }) })
  return backend
}

/** 直接造 jobs 行（不跑反思，避免依赖模型）：created_at 落在今天。 */
function seed(backend, reason, state = 'done', ts = Date.now() / 1000) {
  return backend.withDb((db) => db.prepare(
    'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('reflect', state, 1, JSON.stringify({ identity, sessionId: 's1', reason }), ts, ts).lastInsertRowid)
}

function makeScheduler(backend, keeper, config, seen) {
  const scheduler = installReflectScheduler(ctx, {
    backend, config, keeper,
    getLlm: () => null, getSelection: () => null, log: (line) => seen.push(line),
  })
  return scheduler
}

const baseConfig = (over = {}) => ({
  reflect: { enabled: true, idleMinutes: 30, maxItems: 8, maxRunsPerDay: 2, ...over },
  maintenance: { suppressWindows: [] },
})

test('日限按当日 jobs 汇总：新建实例（=重启）后同日仍不超限；手动行不计入', (t) => {
  const backend = makeBackend(t)
  const seen = []
  const keeper = createKeeper({ store: backend, config: {}, log: (line) => seen.push(line), intervalMs: 3600_000 })
  t.after(() => keeper.dispose())

  seed(backend, 'turn_steps')
  seed(backend, 'idle')
  seed(backend, 'manual') // 手动反思不进日限
  seed(backend, 'turn_steps', 'done', localDayStart() - 3600) // 昨天的行不算今日

  // 新实例：内存计数为 0，只有落库汇总能挡住。
  const scheduler = makeScheduler(backend, keeper, baseConfig(), seen)
  t.after(() => scheduler.dispose())
  const out = scheduler.scheduleAuto({ identity, sessionId: 's1', reason: 'turn_steps' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'daily_limit')
})

test('手动行不占日限：只有 manual 行时自动仍可入队（payload 带 reason）', (t) => {
  const backend = makeBackend(t)
  const seen = []
  const keeper = createKeeper({ store: backend, config: {}, log: (line) => seen.push(line), intervalMs: 3600_000 })
  t.after(() => keeper.dispose())
  seed(backend, 'manual')
  seed(backend, 'manual')

  const scheduler = makeScheduler(backend, keeper, baseConfig({ maxRunsPerDay: 1 }), seen)
  t.after(() => scheduler.dispose())
  const out = scheduler.scheduleAuto({ identity, sessionId: 's1', reason: 'turn_steps' })
  assert.equal(out.ok, true)
  assert.equal(out.scheduled, true)
  const row = backend.withDb((db) => db.prepare(
    "SELECT payload FROM jobs WHERE id=?",
  ).get(out.jobId))
  assert.equal(JSON.parse(row.payload).reason, 'turn_steps')
})

test('查询故障回落内存计数并留可见日志（fail-open 不得静默）', (t) => {
  const seen = []
  let enqueued = 0
  const fakeKeeper = {
    register() {},
    countActive: () => 0,
    countRuns: () => { throw new Error('count_boom') },
    enqueue: () => { enqueued += 1; return 100 + enqueued },
  }
  const backend = makeBackend(t)
  const scheduler = installReflectScheduler(ctx, {
    backend, config: baseConfig({ maxRunsPerDay: 1 }), keeper: fakeKeeper,
    getLlm: () => null, getSelection: () => null, log: (line) => seen.push(line),
  })
  t.after(() => scheduler.dispose())
  const first = scheduler.scheduleAuto({ identity, sessionId: 's1', reason: 'idle' })
  assert.equal(first.ok, true)
  const second = scheduler.scheduleAuto({ identity, sessionId: 's1', reason: 'idle' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'daily_limit', '回落计数必须仍然生效')
  assert.ok(seen.some((line) => line.includes('daily count fallback to memory')),
    '回落必须留一条可见日志')
})
