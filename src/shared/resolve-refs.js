/**
 * 递归解 Ref 树：把配置对象里所有 schemastery `.volatile()` Ref 换成正本值。
 *
 * 用途：面板回显（src/host/routes.js）与配置迁移写值（src/host/config-migration.js）共用同一判据，
 * 只有这一份实现，避免两处漂移。
 * 依赖方向：shared 内纯函数，不 import host/core。
 *
 * @param {unknown} input 可能含 Ref 的配置树（对象/数组/标量）
 * @returns {unknown} 解 Ref 后的新树；标量原样返回
 */
export function resolveRefsDeep(input) {
  if (input && typeof input === 'object' && typeof input.get === 'function' && !Array.isArray(input)) {
    return resolveRefsDeep(input.get())
  }
  if (Array.isArray(input)) return input.map((item) => resolveRefsDeep(item))
  if (input && typeof input === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(input)) out[key] = resolveRefsDeep(val)
    return out
  }
  return input
}
