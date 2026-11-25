// 职责：rules 旧铁律导入组——旧铁律节点→文件（幂等）及其 1 条路由。
// 依赖方向：http-kit/shared/git-detector/core 门面 ← 本文件；不 import 其他组或门面，组间只走 shared。

import { readJson, sendJson } from '../http-kit.js'
import { detectGit } from '../git-detector.js'
import { importLegacyRule, mirrorRules } from '../../core/rule-mirror.js'
import { isValidRuleKey, listRules } from '../../core/rule-store.js'
import { RULES_PREFIX, resolveRulesRoot, sendMethodNotAllowed, statusForError, textOf, writeGuard } from './shared.js'

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
  const imported = importLegacyRule({ backend, key, number, root: dir, gitRequired: guard.required })
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

// ---------------------------------------------------------------------------
// 路由：旧铁律导入（1 条精确路径）。/rules/:key 兜底仍由 router 末位调用。
// ---------------------------------------------------------------------------

/**
 * import-legacy 一条精确路由。
 * @param {{req:object,res:object,path:string,config?:any,backend?:any,detect?:Function,
 *   log?:Function,afterWrite?:Function}} ctx
 * @returns {Promise<boolean>} true=已处理；false=交给后续组
 */
export async function handleImportLegacy({
  req, res, path, config = {}, backend = null, detect = detectGit, log = () => {},
  afterWrite = (payload) => payload,
} = {}) {
  const p = textOf(path)
  const importPath = `${RULES_PREFIX}/rules/import-legacy`
  if (p !== importPath) return false
  if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return true }
  const body = await readJson(req)
  if (!body.ok) {
    sendJson(res, body.status, { ok: false, error: body.error })
    return true
  }
  const rawKey = textOf(body.value?.key).trim()
  // 非法 key 不再静默截断：422 让调用方知道是参数问题；未给 key 时按旧铁律节点推导。
  if (rawKey && !isValidRuleKey(rawKey.slice(0, 64))) {
    sendJson(res, 422, { ok: false, error: 'invalid_key' })
    return true
  }
  const key = rawKey.slice(0, 64)
  const rawNumber = Number(body.value?.number)
  const payload = afterWrite(importLegacyPayload({
    config,
    backend,
    key,
    number: Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : null,
    detect,
    log,
  }))
  // 404=节点不存在、409=重复、422=未通过校验；不再把管理动作一律按 403 报。
  sendJson(res, payload.ok ? 200 : statusForError(textOf(payload.error)), payload)
  return true
}
