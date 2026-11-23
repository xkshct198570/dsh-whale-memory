/**
 * 最近一次规则注入的统计（进程内单槽，供 `/rules/health` 读黄灯）。
 *
 * 为什么需要进程内单槽：注入 skip 是「运行时事实」，磁盘上没有任何痕迹；
 * health 只读磁盘，若不接这条线，被预算挤掉的规则会静默消失（架构书 §4.2）。
 * 只存最后一轮：health 要的是「现在这轮有没有规则没进去」，不是历史统计。
 */

/** @type {{at:number, keys:string[], skipped:Array<{key:string,chars:number}>, chars:number, mode:string, cached:boolean}|null} */
let last = null

/**
 * 记录一次注入结果（hook 每轮 pre-step 调用；缓存命中也要记，skip 才是当前事实）。
 * @param {{keys?:string[], skipped?:Array<{key:string,chars:number}>, chars?:number,
 *   mode?:string, cached?:boolean}} [stats]
 * @returns {void}
 */
export function recordInjection(stats = {}) {
  last = {
    at: Date.now(),
    keys: Array.isArray(stats.keys) ? stats.keys : [],
    skipped: Array.isArray(stats.skipped) ? stats.skipped : [],
    chars: Number(stats.chars) || 0,
    mode: String(stats.mode || ''),
    cached: Boolean(stats.cached),
  }
}

/**
 * 最近一次注入统计（无记录返回 null；调用方按 null=没有注入事实处理）。
 * @returns {{at:number, keys:string[], skipped:Array<{key:string,chars:number}>, chars:number,
 *   mode:string, cached:boolean}|null}
 */
export function lastInjection() {
  return last
}

/** 测试/dispose 用：清空单槽。 */
export function resetInjectionStats() {
  last = null
}
