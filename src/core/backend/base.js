// 职责：backend 共同底座——身份类型、字段白名单、身份 WHERE 安全闸、原型装配工具（installMethods）。
// 依赖方向：零 import（纯常量/纯函数）；被 local-db/query-api/write-api/transfer 引用，不得反向 import 任何 backend 子模块。

/** @typedef {{ userId: string, roleId: string, workspace: string }} Identity */

/** 节点导出字段白名单（顺序即 JSONL 列顺序；导出/导入保真口径）。 */
export const NODE_EXPORT_FIELDS = [
  'id', 'role_id', 'user_id', 'workspace', 'text', 'level', 'memory_type', 'source', 'status',
  'tags', 'context_note', 'weight', 'pinned', 'hits', 'last_hit_at', 'vector_state',
  'created_at', 'updated_at', 'valid_at', 'invalid_at', 'expired_at', 'superseded_by',
  'origin', 'trace_id', 'text_hash', 'layer',
]

/**
 * 身份过滤：`(列='' OR 列=?)`——共享分区('')对任何分区可见，跨分区互不可见。
 *
 * 关键判据（审计 P0）：**只要调用方给了 identity 对象，就必须过滤**，空字符串是分区值
 * 而不是"不过滤"。旧实现 `if (!value) continue` 让 `workspace=''` 退化成全库可见：
 * 面板默认身份 workspace='' 时 /nodes /export /writes 会返回别的 workspace 的节点与正文。
 * 身份对象为 null/undefined 才表示内部管理查询（stats/计数），此时不过滤。
 *
 * 为什么仍保留 `列='' OR`：共享记忆（空分区）按设计对所有分区可见，见
 * `test/data/blind-spots.test.mjs` 盲区①；删掉会切断共享规则/事实召回。
 *
 * 同一判据只此一处：search.js / relations.js 复用本函数，禁止再抄一份（铁律 2）。
 *
 * @param {{ userId?: unknown, roleId?: unknown, workspace?: unknown } | null | undefined} identity
 * @param {{ alias?: string, operator?: string }} [opts] alias＝列前缀（如 'n.'），operator＝子句连接符
 * @returns {{ sql: string, params: string[] }} sql 不含前导 WHERE（调用方决定拼法）
 */
export function identityFilter(identity, { alias = '', operator = ' AND ' } = {}) {
  if (!identity || typeof identity !== 'object') return { sql: '', params: [] }
  const prefix = String(alias || '')
  const clauses = []
  const params = []
  for (const [col, raw] of [
    ['user_id', identity.userId],
    ['role_id', identity.roleId],
    ['workspace', identity.workspace],
  ]) {
    const value = typeof raw === 'string' ? raw : String(raw ?? '')
    clauses.push(`(${prefix}${col} = '' OR ${prefix}${col} = ?)`)
    params.push(value)
  }
  return { sql: clauses.join(operator), params }
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
    parts.push(filter.sql)
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
  if (!proto || typeof proto !== 'object') throw new TypeError('installMethods: constructor with prototype required')
  // 两段式：先全部校验/合并描述符，再一次 defineProperties —— 任一重名则整体不落，
  // 不留“装了一半”的原型（跨域同名时尤其重要）。
  const merged = Object.create(null) // 无原型：方法名恰为 __proto__ 时也不会改到合并表原型
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
