// 职责：峰时抑制窗口（本地时区）解析与判定，纯函数零依赖；被 core/reflect 与测试共用。
// 契约：字符串 "HH:MM-HH:MM"；跨午夜用 start>end 表达；坏值不抛错，收集到 invalid 由调用方留日志（fail-open）。

/**
 * @typedef {{ start: number, end: number, text: string }} SuppressWindow
 *   start/end 为本地当日分钟数（0..1439）；start>end 表示跨午夜。
 */

const WINDOW_RE = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/

/**
 * 解析配置里的 suppressWindows（容忍 Ref/非数组/脏项）。
 * 坏值不丢弃整个列表：能解析的窗口照常生效，坏项进 invalid；调用方按签名去重记日志。
 *
 * @param {unknown} raw 形如 ["09:00-12:00","23:00-07:00"]
 * @returns {{ windows: SuppressWindow[], invalid: string[] }} invalid 为原始项的可读字符串
 */
export function compileSuppressWindows(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
  /** @type {SuppressWindow[]} */
  const windows = []
  const invalid = []
  for (const entry of list) {
    const text = String(entry ?? '')
    const m = WINDOW_RE.exec(text)
    if (!m) { invalid.push(text); continue }
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59 || start === end) {
      invalid.push(text)
      continue
    }
    windows.push({ start, end, text: text.trim() })
  }
  return { windows, invalid }
}

/**
 * 当前时刻是否落在任一抑制窗口内（本地时区）。
 * 跨午夜窗口（start>end）按 `now>=start || now<end` 判定。
 *
 * @param {SuppressWindow[]} windows compileSuppressWindows().windows
 * @param {Date} [date] 注入时钟（测试用）；缺省当前时刻
 * @returns {boolean}
 */
export function inSuppressWindow(windows, date = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const d = date instanceof Date ? date : new Date()
  const minutes = d.getHours() * 60 + d.getMinutes()
  return windows.some((w) => (w.start <= w.end
    ? minutes >= w.start && minutes < w.end
    : minutes >= w.start || minutes < w.end))
}

/**
 * 本地日期键（日限按本地自然日重置；UTC 会让夜间预算跨日错位）。
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
