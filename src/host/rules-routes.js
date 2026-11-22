/**
 * 规则 HTTP 路由（R3a）：只读列表/详情 + 两个管理动作（重建镜像、迁移旧铁律）。
 *
 * 职责：
 * - `GET  /whale-memory/api/rules`            列表 + manifest + git 状态
 * - `GET  /whale-memory/api/rules/git-status` 强制刷新 git 探测
 * - `GET  /whale-memory/api/rules/:key`       单条详情 + 历史
 * - `POST /whale-memory/api/rules/rebuild-mirror` 触发文件→DB 镜像
 * - `POST /whale-memory/api/rules/import-legacy`  旧铁律节点→文件
 *
 * 边界：
 * - 规则默认共享，不按 user 过滤；本层不做授权（回环闸门由 routes.js 统一处理）。
 * - 服务端不弹二次确认；`guardStrict`/确认交互由 client 面板负责。
 * - 任何失败都返回 `{ok:false,error,detail?}`，不抛；git 缺失时读接口照常可用。
 *
 * Why 单独成文件：路由文件已 35K，再塞规则读写会继续膨胀；把 payload 纯函数独立出来
 * 还能脱 HTTP 做契约测试（不起真服务器）。
 */
import { readJson, sendJson } from './http-kit.js'
import { value } from './config-values.js'
import { detectGit, gitRequired, refreshGit } from './git-detector.js'
import {
  computeManifest, defaultRuleRoot, listRules, readHistory, readRule,
} from '../core/rule-store.js'
import { importLegacyRule, mirrorRules, mirrorStatus } from '../core/rule-mirror.js'

/** 与 routes.js 同一个前缀；写死字面量避免 routes ↔ rules-routes 循环 import。 */
export const RULES_PREFIX = '/whale-memory/api'

function textOf(value) {
  return String(value ?? '')
}

/** 配置 `rules.dir` 优先，空则 `$DSH_HOME/rules`。 */
export function resolveRulesRoot(config) {
  const raw = textOf(config?.rules?.dir).trim()
  return raw || defaultRuleRoot()
}

function gitView({ config, detect = detectGit, force = false } = {}) {
  const info = typeof detect === 'function' ? detect({ force }) : detect
  const view = {
    available: Boolean(info?.available),
    version: textOf(info?.version),
    required: Boolean(config?.rules?.requireGit),
    checkedAt: Number(info?.checkedAt) || Date.now(),
  }
  if (info?.error) view.error = String(info.error)
  return view
}

/** 规则标题：结构化 action 优先，否则正文首句（只展示，不改正文）。 */
function titleOf(front, body) {
  const action = textOf(front?.action).trim()
  if (action) return action.slice(0, 80)
  const first = textOf(body).split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean)[0] || ''
  return first.slice(0, 80)
}

/**
 * 列表 payload（纯函数）。
 * @param {{root?:string,config?:any,detect?:Function,forceGit?:boolean}} [args]
 * @returns {object}
 */
export function rulesListPayload({ root = '', config = {}, detect = detectGit, forceGit = false } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const manifest = computeManifest(list.rules)
  const rules = list.rules.map((doc) => ({
    key: textOf(doc.front.key),
    type: textOf(doc.front.type),
    number: Number(doc.front.number),
    priority: textOf(doc.front.priority),
    scope: textOf(doc.front.scope),
    role: textOf(doc.front.role),
    status: textOf(doc.front.status),
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
  const rule = {
    ...got.rule.front,
    front: got.rule.front,
    text: got.rule.text,
    bodyStart: got.rule.bodyStart,
    path: got.rule.file,
    title: titleOf(got.rule.front, got.rule.text),
  }
  return {
    ok: true,
    rule,
    history: history.ok ? history.entries : [],
    git: gitView({ config, detect }),
    ...(history.ok ? {} : { historyError: history.error }),
  }
}

/**
 * 提案列表 payload（只读）：规则文件里 type=rule-candidate 或 status=proposal 的条目。
 * 客户端在 R3a 已挂载该入口；接口缺失会软降级为空态，这里提供真数据但不做写操作。
 * @param {{root?:string,config?:any}} [args]
 * @returns {object}
 */
export function rulesProposalsPayload({ root = '', config = {} } = {}) {
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const items = list.rules
    .filter((doc) => doc.front.type === 'rule-candidate' || doc.front.status === 'proposal')
    .map((doc) => ({
      key: textOf(doc.front.key),
      type: textOf(doc.front.type),
      number: Number(doc.front.number),
      priority: textOf(doc.front.priority),
      scope: textOf(doc.front.scope),
      status: textOf(doc.front.status),
      updated: textOf(doc.front.updated),
      title: titleOf(doc.front, doc.text),
      excerpt: textOf(doc.text).slice(0, 80),
      text: textOf(doc.text),
    }))
  return { ok: true, proposals: items, items }
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

function writeGuard(config, detect) {
  // enabled 是 volatile（Ref）；不能拿 Ref 对象直接和 false 比。
  if (value(config?.rules?.enabled, true) === false) return { ok: false, error: 'rules_disabled' }
  return gitRequired(config, detect)
}

/**
 * 重建镜像（管理动作）。
 * @param {{root?:string,config?:any,backend?:any,detect?:Function,log?:Function}} args
 * @returns {object}
 */
export function rebuildMirrorPayload({ root = '', config = {}, backend, detect = detectGit, log = () => {} } = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const list = listRules(dir)
  const mirror = mirrorRules({ backend, rules: list.rules, log })
  if (!mirror.ok) return { ok: false, error: mirror.error }
  const status = mirrorStatus({ backend, rules: list.rules })
  return { ok: true, dir, mirror, status }
}

/**
 * 迁移旧铁律（管理动作，幂等）。
 * @param {{root?:string,config?:any,backend?:any,key?:string,number?:number,
 *   detect?:Function,log?:Function}} args
 * @returns {object}
 */
export function importLegacyPayload({
  root = '', config = {}, backend, key = '', number = null, detect = detectGit, log = () => {},
} = {}) {
  const guard = writeGuard(config, detect)
  if (!guard.ok) return { ok: false, error: guard.error, git: guard.git }
  const dir = root || resolveRulesRoot(config)
  const imported = importLegacyRule({ backend, key, number, root: dir })
  if (!imported.ok) return imported
  let mirror = null
  if (config?.rules?.mirrorAuto !== false && imported.skipped === false) {
    const list = listRules(dir)
    mirror = mirrorRules({ backend, rules: list.rules, log })
  }
  // count/imported 供面板显示「导入 N 条 / 已存在跳过」；0/1 是本次动作的真实增量。
  return {
    ...imported,
    count: imported.skipped ? 0 : 1,
    imported: imported.skipped ? 0 : 1,
    ...(mirror ? { mirror } : {}),
  }
}

function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow)
  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
}

function decodeKey(rest) {
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

/**
 * 规则路由入口：命中返回 true，未命中返回 false（交给 routes.js 继续/404）。
 *
 * @param {{req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse,
 *   path:string,config?:any,backend?:any,detect?:Function,log?:Function}} args
 * @returns {Promise<boolean>}
 */
export async function handleRules({ req, res, path, config, backend, detect = detectGit, log = () => {} }) {
  const p = textOf(path)
  const listPath = `${RULES_PREFIX}/rules`
  const gitPath = `${RULES_PREFIX}/rules/git-status`
  const rebuildPath = `${RULES_PREFIX}/rules/rebuild-mirror`
  const importPath = `${RULES_PREFIX}/rules/import-legacy`

  if (p === listPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    sendJson(res, 200, rulesListPayload({ config, detect }))
    return true
  }

  if (p === gitPath) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    // 路由层强制刷新：面板点「重新检测」必须绕过 60s 缓存。
    const fresh = detect === detectGit ? refreshGit() : detect({ force: true })
    sendJson(res, 200, gitStatusPayload({ config, detect: () => fresh }))
    return true
  }

  if (p === rebuildPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    // 无载荷动作：仍要排空 body，避免 keep-alive 连接残留请求体；空 body 不算错误。
    await readJson(req)
    const payload = rebuildMirrorPayload({ config, backend, detect, log })
    sendJson(res, payload.ok ? 200 : 403, payload)
    return true
  }

  if (p === importPath) {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
    const body = await readJson(req)
    if (!body.ok) {
      sendJson(res, body.status, { ok: false, error: body.error })
      return true
    }
    const key = textOf(body.value?.key).trim().slice(0, 64)
    const rawNumber = Number(body.value?.number)
    const payload = importLegacyPayload({
      config,
      backend,
      key,
      number: Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : null,
      detect,
      log,
    })
    sendJson(res, payload.ok ? 200 : 403, payload)
    return true
  }

  if (p === `${listPath}/proposals`) {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return true }
    sendJson(res, 200, rulesProposalsPayload({ config }))
    return true
  }

  if (p.startsWith(`${listPath}/`)) {
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

  return false
}
