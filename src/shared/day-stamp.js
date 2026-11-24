/**
 * 本地日期戳 YYYY-MM-DD：日报/收尾报告文件名与台账日期口径。
 * 依赖方向：shared 内纯函数，无 import；按进程本地时区（不做 UTC 转换）。
 * @param {number} seconds 秒级时间戳；非有限数按 0（1970-01-01）处理，不输出 NaN 日期
 * @returns {string} YYYY-MM-DD
 */
export function dayStamp(seconds) {
  const n = Number(seconds)
  const d = new Date((Number.isFinite(n) ? n : 0) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
