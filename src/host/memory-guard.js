/**
 * 进程内存闸门：DSH Host 常驻 RSS 700-900MB 属正常，不能拿固定 RSS 当"告急"。
 * 口径：系统可用内存 <500MB 或本进程 RSS >2GB 才跳过后台重活（反思/搜索反哺）。
 */
import { freemem } from 'node:os'

const FREE_FLOOR = 500 * 1024 * 1024
const RSS_CEIL = 2 * 1024 * 1024 * 1024

export function memoryPressure() {
  const free = freemem()
  const rss = process.memoryUsage().rss
  return { stress: free < FREE_FLOOR || rss > RSS_CEIL, freeMB: Math.round(free / 1048576), rssMB: Math.round(rss / 1048576) }
}
