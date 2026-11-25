// 职责：本地 git 仓库/提交/日志/索引回滚与 .gitignore；依赖：./paths.js、./io.js、./parse.js、./manifest.js。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { baseDir } from './paths.js'
import { atomicWriteFile, existsSyncSafe } from './io.js'
import { listRules } from './parse.js'
import { MANIFEST_FILE, regenerateManifest } from './manifest.js'

// ---------------------------------------------------------------------------
// 常量（仓库初始化与提交）
// ---------------------------------------------------------------------------

export const RULE_DIRS = Object.freeze(['proposals', 'history', 'retired', '.txn'])
/** 规则仓 `.gitignore` 必须包含的条目（候选/快照/事务/锁/播种 marker 都是本机生成物）。 */
export const GITIGNORE_LINES = Object.freeze([
  '*.tmp-*', '.locks/', '.txn/', '.seeded.json', 'proposals/', 'history/',
])
const GIT_TIMEOUT_MS = 5000
const GIT_IDENT = Object.freeze(['-c', 'user.name=dsh-whale-memory', '-c', 'user.email=rules@local'])

// ---------------------------------------------------------------------------
// 提交（显式路径） / 回滚
// ---------------------------------------------------------------------------

/** 提交路径归一：去空、转仓库内相对路径、去重；越界路径直接拒绝（不喂给 git）。 */
function normalizeCommitPaths(base, paths) {
  const out = []
  for (const item of Array.isArray(paths) ? paths : []) {
    const raw = String(item ?? '').trim()
    if (!raw) continue
    const rel = isAbsolute(raw) ? relative(base, raw) : raw
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!clean || clean.startsWith('..') || isAbsolute(clean)) continue
    if (!out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * git 不可用是**降级**而不是提交失败：文件/manifest 已落盘，只是没有版本记录。
 * 只有真的 `git commit` 失败（index/权限/钩子）才算失败并回滚。
 * @param {string} [error] @returns {boolean}
 */
export function isGitDegraded(error) {
  return error === 'git_unavailable' || error === 'not_a_git_repo'
}

/**
 * requireGit 闸门（R9-05）：配置折算成布尔由调用方传入，store 自己复核 git 可执行性。
 *
 * 为什么下沉到 store：路由闸只能拦住 HTTP 入口；播种、迁移、apply 内部、别的插件直接调
 * store 时都绕过它。闸门必须贴着写入口，且**在任何落盘动作之前**（锁目录/建仓/marker 都不许先动）。
 *
 * 只探 `git --version` 而不要求仓库已存在：requireGit 的语义是「这台机器有 git 才能写」，
 * 仓库由写入口自己 ensure；拿「仓库不存在」当缺 git 会误伤首次写入。
 *
 * @param {string} root 规则仓根（仅用于错误明细，不写盘）
 * @param {{gitRequired?:boolean, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:true}|{ok:false, error:'git_required', detail:{reason:string,root:string}}}
 */
export function requireGitGate(root, opts = {}) {
  if (opts.gitRequired !== true) return { ok: true }
  const base = baseDir(root)
  if (opts.git === false) {
    // 调用方显式要求 git 又显式关掉 git：配置自相矛盾，宁可拒绝也不写一笔没有版本记录的规则。
    return { ok: false, error: 'git_required', detail: { reason: 'git_disabled', root: base } }
  }
  const exec = opts.exec || execFileSync
  try {
    exec('git', ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: gitEnv(),
    })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: 'git_required',
      detail: { reason: err?.code === 'ENOENT' ? 'git_unavailable' : String(err?.message || err).trim(), root: base },
    }
  }
}

/** 内部别名：写入口统一用短名调用，导出名给播种/迁移/提案复用（同一道闸，禁止各自实现）。 */
export const gitGate = requireGitGate

/**
 * 三态提交状态（架构书 §6）：`committed`=版本已记录；`degraded`=文件已写但无版本记录
 * （git 关闭/不可用）；`failed`=git 可用但提交失败（写入口必须已把四处回滚干净）。
 *
 * `commit.ok && !committed` 是「工作树与 index 已一致、无需提交」：按 committed 记，
 * 明细里保留 `committed:false`，不谎报「产生了提交」。
 *
 * @param {{ok?:boolean, committed?:boolean, error?:string}|null} commit
 * @param {{git?:boolean}} [opts]
 * @returns {'committed'|'degraded'|'failed'}
 */
export function commitStateOf(commit, opts = {}) {
  if (opts.git === false) return 'degraded'
  if (!commit) return 'degraded'
  if (commit.ok) return 'committed'
  return isGitDegraded(commit.error) ? 'degraded' : 'failed'
}

/** 公开别名：提案 apply 与路由复用同一三态判定（禁止在别处再实现一份）。 */
export const ruleCommitState = commitStateOf

/**
 * 单次提交：**显式路径**（规则文件 + manifest + 墓碑），不用 `git add -A`。
 *
 * 为什么必须显式：规则仓里还躺着 `proposals/`、`history/`、`.txn/`；`add -A` 会把候选草稿
 * 和快照一起固化进历史（双份噪音，回滚也不再干净）。paths 为空 → 不提交，返回 committed:false。
 *
 * @param {string} root @param {string} message
 * @param {{paths?:string[], exec?:Function}} [opts]
 * @returns {{ok:boolean, committed:boolean, message:string, error?:string}}
 */
export function commitRuleChanges(root, message, opts = {}) {
  const base = baseDir(root)
  const text = String(message || 'rules: update')
  const paths = normalizeCommitPaths(base, opts.paths)
  if (paths.length === 0) return { ok: true, committed: false, message: text }
  const done = gitCommit(base, text, { exec: opts.exec, paths })
  if (!done.ok) return { ok: false, committed: false, message: text, error: done.error || 'git_failed' }
  return { ok: true, committed: Boolean(done.committed), message: text }
}

/**
 * 显式清理 git index 的暂存：`git reset -- <paths>`（不 `reset --hard`、不动工作树）。
 *
 * 供 apply 的 rollbackPlan 在 commit 失败后清掉本笔已 `git add`/`git rm` 的暂存，
 * 避免下一笔提交把失败事务的文件带进历史（"幻影版本"）。路径先归一：越界/空路径丢弃；
 * paths 为空时**不调用 git**，返回 ok（幂等）。
 *
 * @param {string} root @param {string[]} paths @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean, paths:string[], error?:string}}
 */
export function resetGitIndex(root, paths, opts = {}) {
  const base = baseDir(root)
  const clean = normalizeCommitPaths(base, paths)
  if (!clean.length) return { ok: true, paths: clean }
  // git 不可用 / 未建仓：没有 index 可清，这是"无需回滚"不是回滚失败。
  // （R9-03：回滚失败清单只该记真失败，否则 git:false 的临时仓会被误判成半写。）
  const repo = isGitRepo(base, { exec: opts.exec })
  if (!repo.ok) return { ok: true, paths: clean, skipped: 'no_repo' }
  const reset = runGit(base, ['reset', '-q', '--', ...clean], { exec: opts.exec })
  return reset.ok ? { ok: true, paths: clean } : { ok: false, paths: clean, error: reset.error }
}

/** 内部别名（回滚路径沿用旧名，行为即 resetGitIndex）。 */
export function resetIndexPaths(root, paths, opts = {}) {
  return resetGitIndex(root, paths, opts)
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/**
 * 补规则仓 `.gitignore` 条目（幂等，只追加缺失行）：候选/快照/事务/锁/播种 marker 全是
 * 本机生成物，不该进 git。返回是否真的改了文件。
 * @param {string} root @param {{fs?:typeof nodeFs}} [opts]
 * @returns {boolean}
 */
export function ensureRuleGitignore(root, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const file = join(base, '.gitignore')
  let content = ''
  try { content = String(fs.readFileSync(file, 'utf8')) } catch { content = '' }
  const lines = content.split('\n').map((line) => line.trim())
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line))
  if (!missing.length) return false
  const head = content.replace(/\n*$/, '')
  const next = `${head ? `${head}\n` : ''}${missing.join('\n')}\n`
  const written = atomicWriteFile(file, next, { fs })
  return Boolean(written.ok)
}

// ---------------------------------------------------------------------------
// git（本地 only）
// ---------------------------------------------------------------------------

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** 统一执行入口：`-C dir` + 固定身份 + `--no-optional-locks` + 5s 超时；不联网。 */
export function runGit(dir, args, opts = {}) {
  const exec = opts.exec || execFileSync
  try {
    const out = exec('git', ['-C', dir, ...GIT_IDENT, '--no-optional-locks', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs || GIT_TIMEOUT_MS,
      env: gitEnv(),
    })
    return { ok: true, out: String(out ?? '') }
  } catch (err) {
    const code = err?.code || err?.status || ''
    const stderr = String(err?.stderr ?? '')
    const message = stderr.trim() || String(err?.message || err)
    if (code === 'ENOENT') return { ok: false, error: 'git_unavailable' }
    return { ok: false, error: message || 'git_failed', code }
  }
}

/** @param {string} dir @returns {{ok:boolean,error?:string}} */
export function isGitRepo(dir, opts = {}) {
  const r = runGit(dir, ['rev-parse', '--is-inside-work-tree'], opts)
  if (!r.ok) return r
  return { ok: r.out.trim() === 'true' }
}

/**
 * 只建仓（`git init -q`），**不提交**。
 *
 * 为什么需要它：默认播种要"整批默认规则只出一个 commit"，但 `ensureRuleRepo` 建仓时会顺手
 * 提交一次 `rules: init repository`（里面只有 README/manifest），history 会多一条噪音。
 * 先 init、再写文件、最后统一 commit，首启就是**一个**提交且包含全部默认规则。
 *
 * @param {string} dir
 * @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean, initialized?:boolean, error?:string}} initialized=false 表示本来就有仓库
 */
export function initRuleRepo(dir, opts = {}) {
  const repo = isGitRepo(dir, opts)
  if (repo.ok) return { ok: true, initialized: false }
  const init = runGit(dir, ['init', '-q'], opts)
  if (!init.ok) return { ok: false, error: init.error }
  return { ok: true, initialized: true }
}

/**
 * 提交（**只接受显式路径**）：`git add -- <paths>` → 无改动视为成功但不提交。
 *
 * R8-13：禁止 `add -A`——候选/快照/事务日志即使被 .gitignore 挡住，`add -A` 也会把
 * "未预期的新文件"一并固化进历史，回滚不再干净。`opts.paths` 缺省/为空 → 不提交，
 * 不猜、不兜底（调用方必须自己给出本笔涉及的文件与 manifest）。提交用
 * `commit -- <已进 index 的 paths>`：预暂存的他笔文件不会被带进提交。
 *
 * @param {string} dir @param {string} message
 * @param {{exec?:Function, paths?:string[]}} [opts]
 * @returns {{ok:boolean,committed?:boolean,out?:string,error?:string,code?:string}}
 */
export function gitCommit(dir, message, opts = {}) {
  const paths = Array.isArray(opts.paths) ? opts.paths : []
  if (paths.length === 0) return { ok: true, committed: false }
  // 路径分两类：仍在盘上的 `git add --`；已被删除的用 `git rm --ignore-unmatch` 把删除记进 index。
  // 直接 `git add -- 已删路径` 会报 "pathspec ... did not match"（purge 的删除路径就是这种）。
  const existing = paths.filter((rel) => existsSync(join(dir, rel)))
  const removed = paths.filter((rel) => !existing.includes(rel))
  if (existing.length) {
    const added = runGit(dir, ['add', '--', ...existing], opts)
    if (!added.ok) return added
  }
  if (removed.length) {
    // 失败不致命：文件可能未跟踪/已被 `git rm` 暂存过；由下面 diff 判空。
    runGit(dir, ['rm', '--ignore-unmatch', '-q', '-f', '--', ...removed], opts)
  }
  const staged = runGit(dir, ['diff', '--cached', '--quiet', '--', ...paths], opts)
  // diff --quiet 有差异时退出码 1；runGit 把非 0 当失败，这里按"有差异"解释。
  if (!staged.ok && staged.code === 1) {
    // `commit -- <paths>`：只提交本笔路径。index 里可能已有别的暂存（面板/git add 预暂存、
    // 上一笔失败残留），无 pathspec 的 commit 会把它们一起带进提交（幻影版本）。
    // 还要把 pathspec 收窄到"真的进了 index 的路径"：未跟踪且从未 add 过的路径（例如
    // git:false 写入后又被 purge 的规则）喂给 `git commit -- <path>` 会报
    // "pathspec ... did not match any file(s) known to git"，整笔提交失败。
    const names = runGit(dir, ['diff', '--cached', '--name-only', '--', ...paths], opts)
    const effective = names.ok
      ? names.out.split('\n').map((line) => line.trim()).filter(Boolean)
      : []
    const commitPaths = effective.length ? effective : paths
    const committed = runGit(dir, ['commit', '-m', String(message || 'rules: update'), '--no-gpg-sign', '--', ...commitPaths], opts)
    if (!committed.ok) return committed
    return { ok: true, committed: true, out: committed.out }
  }
  return { ok: true, committed: false }
}

/**
 * 本地 git 日志。`opts.path` 只列该路径的提交（`/rules/versions` 用），
 * `opts.withTime` 追加 unix 秒时间戳（面板按时间排序/展示，不靠猜提交顺序）。
 * @param {string} dir @param {number} [limit]
 * @param {{exec?:Function,path?:string,withTime?:boolean}} [opts]
 * @returns {{ok:boolean,entries?:Array<{hash:string,subject:string,ts?:number}>,error?:string}}
 */
export function gitLog(dir, limit = 20, opts = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  const format = opts.withTime ? '%h%x09%at%x09%s' : '%h%x09%s'
  const args = ['log', `-n${n}`, `--pretty=format:${format}`]
  if (opts.path) args.push('--', String(opts.path))
  const r = runGit(dir, args, opts)
  if (!r.ok) return r
  const entries = r.out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('\t')
    if (opts.withTime) return { hash: parts[0], ts: Number(parts[1]) || 0, subject: parts.slice(2).join('\t') }
    return { hash: parts[0], subject: parts.slice(1).join('\t') }
  })
  return { ok: true, entries }
}

/**
 * 展示某个 revision：file 给定时返回该文件在该版本的内容，否则返回 --stat 摘要。
 * @param {string} dir @param {string} rev @param {{file?:string}} [opts]
 * @returns {{ok:boolean,text?:string,error?:string}}
 */
export function gitShow(dir, rev, opts = {}) {
  const revision = String(rev ?? '').trim()
  if (!revision || revision.startsWith('-')) return { ok: false, error: 'invalid_rev' }
  const args = opts.file
    ? ['show', `${revision}:${opts.file}`]
    : ['show', '--stat', '--no-color', '--no-renames', revision]
  const r = runGit(dir, args, opts)
  return r.ok ? { ok: true, text: r.out } : r
}

// ---------------------------------------------------------------------------
// 仓库初始化
// ---------------------------------------------------------------------------

/**
 * 建目录 + README + .gitignore + manifest + git init/首次 commit。
 * git 缺失/失败只降级返回 `{git:{available:false}}`，不抛——规则文件仍可读写。
 *
 * @param {{root?:string,git?:boolean,exec?:Function,fs?:typeof nodeFs}} [opts]
 * @returns {{ok:boolean,root?:string,git?:{available:boolean,version?:string,initialized?:boolean,committed?:boolean,error?:string},error?:string}}
 */
export function ensureRuleRepo(opts = {}) {
  const fs = opts.fs || nodeFs
  const root = baseDir(opts.root)
  try {
    fs.mkdirSync(root, { recursive: true })
    for (const dir of RULE_DIRS) fs.mkdirSync(join(root, dir), { recursive: true })
    const readme = join(root, 'README.md')
    if (!existsSyncSafe(readme, fs)) {
      fs.writeFileSync(readme, [
        '# 规则目录',
        '',
        '规则文件是真源；manifest.json 与 history/ 是生成物。',
        '- 规则：`<key>.md`（front matter + 正文）',
        '- 候选：`proposals/<key>.md`',
        '- 历史：`history/<key>/<YYYYMMDDHHmmssSSS>.md`（每个 key 保留 20 份）',
        '',
        '只允许本地 git 操作；本目录不联网。',
        '',
      ].join('\n'), 'utf8')
    }
    // `.gitignore` 逐行补齐（老仓库也要迁移一次）：`.seeded.json` 是本机状态，proposals/history/.txn
    // 是待裁定草稿/快照/短命事务——进 git 会让规则仓的历史变成双份噪音。
    ensureRuleGitignore(root, { fs })
    regenerateManifest(root, { fs })
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }

  if (opts.git === false) {
    return { ok: true, root, git: { available: false, error: 'git_disabled' } }
  }

  const exec = opts.exec || execFileSync
  let version = ''
  try {
    const out = exec('git', ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: gitEnv(),
    })
    version = String(out ?? '').trim()
  } catch (err) {
    return {
      ok: true,
      root,
      git: { available: false, error: err?.code === 'ENOENT' ? 'git_unavailable' : String(err?.message || err) },
    }
  }

  let initialized = false
  const repo = isGitRepo(root, { exec })
  if (!repo.ok) {
    const init = runGit(root, ['init', '-q'], { exec })
    if (!init.ok) return { ok: true, root, git: { available: true, version, initialized: false, error: init.error } }
    initialized = true
  }
  // 只在本次新建仓库时做首次 commit；已有仓库的日常改动由 writeRule 提交，
  // 避免每次 ensure 都插一个空 commit 把规则历史的 diff 打乱。
  // 显式路径：README/.gitignore/manifest + 已存在的规则文件（新建仓库时可能有默认种子在盘上）。
  const committed = initialized
    ? gitCommit(root, 'rules: init repository', {
      exec,
      paths: [
        'README.md', '.gitignore', MANIFEST_FILE,
        ...listRules(root).rules.map((doc) => relative(root, doc.file)),
      ].filter((rel, index, arr) => arr.indexOf(rel) === index),
    })
    : { ok: true, committed: false }
  return {
    ok: true,
    root,
    git: {
      available: true,
      version,
      initialized,
      committed: committed.ok ? Boolean(committed.committed) : false,
      ...(committed.ok ? {} : { error: committed.error }),
    },
  }
}
