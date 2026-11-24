/**
 * 面板配置工具：可读写组清单、按叶子深合并、回显、回读与运行时同步。
 *
 * 拆分（P2d）：配置组/合并/回显/回读与运行时同步集中在本文件；
 * 端点分发在 router.js，配置端点处理在 config-sync.js。
 * 依赖方向：host → host/config.js + shared。
 */
import { Config } from '../config.js'
import { mergePreservingVolatile } from '../../shared/config-values.js'
import { resolveRefsDeep } from '../../shared/resolve-refs.js'

export const CONFIG_GROUPS = [
  'backend', 'identity', 'recall', 'write', 'reflect', 'wrap', 'consolidate',
  'embed', 'privacy', 'edges', 'sync', 'rules', 'panel', 'advanced',
]
export const CONFIG_KEYS = ['dataDir', ...CONFIG_GROUPS]

/** schemastery 默认值（空配置即开箱值），作为回显/深合并的基线。 */
const CONFIG_DEFAULTS = Config({})

/**
 * 按叶子字段深合并：对象递归合并，数组/标量直接替换。
 * 只有提交的叶子会被覆盖；未提交的叶子（含组内默认值）保持原样。
 */
export function deepMergeLeaf(current, patch) {
  const out = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const base = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}
      out[key] = deepMergeLeaf(base, val)
    } else {
      out[key] = Array.isArray(val) ? val.slice() : val
    }
  }
  return out
}

/** 全部组回显：默认值打底 + 运行时实值覆盖（值一律解 Ref）。 */
export function echoConfig(config) {
  return deepMergeLeaf(resolveRefsDeep(CONFIG_DEFAULTS), resolveRefsDeep(config || {}))
}

/** 只看 GET 回显集合内的顶层键（白名单与 echoConfig 同源）。 */
export function pickConfigKeys(next) {
  const patch = {}
  for (const key of CONFIG_KEYS) {
    if (!(key in next)) continue
    const val = next[key]
    if (key === 'dataDir') {
      if (typeof val === 'string') patch.dataDir = val
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      patch[key] = val
    }
  }
  return patch
}

/** 保存后回读：编辑器支持 configuration() 时以加载器层为准。 */
export function readBackConfig(editor, entry, fallback) {
  try {
    if (typeof editor.configuration !== 'function') return fallback
    const rows = editor.configuration()
    const row = Array.isArray(rows) ? rows.find((item) => item && item.entry === entry) : null
    const override = row?.override
    if (override && typeof override === 'object' && !Array.isArray(override)) {
      return deepMergeLeaf(fallback || {}, resolveRefsDeep(override))
    }
  } catch { /* 回读失败不阻塞保存：以 editor.edit 回调结果为准 */ }
  return fallback
}

/** 把保存结果按叶子合并进运行时 config（同一 deepMergeLeaf，不整组替换）。 */
export function syncRuntimeConfig(config, saved) {
  if (!config || typeof config !== 'object' || !saved || typeof saved !== 'object') return
  for (const key of CONFIG_GROUPS) {
    if (!(key in saved)) continue
    // 保留 Ref 引用身份：整组替换会让宿主后续 volatile 更新静默失效（审计 P1-15）。
    config[key] = mergePreservingVolatile(config[key] ?? {}, saved[key])
  }
  if (typeof saved.dataDir === 'string') config.dataDir = saved.dataDir
}

