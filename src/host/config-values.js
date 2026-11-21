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
