// 职责：规则根与规则文件路径的单一真源（默认根/根归一/落点）；依赖：node:os、node:path，不依赖上层。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 默认规则根：`$DSH_HOME/rules`，未设 DSH_HOME 时 `~/.dsh/rules`。
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function defaultRuleRoot(opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || homedir()
  const dshHome = String(env.DSH_HOME || '').trim()
  return dshHome ? join(resolve(dshHome), 'rules') : join(home, '.dsh', 'rules')
}

/**
 * 规则根归一：空 → 默认根；字符串 → 绝对路径。
 *
 * 非字符串（对象/数组/数字）**抛 TypeError**：`resolve({})` 曾把对象静默转成 `"[object Object]"`
 * 目录，规则被写到垃圾路径且无人报错。宁可当场红，也不接受"猜一个根"。
 *
 * @param {string} [root] @returns {string}
 * @throws {TypeError} root 既不是字符串也不是 null/undefined
 */
export function baseDir(root) {
  if (root !== undefined && root !== null && typeof root !== 'string') {
    throw new TypeError('rules root must be a string')
  }
  const raw = String(root ?? '').trim()
  return raw ? resolve(raw) : defaultRuleRoot()
}

/** 规则文件落点：候选进 proposals/，正式规则在根目录。 */
export function rulePath(root, front) {
  const dir = front?.type === 'rule-candidate' ? join(root, 'proposals') : root
  return join(dir, `${front.key}.md`)
}
