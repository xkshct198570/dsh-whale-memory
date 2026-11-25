// 职责：rules 编辑/版本组——版本列表、diff、直接编辑、回滚，及其 4 条路由。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { readJson, sendJson } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { DIFF_LINE_LIMIT, diffLines, gitLog, isValidRuleKey, readHistory, readRule, resolveRevision, revertRule, updateRule } from '../../core/rule-store.js'
import { RULES_PREFIX, applyPostSteps, auditRuleChange, gitView, queryOf, resolveRulesRoot, ruleView, sendMethodNotAllowed, statusForError, textOf, writeGuard } from './shared.js'

/**
 * 版本列表 payload：当前版本 + 历史快照 + 触及该 key 文件的 git 提交。
 *
 * 两条时间线合成一个 `versions` 数组是刻意的：面板"选一版看 diff/revert"不需要知道
 * 那是文件快照还是 git 提交，只需要一个能原样传给 `/rules/diff?rev=` 的 rev。
 * @param {{root?:string,config?:any,key:string,detect?:Function}} args
 * @returns {object}
 */
export function ruleVersionsPayload({ root = '', config = {}, key = '', detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const history = readHistory(dir, key)
  const versions = [{
    kind: 'current',
    rev: '',
    version: Number(got.rule.front.version) || null,
    ts: textOf(got.rule.front.updated),
    source: 'file',
    commit: '',
    subject: '当前版本',
  }]
  if (history.ok) {
    for (const entry of history.entries) {
      versions.push({
        kind: 'history',
        rev: entry.rev,
        version: entry.version ?? null,
        ts: entry.ts,
        source: entry.source,
        commit: '',
        subject: '',
      })
    }
  }
  // git 是可选增强：仓库缺失/无提交时版本列表照常返回（不把 git 缺失变成读失败）。
  const seen = new Set()
  for (const rel of [`${key}.md`, `proposals/${key}.md`]) {
    const log = gitLog(dir, 30, { withTime: true, path: rel })
    if (!log.ok) continue
    for (const entry of log.entries) {
      if (seen.has(entry.hash)) continue
      seen.add(entry.hash)
      const m = String(entry.subject).match(/v(\d+)\s*$/)
      versions.push({
        kind: 'git',
        rev: entry.hash,
        version: m ? Number(m[1]) : null,
        ts: entry.ts ? new Date(entry.ts * 1000).toISOString() : '',
        source: 'git',
        commit: entry.hash,
        subject: entry.subject,
      })
    }
  }
  return {
    ok: true,
    dir,
    key,
    current: {
      version: Number(got.rule.front.version) || null,
      updated: textOf(got.rule.front.updated),
      status: textOf(got.rule.front.status),
      chars: Array.from(textOf(got.rule.text)).length,
    },
    versions,
    git: gitView({ config, detect }),
    ...(history.ok ? {} : { historyError: history.error }),
  }
}

/**
 * 版本 diff payload（纯函数 + 行 diff，不引库）。
 * @param {{root?:string,config?:any,key:string,rev:string,detect?:Function,maxLines?:number}} args
 * @returns {object}
 */
export function ruleDiffPayload({
  root = '', config = {}, key = '', rev = '', detect = detectGit, maxLines = DIFF_LINE_LIMIT,
} = {}) {
  const dir = root || resolveRulesRoot(config)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const resolved = resolveRevision({ root: dir, key, rev })
  if (!resolved.ok) return { ok: false, error: resolved.error, detail: resolved.detail }
  const oldText = textOf(resolved.rule.text)
  const newText = textOf(got.rule.text)
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : DIFF_LINE_LIMIT
  const lineCount = (text) => (text === '' ? 0 : text.split('\n').length)
  const oldLines = lineCount(oldText)
  const newLines = lineCount(newText)
  if (oldLines > limit || newLines > limit) {
    return { ok: false, error: 'diff_too_large', detail: { limit, oldLines, newLines } }
  }
  return {
    ok: true,
    dir,
    key,
    rev: resolved.rev,
    source: resolved.source,
    oldText,
    newText,
    diff: diffLines(oldText, newText),
    git: gitView({ config, detect }),
  }
}

/**
 * 直接编辑规则（R5）：与 apply 同一写闸门（rules_disabled / git_required）。
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function updatePayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const before = readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  const patch = body?.patch
  const updated = updateRule({
    root: dir,
    key,
    patch,
    identity: body?.identity,
    traceId: textOf(body?.traceId),
    now,
  }, { git, exec, gitRequired: guard.required })
  if (!updated.ok) {
    return { ok: false, error: updated.error, detail: updated.detail, rolledBack: updated.rolledBack }
  }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: 'rule_edit',
    key,
    beforeText: before.rule.text,
    afterText: textOf(updated.rule.text),
    commit: updated.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: body?.identity,
    log,
    extra: {
      fields: Object.keys(patch && typeof patch === 'object' ? patch : {}),
      fromVersion: updated.previousVersion,
      toVersion: updated.version,
      changed: updated.changed,
    },
  })
  return {
    ok: true,
    dir,
    key,
    changed: Boolean(updated.changed),
    rule: ruleView(updated.rule),
    // 与 apply 契约一致：`commit` 是提交消息字符串（面板直接展示）；
    // 结构化细节（ok/committed/error）放 commitInfo，避免客户端把对象 String 成 [object Object]。
    commit: textOf(updated.commit?.message),
    commitInfo: updated.commit,
    commitState: updated.commitState ?? null,
    version: updated.version,
    previousVersion: updated.previousVersion,
    mirror: post.mirror ? { ok: Boolean(post.mirror.ok), mirrored: post.mirror.mirrored ?? null } : null,
    agents: post.agents
      ? {
        ok: Boolean(post.agents.ok),
        code: textOf(post.agents.code),
        changed: post.agents.changed ?? null,
        count: Number(post.agents.count) || 0,
      }
      : null,
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

/**
 * 回滚到指定版本（作为新版本写回，不删历史）。
 * @param {{root?:string,config?:any,backend?:any,body?:object,detect?:Function,
 *   mirror?:Function,renderAgents?:Function,git?:boolean,exec?:Function,
 *   log?:Function,now?:number}} args
 * @returns {object}
 */
export function revertPayload({
  root = '', config = {}, backend = null, body = {}, detect = detectGit,
  mirror = null, renderAgents = null, git = true, exec = null, log = () => {}, now = Date.now(),
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const key = textOf(body?.key).trim()
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const rev = textOf(body?.rev).trim()
  if (!rev) return { ok: false, error: 'invalid_rev' }
  const before = readRule(dir, key)
  if (!before.ok) return { ok: false, error: before.error, detail: before.detail }
  const reverted = revertRule({
    root: dir,
    key,
    rev,
    identity: body?.identity,
    traceId: textOf(body?.traceId),
    now,
  }, { git, exec, gitRequired: guard.required })
  if (!reverted.ok) {
    return {
      ok: false,
      error: reverted.error === 'snapshot_not_found' ? 'rev_not_found' : reverted.error,
      detail: reverted.detail,
      rolledBack: reverted.rolledBack,
    }
  }
  const post = applyPostSteps({ dir, config, backend, mirror, renderAgents, log })
  const audit = auditRuleChange({
    backend,
    reason: 'rule_revert',
    key,
    beforeText: before.rule.text,
    afterText: textOf(reverted.rule.text),
    commit: reverted.commit,
    mirrorResult: post.mirror,
    agentsResult: post.agents,
    traceId: textOf(body?.traceId),
    identity: body?.identity,
    log,
    extra: {
      revertTo: reverted.revertedTo,
      source: reverted.source,
      fromVersion: reverted.previousVersion,
      toVersion: reverted.version,
    },
  })
  return {
    ok: true,
    dir,
    key,
    revertedTo: reverted.revertedTo,
    source: reverted.source,
    changed: true,
    rule: ruleView(reverted.rule),
    commit: textOf(reverted.commit?.message),
    commitInfo: reverted.commit,
    commitState: reverted.commitState ?? null,
    version: reverted.version,
    previousVersion: reverted.previousVersion,
    mirror: post.mirror ? { ok: Boolean(post.mirror.ok), mirrored: post.mirror.mirrored ?? null } : null,
    agents: post.agents
      ? {
        ok: Boolean(post.agents.ok),
        code: textOf(post.agents.code),
        changed: post.agents.changed ?? null,
        count: Number(post.agents.count) || 0,
      }
      : null,
    audit: { ok: audit.ok, ...(audit.ok ? {} : { error: audit.error }) },
  }
}

// ---------------------------------------------------------------------------
// 路由：编辑/版本组（4 条精确路径）。与具体端点/兜底无路径交叉；/rules/:key 兜底仍由 router 末位调用。
// ---------------------------------------------------------------------------

/**
 * 版本列表 / diff / 直接编辑 / 回滚四条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,backend?:any,detect?:Function,
 *   log?:Function,git?:boolean,afterWrite?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleEditRevert({
  req, res, path, config = {}, backend = null, detect = detectGit, log = () => {}, git = true,
  afterWrite = (payload) => payload,
} = {}) {
  const p = textOf(path)
  const diffPath = `${RULES_PREFIX}/rules/diff`
  const versionsPath = `${RULES_PREFIX}/rules/versions`
  const updatePath = `${RULES_PREFIX}/rules/update`
  const revertPath = `${RULES_PREFIX}/rules/revert`

  if (p === diffPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    const query = queryOf(req)
    const payload = ruleDiffPayload({
      config,
      key: textOf(query.get('key')).trim(),
      rev: textOf(query.get('rev')).trim(),
      detect,
    })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === versionsPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    const query = queryOf(req)
    const payload = ruleVersionsPayload({
      config,
      key: textOf(query.get('key')).trim(),
      detect,
    })
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === updatePath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(updatePayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  if (p === revertPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) { sendJson(res, body.status, { ok: false, error: body.error }); return true }
    const payload = afterWrite(revertPayload({
      config,
      backend,
      body: body.value,
      detect,
      git,
      log,
    }))
    sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
    return true
  }

  return false
}
