// 职责：backend 共同底座——身份类型、字段白名单、身份 WHERE 安全闸。
// 依赖方向：零 import（纯常量/纯函数）；被 local-db/query-api/write-api/transfer 引用，不得反向 import 任何 backend 子模块。

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

/** 节点导出字段白名单（顺序即 JSONL 列顺序；导出/导入保真口径）。 */
export const NODE_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'pinned', 'hits', 'last_hit_at', 'vector_state',
  'created_at', 'updated_at', 'valid_at', 'invalid_at', 'expired_at', 'superseded_by',
  'origin', 'trace_id', 'text_hash',
]

/**
 * 导出身份过滤：与 search 同口径 `(列='' OR 列=?)`，空身份字段不过滤。
 * 为什么导出也要过滤：导出文件会被拿去推送/外传，不带身份条件等于跨分区泄漏。
 *
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @returns {{ sql: string, params: string[] }}
 */
export function identityFilter(identity) {
  const clauses = []
  const params = []
  for (const [col, raw] of [
    ['user_id', identity?.userId],
    ['role_id', identity?.roleId],
    ['workspace', identity?.workspace],
  ]) {
    const value = typeof raw === 'string' ? raw : String(raw ?? '')
    if (!value) continue
    clauses.push(`(${col} = '' OR ${col} = ?)`)
    params.push(value)
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * 完整 WHERE：身份条件 + 额外条件（全部 AND）。列名属于 nodes 表本身（不做别名）。
 *
 * why 不直接拼字符串：身份条件是安全闸，额外条件（id/action/source）是业务过滤，
 * 两者混写时最容易漏参数占位，导致"查询全表"这种静默越权。
 *
 * @param {Identity|null|undefined} identity
 * @param {Array<[string, unknown[]]>} [extra] 每项 `[SQL 片段, 参数数组]`
 * @returns {{ sql: string, params: string[] }}
 */
export function whereOf(identity, extra = []) {
  const filter = identityFilter(identity)
  const parts = []
  const params = []
  if (filter.sql) {
    parts.push(filter.sql.slice(' WHERE '.length))
    params.push(...filter.params)
  }
  for (const [sql, args] of extra) {
    parts.push(sql)
    params.push(...(args || []))
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
}
