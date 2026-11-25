/**
 * Session Wrap 运行台账（schema v5 `wrap_runs`）的唯一读写入口。
 *
 * 为什么要独立模块：wrap 的业务状态（候选/提案/报告/清洁/可切会话）与 jobs 的调度状态
 * （queued/running/done/failed + 退避重试）生命周期不同。一次 run 可能被重排成多个 job；
 * 把业务字段塞进 jobs.payload 会让面板、审计、续跑都要解 JSON，且 jobs 的清理会误删证据。
 *
 * 状态机：queued → running → done | failed | skipped。
 * - `skipped` 是**有明确原因的正常终态**（无模型/无素材/写开关关），不是失败；
 * - 崩溃窗口：handler 先落盘 distilled_json 再写候选，重试从断点续跑（见 phase）。
 * - 幂等键 (session_id, material_hash)：同会话同材料只一行；显式/手动重试只重置这一行。
 *
 * 本模块只做 SQL，不调模型、不写文件、不碰 jobs。
 */

/** 允许写入的列白名单：updateRun 不接受调用方拼列名（防 SQL 注入与误改幂等键）。 */
const UPDATABLE = new Set([
  'state', 'trigger', 'job_id', 'attempts', 'phase', 'summary', 'distilled_json',
  'candidates', 'rule_proposals', 'open_loops', 'report_path', 'hygiene_json',
  'switch_ready_json', 'error', 'updated_at',
])

const STATES = new Set(['queued', 'running', 'done', 'failed', 'skipped'])

/** 本地自然日零点（秒）：面板按用户日历看“今日收尾次数”，不能用 UTC 切日。 */
function localDayStart(nowSec) {
  const d = new Date(Number(nowSec) * 1000)
  d.setHours(0, 0, 0, 0)
  return d.getTime() / 1000
}

function textOf(value, max = 500) {
  return String(value ?? '').slice(0, max)
}

/** JSON 列安全解码：坏 JSON 返回 null，不让读路径抛。 */
function decodeJson(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把 DB 行解码成面板/服务可直接用的对象（JSON 列已解析）。
 * @param {object|null} row
 * @returns {object|null}
 */
export function decodeRun(row) {
  if (!row) return null
  return {
    ...row,
    id: Number(row.id),
    job_id: row.job_id === null || row.job_id === undefined ? null : Number(row.job_id),
    attempts: Number(row.attempts || 0),
    candidates: Number(row.candidates || 0),
    rule_proposals: Number(row.rule_proposals || 0),
    open_loops: Number(row.open_loops || 0),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    distilled: decodeJson(row.distilled_json),
    hygiene: decodeJson(row.hygiene_json),
    switchReady: decodeJson(row.switch_ready_json),
  }
}

/**
 * 读一条 run。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @returns {object|null}
 */
export function getRun(db, id) {
  const row = db.prepare('SELECT * FROM wrap_runs WHERE id=?').get(Number(id))
  return decodeRun(row)
}

/**
 * 按幂等键找 run。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {string} materialHash
 * @returns {object|null}
 */
export function findRun(db, sessionId, materialHash) {
  // v6 去掉了表级 UNIQUE：同 session+hash 允许多行（失败重试耗尽后新建），取最近一行判幂等。
  const row = db.prepare('SELECT * FROM wrap_runs WHERE session_id=? AND material_hash=? ORDER BY id DESC LIMIT 1')
    .get(textOf(sessionId, 200), textOf(materialHash, 64))
  return decodeRun(row)
}

/**
 * 创建（或按规则重置）一次 run。
 *
 * 重置语义（只在调用方明确允许时）：
 * - queued/running：返回现有行，不重复建 job（幂等）；
 * - done：返回现有行，**绝不重跑**（同材料已成功）；
 * - failed/skipped：reset=true 时把同一行改回 queued，保留已蒸馏断点（distilled_json）与报告字段，
 *   避免手动重试把模型再烧一遍；reset=false 时原样返回（自动触发不得复活终态）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId:string, materialHash:string, trigger:string,
 *   identity?:{userId?:string,roleId?:string,workspace?:string}, now:number,
 *   reset?:boolean }} input
 * @returns {{ ok:boolean, run:object|null, created:boolean, active:boolean, done:boolean,
 *   reset:boolean, error?:string }}
 */
export function createRun(db, {
  sessionId, materialHash, trigger, identity = {}, now, reset = false, maxAttempts = 4,
} = {}) {
  const sid = textOf(sessionId, 200)
  const hash = textOf(materialHash, 64)
  if (!sid || !hash) return { ok: false, run: null, created: false, active: false, done: false, reset: false, error: 'invalid_key' }
  const ts = Number(now) || Date.now() / 1000
  const ident = {
    userId: textOf(identity.userId, 128),
    roleId: textOf(identity.roleId, 64),
    workspace: textOf(identity.workspace, 64),
  }
  const insert = () => db.prepare(`INSERT INTO wrap_runs
    (session_id,material_hash,state,trigger,user_id,role_id,workspace,created_at,updated_at)
    VALUES (?,?,'queued',?,?,?,?,?,?)`).run(
    sid, hash, textOf(trigger, 32) || 'manual', ident.userId, ident.roleId, ident.workspace, ts, ts,
  )
  const existing = findRun(db, sid, hash)
  if (!existing) {
    const info = insert()
    const run = getRun(db, Number(info.lastInsertRowid))
    return { ok: true, run, created: true, active: true, done: false, reset: false }
  }

  if (existing.state === 'queued' || existing.state === 'running') {
    return { ok: true, run: existing, created: false, active: true, done: false, reset: false }
  }
  if (existing.state === 'done') {
    return { ok: true, run: existing, created: false, active: false, done: true, reset: false }
  }
  if (!reset) {
    return { ok: true, run: existing, created: false, active: false, done: false, reset: false }
  }

  // S2 判据（总纲 §5.2）：失败且 attempts 已耗尽 → 新建 run（新 runId），历史行保留可回溯；
  // attempts 未耗尽时重置同一行，继续享用已蒸馏断点，不重复烧模型。
  if (existing.state === 'failed' && Number(existing.attempts || 0) >= Math.max(1, Number(maxAttempts) || 4)) {
    const info = insert()
    const run = getRun(db, Number(info.lastInsertRowid))
    return { ok: true, run, created: true, active: true, done: false, reset: false, exhausted: true }
  }

  // 终态重试：保留 phase/distilled_json（若已蒸馏），清掉错误与 job 指针，attempts 归零重新拿预算。
  // 不清 candidates/rule_proposals：它们是已完成的写入证据；续跑按 distilled items 的 status 跳过。
  db.prepare(`UPDATE wrap_runs SET state='queued', trigger=?, job_id=NULL, attempts=0,
    error='', updated_at=? WHERE id=?`).run(textOf(trigger, 32) || 'manual', ts, existing.id)
  return { ok: true, run: getRun(db, existing.id), created: false, active: true, done: false, reset: true }
}

/**
 * 更新 run 的允许列（白名单）。state 值非法直接拒绝，避免写坏 CHECK 后整条更新失败却无人可见。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @param {object} patch
 * @returns {{ ok:boolean, run?:object, error?:string }}
 */
export function updateRun(db, id, patch = {}) {
  const fields = []
  const params = []
  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE.has(key)) continue
    if (key === 'state' && !STATES.has(String(value))) return { ok: false, error: 'invalid_state' }
    fields.push(`${key}=?`)
    params.push(key === 'distilled_json' || key === 'hygiene_json' || key === 'switch_ready_json'
      ? (value === null || value === undefined ? null : JSON.stringify(value))
      : value)
  }
  if (fields.length === 0) return { ok: false, error: 'no_fields' }
  if (!Object.prototype.hasOwnProperty.call(patch, 'updated_at')) {
    fields.push('updated_at=?')
    params.push(Date.now() / 1000)
  }
  params.push(Number(id))
  const info = db.prepare(`UPDATE wrap_runs SET ${fields.join(', ')} WHERE id=?`).run(...params)
  if (Number(info?.changes || 0) === 0) return { ok: false, error: 'not_found' }
  return { ok: true, run: getRun(db, id) }
}

/**
 * 开始一次执行：state=running、attempts+1、清空上次错误。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @param {number} now
 * @returns {object|null} 最新行
 */
export function markRunAttempt(db, id, now = Date.now() / 1000) {
  db.prepare(`UPDATE wrap_runs SET state='running', attempts=attempts+1, error='', updated_at=?
    WHERE id=?`).run(Number(now), Number(id))
  return getRun(db, id)
}

/**
 * 最近一次 run（面板概览）。identity 非空时只返回同分区，避免把别人会话的计数展示出去。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ identity?:{userId?:string,roleId?:string,workspace?:string} }} [opts]
 * @returns {object|null}
 */
export function latestRun(db, { identity = null } = {}) {
  if (identity && typeof identity === 'object') {
    const row = db.prepare(`SELECT * FROM wrap_runs WHERE user_id=? AND role_id=? AND workspace=?
      ORDER BY id DESC LIMIT 1`).get(
      textOf(identity.userId, 128), textOf(identity.roleId, 64), textOf(identity.workspace, 64),
    )
    return decodeRun(row)
  }
  return decodeRun(db.prepare('SELECT * FROM wrap_runs ORDER BY id DESC LIMIT 1').get())
}

/**
 * 今日已创建的 run 数（含终态）。
 *
 * `triggers` 给定时只统计这些触发来源：`maxRunsPerDay` 只限制后台自动触发
 * （idle/disposed），显式/手动是人工动作，不能消耗后台预算（审查 P2）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @param {{ triggers?: string[] }} [opts]
 * @returns {number}
 */
export function countRunsToday(db, now = Date.now() / 1000, { triggers = null } = {}) {
  const start = localDayStart(now)
  const list = Array.isArray(triggers) ? triggers.map((item) => String(item)).filter(Boolean) : []
  if (list.length === 0) {
    return Number(db.prepare('SELECT count(*) AS n FROM wrap_runs WHERE created_at >= ?').get(start)?.n || 0)
  }
  const marks = list.map(() => '?').join(',')
  return Number(db.prepare(`SELECT count(*) AS n FROM wrap_runs WHERE created_at >= ? AND trigger IN (${marks})`)
    .get(start, ...list)?.n || 0)
}

/**
 * 最近 run 列表（面板/诊断；不返回 distilled 明细以免把候选正文带出去）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit 1..50
 * @returns {object[]}
 */
export function listRuns(db, limit = 10) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 10))
  return db.prepare(`SELECT id,session_id,material_hash,state,trigger,user_id,role_id,workspace,
    job_id,attempts,phase,candidates,rule_proposals,open_loops,report_path,error,created_at,updated_at
    FROM wrap_runs ORDER BY id DESC LIMIT ?`).all(lim).map(decodeRun)
}
