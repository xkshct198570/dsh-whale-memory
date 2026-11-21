/**
 * 进程内存闸门：DSH Host 常驻 RSS 700-900MB 属正常，不能拿固定 RSS 当"告急"。
 *
 * 口径（Why）：系统可用内存 <500MB 或本进程 RSS >2GB 才跳过后台重活（反思/搜索反哺）。
 * 可用内存优先读 /proc/meminfo 的 MemAvailable，而不是 os.freemem()：
 * Linux 的 freemem() 是 MemFree，不含可回收的 page cache，会把"其实够用"误判成压力
 * （反过来在某些容器里也可能高估，故仍保留 freemem() 作为读不到时的兜底）。
 */
import { readFileSync } from 'node:fs'
import { freemem } from 'node:os'

/** 系统可用内存地板（500MB）。 */
export const FREE_FLOOR = 500 * 1024 * 1024
/** 本进程 RSS 天花板（2GB）。 */
export const RSS_CEIL = 2 * 1024 * 1024 * 1024

/** 默认读 /proc/meminfo；不存在（非 Linux）时抛错，由调用方回落 freemem()。 */
function readMeminfo() {
  return readFileSync('/proc/meminfo', 'utf8')
}

/**
 * 系统可用内存（字节）：优先 MemAvailable（含可回收缓存），读不到回落 os.freemem()。
 *
 * @param {() => string} [readText] 可注入的 meminfo 读取器（测试用）
 * @returns {number} 字节数
 */
export function availableBytes(readText = readMeminfo) {
  try {
    const text = String(readText())
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)
    if (match) {
      const kb = Number(match[1])
      if (Number.isFinite(kb) && kb >= 0) return kb * 1024
    }
  } catch {
    // 读不到就回落：闸门不能因为读文件失败而抛错阻断主流程
  }
  return freemem()
}

/**
 * 内存压力判定（可注入 freeBytes/rssBytes，便于单测边界）。
 *
 * @param {{ freeBytes?: number|(() => number), rssBytes?: number|(() => number) }} [deps]
 * @returns {{ stress: boolean, freeMB: number, rssMB: number, free: number, rss: number }}
 */
export function memoryPressure({ freeBytes, rssBytes } = {}) {
  const free = typeof freeBytes === 'function'
    ? Number(freeBytes())
    : Number.isFinite(freeBytes) ? Number(freeBytes) : availableBytes()
  const rss = typeof rssBytes === 'function'
    ? Number(rssBytes())
    : Number.isFinite(rssBytes) ? Number(rssBytes) : process.memoryUsage().rss
  return {
    stress: free < FREE_FLOOR || rss > RSS_CEIL,
    freeMB: Math.round(free / 1048576),
    rssMB: Math.round(rss / 1048576),
    free,
    rss,
  }
}
