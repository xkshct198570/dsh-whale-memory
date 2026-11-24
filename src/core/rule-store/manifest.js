// 职责：铁律编号分配/墓碑/manifest.json 生成与读取；依赖：node 内置 + ./paths.js + ./io.js + ./parse.js。
import { readFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { baseDir } from './paths.js'
import { atomicWriteFile, durableWriteFile } from './io.js'
import { isValidRuleKey, isUnnumberedRule, listRules, ruleKeyOfFile, RESERVED_NUMBERS, RULE_NUMBER_MAX } from './parse.js'

export const MANIFEST_FILE = 'manifest.json'
/** 墓碑目录：已彻底删除规则的 `{key,number,at,reason}` 台账，append-only，可重建 manifest。 */
export const RETIRED_DIR = 'retired'
const IRON_RULE_FILE_RE = /^iron-rule-(\d+)\.md$/i
/**
 * 目录内 `iron-rule-<n>.md` 的文件名编号集合（parse-only：只看文件名，不读 front、不跑校验）。
 *
 * 为什么必须单独存在：手改成非法 front 的规则文件解析失败，不会进 `listRules().rules`；
 * 若编号占用只看"解析成功的规则"，分配器会把这个号再发一次并覆盖原文件（R9-02 复现过）。
 * 文件名是磁盘上"这个号已被占"的最后证据，崩溃/手改都不能让它消失。
 *
 * @param {string} root @param {{fs?: typeof nodeFs}} [opts] @returns {Set<number>}
 */
export function fileRuleNumbers(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const numbers = new Set()
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch { /* 目录不存在/不可读：没有文件名证据，交给调用方的其它校验报错 */ }
  for (const entry of entries) {
    if (!entry || (!entry.isFile?.() && !entry.isSymbolicLink?.())) continue
    const match = IRON_RULE_FILE_RE.exec(String(entry.name))
    if (!match) continue
    const n = Number(match[1])
    // >999 的文件名不是合法铁律编号（validate 会拒绝），不得让它把 nextNumber 顶到 1000+ 锁死新建。
    if (Number.isInteger(n) && n > 0 && n <= RULE_NUMBER_MAX) numbers.add(n)
  }
  return numbers
}

/**
 * 编号占用唯一真源 = 文件名编号 ∪ 解析成功的铁律 front 编号 ∪ 墓碑编号。
 *
 * - 文件名：非法 front 的文件也占号，分配器不得复用（R9-02 不变式）；
 * - front：兼容"文件名不规整但 front 有号"的历史文件；
 * - 墓碑：purge 后编号作废、永不复用。
 *
 * @param {string} root @param {{fs?: typeof nodeFs, listed?: {rules?: Array<object>}}} [opts]
 *   `listed` 可传已解析的 listRules 结果，避免一次分配重复解析全部规则。
 * @returns {Set<number>}
 */
export function occupancy(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const numbers = fileRuleNumbers(base, { fs })
  const rules = Array.isArray(opts.listed?.rules) ? opts.listed.rules : listRules(base).rules
  for (const doc of rules) {
    if (String(doc?.front?.type ?? '') !== 'iron-rule') continue
    const n = Number(doc?.front?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  for (const item of readTombstones(base, { fs })) {
    const n = Number(item?.number)
    if (Number.isInteger(n) && n > 0) numbers.add(n)
  }
  return numbers
}
// ---------------------------------------------------------------------------
// 墓碑（retired/<key>.json）：编号永不复用的真源
// ---------------------------------------------------------------------------
/** `retired/<key>.json` 路径（key 必须已过白名单，否则不能拼路径）。 */
function tombstonePath(base, key) {
  return join(base, RETIRED_DIR, `${key}.json`)
}

/**
 * 写墓碑（append-only）：先 fsync 落盘，再由调用方删规则文件。
 *
 * 为什么不只写 manifest：manifest 是生成物，删掉/并发 purge 都会让它回退，已删编号被复用。
 * 墓碑是独立文件，`regenerateManifest` 取「旧 manifest.retired ∪ retired/ 目录」并集，删
 * manifest 也重建得回来。同一 key 第二次 purge 时 `numbers` 累积、`number` 留最早的那个，
 * `at` 留最早时间（append-only = 不删/不覆盖已作废编号）。
 *
 * @param {string} root
 * @param {{key:string, number:number, at?:string, reason?:string}} tool
 * @param {{fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeTombstone(root, tool = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const key = String(tool?.key ?? '').trim()
  const number = Number(tool?.number)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: 'invalid_number' }
  const dir = join(base, RETIRED_DIR)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {
    return { ok: false, error: `retired_dir_failed:${err?.message || err}` }
  }
  const path = tombstonePath(base, key)
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(path, 'utf8')) } catch { prev = null }
  const prevAt = String(prev?.at ?? '').trim()
  const at = String(tool?.at ?? '').trim() || new Date().toISOString()
  // 同一 key 二次彻底删除（重建后又 purge）：墓碑不覆盖旧编号，`numbers` 累积、`number` 留最早。
  // 覆盖会把旧编号放回池子（nextNumber 回落、编号复用），这是编号不变式的直接破口。
  const prevNumbers = Array.isArray(prev?.numbers)
    ? prev.numbers.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : (Number.isInteger(Number(prev?.number)) && Number(prev?.number) > 0 ? [Number(prev.number)] : [])
  const numbers = [...new Set([...prevNumbers, number])].sort((a, b) => a - b)
  // 同一墓碑重写保留更早的 `at`：墓碑记录"何时作废"，后写的一律不掩盖第一次。
  const payload = {
    key,
    number: numbers[0],
    numbers,
    at: prevAt && prevAt < at ? prevAt : at,
    reason: String(tool?.reason ?? prev?.reason ?? 'purge').trim() || 'purge',
  }
  const written = durableWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, { fs })
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, path }
}

/**
 * 读全部墓碑（`retired/*.json`），坏文件跳过（不因一条坏墓碑丢掉整个占用集合）。
 * 一个文件里的 `numbers` 会展开成多条（同 key 多次 purge），占用/manifest 都按编号逐条算。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts]
 * @returns {Array<{key:string, number:number, at:string, reason:string}>}
 */
export function readTombstones(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const dir = join(base, RETIRED_DIR)
  let names
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(join(dir, name), 'utf8')) } catch { continue }
    const key = String(parsed?.key ?? ruleKeyOfFile(name)).trim()
    if (!isValidRuleKey(key)) continue
    // 一个墓碑文件可累积多个编号（同 key 二次 purge）：展开成多条，占用集合/manifest 都算全。
    const numbers = Array.isArray(parsed?.numbers)
      ? parsed.numbers.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [Number(parsed?.number)]
    const at = String(parsed?.at ?? '').trim()
    const reason = String(parsed?.reason ?? 'purge').trim()
    for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
      out.push({ key, number, at, reason })
    }
  }
  // 排序与 manifest 同口径（number → key）：目录里按文件名排序会让 10 排在 9 前面，manifest 抖动。
  return out.sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
}

/** 该编号是否已进墓碑（apply/import 写目标前复核用：命中即拒绝，不得复活）。 */
export function isRetiredNumber(root, number, opts = {}) {
  const n = Number(number)
  if (!Number.isInteger(n) || n <= 0) return false
  return readTombstones(root, opts).some((item) => Number(item.number) === n)
}

/**
 * 可分配的下一个铁律编号 = max(现存铁律编号 ∪ 墓碑)+1，跳过保留空号。
 * 供 legacy 导入等"没有可靠编号"的入口取号（锁内调用；本函数不自己加锁）。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts] @returns {number}
 */
export function allocatableRuleNumber(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  return nextRuleNumber(occupancy(base, { fs }))
}
// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
/** 有规则时的下一个编号：max+1，跳过保留空号（6）。 */
export function nextRuleNumber(numbers) {
  const list = Array.from(numbers || []).filter((n) => Number.isInteger(n) && n > 0)
  let next = list.length ? Math.max(...list) + 1 : 1
  while (RESERVED_NUMBERS.includes(next)) next += 1
  return next
}

/**
 * 墓碑归一：`manifest.retired` 是"已彻底删除、编号作废"的编号台账（rule-store 的唯一删除记录）。
 *
 * 只保留合法正整数的编号；同一 `{key,number}` 只留最新 `at`（重复记录不堆垃圾）。
 * 排序固定（number → key），保证 manifest 在 git diff 里稳定、不因对象顺序抖动。
 *
 * @param {Array<{key:string,number:number,at:string}>} retired
 * @returns {Array<{key:string,number:number,at:string}>}
 */
function normalizeRetired(retired) {
  const seen = new Map()
  for (const item of Array.isArray(retired) ? retired : []) {
    const key = String(item?.key ?? '').trim()
    const number = Number(item?.number)
    if (!key || !Number.isInteger(number) || number <= 0) continue
    const at = String(item?.at ?? '').trim()
    const id = `${key}#${number}`
    const prev = seen.get(id)
    if (!prev || String(prev.at) < at) seen.set(id, { key, number, at })
  }
  return [...seen.values()].sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
}

/**
 * 由规则列表计算 manifest 视图（纯函数，GET 列表用；不写盘）。
 *
 * 编号口径：只有正整数编号参与 `nextNumber`/`total`；无编号铁律（安全行，number=0）单列
 * `unnumbered` 计数——它存在、要被列表/镜像渲染，但**不占号**，否则 nextNumber 会被压回 1。
 * 已 purge 的编号只剩墓碑：`nextNumber` 把它算作占用（删最高号也不回落），但 `total`
 * 只数现存编号规则——墓碑不是规则，不能虚增列表条数。
 *
 * @param {Array<object>} rules listRules 的 rules
 * @param {Array<{key:string,number:number,at:string}>} [retired] manifest.retired 墓碑
 * @param {Iterable<number>} [extraNumbers] 解析失败的 `iron-rule-<n>.md` 文件名编号（仍占号）
 * @returns {{nextNumber:number,total:number,unnumbered:number,byStatus:Record<string,number>,
 *   retired:Array<{key:string,number:number,at:string}>}}
 */
export function computeManifest(rules, retired = [], extraNumbers = []) {
  const tombstones = normalizeRetired(retired)
  const byStatus = {}
  const numbers = []
  let unnumbered = 0
  for (const doc of Array.isArray(rules) ? rules : []) {
    const status = String(doc?.front?.status || 'unknown')
    byStatus[status] = (byStatus[status] || 0) + 1
    // 只有 iron-rule 的正整数编号进 total/nextNumber；普通规则带 number 也不占号。
    const n = String(doc?.front?.type ?? '') === 'iron-rule' ? Number(doc?.front?.number) : null
    if (Number.isInteger(n) && n > 0) numbers.push(n)
    else if (isUnnumberedRule(doc?.front)) unnumbered += 1
  }
  const extra = Array.from(extraNumbers || []).filter((n) => Number.isInteger(n) && n > 0)
  const occupied = numbers.concat(tombstones.map((item) => item.number), extra)
  return {
    nextNumber: nextRuleNumber(occupied),
    total: numbers.length,
    unnumbered,
    byStatus,
    retired: tombstones,
  }
}

/**
 * 重建 manifest.json（生成物，勿手改）；内容稳定排序，便于 git diff。
 *
 * 墓碑真源 = 「旧 manifest.retired ∪ retired/*.json ∪ opts.retired」，**只增不减**：
 * - 删掉 manifest.json 也能由规则文件 + 墓碑目录重建出同样的 nextNumber（编号不回落）；
 * - 新的占用集合必须是旧墓碑集合的超集，否则拒绝写并报 `retired_shrink`——
 *   防止一份旧 manifest 覆盖掉刚写下的新墓碑，把已删编号放回池子。
 *
 * @param {string} root
 * @param {{fs?:typeof nodeFs, retired?:Array<{key:string,number:number,at:string}>}} [opts]
 * @returns {{ok:boolean,manifest?:object,error?:string,detail?:any}}
 */
export function regenerateManifest(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const existing = readManifest(base)
  // 回滚事务允许"撤销刚落下的墓碑"：忽略旧 manifest.retired，只用磁盘墓碑 + 本次追加重建。
  // 正常写入永远走并集，保证旧墓碑不凭空消失、编号不被回收。
  const rollbackMode = opts.allowShrink === true
  const rawOld = rollbackMode ? [] : (Array.isArray(existing?.retired) ? existing.retired : [])
    .filter((item) => Number.isInteger(Number(item?.number)) && Number(item?.number) > 0)
  const oldRetired = rollbackMode ? [] : normalizeRetired(existing?.retired)
  const fromDisk = readTombstones(base, { fs })
  const retired = normalizeRetired(oldRetired.concat(fromDisk, Array.isArray(opts.retired) ? opts.retired : []))
  // 只增不减：旧 manifest 里出现过的编号必须仍在新集合里。按编号比对（不按 key），
  // 因为墓碑的 key 可能被手工改坏；编号一旦消失，就意味着"已删编号被放回池子"。
  const presentNumbers = new Set(retired.map((item) => item.number))
  const missing = rawOld.filter((item) => !presentNumbers.has(Number(item.number)))
  // `allowShrink` 只给本事务的回滚用（purge 的 commit 失败要撤销刚落下的墓碑）：
  // 正常写入路径永远不带它，保证"旧墓碑不会凭空消失、编号不被回收"。
  if (missing.length && opts.allowShrink !== true) {
    return { ok: false, error: 'retired_shrink', detail: { missing } }
  }
  const list = listRules(base)
  // 非法 front 的 `iron-rule-<n>.md` 仍占号：manifest.nextNumber 必须与分配器同口径，
  // 否则面板显示"下一个 18"而 create 实际给 19（R9-02）。
  const view = computeManifest(list.rules, retired, fileRuleNumbers(base, { fs }))
  const manifest = {
    ...view,
    keys: list.rules.map((doc) => doc.front.key),
    updatedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(base, { recursive: true })
    const written = atomicWriteFile(join(base, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { fs })
    if (!written.ok) return { ok: false, error: written.error }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
  return { ok: true, manifest }
}

/** 只读 manifest（缺失/坏 JSON 返回 null，调用方可回退到 computeManifest）。 */
export function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(baseDir(root), MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}
