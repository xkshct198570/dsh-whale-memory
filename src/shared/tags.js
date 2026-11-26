// 职责：nodes.tags 的归一与解析（纯函数，零 import）；host 投影与 core 关系层共用同一判据。
// 依赖方向：shared 层最底；被 core/relations.js（再导出）与 host/tools.js import；不得 import host/core。

/**
 * 标签数组（去空、去重、小写比较但保留原样）。
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? '').trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * 解析库里存的 tags JSON；坏数据当空数组（读路径绝不抛）。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseTags(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? normalizeTags(parsed) : []
  } catch { return [] }
}
