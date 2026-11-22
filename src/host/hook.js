/**
 * 记忆召回注入 + 作用域规则注入 + 规则提案/确认（fail-open）。
 *
 * 时序（别改回 section）：pre-step 先做「规则确认 → 作用域注入 → 召回 → 提案」，
 * 把三段文本合并进同一份缓存；systemPrompt.context 在 step() 的 refreshContext 阶段再求值，
 * 本轮请求就能同时带上规则与召回。角色展示由独立插件用 section 注入，记忆用 context（本包），
 * 两者职责不混（架构书 §6.2：不新开 section、不抢别人的名字）。
 *
 * 边界：
 * - **global 规则不做每轮注入**：AGENTS 摘要负责"知道有这条"；只有 `role:`/`workspace:`
 *   规则按身份注入。仅当 AGENTS 标记块不存在时降级注入 global（≤预算），保证规则仍可见。
 * - 提案检测跳过 subagent（没有可裁定的人）；规则注入/召回对 subagent 同样跳过（无会话上下文）。
 * - 提案期不调 LLM；确认时若需措辞改写且模型不可用 → 转面板（needs_manual），不阻断对话。
 * - 生命周期硬线（P-4）：整个安装包在 ctx.effect 内；每次请求带 AbortController；
 *   dispose 时中止在途、清缓存、返回空文本；任何失败只记日志，绝不抛。
 *
 * Why 规则走同一个 context：新开 section 会抢 `whale-memory:recall` 之外的位置与名字，
 * 且预算/清理/失败开放要再做一遍；复用同一段文本，等于复用同一套缓存与降级路径。
 */
import { statSync } from 'node:fs'
import { deriveWorkspace, resolveIdentity } from './identity.js'
import { bool, num, value } from './config-values.js'
import { judgeReply } from '../core/adoption.js'
import { listRules } from '../core/rule-store.js'
import { agentsPathOf, fileHasMarkers } from '../core/rule-render.js'
import {
  confirmPendingForSession,
  createProposal,
  resolveRuleRoot,
  setSessionPending,
} from '../core/rule-proposal.js'

export const CONTEXT_NAME = 'whale-memory:recall'
export const CONTEXT_ORDER = 100
const CACHE_TTL_MS = 120_000
const MAX_QUERY_CHARS = 2000
/** 单步回复累积上限：只用于采纳判定，超出部分不影响回复本身。 */
const REPLY_BUF_MAX = 16_384
/** 规则注入预算（`rules.injectChars` 默认 600）：与召回预算各自独立，互不挤占。 */
export const RULE_INJECT_DEFAULT = 600
/** 作用域规则前缀缓存时长：30s 内同一 (目录 mtime, roleId, workspace) 不重复扫盘。 */
export const RULES_CACHE_TTL_MS = 30_000
/** 会话内确认的上限等待：超时走后台，不阻断主链路。 */
export const CONFIRM_TIMEOUT_MS = 1500
/** 超过这个长度的文本不当作"裁定回复"，避免长消息被误判为确认。 */
const CONFIRM_QUERY_MAX = 500
/** 规则前缀缓存键前缀（与 session id 不可能撞车；service.invalidateCache 清整表即同步失效）。 */
const RULES_KEY_PREFIX = '#rules|'

/**
 * 取最后一条用户消息的文本块。
 * @param {Array<any>} messages
 * @param {number} [maxChars]
 * @returns {string}
 */
export function extractQuery(messages, maxChars = MAX_QUERY_CHARS) {
  if (!Array.isArray(messages)) return ''
  let last = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.source && m.source.kind === 'user') { last = m; break }
  }
  if (!last) return ''
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim()
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** @param {Map<string,{text:string,exp:number}>} cache @param {unknown} sessionId */
function readCached(cache, sessionId) {
  if (!sessionId) return ''
  const key = String(sessionId)
  const entry = cache.get(key)
  if (!entry) return ''
  if (!entry.text || Date.now() >= entry.exp) { cache.delete(key); return '' }
  return entry.text
}

/** @param {any} value @returns {string} */
function textOf(input) {
  return input === null || input === undefined ? '' : String(input)
}

function trimmed(input) {
  return textOf(input).trim()
}

/** 码点计数（预算按字符算，不能按 UTF-16 长度）。 */
function chars(text) {
  return Array.from(textOf(text)).length
}

/**
 * 作用域匹配：`role:` 严格相等；`workspace:` 精确或前缀目录（`path/` 下）。
 * 为什么不比较派生后的 workspace：规则里存的是绝对路径，identity.workspace 也是同一口径
 * 的派生值；再派生一次只会把超长路径压缩成 h:hash 而假不匹配（架构书 §3.4）。
 * @param {string} scope @param {string} roleId @param {string} workspace
 * @returns {boolean}
 */
export function scopeMatches(scope, roleId, workspace) {
  const raw = trimmed(scope)
  if (raw.startsWith('role:')) {
    const role = trimmed(raw.slice('role:'.length))
    return Boolean(role && roleId && role === roleId)
  }
  if (raw.startsWith('workspace:')) {
    const base = trimmed(raw.slice('workspace:'.length)).replace(/\/+$/, '')
    const ws = trimmed(workspace).replace(/\/+$/, '')
    if (!base || !ws) return false
    return ws === base || ws.startsWith(`${base}/`)
  }
  return false
}

/** `【规则·<scope>】` 里展示的作用域（global 也要显式写，防串场）。 */
function scopeLabel(scope) {
  const raw = trimmed(scope) || 'global'
  return raw
}

/** 注入排序：铁律按编号在前，其余按 priority + key；同编号不重复。 */
function compareForInject(a, b) {
  const ironA = textOf(a.front.type) === 'iron-rule' ? 0 : 1
  const ironB = textOf(b.front.type) === 'iron-rule' ? 0 : 1
  if (ironA !== ironB) return ironA - ironB
  const numA = Number(a.front.number) || 0
  const numB = Number(b.front.number) || 0
  if (numA !== numB) return numA - numB
  return textOf(a.front.key).localeCompare(textOf(b.front.key))
}

/**
 * 构造作用域规则前缀（纯读；不写盘、不调模型）。
 *
 * @param {{identity?:object, rulesDir?:string, config?:any, rules?:Array<any>,
 *   agentsPath?:string, budget?:number}} [args]
 * @returns {{text:string, keys:string[], skipped:Array<{key:string,chars:number}>,
 *   chars:number, mode:'scope'|'global'|'none', hasAgentsMarkers:boolean}}
 */
export function buildRulesPrefix({
  identity = {}, rulesDir, config = {}, rules = null, agentsPath = '', budget = null,
} = {}) {
  const dir = trimmed(rulesDir) || resolveRuleRoot('', config)
  const limit = Math.max(0, Number.isFinite(budget) ? Number(budget) : num(config?.rules?.injectChars, RULE_INJECT_DEFAULT))
  const ident = identity && typeof identity === 'object' ? identity : {}
  const roleId = trimmed(ident.roleId)
  const workspace = trimmed(ident.workspace)

  let docs = []
  if (Array.isArray(rules)) docs = rules
  else {
    try {
      docs = listRules(dir).rules
    } catch {
      docs = []
    }
  }
  const active = docs.filter((doc) => textOf(doc?.front?.status || 'active') === 'active'
    && textOf(doc?.front?.type) !== 'rule-candidate')

  const scoped = active.filter((doc) => scopeMatches(doc.front.scope, roleId, workspace))
  const markers = fileHasMarkers(agentsPath || agentsPathOf(dir))
  // global 只作降级：AGENTS 有标记块时摘要已经能看见，再注入就是双份预算双份漂移风险。
  const globals = markers ? [] : active.filter((doc) => trimmed(doc.front.scope || 'global') === 'global')

  const pool = []
  const seen = new Set()
  for (const doc of [...scoped.sort(compareForInject), ...globals.sort(compareForInject)]) {
    const key = textOf(doc.front.key)
    if (!key || seen.has(key)) continue
    seen.add(key)
    pool.push(doc)
  }

  const lines = []
  const keys = []
  const skipped = []
  let used = 0
  let mode = scoped.length ? 'scope' : (globals.length ? 'global' : 'none')
  for (const doc of pool) {
    const key = textOf(doc.front.key)
    const line = `【规则·${scopeLabel(doc.front.scope)}】${textOf(doc.text)}`
    const length = chars(line)
    const extra = lines.length ? 1 : 0
    if (limit > 0 && used + length + extra > limit) {
      // 放不下的规则整条跳过（不截半条规则：半句规则比没有规则更危险）。
      skipped.push({ key, chars: length })
      continue
    }
    lines.push(line)
    keys.push(key)
    used += length + extra
  }
  // 极端情况：单条规则就超预算 → 截断这一条（至少让规则可见），并记进 skipped。
  if (!lines.length && pool.length && limit > 0) {
    const doc = pool[0]
    const key = textOf(doc.front.key)
    const line = `【规则·${scopeLabel(doc.front.scope)}】${textOf(doc.text)}`
    lines.push(Array.from(line).slice(0, limit).join(''))
    keys.push(key)
    skipped.push({ key, chars: chars(line) })
    used = limit
  }
  if (!keys.length) mode = 'none'
  // 同一 key 只记一次 skipped（循环里跳过 + 末尾截断会给同一条记两遍）。
  const skippedUnique = []
  const seenSkipped = new Set()
  for (const item of skipped) {
    if (seenSkipped.has(item.key)) continue
    seenSkipped.add(item.key)
    skippedUnique.push(item)
  }
  return { text: lines.join('\n'), keys, skipped: skippedUnique, chars: used, mode, hasAgentsMarkers: markers }
}

/**
 * 限时等待：确认链路给 1500ms 上限；超时后由后台继续（结果仍会落盘，只是本轮不提示）。
 * @template T @param {Promise<T>} promise @param {number} ms
 * @returns {Promise<T|{timeout:true}>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timeout: true })
    }, Math.max(1, ms))
    if (typeof timer.unref === 'function') timer.unref()
    promise.then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ error: String(err?.message || err) })
    })
  })
}

/**
 * @param {any} ctx
 * @param {{ backend: any, config: any, getIdentityCfg?: () => any, getIdentityHint?: () => any,
 *   getHostUserId?: () => string, log?: (s:string)=>void }} deps
 * @returns {{ cache: Map<string,{text:string,exp:number}>, dispose: () => void,
 *   invalidateRulesCache: () => number }}
 */
export function installHook(ctx, {
  backend, config,
  getIdentityCfg = () => config?.identity,
  getIdentityHint = () => null,
  getHostUserId = () => '',
  identityState = null,
  log = () => {},
}) {
  const cache = new Map()
  const inflight = new Set()
  /**
   * 待判定的注入与回复文本，**按会话单槽**而不是 (turn,step) 复合键。
   * why：pre-step 的 turn/step 与 assistant-stream 帧的编号不保证同源同偏移，
   * 用复合键错位就会静默结算不到（证据在，但永远判不出来）。每步 pre-step 都会
   * 重置文本并重新登记，粒度仍是「一步」，但不再赌两个字段的编号一致。
   */
  const pending = new Map()
  const replyBuf = new Map()
  let disposed = false

  const timeoutMs = num(config?.recall?.timeoutMs, 2000)
  /**
   * 注入层级（volatile 数组 ⇒ Ref，必须每次现取）：undefined 表示"配置里没有这一项"，
   * 交给 backend 不过滤（旧调用方兼容）；数组就原样下传（空数组=不注入）。
   */
  const injectLevels = () => {
    const raw = value(config?.recall?.injectLevels, undefined)
    return Array.isArray(raw) ? raw.map((x) => String(x)) : undefined
  }

  /** 规则目录 mtime：目录项变更（新增/删除/改名）都会变，足以作为缓存键的一部分。 */
  const dirMtime = (dir) => {
    try {
      return statSync(dir).mtimeMs
    } catch {
      return 0
    }
  }

  /** 清规则前缀缓存（service.invalidateCache 清整表时也顺带清掉）。 */
  const invalidateRulesCache = () => {
    let cleared = 0
    for (const key of [...cache.keys()]) {
      if (String(key).startsWith(RULES_KEY_PREFIX)) { cache.delete(key); cleared += 1 }
    }
    return cleared
  }

  /**
   * 取作用域前缀（30s 缓存）：缓存键 = dirMtime|roleId|workspace|AGENTS标记态。
   * 读完就存；规则读失败 fail-open 空串（注入永远不能让对话失败）。
   */
  const getRulesPrefix = ({ identity, rulesDir, agentsPath }) => {
    const key = `${RULES_KEY_PREFIX}${dirMtime(rulesDir)}|${trimmed(identity.roleId)}|${trimmed(identity.workspace)}|${fileHasMarkers(agentsPath) ? 1 : 0}`
    const hit = cache.get(key)
    // 空结果也缓存：没有适用规则时每步重扫目录（读+校验全部规则文件）是纯浪费。
    if (hit && Date.now() < hit.exp) return { ...hit.meta, text: hit.text, cached: true }
    let built
    try {
      built = buildRulesPrefix({ identity, rulesDir, config, agentsPath })
    } catch (err) {
      log(`[whale-memory] rules inject fail-open: ${err?.name || err?.message || err}`)
      built = { text: '', keys: [], skipped: [], chars: 0, mode: 'none', hasAgentsMarkers: false }
    }
    const meta = { keys: built.keys, skipped: built.skipped, chars: built.chars, mode: built.mode }
    cache.set(key, { text: built.text, exp: Date.now() + RULES_CACHE_TTL_MS, meta })
    return { ...meta, text: built.text, cached: false }
  }

  /** 结算一次待判定注入：有引用证据才回写 used，无证据保持 0（未采纳）。 */
  const settle = (sid) => {
    const key = String(sid)
    const entry = pending.get(key)
    pending.delete(key)
    const text = replyBuf.get(key) || ''
    replyBuf.delete(key)
    if (!entry || !entry.recallId) return
    if (!text) {
      log(`[whale-memory] adoption settle recall=${entry.recallId} skipped=no_reply_text`)
      return
    }
    try {
      const verdict = judgeReply(text, entry.nodes)
      log(`[whale-memory] adoption settle recall=${entry.recallId} chars=${text.length} adopted=${verdict.adopted}`)
      if (!verdict.adopted) return
      const res = backend.markRecallUsed?.(entry.recallId, true)
      if (res && res.ok) {
        log(`[whale-memory] adoption recall=${entry.recallId} cited=${verdict.nodeIds.length} chars=${text.length}`)
      }
    } catch (err) {
      log(`[whale-memory] adoption fail-open: ${err?.name || err?.message || err}`)
    }
  }

  /**
   * 会话内确认（身份解析后、召回前）：命中确认短语才应用，失败一律留痕不阻断。
   * @returns {Promise<string>} 本轮要追加的提示行（空串=无）
   */
  const confirmTurn = async ({ sid, query, identity, traceId, rulesDir, identityInfo }) => {
    if (!query) return ''
    let outcome
    try {
      outcome = await withTimeout(confirmPendingForSession({
        sessionId: sid,
        query,
        rulesDir,
        config,
        identity: identityInfo,
        traceId,
        getLlm: () => (typeof ctx?.get === 'function' ? ctx.get('llm') : null),
        getSelection: () => (typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : null),
        backend,
        log,
      }), CONFIRM_TIMEOUT_MS)
    } catch (err) {
      log(`[whale-memory] rules confirm fail-open: ${err?.name || err?.message || err}`)
      return ''
    }
    if (!outcome || outcome.timeout) {
      log('[whale-memory] rules confirm timeout（后台继续）')
      return ''
    }
    if (outcome.error) {
      log(`[whale-memory] rules confirm fail-open: ${outcome.error}`)
      return ''
    }
    if (outcome.ok) {
      const key = textOf(outcome.applied?.key)
      const number = outcome.applied?.number
      log(`[whale-memory] rules confirm applied key=${key} #${number ?? '-'}`)
      return `【规则已收录】${key}${number ? `（#${number}）` : ''}`
    }
    if (outcome.code === 'rule_guard_failed' || outcome.code === 'llm_unavailable'
      || outcome.code === 'llm_unparseable' || outcome.code === 'llm_error') {
      const label = textOf(outcome.proposal?.summary?.label) || textOf(outcome.proposal?.id)
      return `【规则待人工处理】${label}（${outcome.code}）——请在规则页签「待确认」面板确认。`
    }
    if (outcome.code === 'no_pending' || outcome.code === 'no_confirm' || outcome.code === 'rules_disabled') return ''
    log(`[whale-memory] rules confirm skipped code=${outcome.code}`)
    return ''
  }

  /**
   * 提案检测（召回后、不阻塞主链路）：成功则在本轮 context 末尾追加一行"问用户"指令。
   * 冷却中的候选只进面板，不提示（避免反复骚扰同一条被拒的规则）。
   */
  const offerProposal = ({ sid, query, identityInfo, traceId }) => {
    const askMode = String(value(config?.rules?.askMode, 'panel+chat'))
    if (!askMode.includes('chat')) return
    if (chars(query) >= CONFIRM_QUERY_MAX) return
    const run = () => {
      try {
        if (disposed) return
        const created = createProposal({
          text: query,
          source: 'owner',
          identity: identityInfo,
          traceId,
          sessionId: sid,
          rulesDir: resolveRuleRoot('', config),
          config,
          log,
        })
        if (!created.ok) {
          if (created.code !== 'not_rule' && created.code !== 'descriptive' && created.code !== 'preference') {
            log(`[whale-memory] rules proposal skipped code=${created.code}`)
          }
          return
        }
        if (created.cooling) {
          log(`[whale-memory] rules proposal cooling=${created.proposal.id}`)
          return
        }
        setSessionPending(sid, created.proposal.id)
        const summary = created.proposal.summary || { label: created.proposal.draft?.key, title: '', relation: 'new' }
        const relationText = created.proposal.relation?.relation === 'new' ? '草稿'
          : `${created.proposal.relation?.relation}/${created.proposal.relation?.targets?.length || 0} 条既有规则`
        const line = `【规则候选】${summary.label} · ${summary.title}（${relationText}）——请在回复末尾用一句话询问用户是否收进铁律；用户确认后下一轮自动收录。`
        const entry = cache.get(sid)
        if (entry && Date.now() < entry.exp) entry.text = `${entry.text}\n${line}`
        else cache.set(sid, { text: line, exp: Date.now() + CACHE_TTL_MS })
        log(`[whale-memory] rules proposal id=${created.proposal.id} relation=${created.proposal.relation?.relation}`)
      } catch (err) {
        log(`[whale-memory] rules proposal fail-open: ${err?.name || err?.message || err}`)
      }
    }
    // 不阻塞主链路：宿主 setTimeout 优先（随插件生命周期清理），否则 setImmediate。
    if (typeof ctx?.setTimeout === 'function') {
      try { ctx.setTimeout(run, 0); return } catch { /* 宿主不支持就降级 */ }
    }
    if (typeof setImmediate === 'function') { setImmediate(run); return }
    setTimeout(run, 0)
  }

  const onPreStep = async (payload, next) => {
    const decision = await next()
    try {
      if (disposed) return decision
      if (!decision || decision.kind !== 'enter') return decision
      const agent = payload?.agent
      const sessionId = agent?.session?.id
      if (!sessionId) return decision
      if (agent?.session?.header?.origin === 'subagent') return decision
      if (payload?.signal?.aborted) return decision

      const sid = String(sessionId)
      const recallOn = bool(config?.recall?.enabled, true)
      const rulesOn = bool(config?.rules?.enabled, true)
      if (!recallOn && !rulesOn) return decision

      const query = extractQuery(payload.messages)
      const hostUserId = typeof getHostUserId === 'function' ? String(getHostUserId() || '') : ''
      const sessionWorkspace = deriveWorkspace(agent?.session?.header)
      const ident = resolveIdentity(getIdentityCfg(), getIdentityHint(), hostUserId, sessionWorkspace)
      if (!ident.ok) return decision
      // 面板/routes 没有会话 header，读不到会话 workspace；这里把"最近一次召回真正用的身份"
      // 记到共享 state，/stats 与 /config 只读展示，避免面板把 Config 值当成生效值。
      if (identityState && typeof identityState === 'object') {
        identityState.lastRecall = {
          workspace: ident.identity.workspace,
          roleId: ident.identity.roleId,
          userId: ident.identity.userId,
          workspaceSource: ident.sources?.workspace || '',
          at: Date.now() / 1000,
        }
      }

      cache.delete(sid)
      // 上一步的回复已完整落进 assistant-stream：进入新步前先结算，别让证据过期被下一轮覆盖。
      settle(sessionId)

      const traceId = `${sid}:${Date.now()}`
      const rulesDir = resolveRuleRoot('', config)
      const agentsPath = agentsPathOf(rulesDir)

      // 1) 确认先于注入：本轮刚收录的规则应当立刻出现在本轮 context 里。
      const notices = []
      if (rulesOn) {
        const notice = await confirmTurn({
          sid, query, identity: ident.identity, traceId, rulesDir, identityInfo: ident.identity,
        })
        if (notice) notices.push(notice)
      }

      // 2) 作用域规则注入（global 不注入；AGENTS 缺标记时降级注入 global）。
      let rulesPrefix = ''
      if (rulesOn) {
        const got = getRulesPrefix({ identity: ident.identity, rulesDir, agentsPath })
        rulesPrefix = got.text
        if (got.keys.length) {
          log(`[whale-memory] rules inject keys=${got.keys.join(',')} chars=${got.chars} skipped=${got.skipped.length} cached=${got.cached}`)
        }
      }

      // 3) 召回（原逻辑不动：超时/中止/缓存/采纳登记都在这里）。
      let recallPrefix = ''
      if (recallOn && query) {
        const ac = new AbortController()
        inflight.add(ac)
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        try {
          const started = Date.now()
          const result = await backend.recall({
            query,
            maxHits: num(config?.recall?.maxHits, 5),
            charBudget: num(config?.recall?.charBudget, 1500),
            intentBudget: bool(config?.recall?.intentBudget, true),
            minRel: num(config?.recall?.minRel, 0.34),
            // 注入开关（审计 P1-1 假开关）：面板里的 injectLevels/showSources 必须真传到 backend，
            // 只在面板改字而 backend 不接，就是"写着能调、实际没实现"。
            injectLevels: injectLevels(),
            showSources: bool(config?.recall?.showSources, true),
            diffusion: bool(config?.edges?.diffusion, true),
            minConf: num(config?.edges?.minConf, 0.6),
            identity: ident.identity,
            traceId,
          }, ac.signal)
          if (result && typeof result.prefix === 'string' && result.prefix) {
            recallPrefix = result.prefix
            // 只有真正注入的召回才登记采纳待判（预算裁掉/零命中的行没有可采纳对象）。
            if (result.recallId) {
              pending.set(sid, { recallId: Number(result.recallId), nodes: result.injectedNodes || [] })
            }
            log(`[whale-memory] recall ok hits=${Number(result.hits || 0)} chars=${result.prefix.length} ms=${Date.now() - started}`)
          }
        } catch (err) {
          // 召回失败只丢召回：规则前缀与提示照常注入（fail-open 不等于整段失效）。
          log(`[whale-memory] recall fail-open: ${err?.name || err?.message || err}`)
        } finally {
          clearTimeout(timer)
          inflight.delete(ac)
        }
      }

      // 4) 合并：规则前缀在前（约束先于证据），召回在后；两者都空时不留空 entry。
      const parts = [rulesPrefix, recallPrefix, ...notices].filter(Boolean)
      if (parts.length) cache.set(sid, { text: parts.join('\n'), exp: Date.now() + CACHE_TTL_MS })

      // 5) 提案检测：召回之后、后台跑；仅有可裁定的人（owner 在聊天里）才问。
      if (rulesOn && query) offerProposal({ sid, query, identityInfo: ident.identity, traceId })
    } catch (err) {
      log(`[whale-memory] recall fail-open: ${err?.name || err?.message || err}`)
    }
    return decision
  }

  /** 回复侧文本增量：按 (turn, step) 累积，供结算时判「是否引用了注入节点」。 */
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (disposed) return
      const frame = payload?.frame
      const agent = payload?.agent
      if (!frame || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const sid = agent?.session?.id ?? agent?.id
      if (!sid) return
      const key = String(sid)
      const prev = replyBuf.get(key) || ''
      if (prev.length >= REPLY_BUF_MAX) return
      if (!prev) log(`[whale-memory] stream first delta turn=${frame.turn ?? '-'} step=${frame.step ?? '-'}`)
      replyBuf.set(key, (prev + chunk.text).slice(0, REPLY_BUF_MAX))
    } catch { /* 观测信号 fail-open，不影响流式回复 */ }
  })

  /** 回合关闭：结算该会话所有剩余待判条目，避免跨回合残留。 */
  const offStopping = ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      const sid = agent?.session?.id ?? agent?.id
      if (sid) settle(sid)
    } catch (err) {
      log(`[whale-memory] adoption settle fail-open: ${err?.name || err?.message || err}`)
    }
  })

  const offPre = ctx.on('agent/pre-step', onPreStep)
  const offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => {
    const sid = agent?.session?.id ?? agent?.id
    if (!sid) return
    cache.delete(String(sid))
    settle(sid)
  })

  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        if (disposed) return ''
        const sid = context?.scope?.session?.id ?? context?.agent?.session?.id
        return readCached(cache, sid)
      } catch { return '' }
    },
  }), 'whale-memory: recall context')

  const dispose = () => {
    disposed = true
    offPre?.()
    offDisposed?.()
    offStream?.()
    offStopping?.()
    for (const ac of inflight) { try { ac.abort() } catch { /* noop */ } }
    inflight.clear()
    cache.clear()
    pending.clear()
    replyBuf.clear()
  }
  return { cache, dispose, invalidateRulesCache }
}
