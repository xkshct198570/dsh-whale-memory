// 职责：rules 只读底座组——列表/详情/git 状态/健康巡检/能力探测，及其 4 条路由（详情兜底单独导出）。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectGit, refreshGit } from '../git-detector.js'
import { computeManifest, fileRuleNumbers, listRules, readHistory, readManifest, readRule, readTombstones, TXN_DIR } from '../../core/rule-store.js'
import { chainIssues, resolveChain } from '../../core/rule-reconcile.js'
import { agentsBlockStale, agentsPathOf, fileHasMarkers, rulesDigestContent } from '../../core/rule-render.js'
import { lockState } from '../../core/rule-lock.js'
import { sendJson } from '../http-kit.js'
import { RULES_PREFIX, decodeKey, gitView, loadDefaultRestore, resolveRulesRoot, sendMethodNotAllowed, summaryBudgetOf, textOf, titleOf, ruleView } from './shared.js'
import { lastInjection } from '../inject-stats.js'

/**
 * 列表 payload（纯函数）。
 * @param {{root?:string,config?:any,detect?:Function,forceGit?:boolean}} [args]
 * @returns {object}
 */
export function rulesListPayload({ root = '', config = {}, detect = detectGit, forceGit = false } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  // 墓碑必须参与列表的 nextNumber：purge 过的编号不复用，列表页的"下一个编号"不能回落。
  // R9-20：墓碑以 retired/*.json 为真源；manifest 丢失/陈旧不得让 nextNumber 回落。
  const manifest = computeManifest(list.rules, readTombstones(dir), fileRuleNumbers(dir))
  const rules = list.rules.map((doc) => ({
    key: textOf(doc.front.key),
    type: textOf(doc.front.type),
    number: Number(doc.front.number),
    priority: textOf(doc.front.priority),
    scope: textOf(doc.front.scope),
    role: textOf(doc.front.role),
    status: textOf(doc.front.status),
    // `origin` 是「默认铁律」徽标的唯一判据（default:<key>）；列表不带它，面板只能瞎猜。
    origin: textOf(doc.front.origin),
    updated: textOf(doc.front.updated),
    title: titleOf(doc.front, doc.text),
    excerpt: textOf(doc.text).slice(0, 80),
    chars: Array.from(textOf(doc.text)).length,
  }))
  const payload = {
    ok: true,
    dir,
    git: gitView({ config, detect, force: forceGit }),
    rules,
    manifest,
  }
  if (list.errors.length) {
    payload.errors = list.errors.map((item) => ({ file: item.file, error: item.error, detail: item.detail }))
  }
  return payload
}

/**
 * 详情 payload（纯函数）。
 * @param {{root?:string,config?:any,key:string,detect?:Function}} args
 * @returns {object}
 */
export function ruleDetailPayload({ root = '', config = {}, key, detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const got = readRule(dir, key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  const history = readHistory(dir, key)
  // `front` 保留规范嵌套；同一层再铺开 front 字段，供面板直接读 rule.number/rule.origin
  // （客户端已按扁平结构渲染；两套并存不冲突，避免为一个展示层改动破坏契约）。
  const rule = ruleView(got.rule)
  return {
    ok: true,
    rule,
    history: history.ok ? history.entries : [],
    git: gitView({ config, detect }),
    ...(history.ok ? {} : { historyError: history.error }),
  }
}

/**
 * git-status payload：**强制刷新**（不吃 60s 缓存）。
 * @param {{config?:any,detect?:Function}} [args]
 * @returns {object}
 */
export function gitStatusPayload({ config = {}, detect = detectGit } = {}) {
  const view = typeof detect === 'function' ? detect({ force: true }) : detect
  return {
    ok: true,
    git: {
      available: Boolean(view?.available),
      version: textOf(view?.version),
      required: Boolean(config?.rules?.requireGit),
      checkedAt: Number(view?.checkedAt) || Date.now(),
      ...(view?.error ? { error: String(view.error) } : {}),
    },
  }
}

/**
 * 规则库健康检查（只读，不写盘、不修自愈）：文件 ↔ manifest ↔ retired 墓碑 ↔ 编号/key 一致性。
 *
 * Why 200+ok:false：这是监控探针，调用方要能一次拿到全部 failures 做巡检图表；
 * HTTP 层失败只留给「接口不存在/未授权」，业务不一致用 body 表达（与 render no_markers 同口径）。
 *
 * @param {{root?:string,config?:any,detect?:Function}} [args]
 * @returns {object}
 */
export function rulesHealthPayload({ root = '', config = {}, detect = detectGit } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const manifest = readManifest(dir)
  const tombstones = readTombstones(dir)
  const failures = []
  const push = (code, extra = {}) => failures.push({ code, ...extra })

  // ① 文件层：解析/校验失败、key≠文件名、编号重复都由 listRules 归到 errors。
  // validateRule 的具体原因在 detail[].code（duplicate_number/number_reserved/…），必须摊平，
  // 否则巡检只能看到笼统的 invalid_rule，等于没报出到底是撞号还是保留号。
  for (const item of list.errors) {
    push(textOf(item.error) || 'invalid_rule', { file: textOf(item.file), detail: item.detail })
    if (Array.isArray(item.detail)) {
      for (const error of item.detail) {
        const code = textOf(error?.code)
        if (code && code !== textOf(item.error)) {
          push(code, { file: textOf(item.file), field: textOf(error?.field), detail: error?.message })
        }
      }
    }
  }

  // ② manifest 与磁盘文件对账（manifest 是墓碑唯一真源，内容漂移必须报）。
  if (!manifest) {
    push('manifest_missing', { file: `${dir}/manifest.json` })
  } else {
    const computed = computeManifest(list.rules, manifest.retired, fileRuleNumbers(dir))
    if (Number(manifest.total) !== computed.total) {
      push('manifest_total_mismatch', { expected: computed.total, actual: Number(manifest.total) })
    }
    if (Number(manifest.nextNumber) !== computed.nextNumber) {
      push('manifest_next_number_mismatch', { expected: computed.nextNumber, actual: Number(manifest.nextNumber) })
    }
    const liveKeys = list.rules.map((doc) => textOf(doc.front.key)).sort()
    const manifestKeys = (Array.isArray(manifest.keys) ? manifest.keys : []).map((key) => textOf(key)).sort()
    if (liveKeys.join('\n') !== manifestKeys.join('\n')) {
      push('manifest_keys_mismatch', {
        missing: liveKeys.filter((key) => !manifestKeys.includes(key)),
        extra: manifestKeys.filter((key) => !liveKeys.includes(key)),
      })
    }
    const manifestRetired = (Array.isArray(manifest.retired) ? manifest.retired : [])
      .map((item) => ({ key: textOf(item?.key), number: Number(item?.number) }))
      .sort((a, b) => a.number - b.number || a.key.localeCompare(b.key))
    const diskRetired = tombstones.map((item) => ({ key: item.key, number: item.number }))
    if (manifestRetired.length !== diskRetired.length
      || manifestRetired.some((item, index) => item.number !== diskRetired[index].number || item.key !== diskRetired[index].key)) {
      push('retired_mismatch', { manifest: manifestRetired, retiredDir: diskRetired })
    }
  }

  // ③ 合并/取代链：断链、环、链终点非 active 都必须报（注入/摘要只该用 terminal+active）。
  const chains = chainIssues(list.rules)
  for (const item of chains.broken) {
    push('chain_broken', { key: textOf(item.key), missingKey: textOf(item.missingKey), chain: item.chain })
  }
  for (const item of chains.cycles) {
    push('chain_cycle', { key: textOf(item.key), chain: item.chain })
  }
  for (const doc of list.rules) {
    const key = textOf(doc.front.key)
    const pointer = textOf(doc.front.merged_into) || textOf(doc.front.superseded_by)
    if (!pointer) continue
    const resolved = resolveChain(list.rules, key)
    // 断链/环已在上面报过，这里只报「链能走通但终点不是 active」。
    if (resolved.ok && resolved.status !== 'active') {
      push('chain_target_inactive', { key, chain: resolved.chain, status: resolved.status })
    }
  }

  // ④ 墓碑编号不得被现存铁律复活（writeRule 不拦恢复默认，必须在巡检里红）。
  const retiredNumbers = new Set(tombstones.map((item) => item.number))
  for (const doc of list.rules) {
    const n = Number(doc.front.number)
    if (doc.front.type === 'iron-rule' && Number.isInteger(n) && n > 0 && retiredNumbers.has(n)) {
      push('retired_number_reused', { key: textOf(doc.front.key), number: n })
    }
  }

  // ⑤ 未完成/恢复失败的事务：`.txn` 非空即红（恢复器失败会保留锚点并写 failures）。
  //    成功恢复的记录在 `.txn/.recovered.jsonl`，只作证据展示，不算失败。
  const txnDir = join(dir, TXN_DIR)
  const pendingTxns = []
  try {
    for (const name of readdirSync(txnDir)) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const parsed = JSON.parse(readFileSync(join(txnDir, name), 'utf8'))
        push('txn_pending', {
          id, op: textOf(parsed?.op || 'apply'),
          failures: Array.isArray(parsed?.failures) ? parsed.failures : [],
        })
        pendingTxns.push(id)
      } catch {
        push('txn_unreadable', { id })
        pendingTxns.push(id)
      }
    }
  } catch { /* `.txn` 不存在=没有待恢复项 */ }
  let lastRecovery = null
  try {
    const lines = String(readFileSync(join(txnDir, '.recovered.jsonl'), 'utf8')).split('\n').filter(Boolean)
    const last = lines[lines.length - 1]
    if (last) lastRecovery = JSON.parse(last)
  } catch { /* 没有恢复记录 */ }

  // requireGit 是写闸：可用性不满足时所有写入口 403，巡检不能报绿。
  const git = gitView({ config, detect })
  if (git.required === true && git.available !== true) {
    push('git_required_unmet', { git })
  }

  // 黄灯（非红）：不影响 ok，但必须让面板/交接看得到——这些是「规则静默消失」的预兆。
  const warnings = []
  try {
    const digest = rulesDigestContent(list.rules, { dir, budgetChars: summaryBudgetOf(config) })
    if (digest.skipped?.length) {
      warnings.push({
        code: 'summary_budget_skipped',
        keys: digest.skipped.map((item) => item.key),
        detail: `摘要预算 ${digest.budgetChars} 码点，${digest.skipped.length} 条规则未进 AGENTS`,
      })
    }
  } catch { /* 摘要重算失败只影响黄灯，不影响健康判定 */ }
  try {
    const injected = lastInjection()
    if (injected?.skipped?.length) {
      warnings.push({
        code: 'inject_skipped',
        keys: injected.skipped.map((item) => item.key),
        detail: `最近一次注入（mode=${injected.mode || '?'}）有 ${injected.skipped.length} 条规则因预算被跳过`,
      })
    }
  } catch { /* 注入统计缺失=没有事实 */ }
  try {
    const agentsPath = agentsPathOf(dir)
    if (agentsBlockStale({ agentsPath, rulesDir: dir })) {
      warnings.push({
        code: 'agents_block_stale',
        file: agentsPath,
        detail: 'AGENTS 管理块旧于规则文件（renderAgents=false 或渲染失败）：hook 已降级注入 global',
      })
    }
    // 已有 AGENTS.md 但没有任何管理标记：摘要永远不会写入，规则对新会话"隐身"。
    // 不自动插块（会改宿主资产），但必须黄灯+启动日志，让人知道开关没生效。
    if (existsSync(agentsPath) && !fileHasMarkers(agentsPath)) {
      warnings.push({
        code: 'agents_markers_missing',
        file: agentsPath,
        detail: 'AGENTS.md 已存在但没有管理块标记：规则摘要不会写入（可手动加 <!-- whale-memory:rules:begin --> 标记，或删掉文件让插件重建）',
      })
    }
  } catch { /* mtime 读不到不算黄灯事实 */ }
  try {
    // 阈值用 rule-lock 的单一真源常量；不再读 schema 里不存在的 rules.lockStaleMs（死旋钮）。
    const lock = lockState(dir)
    if (lock.held && lock.stale) {
      warnings.push({
        code: 'zombie_lock',
        owner: lock.owner,
        ageMs: lock.ageMs,
        detail: `仓库锁已持有 ${Math.round(lock.ageMs / 1000)}s（owner pid=${lock.owner?.pid ?? '?'}）：疑似 pid 复用/进程卡死，写操作会持续 repo_locked`,
      })
    }
  } catch { /* 锁状态读不到不算健康事实 */ }

  return {
    ok: failures.length === 0,
    dir,
    failures,
    warnings,
    txns: { pending: pendingTxns, lastRecovery },
    counts: {
      rules: list.rules.length,
      errors: list.errors.length,
      tombstones: tombstones.length,
      nextNumber: manifest ? Number(manifest.nextNumber) : null,
    },
    git,
    checkedAt: Date.now(),
  }
}

/**
 * 面板能力探测：`GET /rules` 带 capabilities，客户端据此**隐藏**尚未上线能力的入口
 * （恢复默认按钮、plan 预览），而不是点了才报 501。
 * @returns {Promise<{plan:boolean,restoreDefault:boolean}>}
 */
export async function rulesCapabilities() {
  const plan = existsSync(new URL('../../core/rule-plan.js', import.meta.url))
  const restore = await loadDefaultRestore()
  return { plan, restoreDefault: Boolean(restore) }
}

// ---------------------------------------------------------------------------
// 路由：只读底座组。详情兜底必须由 router 在所有具体端点之后调用，
// 否则 `GET /rules/<具体端点>` 会被当成 key 走 404，破坏原 405 语义。
// ---------------------------------------------------------------------------

/**
 * 列表 / git 状态 / 健康巡检三条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,detect?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleListHealth({ req, res, path, config = {}, detect = detectGit } = {}) {
  const p = textOf(path)
  const listPath = `${RULES_PREFIX}/rules`
  if (p === listPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // capabilities 让客户端**隐藏**还没上线的入口（恢复默认/plan），而不是点了才 501。
    const capabilities = await rulesCapabilities()
    sendJson(res, 200, { ...rulesListPayload({ config, detect }), capabilities })
    return true
  }
  const gitPath = `${RULES_PREFIX}/rules/git-status`
  if (p === gitPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 路由层强制刷新：面板点「重新检测」必须绕过 60s 缓存。
    const fresh = detect === detectGit ? refreshGit() : detect({ force: true })
    sendJson(res, 200, gitStatusPayload({ config, detect: () => fresh }))
    return true
  }
  const healthPath = `${RULES_PREFIX}/rules/health`
  if (p === healthPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 巡检探针：业务不一致也回 200，ok:false + failures[] 交给调用方（文档口径一致）。
    sendJson(res, 200, rulesHealthPayload({ config, detect }))
    return true
  }
  return false
}

/**
 * `/rules/:key` 详情兜底：必须在 router 所有具体端点之后调用（GET 到 POST-only 端点应保持 405）。
 * @param {{req:object,res:object,path:string,config?:any,detect?:Function}} ctx
 * @returns {boolean} true=已处理
 */
export function handleRuleDetail({ req, res, path, config = {}, detect = detectGit } = {}) {
  const p = textOf(path)
  const listPath = `${RULES_PREFIX}/rules`
  if (!p.startsWith(`${listPath}/`)) return false
  if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
  const rest = p.slice(listPath.length + 1)
  if (!rest || rest.includes('/')) return false
  const key = decodeKey(rest)
  if (key === null) {
    sendJson(res, 400, { ok: false, error: 'invalid_key' })
    return true
  }
  const payload = ruleDetailPayload({ config, key, detect })
  sendJson(res, payload.ok ? 200 : 404, payload)
  return true
}
