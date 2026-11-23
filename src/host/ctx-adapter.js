/**
 * 宿主能力适配层（R9-09）：插件只经这里读 cordis 服务，缺服务时降级为 null 且只记一次日志。
 *
 * Why 单独成文件：
 * - `ctx.get(name)` 本身在真宿主里安全，但缺失服务时若各调用点各写 try/catch，故障会被吞成
 *   "某功能没反应"；集中一处才能保证 `fail-open domain=host service=<name>` 可解释（架构书 §3.1）。
 * - `agentDefaultModel.currentSelection()` 是**方法调用**不是属性读；散落在 hook/routes 里
 *   各写一遍，宿主形状一变就各坏各的。
 *
 * 边界：只读，不注册服务、不改 ctx、不缓存服务对象（宿主可能热替换）。
 */

/**
 * 建一个宿主适配器（每次 apply/install 建一个即可，内部按 service 去重告警）。
 *
 * @param {any} ctx cordis 上下文
 * @param {{log?:Function}} [opts]
 * @returns {{get:(name:string)=>any, llm:()=>any, selection:()=>({provider?:string,model?:string}|null),
 *   webServer:()=>any, credentials:()=>any, configEditor:()=>any, identity:()=>any}}
 */
export function createHostAdapter(ctx, { log = () => {} } = {}) {
  const warned = new Set()

  /**
   * 安全取服务：未提供/读取抛错一律 null；同一服务只告警一次（每步刷屏会淹掉真错误）。
   * @param {string} name @returns {any}
   */
  const get = (name) => {
    try {
      if (typeof ctx?.get !== 'function') return null
      return ctx.get(name) ?? null
    } catch (err) {
      if (!warned.has(name)) {
        warned.add(name)
        log(`[whale-memory] fail-open domain=host service=${name} error=${err?.message || err}`)
      }
      return null
    }
  }

  /** 当前默认模型选择（provider/model）；宿主未提供或形状不符返回 null。 */
  const selection = () => {
    const model = get('agentDefaultModel')
    try {
      return typeof model?.currentSelection === 'function' ? model.currentSelection() : null
    } catch {
      return null
    }
  }

  return {
    get,
    llm: () => get('llm'),
    selection,
    webServer: () => get('webServer'),
    credentials: () => get('credentials'),
    configEditor: () => get('configEditor'),
    identity: () => get('identity'),
  }
}
