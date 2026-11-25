// 职责：wrap_session_prefs 的唯一读写入口（per-session 跳过自动收尾）；依赖：零 import。
//
// 为什么单独落库（S2）：skipAuto 必须跨重启生效。缺行=不跳过（默认开），
// 只有显式写入才产生行；读路径坏 JSON/缺表一律回落 false，不阻断收尾主链。

/** 规范化会话键（与 wrap_runs.session_id 同口径，防超长键污染主键）。 */
function sessionKey(raw) {
  return String(raw ?? '').trim().slice(0, 200)
}

/**
 * 读某会话是否跳过自动收尾。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {boolean} true=跳过；缺表/缺行/异常均 false
 */
export function skipAutoOf(db, sessionId) {
  const sid = sessionKey(sessionId)
  if (!sid) return false
  try {
    const row = db.prepare('SELECT skip_auto FROM wrap_session_prefs WHERE session_id=?').get(sid)
    return Boolean(row && Number(row.skip_auto) === 1)
  } catch {
    return false
  }
}

/**
 * 写某会话的跳过开关（幂等 upsert）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {boolean} skipAuto
 * @param {number} [now] 秒
 * @returns {{ok:boolean, sessionId?:string, skipAuto?:boolean, error?:string}}
 */
export function setSkipAuto(db, sessionId, skipAuto, now = Date.now() / 1000) {
  const sid = sessionKey(sessionId)
  if (!sid) return { ok: false, error: 'invalid_session' }
  try {
    db.prepare(`INSERT INTO wrap_session_prefs (session_id, skip_auto, updated_at) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET skip_auto=excluded.skip_auto, updated_at=excluded.updated_at`)
      .run(sid, skipAuto ? 1 : 0, Number(now) || Date.now() / 1000)
    return { ok: true, sessionId: sid, skipAuto: Boolean(skipAuto) }
  } catch (err) {
    return { ok: false, error: `db_error:${String(err?.message || err).slice(0, 120)}` }
  }
}

/**
 * 批量读回 prefs（面板列表用；只回 id+skipAuto，不含正文）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, boolean>}
 */
export function skipAutoMap(db) {
  const out = new Map()
  try {
    for (const row of db.prepare('SELECT session_id, skip_auto FROM wrap_session_prefs').all()) {
      out.set(String(row.session_id), Number(row.skip_auto) === 1)
    }
  } catch { /* 缺表/坏库：全部按不跳过 */ }
  return out
}
