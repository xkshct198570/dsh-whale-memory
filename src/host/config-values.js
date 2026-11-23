/**
 * schemastery `.volatile()` 字段是 Ref：必须 `.get()` 才是值。
 * 统一在这里取值，禁止在路由/hook 里直接 `=== false`（Ref 恒真，会绕过开关）。
 */
export function value(v, fallback) {
  const raw = v && typeof v.get === 'function' ? v.get() : v
  return raw === undefined ? fallback : raw
}

export function bool(v, fallback = false) {
  const raw = value(v, fallback)
  return typeof raw === 'boolean' ? raw : fallback
}

export function num(v, fallback) {
  const raw = Number(value(v, fallback))
  return Number.isFinite(raw) ? raw : fallback
}

/**
 * cosmokit Volatile 写协议（与宿主 `updateVolatile` 同一符号，跨 ESM/CJS 拷贝仍识别）。
 * 配置保存时若把 Ref 整个替换成普通值，宿主后续“只改 volatile 字段”的更新会找不到 Ref、
 * 静默失效直到重启（审计 P1-15）——回写运行态时必须保住原 Ref。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** @param {unknown} v @returns {boolean} 是否是 cosmokit Volatile 引用 */
export function isVolatileRef(v) {
  return Boolean(v) && typeof v === 'object' && VOLATILE_WRITE in /** @type {object} */ (v)
}

/** 把一个普通值写进既有 Ref（值由宿主自己做不可变快照）。 */
function writeRef(ref, value) {
  try {
    const current = typeof ref.get === 'function' ? ref.get() : undefined
    if (JSON.stringify(current) === JSON.stringify(value)) return
  } catch { /* 比较失败照常写 */ }
  ref[VOLATILE_WRITE](value)
}

/**
 * 按叶子合并 patch 到运行态配置对象，**保留既有 Volatile Ref 的引用身份**：
 * - 目标是 Ref ⇒ 通过写协议更新值，不换对象；
 * - 目标是普通对象 ⇒ 递归合并；
 * - 其余（标量/数组）⇒ 直接替换。
 *
 * @param {any} target 运行态配置组（可能含 Ref）
 * @param {any} patch 面板提交的叶子
 * @returns {any} 合并后的对象（优先原地改 target，返回 target）
 */
export function mergePreservingVolatile(target, patch) {
  // 整组本身就是 Ref（schemastery 对嵌套 volatile 对象也可能给 Ref）：只能写值，不能展开。
  if (isVolatileRef(target)) { writeRef(target, patch); return target }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = base[key]
    if (isVolatileRef(current)) { writeRef(current, value); continue }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = current && typeof current === 'object' && !Array.isArray(current)
        ? mergePreservingVolatile(current, value)
        : mergePreservingVolatile({}, value)
      continue
    }
    base[key] = Array.isArray(value) ? value.slice() : value
  }
  return base
}
