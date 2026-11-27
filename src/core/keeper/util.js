/**
 * keeper 通用小工具：秒数归一、文本截断、job payload 的 JSON 安全解析。
 * 依赖方向：core 内部纯函数，无 import；`toSeconds` 由 scheduler 与 handlers 共用，
 * `clampText`/`safeJson` 仅 scheduler 使用。
 */
export const toSeconds = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
export const clampText = (value, max = 500) => String(value ?? '').slice(0, max)

export function safeJson(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/**
 * handler 硬超时（0.8.1-07）：超时让调用方按失败收尾，队列可继续跑别的 kind。
 * 输掉的 promise 必须挂 catch —— 否则迟到 reject 会变成 unhandledRejection。
 *
 * @param {Promise<any>} task
 * @param {number} ms 正数；<=0 由调用方决定不走本函数
 * @param {string} label 日志标签（如 `reflect:42`，不含正文）
 * @returns {Promise<any>}
 */
export function withHandlerTimeout(task, ms, label) {
  const limit = Math.max(1, Math.floor(Number(ms) || 0))
  let timer = null
  const guarded = Promise.resolve(task)
  guarded.catch(() => {})
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler_timeout:${label}:${limit}ms`)), limit)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([guarded, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}
