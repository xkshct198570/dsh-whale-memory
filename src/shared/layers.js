// 职责：分层标签词汇（v7：fact/lesson/user）唯一真源；依赖为零，core/shared/host 共用。
//
// 为什么单独成模块：白名单（写入校验）、分组查询（profileLayers）、画像渲染分组三处都用到
// 同一组值；各写一份时新增一层要改三处，且容易漂移成"能写不能读"。

/** 合法分层标签（顺序即枚举顺序；NULL=未分层由调用方表达）。 */
export const LAYERS = Object.freeze(['fact', 'lesson', 'user'])

/**
 * memory_type → layer（S4 reflect 用）：procedural≈lesson、semantic≈fact。
 * 与收尾的 `LAYER_OF_KIND`（kind→layer）同口径：lesson 的 memory_type 恒 procedural；
 * 反思只产出 semantic/procedural（不产 preference），所以这里不映射 user。
 */
export const LAYER_OF_TYPE = Object.freeze({ procedural: 'lesson', semantic: 'fact' })

/**
 * @param {unknown} type
 * @returns {'fact'|'lesson'|null}
 */
export function layerOfMemoryType(type) {
  const key = String(type ?? '')
  return LAYER_OF_TYPE[key] || null
}

const LAYER_SET = new Set(LAYERS)

/**
 * 分层标签收敛：只允许 LAYERS 之一，其余（缺省/旧调用方/脏导入）一律 NULL。
 *
 * 为什么不在 DB 加 CHECK：老库走 ALTER TABLE 加不了 CHECK；且未知值的语义就是"未分层"，
 * 写入层白名单 + 读路径按 IN 三值过滤同样安全，迁移也不需要重建表。
 *
 * @param {unknown} layer
 * @returns {'fact'|'lesson'|'user'|null}
 */
export function validLayer(layer) {
  const value = String(layer ?? '')
  return LAYER_SET.has(value) ? /** @type {'fact'|'lesson'|'user'} */ (value) : null
}
