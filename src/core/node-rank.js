// 职责：同身份同文节点「保留谁」的唯一质量排序（迁移去重 / 巩固收敛共用）；依赖：零 import。
//
// 为什么必须单点：审计 P2-F2 发现两条去重策略相反——启动迁移 dedupeActiveHashes 留“最早”，
// 巩固 convergeDuplicateHashes 留“最高信任”。升级只会跑前者，结果 owner/core/procedural 的
// 副本被退役、活跃行降级成 web/normal，保护面（免自动 MERGE/SUPERSEDE）静默消失。
// 现在两处都按同一质量序，且判据只此一处（铁律 2）。

/** 来源等级：owner > self > group > web/tool > import（与 writer SOURCE_MAP 语义一致）。 */
export const SOURCE_RANK = Object.freeze({ owner: 5, self: 4, group: 3, web: 2, tool: 2, import: 1 })
/** 记忆层级：core > important > normal。 */
export const LEVEL_RANK = Object.freeze({ core: 3, important: 2, normal: 1 })
/** 类型：procedural（可执行）优先于事实/情节；mixed 与 semantic 同档。 */
export const TYPE_RANK = Object.freeze({ procedural: 2, semantic: 1, mixed: 1, episodic: 0 })

/** 质量序（JS 排序版）：>0 表示 b 更该保留；用于已取出的行数组。 */
export function compareQuality(a, b) {
  return (Number(b?.pinned || 0) - Number(a?.pinned || 0))
    || ((LEVEL_RANK[String(b?.level)] ?? 0) - (LEVEL_RANK[String(a?.level)] ?? 0))
    || ((SOURCE_RANK[String(b?.source)] ?? 0) - (SOURCE_RANK[String(a?.source)] ?? 0))
    || ((TYPE_RANK[String(b?.memory_type)] ?? 0) - (TYPE_RANK[String(a?.memory_type)] ?? 0))
    || (Number(a?.created_at || 0) - Number(b?.created_at || 0))
    || (String(a?.id) < String(b?.id) ? -1 : 1)
}

/**
 * 质量序（SQL ORDER BY 版）：只接受 nodes 表自身的列名，不接受参数拼表。
 * @param {string} [alias] 表别名（如 'n.'）；空＝无别名
 * @returns {string} 可直接拼进 ORDER BY 的片段
 */
export function qualityOrderSql(alias = '') {
  const p = String(alias || '')
  return `${p}pinned DESC,`
    + ` CASE ${p}level WHEN 'core' THEN 3 WHEN 'important' THEN 2 ELSE 1 END DESC,`
    + ` CASE ${p}source WHEN 'owner' THEN 5 WHEN 'self' THEN 4 WHEN 'group' THEN 3 WHEN 'web' THEN 2 WHEN 'tool' THEN 2 ELSE 1 END DESC,`
    + ` CASE ${p}memory_type WHEN 'procedural' THEN 2 WHEN 'episodic' THEN 0 ELSE 1 END DESC,`
    + ` ${p}created_at ASC, ${p}rowid ASC`
}
