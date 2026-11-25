// 职责：候选文件存储底座（读写/列表/冷却日志/上限/归档）与文本工具；
// 依赖：node 内置（crypto/fs/path）+ ../../shared/config-values.js + ../rules.js(dedupeKey) + ../rule-store.js(atomicWriteFile/defaultRuleRoot)；不 import 本域其他子模块/门面。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { num, value } from '../../shared/config-values.js'
import { dedupeKey } from '../rules.js'
import { atomicWriteFile, defaultRuleRoot } from '../rule-store.js'

/** 候选 id 形状：`p<毫秒时间戳>_<hash8>`；同时充当路径安全闸（不允许 `..`/分隔符）。 */
export const PROPOSAL_ID_RE = /^p[0-9]{3,19}_[a-z0-9]{4,16}$/
/** 冷却日志文件名（生成物；`proposals/` 下唯一以点开头的文件）。 */
export const REJECTED_FILE = '.rejected.jsonl'
/** 冷却日志保留口径（R9-14）：180 天内或最近 200 条，取并集；日志不得无限增长。 */
export const REJECTED_KEEP_DAYS = 180
export const REJECTED_KEEP_LAST = 200
/** 过期候选归档目录（proposals/archive/）：移出主扫描范围，但保留裁定证据。 */
export const PROPOSALS_ARCHIVE_DIR = 'archive'
/** 需要措辞改写（不能直接落盘）的关系。 */
export const REWRITE_RELATIONS = Object.freeze(['merge', 'conflict', 'refine'])

export function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

export function trimmed(value) {
  return textOf(value).trim()
}

export function chars(text) {
  return Array.from(textOf(text)).length
}

/**
 * 候选去重 hash（架构书 §3.2）：**必须含 scope+role**——同一句话在不同工作区是两条候选，
 * 不能互相占用命中计数/冷却窗口。文本先走 `dedupeKey` 归一化，scope/role 单独进盐。
 * @param {string} text 用户原句
 * @param {string|{scope?:string,role?:string}} [scopeOrDraft] 作用域（或草案）
 * @returns {string} 16 hex
 */
export function proposalHashOf(text, scopeOrDraft = {}) {
  const scope = trimmed(typeof scopeOrDraft === 'string' ? scopeOrDraft : scopeOrDraft?.scope) || 'global'
  const role = trimmed(typeof scopeOrDraft === 'object' && scopeOrDraft ? scopeOrDraft.role : '')
  return createHash('sha256').update(`${dedupeKey(text)}|${scope}|${role}`, 'utf8').digest('hex').slice(0, 16)
}

export function isoNow(now) {
  return new Date(now).toISOString()
}

/**
 * 规则根：显式参数 > `config.rules.dir` > `$DSH_HOME/rules`。
 * @param {string} [rulesDir] @param {any} [config] @returns {string}
 */
export function resolveRuleRoot(rulesDir, config) {
  const explicit = trimmed(rulesDir)
  if (explicit) return resolve(explicit)
  const configured = trimmed(value(config?.rules?.dir, ''))
  return configured ? resolve(configured) : defaultRuleRoot()
}

/** 候选目录。 */
export function proposalsDirOf(rulesDir, config) {
  return join(resolveRuleRoot(rulesDir, config), 'proposals')
}

// ---------------------------------------------------------------------------
// 候选读写
// ---------------------------------------------------------------------------

/**
 * 原子写候选 JSON；失败不抛。
 * @param {string} file @param {object} proposal @returns {{ok:boolean,error?:string}}
 */
export function writeProposalFile(file, proposal) {
  return atomicWriteFile(file, `${JSON.stringify(proposal, null, 2)}\n`)
}

/**
 * 读候选 JSON（id 非法/文件缺失/坏 JSON 都返回 `proposal_not_found`，不泄露路径细节）。
 * @param {{rulesDir?:string, config?:any, id:string}} args
 * @returns {{ok:true, proposal:object} | {ok:false, error:string}}
 */
export function readProposal({ rulesDir, config, id } = {}) {
  const wanted = trimmed(id)
  if (!PROPOSAL_ID_RE.test(wanted)) return { ok: false, error: 'proposal_not_found' }
  const file = join(proposalsDirOf(rulesDir, config), `${wanted}.json`)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: 'proposal_not_found' }
  }
  try {
    const proposal = JSON.parse(raw)
    if (!proposal || typeof proposal !== 'object') return { ok: false, error: 'proposal_not_found' }
    return { ok: true, proposal: { ...proposal, id: textOf(proposal.id || wanted), file } }
  } catch {
    return { ok: false, error: 'proposal_not_found' }
  }
}

/**
 * 候选列表（新→旧）；`status` 支持单值或逗号分隔多值过滤。
 * @param {{rulesDir?:string, config?:any, status?:string}} [args]
 * @returns {{ok:true, proposals:Array<object>, dir:string}}
 */
export function listProposals({ rulesDir, config, status = '' } = {}) {
  const dir = proposalsDirOf(rulesDir, config)
  const wanted = trimmed(status).split(',').map((s) => s.trim()).filter(Boolean)
  const proposals = []
  const names = readdirNames(dir)
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!PROPOSAL_ID_RE.test(id)) continue
    const got = readProposal({ rulesDir, config, id })
    if (!got.ok) continue
    if (wanted.length && !wanted.includes(textOf(got.proposal.status))) continue
    proposals.push(got.proposal)
  }
  proposals.sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))
    || String(b.id).localeCompare(String(a.id)))
  return { ok: true, proposals, dir }
}

/** 目录列表（不存在/不可读按空处理：候选目录可能还没建）。 */
export function readdirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 冷却（拒绝日志）
// ---------------------------------------------------------------------------

/** 读冷却日志：坏行跳过，不让一行脏数据挡住所有提案。 */
export function readRejected(dir) {
  let raw = ''
  try {
    raw = readFileSync(join(dir, REJECTED_FILE), 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const item = line.trim()
    if (!item) continue
    try {
      const parsed = JSON.parse(item)
      if (parsed && typeof parsed === 'object' && trimmed(parsed.hash)) entries.push(parsed)
    } catch { /* 坏行跳过 */ }
  }
  return entries
}

/**
 * 冷却日志裁剪（R9-14）：保留「180 天内」与「最近 200 条」的并集，避免 jsonl 无限增长。
 *
 * 为什么取并集而不是只按时间：冷却窗口内必须留着（否则同一句可被反复提案），
 * 而历史裁定证据也要留最近一批供面板/审计回看；两条判据各自独立。
 *
 * @param {Array<object>} entries @param {number} now
 * @returns {Array<object>}
 */
export function pruneRejected(entries, now) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return []
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const cutoff = nowMs - REJECTED_KEEP_DAYS * 24 * 3600 * 1000
  const recentStart = Math.max(0, list.length - REJECTED_KEEP_LAST)
  return list.filter((item, index) => {
    if (index >= recentStart) return true
    const expiresAt = Number.isFinite(Number(item?.expiresAt))
      ? Number(item.expiresAt)
      : (Number.isFinite(Number(item?.ts)) ? Number(item.ts) + REJECTED_KEEP_DAYS * 24 * 3600 * 1000 : NaN)
    return Number.isFinite(expiresAt) && expiresAt >= cutoff
  })
}

/** 追加一行冷却记录（原子重写 + 裁剪：jsonl 被并发截断会让冷却整体失效）。 */
export function appendRejected(dir, entry, now = Date.now()) {
  const entries = pruneRejected([...readRejected(dir), entry], now)
  const lines = entries.map((item) => JSON.stringify(item)).join('\n')
  return atomicWriteFile(join(dir, REJECTED_FILE), `${lines}\n`)
}

/**
 * 是否在冷却期：同 hash 在 `rules.askCooldownDays`(30) 天的**绝对窗口**内被拒绝过。
 *
 * 为什么按 `expiresAt` 而不是 `now - ts`：时钟回拨时 `now - ts` 会变成负数（永远 ≤ 窗口），
 * 冷却/会话 TTL 就被永久冻住；落绝对到期时间后，回拨只是延长到原到期点，前跳则正常解冻。
 * @returns {boolean}
 */
export function isCooling(dir, hash, days, now) {
  if (!hash || days <= 0) return false
  const windowMs = days * 24 * 3600 * 1000
  for (const entry of readRejected(dir)) {
    if (trimmed(entry.hash) !== hash) continue
    const expiresAt = Number.isFinite(Number(entry.expiresAt))
      ? Number(entry.expiresAt)
      : (Number.isFinite(Number(entry.ts)) ? Number(entry.ts) + windowMs : NaN)
    if (!Number.isFinite(expiresAt)) continue
    if (now < expiresAt) return true
  }
  return false
}

/** 建候选目录（recursive：首次提案时 rules/proposals 可能都不存在）。 */
export function mkdirIfNeeded(dir) {
  mkdirSync(dir, { recursive: true })
}

/**
 * 候选上限：保留 pending/needs_manual 里最新的 `rules.maxProposals` 条，最旧的标 expired。
 * 为什么不删文件：候选是裁定证据，面板要能翻历史；只改状态。
 * @returns {string[]} 被标 expired 的 id
 */
export function enforceProposalCap({ rulesDir, config = {}, now = Date.now(), log = () => {} } = {}) {
  const max = Math.max(1, num(config?.rules?.maxProposals, 20))
  const { proposals, dir } = listProposals({ rulesDir, config, status: 'pending,needs_manual' })
  if (proposals.length <= max) return []
  const keep = new Set(proposals.slice(0, max).map((item) => item.id))
  const expired = []
  for (const item of proposals) {
    if (keep.has(item.id)) continue
    const file = item.file || join(dir, `${item.id}.json`)
    const next = { ...item, status: 'expired', updated: isoNow(now) }
    const written = writeProposalFile(file, next)
    if (written.ok) expired.push(item.id)
  }
  if (!expired.length) return []
  // 归档（R9-14）：expired 候选移出主目录，只改状态不够——listProposals 每次全扫主目录，
  // 过期项无限堆积会让候选扫描越跑越慢，也会挤占面板「待确认」视野。
  archiveExpiredProposals(dir, expired, log)
  log(`[whale-memory] proposals cap=${max} expired=${expired.length}`)
  return expired
}

/**
 * 把过期候选从 `proposals/*.json` 移到 `proposals/archive/`：保留裁定证据但退出主扫描范围。
 *
 * 失败只记日志不回滚（过期是状态事实，归档是卫生动作）：rename 失败时留主目录，
 * 下次会再试；不删文件、不改状态。
 *
 * @param {string} dir proposals 目录 @param {string[]} ids 已标 expired 的候选 id
 * @param {Function} log
 */
export function archiveExpiredProposals(dir, ids, log) {
  const archiveDir = join(dir, PROPOSALS_ARCHIVE_DIR)
  try { mkdirSync(archiveDir, { recursive: true }) } catch (err) {
    log(`[whale-memory] proposals archive mkdir failed: ${err?.message || err}`)
    return
  }
  for (const id of ids) {
    const from = join(dir, `${id}.json`)
    const to = join(archiveDir, `${id}.json`)
    if (!existsSync(from)) continue
    try {
      renameSync(from, to)
    } catch (err) {
      log(`[whale-memory] proposals archive rename failed id=${id} code=${err?.code || err?.message || err}`)
    }
  }
}
