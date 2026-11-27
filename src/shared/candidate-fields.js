// 职责：判重候选字段集唯一真源（最近窗口与 FTS 并集必须同字段，否则并集会丢双时态导致误 SUPERSEDE）；零依赖，不 import 业务模块。

/** 判重候选列（顺序即 node:sqlite 行对象键序；search 与 decide 共用，禁止各写一份 SELECT 列表）。 */
export const CANDIDATE_COLUMNS = Object.freeze([
  'id', 'text', 'level', 'memory_type', 'source', 'valid_at', 'invalid_at',
])

/**
 * 拼候选 SELECT 列表。
 * @param {string} [alias] 表别名前缀（如 `n.`）；缺省不加前缀
 * @returns {string} 逗号分隔的列名
 */
export function candidateSelect(alias = '') {
  return CANDIDATE_COLUMNS.map((column) => `${alias}${column}`).join(',')
}
