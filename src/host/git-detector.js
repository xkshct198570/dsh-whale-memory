/**
 * Git 能力探测与降级闸门。
 *
 * 职责：
 * - 探测本机 git 是否可用/版本，模块级缓存 60s，避免每条规则写都 spawn 一次；
 * - `refreshGit()` 强制重探（面板「重新检测」）；
 * - `installHint(platform)` 给出各平台安装命令与官方下载地址；
 * - `gitRequired(config)` 把 `rules.requireGit` 变成写操作前的统一闸门：
 *   false=降级（文件仍可读写），true=缺失即硬拦并返回 `git_required`。
 *
 * 边界：只读探测，不安装、不改配置、不联网（下载地址只是文本，不自动打开）。
 * Why 单独成文件：git 缺失是环境问题不是规则仓储的失败；探测结果要给面板/路由/写操作
 * 三处共用，且必须可注入 exec 做脱机单测（本机没 git 也要能验证降级分支）。
 */
import { execFileSync } from 'node:child_process'

/** 模块级缓存时长：60s 内重复探测直接复用（进程启动后第一条规则写不重复 spawn）。 */
export const GIT_CACHE_MS = 60_000

/** @type {{at:number,info:object}|null} */
let cache = null
let probeCount = 0

/**
 * 解析 `git --version` 输出。
 * @param {string} out
 * @returns {string} 版本号；解析失败为空串
 */
function parseVersion(out) {
  const m = String(out ?? '').match(/git version\s+([0-9][0-9A-Za-z.+-]*)/i)
  return m ? m[1] : ''
}

/**
 * 探测 git。
 *
 * exec 的签名与 child_process.execFileSync 一致：`(file, args, options)`。
 * 注入 exec 便于单测模拟 ENOENT/非 0 退出；返回值永远不抛。
 *
 * @param {{exec?: Function, timeoutMs?: number, force?: boolean}} [opts]
 * @returns {{available:boolean,version:string,error:string|null,checkedAt:number}}
 */
export function detectGit(opts = {}) {
  const now = Date.now()
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : GIT_CACHE_MS
  if (!opts.force && cache && now - cache.at < ttl) return { ...cache.info }

  const exec = opts.exec || execFileSync
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2000
  probeCount += 1
  let info
  try {
    const out = exec('git', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
    const version = parseVersion(out)
    info = version
      ? { available: true, version, error: null, checkedAt: now }
      // 命令能跑但输出不认识（包装过的 git/裁剪版）：仍视为不可用，不赌。
      : { available: false, version: '', error: 'unrecognized_version', checkedAt: now }
  } catch (err) {
    const code = err?.code || err?.status || ''
    info = {
      available: false,
      version: '',
      error: code === 'ENOENT' ? 'git_not_installed' : String(err?.stderr || err?.message || err || 'git_probe_failed').trim(),
      checkedAt: now,
    }
  }
  cache = { at: now, info }
  return { ...info }
}

/**
 * 强制刷新缓存并重新探测（面板「重新检测」与 `/rules/git-status`）。
 * @param {{exec?:Function,timeoutMs?:number}} [opts]
 * @returns {{available:boolean,version:string,error:string|null,checkedAt:number}}
 */
export function refreshGit(opts = {}) {
  cache = null
  return detectGit({ ...opts, force: true })
}

/** 清空缓存（测试/插件 dispose 用；不探测）。 */
export function resetGitCache() {
  cache = null
  probeCount = 0
}

/** 本次进程已探测次数（只读诊断；缓存命中不计）。 */
export function gitProbeCount() {
  return probeCount
}

/**
 * 各平台安装命令（多语言命令：brew/apt/winget + 官网下载）。
 * 只返回文本，不执行；platform 缺省取 process.platform。
 *
 * @param {string} [platform]
 * @returns {{platform:string,commands:Array<{label:string,command:string}>,download:string,note:string}}
 */
export function installHint(platform = process.platform) {
  const p = String(platform || process.platform)
  if (p === 'darwin') {
    return {
      platform: p,
      commands: [
        { label: 'Homebrew（推荐）', command: 'brew install git' },
        { label: 'Xcode 命令行工具', command: 'xcode-select --install' },
      ],
      download: 'https://git-scm.com/downloads',
      note: '安装后重新打开终端；本插件不会自动安装或联网下载。',
    }
  }
  if (p === 'win32') {
    return {
      platform: p,
      commands: [
        { label: 'winget（推荐）', command: 'winget install --id Git.Git -e --source winget' },
        { label: 'Chocolatey', command: 'choco install git -y' },
      ],
      download: 'https://git-scm.com/downloads',
      note: '安装时勾选「Git from the command line」；安装后重开终端。',
    }
  }
  return {
    platform: p,
    commands: [
      { label: 'Debian/Ubuntu', command: 'sudo apt-get install -y git' },
      { label: 'Fedora/RHEL', command: 'sudo dnf install -y git' },
      { label: 'Arch', command: 'sudo pacman -S --noconfirm git' },
      { label: 'Alpine', command: 'sudo apk add --no-cache git' },
    ],
    download: 'https://git-scm.com/downloads',
    note: '包管理器安装即可；本插件不会自动安装或联网下载。',
  }
}

/**
 * 写操作前闸门：读 `config.rules.requireGit`。
 *
 * - false（默认）：降级放行，`degraded:true`，调用方仍写文件、跳过 git commit；
 * - true：git 不可用立即返回 `{ok:false,error:'git_required'}`，调用方必须原样回给面板。
 *
 * detect 可注入（测试/已有探测结果），缺省走缓存探测。
 *
 * @param {{rules?:{requireGit?:boolean}}|any} config
 * @param {Function|{available:boolean,version:string,error:string|null,checkedAt:number}} [detect]
 * @returns {{required:boolean,ok:boolean,degraded:boolean,git:object,error?:string}}
 */
export function gitRequired(config, detect = detectGit) {
  const required = Boolean(config?.rules?.requireGit)
  const info = typeof detect === 'function' ? detect() : (detect || detectGit())
  if (!required) {
    return { required: false, ok: true, degraded: !info.available, git: info }
  }
  if (info.available) return { required: true, ok: true, degraded: false, git: info }
  return { required: true, ok: false, degraded: true, git: info, error: 'git_required' }
}
