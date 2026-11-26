/**
 * 会话材料采集与收尾触发（Session Wrap 的 Host 侧入口）。
 *
 * 职责边界（铁律 2/10）：本模块只做「有界缓冲 + 事件→触发」的接线，不含提炼/写库/报告逻辑。
 * 提炼契约在 core/distill.js，运行编排在 host/session-wrap.js；任何领域词表都在 core/wrap-intent.js。
 *
 * 材料口径（为什么这样切）：
 * - 只收 `session/event` 的 owner 直发消息与 assistant 文本块：这是模型已提交的持久事实，
 *   不重新拼 assistant-stream（流式帧没有「这一步最终回复」的稳定身份，会重复/丢半句）。
 * - 不收工具调用/工具结果/思考过程：wrap 要沉淀的是「结论与教训」，不是原始工具输出；
 *   工具输出体积大、含密钥/整段文件，写进模型提示词既贵又危险。
 * - 每会话最多 20 轮 / 12k 码点；按**整轮**裁剪（user+assistant 成组），不把问答拆散。
 * - 消息在入缓冲前先过 privacyCheck（同 write 路径的脱敏口径）；只有在用户显式关闭
 *   `privacy.redact` 时才不脱敏——与普通写入的开关语义一致，不是本模块另开的口子。
 *
 * 触发（优先级：显式 > 空闲 > disposed）：
 * - 显式：pre-step 只做确定性意图判定并记 pendingIntent；turn-stopping 时入队（不阻塞回复）。
 * - 空闲：60s tick；无进行中的 turn、有材料、超过 idleMinutes 才触发；同材料 hash 不重复触发。
 * - disposed：会话被移除时 flush；失败只记日志，不阻塞宿主 dispose。
 * - 子代理会话（header.origin==='subagent'）根本不进缓冲：它没有可裁定的 owner。
 */

import { privacyCheck } from '../core/writer.js'
import { detectWrapIntent } from '../core/wrap-intent.js'
import { materialHash, normalizeMaterial } from '../core/wrap-material.js'
import { bool, num } from '../shared/config-values.js'
import { projectSessions } from './session-capture/sessions.js'

/** 单条消息缓冲上限（码点）：一次长粘贴不应挤掉整轮对话。 */
const MAX_MESSAGE_CHARS = 2000
/** pendingIntent 有效期：用户说了“收尾”却继续聊，超过这个时间不再自动入队。 */
const PENDING_INTENT_TTL_MS = 10 * 60 * 1000

/** 取消息里的文本块（不含思考/工具调用）。非数组内容一律忽略。 */
export function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 截断到 max 码点（不切坏代理对）；超长加省略号。 */
export function clampCodePoints(text, max = MAX_MESSAGE_CHARS) {
  const chars = Array.from(String(text ?? '').trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * 按整轮裁剪缓冲：先留最近 maxTurns 轮，再按字数从最旧整轮丢弃。
 * 单轮超预算时保留最后一轮（否则材料可能全空，等于永远不触发）。
 *
 * @param {Array<{turn:number, seqTo:number, user:string, assistants:string[]}>} groups
 * @param {{ maxTurns?:number, maxChars?:number }} [opts]
 * @returns {Array<object>} 新数组
 */
export function trimTurnGroups(groups, { maxTurns = 20, maxChars = 12000 } = {}) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && (g.user || (Array.isArray(g.assistants) && g.assistants.length)))
  let kept = list.slice(Math.max(0, list.length - Math.max(1, maxTurns)))
  const charsOf = (g) => {
    let n = Array.from(String(g.user || '')).length
    for (const a of g.assistants || []) n += Array.from(String(a || '')).length
    return n
  }
  let total = kept.reduce((sum, g) => sum + charsOf(g), 0)
  while (kept.length > 1 && total > maxChars) {
    total -= charsOf(kept[0])
    kept = kept.slice(1)
  }
  return kept
}

/** 当前配置（Ref 解包统一走 config-values，禁止裸比较）。 */
function wrapCfg(config) {
  const w = config?.wrap || {}
  return {
    enabled: bool(w.enabled, true),
    explicit: bool(w.explicit, true),
    idle: bool(w.idle, true),
    disposed: bool(w.disposed, true),
    idleMinutes: num(w.idleMinutes, 10),
    maxRunsPerDay: num(w.maxRunsPerDay, 6),
    maxTurns: 20,
    maxChars: num(w.maxMaterialChars, 12000),
    redact: bool(config?.privacy?.redact, true),
  }
}

/**
 * 安装采集器。
 *
 * @param {{ on:Function, effect?:Function }} ctx 宿主上下文（只用到事件总线）
 * @param {{
 *   config:any, log?:(line:string)=>void,
 *   getIdentity:(header:any)=> {ok:boolean, identity?:{userId:string,roleId:string,workspace:string}, error?:string},
 *   onTrigger:(input:{sessionId:string,trigger:string,material:any,identity:any,header:any,
 *     hash:string,now:number}) => Promise<{ok:boolean,reason?:string,runId?:number,existing?:boolean}>,
 *   canTriggerAuto?:() => {ok:boolean,reason?:string},
 *   now?:()=>number, idleTickMs?:number, maxSessions?:number,
 *   maxTurns?:number, maxChars?:number,
 * }} deps
 * @returns {{ flush:(sid:string,trigger:string,opts?:{force?:boolean})=>Promise<object>,
 *   triggerRecent:(trigger:string)=>Promise<object>, advance:(sid:string,throughSeq:number)=>void,
 *   status:()=>object, tick:()=>Promise<object>, dispose:()=>void }}
 */
export function installSessionCapture(ctx, {
  config, log = () => {}, getIdentity, onTrigger,
  canTriggerAuto = () => ({ ok: true }),
  now = () => Date.now(), idleTickMs = 60_000, maxSessions = 64,
  maxTurns = 20, maxChars = 12000, redact = true,
} = {}) {
  if (typeof onTrigger !== 'function') throw new TypeError('installSessionCapture: onTrigger required')
  const sessions = new Map()
  let disposed = false
  let timer = null
  let runningFlush = 0
  let lastSkip = null
  /** 会话表淘汰计数（有界兜底的可观测证据：不是静默丢材料）。 */
  const evicted = { material: 0, openTurn: 0, flushed: 0 }

  const cfgNow = () => {
    const c = wrapCfg(config)
    return { ...c, maxTurns: Math.max(1, Number(maxTurns) || c.maxTurns), maxChars: Math.max(1000, Number(maxChars) || c.maxChars), redact: redact !== false && c.redact }
  }

  const idOf = (session) => String(session?.id || session?.session?.id || '')

  function ensure(session) {
    const sid = idOf(session)
    if (!sid) return null
    const header = session?.header || {}
    if (header.origin === 'subagent') return null
    let rec = sessions.get(sid)
    if (!rec) {
      rec = {
        id: sid, header, groups: [], lastActivity: now(), openTurns: new Set(),
        turn: 0, pendingIntent: null, lastTriggeredHash: '', lastTriggeredAt: 0,
      }
      sessions.set(sid, rec)
      // 有界会话表：超上限时淘汰最久未活动者。有材料且无 open turn 的会话先尽力入队一次
      // 再移除（异步 flushSnapshot 在 await 前已同步取好快照）；空会话直接删。
      const cap = Math.max(8, Number(maxSessions) || 64)
      if (sessions.size > cap) {
        const victims = [...sessions.values()]
          .filter((item) => item !== rec)
          .sort((a, b) => (a.openTurns.size > 0 ? 1 : 0) - (b.openTurns.size > 0 ? 1 : 0)
            || a.lastActivity - b.lastActivity)
        let flushedOnce = false
        while (sessions.size > cap && victims.length > 0) {
          const victim = victims.shift()
          if (victim.groups.length > 0) {
            if (victim.openTurns.size > 0) {
              evicted.openTurn += 1
              log(`[whale-memory] wrap session evicted with open turn: ${victim.id}`)
            } else if (!flushedOnce && cfgNow().enabled && cfgNow().idle) {
              // 每次淘汰最多 flush 一个：避免一次涌入 30+ 会话时同步做 30+ 次快照/入队；
              // 其余有材料会话计入 evicted.material，status 可见（不静默）。
              flushedOnce = true
              evicted.flushed += 1
              try {
                void flushSnapshot(victim, 'idle').catch((err) => log(`[whale-memory] wrap evict flush fail-open: ${err?.message || err}`))
              } catch { /* 淘汰是兜底，不能让事件路径抛 */ }
            } else {
              evicted.material += 1
            }
          }
          sessions.delete(victim.id)
        }
      }
    } else if (session?.header && rec.header !== session.header) {
      rec.header = session.header
    }
    return rec
  }

  function appendText(rec, role, text, turn, seq) {
    const clean = clampCodePoints(text)
    if (!clean) return
    const checked = cfgNow().redact ? privacyCheck(clean, { redact: true }) : { ok: true, text: clean }
    const value = checked.text
    if (role === 'user') {
      rec.groups.push({ turn: Number(turn) || rec.turn || 0, seqFrom: Number(seq) || 0, seqTo: Number(seq) || 0, user: value, assistants: [] })
    } else {
      const last = rec.groups[rec.groups.length - 1]
      if (last && last.turn === (Number(turn) || rec.turn) && last.user) {
        last.assistants.push(value)
        if (Number(seq) > last.seqTo) last.seqTo = Number(seq)
      } else {
        rec.groups.push({
          turn: Number(turn) || rec.turn || 0, seqFrom: Number(seq) || 0, seqTo: Number(seq) || 0,
          user: '', assistants: [value],
        })
      }
    }
    rec.groups = trimTurnGroups(rec.groups, cfgNow())
  }

  const onEvent = (session, event) => {
    if (disposed || !event || typeof event.type !== 'string') return
    const rec = ensure(session)
    if (!rec) return
    rec.lastActivity = now()
    const data = event.data || {}
    try {
      switch (event.type) {
        case 'turn/start':
          if (Number.isFinite(Number(data.turn))) rec.turn = Number(data.turn)
          rec.openTurns.add(Number(data.turn))
          break
        case 'turn/end':
          rec.openTurns.delete(Number(data.turn))
          break
        case 'user/message': {
          // 只认直发人类消息：source.kind==='user'。agent.inject / goal / schedule 的
          // user-role 消息 source.kind 是各自的类型，混进来会污染“本轮是谁在说”。
          if (data?.source?.kind !== 'user') break
          const text = messageText(data.content)
          if (text) appendText(rec, 'user', text, rec.turn, event.seq)
          break
        }
        case 'assistant/message': {
          const text = messageText(data?.message?.content)
          if (text) appendText(rec, 'assistant', text, data.turn, event.seq)
          break
        }
        default:
          break
      }
    } catch (err) {
      log(`[whale-memory] wrap capture fail-open: ${err?.message || err}`)
    }
  }

  /** 取最后一条 owner 直发用户文本（pre-step 的 messages 是构造请求用的快照）。 */
  function lastUserText(messages) {
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (!m || m?.source?.kind !== 'user') continue
      return messageText(m.content)
    }
    return ''
  }

  const onPreStep = async (payload, next) => {
    const decision = await next()
    try {
      if (disposed || decision?.kind !== 'enter') return decision
      const session = payload?.agent?.session
      if (!session || session?.header?.origin === 'subagent') return decision
      const rec = ensure(session)
      if (!rec) return decision
      rec.lastActivity = now()
      const cfg = cfgNow()
      if (!cfg.enabled || !cfg.explicit) return decision
      const text = lastUserText(payload?.messages)
      if (!text) return decision
      const intent = detectWrapIntent(text)
      rec.pendingIntent = intent.match
        ? { text: text.slice(0, 200), phrase: intent.phrase || '', at: now(), turn: rec.turn }
        : null
    } catch (err) {
      log(`[whale-memory] wrap intent fail-open: ${err?.message || err}`)
    }
    return decision
  }

  const onTurnStopping = ({ agent } = {}) => {
    try {
      if (disposed) return
      const session = agent?.session
      const sid = idOf(session)
      if (!sid) return
      const rec = sessions.get(sid)
      if (!rec) return
      rec.lastActivity = now()
      const cfg = cfgNow()
      const pending = rec.pendingIntent
      if (!pending || !cfg.enabled || !cfg.explicit) return
      if (now() - pending.at > PENDING_INTENT_TTL_MS) { rec.pendingIntent = null; return }
      if (rec.flushingExplicit) return
      // 成功/明确关闭才消费意图；入队失败保留 pending，下一回合仍可重试（审查 P2：不能只留日志）。
      rec.flushingExplicit = true
      void flush(sid, 'explicit')
        .then((out) => {
          if (out?.ok || out?.reason === 'wrap_disabled') rec.pendingIntent = null
          else rec.lastTriggerError = { at: now(), trigger: 'explicit', reason: String(out?.reason || 'unknown') }
        })
        .catch((err) => {
          rec.lastTriggerError = { at: now(), trigger: 'explicit', reason: String(err?.message || err).slice(0, 160) }
          log(`[whale-memory] wrap explicit fail-open: ${err?.message || err}`)
        })
        .finally(() => { rec.flushingExplicit = false })
    } catch (err) {
      log(`[whale-memory] wrap stopping fail-open: ${err?.message || err}`)
    }
  }

  const onSessionDisposed = (session) => {
    try {
      if (disposed) return
      const sid = idOf(session)
      if (!sid) return
      const rec = sessions.get(sid)
      if (!rec) return
      const cfg = cfgNow()
      const trigger = rec.pendingIntent && cfg.explicit ? 'explicit' : 'disposed'
      rec.pendingIntent = null
      sessions.delete(sid)
      if (!cfg.enabled || !cfg.disposed) return
      // disposed 是同步事件：异步入队不阻塞关闭；失败只留日志（没有可回滚的宿主行为）。
      void flushSnapshot(rec, trigger).catch((err) => log(`[whale-memory] wrap disposed fail-open: ${err?.message || err}`))
    } catch (err) {
      log(`[whale-memory] wrap disposed fail-open: ${err?.message || err}`)
    }
  }

  function snapshotOf(rec) {
    const turns = []
    // 配置可能在缓冲期间调小：快照前再按当前预算裁一次（仍按整轮），保证送进模型的材料不超上限。
    for (const group of trimTurnGroups(rec.groups, cfgNow())) {
      if (group.user) turns.push({ role: 'user', text: group.user, turn: group.turn, seq: group.seqFrom })
      for (const text of group.assistants) turns.push({ role: 'assistant', text, turn: group.turn, seq: group.seqTo })
    }
    const material = normalizeMaterial({ turns })
    material.seqTo = rec.groups.reduce((max, g) => Math.max(max, Number(g.seqTo) || 0), 0)
    material.turnsCount = rec.groups.length
    return { material, hash: materialHash(material), header: rec.header }
  }

  async function flushSnapshot(rec, trigger, { force = false } = {}) {
    const snapshot = snapshotOf(rec)
    if (!snapshot.hash) return { ok: false, reason: 'no_material' }
    if (!force && rec.lastTriggeredHash === snapshot.hash
      && now() - rec.lastTriggeredAt < 60 * 60 * 1000) {
      return { ok: false, reason: 'same_material' }
    }
    const ident = getIdentity(rec.header)
    if (!ident || ident.ok === false) return { ok: false, reason: ident?.error || 'identity_required' }
    runningFlush += 1
    try {
      const out = await onTrigger({
        sessionId: rec.id, trigger, material: snapshot.material, identity: ident.identity,
        header: rec.header, hash: snapshot.hash, now: now(),
      })
      if (out?.ok) {
        rec.lastTriggeredHash = snapshot.hash
        rec.lastTriggeredAt = now()
      }
      return out || { ok: false, reason: 'no_result' }
    } finally {
      runningFlush -= 1
    }
  }

  /** 对外：某个会话入队（面板/测试显式调用）。 */
  async function flush(sid, trigger = 'manual', opts = {}) {
    const rec = sessions.get(String(sid))
    if (!rec) return { ok: false, reason: 'no_session' }
    const cfg = cfgNow()
    if (!cfg.enabled) return { ok: false, reason: 'wrap_disabled' }
    // 手动收尾允许在回合进行中排队：材料是“此刻快照”（含已提交的 user/assistant 文本），
    // 由队列稍后执行；不再用 turn_in_progress 拒绝点击（S1b 后置语义，2026-11-26 厂长反馈）。
    return flushSnapshot(rec, trigger, opts)
  }

  /** 面板「立即收尾」：取最近有材料且无进行中 turn 的会话。 */
  async function triggerRecent(trigger = 'manual') {
    const candidates = [...sessions.values()]
      .filter((rec) => rec.groups.length > 0)
      .sort((a, b) => b.lastActivity - a.lastActivity)
    if (candidates.length === 0) return { ok: false, reason: 'no_material' }
    // 取“最近且已结束回合”的会话；最近那个正好在跑工具不应挡住别的可收尾会话（审查 P2）。
    const closed = candidates.filter((rec) => rec.openTurns.size === 0)
    // 手动：没有“已结束回合”的会话时，允许取最近一条进行中的会话做快照入队；
    // 自动触发不走这里（tick 自己跳过 open turn），所以不会在空闲时误收半轮。
    const pick = closed[0] || (trigger === 'manual' ? candidates[0] : null)
    if (!pick) return { ok: false, reason: 'turn_in_progress' }
    const cfg = cfgNow()
    if (!cfg.enabled) return { ok: false, reason: 'wrap_disabled' }
    return flushSnapshot(pick, trigger, { force: true })
  }

  /**
   * 一次 wrap 成功后才推进缓冲：失败/跳过保留材料，手动重试还有机会。
   * @param {string} sid @param {number} throughSeq
   */
  function advance(sid, throughSeq) {
    const rec = sessions.get(String(sid))
    if (!rec) return
    const cut = Number(throughSeq) || 0
    if (cut <= 0) return
    rec.groups = trimTurnGroups(rec.groups.filter((g) => Number(g.seqTo) > cut), cfgNow())
    // 已推进的材料允许下一次空闲重新按新 hash 触发；旧 hash 不再用于去重。
    rec.lastTriggeredHash = ''
  }

  async function tick() {
    if (disposed) return { triggered: 0, skipped: 'disposed' }
    const cfg = cfgNow()
    if (!cfg.enabled || !cfg.idle) return { triggered: 0, skipped: 'disabled' }
    const idleMs = Math.max(1, cfg.idleMinutes) * 60_000
    const gate = canTriggerAuto()
    if (gate && gate.ok === false) return { triggered: 0, skipped: gate.reason || 'auto_blocked' }
    let triggered = 0
    const skipped = []
    for (const rec of sessions.values()) {
      if (rec.openTurns.size > 0 || rec.groups.length === 0) continue
      if (now() - rec.lastActivity < idleMs) continue
      const out = await flushSnapshot(rec, 'idle')
      if (out?.ok) triggered += 1
      else if (out?.reason && out.reason !== 'same_material') skipped.push(out.reason)
    }
    if (skipped.length) lastSkip = { at: now(), reasons: [...new Set(skipped)] }
    return { triggered, skipped: skipped.length ? lastSkip.reasons : undefined }
  }

  /**
   * 面板会话列表：只暴露 id/活动时间/可收尾轮数/是否进行中；不含正文、标题、cwd。
   * @returns {Array<object>}
   */
  function listSessions() {
    return projectSessions(sessions.values())
  }

  function status() {
    const list = [...sessions.values()]
    return {
      sessions: sessions.size,
      material: list.filter((rec) => rec.groups.length > 0).length,
      pendingIntents: list.filter((rec) => rec.pendingIntent).length,
      runningFlush,
      lastSkip,
      evicted: { ...evicted },
      lastTriggerError: list
        .map((rec) => rec.lastTriggerError)
        .filter(Boolean)
        .sort((a, b) => b.at - a.at)[0] || null,
    }
  }

  // 订阅必须走 ctx.on（宿主事件总线）；listener 异常一律在本模块内兜住，不影响对话。
  const offs = []
  for (const [event, fn] of [
    ['session/event', onEvent],
    ['session/disposed', onSessionDisposed],
    ['agent/pre-step', onPreStep],
    ['agent/turn-stopping', onTurnStopping],
  ]) {
    try { offs.push(ctx.on(event, fn)) } catch (err) { log(`[whale-memory] wrap subscribe ${event} failed: ${err?.message || err}`) }
  }

  timer = setInterval(() => { void tick().catch((err) => log(`[whale-memory] wrap idle tick fail-open: ${err?.message || err}`)) }, Math.max(1000, Number(idleTickMs) || 60_000))
  if (typeof timer.unref === 'function') timer.unref()

  const dispose = () => {
    disposed = true
    if (timer) { clearInterval(timer); timer = null }
    for (const off of offs) { try { off?.() } catch { /* noop */ } }
    sessions.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose(), 'whale-memory: session capture')

  return { flush, triggerRecent, advance, listSessions, status, tick, dispose }
}
