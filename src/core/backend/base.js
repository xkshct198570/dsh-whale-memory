// 职责：backend 共同底座——身份类型、字段白名单、身份 WHERE 安全闸、原型装配工具（installMethods）。
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

/**
 * 原型装配：把各域方法对象装到类的 prototype 上，描述符与 class 方法一致。
 *
 * why 不用 Object.assign：它只搬值不搬描述符——getter 会退化成字段、方法变成可枚举，
 * 原型对拍与 for-in 行为都会变；这里按描述符装并强制 `enumerable:false`。
 * why 装载前查重：同名成员若被后装域覆盖就是静默丢方法，必须当场抛错（禁止静默失败）。
 *
 * @param {Function} Cls 目标类（其 prototype 承载底座成员）
 * @param {...object} methodSets 每个域的方法对象（键=方法名）
 * @returns {Function} 入参 Cls
 */
export function installMethods(Cls, ...methodSets) {
  const proto = Cls && Cls.prototype
  if (!proto || typeof proto !== 'object') throw new TypeError('installMethods: Class required')
  // 两段式：先全部校验/合并描述符，再一次 defineProperties —— 任一重名则整体不落，
  // 不留“装了一半”的原型（跨域同名时尤其重要）。
  const merged = {}
  for (const methods of methodSets) {
    const descriptors = Object.getOwnPropertyDescriptors(methods)
    for (const key of Object.keys(descriptors)) {
      if (key === 'constructor') throw new Error('installMethods: constructor not allowed')
      if (Object.prototype.hasOwnProperty.call(proto, key) || Object.prototype.hasOwnProperty.call(merged, key)) {
        throw new Error(`installMethods: duplicate member ${key}`)
      }
      descriptors[key].enumerable = false
      merged[key] = descriptors[key]
    }
  }
  Object.defineProperties(proto, merged)
  return Cls
}
