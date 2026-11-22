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
 * Why 一次 commit：默认播种是"一次安装动作"，16 个文件各自 commit 会把规则仓的 history 打成噪音，
 * 也没法用一条提交回滚整批默认值。写文件时 `git:false`，最后统一提交一次；仓库不存在时先用
 * `initRuleRepo` 只建仓（不建首 commit），保证首启也只有一个提交点、且该提交包含全部默认规则。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atomicWriteFile,
  defaultRuleRoot,
  gitCommit,
  initRuleRepo,
  listRules,
  normalizeRuleDoc,
  parseRuleDocument,
  regenerateManifest,
  validateRule,
  writeRule,
} from './rule-store.js'

/** 播种标记（规则仓内，与 manifest.json 同层；不进 git，见 `ensureMarkerIgnored`）。 */
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
 * 把 `.seeded.json` 加进规则仓 `.gitignore`：marker 是**本机状态**，不该被 commit 进规则仓
 * （否则换机会带着"已播种"标记，新机永远不长默认铁律）。
 *
 * 已有仓库的 `.gitignore` 不会被 ensureRuleRepo 重写，所以这里补一次；失败只降级（marker 最多
 * 进一次 commit，不影响播种本身）。
 * @returns {boolean} 是否真的改了文件
 */
function ensureMarkerIgnored({ root, fs, marker }) {
  const file = join(root, '.gitignore')
  const line = String(marker || SEED_MARKER)
  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    content = '*.tmp-*\n.locks/\n'
  }
  const lines = content.split('\n')
  if (lines.some((item) => item.trim() === line)) return false
  const next = `${content.replace(/\n*$/, '\n')}${line}\n`
  const written = atomicWriteFile(file, next, { fs })
  return Boolean(written.ok)
}

/**
 * 单次 commit（失败降级：git 不可用/目录不是仓库时规则文件照样有效）。
 * @returns {{ok:boolean,committed:boolean,message:string,error?:string}}
 */
function commitOnce(dir, message, { exec } = {}) {
  try {
    const done = gitCommit(dir, message, exec ? { exec } : {})
    if (done && done.ok) return { ok: true, committed: Boolean(done.committed), message }
    return { ok: false, committed: false, message, error: String(done?.error || 'git_failed') }
  } catch (err) {
    return { ok: false, committed: false, message, error: String(err?.message || err) }
  }
}

/**
 * 首次播种默认规则（幂等）。
 *
 * 判定顺序（每一步都是提前返回，绝不"先写后判"）：
 * 1. `root/.seeded.json` 存在 → `skipped:'already_seeded'`（用户删/停用默认规则后重启也不重播）；
 * 2. 目录里已有任何合法规则 → 不覆盖，写 marker `{skipped:'existing_rules'}`；
 * 3. `defaults/rules` 不存在 → `skipped:'defaults_missing'`，且**不写** marker（将来装到带默认值的版本还能播）；
 * 4. 逐文件校验 → 写入（`git:false`）→ 坏文件进 `invalid` 不阻断；
 * 5. `regenerateManifest` → 一次 `gitCommit('rules: seed defaults (N)')` → 写 marker。
 *
 * 全部默认文件都非法时**不写** marker（否则这批规则永久缺失），返回 `ok:false, error:'all_invalid'`。
 *
 * @param {{root?:string, defaultsDir?:string, marker?:string, log?:Function}} [args]
 *   root 默认 `$DSH_HOME/rules`；defaultsDir 默认包内 `defaults/rules`。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 *   git:false 只写文件不提交；exec 可注入假 git（单测不依赖本机安装）。
 * @returns {{ok:boolean, root:string, defaultsDir:string, marker:string,
 *   seeded?:number, count:number, skipped?:string, skippedInvalid?:number,
 *   invalid?:Array<{file:string,errors:Array<object>}>, commit?:object|null,
 *   manifest?:object|null, error?:string, detail?:any}}
 */
export function seedDefaultRules({
  root = '', defaultsDir = defaultRulesDir(), marker = SEED_MARKER, log = () => {},
} = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const git = opts.git !== false
  const base = String(root ?? '').trim() ? resolve(root) : defaultRuleRoot()
  const markerFile = join(base, marker)
  const defaults = String(defaultsDir ?? '').trim()

  // 1) 已播过：marker 是唯一判据（用户删光/停用默认规则也不复活）。
  if (existsSync(markerFile)) {
    return { ok: true, root: base, defaultsDir: defaults, marker: markerFile, skipped: 'already_seeded', count: 0 }
  }

  // 2) 已有规则：绝不覆盖（用户自己的规则优先），但同样写 marker——以后再删空也不重播。
  let listed
  try {
    listed = listRules(base)
  } catch (err) {
    return { ok: false, error: 'list_failed', root: base, count: 0, defaultsDir: defaults, marker: markerFile, detail: String(err?.message || err) }
  }
  if (listed.rules.length > 0) {
    // marker 不进 git：先补 .gitignore 再写 marker，避免后续任意一次写规则的 commit 把 marker 带进仓。
    ensureMarkerIgnored({ root: base, fs, marker })
    writeMarker(markerFile, { skipped: 'existing_rules', at: new Date().toISOString() }, fs)
    return { ok: true, root: base, defaultsDir: defaults, marker: markerFile, skipped: 'existing_rules', count: 0 }
  }

  // 3) 包内没有默认规则目录（旧包/裁剪安装）：不写 marker，留给将来能播的版本。
  if (!defaults || !existsSync(defaults)) {
    return { ok: true, root: base, defaultsDir: defaults, marker: markerFile, skipped: 'defaults_missing', count: 0 }
  }

  // 规则仓就绪：只需要"仓库存在"，不要 ensureRuleRepo 的首个 init commit——
  // 那会把 README/manifest 单独提交一次，首启的 history 就多一条噪音。先 init，写完再统一提交。
  // init 前必须先把目录建出来：`git -C <不存在目录> init` 会直接失败（播种就白丢一条提交）。
  if (git) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const inited = initRuleRepo(base, opts.exec ? { exec: opts.exec } : {})
      if (!inited.ok) log(`[whale-memory] rules seed git init skipped: ${inited.error || 'git_unavailable'}`)
    } catch (err) {
      // git 缺失/建仓失败不能挡住写文件；写规则本身不需要仓库。
      log(`[whale-memory] rules seed git init threw: ${err?.message || err}`)
    }
  }

  let names
  try {
    names = readdirSync(defaults)
      .filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'README.MD')
      .sort()
  } catch (err) {
    return { ok: false, error: 'defaults_read_failed', root: base, defaultsDir: defaults, marker: markerFile, count: 0, detail: String(err?.message || err) }
  }
  if (names.length === 0) {
    return { ok: true, root: base, defaultsDir: defaults, marker: markerFile, skipped: 'defaults_empty', count: 0 }
  }

  const numbers = new Map()
  const invalid = []
  let seeded = 0
  for (const name of names) {
    const file = join(defaults, name)
    let source
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch (err) {
      invalid.push({ file, errors: [{ code: 'read_failed', field: null, message: String(err?.message || err) }] })
      continue
    }
    const parsed = parseRuleDocument(source)
    if (!parsed.ok) {
      invalid.push({ file, errors: [{ code: 'parse_failed', field: null, message: String(parsed.error || 'parse_failed') }] })
      continue
    }
    const normalized = normalizeRuleDoc(parsed.front, parsed.text)
    // numbers 累积本批次已占编号：默认文件之间撞号也必须当场红，而不是靠后面的写失败。
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) {
      invalid.push({ file, errors: check.errors })
      continue
    }
    // git:false —— 16 个文件只留最后一次 commit；单文件 commit 会把 history 打成噪音。
    const written = writeRule(base, { front: normalized.front, text: normalized.text }, { git: false, fs })
    if (!written.ok) {
      invalid.push({ file, errors: [{ code: written.error || 'write_failed', field: null, message: String(written.detail?.error || written.error || 'write_failed') }] })
      continue
    }
    // 无编号铁律（安全行 number=0）不占号：本批次的撞号表里只登记正整数编号。
    if (Number.isInteger(normalized.front.number) && normalized.front.number > 0) {
      numbers.set(normalized.front.number, normalized.front.key)
    }
    seeded += 1
  }

  // 一条合法规则都没写进去：不写 marker（否则这批默认铁律永久缺失），交给上层记日志。
  if (seeded === 0) {
    return {
      ok: false, error: 'all_invalid', root: base, defaultsDir: defaults, marker: markerFile,
      seeded: 0, count: 0, skippedInvalid: invalid.length, invalid,
    }
  }

  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) log(`[whale-memory] rules seed manifest failed: ${manifest.error || 'unknown'}`)
  // marker 不进 git：先补 .gitignore，再提交，避免 marker 被本次/后续 commit 带进仓。
  ensureMarkerIgnored({ root: base, fs, marker })

  const message = `rules: seed defaults (${seeded})`
  const commit = git ? commitOnce(base, message, opts) : null
  if (commit && !commit.ok) log(`[whale-memory] rules seed commit skipped: ${commit.error || 'git_unavailable'}`)

  const markerWritten = writeMarker(markerFile, {
    seededAt: new Date().toISOString(),
    source: 'defaults',
    count: seeded,
    version: SEED_VERSION,
  }, fs)
  if (!markerWritten.ok) {
    // marker 写不进去就等于会重复播种；如实返回失败，别让上层以为播完收工。
    return {
      ok: false, error: 'marker_write_failed', root: base, defaultsDir: defaults, marker: markerFile,
      seeded, count: seeded, skippedInvalid: invalid.length, invalid, commit, manifest: manifest.manifest || null,
      detail: markerWritten.error,
    }
  }

  return {
    ok: true,
    root: base,
    defaultsDir: defaults,
    marker: markerFile,
    seeded,
    count: seeded,
    skippedInvalid: invalid.length,
    invalid,
    commit,
    manifest: manifest.manifest || null,
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
