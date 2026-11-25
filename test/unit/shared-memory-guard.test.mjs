/**
 * memory-guard 纯判定契约：可用内存解析与压力边界。
 *
 * P2a 从 src/host 搬进 src/shared；本文件锁住搬家前的输入/输出边界，
 * 并承接原先放在 test/data/import-export.test.mjs 的两条内存闸门用例（断言保留并补边界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableBytes, memoryPressure, FREE_FLOOR, RSS_CEIL } from '../../src/shared/memory-guard.js'

test('常量口径：可用内存地板 500MB、进程 RSS 天花板 2GB', () => {
  assert.equal(FREE_FLOOR, 500 * 1024 * 1024)
  assert.equal(RSS_CEIL, 2 * 1024 * 1024 * 1024)
})

test('availableBytes：优先 MemAvailable（含可回收缓存），缺行/异常回落 freemem', () => {
  const meminfo = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    4096000 kB\n'
  assert.equal(availableBytes(() => meminfo), 4096000 * 1024)

  // 没有 MemAvailable 行 / 读取抛错 / 非法数值：回落 os.freemem()（非负有限数）
  for (const reader of [
    () => 'MemTotal: 1000 kB\n',
    () => { throw new Error('no proc') },
    () => 'MemAvailable: not-a-number kB\n',
    () => 'MemAvailable: -1 kB\n',
  ]) {
    const fallback = availableBytes(reader)
    assert.equal(Number.isFinite(fallback), true)
    assert.ok(fallback >= 0)
  }
})

test('memoryPressure：free < 500MB 或 rss > 2GB 才算压力，等号不算', () => {
  const noRss = () => 1
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR - 1, rssBytes: noRss }).stress, true)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR, rssBytes: noRss }).stress, false)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR * 10, rssBytes: () => RSS_CEIL + 1 }).stress, true)
  assert.equal(memoryPressure({ freeBytes: () => FREE_FLOOR * 10, rssBytes: () => RSS_CEIL }).stress, false)
})

test('memoryPressure：数值注入、MB 取整与原始字节回显', () => {
  const pressure = memoryPressure({ freeBytes: FREE_FLOOR - 1024, rssBytes: 1024 })
  assert.equal(pressure.stress, true)
  assert.equal(pressure.free, FREE_FLOOR - 1024)
  assert.equal(pressure.rss, 1024)
  assert.equal(pressure.freeMB, Math.round((FREE_FLOOR - 1024) / 1048576))
  assert.equal(pressure.rssMB, 0)

  const healthy = memoryPressure({ freeBytes: 8 * 1024 * 1024 * 1024, rssBytes: 900 * 1024 * 1024 })
  assert.equal(healthy.stress, false)
  assert.equal(healthy.freeMB, 8192)
  assert.equal(healthy.rssMB, 900)
})

test('memoryPressure：非有限数按默认探测处理，不产生 NaN 输出', () => {
  // NaN 不是 Number.isFinite，走默认 availableBytes()/process.rss；只断言输出形状稳定。
  const pressure = memoryPressure({ freeBytes: NaN, rssBytes: NaN })
  assert.equal(typeof pressure.stress, 'boolean')
  assert.equal(Number.isFinite(pressure.free), true)
  assert.equal(Number.isFinite(pressure.rss), true)
  assert.equal(Number.isFinite(pressure.freeMB), true)
  assert.equal(Number.isFinite(pressure.rssMB), true)
})
