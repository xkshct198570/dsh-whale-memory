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
