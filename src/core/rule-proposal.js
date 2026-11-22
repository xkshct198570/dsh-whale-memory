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
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dedupeKey, detectSignals, normalizeRuleText } from './rules.js'
import {
  buildMergePrompt,
  classifyRelation,
  compileStructured,
  guardRewrite,
  normalizeForGuard,
  parseMergeReply,
  retainsClause,
} from './rule-reconcile.js'
import {
  atomicWriteFile,
  computeManifest,
  defaultRuleRoot,
  ensureRuleRepo,
  gitCommit,
  listRules,
  regenerateManifest,
  writeRule,
} from './rule-store.js'
import { agentsPathOf, renderAgentsDigest, titleOfRule } from './rule-render.js'
import { mirrorRules } from './rule-mirror.js'

/** 候选 id 形状：`p<毫秒时间戳>_<hash8>`；同时充当路径安全闸（不允许 `..`/分隔符）。 */
const PROPOSAL_ID_RE = /^p[0-9]{3,19}_[a-z0-9]{4,16}$/
/** 冷却日志文件名（生成物；`proposals/` 下唯一以点开头的文件）。 */
export const REJECTED_FILE = '.rejected.jsonl'
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

/** 追加一行冷却记录（原子重写：jsonl 被并发截断会让冷却整体失效）。 */
function appendRejected(dir, entry) {
  const entries = [...readRejected(dir), entry]
  const lines = entries.map((item) => JSON.stringify(item)).join('\n')
  return atomicWriteFile(join(dir, REJECTED_FILE), `${lines}\n`)
}

/**
 * 是否在冷却期：同 hash 在 `rules.askCooldownDays`(30) 天内被拒绝过。
 * @returns {boolean}
 */
function isCooling(dir, hash, days, now) {
  if (!hash || days <= 0) return false
  const windowMs = days * 24 * 3600 * 1000
  for (const entry of readRejected(dir)) {
    if (trimmed(entry.hash) !== hash) continue
    const ts = Number(entry.ts)
    if (!Number.isFinite(ts)) continue
    if (now - ts <= windowMs) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 候选生成
// ---------------------------------------------------------------------------

/** 候选摘要（面板/聊天提示共用；不塞正文，避免把候选读成规则本体）。 */
function summaryOf(draft, relation) {
  const label = trimmed(draft?.type) === 'iron-rule' ? `铁律${draft.number}` : trimmed(draft?.key)
  const title = titleOfRule({ action: draft?.action, number: draft?.number }, draft?.text)
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
  const manifest = computeManifest(activeRules)

  const compiled = compileStructured(raw, signals, {
    existingRules: activeRules,
    nextNumber: manifest.nextNumber,
    source,
    workspace: trimmed(ident.workspace),
  })
  if (!compiled.ok) return { ok: false, code: compiled.error, detail: compiled.detail }
  const draft = compiled.draft
  const relation = classifyRelation(draft, activeRules)
  const affected = snapshotAffected(activeRules, relation.targets)

  const hash = dedupeKey(raw)
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
  const { proposals } = listProposals({ rulesDir, config, status: 'pending,needs_manual' })
  if (proposals.length <= max) return []
  const keep = new Set(proposals.slice(0, max).map((item) => item.id))
  const expired = []
  for (const item of proposals) {
    if (keep.has(item.id)) continue
    const next = { ...item, status: 'expired', updated: isoNow(now) }
    const written = writeProposalFile(item.file || join(proposalsDirOf(rulesDir, config), `${item.id}.json`), next)
    if (written.ok) expired.push(item.id)
  }
  if (expired.length) log(`[whale-memory] proposals cap=${max} expired=${expired.length}`)
  return expired
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
    id: textOf(proposal.id),
    reason: trimmed(reason).slice(0, 200),
    userId: trimmed(ident.userId),
    roleId: trimmed(ident.roleId),
  }
  try {
    mkdirIfNeeded(dir)
  } catch { /* 冷却写失败不阻止状态更新；面板仍能看到 rejected */ }
  const logged = appendRejected(dir, entry)
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
  sessionPending.set(sid, { proposalId: trimmed(proposalId), at: now })
  return true
}

/** @returns {{proposalId:string, at:number}|null} */
export function getSessionPending(sessionId, now = Date.now()) {
  const sid = trimmed(sessionId)
  if (!sid) return null
  const entry = sessionPending.get(sid)
  if (!entry) return null
  if (now - Number(entry.at) > SESSION_PENDING_TTL_MS) {
    sessionPending.delete(sid)
    return null
  }
  return entry
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
  if (detectConfirmIntent(query) !== 'confirm') return { ok: false, code: 'no_confirm' }
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
// 应用事务
// ---------------------------------------------------------------------------

/** 记录文件原样（回滚快照）；file 不存在时 content=null。 */
function trackFile(planned, file) {
  if (!file || planned.some((item) => item.file === file)) return
  let content = null
  try {
    content = readFileSync(file, 'utf8')
  } catch { content = null }
  planned.push({ file, content })
}

/** 回滚：逐文件恢复（null=删除新文件），再重建 manifest；返回失败清单不抛。 */
function rollbackFiles(base, planned) {
  const failures = []
  for (const item of planned) {
    try {
      if (item.content === null) {
        unlinkSync(item.file)
      } else {
        const written = atomicWriteFile(item.file, item.content)
        if (!written.ok) failures.push({ file: item.file, error: written.error })
      }
    } catch (err) {
      failures.push({ file: item.file, error: String(err?.message || err) })
    }
  }
  try {
    regenerateManifest(base)
  } catch (err) {
    failures.push({ file: join(base, 'manifest.json'), error: String(err?.message || err) })
  }
  return failures
}


/** 取 LLM 合并回包文本；兼容 chat 与 stream 两种宿主接口。 */
async function callLlmMerge({ llm, prompt, selection = null, log = () => {} }) {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: prompt.system }] },
    { role: 'user', content: [{ type: 'text', text: prompt.user }] },
  ]
  try {
    if (typeof llm?.chat === 'function') {
      const out = await llm.chat({
        messages,
        system: prompt.system,
        user: prompt.user,
        ...(selection?.provider ? { provider: selection.provider } : {}),
        ...(selection?.model ? { model: selection.model } : {}),
      })
      const text = textOf(typeof out === 'string' ? out : (out?.text ?? out?.content ?? out?.value?.text))
      if (!text) return { ok: false, error: 'llm_empty' }
      return { ok: true, text }
    }
    if (typeof llm?.stream === 'function') {
      const provider = textOf(selection?.provider)
      const model = textOf(selection?.model)
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

/** 候选落回 needs_manual（失败留痕，不落规则文件）。 */
function markNeedsManual({ rulesDir, config, proposal, code, detail, failures, now }) {
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
 * 子句并集（归一化去重；保留原文形态）。
 * 只收**正文里确实还在**的子句：owner 显式 acknowledgeDropped 丢弃的例外不能被 front 字段
 * 偷偷留着，否则结构化字段与正文就是两套事实。
 */
function unionClauses(base, extra, mergedText) {
  const mergedNorm = normalizeForGuard(mergedText)
  const out = []
  const seen = new Set()
  for (const item of [...base, ...extra]) {
    const text = trimmed(item)
    if (!text) continue
    if (mergedNorm && !retainsClause(mergedNorm, text)) continue
    const key = normalizeRuleText(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/**
 * 唯一应用事务（架构书 §4.7）：守卫 → 落盘 → 单次 commit → 镜像 → 渲染 → 审计。
 *
 * 失败语义（与文档的 commit_pending 不同，按 R3b 任务书收紧）：
 * 任何一步失败都**回滚已写文件**并返回错误；只有"镜像/渲染/审计"失败不回滚（它们可重试，
 * 且不回滚才能让面板看到 pending 状态）。
 *
 * @param {{id:string, decisions?:object, identity?:object, traceId?:string, rulesDir?:string,
 *   config?:any, getLlm?:Function, getSelection?:Function, backend?:any,
 *   mirror?:Function, renderAgents?:Function, git?:boolean, exec?:Function, log?:Function,
 *   now?:number}} args
 * @returns {Promise<object>}
 */
export async function applyProposal({
  id, decisions = {}, identity = {}, traceId = '', rulesDir, config = {},
  getLlm = () => null, getSelection = () => null, backend = null,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
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
  const decided = decisions && typeof decisions === 'object' ? decisions : {}
  const draft = proposal.draft && typeof proposal.draft === 'object' ? proposal.draft : null
  if (!draft || !textOf(draft.key)) return { ok: false, error: 'proposal_corrupt', code: 'proposal_corrupt', proposal }
  const relation = textOf(proposal.relation?.relation) || 'new'
  const needsRewrite = REWRITE_RELATIONS.includes(relation)

  // 规则仓就绪 + git 闸门：ensureRuleRepo 顺带给出 git 可用性（本模块不 import host 探测）。
  const ensured = ensureRuleRepo({ root: base, git: git !== false, ...(exec ? { exec } : {}) })
  if (!ensured.ok) return { ok: false, error: 'ensure_failed', code: 'ensure_failed', detail: ensured.error }
  const gitAvailable = git !== false && ensured.git?.available === true
  if (cfgBool(config?.rules?.requireGit, false) && !gitAvailable) {
    return { ok: false, error: 'git_required', code: 'git_required', proposal }
  }

  const currentRules = listRules(base).rules.filter((doc) => textOf(doc.front.status) === 'active'
    && textOf(doc.front.type) !== 'rule-candidate')
  const byKey = new Map(currentRules.map((doc) => [textOf(doc.front.key), doc]))
  // 受影响旧规则：磁盘真源优先（提案后文件可能被手改），缺失时退回提案快照。
  const affectedDocs = []
  for (const snap of Array.isArray(proposal.affected) ? proposal.affected : []) {
    const key = textOf(snap?.key)
    if (!key) continue
    const live = byKey.get(key)
    if (live) affectedDocs.push({ key, front: live.front, text: textOf(live.text), file: live.file })
    else if (snap.front) affectedDocs.push({ key, front: snap.front, text: textOf(snap.text), file: textOf(snap.file) })
  }

  // 3) duplicate：不新建文件，只把裁定结果记下来（hits 累加属于候选侧，规则正文不动）。
  if (relation === 'duplicate') {
    const targetDoc = byKey.get(textOf(proposal.relation?.targets?.[0]?.key))
    const applied = {
      key: targetDoc ? textOf(targetDoc.front.key) : textOf(proposal.relation?.targets?.[0]?.key),
      file: targetDoc?.file || '',
      number: targetDoc ? Number(targetDoc.front.number) : null,
      commit: null,
      duplicate: true,
      mirror: null,
      agents: null,
    }
    const next = { ...proposal, status: 'accepted', updated: isoNow(now), applied: { ...applied, at: isoNow(now) } }
    writeProposalFile(next.file || join(proposalsDirOf(base, config), `${next.id}.json`), next)
    auditApply({
      backend, proposal, relation, target: applied, beforeText: targetDoc?.text, afterText: targetDoc?.text || '',
      affectedChanges: [], commit: null, mirrorResult: null, agentsResult: null, traceId, identity, log,
    })
    return { ok: true, applied, proposal: next, duplicate: true }
  }

  // 1) 措辞改写：面板 decisions.text 优先；否则 rules.llm 打开时问模型。
  let mergedText = trimmed(decided.text)
  const rewrites = []
  if (!mergedText && needsRewrite) {
    if (!cfgBool(config?.rules?.llm, false)) {
      const manual = markNeedsManual({
        rulesDir: base, config, proposal, code: 'llm_unavailable',
        detail: '需要改写但 rules.llm=false', now,
      })
      return { ok: false, error: 'llm_unavailable', code: 'llm_unavailable', status: 'needs_manual', proposal: manual }
    }
    const llm = typeof getLlm === 'function' ? getLlm() : null
    if (!llm) {
      const manual = markNeedsManual({ rulesDir: base, config, proposal, code: 'llm_unavailable', detail: '模型不可用', now })
      return { ok: false, error: 'llm_unavailable', code: 'llm_unavailable', status: 'needs_manual', proposal: manual }
    }
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
    mergedText = parsed.value.merged_text
    for (const item of parsed.value.affected) rewrites.push(item)
  }
  for (const item of Array.isArray(decided.affected) ? decided.affected : []) {
    const key = trimmed(item?.key)
    const newText = trimmed(item?.new_text ?? item?.text)
    if (!key || !newText) continue
    const existing = rewrites.find((rw) => rw.key === key)
    if (existing) existing.new_text = newText
    else rewrites.push({ key, new_text: newText })
  }
  if (!mergedText) mergedText = trimmed(draft.text)
  if (!mergedText) {
    const manual = markNeedsManual({ rulesDir: base, config, proposal, code: 'empty_rewrite', now })
    return { ok: false, error: 'empty_rewrite', code: 'empty_rewrite', status: 'needs_manual', proposal: manual }
  }

  // 2) 守卫：改写正文必须保住旧例外/模态/作用域；新规则也要过长度/隐私/模糊词。
  const strict = cfgBool(config?.rules?.guardStrict, true)
  // 面板发的是布尔（勾选确认= true），聊天/脚本发的是 key 数组；两种都接受，但只在非 strict
  // 模式才放行「丢例外」——strict 是硬闸，勾选也不许绕（架构书 §4.5）。
  const ackRaw = decided.acknowledgeDropped
  const acknowledgeDropped = Array.isArray(ackRaw)
    ? ackRaw
    : (ackRaw === true ? affectedDocs.map((doc) => doc.key) : [])
  // 面板「只接受这几条受影响规则」：不在白名单里的旧规则保持原样（不 supersede、不改写）。
  const acceptAffected = Array.isArray(decided.acceptAffected) && decided.acceptAffected.length
    ? new Set(decided.acceptAffected.map((key) => trimmed(key)).filter(Boolean))
    : null
  const acceptedAffected = acceptAffected ? affectedDocs.filter((doc) => acceptAffected.has(doc.key)) : affectedDocs
  const guard = guardRewrite({ affected: affectedDocs, mergedText, draft, strict, acknowledgeDropped })
  if (!guard.ok) {
    const manual = markNeedsManual({
      rulesDir: base, config, proposal, code: 'rule_guard_failed', failures: guard.failures, now,
    })
    log(`[whale-memory] rule apply guard failed proposal=${proposal.id} failures=${guard.failures.length}`)
    return {
      ok: false,
      error: 'rule_guard_failed',
      code: 'rule_guard_failed',
      failures: guard.failures,
      status: 'needs_manual',
      proposal: manual,
    }
  }

  // 4) 编号/文件名：refine 沿用旧号，其余用草案号（空号 6 由 writeRule 挡住）。
  const targetKey = textOf(draft.key)
  const existingTarget = byKey.get(targetKey)
  const manifest = computeManifest(currentRules)
  const targetNumber = existingTarget
    ? Number(existingTarget.front.number)
    : (Number.isInteger(Number(draft.number)) && Number(draft.number) > 0 ? Number(draft.number) : manifest.nextNumber)

  const planned = []
  trackFile(planned, existingTarget?.file || join(base, `${targetKey}.md`))
  for (const doc of affectedDocs) {
    if (doc.key !== targetKey && doc.file) trackFile(planned, doc.file)
  }

  const supersedable = ['merge', 'conflict', 'refine'].includes(relation)
  const writeOpts = { git: false, ...(exec ? { exec } : {}) }
  const created = existingTarget ? textOf(existingTarget.front.created) || today() : today()
  const version = existingTarget ? Number(existingTarget.front.version || 1) + 1 : 1
  const front = {
    key: targetKey,
    type: textOf(draft.type) || 'rule',
    number: targetNumber,
    priority: textOf(draft.priority) || 'P1',
    scope: textOf(draft.scope) || 'global',
    role: textOf(draft.role),
    modality: textOf(draft.modality) || 'must',
    action: textOf(draft.action),
    object: textOf(draft.object),
    // 合并/冲突/改写时例外与条件必须取并集：守卫已要求旧例外留在正文里，
    // front 里若只留草案的例外，就会出现"正文有、结构化字段没有"的漂移。
    conditions: unionClauses(
      Array.isArray(draft.conditions) ? draft.conditions : [],
      supersedable ? affectedDocs.flatMap((doc) => doc.front.conditions || []) : [],
      mergedText,
    ),
    exceptions: unionClauses(
      Array.isArray(draft.exceptions) ? draft.exceptions : [],
      supersedable ? affectedDocs.flatMap((doc) => doc.front.exceptions || []) : [],
      mergedText,
    ),
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: created || today(),
    updated: today(),
    version,
    origin: `proposal:${textOf(proposal.id)}`,
  }
  const firstWrite = writeRule(base, { front, text: mergedText }, writeOpts)
  if (!firstWrite.ok) {
    const rolledBack = rollbackFiles(base, planned)
    return {
      ok: false,
      error: 'write_failed',
      code: textOf(firstWrite.error) || 'write_failed',
      detail: firstWrite.detail,
      rolledBack: true,
      rollbackFailures: rolledBack,
      proposal,
    }
  }

  // 5) 受影响旧规则：合并→merged_into；冲突→superseded_by；逐条留历史快照（writeRule 内）。
  const supersede = relation === 'merge' || relation === 'conflict'
  const affectedChanges = []
  for (const doc of acceptedAffected) {
    if (doc.key === targetKey) continue
    const rw = rewrites.find((item) => item.key === doc.key)
    const nextText = rw ? rw.new_text : doc.text
    const nextFront = {
      ...doc.front,
      updated: today(),
      version: Number(doc.front.version || 1) + 1,
    }
    if (supersede) {
      nextFront.status = 'superseded'
      if (relation === 'merge') nextFront.merged_into = targetKey
      else nextFront.superseded_by = targetKey
    }
    const written = writeRule(base, { front: nextFront, text: nextText }, writeOpts)
    if (!written.ok) {
      const rolledBack = rollbackFiles(base, planned)
      return {
        ok: false,
        error: 'affected_write_failed',
        code: textOf(written.error) || 'affected_write_failed',
        detail: written.detail,
        key: doc.key,
        rolledBack: true,
        rollbackFailures: rolledBack,
        proposal,
      }
    }
    affectedChanges.push({ key: doc.key, before: doc.text, after: nextText, status: nextFront.status })
  }

  // 6) 单次 git commit：所有规则文件 + manifest 同一个提交，便于整笔回退。
  let commit = null
  if (gitAvailable) {
    const message = `rule: apply ${textOf(proposal.id)} ${targetKey} (#${targetNumber})`
    const committed = gitCommit(base, message, exec ? { exec } : {})
    if (!committed.ok) {
      const rolledBack = rollbackFiles(base, planned)
      return {
        ok: false,
        error: 'commit_failed',
        code: 'commit_failed',
        detail: committed.error,
        rolledBack: true,
        rollbackFailures: rolledBack,
        proposal,
      }
    }
    commit = { message, committed: Boolean(committed.committed) }
  }

  // 7) 后处理：镜像（rules.mirrorAuto）→ AGENTS 摘要（rules.renderAgents）→ 审计。
  const postRules = listRules(base).rules
  let mirrorResult = null
  const mirrorFn = typeof mirror === 'function' ? mirror : mirrorRules
  if (cfgBool(config?.rules?.mirrorAuto, true) && backend) {
    try {
      mirrorResult = mirrorFn({ backend, rules: postRules, log })
    } catch (err) {
      mirrorResult = { ok: false, error: String(err?.message || err) }
    }
  }
  let agentsResult = null
  const agentsFn = typeof renderAgents === 'function' ? renderAgents : renderAgentsDigest
  if (cfgBool(config?.rules?.renderAgents, true)) {
    try {
      agentsResult = agentsFn({ rules: postRules, agentsPath: agentsPathOf(base), rulesDir: base, log })
    } catch (err) {
      agentsResult = { ok: false, code: 'render_failed', error: String(err?.message || err) }
    }
  }
  auditApply({
    backend,
    proposal,
    relation,
    target: { key: targetKey, number: targetNumber },
    beforeText: existingTarget ? textOf(existingTarget.text) : '',
    afterText: mergedText,
    affectedChanges,
    commit,
    mirrorResult,
    agentsResult,
    traceId,
    identity,
    log,
  })

  const applied = {
    key: targetKey,
    file: textOf(firstWrite.path),
    number: targetNumber,
    commit: commit ? commit.message : null,
    mirror: mirrorResult ? { ok: Boolean(mirrorResult.ok), mirrored: mirrorResult.mirrored ?? null } : null,
    agents: agentsResult ? { ok: Boolean(agentsResult.ok), code: agentsResult.code || '', changed: agentsResult.changed ?? null } : null,
    affected: affectedChanges.map((item) => item.key),
    at: isoNow(now),
  }
  const nextProposal = {
    ...proposal,
    status: 'accepted',
    updated: isoNow(now),
    applied,
    relationSummary: relation,
  }
  writeProposalFile(nextProposal.file || join(proposalsDirOf(base, config), `${nextProposal.id}.json`), nextProposal)
  clearSessionPending(proposal.sessionId || '')
  log(`[whale-memory] rule applied id=${proposal.id} key=${targetKey} #${targetNumber} relation=${relation}`)
  return { ok: true, applied, proposal: nextProposal }
}
