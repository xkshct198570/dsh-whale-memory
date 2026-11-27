// 职责：持久化写入队列（enqueue/drain/review）+ 判定器模型调用；依赖：../../shared/config-values.js + ../db.js + ../tokenize.js + ../judge.js + ./decide.js + ./audit.js + ./process.js + ./review.js；不 import 门面。
import { value } from '../../shared/config-values.js'
import { now } from '../db.js'
import { normalize } from '../tokenize.js'
import { buildJudgePrompt, mapCandidates, parseJudgeOutput } from '../judge.js'
import {
  TEXT_LIMIT, decideWrite, findCandidates, normalizeIdentity,
} from './decide.js'
import { withTx } from './audit.js'
import { processEvent } from './process.js'
import { acceptCandidate } from './review.js'
import { RETRY_MAX_ATTEMPTS, redactJobPayload } from '../job-payload.js'

/** 每批任务数（写连接上保持短事务，避免长阻塞）。 */
const BATCH = 20
/** 写 job 自身重试上限与退避（与 keeper 的 1m→5m→30m 同口径；写队列是唯一 owner）。
 *  上限值取 job-payload.RETRY_MAX_ATTEMPTS：终态判定与 keeper 共用同一判据。 */
const WRITE_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS
const WRITE_BACKOFF_SECONDS = [0, 60, 300, 1800]
/** 写队列只负责自己的 queued/到期重试，30s 扫一次足够，不抢 keeper 的 10min 语义。 */
const WRITE_RETRY_TICK_MS = 30_000
/** 判定器候选上限：只问最新的 N 条（提示词体积/token 成本的硬闸门，候选再多也只截最新）。 */
const JUDGE_CANDIDATE_LIMIT = 12
/** 判定器模型硬超时：单条超 2s 即回落规则，不拖住整批写入。 */
const JUDGE_TIMEOUT_MS = 2000

/**
 * 判定器模型调用：照 reflect.js 的 stream 收集口径（text-delta/block-end），
 * 外加 2s AbortController 硬超时（模型卡住不能拖住整批写入）。
 *
 * 非导出：只有队列用；测试通过 fake llm 端到端覆盖（见 writer.test.mjs）。
 *
 * @param {{ stream: Function }} llm
 * @param {{ provider?: string, model?: string } | null} selection
 * @param {string} prompt
 * @param {string} modelOverride write.model（非空即覆盖默认模型）
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
function collectJudgeText(llm, selection, prompt, modelOverride) {
  const provider = selection?.provider
  const model = modelOverride || selection?.model
  if (!provider || !model) return Promise.resolve({ ok: false, error: 'no_model' })
  return new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    const finish = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    const timer = setTimeout(() => {
      try { controller.abort() } catch { /* 已结束的 stream 再 abort 无害 */ }
      finish({ ok: false, error: 'timeout' })
    }, JUDGE_TIMEOUT_MS)
    void (async () => {
      let text = ''
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          temperature: 0,
          maxTokens: 200,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text += String(chunk.block.text || '')
        }
        finish({ ok: true, text })
      } catch {
        finish({ ok: false, error: 'llm_error' })
      }
    })()
  })
}

/**
 * 持久化写入队列（铁律 3：进程重启后不丢事件）。
 *
 * 为什么用 jobs 表而不是内存数组：事件入队即落盘，进程重启后 enqueue 的 Promise 自然消失，
 * 但 job 还在；下次 createWriteQueue 把遗留 running 复位 queued，drain 继续跑完。
 *
 * 判定器（judge=llm）：每条 job 处理前，在 DB 事务外取候选 → 无候选直接 ADD（不调模型）→
 * 有候选且 llm/selection 可用才问模型；解析失败/超时/模型缺失一律带 `judge_fallback:<why>`
 * 回落规则。模型调用从不进事务、单条失败只影响该条（job 仍按规则落库），整批照跑。
 *
 * @param {{
 *   store: { withDb: <T>(fn: (db: import('node:sqlite').DatabaseSync) => T) => T },
 *   config?: object|Function,
 *   log?: (line: string) => void,
 *   getLlm?: (() => any) | null,
 *   getSelection?: (() => { provider?: string, model?: string } | null) | null,
 * }} args
 * @returns {{
 *   enqueue: (event: object) => Promise<{ ok: boolean, id?: string, action: string, reason: string, duplicate?: boolean, judge?: object }>,
 *   drain: () => Promise<{ processed: number }>,
 *   review: (id: number|string, decision: 'accept'|'reject', reason?: string) => { ok: boolean, id?: string, error?: string },
 *   pending: () => number,
 *   dispose: () => void,
 * }}
 */
export function createWriteQueue({ store, config, log = () => {}, getLlm = null, getSelection = null } = {}) {
  if (!store || typeof store.withDb !== 'function') throw new TypeError('createWriteQueue: store.withDb required')
  const cfg = config || {}
  // config 可以是 getter：面板改 shadow/auto 后必须即时生效，不能在构造时冻结。
  const liveConfig = () => (typeof cfg === 'function' ? cfg() : cfg)
  const onDb = (fn) => store.withDb(fn)

  // 崩溃补偿：上一次进程死在 running 的 write job 重新排队（attempts 保留，便于观察重试次数）。
  // 队列是 write job 的唯一消费者；启动补偿由 index.js 初始化时调 drainWrites 触发。
  try {
    onDb((db) => db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE kind='write' AND state='running'").run(now()))
  } catch (err) {
    log(`[whale-memory] write queue reset failed: ${err?.message || err}`)
  }

  /** @type {Map<number, (result: any) => void>} */
  const waiters = new Map()
  /** waiter 入队时刻：跨 drain/跨进程兜底超时用（秒）。 */
  const waitSince = new Map()
  let draining = null
  let closed = false
  let waitSweeper = null
  let retryTimer = null
  /** 单条等待上限：超过即结算 TIMEOUT（面板写入不能无限悬挂）。 */
  const WAIT_TIMEOUT_MS = 120_000

  /** 把一条 job 的终态翻译成 enqueue 的返回形状。 */
  function settleFromRow(jobId, row) {
    const fail = { ok: false, action: 'FAILED', reason: String(row?.last_error || 'job_failed') }
    if (!row) return { ok: false, action: 'LOST', reason: 'job_row_missing' }
    if (row.state === 'failed') return fail
    let parsed = {}
    try { parsed = JSON.parse(String(row.payload || '{}')) || {} } catch { parsed = {} }
    const inner = parsed.result && typeof parsed.result === 'object' ? parsed.result : {}
    return { ...inner, ok: inner.ok === undefined ? row.state === 'done' : Boolean(inner.ok), action: String(inner.action || 'DONE') }
  }

  /**
   * 终态扫地机：本进程没处理到的 job（另一 drain/另一进程抢先）也必须结算 waiter。
   * 只在有 waiter 时开一个 interval，清空后自停；定时器 unref，不拖住宿主退出。
   */
  function ensureWaitSweep() {
    if (waitSweeper || closed) return
    waitSweeper = setInterval(() => {
      if (waiters.size === 0) {
        clearInterval(waitSweeper)
        waitSweeper = null
        return
      }
      for (const [jobId, resolve] of [...waiters]) {
        try {
          const row = onDb((db) => db.prepare('SELECT state,payload,last_error FROM jobs WHERE id=?').get(jobId))
          if (row && (row.state === 'done' || row.state === 'failed')) {
            waiters.delete(jobId)
            waitSince.delete(jobId)
            resolve(settleFromRow(jobId, row))
            continue
          }
          const started = waitSince.get(jobId) || 0
          if (started && Date.now() - started > WAIT_TIMEOUT_MS) {
            waiters.delete(jobId)
            waitSince.delete(jobId)
            resolve({ ok: false, action: 'TIMEOUT', reason: 'queue_wait_timeout' })
          }
        } catch {
          // 读库失败（锁/关闭）下一轮继续，不在这里把 waiter 判死。
        }
      }
    }, 1000)
    if (typeof waitSweeper.unref === 'function') waitSweeper.unref()
  }

  /** judge=llm 开关（兼容 Ref 与扁平 config；读不到一律按 rules）。 */
  const judgeEnabled = (live) => {
    try {
      const c = value(live)
      const w = value(c?.write)
      return String(value(w?.judge ?? '') || '') === 'llm'
    } catch {
      return false
    }
  }

  /**
   * 判定器裁决（模型调用绝不进 DB 事务：先 onDb 同步取候选，再在事务外问模型）。
   * 无候选返回 null（调用方直接走规则 ADD，不花模型钱）；其余失败返回 ok:false 的裁决，
   * 由 decideWrite 回落规则并在结果里带 `judge_fallback:<why>`。
   */
  async function judgeEvent(event, live) {
    const fallback = (why) => ({ ok: false, error: `judge_fallback:${why}` })
    let candidates
    try {
      candidates = onDb((db) => findCandidates(db, event))
    } catch {
      return fallback('candidates_unavailable')
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    const llm = typeof getLlm === 'function' ? getLlm() : null
    if (!llm || typeof llm.stream !== 'function') return fallback('llm_unavailable')
    const selection = typeof getSelection === 'function' ? getSelection() : null
    const writeSection = value(value(live)?.write)
    const modelOverride = String(value(writeSection?.model) ?? '')
    if (!selection?.provider || (!selection?.model && !modelOverride)) return fallback('no_model')
    const text = normalize(String(event?.text ?? ''))
    const { map, lines } = mapCandidates(candidates.slice(0, JUDGE_CANDIDATE_LIMIT))
    const out = await collectJudgeText(llm, selection, buildJudgePrompt(text, lines), modelOverride)
    if (!out.ok) return fallback(out.error || 'llm_error')
    const parsed = parseJudgeOutput(out.text, map)
    if (!parsed.ok) return fallback(parsed.error)
    return { ok: true, targetId: parsed.targetId, action: parsed.action, reason: parsed.reason }
  }

  /** 单批处理：置 running → processEvent → done/failed，单条失败不打断整批。 */
  async function runDrain() {
    let processed = 0
    for (;;) {
      if (closed) break
      let batch
      try {
        batch = onDb((db) => db.prepare(
          "SELECT id,payload,attempts FROM jobs WHERE kind='write' AND state='queued'"
          + " AND (next_at IS NULL OR next_at <= ?) ORDER BY next_at IS NOT NULL, next_at, id LIMIT " + BATCH,
        ).all(now()))
      } catch (err) {
        log(`[whale-memory] write queue read failed: ${err?.message || err}`)
        break
      }
      if (!Array.isArray(batch) || batch.length === 0) break

      for (const job of batch) {
        const jobId = Number(job.id)
        let event = {}
        try { event = JSON.parse(String(job.payload ?? '{}')) } catch { event = {} }
        let result
        let verdict = null
        try {
          onDb((db) => db.prepare("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=?")
            .run(now(), jobId))
          const live = liveConfig()
          if (judgeEnabled(live)) {
            try {
              verdict = await judgeEvent(event, live)
            } catch (err) {
              verdict = { ok: false, error: `judge_fallback:${String(err?.message || err)}` }
            }
          }
          const targetEvent = verdict ? { ...event, __judgeVerdict: verdict } : event
          result = onDb((db) => processEvent(db, targetEvent, live))
          if (result?.judge?.used) {
            log(`[whale-memory] judge used=true action=${result.judge.action} target=${result.judge.targetId ?? '-'}`)
          } else if (verdict) {
            log(`[whale-memory] judge fallback reason=${result?.judge?.error || verdict.error || 'unknown'}`)
          }
          // 终态同轮脱敏（0.8.1-01）：payload 只留白名单键（result/reason/追溯键），
          // 写事件正文（text/tags/ingestPolicy…）不再长期留在 jobs 里。
          const payload = redactJobPayload({
            ...event,
            result: {
              action: result.action, id: result.id ?? null, reason: result.reason ?? '',
              ...(result.judge ? { judge: result.judge } : {}),
            },
          })
          onDb((db) => db.prepare("UPDATE jobs SET state='done', payload=?, last_error=NULL, updated_at=? WHERE id=?")
            .run(payload, now(), jobId))
        } catch (err) {
          const reason = String(err?.message || err).slice(0, 300)
          result = { ok: false, action: 'FAILED', reason }
          try {
            const attempts = Math.max(0, Number(job.attempts || 0)) + 1
            if (attempts < WRITE_MAX_ATTEMPTS) {
              const delay = WRITE_BACKOFF_SECONDS[Math.min(attempts, WRITE_BACKOFF_SECONDS.length - 1)]
              onDb((db) => db.prepare(`UPDATE jobs SET state='queued', attempts=?, last_error=?, next_at=?, updated_at=?
                WHERE id=? AND state='running'`).run(attempts, reason, now() + delay, now(), jobId))
            } else {
              // 终态失败：正文脱敏；attempts 未到上限时 payload 原样保留（重跑要读事件）。
              onDb((db) => db.prepare(`UPDATE jobs SET state='failed', attempts=?, last_error=?, next_at=NULL, payload=?, updated_at=?
                WHERE id=? AND state='running'`).run(attempts, reason, redactJobPayload(job.payload), now(), jobId))
            }
          } catch (inner) {
            log(`[whale-memory] write queue retry/fail update failed: ${inner?.message || inner}`)
          }
        }
        processed += 1
        const resolver = waiters.get(jobId)
        if (resolver) {
          waiters.delete(jobId)
          waitSince.delete(jobId)
          // 调用方要知道"这是重复消息"（面板/对话侧可据此静默）
          const out = result.action === 'NOOP' && result.reason === 'duplicate'
            ? { ...result, duplicate: true }
            : result
          resolver(out)
        }
      }
      if (batch.length < BATCH) break
      // 满批后让出事件循环，避免长队列霸占主线程（写入在下一批继续）
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { processed }
  }

  /** 到期重试的兜底扫描：只处理自身 queued 行，不依赖 keeper。 */
  function ensureRetryTimer() {
    if (retryTimer || closed) return
    retryTimer = setInterval(() => {
      if (closed) return
      try {
        const due = Number(onDb((db) => db.prepare(
          "SELECT count(*) AS n FROM jobs WHERE kind='write' AND state='queued' AND (next_at IS NULL OR next_at <= ?)",
        ).get(now())?.n || 0))
        if (due > 0) drain().catch((err) => log(`[whale-memory] write queue retry drain failed: ${err?.message || err}`))
      } catch (err) {
        log(`[whale-memory] write queue retry scan failed: ${err?.message || err}`)
      }
    }, WRITE_RETRY_TICK_MS)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  ensureRetryTimer()

  /** 单飞：并发 drain 返回同一个 Promise。 */
  function drain() {
    if (closed) return Promise.resolve({ processed: 0 })
    if (draining) return draining
    draining = runDrain().finally(() => { draining = null })
    return draining
  }

  /** 入队：先落盘再返回 Promise；该 job 处理完（done/failed）时 resolve。 */
  function enqueue(event) {
    if (closed) return Promise.resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    const payload = JSON.stringify(event ?? {})
    let jobId
    try {
      jobId = Number(onDb((db) => db.prepare(
        'INSERT INTO jobs (kind,state,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ).run('write', 'queued', 0, payload, now(), now()).lastInsertRowid))
    } catch (err) {
      return Promise.resolve({ ok: false, action: 'REJECT', reason: `queue_insert_failed:${err?.message || err}` })
    }
    const promise = new Promise((resolve) => {
      waiters.set(jobId, resolve)
      waitSince.set(jobId, Date.now())
    })
    ensureWaitSweep()
    setImmediate(() => { drain().catch((err) => log(`[whale-memory] write queue drain failed: ${err?.message || err}`)) })
    return promise
  }

  /**
   * 审核候选（writes 行 action='CANDIDATE'）。
   * accept：读 writes.payload 还原等级/类型/tags/source/expired_at，并按 shadowOf 执行动作
   *   （ADD/REVIEW 插新节点，MERGE 改目标正文，SUPERSEDE 插新节点并让旧节点失效）；
   *   origin 保留候选原始来源（payload.origin）；旧候选无 origin 时回落 'shadow-review'。
   * reject：审计行改 REJECT，reason 追加 review:reject[:理由]。
   *
   * @param {number|string} id writes 行 id
   * @param {'accept'|'reject'} decision
   * @param {string} [reason] 驳回理由（≤200 由路由截断）
   * @param {{ identity?: { userId?: string, roleId?: string, workspace?: string } }} [opts]
   *   identity：审核人所在分区；给出时只允许审核同分区候选（跨分区 id 直给 404）。
   * @returns {{ ok: boolean, id?: string, error?: string }}
   */
  function review(id, decision, reason, opts = {}) {
    const action = String(decision ?? '')
    if (action !== 'accept' && action !== 'reject') return { ok: false, error: 'invalid_decision' }
    const writeId = Number(id)
    if (!Number.isInteger(writeId)) return { ok: false, error: 'candidate_not_found' }
    const ident = normalizeIdentity(opts?.identity)
    const scoped = Boolean(opts?.identity)
    try {
      return onDb((db) => {
        const row = db.prepare(
          `SELECT id,trace_id,action,reason,after_text,mode,payload,user_id,role_id,workspace FROM writes
           WHERE id=? AND action='CANDIDATE'${scoped ? ' AND user_id=? AND role_id=? AND workspace=?' : ''}`,
        ).get(writeId, ...(scoped ? [ident.userId, ident.roleId, ident.workspace] : []))
        if (!row) return { ok: false, error: 'candidate_not_found' }

        if (action === 'reject') {
          const extra = `review:reject${reason ? ':' + String(reason) : ''}`
          const previous = String(row.reason ?? '').trim()
          db.prepare("UPDATE writes SET action='REJECT', reason=? WHERE id=?")
            .run(previous ? `${previous} · ${extra}` : extra, writeId)
          return { ok: true }
        }

        let payload = {}
        try { payload = JSON.parse(String(row.payload ?? '{}')) || {} } catch { payload = {} }
        const text = normalize(String(row.after_text ?? ''))
        if (!text || text.length > TEXT_LIMIT) return { ok: false, error: 'invalid_text' }
        return withTx(db, () => acceptCandidate(db, row, text, payload, String(payload.shadowOf || 'ADD'), writeId))
      })
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  /** 待处理 job 数（queued + running）。 */
  function pending() {
    if (closed) return 0
    try {
      return Number(onDb((db) => db.prepare(
        "SELECT count(*) AS n FROM jobs WHERE kind='write' AND state IN ('queued','running')",
      ).get()?.n || 0))
    } catch {
      return 0
    }
  }

  /** 释放内存态（不动库：未完成的 job 留给下次启动继续）。 */
  function dispose() {
    closed = true
    if (waitSweeper) { clearInterval(waitSweeper); waitSweeper = null }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
    for (const resolve of waiters.values()) resolve({ ok: false, action: 'REJECT', reason: 'queue_disposed' })
    waiters.clear()
    waitSince.clear()
  }

  return { enqueue, drain, review, pending, dispose }
}
