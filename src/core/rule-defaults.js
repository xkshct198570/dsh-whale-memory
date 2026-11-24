/**
 * 默认铁律首次播种：把包内 `defaults/rules/*.md` 一次性灌进规则仓（文件真源）。
 *
 * 职责：
 * - `defaultRulesDir()`：从本模块定位插件根下的 `defaults/rules`（编译/安装后仍有效，不猜 cwd）；
 * - `seedDefaultRules()`：首次启动把默认规则写进 `$DSH_HOME/rules`，生成 manifest、**一次** git commit、
 *   写 `.seeded.json` 标记；单个坏文件跳过并记 `invalid`，不阻断其余文件。
 *
 * 边界：
 * - 只读写规则目录与 marker，不认识 DB/HTTP/模型；镜像与 AGENTS 摘要由 index.js 的启动自愈链路接着做；
 * - `defaults/rules-local/` **不参与**播种（本机专用规则，换机不该被复制过去）；
 * - 只 import rule-store 的仓储函数（解析/校验/写入/git 全走同一套口径），不复制第二套校验。
 *
 * Why 用 marker 而不是"目录为空就播种"：默认规则是**可删可停用**的。用户删掉不想要的默认规则后重启，
 * 目录可能又空了；若以"空目录"为判据就会把铁律重新灌回来，等于用户永远删不掉。`.seeded.json`
 * 才是判据——播过一次就不再播，剩下的一切以文件现状为准。
 *
 * Why 一次 commit：默认播种是"一次安装动作"，20 个文件各自 commit 会把规则仓的 history 打成噪音，
 * 也没法用一条提交回滚整批默认值。写文件时 `git:false`，最后统一提交一次；仓库不存在时先用
 * `initRuleRepo` 只建仓（不建首 commit），保证首启也只有一个提交点、且该提交包含全部默认规则。
 */
import { existsSync } from 'node:fs'
import * as nodeFs from 'node:fs'

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireRepoLock,
  atomicWriteFile,
  defaultRuleRoot,
  ensureRuleGitignore,
  gitCommit,
  initRuleRepo,
  listRules,
  normalizeRuleDoc,
  parseRuleDocument,
  readRuleSource,
  readTombstones,
  regenerateManifest,
  requireGitGate,
  validateRule,
  writeRule,
  MANIFEST_FILE,
} from './rule-store.js'

/** 目录 fsync（删文件后让目录项持久化）；平台不支持时静默跳过。 */
function fsyncDir(dir, fs = nodeFs) {
  let fd = null
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) } catch { /* 非 POSIX 或权限不足 */ } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already closed */ } }
  }
}

/** 播种标记（规则仓内，与 manifest.json 同层；不进 git，见 `ensureRuleGitignore`）。 */
export const SEED_MARKER = '.seeded.json'
/** marker 结构版本：内容语义变了才 +1，用来区分"旧版播种"与"新版播种"。 */
export const SEED_VERSION = 1

/**
 * 包内默认规则目录的绝对路径（`<插件根>/defaults/rules`）。
 *
 * 用 `import.meta.url` 定位而不是 `process.cwd()`：插件被安装进 profile 后 cwd 是宿主的，
 * 只有模块自身位置才是稳定的。目录是否存在另用 `defaultRulesAvailable()` 判定——本函数必须
 * 返回**路径字符串**，因为 `seedDefaultRules` 的默认形参要用它。
 *
 * @returns {string}
 */
export function defaultRulesDir() {
  return fileURLToPath(new URL('../../defaults/rules', import.meta.url))
}

/**
 * 包内默认规则目录是否存在（旧版本包/裁剪安装可能没有 `defaults/`）。
 * @param {string} [dir]
 * @returns {boolean}
 */
export function defaultRulesAvailable(dir = defaultRulesDir()) {
  try {
    return existsSync(dir)
  } catch {
    return false
  }
}

/** 读取 JSON（缺失/坏文件返回 null，绝不抛）。 */
function readMarker(file, fs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 写 marker（原子写：半截 JSON 会让下次启动误判成"没播过"，从而重复播种）。 */
function writeMarker(file, value, fs) {
  const written = atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, { fs })
  return written
}

/**
 * 读包内默认规则目录的候选清单（文件名 → key）。
 * @param {string} dir @param {typeof nodeFs} fs
 * @returns {string[]}
 */
function defaultFilesOf(dir, fs) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD')
      .sort()
  } catch {
    return []
  }
}

/** 文件名 → key（默认文件名就是 key；不相等由播种按 key_mismatch 拒绝）。 */
function keyOfDefaultFile(name) {
  return String(name).replace(/\.md$/i, '')
}

/**
 * 单次提交（失败降级：git 不可用/目录不是仓库时规则文件照样有效）。
 * 显式路径：本次新播的规则文件 + manifest + .gitignore；不用 add -A。
 * @returns {{ok:boolean,committed:boolean,message:string,error?:string}}
 */
function commitOnce(dir, message, { exec, paths } = {}) {
  try {
    const done = gitCommit(dir, message, { ...(exec ? { exec } : {}), paths: Array.isArray(paths) ? paths : [] })
    if (done && done.ok) return { ok: true, committed: Boolean(done.committed), message }
    return { ok: false, committed: false, message, error: String(done?.error || 'git_failed') }
  } catch (err) {
    return { ok: false, committed: false, message, error: String(err?.message || err) }
  }
}

/**
 * 解析一个默认规则文件；返回 `{ok,front,text}` 或 `{ok:false,errors}`。
 * 只走 rule-store 的同一套解析/校验，不复制第二套口径。
 * @param {string} file @param {string} name @param {Map<number,string>} numbers 本批已占编号
 * @param {typeof nodeFs} fs
 * @returns {{ok:boolean,key?:string,front?:object,text?:string,errors?:Array<object>}}
 */
function parseDefault(file, name, numbers, fs) {
  const read = readRuleSource(file, { fs })
  if (!read.ok) {
    return { ok: false, key: keyOfDefaultFile(name), errors: [{ code: read.error === 'read_failed' ? 'read_failed' : read.error, field: null, message: read.error }] }
  }
  const parsed = parseRuleDocument(read.text)
  if (!parsed.ok) {
    return { ok: false, key: keyOfDefaultFile(name), errors: [{ code: 'parse_failed', field: null, message: String(parsed.error || 'parse_failed') }] }
  }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  // key=文件名：包内默认文件名写错时不许"按正文 key 另存一份"，否则默认目录与规则仓会各叫一名。
  if (normalized.front.key !== keyOfDefaultFile(name)) {
    return {
      ok: false,
      key: normalized.front.key,
      errors: [{ code: 'key_mismatch', field: 'key', message: `文件名 ${name} 与 key ${normalized.front.key} 不一致` }],
    }
  }
  // numbers 累积本批次已占编号：默认文件之间撞号也必须当场红，而不是靠后面的写失败。
  const check = validateRule(normalized.front, normalized.text, { numbers })
  if (!check.ok) return { ok: false, key: normalized.front.key, errors: check.errors }
  return { ok: true, key: normalized.front.key, front: normalized.front, text: normalized.text }
}

/** marker 里的 invalid 压成可持久化形状（不带整段错误消息，够重试定位即可）。 */
function compactInvalid(invalid) {
  return (Array.isArray(invalid) ? invalid : []).map((item) => ({
    file: String(item?.file ?? ''),
    key: String(item?.key ?? ''),
    code: String(item?.errors?.[0]?.code ?? item?.code ?? 'invalid'),
  }))
}

/**
 * 让出事件循环一次（R9-21b）：首启 20 个默认规则文件不得在同一个 tick 里同步写完。
 *
 * 为什么用 setImmediate：它排在 I/O 之后的 check 阶段，先把「启动路径」让出去；
 * `setTimeout(0)` 要多等一个 timers 阶段，且启动自愈本身就跑在 setTimeout 里（别自己饿死自己）。
 * 锁跨 tick 由「活 pid 不接管」保证（架构书 §2.7）。
 *
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 首次播种默认规则（幂等 + 版本化 + 坏文件重试）。
 *
 * 判据顺序：
 * 1. 无 marker 且目录已有合法规则 → `skipped:'existing_rules'`（不覆盖正文），marker 记
 *    `keys`=默认 key 清单（"已采纳"），以后升级只补真正新增的默认 key；
 * 2. 无 marker 且目录空 → 逐文件播种，坏文件进 `invalid` 不阻断，全部非法则不写 marker；
 * 3. 已有 marker → 只补两类缺失项：`invalid` 里的 key（下轮重试）与 `keys` 里没有的新默认 key
 *    （升级新增）；已在盘上的正文一律不覆盖，墓碑里的 key 一律不复活；
 * 4. `SEED_VERSION` 参与：marker.version 落后时升级写回，即使本次没有新文件；
 * 5. 播种在调用方持有的仓库锁内完成（本函数自己拿锁；锁内写规则传 lockHeld:true），
 *    一次 git commit（显式路径）；`git:false` 只写文件。
 * 6. async：逐文件 `setImmediate` 让出事件循环（R9-21b），首启 20 个文件不在同一 tick 跑完；
 *    锁跨 tick 由「活 pid 不接管」保证安全（架构书 §2.7）。
 *
 * @param {{root?:string, defaultsDir?:string, marker?:string, log?:Function}} [args]
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function, timeoutMs?:number, staleMs?:number,
 *   gitRequired?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, root:string, defaultsDir:string, marker:string,
 *   seeded?:number, count:number, skipped?:string, skippedInvalid?:number,
 *   invalid?:Array<{file:string,key?:string,errors:Array<object>}>, commit?:object|null,
 *   manifest?:object|null, keys?:string[], error?:string, detail?:any}>}
 */
export async function seedDefaultRules({
  root = '', defaultsDir = defaultRulesDir(), marker = SEED_MARKER, log = () => {},
} = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const git = opts.git !== false
  const base = String(root ?? '').trim() ? resolve(root) : defaultRuleRoot()
  const markerFile = join(base, marker)
  const defaults = String(defaultsDir ?? '').trim()
  // requireGit 闸门（R9-05）：播种也是写入口，必须与面板/提案同口径；先于锁与 marker，
  // 缺 git 时既不能播规则也不能写「已播种」假状态。
  const gate = requireGitGate(base, opts)
  if (!gate.ok) {
    return {
      ok: false, error: 'git_required', detail: gate.detail,
      root: base, defaultsDir: defaults, marker: markerFile, count: 0,
    }
  }
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) {
    return {
      ok: false, error: lock.error, root: base, defaultsDir: defaults, marker: markerFile, count: 0,
    }
  }
  try {
    return await seedLocked({ base, defaults, marker, markerFile, fs, git, log, opts })
  } finally {
    lock.release()
  }
}

/** `seedDefaultRules` 的锁内实现（async：逐文件让出事件循环，锁跨 tick 持有）。 */
async function seedLocked({ base, defaults, marker, markerFile, fs, git, log, opts }) {
  const baseResult = { root: base, defaultsDir: defaults, marker: markerFile, count: 0 }
  const existingMarker = readMarker(markerFile, fs)

  // 已有 marker：只补 invalid 重试项 + 升级新增 key。
  if (existingMarker) return retrySeed({ base, defaults, marker, markerFile, fs, git, log, opts, existingMarker })

  let listed
  try {
    listed = listRules(base)
  } catch (err) {
    return { ...baseResult, ok: false, error: 'list_failed', detail: String(err?.message || err) }
  }

  const files = defaults && existsSync(defaults) ? defaultFilesOf(defaults, fs) : []

  // 已有规则：绝不覆盖（用户自己的规则优先），marker 记 keys=默认 key（已采纳）。
  if (listed.rules.length > 0) {
    ensureRuleGitignore(base, { fs })
    const written = writeMarker(markerFile, {
      version: SEED_VERSION,
      status: 'complete',
      seededAt: new Date().toISOString(),
      source: 'defaults',
      skipped: 'existing_rules',
      at: new Date().toISOString(),
      keys: files.map(keyOfDefaultFile),
      invalid: [],
    }, fs)
    if (!written.ok) {
      return { ...baseResult, ok: false, error: 'marker_write_failed', detail: written.error }
    }
    return { ...baseResult, ok: true, skipped: 'existing_rules', keys: files.map(keyOfDefaultFile) }
  }

  // 包内没有默认规则目录（旧包/裁剪安装）：不写 marker，留给将来能播的版本。
  if (!files.length) {
    if (!defaults || !existsSync(defaults)) return { ...baseResult, ok: true, skipped: 'defaults_missing' }
    return { ...baseResult, ok: true, skipped: 'defaults_empty' }
  }

  // 首播前先 durable 写 "seeding" marker（含 planned key 清单）。
  // 为什么必须在写文件之前：写一半被杀后，旧逻辑会把"盘上任意规则"当成用户已有规则，
  // 直接 adopt 全部默认 key 并永不重播（审计 P0：静默漏播 15 条铁律）。
  const planned = files.map(keyOfDefaultFile)
  const seedingMarker = writeMarker(markerFile, {
    version: SEED_VERSION,
    status: 'seeding',
    seededAt: new Date().toISOString(),
    source: 'defaults',
    planned,
    keys: [],
    invalid: [],
  }, fs)
  if (!seedingMarker.ok) {
    return { ...baseResult, ok: false, error: 'marker_write_failed', detail: seedingMarker.error }
  }

  // 规则仓就绪：只建仓不首提交（首启要一个包含全部默认规则的提交点）。
  prepareRepo(base, fs, git, opts, log)

  const seeded = await seedEntries({ base, defaults, files, fs, log })
  if (seeded.count === 0 && seeded.tombstoned > 0 && seeded.invalid.length === 0) {
    // 默认铁律已全部被用户彻底删除：写 marker（keys=默认 key 清单=已采纳），以后不再重播/重试。
    ensureRuleGitignore(base, { fs })
    const adopted = files.map(keyOfDefaultFile)
    const written = writeMarker(markerFile, {
      version: SEED_VERSION,
      status: 'complete',
      seededAt: new Date().toISOString(),
      source: 'defaults',
      skipped: 'tombstoned',
      count: 0,
      keys: adopted,
      invalid: [],
    }, fs)
    if (!written.ok) return { ...baseResult, ok: false, error: 'marker_write_failed', detail: written.error }
    return { ...baseResult, ok: true, skipped: 'tombstoned', seeded: 0, tombstoned: seeded.tombstoned, keys: adopted }
  }
  if (seeded.count === 0) {
    // 全部失败：不写 marker（下轮重试）。因 manifest 写失败导致时明确回 manifest_failed，
    // 让调用方/health 区分“存储坏了”与“规则内容坏了”。
    const manifestFailure = seeded.invalid.some((item) => Array.isArray(item.errors)
      && item.errors.some((error) => error?.code === 'manifest_failed'))
    return {
      ...baseResult, ok: false, error: manifestFailure ? 'manifest_failed' : 'all_invalid',
      seeded: 0, skippedInvalid: seeded.invalid.length,
      invalid: seeded.invalid, tombstoned: seeded.tombstoned,
    }
  }
  const finalized = finalizeSeed({
    base, defaults, marker, markerFile, fs, git, log, opts,
    seededKeys: seeded.keys, invalid: seeded.invalid, paths: seeded.paths,
    tombstoned: seeded.tombstoned, priorKeys: [], priorInvalid: compactInvalid(seeded.invalid),
  })
  return finalized
}

/**
 * 有 marker 的分支：只补「invalid 重试 + 升级新增默认 key」；不覆盖盘上正文、不复活墓碑 key。
 */
async function retrySeed({ base, defaults, marker, markerFile, fs, git, log, opts, existingMarker }) {
  const baseResult = { root: base, defaultsDir: defaults, marker: markerFile, count: 0 }
  if (!defaults || !existsSync(defaults)) {
    return { ...baseResult, ok: true, skipped: 'already_seeded', seeded: 0, keys: markerKeysOf(existingMarker) }
  }
  // 旧版 marker（只有 skipped/at，没有 keys）：把它当作"已采纳当前全部默认 key"，
  // 绝不因为缺 keys 就把默认规则补播进用户已有规则的目录。
  if (!Array.isArray(existingMarker.keys)) {
    const adopted = defaultFilesOf(defaults, fs).map(keyOfDefaultFile)
    const written = writeMarker(markerFile, {
      ...existingMarker,
      status: 'complete',
      version: SEED_VERSION,
      seededAt: new Date().toISOString(),
      keys: adopted,
      invalid: Array.isArray(existingMarker.invalid) ? existingMarker.invalid : [],
    }, fs)
    if (!written.ok) return { ...baseResult, ok: false, error: 'marker_write_failed', detail: written.error }
    return { ...baseResult, ok: true, skipped: 'already_seeded', seeded: 0, keys: adopted }
  }
  const recovering = String(existingMarker.status || '') === 'seeding'
  // 恢复态：planned 里已在盘上的 key 也要算进 marker.keys（否则恢复后它们被视为"未采纳"）。
  const recorded = new Set(recovering ? [] : markerKeysOf(existingMarker))
  const invalidKeys = new Set(compactInvalid(existingMarker.invalid).map((item) => item.key).filter(Boolean))
  const onDisk = new Set(listRules(base).rules.map((doc) => String(doc.front.key)))
  const recoveredKeys = recovering
    ? (Array.isArray(existingMarker.planned) ? existingMarker.planned : [])
      .map((key) => String(key)).filter((key) => onDisk.has(key))
    : []
  const tombstones = new Set(readTombstones(base, { fs }).map((item) => String(item.key)))
  const files = defaultFilesOf(defaults, fs).filter((name) => {
    const key = keyOfDefaultFile(name)
    if (onDisk.has(key)) return false        // 已有正文：绝不覆盖
    if (tombstones.has(key)) return false    // 已彻底删除：绝不复活
    if (recorded.has(key) && !invalidKeys.has(key)) return false // 用户删掉/已采纳的默认 key：不重播
    return true                              // 升级新增 key 或上轮 invalid 重试项
  })
  const nextVersion = Number(existingMarker.version) === SEED_VERSION
  const nextKeys = [...new Set([...markerKeysOf(existingMarker), ...recoveredKeys])]
  if (!files.length) {
    if (!nextVersion || recovering) {
      const bumped = writeMarker(markerFile, {
        ...existingMarker, status: 'complete', version: SEED_VERSION,
        seededAt: new Date().toISOString(), keys: nextKeys,
      }, fs)
      if (!bumped.ok) return { ...baseResult, ok: false, error: 'marker_write_failed', detail: bumped.error }
    }
    return { ...baseResult, ok: true, skipped: 'already_seeded', seeded: 0, keys: nextKeys }
  }
  prepareRepo(base, fs, git, opts, log)
  const seeded = await seedEntries({ base, defaults, files, fs, log })
  // 本次仍失败的 invalid 保留（下轮重试）；成功的从旧 invalid 里剔除。
  const retriedOk = new Set(seeded.keys)
  const carried = compactInvalid(existingMarker.invalid).filter((item) => item.key && !retriedOk.has(item.key))
  const merged = [...carried, ...compactInvalid(seeded.invalid)]
  return finalizeSeed({
    base, defaults, marker, markerFile, fs, git, log, opts,
    seededKeys: seeded.keys, invalid: seeded.invalid, paths: seeded.paths,
    tombstoned: seeded.tombstoned,
    priorKeys: [...new Set([...markerKeysOf(existingMarker), ...recoveredKeys])], priorInvalid: merged,
  })
}

/** marker.keys 归一（老 marker 没有 keys → 空）。 */
function markerKeysOf(marker) {
  return (Array.isArray(marker?.keys) ? marker.keys : []).map((key) => String(key)).filter(Boolean)
}

/** 建目录 + 只 init（不首提交），git 失败只降级记日志。 */
function prepareRepo(base, fs, git, opts, log) {
  if (!git) return
  try {
    fs.mkdirSync(base, { recursive: true })
    const inited = initRuleRepo(base, opts.exec ? { exec: opts.exec } : {})
    if (!inited.ok) log(`[whale-memory] rules seed git init skipped: ${inited.error || 'git_unavailable'}`)
  } catch (err) {
    log(`[whale-memory] rules seed git init threw: ${err?.message || err}`)
  }
}

/**
 * 逐文件播种（git:false + lockHeld:true：文件/manifest 由 writeRule 做完，提交由调用方一次出）。
 *
 * 墓碑过滤对**首播同样生效**：用户 purge 掉默认铁律后删掉 `.seeded.json`（或换机重播），
 * 不得把已作废的 key/编号复活。命中墓碑的文件跳过并计入 `tombstoned`。
 * @returns {{count:number, keys:string[], invalid:Array<object>, paths:string[], tombstoned:number}}
 */
async function seedEntries({ base, defaults, files, fs, log }) {
  const numbers = new Map()
  const invalid = []
  const keys = []
  const paths = []
  const tombstonedKeys = new Set(readTombstones(base, { fs }).map((item) => String(item.key)))
  let tombstoned = 0
  for (const name of files) {
    // 一次 setImmediate 写一条（R9-21b）：首启 20 个默认规则文件不得在同一个 tick 里跑完。
    await yieldToEventLoop()
    const file = join(defaults, name)
    if (tombstonedKeys.has(keyOfDefaultFile(name))) {
      tombstoned += 1
      continue
    }
    const parsed = parseDefault(file, name, numbers, fs)
    if (!parsed.ok) {
      invalid.push({ file, key: parsed.key, errors: parsed.errors })
      continue
    }
    writerWrite(base, parsed, fs, log, (written) => {
      if (!written.ok) {
        invalid.push({ file, key: parsed.key, errors: [{ code: written.error || 'write_failed', field: null, message: String(written.detail?.error || written.error || 'write_failed') }] })
        return
      }
      // 无编号铁律（安全行 number=0）不占号：本批次的撞号表里只登记正整数编号。
      if (parsed.front.type === 'iron-rule' && Number.isInteger(parsed.front.number) && parsed.front.number > 0) {
        numbers.set(parsed.front.number, parsed.front.key)
      }
      keys.push(parsed.key)
      paths.push(relativePath(base, written.path))
    })
  }
  return { count: keys.length, keys, invalid, paths, tombstoned }
}

/** 单条播种落盘（抽出来只为 try/finally 简洁）：回调拿 writeRule 结果。 */
function writerWrite(base, parsed, fs, log, done) {
  const written = writeRule(base, { front: parsed.front, text: parsed.text }, { git: false, fs, lockHeld: true })
  done(written)
}

/** 相对路径（POSIX 分隔符，喂给 git add）。 */
function relativePath(base, file) {
  const rel = String(file).startsWith(`${base}/`) || String(file).startsWith(`${base}\\`)
    ? String(file).slice(base.length + 1)
    : file
  return rel.replace(/\\/g, '/')
}

/** 收尾：manifest → .gitignore → 单次提交（显式路径）→ marker。 */
function finalizeSeed({
  base, defaults, markerFile, fs, git, log, opts, seededKeys, invalid, paths, tombstoned = 0,
  priorKeys, priorInvalid,
}) {
  const baseResult = {
    root: base, defaultsDir: defaults || '', marker: markerFile, count: seededKeys.length,
    ...(tombstoned ? { tombstoned } : {}),
  }
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) {
    // 架构书 §2.9：manifest 重建失败 → 不写 marker（否则下轮 already_seeded 直接跳过，
    // manifest 永远坏着）。文件已写，下轮启动自愈会先重建 manifest 再重试播种。
    log(`[whale-memory] rules seed manifest failed: ${manifest.error || 'unknown'}`)
    return { ...baseResult, ok: false, error: 'manifest_failed', detail: manifest.error,
      seeded: seededKeys.length, skippedInvalid: invalid.length, invalid, manifest: null }
  }
  ensureRuleGitignore(base, { fs })

  const message = `rules: seed defaults (${seededKeys.length})`
  const commit = git
    ? commitOnce(base, message, { exec: opts.exec, paths: [MANIFEST_FILE, '.gitignore', ...paths] })
    : null
  if (commit && !commit.ok) log(`[whale-memory] rules seed commit skipped: ${commit.error || 'git_unavailable'}`)

  const keys = [...new Set([...(priorKeys || []), ...seededKeys])]
  const markerWritten = writeMarker(markerFile, {
    version: SEED_VERSION,
    status: 'complete',
    seededAt: new Date().toISOString(),
    source: 'defaults',
    count: seededKeys.length,
    keys,
    invalid: priorInvalid || compactInvalid(invalid),
  }, fs)
  if (!markerWritten.ok) {
    return {
      ...baseResult, ok: false, error: 'marker_write_failed', seeded: seededKeys.length,
      skippedInvalid: invalid.length, invalid, commit, manifest: manifest.manifest || null,
      detail: markerWritten.error,
    }
  }
  return {
    ...baseResult,
    ok: true,
    seeded: seededKeys.length,
    skippedInvalid: invalid.length,
    invalid,
    commit,
    manifest: manifest.manifest || null,
    keys,
  }
}

/**
 * 单条默认规则恢复（面板「恢复默认」）：用包内默认正文覆盖当前规则，清掉该 key 的墓碑。
 *
 * 语义：这是**显式人工动作**，允许覆盖正文并产生新版本；历史快照由 writeRule 保留。
 * 清墓碑是恢复的一部分——否则编号仍被视为已作废，manifest/健康检查会和现行规则打架。
 *
 * @param {{root?:string, key:string, git?:boolean, exec?:Function, now?:number, log?:Function}} args
 * @returns {Promise<{ok:boolean, rule?:object, path?:string, error?:string, detail?:any}>}
 */
export async function restoreDefaultRule({ root = '', key = '', git = true, exec = null, now = Date.now, log = () => {} } = {}) {
  const k = String(key ?? '').trim()
  const name = `${k}.md`
  const file = join(defaultRulesDir(), name)
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k) || !existsSync(file)) {
    return { ok: false, error: 'default_not_found' }
  }
  const fs = nodeFs
  const base = String(root ?? '').trim() ? resolve(String(root)) : defaultRuleRoot()
  const parsed = parseDefault(file, name, new Map(), fs)
  if (!parsed.ok) return { ok: false, error: 'invalid_default', detail: parsed.errors }
  const lock = acquireRepoLock(base, { fs, timeoutMs: 2000 })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    // 墓碑必须先清再写：writeRule 会按墓碑拒绝“编号复用”（number_retired），
    // 而恢复默认是显式人工动作、同 key 同编号重新启用是它的语义。
    const tomb = readTombstones(base, { fs }).find((item) => String(item.key) === k)
    const tombPath = join(base, 'retired', `${k}.json`)
    let tombBackup = null
    if (tomb && existsSync(tombPath)) {
      try {
        tombBackup = { path: tombPath, content: fs.readFileSync(tombPath) }
        fs.unlinkSync(tombPath)
        try { fsyncDir(dirname(tombPath), fs) } catch { /* 目录 fsync 失败不改变已删除事实 */ }
      } catch (err) {
        log(`[whale-memory] restore default tombstone remove failed: ${err?.message || err}`)
        tombBackup = null
      }
    }
    // 墓碑文件删掉还不够：manifest.retired 按“只增不减”保存旧集合，必须显式 shrink
    // 一次（这是人工恢复动作，语义就是撤销该 key 的墓碑），否则 writeRule 仍判 number_retired。
    if (tombBackup) {
      const shrunk = regenerateManifest(base, { fs, allowShrink: true })
      if (!shrunk.ok) {
        try { fs.writeFileSync(tombBackup.path, tombBackup.content) } catch { /* best effort */ }
        return { ok: false, error: 'manifest_failed', detail: shrunk.error }
      }
    }
    const written = writeRule(base, { front: parsed.front, text: parsed.text }, { git: false, fs, lockHeld: true })
    if (!written.ok) {
      // 写失败：把墓碑原样放回，别让编号因为一次失败的恢复而变成可复用。
      if (tombBackup) {
        try {
          fs.writeFileSync(tombBackup.path, tombBackup.content)
          const fd = fs.openSync(tombBackup.path, 'r')
          try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        } catch { /* best effort：墓碑还在磁盘上就够，manifest 下一轮自愈 */ }
        try { regenerateManifest(base, { fs }) } catch { /* 下一轮自愈 */ }
      }
      return { ok: false, error: written.error || 'write_failed', detail: written.detail }
    }
    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) return { ok: false, error: 'manifest_failed', detail: manifest.error }
    let commit = null
    if (git) {
      const commitPaths = [relativePath(base, written.path), MANIFEST_FILE]
      // 墓碑的删除也必须进本次提交：否则工作树删了、HEAD 还跟踪，换机/checkout 后墓碑复活。
      if (tombBackup) commitPaths.push(relativePath(base, tombPath))
      commit = commitOnce(base, `rule: restore default ${k}`, {
        exec, paths: commitPaths,
      })
      if (commit && !commit.ok) log(`[whale-memory] restore default commit skipped: ${commit.error || 'git_unavailable'}`)
    }
    return {
      ok: true,
      path: written.path,
      commit,
      rule: { ...normalizeRuleDoc(parsed.front, parsed.text), bodyStart: 0, file: written.path },
    }
  } finally {
    lock.release()
  }
}

/**
 * 读 marker（诊断用：面板/日志想知道"为什么没播种"）。
 * @param {string} root @param {string} [marker] @returns {object|null}
 */
export function readSeedMarker(root, marker = SEED_MARKER) {
  const base = String(root ?? '').trim() ? resolve(root) : defaultRuleRoot()
  return readMarker(join(base, marker), nodeFs)
}
