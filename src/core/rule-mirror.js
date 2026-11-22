/**
 * 规则文件 → DB 镜像（R3a）。
 *
 * 职责：
 * - 把规则文件 upsert 成 nodes 行（origin=`rule:<key>`），供既有召回/检索直接复用；
 * - 文件删除后把镜像行 status=archived、pinned=0（不物理删，保留审计）；
 * - 只触碰 origin 以 `rule:` 开头的行，人工事实/其他来源一律不动；
 * - `mirrorStatus` 对比文件与镜像（缺行/过期/孤儿），供面板显示一致性；
 * - `importLegacyRule` 把旧 DB 里的铁律节点导出成规则文件（一次性迁移，幂等）。
 *
 * 边界：
 * - **不新增列、不改 schema**；nodes 现有列足够表达规则镜像。
 * - 直接 SQL 事务（backend.withDb），不走 writer 的决策流水线：规则文件已是审核后的真源，
 *   再经一遍 ADD/MERGE/SUPERSEDE 会产生人工规则与决策器的二次解释。
 * - 本模块不写文件、不调模型；文件读写由 rule-store.js 负责。
 *
 * Why：规则必须能被现有召回链路命中，否则"规则引擎"只是孤岛文件；镜像用 origin 前缀
 * 划出明确边界，既复用检索又不污染用户的普通记忆。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash, bigrams } from './tokenize.js'
import {
  acquireRepoLock, allocatableRuleNumber, defaultRuleRoot, isRetiredNumber, isValidRuleKey, listRules,
  readTombstones, writeRule,
} from './rule-store.js'

/** 旧铁律节点（迁移前已知 id）；没有该节点时按 tags/origin 兜底查找。 */
export const LEGACY_IRON_RULE_ID = 'n1795335656522_ba2f7fa325'

/** 规则镜像的 origin 前缀；所有镜像 SQL 都必须带这个约束。 */
export const RULE_ORIGIN_PREFIX = 'rule:'

const LEVEL_OF = Object.freeze({ 'iron-rule': 'core', rule: 'important', 'rule-candidate': 'important' })
const WEIGHT_OF = Object.freeze({ P0: 1.0, P1: 0.8, P2: 0.6, P3: 0.5 })

const EXCEPTION_RE = /[；;，,]?\s*例外\s*[：:]\s*([^。；;\n]+)/
const RULE_TEMPLATE_HEAD_RE = /【规则·[^】]*】/g
const SCOPE_TAIL_RE = /[；;]?\s*作用域\s*[：:][^。；\n]*/g

/** @param {any} value @returns {string} */
function textOf(value) {
  return String(value ?? '')
}

/**
 * 接受三种形态：数组、规则根目录、`{rules:[...]}`；返回 `{front,text}` 数组。
 * @param {any} rules
 * @returns {Array<{front:object,text:string}>}
 */
function resolveDocs(rules) {
  if (Array.isArray(rules)) return rules
  if (typeof rules === 'string' && rules.trim()) return listRules(rules.trim()).rules
  if (rules && Array.isArray(rules.rules)) return rules.rules
  if (rules && typeof rules.root === 'string') return listRules(rules.root).rules
  return []
}

function originOf(front) {
  return `${RULE_ORIGIN_PREFIX}${textOf(front?.key)}`
}

function tagsOf(front) {
  const tags = [
    'rule',
    `rule-key:${textOf(front.key)}`,
    `rule-type:${textOf(front.type)}`,
    `rule-scope:${textOf(front.scope)}`,
    `rule-priority:${textOf(front.priority)}`,
  ]
  // 普通规则/候选没有 number（R8-01）：不写 `rule-no:null` 这种假标签。
  const number = Number(front?.number)
  if (Number.isInteger(number) && number > 0) tags.splice(2, 0, `rule-no:${number}`)
  return tags
}

/** 作用域摘要 ≤200（schema 硬顶），只放 scope/role/updated，不放正文。 */
function contextOf(front) {
  const parts = [textOf(front.scope)]
  if (front.role) parts.push(`role:${front.role}`)
  parts.push(`updated:${textOf(front.updated)}`)
  return parts.join(' · ').slice(0, 200)
}

/**
 * `front.scope` → 镜像行的 `role_id` / `workspace`（R8-08）。
 * global 两者都留空（架构书 §5：global 留空，便于面板按作用域过滤）；
 * 镜像不再读 `front.role`（冗余字段），只认 scope，避免 global 规则被写进某个角色分区。
 * @param {any} scope @returns {{role_id:string, workspace:string}}
 */
export function scopeColumns(scope) {
  const raw = textOf(scope).trim() || 'global'
  if (raw.startsWith('role:')) return { role_id: raw.slice('role:'.length).trim(), workspace: '' }
  if (raw.startsWith('workspace:')) {
    return { role_id: '', workspace: raw.slice('workspace:'.length).trim().replace(/[\\/]+$/, '') }
  }
  return { role_id: '', workspace: '' }
}

/** tags 解析失败只当空数组（旧行/手改行不能拖垮漂移判定）。 */
function parseTags(raw) {
  try {
    const parsed = JSON.parse(textOf(raw))
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function mirrorId() {
  const ts = Date.now()
  const hex = Math.floor(Math.random() * 0xffffffffff).toString(16).padStart(10, '0')
  return `n${ts}_${hex}`
}

/** 同步事务：withDb 给的是同步连接，BEGIN IMMEDIATE 保证读-写-提交原子。 */
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚/连接坏时不让回滚错误掩盖原始错误 */ }
    throw err
  }
}

/** @param {any} backend @returns {import('node:sqlite').DatabaseSync|null} */
function dbOf(backend) {
  if (!backend || typeof backend.withDb !== 'function') return null
  try {
    return backend.withDb((db) => db)
  } catch {
    return null
  }
}

function expectedStatus(front) {
  return front?.status === 'active' && front?.type !== 'rule-candidate' ? 'active' : 'archived'
}

function pinnedOf(front) {
  return expectedStatus(front) === 'active' ? 1 : 0
}

/**
 * 全量镜像：upsert 现有文件、归档已删除文件对应的孤儿行。
 *
 * @param {{backend:any, rules:any, log?:Function}} args
 *   rules 可为 listRules 的 rules 数组、规则根目录、或 `{rules:[...]}`。
 * @returns {{ok:boolean,error?:string,mirrored?:number,created?:number,updated?:number,
 *   orphaned?:number,total?:number,checkedAt?:number}}
 */
export function mirrorRules({ backend, rules, log = () => {} } = {}) {
  const db = dbOf(backend)
  if (!db) return { ok: false, error: 'backend_unavailable' }
  const docs = resolveDocs(rules)
  const now = Date.now()
  try {
    const result = inTransaction(db, () => {
      const findByOrigin = db.prepare('SELECT id, text, text_hash, updated_at FROM nodes WHERE origin = ? LIMIT 1')
      const insert = db.prepare(`
        INSERT INTO nodes (id,text,text_hash,text_bigrams,level,memory_type,source,status,
          role_id,user_id,workspace,tags,context_note,weight,hits,pinned,origin,trace_id,created_at,updated_at)
        VALUES (?,?,?,?,?,'procedural','owner',?,?,'',?,?,?,?,0,?,?,'rules',?,?)
      `)
      const update = db.prepare(`
        UPDATE nodes SET text=?, text_hash=?, text_bigrams=?, level=?, memory_type='procedural',
          source='owner', status=?, role_id=?, user_id='', workspace=?, tags=?, context_note=?,
          weight=?, pinned=?, origin=?, trace_id='rules', updated_at=?
        WHERE id=?
      `)
      let created = 0
      let updated = 0
      let candidates = 0
      let total = 0
      const keys = new Set()
      for (const doc of docs) {
        const front = doc?.front && typeof doc.front === 'object' ? doc.front : doc
        const key = textOf(front?.key).trim()
        const body = textOf(doc?.text ?? doc?.body)
        // 候选不镜像（R8-08）：待裁定草稿不该进召回镜像；已有行由下面的孤儿逻辑归档。
        if (textOf(front?.type) === 'rule-candidate') { candidates += 1; continue }
        if (!key || !body) {
          log(`[whale-memory] mirror skip invalid rule: ${key || '<no-key>'}`)
          continue
        }
        total += 1
        keys.add(key)
        const origin = originOf(front)
        const tags = JSON.stringify(tagsOf(front))
        const context = contextOf(front)
        const level = LEVEL_OF[front.type] || 'important'
        const status = expectedStatus(front)
        const weight = WEIGHT_OF[String(front.priority || 'P1').toUpperCase()] ?? 0.8
        const pinned = pinnedOf(front)
        const scopeCols = scopeColumns(front.scope)
        const row = findByOrigin.get(origin)
        if (row) {
          update.run(
            body, contentHash(body), bigrams(body), level, status, scopeCols.role_id, scopeCols.workspace,
            tags, context, weight, pinned, origin, now, row.id,
          )
          updated += 1
        } else {
          insert.run(
            mirrorId(), body, contentHash(body), bigrams(body), level, status, scopeCols.role_id,
            scopeCols.workspace, tags, context, weight, pinned, origin, now, now,
          )
          created += 1
        }
      }

      // 孤儿：文件已不存在的规则行只归档，不物理删（审计/引用仍可查）。
      const rows = db.prepare("SELECT id, origin, status FROM nodes WHERE origin LIKE 'rule:%'").all()
      let orphaned = 0
      const archive = db.prepare("UPDATE nodes SET status='archived', pinned=0, updated_at=? WHERE id=?")
      for (const row of rows) {
        const key = textOf(row.origin).slice(RULE_ORIGIN_PREFIX.length)
        if (keys.has(key)) continue
        if (row.status !== 'archived') archive.run(now, row.id)
        orphaned += 1
      }
      return { created, updated, orphaned, total, candidates }
    })
    return {
      ok: true,
      mirrored: result.created + result.updated,
      created: result.created,
      updated: result.updated,
      orphaned: result.orphaned,
      total: result.total,
      candidatesSkipped: result.candidates,
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 漂移判定（R8-08）：正文一致性之外还必须比 front 关键字段——scope/priority/status/pinned
 * 与镜像行的 tags/status/pinned/scope 列。只比 text_hash+updated_at 会漏掉"改了 scope 但正文
 * 没变"的假一致（架构书 §5）。
 * @param {object} row 镜像行 @param {object} front 文件 front
 * @returns {boolean} true = 漂移
 */
function driftOf(row, front) {
  const scope = textOf(front?.scope).trim() || 'global'
  const cols = scopeColumns(scope)
  if (textOf(row.status) !== expectedStatus(front)) return true
  if (Number(row.pinned || 0) !== pinnedOf(front)) return true
  if (textOf(row.workspace) !== cols.workspace) return true
  if (textOf(row.role_id) !== cols.role_id) return true
  const tags = parseTags(row.tags)
  if (!tags.includes(`rule-scope:${scope}`)) return true
  if (!tags.includes(`rule-priority:${textOf(front.priority)}`)) return true
  return false
}

/**
 * 一致性视图：文件 vs 镜像行（计数，不返回正文）。
 *
 * - mirrored：文件有行且 text_hash / front 关键字段一致；
 * - missing：文件有、镜像无；
 * - stale：镜像有、文件有，但文本 hash、updated 时间或 front 关键字段（scope/priority/
 *   status/pinned）与镜像行不一致；
 * - orphaned：镜像有、文件无（含尚未归档的）。
 * - 候选（rule-candidate）不镜像，也不计入 missing（R8-08）。
 *
 * @param {{backend:any, rules:any}} args
 * @returns {{ok:boolean,error?:string,mirrored?:number,missing?:number,stale?:number,
 *   orphaned?:number,totalFiles?:number,totalRows?:number,checkedAt?:number}}
 */
export function mirrorStatus({ backend, rules } = {}) {
  const db = dbOf(backend)
  if (!db) return { ok: false, error: 'backend_unavailable' }
  const docs = resolveDocs(rules)
  const now = Date.now()
  try {
    const rows = db.prepare('SELECT id, origin, text_hash, status, updated_at, tags, workspace, role_id, pinned FROM nodes WHERE origin LIKE \'rule:%\'').all()
    const byKey = new Map()
    for (const row of rows) byKey.set(textOf(row.origin).slice(RULE_ORIGIN_PREFIX.length), row)
    const fileKeys = new Set()
    let mirrored = 0
    let stale = 0
    let missing = 0
    for (const doc of docs) {
      const front = doc?.front && typeof doc.front === 'object' ? doc.front : doc
      if (textOf(front?.type) === 'rule-candidate') continue
      const key = textOf(front?.key).trim()
      const body = textOf(doc?.text ?? doc?.body)
      if (!key) continue
      fileKeys.add(key)
      const row = byKey.get(key)
      if (!row) { missing += 1; continue }
      const hashOk = row.text_hash === contentHash(body)
      const fileUpdated = Date.parse(textOf(front?.updated))
      const newerFile = Number.isFinite(fileUpdated) && row.updated_at < fileUpdated
      if (hashOk && !newerFile && !driftOf(row, front)) mirrored += 1
      else stale += 1
    }
    let orphaned = 0
    for (const key of byKey.keys()) if (!fileKeys.has(key)) orphaned += 1
    return {
      ok: true,
      mirrored,
      missing,
      stale,
      orphaned,
      totalFiles: fileKeys.size,
      totalRows: rows.length,
      checkedAt: now,
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/** @param {any} backend @param {string} id @returns {object|null} */
function findNode(backend, { key, id } = {}) {
  const db = dbOf(backend)
  if (!db) return null
  try {
    if (id) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ? LIMIT 1').get(String(id))
      if (row) return row
    }
    if (key) {
      const origin = `${RULE_ORIGIN_PREFIX}${key}`
      const row = db.prepare('SELECT * FROM nodes WHERE origin = ? LIMIT 1').get(origin)
        || db.prepare("SELECT * FROM nodes WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT 1").get(`%${key}%`)
      if (row) return row
    }
    // 兜底：任何一个打 iron-rule 标签/来源的节点（旧库没有固定 id 时）。
    return db.prepare("SELECT * FROM nodes WHERE tags LIKE '%iron-rule%' OR origin LIKE '%iron-rule%' ORDER BY pinned DESC, updated_at DESC LIMIT 1").get() || null
  } catch {
    return null
  }
}

function parseNumberHint(...values) {
  for (const value of values) {
    const m = String(value ?? '').match(/(?:iron-rule|rule-no:)\s*[-:]?\s*(\d+)/)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > 0) return n
    }
  }
  return null
}

/**
 * 旧 DB 铁律节点 → 规则文件（幂等：已有同 key 文件则跳过）。
 *
 * 正文取节点 text；例外从正文里的「例外：…」拆出并从正文移除；拆不出给空数组。
 * origin 写 `legacy:<node id>` 作为迁移证据（front 白名单不允许额外的 legacy 字段，
 * 因此 `legacy:true` 只在返回值里标注，避免破坏严格 front schema）。
 *
 * @param {{backend:any,key?:string,number?:number,root?:string,rules?:string,
 *   legacyId?:string}} args
 * @returns {{ok:boolean,error?:string,path?:string,key?:string,number?:number,
 *   legacy?:boolean,skipped?:boolean,nodeId?:string,detail?:any}}
 */
export function importLegacyRule({
  backend, key = '', number = null, root = '', rules = '', git = true, legacyId = LEGACY_IRON_RULE_ID,
} = {}) {
  const base = root || rules || defaultRuleRoot()
  const requestedKey = textOf(key).trim()
  if (requestedKey && !isValidRuleKey(requestedKey)) return { ok: false, error: 'invalid_key' }
  const node = findNode(backend, { key: requestedKey, id: requestedKey ? '' : legacyId })
  if (!node) return { ok: false, error: 'legacy_not_found' }

  // 编号分配 + 墓碑复核 + 落盘必须在同一把仓库锁内：锁外算号会让并发导入撞号/分配器重复。
  const lock = acquireRepoLock(base)
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return importLocked({ backend, base, requestedKey, number, node, key, git, legacyId })
  } finally {
    lock.release()
  }
}

/**
 * `importLegacyRule` 的锁内实现（分配号 → 墓碑复核 → 幂等查既有 origin → 落盘）。
 * @param {{backend:any,base:string,requestedKey:string,number:any,node:any,key:string,
 *   git:boolean,legacyId:string}} args
 * @returns {object}
 */
function importLocked({ backend, base, requestedKey, number, node, git, legacyId }) {

  // 幂等：同一个旧节点已经导出过（origin=`legacy:<node id>`）就直接返回既有文件，
  // 不能再走分配器（每次分配都会得一个新编号，重复生成 iron-rule-N 副本）。
  const already = listRules(base).rules.find((doc) => textOf(doc.front.origin) === `legacy:${node.id}`)
  if (already) {
    return {
      ok: true,
      path: already.file,
      key: String(already.front.key),
      number: Number.isInteger(Number(already.front.number)) ? Number(already.front.number) : null,
      legacy: true,
      skipped: true,
      nodeId: node.id,
    }
  }

  const hinted = parseNumberHint(requestedKey, node.tags, node.origin, node.text)
  // 编号来源只有三种：调用方显式 → 正文/标签 hint → 仓储分配器。**没有 `|| 17` 回落**：
  // 17 只是某台机器的历史号，回落会让所有旧节点挤进同一编号并被判撞号。
  const explicit = Number(number) > 0 ? Number(number) : (hinted && Number.isInteger(hinted) ? hinted : null)
  // 墓碑占号：显式/推断的编号已彻底删除过 → 拒绝，不得用迁移把已作废编号复活。
  if (explicit && isRetiredNumber(base, explicit)) {
    return { ok: false, error: 'number_retired', detail: { number: explicit } }
  }
  const resolvedNumber = explicit || allocatableRuleNumber(base)
  const resolvedKey = requestedKey || `iron-rule-${resolvedNumber}`
  // 墓碑按 key 复核（不只是显式 number）：同 key 历史编号可能已被作废，复活 key 等于复活规则。
  if (readTombstones(base).some((item) => String(item.key) === resolvedKey)) {
    return { ok: false, error: 'number_retired', detail: { key: resolvedKey, number: resolvedNumber } }
  }
  const path = join(base, `${resolvedKey}.md`)
  if (existsSync(path)) {
    return { ok: true, path, key: resolvedKey, number: resolvedNumber, legacy: true, skipped: true, nodeId: node.id }
  }

  let body = textOf(node.text).trim()
  const exceptions = []
  const m = body.match(EXCEPTION_RE)
  if (m) {
    for (const part of m[1].split(/[、,，]/)) {
      const item = part.trim()
      if (item && !exceptions.includes(item)) exceptions.push(item)
    }
    body = body.replace(EXCEPTION_RE, '').trim()
  }
  // 旧节点可能是编译模板：去掉【规则·域】与作用域尾巴，正文只留指令本体。
  body = body.replace(RULE_TEMPLATE_HEAD_RE, '').replace(SCOPE_TAIL_RE, '').trim()
  body = body.replace(/[；;，,\s]+$/, '').trim()
  if (!body && exceptions.length) return { ok: false, error: 'legacy_body_empty' }

  const created = Number.isFinite(Number(node.created_at)) && Number(node.created_at) > 0
    ? new Date(Number(node.created_at)).toISOString().slice(0, 10)
    : undefined
  const updated = Number.isFinite(Number(node.updated_at)) && Number(node.updated_at) > 0
    ? new Date(Number(node.updated_at)).toISOString().slice(0, 10)
    : undefined

  const saved = writeRule(base, {
    front: {
      key: resolvedKey,
      type: 'iron-rule',
      number: resolvedNumber,
      priority: 'P0',
      scope: 'global',
      role: '',
      modality: 'must',
      action: '',
      object: '',
      conditions: [],
      exceptions,
      status: 'active',
      merged_into: '',
      superseded_by: '',
      ...(created ? { created } : {}),
      ...(updated ? { updated } : {}),
      version: 1,
      origin: `legacy:${node.id}`,
    },
    text: body,
  }, { git: git !== false, lockHeld: true })
  if (!saved.ok) return { ok: false, error: saved.error, detail: saved.detail }
  return {
    ok: true,
    path: saved.path,
    key: resolvedKey,
    number: resolvedNumber,
    legacy: true,
    skipped: false,
    nodeId: node.id,
  }
}

