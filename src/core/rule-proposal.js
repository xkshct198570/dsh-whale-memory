/**
 * 规则提案制（R3b）：候选生成、冷却、裁定、**唯一应用事务**。
 *
 * 职责：
 * - `createProposal`：信号门槛 → 结构化编译 → 关系判定 → 冷却检查 → 原子写候选 JSON；
 * - `listProposals` / `readProposal` / `rejectProposal`：候选只读视图与拒绝（写冷却日志）；
 * - `applyProposal`：守卫 → 落盘（单次 git commit）→ 镜像 → 重渲染 → 审计；任一步失败回滚；
 * - `confirmPendingForSession`：聊天里的"确认短语"→ 应用本会话唯一候选（含 30min TTL 映射）。
 *
 * 边界：
 * - 提案期**不调 LLM**（避免对话延迟）；合并/冲突/改写的措辞改写只在 apply 时做，
 *   且只在 `rules.llm` 打开时（架构书 §4.4）。
 * - 候选存 `proposals/<id>.json`，冷却日志 `proposals/.rejected.jsonl`；**不进 git、不镜像**。
 * - 规则文件仍由 rule-store 写（原子写 + 历史快照 + 校验），本模块不自己拼文件。
 * - 不碰 HTTP、不碰面板；路由/ hook 只做编排。
 *
 * Why 单独成文件：这是"机器起草、用户裁定"的唯一闸口。把它和路由/hook 混在一起，
 * 就会出现"面板能确认、聊天也能确认，但两条路径落盘逻辑不同"的分叉——同一入口才能保证
 * 守卫、编号、commit、镜像、审计五件事一次全做或全不做。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dedupeKey, detectSignals } from './rules.js'
import {
  buildMergePrompt,
  classifyRelation,
  compileStructured,
  parseMergeReply,
} from './rule-reconcile.js'
import {
  atomicWriteFile,
  defaultRuleRoot,
  ensureRuleRepo,
  gitCommit,
  listRules,
  nextRuleNumber,
  occupancy,
  readTombstones,
  regenerateManifest,
  requireGitGate,
  ruleCommitState,
  writeRule,
} from './rule-store.js'
// R8-03 的存储层契约（锁/事务日志/显式路径提交）由 store owner 落地；未落地时按下面的
// `*Safe` 降级函数退回旧路径（同一事务语义，只是没有跨进程仓库锁与 .txn 日志）。
import * as storeApi from './rule-store.js'
import { buildApplyPlan } from './rule-plan.js'
import { agentsPathOf, renderAgentsDigest, titleOfRule } from './rule-render.js'
import { mirrorRules } from './rule-mirror.js'

/** 候选 id 形状：`p<毫秒时间戳>_<hash8>`；同时充当路径安全闸（不允许 `..`/分隔符）。 */
const PROPOSAL_ID_RE = /^p[0-9]{3,19}_[a-z0-9]{4,16}$/
/** 冷却日志文件名（生成物；`proposals/` 下唯一以点开头的文件）。 */
export const REJECTED_FILE = '.rejected.jsonl'
/** 冷却日志保留口径（R9-14）：180 天内或最近 200 条，取并集；日志不得无限增长。 */
export const REJECTED_KEEP_DAYS = 180
export const REJECTED_KEEP_LAST = 200
/** 过期候选归档目录（proposals/archive/）：移出主扫描范围，但保留裁定证据。 */
export const PROPOSALS_ARCHIVE_DIR = 'archive'
/** 会话候选映射 TTL：用户隔了半小时才回「确认」就不要再猜是哪条。 */
export const SESSION_PENDING_TTL_MS = 30 * 60 * 1000
/** 需要措辞改写（不能直接落盘）的关系。 */
const REWRITE_RELATIONS = Object.freeze(['merge', 'conflict', 'refine'])
/** 会话候选映射：只存最新一条（一屏只问一条，避免"确认"指代不明）。 */
const sessionPending = new Map()

/**
 * 配置取值（core 不能 import host/config-values.js：依赖方向是 host→core）。
 * `.volatile()` 字段在运行时是 Ref，必须 `.get()`；直接比较会恒真（假开关）。
 * @param {any} input @param {any} fallback @returns {any}
 */
function cfgValue(input, fallback) {
  const raw = input && typeof input.get === 'function' ? input.get() : input
  return raw === undefined ? fallback : raw
}

function cfgBool(input, fallback = false) {
  const raw = cfgValue(input, fallback)
  return typeof raw === 'boolean' ? raw : fallback
}

function cfgNum(input, fallback) {
  const raw = Number(cfgValue(input, fallback))
  return Number.isFinite(raw) ? raw : fallback
}

function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

function trimmed(value) {
  return textOf(value).trim()
}

function chars(text) {
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

function today() {
  return new Date().toISOString().slice(0, 10)
}

function isoNow(now) {
  return new Date(now).toISOString()
}

/**
 * 规则根：显式参数 > `config.rules.dir` > `$DSH_HOME/rules`。
 * @param {string} [rulesDir] @param {any} [config] @returns {string}
 */
export function resolveRuleRoot(rulesDir, config) {
  const explicit = trimmed(rulesDir)
  if (explicit) return resolve(explicit)
  const configured = trimmed(cfgValue(config?.rules?.dir, ''))
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
function writeProposalFile(file, proposal) {
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
function readdirNames(dir) {
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
function readRejected(dir) {
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
function pruneRejected(entries, now) {
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
function appendRejected(dir, entry, now = Date.now()) {
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
function isCooling(dir, hash, days, now) {
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

// ---------------------------------------------------------------------------
// 候选生成
// ---------------------------------------------------------------------------

/** 候选摘要（面板/聊天提示共用；不塞正文，避免把候选读成规则本体）。 */
function summaryOf(draft, relation) {
  const label = trimmed(draft?.type) === 'iron-rule' ? `铁律${draft.number}` : trimmed(draft?.key)
  // 优先用结构化编译出的短标题（“删源文件”），退化才用渲染层启发式。
  const title = textOf(draft?.title) || titleOfRule({ action: draft?.action, number: draft?.number }, draft?.text)
  return { label, title, relation }
}

/** 快照受影响旧规则（apply 时若文件已变，以磁盘为准；这份是兜底证据）。 */
function snapshotAffected(rules, targets) {
  const byKey = new Map(rules.map((doc) => [textOf(doc.front?.key), doc]))
  const out = []
  for (const target of targets) {
    const doc = byKey.get(target.key)
    if (!doc) continue
    out.push({
      key: textOf(doc.front.key),
      number: Number(doc.front.number),
      file: doc.file,
      front: { ...doc.front },
      text: textOf(doc.text),
      reason: textOf(target.reason),
    })
  }
  return out
}

/**
 * 生成候选（架构书 §4.1）。
 *
 * @param {{text:string, source?:string, identity?:object, traceId?:string, sessionId?:string,
 *   rulesDir?:string, config?:any, log?:Function, now?:number}} args
 * @returns {{ok:true, proposal:object, cooling:boolean, existing?:boolean} | {ok:false, code:string}}
 *   code: rules_disabled|privacy|preference|descriptive|not_rule|<compile 错误码>
 */
export function createProposal({
  text, source = 'owner', identity = {}, traceId = '', sessionId = '',
  rulesDir, config = {}, log = () => {}, now = Date.now(),
} = {}) {
  const raw = trimmed(text)
  if (!cfgBool(config?.rules?.enabled, true)) return { ok: false, code: 'rules_disabled' }
  if (!raw) return { ok: false, code: 'empty' }

  const base = resolveRuleRoot(rulesDir, config)
  const ident = identity && typeof identity === 'object' ? identity : {}
  const signals = detectSignals(raw, { source, workspace: trimmed(ident.workspace) })
  if (signals.rejectReason) return { ok: false, code: signals.rejectReason }
  if (!signals.ruleLike) return { ok: false, code: 'not_rule' }

  const listed = listRules(base)
  // 只与 active 正式规则比对：superseded/retired 已经失效，候选里的 `rule-candidate` 不是同层级。
  const activeRules = listed.rules.filter((doc) => textOf(doc.front.status) === 'active'
    && textOf(doc.front.type) !== 'rule-candidate')
  // 编号口径必须与 manifest/create/health 同源：用全量规则（含 inactive/候选外的历史文件）
  // ＋文件名＋墓碑算 nextNumber；关系判定仍只看 activeRules。
  // （非 `iron-rule-<n>.md` 文件名的 inactive 铁律，只能靠全量 rules 的 front 号占位。）
  // R9-20：提案期取号与 plan/create/health 同口径——occupancy() 是唯一入口
  // （文件名编号 ∪ 解析成功 front 编号 ∪ 墓碑）；manifest.retired 不再参与取号。
  const occupiedNumbers = occupancy(base, { listed })
  const nextNumber = nextRuleNumber(occupiedNumbers)

  const compiled = compileStructured(raw, signals, {
    existingRules: activeRules,
    nextNumber,
    occupancy: occupiedNumbers,
    source,
    workspace: trimmed(ident.workspace),
    // role 必须进草案：候选 hash 含 role（架构书 §3.2），否则跨角色会共用命中去重/冷却。
    role: trimmed(ident.roleId),
  })
  if (!compiled.ok) return { ok: false, code: compiled.error, detail: compiled.detail }
  const draft = compiled.draft
  const relation = classifyRelation(draft, activeRules)
  // R9-19 ④：候选创建前先查 key 全仓唯一（跨 scope 也不得同名）与编号占用。
  // 注定 target_conflict/number_conflict/number_retired 的候选不创建（也不追加提示行），
  // 否则用户看到的"待确认"到了 apply 才失败（假承诺）。同 scope 同 key 走 refine 语义。
  const allByKey = new Map(listed.rules.map((doc) => [trimmed(doc.front.key), doc]))
  const sameKeyDoc = allByKey.get(draft.key)
  if (sameKeyDoc && relation.relation !== 'refine') {
    return {
      ok: false,
      code: 'target_conflict',
      detail: {
        key: draft.key,
        scope: trimmed(sameKeyDoc.front.scope),
        status: trimmed(sameKeyDoc.front.status),
        reason: 'key_exists_outside_refine',
      },
    }
  }
  if (draft.type === 'iron-rule' && Number.isInteger(Number(draft.number)) && Number(draft.number) > 0) {
    const number = Number(draft.number)
    const refineDoc = relation.relation === 'refine' ? sameKeyDoc : null
    const ownsNumber = Boolean(refineDoc) && Number(refineDoc.front.number) === number
    if (!ownsNumber) {
      if (readTombstones(base).some((item) => Number(item.number) === number)) {
        return { ok: false, code: 'number_retired', detail: { number, key: draft.key } }
      }
      if (occupiedNumbers.has(number)) {
        return { ok: false, code: 'number_conflict', detail: { number, key: draft.key } }
      }
    }
  }
  const affected = snapshotAffected(activeRules, relation.targets)

  const hash = proposalHashOf(raw, draft)
  const hash8 = hash.slice(0, 8)
  const dir = join(base, 'proposals')
  const cooling = isCooling(dir, hash, cfgNum(config?.rules?.askCooldownDays, 30), now)

  const existing = listProposals({ rulesDir: base, config, status: 'pending,needs_manual' }).proposals
    .find((item) => textOf(item.hash) === hash)
  if (existing) {
    // 同 hash 只留一条候选（架构书 §4.1）：重复命中只累加计数，不新建文件。
    const bumped = {
      ...existing,
      hits: Number(existing.hits || 1) + 1,
      updated: isoNow(now),
      // 冷却态按当前时间重算：冷却期过的候选要能重新被问，不能被旧标记永久冻住。
      cooling,
    }
    writeProposalFile(existing.file || join(dir, `${existing.id}.json`), bumped)
    return { ok: true, proposal: bumped, cooling: Boolean(bumped.cooling), existing: true }
  }

  const id = `p${now}_${hash8}`
  if (!PROPOSAL_ID_RE.test(id)) return { ok: false, code: 'invalid_id' }
  const proposal = {
    id,
    status: 'pending',
    hash,
    hash8,
    created: isoNow(now),
    updated: isoNow(now),
    hits: 1,
    source: trimmed(source) || 'owner',
    sessionId: trimmed(sessionId),
    traceId: trimmed(traceId),
    identity: {
      userId: trimmed(ident.userId),
      roleId: trimmed(ident.roleId),
      workspace: trimmed(ident.workspace),
    },
    text: raw,
    draft,
    relation,
    affected,
    affectedKeys: affected.map((item) => item.key),
    needsRewrite: REWRITE_RELATIONS.includes(relation.relation),
    cooling,
    summary: summaryOf(draft, relation.relation),
    // 语义提炼状态：默认规则路径已在编译期完成；rules.llm=true 时候选创建后后台再润色一次。
    refine: {
      state: cfgBool(config?.rules?.llm, false) ? 'pending' : 'rule',
      by: 'rule',
      at: isoNow(now),
    },
    applied: null,
    needsManual: null,
  }

  try {
    mkdirIfNeeded(dir)
  } catch (err) {
    return { ok: false, code: 'dir_failed', detail: String(err?.message || err) }
  }
  const written = writeProposalFile(join(dir, `${id}.json`), proposal)
  if (!written.ok) return { ok: false, code: 'write_failed', detail: written.error }

  const expired = enforceProposalCap({ rulesDir: base, config, now, log })
  return { ok: true, proposal, cooling, ...(expired.length ? { expired } : {}) }
}

/** 建候选目录（recursive：首次提案时 rules/proposals 可能都不存在）。 */
function mkdirIfNeeded(dir) {
  mkdirSync(dir, { recursive: true })
}

/**
 * 候选上限：保留 pending/needs_manual 里最新的 `rules.maxProposals` 条，最旧的标 expired。
 * 为什么不删文件：候选是裁定证据，面板要能翻历史；只改状态。
 * @returns {string[]} 被标 expired 的 id
 */
export function enforceProposalCap({ rulesDir, config = {}, now = Date.now(), log = () => {} } = {}) {
  const max = Math.max(1, cfgNum(config?.rules?.maxProposals, 20))
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
function archiveExpiredProposals(dir, ids, log) {
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

/**
 * 拒绝候选：写冷却日志 + status=rejected。
 * @param {{id:string, reason?:string, identity?:object, rulesDir?:string, config?:any, now?:number}} args
 * @returns {{ok:boolean, proposal?:object, error?:string}}
 */
export function rejectProposal({ id, reason = '', identity = {}, rulesDir, config, now = Date.now() } = {}) {
  const got = readProposal({ rulesDir, config, id })
  if (!got.ok) return { ok: false, error: got.error }
  const proposal = got.proposal
  // 只有未裁定的候选能被拒绝：已收录的候选再拒绝会写出矛盾的冷却记录。
  if (!['pending', 'needs_manual'].includes(textOf(proposal.status))) {
    return { ok: false, error: 'proposal_not_pending' }
  }
  const dir = proposalsDirOf(rulesDir, config)
  const ident = identity && typeof identity === 'object' ? identity : {}
  const entry = {
    hash: textOf(proposal.hash),
    ts: now,
    // 绝对到期时间：时钟回拨不会让冷却永久冻结（isCooling 只比 now < expiresAt）。
    expiresAt: now + Math.max(0, cfgNum(config?.rules?.askCooldownDays, 30)) * 24 * 3600 * 1000,
    id: textOf(proposal.id),
    reason: trimmed(reason).slice(0, 200),
    userId: trimmed(ident.userId),
    roleId: trimmed(ident.roleId),
  }
  try {
    mkdirIfNeeded(dir)
  } catch { /* 冷却写失败不阻止状态更新；面板仍能看到 rejected */ }
  const logged = appendRejected(dir, entry, now)
  const next = {
    ...proposal,
    status: 'rejected',
    updated: isoNow(now),
    rejected: { at: isoNow(now), reason: entry.reason, cooling: logged.ok },
  }
  const written = writeProposalFile(proposal.file || join(dir, `${proposal.id}.json`), next)
  if (!written.ok) return { ok: false, error: 'write_failed' }
  clearSessionPending(proposal.sessionId || '')
  return { ok: true, proposal: next }
}

// ---------------------------------------------------------------------------
// 会话候选映射
// ---------------------------------------------------------------------------

/** @param {string} sessionId @param {string} proposalId @param {number} [now] */
export function setSessionPending(sessionId, proposalId, now = Date.now()) {
  const sid = trimmed(sessionId)
  if (!sid || !PROPOSAL_ID_RE.test(trimmed(proposalId))) return false
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  // 绝对到期时间（R9-14）：时钟回拨时 `now - at` 会变负、TTL 被永久冻结；落 expAt 只延长到原点。
  sessionPending.set(sid, { proposalId: trimmed(proposalId), at, expAt: at + SESSION_PENDING_TTL_MS })
  return true
}

/** @returns {{proposalId:string, at:number, expAt:number}|null} */
export function getSessionPending(sessionId, now = Date.now()) {
  const sid = trimmed(sessionId)
  if (!sid) return null
  const entry = sessionPending.get(sid)
  if (!entry) return null
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const at = Number(entry.at) || 0
  // 兼容旧内存形状（只有 at）：缺失 expAt 时按 at+TTL 推导，不因升级丢 pending。
  const expAt = Number.isFinite(Number(entry.expAt)) ? Number(entry.expAt) : at + SESSION_PENDING_TTL_MS
  if (nowMs >= expAt) {
    sessionPending.delete(sid)
    return null
  }
  return { proposalId: entry.proposalId, at, expAt }
}

export function clearSessionPending(sessionId) {
  const sid = trimmed(sessionId)
  if (sid) sessionPending.delete(sid)
}

/** 测试/dispose 用：清空全部映射。 */
export function resetSessionPending() {
  sessionPending.clear()
}

/** 确认词头（架构书 §4.6 的裁定词表；只认句首，避免「对/好」这类口头词误判）。 */
const CONFIRM_HEAD_RE = /^(确认|确认一下|收录|收进铁律|加入铁律|加入|可以|好)/

/**
 * 确认意图识别：**只认短、明确、无问号的句子**。
 * 含糊回复（「看看」「那个呢」「好不好？」）一律不动状态——裁定必须有确定性。
 * @param {string} query
 * @returns {'confirm'|'none'}
 */
export function detectConfirmIntent(query) {
  const raw = trimmed(query)
  if (!raw) return 'none'
  if (chars(raw) > 12) return 'none'
  if (/[？?]/.test(raw) || /(吗|呢|吧？)\s*$/.test(raw)) return 'none'
  // 否定优先：「先不确认」包含「确认」，必须先挡住。
  if (/(不确认|先不|不要|不用|别|算了|取消|拒绝)/.test(raw)) return 'none'
  const compact = raw.replace(/[。！!，,、\s]+/g, '')
  if (!compact) return 'none'
  // 允许「我确认一下」「这条收进铁律」「那就收录」这类带主语/指代的短句，
  // 但确认词必须落在句首（去掉主语后）：句中偶然出现「对/好」不算裁定。
  const head = compact.replace(/^(我|这条|这个|那就|就|都|先)+/, '')
  return CONFIRM_HEAD_RE.test(head) ? 'confirm' : 'none'
}

/**
 * 会话内确认 → 应用本会话唯一候选。
 *
 * @param {{sessionId:string, query:string, rulesDir?:string, config?:any, identity?:object,
 *   traceId?:string, getLlm?:Function, getSelection?:Function, backend?:any, log?:Function,
 *   now?:number}} args
 * @returns {Promise<{ok:boolean, code:string, proposal?:object, applied?:object,
 *   failures?:Array<object>}>}
 */
export async function confirmPendingForSession({
  sessionId, query, rulesDir, config = {}, identity = {}, traceId = '',
  getLlm = () => null, getSelection = () => null, backend = null, log = () => {}, now = Date.now(),
} = {}) {
  const sid = trimmed(sessionId)
  if (!sid) return { ok: false, code: 'no_session' }
  if (!cfgBool(config?.rules?.enabled, true)) return { ok: false, code: 'rules_disabled' }
  const pending = getSessionPending(sid, now)
  if (!pending) return { ok: false, code: 'no_pending' }
  // 只认 `收录 <id8>`（大小写/空格容忍）：「好/可以/确认」这类模糊句**不动状态**
  // （架构书 §3.4）。面板按钮是唯一显式入口；聊天只作快捷通道，必须有 nonce 指名候选。
  const nonce = confirmNonceOf(query)
  if (!nonce) return { ok: false, code: 'no_confirm' }
  const got = readProposal({ rulesDir, config, id: pending.proposalId })
  if (!got.ok) {
    clearSessionPending(sid)
    return { ok: false, code: 'no_pending' }
  }
  // nonce 必须指向本会话映射的那一条：不许用面板里另一条的 nonce 顶替（会收录没给用户看过口径的候选）。
  const expected = proposalNonce(got.proposal)
  if (!expected || expected !== nonce) return { ok: false, code: 'nonce_mismatch', proposal: got.proposal }
  const result = await applyProposal({
    id: pending.proposalId,
    decisions: {},
    identity,
    traceId,
    rulesDir,
    config,
    getLlm,
    getSelection,
    backend,
    log,
    now,
  })
  if (result.ok) {
    clearSessionPending(sid)
    return { ok: true, code: 'applied', proposal: result.proposal, applied: result.applied }
  }
  return {
    ok: false,
    code: textOf(result.code || result.error) || 'apply_failed',
    proposal: result.proposal,
    failures: result.failures || [],
  }
}

// ---------------------------------------------------------------------------
// 应用事务：存储层契约接线（锁 / 事务日志 / 显式路径提交）
// ---------------------------------------------------------------------------

/** 读文件当前内容：不存在返回 null（坏盘/权限错误必须抛，不能当空文件）。 */
function readIfExists(file) {
  if (!file) return null
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

/** @param {string} text @returns {string} sha256 hex（与 rule-plan 的 oldHash 同口径）。 */
function sha256(text) {
  return createHash('sha256').update(textOf(text), 'utf8').digest('hex')
}

/**
 * 仓库级写锁（R8-02 契约）：store owner 未落地时降级为"函数内同步执行"。
 *
 * Why 降级而不是自己造锁：锁/事务日志是存储层资产（stale 清理、跨进程语义都在 store 侧），
 * 这里再造一份就会两套真源。降级态下 TS-CAS（oldHash 复核 + 候选状态重读）仍在，只是
 * 跨进程窗口没有互斥；store 落地后本函数自动走真锁。
 * @returns {{ok:true,value:any}|{ok:false,lockError:string}}
 */
function withStoreLock(base, fn, exec) {
  if (typeof storeApi.withRepoLock === 'function') {
    try {
      const value = storeApi.withRepoLock(base, fn, exec ? { exec } : {})
      // 契约：抢锁失败返回 {ok:false,error:'repo_locked',lock}（不抛）。要在这里分流，
      // 否则会被当成"事务失败"回给面板，用户就看不到 lock_failed 这个可重试原因。
      if (value && value.ok === false && value.error === 'repo_locked') {
        return { ok: false, lockError: 'repo_locked' }
      }
      return { ok: true, value }
    } catch (err) {
      return { ok: false, lockError: String(err?.message || err) }
    }
  }
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return { ok: false, lockError: String(err?.message || err) }
  }
}

/** 写事务日志（契约：`.txn/<id>.json`）；未落地时跳过（回滚仍靠内存快照）。 */
function writeTxnSafe(base, txn) {
  if (typeof storeApi.writeTxn !== 'function') return { ok: true, skipped: true }
  try {
    return storeApi.writeTxn(base, txn)
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/** 清事务日志；未落地时 no-op。 */
function clearTxnSafe(base, id) {
  if (typeof storeApi.clearTxn !== 'function') return
  try {
    storeApi.clearTxn(base, id)
  } catch { /* 事务已提交：日志清不掉只影响自愈，不该让已落盘的规则失败 */ }
}

/**
 * 单次提交（契约：显式路径；paths 空则不提交）。store 未落地时退回 `gitCommit`（add -A），
 * 语义仍是"这一笔的所有文件进同一个 commit"，差别只在显式路径清单。
 * @returns {{ok:boolean,committed?:boolean,error?:string}}
 */
function commitChanges(base, message, paths, exec) {
  const opts = exec ? { exec } : {}
  if (typeof storeApi.commitRuleChanges === 'function') {
    try {
      return storeApi.commitRuleChanges(base, message, { paths, ...opts })
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }
  // 兜底也必须带显式 paths：store 已删除 `add -A` 兼容，缺 paths 会变成"静默不提交"。
  return gitCommit(base, message, { paths, ...opts })
}

/** 历史目录当前快照名（事务回滚要删掉本笔新增的快照文件）。 */
function historyNames(base, key) {
  try {
    return readdirSync(join(base, 'history', key))
  } catch {
    return []
  }
}

/**
 * 回滚本笔写入：逐文件恢复旧全文（null=本笔新建 → 删除），删本笔新增 history 条目，
 * 最后按现存规则重建 manifest。返回失败清单（不抛：回滚失败本身要留痕给 health）。
 */
function rollbackPlan(base, plan, historyBefore, { exec = null, gitAvailable = false } = {}) {
  const failures = []
  for (const file of plan.files) {
    try {
      if (file.oldText === null) {
        if (existsSync(file.path)) unlinkSync(file.path)
      } else {
        const written = atomicWriteFile(file.path, file.oldText)
        if (!written.ok) failures.push({ file: file.path, error: written.error })
      }
    } catch (err) {
      failures.push({ file: file.path, error: String(err?.message || err) })
    }
  }
  for (const [key, before] of historyBefore) {
    const keep = new Set(before)
    for (const name of historyNames(base, key)) {
      if (keep.has(name)) continue
      try { unlinkSync(join(base, 'history', key, name)) } catch (err) {
        failures.push({ file: join(base, 'history', key, name), error: String(err?.message || err) })
      }
    }
  }
  try {
    regenerateManifest(base)
  } catch (err) {
    failures.push({ file: join(base, 'manifest.json'), error: String(err?.message || err) })
  }
  // 清 index：commit 失败时 store 的 gitCommit 已把新内容 `git add` 进暂存区，只恢复工作树
  // 不清暂存，下一次任意 commit 会把"已回滚的规则"重新带进历史（lead 审出的回滚缺口）。
  if (gitAvailable) {
    const paths = [...plan.files.map((file) => file.path), join(base, 'manifest.json')]
    if (typeof storeApi.resetGitIndex === 'function') {
      try {
        const reset = storeApi.resetGitIndex(base, paths, exec ? { exec } : {})
        if (reset && reset.ok === false) failures.push({ file: 'git-index', error: String(reset.error || 'reset_failed') })
      } catch (err) {
        failures.push({ file: 'git-index', error: String(err?.message || err) })
      }
    }
  }
  return failures
}


/**
 * 取 LLM 合并回包文本；兼容 chat 与 stream 两种宿主接口。
 *
 * provider/model 两条路径都必填（R9-10）：宿主可能按 provider 路由计费/权限；缺选择时
 * 不能让模型调用"猜默认"，一律 `no_model` 交给上层转 needs_manual（架构书 §3.8）。
 *
 * @param {{llm:any, prompt:{system:string,user:string}, selection?:{provider?:string,model?:string},
 *   log?:Function}} args
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function callLlmMerge({ llm, prompt, selection = null, log = () => {} }) {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: prompt.system }] },
    { role: 'user', content: [{ type: 'text', text: prompt.user }] },
  ]
  const provider = textOf(selection?.provider)
  const model = textOf(selection?.model)
  try {
    if (typeof llm?.chat === 'function') {
      if (!provider || !model) return { ok: false, error: 'no_model' }
      const out = await llm.chat({
        messages,
        system: prompt.system,
        user: prompt.user,
        provider,
        model,
      })
      const text = textOf(typeof out === 'string' ? out : (out?.text ?? out?.content ?? out?.value?.text))
      if (!text) return { ok: false, error: 'llm_empty' }
      return { ok: true, text }
    }
    if (typeof llm?.stream === 'function') {
      if (!provider || !model) return { ok: false, error: 'no_model' }
      let text = ''
      for await (const chunk of llm.stream({
        provider, model, temperature: 0, maxTokens: 800, messages,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'block-end' && chunk?.block?.type === 'text') text += textOf(chunk.block.text)
      }
      if (!text) return { ok: false, error: 'llm_empty' }
      return { ok: true, text }
    }
    return { ok: false, error: 'llm_unavailable' }
  } catch (err) {
    log(`[whale-memory] rules merge llm failed: ${err?.name || err?.message || err}`)
    return { ok: false, error: 'llm_error' }
  }
}

/**
 * 候选落回 needs_manual（失败留痕，不落规则文件）。
 *
 * 带状态 CAS：并发下另一只手已经把候选改成 accepted/rejected 时不得覆盖——否则会出现
 * 「规则已落盘、候选却显示 needs_manual」的两套事实。
 */
function markNeedsManual({ rulesDir, config, proposal, code, detail, failures, now }) {
  const fresh = readProposal({ rulesDir, config, id: proposal.id })
  if (fresh.ok && !['pending', 'needs_manual'].includes(textOf(fresh.proposal.status))) return fresh.proposal
  const next = {
    ...proposal,
    status: 'needs_manual',
    updated: isoNow(now),
    needsManual: {
      code: textOf(code),
      at: isoNow(now),
      ...(detail ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400) } : {}),
      ...(failures?.length ? { failures } : {}),
    },
  }
  const written = writeProposalFile(next.file || join(proposalsDirOf(rulesDir, config), `${next.id}.json`), next)
  return { ...next, ...(written.ok ? {} : { writeError: written.error }) }
}

/** writes.action 口径（writes 表注释定义的动作集）。 */
function auditAction(relation) {
  if (relation === 'duplicate') return 'NOOP'
  if (relation === 'conflict') return 'SUPERSEDE'
  if (relation === 'merge' || relation === 'refine') return 'MERGE'
  return 'ADD'
}

/** 审计：writes（reason=rule_apply）+ evolution（正文 old→new）；失败只记日志。 */
function auditApply({
  backend, proposal, relation, target, beforeText, afterText, affectedChanges,
  commit, mirrorResult, agentsResult, traceId, identity, log,
}) {
  if (!backend || typeof backend.withDb !== 'function') return { ok: false, error: 'backend_unavailable' }
  const ident = identity && typeof identity === 'object' ? identity : {}
  try {
    backend.withDb((db) => {
      const nodeRow = db.prepare('SELECT id FROM nodes WHERE origin = ? LIMIT 1').get(`rule:${target.key}`)
      const nodeId = nodeRow?.id || `rule:${target.key}`
      const now = Date.now() / 1000
      db.prepare(`INSERT INTO writes (ts, trace_id, action, node_id, reason, before_text, after_text,
        mode, payload, user_id, role_id, workspace) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        now, textOf(traceId), auditAction(relation), nodeId, 'rule_apply',
        beforeText ? textOf(beforeText) : null, textOf(afterText), 'auto',
        JSON.stringify({
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          relation,
          number: target.number,
          affected: affectedChanges.map((item) => item.key),
          commit: commit?.message || '',
          mirror: Boolean(mirrorResult?.ok),
          agents: Boolean(agentsResult?.ok),
        }),
        textOf(ident.userId), textOf(ident.roleId), textOf(ident.workspace),
      )
      const evo = db.prepare(`INSERT INTO evolution (ts, from_id, to_id, field, old_value, new_value, trace_id)
        VALUES (?,?,?,?,?,?,?)`)
      const rows = [{ id: nodeId, before: beforeText, after: afterText }]
      for (const change of affectedChanges) {
        const row = db.prepare('SELECT id FROM nodes WHERE origin = ? LIMIT 1').get(`rule:${change.key}`)
        rows.push({ id: row?.id || `rule:${change.key}`, before: change.before, after: change.after })
      }
      for (const row of rows) {
        if (textOf(row.before) === textOf(row.after)) continue
        evo.run(now, row.id, row.id, 'text', textOf(row.before), textOf(row.after), textOf(traceId))
      }
      return true
    })
    return { ok: true }
  } catch (err) {
    log(`[whale-memory] rules audit failed: ${err?.message || err}`)
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 唯一应用事务（架构书 §3.5 / R8-03）：plan → 仓库锁 → CAS → 事务日志 → 逐文件落盘 → 单次 commit → 清日志。
 *
 * 顺序不可换：
 * 1. `buildApplyPlan` 先算计划与守卫（纯函数），失败一律不写盘、候选转 needs_manual 并留 failures；
 * 2. 锁内**重读候选**做状态 CAS（双击/并发只有一次能拿到 pending）；
 * 3. 锁内逐文件复核 `oldHash`（TOCTOU：计划之后有人手改 → plan_stale，不写）；
 * 4. 写 `.txn` → 逐文件 `writeRule(lockHeld:true, git:false)` → `commitRuleChanges(显式路径)`；
 * 5. **commit 成功后**才写候选 accepted / 清事务日志；镜像/AGENTS/审计失败不回滚真源。
 *
 * @param {{id:string, decisions?:object, identity?:object, traceId?:string, rulesDir?:string,
 *   config?:any, getLlm?:Function, getSelection?:Function, backend?:any,
 *   mirror?:Function, renderAgents?:Function, git?:boolean, exec?:Function, log?:Function,
 *   now?:number, planHash?:string}} args
 *   planHash: 面板 `/rules/plan` 发回来的指纹；给了就必须与本次重算一致（plan_hash_mismatch）。
 * @returns {Promise<object>}
 */
export async function applyProposal({
  id, decisions = {}, identity = {}, traceId = '', rulesDir, config = {},
  getLlm = () => null, getSelection = () => null, backend = null,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
  planHash = '', gitRequired = null,
} = {}) {
  const base = resolveRuleRoot(rulesDir, config)
  const got = readProposal({ rulesDir: base, config, id })
  if (!got.ok) return { ok: false, error: 'proposal_not_found', code: 'proposal_not_found' }
  const proposal = got.proposal
  if (!cfgBool(config?.rules?.enabled, true)) {
    return { ok: false, error: 'rules_disabled', code: 'rules_disabled', proposal }
  }
  if (!['pending', 'needs_manual'].includes(textOf(proposal.status))) {
    return { ok: false, error: 'proposal_not_pending', code: 'proposal_not_pending', proposal }
  }
  const decided = { ...(decisions && typeof decisions === 'object' ? decisions : {}) }
  const draft = proposal.draft && typeof proposal.draft === 'object' ? proposal.draft : null
  if (!draft || !textOf(draft.key)) return { ok: false, error: 'proposal_corrupt', code: 'proposal_corrupt', proposal }
  const relation = textOf(proposal.relation?.relation) || 'new'
  const needsRewrite = REWRITE_RELATIONS.includes(relation)

  // requireGit 闸门（R9-05）：显式参数优先（路由把 config 折算成布尔传进来），回落到 config
  // 只为兼容直接调用——两者同源，不制造第二个真源。闸门先于建仓，缺 git 时不落任何目录。
  const requireGit = gitRequired === null ? cfgBool(config?.rules?.requireGit, false) : Boolean(gitRequired)
  const gate = requireGitGate(base, { gitRequired: requireGit, git, ...(exec ? { exec } : {}) })
  if (!gate.ok) {
    return { ok: false, error: 'git_required', code: 'git_required', proposal, detail: gate.detail }
  }

  // 1) 措辞改写：面板 decisions.text/affected 优先；需要改写又没给 → rules.llm 问模型，否则转面板。
  //    模型输出只当**候选措辞**：它和面板输入一样只能进 decisions，随后由 plan 逐文件守卫。
  const rewrites = new Map()
  for (const item of Array.isArray(decided.affected) ? decided.affected : []) {
    const key = trimmed(item?.key)
    const next = trimmed(item?.new_text ?? item?.text)
    if (key && next) rewrites.set(key, next)
  }
  if (!trimmed(decided.text)) {
    if (!needsRewrite) {
      decided.text = trimmed(draft.text)
    } else if (!cfgBool(config?.rules?.llm, false)) {
      const manual = markNeedsManual({
        rulesDir: base, config, proposal, code: 'llm_unavailable',
        detail: '需要改写但 rules.llm=false', now,
      })
      return { ok: false, error: 'llm_unavailable', code: 'llm_unavailable', status: 'needs_manual', proposal: manual }
    } else {
      const llm = typeof getLlm === 'function' ? getLlm() : null
      if (!llm) {
        const manual = markNeedsManual({ rulesDir: base, config, proposal, code: 'llm_unavailable', detail: '模型不可用', now })
        return { ok: false, error: 'llm_unavailable', code: 'llm_unavailable', status: 'needs_manual', proposal: manual }
      }
      const affectedDocs = (Array.isArray(proposal.affected) ? proposal.affected : [])
        .map((snap) => ({ key: trimmed(snap?.key), front: snap?.front || {}, text: textOf(snap?.text) }))
        .filter((doc) => doc.key)
      const prompt = buildMergePrompt({ draft, affected: affectedDocs })
      const out = await callLlmMerge({ llm, prompt, selection: getSelection?.(), log })
      if (!out.ok) {
        const manual = markNeedsManual({ rulesDir: base, config, proposal, code: out.error, detail: '模型改写失败', now })
        return { ok: false, error: out.error, code: out.error, status: 'needs_manual', proposal: manual }
      }
      const parsed = parseMergeReply(out.text)
      if (!parsed.ok) {
        const manual = markNeedsManual({
          rulesDir: base, config, proposal, code: 'llm_unparseable', detail: parsed.error, now,
        })
        return { ok: false, error: 'llm_unparseable', code: 'llm_unparseable', status: 'needs_manual', proposal: manual }
      }
      decided.text = parsed.value.merged_text
      // 面板显式给过的 affected 改写优先，模型的不覆盖 owner。
      for (const item of parsed.value.affected) {
        const key = trimmed(item?.key)
        const next = trimmed(item?.new_text)
        if (key && next && !rewrites.has(key)) rewrites.set(key, next)
      }
    }
  }
  decided.affected = [...rewrites.entries()].map(([key, new_text]) => ({ key, new_text }))
  if (!trimmed(decided.text)) {
    const manual = markNeedsManual({ rulesDir: base, config, proposal, code: 'empty_rewrite', now })
    return { ok: false, error: 'empty_rewrite', code: 'empty_rewrite', status: 'needs_manual', proposal: manual }
  }

  // 2) 计划（含逐文件守卫 + planHash）；守卫失败必须把失败项留到候选上（needs_manual 可见可改）。
  const built = buildApplyPlan({ proposal, rulesDir: base, config, decisions: decided, now, log, exec })
  if (!built.ok) {
    if (built.code === 'proposal_corrupt') {
      return { ok: false, error: built.code, code: built.code, proposal }
    }
    const manual = markNeedsManual({
      rulesDir: base, config, proposal, code: built.code, detail: built.detail,
      failures: built.failures, now,
    })
    if (built.code === 'rule_guard_failed') {
      log(`[whale-memory] rule apply guard failed proposal=${proposal.id} failures=${built.failures?.length || 0}`)
    }
    return {
      ok: false,
      error: built.code,
      code: built.code,
      failures: built.failures || [],
      status: 'needs_manual',
      proposal: manual,
    }
  }
  const plan = built.plan
  // 墓碑编号不复用（R8-01）：锁外快路径先挡一次；锁内重算还会再挡（purge 可能发生在两步之间）。
  const planNumber = plan.target.number
  if (Number.isInteger(planNumber) && planNumber > 0
    && typeof storeApi.isRetiredNumber === 'function'
    && storeApi.isRetiredNumber(base, planNumber)) {
    const manual = markNeedsManual({
      rulesDir: base, config, proposal, code: 'number_retired',
      detail: `编号 ${planNumber} 已被墓碑占位（永不复用）`, now,
    })
    return { ok: false, error: 'number_retired', code: 'number_retired', status: 'needs_manual', proposal: manual }
  }
  const expectedPlanHash = trimmed(planHash)
  // 锁外先比一次：能早退就早退（面板 hash 明显过期，不必抢锁）。
  if (expectedPlanHash && expectedPlanHash !== plan.planHash) {
    return {
      ok: false,
      error: 'plan_hash_mismatch',
      code: 'plan_hash_mismatch',
      proposal,
      expectedPlanHash,
      planHash: plan.planHash,
    }
  }

  // 3) 锁内事务：CAS → **锁内重算 plan** → oldHash 复核 → 事务日志 → 逐文件写 → 单次 commit → accepted。
  const runApply = () => {
    const fresh = readProposal({ rulesDir: base, config, id: proposal.id })
    if (!fresh.ok) return { ok: false, code: 'proposal_not_found' }
    if (!['pending', 'needs_manual'].includes(textOf(fresh.proposal.status))) {
      return { ok: false, code: 'proposal_not_pending', proposal: fresh.proposal }
    }
    // 编号/墓碑/oldHash 必须在**锁内**重算：锁外的 plan 可能已被另一笔 apply/purge 改掉
    // （两提案同抢一个号 → 第二笔会撞号 write_failed；plan 后 purge 目标号 → 会复用墓碑号）。
    // 仓就绪/ git 可用性必须**锁内**判定（R9-14）：锁外 ensure 会在两道闸之间留下 TOCTOU 窗口，
    // 且 ensure 自身会重建 manifest——两个写者在锁外各 ensure 一次就是两次半写风险。
    const ensured = ensureRuleRepo({ root: base, git: git !== false, ...(exec ? { exec } : {}) })
    if (!ensured.ok) return { ok: false, code: 'ensure_failed', error: 'ensure_failed', detail: ensured.error }
    const gitAvailable = git !== false && ensured.git?.available === true
    // 同一快照既用于 plan、也用于后面 postRules 之外的判定：一次 listRules，不重复扫盘。
    const listedSnapshot = listRules(base).rules
    const rebuilt = buildApplyPlan({
      proposal: fresh.proposal, rulesDir: base, config, decisions: decided, now, log, exec,
      listed: listedSnapshot,
    })
    if (!rebuilt.ok) {
      if (rebuilt.code === 'proposal_corrupt') return { ok: false, code: 'proposal_corrupt' }
      const manual = markNeedsManual({
        rulesDir: base, config, proposal: fresh.proposal, code: rebuilt.code,
        detail: rebuilt.detail, failures: rebuilt.failures, now,
      })
      return {
        ok: false,
        code: rebuilt.code,
        error: rebuilt.code,
        failures: rebuilt.failures || [],
        status: 'needs_manual',
        proposal: manual,
      }
    }
    const plan = rebuilt.plan // 锁内计划是唯一真源；下面所有旧 hash/编号/提交都取它
    // 面板 hash 以锁内重算为准：两者不一致说明计划已过期，必须让用户重新预览。
    if (expectedPlanHash && expectedPlanHash !== plan.planHash) {
      return { ok: false, code: 'plan_hash_mismatch', expectedPlanHash, planHash: plan.planHash }
    }
    const stale = []
    for (const file of plan.files) {
      let current
      try {
        current = readIfExists(file.path)
      } catch (err) {
        stale.push({ key: file.key, code: 'plan_stale', detail: `读取失败：${err?.message || err}` })
        continue
      }
      const hash = current === null ? null : sha256(current)
      if (hash !== file.oldHash) {
        stale.push({ key: file.key, code: 'plan_stale', detail: '计划后磁盘内容已变化（oldHash 不匹配）' })
      }
    }
    if (stale.length) return { ok: false, code: 'plan_stale', failures: stale }

    // duplicate：不建文件、不 commit，只把裁定写进候选（同一入口，锁内状态 CAS）。
    if (plan.duplicate) {
      const applied = {
        key: plan.target.key,
        file: '',
        number: plan.target.number,
        commit: null,
        // 重复=不写文件，没有版本状态可报；与 update 的 changed:false 同口径。
        commitState: null,
        duplicate: true,
        mirror: null,
        agents: null,
        at: isoNow(now),
      }
      const next = { ...fresh.proposal, status: 'accepted', updated: isoNow(now), applied }
      writeProposalFile(next.file || join(proposalsDirOf(base, config), `${next.id}.json`), next)
      return {
        ok: true, duplicate: true, applied, proposal: next, commit: null, affectedChanges: [],
        commitState: null,
        beforeText: textOf(plan.affected[0]?.oldText), afterText: textOf(plan.affected[0]?.newText),
      }
    }

    // 事务日志是崩溃恢复锚点：写不进去就不许落盘（否则崩溃后没法按 oldText 回滚）。
    const txnId = `apply-${proposal.id}-${now}-${process.pid}`
    const txn = writeTxnSafe(base, {
      id: txnId,
      planHash: plan.planHash,
      proposalId: proposal.id,
      createdAt: isoNow(now),
      files: plan.files.map((file) => ({
        key: file.key, path: file.path, oldText: file.oldText, newText: file.newText,
      })),
    })
    if (!txn.ok && !txn.skipped) {
      return { ok: false, code: 'txn_failed', error: 'txn_failed', detail: txn.error, failures: [{ code: 'txn_failed' }] }
    }
    const historyBefore = new Map(plan.files.map((file) => [file.key, historyNames(base, file.key)]))
    const written = []
    for (const file of plan.files) {
      const out = writeRule(base, { front: file.front, text: file.text }, {
        git: false, lockHeld: true, ...(exec ? { exec } : {}),
      })
      if (!out.ok) {
        const rolledBack = rollbackPlan(base, plan, historyBefore, { exec, gitAvailable })
        // 回滚后必须清本笔事务日志：留着会让下次启动 recover 把之后合法写入当成未完成事务。
        clearTxnSafe(base, txnId)
        return {
          ok: false,
          error: 'write_failed',
          code: textOf(out.error) || 'write_failed',
          detail: out.detail,
          key: file.key,
          rolledBack: true,
          rollbackFailures: rolledBack,
          failures: [{ code: textOf(out.error) || 'write_failed', key: file.key, detail: textOf(out.detail) }],
        }
      }
      written.push({ key: file.key, path: out.path || file.path })
    }

    // 单次 commit（显式路径；paths 为空即不提交，git 不可用时整笔跳过）。
    let commit = null
    if (gitAvailable) {
      // 显式路径：规则文件 + manifest（manifest 每次写都会重建，必须同一笔提交里）。
      const commitPaths = [...plan.files.map((file) => file.path), join(base, 'manifest.json')]
      const committed = commitChanges(base, plan.commitMessage, commitPaths, exec)
      if (!committed.ok) {
        const rolledBack = rollbackPlan(base, plan, historyBefore, { exec, gitAvailable })
        // 同上：commit 失败回滚后清事务日志（restore 已把文件写回 oldText，不再有待恢复项）。
        clearTxnSafe(base, txnId)
        return {
          ok: false,
          error: 'commit_failed',
          code: 'commit_failed',
          detail: committed.error,
          rolledBack: true,
          rollbackFailures: rolledBack,
          commitState: 'failed',
        }
      }
      commit = { message: plan.commitMessage, committed: Boolean(committed.committed) }
    }
    clearTxnSafe(base, txnId)

    const targetFile = written.find((item) => item.key === plan.target.key) || written[0] || { path: '' }
    // 审计的 beforeText 必须取**锁内 plan 的真实旧正文**（R9-14）：新建目标 oldText=空串，
    // refine/merge 目标是磁盘上的旧正文；用空串冒充「原规则不存在」会把改写记成新建。
    const targetPlanFile = plan.files.find((item) => item.key === plan.target.key) || null
    const affectedChanges = plan.affected
      .filter((item) => item.key !== plan.target.key)
      .map((item) => ({ key: item.key, before: item.oldText, after: item.newText, status: item.status }))
    // 候选 accepted 只在 commit 成功后写（失败/崩溃时候选仍是 pending/needs_manual，可重试）。
    const applied = {
      key: plan.target.key,
      file: targetFile.path,
      number: plan.target.number,
      commit: commit ? commit.message : null,
      mirror: null,
      agents: null,
      affected: affectedChanges.map((item) => item.key),
      // 编号被顺延过（提案号被占/保留号）必须让面板看得见，不能静默改成另一个号。
      ...(plan.numberAdjusted ? { numberAdjusted: plan.numberAdjusted } : {}),
      at: isoNow(now),
    }
    const next = { ...fresh.proposal, status: 'accepted', updated: isoNow(now), applied, relationSummary: relation }
    const acceptedWritten = writeProposalFile(next.file || join(proposalsDirOf(base, config), `${next.id}.json`), next)
    if (!acceptedWritten.ok) {
      log(`[whale-memory] rules accepted write failed id=${proposal.id} code=${acceptedWritten.error}`)
    }
    return {
      ok: true, applied, proposal: next, commit, affectedChanges,
      commitState: ruleCommitState(commit, { git: gitAvailable ? true : false }),
      beforeText: targetPlanFile ? textOf(targetPlanFile.oldBody) : '',
      afterText: textOf(plan.target.text),
    }
  }

  const locked = withStoreLock(base, runApply, exec)
  if (!locked.ok) {
    return { ok: false, error: 'lock_failed', code: 'lock_failed', detail: locked.lockError, proposal }
  }
  const outcome = locked.value || { ok: false, code: 'apply_failed' }
  if (!outcome.ok) {
    if (outcome.code === 'proposal_not_pending') {
      return { ok: false, error: 'proposal_not_pending', code: 'proposal_not_pending', proposal: outcome.proposal }
    }
    if (outcome.code === 'plan_stale') {
      return {
        ok: false,
        error: 'plan_stale',
        code: 'plan_stale',
        failures: outcome.failures || [],
        proposal,
      }
    }
    if (outcome.code === 'plan_hash_mismatch') {
      return {
        ok: false,
        error: 'plan_hash_mismatch',
        code: 'plan_hash_mismatch',
        ...(outcome.expectedPlanHash ? { expectedPlanHash: outcome.expectedPlanHash } : {}),
        ...(outcome.planHash ? { planHash: outcome.planHash } : {}),
        proposal: outcome.proposal || proposal,
      }
    }
    return {
      ok: false,
      error: textOf(outcome.error) || textOf(outcome.code) || 'apply_failed',
      code: textOf(outcome.code) || textOf(outcome.error) || 'apply_failed',
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.rolledBack ? { rolledBack: true } : {}),
      ...(outcome.rollbackFailures ? { rollbackFailures: outcome.rollbackFailures } : {}),
      ...(outcome.failures ? { failures: outcome.failures } : {}),
      proposal,
    }
  }

  // 4) 后处理：镜像 → AGENTS 摘要 → 审计。失败不回滚真源（可重试；候选已 accepted）。
  const postRules = listRules(base).rules
  let mirrorResult = null
  const mirrorFn = typeof mirror === 'function' ? mirror : mirrorRules
  if (!outcome.duplicate && cfgBool(config?.rules?.mirrorAuto, true) && backend) {
    try {
      mirrorResult = mirrorFn({ backend, rules: postRules, log })
    } catch (err) {
      mirrorResult = { ok: false, error: String(err?.message || err) }
    }
  }
  let agentsResult = null
  const agentsFn = typeof renderAgents === 'function' ? renderAgents : renderAgentsDigest
  if (!outcome.duplicate && cfgBool(config?.rules?.renderAgents, true)) {
    try {
      agentsResult = agentsFn({
        rules: postRules, agentsPath: agentsPathOf(base), rulesDir: base, log,
        budgetChars: cfgNum(config?.rules?.summaryBudgetChars, 6000),
      })
    } catch (err) {
      agentsResult = { ok: false, code: 'render_failed', error: String(err?.message || err) }
    }
  }
  auditApply({
    backend,
    proposal,
    relation,
    target: { key: outcome.applied.key, number: outcome.applied.number },
    beforeText: textOf(outcome.beforeText),
    afterText: textOf(outcome.afterText),
    affectedChanges: outcome.affectedChanges || [],
    commit: outcome.commit,
    mirrorResult,
    agentsResult,
    traceId,
    identity,
    log,
  })

  const applied = {
    ...outcome.applied,
    mirror: mirrorResult ? { ok: Boolean(mirrorResult.ok), mirrored: mirrorResult.mirrored ?? null } : null,
    agents: agentsResult ? { ok: Boolean(agentsResult.ok), code: agentsResult.code || '', changed: agentsResult.changed ?? null } : null,
  }
  const finalProposal = { ...outcome.proposal, applied }
  writeProposalFile(finalProposal.file || join(proposalsDirOf(base, config), `${finalProposal.id}.json`), finalProposal)
  clearSessionPending(proposal.sessionId || '')
  log(`[whale-memory] rule applied id=${proposal.id} key=${applied.key} #${applied.number ?? '-'} relation=${relation}`)
  return {
    ok: true,
    applied,
    proposal: finalProposal,
    commitState: outcome.commitState ?? null,
    ...(outcome.duplicate ? { duplicate: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// 确认提示行（nonce）
// ---------------------------------------------------------------------------

/**
 * 候选 nonce：`p` + hash8（面板/聊天同一枚，8 位足够短且与候选 id 同源）。
 * @param {object} proposal @returns {string} 无 hash8 时返回空串（退化到面板处理）。
 */
export function proposalNonce(proposal) {
  const hash8 = trimmed(proposal?.hash8)
    || (trimmed(proposal?.id).match(/_([0-9a-z]{8})$/)?.[1] || '')
  return hash8 ? `p${hash8.toLowerCase()}` : ''
}

/**
 * 候选提示行（聊天用）：必须带 `收录 <id8>`，不要让用户猜「确认」指哪条。
 * @param {object} proposal @returns {string}
 */
export function buildProposalAskLine(proposal = {}) {
  const nonce = proposalNonce(proposal)
  const summary = proposal.summary && typeof proposal.summary === 'object' ? proposal.summary : {}
  const label = trimmed(summary.label) || trimmed(proposal.draft?.key)
  const title = trimmed(summary.title)
  const relation = trimmed(proposal.relation?.relation) || 'new'
  const count = Array.isArray(proposal.relation?.targets) ? proposal.relation.targets.length : 0
  const kind = relation === 'new' ? '草稿' : `${relation}/${count} 条既有规则`
  const head = `【规则候选】${label}${title ? ` · ${title}` : ''}（${kind}）`
  if (!nonce) return `${head}——请在规则页签「待确认」面板处理。`
  return `${head}——回复「收录 ${nonce}」确认收进铁律，或到规则页签「待确认」面板处理。`
}

/**
 * 聊天确认的唯一合法形态：**整句** `[确认]收录 <p + 8 位 hex>`（架构书 §3.4）。
 * 正则锚定整句：句中转述、引用提示行、带问号/否定/额外文字一律不算确认。
 */
const CONFIRM_NONCE_RE = /^\s*(?:确认)?收录\s*[pP]([0-9a-fA-F]{8})\s*[。！!]?\s*$/

/**
 * 从一句话里取确认 nonce（带 `p` 前缀，小写）。
 * @param {string} query @returns {string} 空串=不是合法确认句
 */
export function confirmNonceOf(query) {
  const raw = trimmed(query)
  if (!raw) return ''
  const match = raw.match(CONFIRM_NONCE_RE)
  return match ? `p${match[1].toLowerCase()}` : ''
}
