/**
 * 规则仓储（R3a）门面：路径/io/解析/manifest/history/git/锁事务已按职责拆到 `rule-store/` 子模块；
 * 本文件保留写入口（writeRule/create/purge/update/revert）与写失败回滚编排。
 *
 * 边界：
 * - 本模块不认识 DB、不认识 HTTP、不调模型；镜像在 rule-mirror.js，路由在 rules-routes.js。
 * - 只允许 node 内置模块。校验口径复用 rules.js 的 detectSignals（隐私/模糊/祈使判定）。
 * - `updateRule`/`revertRule` 只负责"文件 + git + 历史"；镜像/AGENTS 渲染/审计由路由层编排。
 *
 * Why 文件优先：规则需要人可读、可 diff、可回滚；数据库列改一次就要迁移，规则正文却要
 * 被 owner 反复手改。文件 + git 才是可审计的真源，manifest/history 都是生成物。
 */

import { existsSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join, relative } from 'node:path'
import { normalizeRuleText, ruleKeyOf } from './rules.js'
import { defaultRuleRoot, baseDir, rulePath } from './rule-store/paths.js'
import { atomicWriteFile, durableWriteFile, fsyncDir, dirnameOf } from './rule-store/io.js'
import {
  RULE_FIELDS, RULE_TYPES, RULE_MODALITIES, RULE_PRIORITIES, RULE_STATUSES,
  RESERVED_NUMBERS, UNNUMBERED_RULE_KEYS, isUnnumberedRule,
  RULE_BODY_MAX, SUMMARY_MAX, RULE_NUMBER_MAX, RULE_FILE_MAX,
  RULE_PATCH_FIELDS, IMMUTABLE_RULE_FIELDS, RULE_STATUS_TRANSITIONS,
  isValidRuleKey, parseRuleDocument, ruleKeyOfFile, readRuleSource,
  serializeRuleDocument, dateOf, findRuleFile, normalizeRuleDoc, validateRule,
  readRule, readRuleLax, listRules,
} from './rule-store/parse.js'
import {
  MANIFEST_FILE, RETIRED_DIR, writeTombstone, readTombstones, isRetiredNumber,
  allocatableRuleNumber, fileRuleNumbers, occupancy, nextRuleNumber,
  computeManifest, regenerateManifest, readManifest,
} from './rule-store/manifest.js'
import {
  HISTORY_KEEP, DIFF_LINE_LIMIT, writeHistorySnapshot, readHistory, readSnapshot,
  diffLines, resolveRevision, removeHistoryEntry,
} from './rule-store/history.js'
import {
  RULE_DIRS, GITIGNORE_LINES, requireGitGate, ruleCommitState, commitRuleChanges,
  resetGitIndex, ensureRuleGitignore, isGitRepo, initRuleRepo, gitCommit, gitLog,
  gitShow, ensureRuleRepo, isGitDegraded, gitGate, commitStateOf, resetIndexPaths, runGit,
} from './rule-store/git.js'
import {
  TXN_DIR, LOCK_DIR, REPO_LOCK, REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock,
  writeTxn, readTxn, clearTxn, listTxns, recoverPendingTxn,
} from './rule-store/lock-txn.js'

// 子模块公开符号在门面原样再导出：路径与导出名保持不变，调用方无需改动。
export {
  defaultRuleRoot, atomicWriteFile, durableWriteFile,
  RULE_FIELDS, RULE_TYPES, RULE_MODALITIES, RULE_PRIORITIES, RULE_STATUSES,
  RESERVED_NUMBERS, UNNUMBERED_RULE_KEYS, isUnnumberedRule,
  RULE_BODY_MAX, SUMMARY_MAX, RULE_NUMBER_MAX, RULE_FILE_MAX,
  RULE_PATCH_FIELDS, IMMUTABLE_RULE_FIELDS, RULE_STATUS_TRANSITIONS,
  isValidRuleKey, parseRuleDocument, ruleKeyOfFile, readRuleSource,
  serializeRuleDocument, normalizeRuleDoc, validateRule,
  readRule, readRuleLax, listRules,
  MANIFEST_FILE, RETIRED_DIR, writeTombstone, readTombstones, isRetiredNumber,
  allocatableRuleNumber, fileRuleNumbers, occupancy, nextRuleNumber,
  computeManifest, regenerateManifest, readManifest,
  HISTORY_KEEP, DIFF_LINE_LIMIT, writeHistorySnapshot, readHistory, readSnapshot,
  diffLines, resolveRevision,
  RULE_DIRS, GITIGNORE_LINES, requireGitGate, ruleCommitState, commitRuleChanges,
  resetGitIndex, ensureRuleGitignore, isGitRepo, initRuleRepo, gitCommit, gitLog,
  gitShow, ensureRuleRepo,
  TXN_DIR, LOCK_DIR, REPO_LOCK, REPO_LOCK_STALE_MS, acquireRepoLock, withRepoLock,
  writeTxn, readTxn, clearTxn, listTxns, recoverPendingTxn,
}
/** 锁协议实现已抽到 rule-lock.js；这里保持旧导出名，调用方无需改动。 */

/**
 * 写一条规则：归一化 → 校验 → 历史快照 → 原子写 → manifest → git commit。
 *
 * 并发：同 key 的两个同步写入天然串行（Node 单线程 + 唯一 tmp 名）；跨进程 rename 原子，
 * 最后写入者胜出，但不会出现半文件。
 *
 * @param {string} root
 * @param {{front?:object,text?:string,body?:string}|object} input 可传 `{front,text}` 或扁平 front
 * @param {{fs?: typeof nodeFs, git?: boolean, exec?: Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,git?:object,error?:string,detail?:any}}
 */
export function writeRule(root, input, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  const rawFront = input?.front && typeof input.front === 'object' ? input.front : input
  const rawText = input?.text ?? input?.body ?? ''
  const normalized = normalizeRuleDoc(rawFront, rawText)
  // 先挡住路径：key 会进目录名/文件名，后面的 ensure（建目录）与锁都不能拿到越界 key。
  if (!isValidRuleKey(normalized.front.key)) {
    return { ok: false, error: 'invalid_rule', detail: [{ code: 'invalid_key', field: 'key', message: 'key 非法' }] }
  }
  // requireGit 闸门（R9-05）必须在**拿锁之前**：`.locks/` 本身也是落盘动作，缺 git 时不许动。
  const gate = gitGate(base, opts)
  if (!gate.ok) return gate

  const run = () => {
    // 首次写规则时初始化 git 仓库；git 缺失只降级（ensureRuleRepo 不抛），文件仍可写。
    const ensured = ensureRuleRepo({ root: base, git: opts.git !== false, fs, exec: opts.exec })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }

    const existing = listRules(base)
    // 编号唯一性用占用集合（文件名 ∪ front ∪ 墓碑）而不是"解析成功的规则"：
    // 手改坏的 iron-rule-N.md 解析失败也必须挡住新建/改写撞号（R9-02）。
    // 自己那条要剔出去（改自己的正文/版本不能被自己判成撞号）。
    const numbers = new Map()
    for (const doc of existing.rules) {
      if (doc.front.key === normalized.front.key) continue
      if (doc.front.type !== 'iron-rule') continue
      if (!(Number.isInteger(doc.front.number) && doc.front.number > 0)) continue
      numbers.set(doc.front.number, doc.front.key)
    }
    for (const n of fileRuleNumbers(base, { fs })) {
      if (n === normalized.front.number) continue
      if (!numbers.has(n)) numbers.set(n, `iron-rule-${n}.md`)
    }
    // R9-20 ②：墓碑也进编号校验 map（写前拒绝 number_retired，不靠 health 事后报红）。
    // 墓碑优先于同名文件/其它规则：同一 key 重建后再 purge 的墓碑号也不得复活。
    for (const item of readTombstones(base, { fs })) {
      const n = Number(item?.number)
      if (Number.isInteger(n) && n > 0) numbers.set(n, `retired:${item.key}`)
    }
    const check = validateRule(normalized.front, normalized.text, { numbers })
    if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

    const serialized = serializeRuleDocument(normalized)
    if (!serialized.ok) return { ok: false, error: 'serialize_failed', detail: serialized.error }
    // 写入器不得产出自己读不回的文件：序列化后立即按解析器复读一次，
    // 失败就拒绝落盘（否则文件占号但面板/注入/AGENTS 全部看不见）。
    const roundTrip = parseRuleDocument(serialized.text)
    if (!roundTrip.ok) {
      return { ok: false, error: 'serialize_unreadable', detail: roundTrip.error }
    }

    const target = rulePath(base, normalized.front)
    const oldFile = findRuleFile(base, normalized.front.key)
    let snapshot = null
    let oldSource = null
    if (oldFile) {
      const old = readRuleSource(oldFile, { fs })
      if (!old.ok) return { ok: false, error: 'snapshot_read_failed', detail: old.error }
      oldSource = old.text
      snapshot = writeHistorySnapshot(base, normalized.front.key, oldSource, { fs })
      if (!snapshot.ok) return { ok: false, error: 'snapshot_failed', detail: snapshot.error }
    }
    // 显式路径：本文件 + manifest（+ 旧文件若被移走）；不用 add -A，避免把候选/快照带进提交。
    const paths = Array.isArray(opts.commitPaths)
      ? [...new Set([...opts.commitPaths, relative(base, target), MANIFEST_FILE, ...(oldFile && oldFile !== target ? [relative(base, oldFile)] : [])])]
      : [relative(base, target), MANIFEST_FILE, ...(oldFile && oldFile !== target ? [relative(base, oldFile)] : [])]
    const rollback = () => rollbackWriteAttempt(base, {
      target, oldFile, oldSource, key: normalized.front.key, historyRev: snapshot?.rev || '', paths, fs, exec: opts.exec,
    })

    // 正文与 history 都走 durableWriteFile（tmp+fsync+rename+fsync dir）：R9-03 起"原子"升级为"持久"。
    const written = durableWriteFile(target, serialized.text, { fs })
    if (!written.ok) {
      const cleanup = snapshot?.rev ? removeHistoryEntry(base, normalized.front.key, snapshot.rev, fs) : null
      return { ok: false, error: 'write_failed', detail: written.error, rollbackFailures: cleanup ? [cleanup] : [] }
    }
    if (oldFile && oldFile !== target) {
      try { fs.unlinkSync(oldFile) } catch (err) {
        // 两份文件同时存在会让 listRules 报编号冲突；回滚新文件，保持旧状态。
        const rolled = rollback()
        return {
          ok: false, error: 'move_failed', detail: String(err?.message || err),
          rolledBack: rolled.ok, rollbackFailures: rolled.failures,
        }
      }
    }

    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) {
      const rolled = rollback()
      return {
        ok: false, error: 'manifest_failed', detail: manifest.error,
        rolledBack: rolled.ok, rollbackFailures: rolled.failures,
      }
    }

    let git = null
    if (opts.git !== false) {
      const done = commitRuleChanges(base, `rules: ${normalized.front.key} v${normalized.front.version}`, {
        exec: opts.exec,
        paths,
      })
      if (!done.ok && !isGitDegraded(done.error)) {
        // 非降级提交失败：真源必须回到写前（文件/manifest/history/index 四处），不得 ok:true 丢提交。
        const rolled = rollback()
        return {
          ok: false, error: 'commit_failed', detail: { stage: 'commit', error: done.error || 'git_failed' },
          rolledBack: rolled.ok, rollbackFailures: rolled.failures, commitState: 'failed',
        }
      }
      git = done.ok
        ? { ok: true, committed: Boolean(done.committed), message: done.message }
        : { ok: false, committed: false, degraded: true, message: done.message, error: done.error || 'git_failed' }
    }
    return {
      ok: true,
      rule: {
        front: normalized.front,
        text: normalized.text,
        bodyStart: parseRuleDocument(serialized.text).bodyStart,
        file: target,
      },
      path: target,
      history: snapshot?.rev || '',
      manifest: manifest.manifest,
      git,
      commitState: commitStateOf(git, { git: opts.git }),
    }
  }

  // 锁外默认自己拿仓库级锁；锁内调用方传 lockHeld:true（create/update/apply/seed）。
  if (opts.lockHeld === true) return run()
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return run()
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------
// 新建 / 停用 / 恢复（面板直写，不经提案决策流水线）
// ---------------------------------------------------------------------------

/**
 * 新建规则可接受的 draft 字段白名单。
 *
 * 刻意**不含** key/type 之外的元数据（number/created/version/origin/status）：编号是"永不复用"的
 * 全局资源、created 是历史锚点、origin 是归属审计，都必须由仓储分配/盖章，不能由面板随便写。
 * 也不含 modality——模态从正文推断，避免"正文说禁止、front 写 must"的自相矛盾。
 */
export const CREATE_DRAFT_FIELDS = Object.freeze([
  'text', 'type', 'priority', 'scope', 'role', 'conditions', 'exceptions', 'action', 'object',
])
export const CREATE_RULE_TYPES = Object.freeze(['iron-rule', 'rule'])

/**
 * 模态推断（新建规则用）：与 rule-reconcile.js 的 `modalityOf` 同一口径。
 *
 * 为什么不 import：rule-reconcile 反向 import 本模块的常量（RESERVED_NUMBERS/RULE_BODY_MAX 等），
 * 再互相 import 就成环。这里复制三条正则，**两处必须同改**（有单测 `createRule：模态从正文推断` 盯着）。
 */
const MANUAL_NEG_RE = /(禁止|不得|不许|不准|不能|不必|无需|不用|毋须|切勿|勿|不要|别再|别用|别把|别删|别改|别(?!人|的|处|致|样)|严禁|避免|never|must not|do not|don't)/i
const MANUAL_ONLY_RE = /(只能|只准|只允许|仅能|仅允许|只用|只保留|只读|只做|只接受|只支持|只(?:用|留|存|删|选|取|做|算|跑|走|看|读|写|发|收|要|能|须|需|有|是|可|会|应|得|让|把|给|对|向|从|在|为|于))/
const MANUAL_EXCEPT_RE = /除(?:了)?[^，,。；;]{1,40}外/

/** @param {string} text @returns {'must'|'must_not'|'only'|'except'} */
function manualModalityOf(text) {
  const s = String(text ?? '')
  if (MANUAL_NEG_RE.test(s)) return 'must_not'
  if (MANUAL_EXCEPT_RE.test(s)) return 'except'
  if (MANUAL_ONLY_RE.test(s)) return 'only'
  return 'must'
}

/**
 * 新建一条规则（面板直写路径，**不经过** writer 决策/提案流水线）。
 *
 * 身份分配（仓储盖章，面板不可指定）：
 * - `number = nextRuleNumber(已有编号)`：空号 6 不复用，已有 1–17 时从 18 起；
 * - `key`：iron-rule → `iron-rule-<number>`；rule → `rule-<domain>-<hash8>`（domain 从正文推断，
 *   hash8 = 归一化正文 sha256 前 8 位）；
 * - `origin = manual:<userId|''>`、`version = 1`、`created/updated = 今天`、`status = active`。
 *
 * 失败语义：形状问题 → `invalid_draft`（未知字段/空正文/类型非法/数组非法）；内容问题 →
 * `invalid_rule` + validateRule 的错误数组（正文超 500/非祈使/隐私/铁律模糊词…）；撞已有 key →
 * `duplicate_rule`（同 key 覆盖会吞掉别人的规则正文，必须显式拒绝，改用 update/revert 通道）。
 * 以上全部在**写文件之前**判定，失败不留半成品、不烧编号。
 *
 * 单 commit：先写文件（`git:false`）再一次性 `rule: create <key> (#n)`，与默认播种同理——
 * 一条规则的落盘应当只有一个提交点。
 *
 * @param {{root?:string, draft?:object, identity?:object, traceId?:string, now?:number}} args
 *   identity/traceId 只为与路由/审计同签名（本模块不写 DB）。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, path?:string, key?:string, number?:number,
 *   type?:string, version?:number, commit?:object|null, error?:string, detail?:any}}
 */
export function createRule({ root = '', draft = {}, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  // requireGit 闸门（R9-05）：先于校验/锁/建仓，路由之外的调用方（脚本/迁移）同样被拦。
  const gate = gitGate(base, opts)
  if (!gate.ok) return gate
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'draft_must_be_object' } }
  }
  const unknown = Object.keys(draft).filter((field) => !CREATE_DRAFT_FIELDS.includes(field))
  if (unknown.length) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'unknown_field', fields: unknown } }
  }
  const type = String(draft.type ?? 'rule').trim() || 'rule'
  if (!CREATE_RULE_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'invalid_type', type, allowed: CREATE_RULE_TYPES } }
  }
  const text = String(draft.text ?? '').trim()
  if (!text || !normalizeRuleText(text)) {
    return { ok: false, error: 'invalid_draft', detail: { reason: 'empty_text' } }
  }
  const chars = Array.from(text).length
  if (chars > RULE_BODY_MAX) {
    return {
      ok: false,
      error: 'invalid_rule',
      detail: [{ code: 'body_too_long', field: null, message: `正文 ${chars} 字，超过硬顶 ${RULE_BODY_MAX}` }],
    }
  }
  for (const field of ['conditions', 'exceptions']) {
    if (draft[field] === undefined) continue
    if (!Array.isArray(draft[field])) {
      return { ok: false, error: 'invalid_draft', detail: { reason: `${field}_must_be_array`, field } }
    }
  }

  // 仓库锁内：重读磁盘 → 分配号 → 落盘 → manifest → 单次提交。锁外算号会被并发抢号/复活墓碑号。
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error, detail: { root: base } }
  try {
    if (opts.git !== false) {
      // 仓就绪（含 git init）：单 commit 需要一个已存在的仓库；缺 git 只降级（ensureRuleRepo 不抛）。
      const ensured = ensureRuleRepo({ root: base, git: true, fs, ...(opts.exec ? { exec: opts.exec } : {}) })
      if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: { root: base, error: ensured.error } }
    }

    const listed = listRules(base)
    // 编号只属于 iron-rule：普通规则 number=null（不占号、不压 nextNumber）。
    // 占用 = 文件名编号 ∪ 解析成功编号 ∪ 墓碑：非法 front 的文件也占号，绝不复用（R9-02）。
    const number = type === 'iron-rule'
      ? nextRuleNumber(occupancy(base, { fs, listed }))
      : null
    if (type === 'iron-rule' && number > RULE_NUMBER_MAX) {
      return { ok: false, error: 'number_exhausted', detail: { max: RULE_NUMBER_MAX } }
    }
    // `rule:<domain>-<hash8>` → `rule-<domain>-<hash8>`（面板/文件里的 key 形状）。
    const key = type === 'iron-rule' ? `iron-rule-${number}` : ruleKeyOf(text).replace(/^rule:/, 'rule-')
    if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_draft', detail: { reason: 'invalid_key', key } }
    if (listed.rules.some((doc) => String(doc.front.key) === key) || existsSync(join(base, `${key}.md`))) {
      return { ok: false, error: 'duplicate_rule', detail: { key, reason: 'key_exists' } }
    }

    const userId = String(identity?.userId ?? '').slice(0, 128)
    const conditions = Array.isArray(draft.conditions)
      ? draft.conditions.map((item) => String(item ?? '').trim()).filter(Boolean)
      : []
    const exceptions = Array.isArray(draft.exceptions)
      ? draft.exceptions.map((item) => String(item ?? '').trim()).filter(Boolean)
      : []
    const date = dateOf(now)
    const front = {
      key,
      type,
      number,
      priority: String(draft.priority ?? (type === 'iron-rule' ? 'P0' : 'P1')).trim().toUpperCase(),
      scope: String(draft.scope ?? 'global').trim() || 'global',
      role: String(draft.role ?? '').trim(),
      modality: manualModalityOf(text),
      action: String(draft.action ?? '').trim(),
      object: String(draft.object ?? '').trim(),
      conditions,
      exceptions,
      status: 'active',
      merged_into: '',
      superseded_by: '',
      created: date,
      updated: date,
      version: 1,
      origin: `manual:${userId}`,
    }

    // git:false：文件 + manifest 由 writeRule 一次做完，提交由下面这一条统一出。
    const written = writeRule(base, { front, text }, { git: false, fs, lockHeld: true })
    if (!written.ok) {
      // 回滚证据必须原样上抛：调用方/测试要能区分"没写"与"写了又回滚干净"（R9-03）。
      return {
        ok: false, error: written.error || 'write_failed', detail: written.detail,
        ...(written.rolledBack !== undefined ? { rolledBack: written.rolledBack } : {}),
        ...(written.rollbackFailures ? { rollbackFailures: written.rollbackFailures } : {}),
      }
    }

    const message = `rule: create ${key} (#${number})`
    const commitPaths = [relative(base, written.path), MANIFEST_FILE]
    let commit = null
    if (opts.git !== false) {
      commit = commitRuleChanges(base, message, { exec: opts.exec, paths: commitPaths })
      if (!commit.ok && isGitDegraded(commit.error)) {
        // 降级：文件/manifest 已落盘，只是没有版本记录（架构书 §6「git 不可用」语义）。
        return {
          ok: true, rule: written.rule, path: written.path, key, number, type, version: 1,
          origin: front.origin, commit, manifest: written.manifest || null, commitState: 'degraded',
        }
      }
      if (!commit.ok) {
        // commit 失败必须回滚：删新文件 + 重建 manifest + 清 git index，不留"幻影规则/幻影版本"。
        const rolled = rollbackCreatedFile(base, written.path, commitPaths, { fs, exec: opts.exec })
        return {
          ok: false,
          error: 'commit_failed',
          detail: { stage: 'commit', error: commit.error },
          rolledBack: rolled.ok,
          rollbackFailures: rolled.failures,
          key,
          number,
          type,
          commitState: 'failed',
        }
      }
    }
    return {
      ok: true,
      rule: written.rule,
      path: written.path,
      key,
      number,
      type,
      version: 1,
      origin: front.origin,
      commit,
      manifest: written.manifest || null,
      commitState: commitStateOf(commit, { git: opts.git }),
    }
  } finally {
    lock.release()
  }
}

/**
 * 停用一条规则（复用 R5 `updateRule`，patch `{status:'retired'}`）。
 *
 * 停用 = 保留文件/编号/正文/历史，只把 status 置 retired：pinned 镜像因此归 0（rule-mirror 按
 * status 投影），但编号继续占位——**编号永不复用**，manifest 的 nextNumber 不因停用回退。
 *
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, status?:string, retired?:boolean, changed?:boolean,
 *   commit?:object|null, version?:number, previousVersion?:number, error?:string, detail?:any}}
 */
export function retireRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const got = readRule(baseDir(root), key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  if (String(got.rule.front.status) === 'retired') {
    return { ok: false, error: 'already_retired', rule: got.rule, status: 'retired' }
  }
  const updated = updateRule({ root, key, patch: { status: 'retired' }, identity, traceId, now }, opts)
  if (!updated.ok) return updated
  return { ...updated, status: 'retired', retired: true }
}

/**
 * 恢复一条已停用规则（patch `{status:'active'}`；不新建文件、不改编号/正文/版本历史）。
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean, rule?:object, status?:string, reactivated?:boolean, changed?:boolean,
 *   commit?:object|null, version?:number, previousVersion?:number, error?:string, detail?:any}}
 */
export function reactivateRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const got = readRule(baseDir(root), key)
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
  if (String(got.rule.front.status) !== 'retired') {
    return { ok: false, error: 'not_retired', rule: got.rule, status: String(got.rule.front.status) }
  }
  const updated = updateRule({ root, key, patch: { status: 'active' }, identity, traceId, now }, opts)
  if (!updated.ok) return updated
  return { ...updated, status: 'active', reactivated: true }
}

/**
 * 物理删除规则文件：优先 `git rm`（删除与暂存一体，随后一次 commit 就是一次删除记录），
 * git 不可用/不是仓库/文件未跟踪时降级 `fs.unlinkSync`——删除动作本身不能因 git 缺失失败。
 * @param {string} base @param {string} file
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean,viaGit?:boolean,error?:string,detail?:any}}
 */
function removeRuleFile(base, file, opts = {}) {
  const fs = opts.fs || nodeFs
  if (opts.git !== false) {
    const repo = isGitRepo(base, { exec: opts.exec })
    if (repo.ok) {
      const rel = relative(base, file)
      // 只允许仓库内相对路径；越界路径说明文件不该在这里，直接走 unlink，不喂给 git。
      if (rel && !rel.startsWith('..')) {
        const rm = runGit(base, ['rm', '-q', '-f', '--', rel], { exec: opts.exec })
        if (rm.ok) return { ok: true, viaGit: true }
      }
    }
  }
  try {
    fs.unlinkSync(file)
    return { ok: true, viaGit: false }
  } catch (err) {
    return { ok: false, error: 'delete_failed', detail: String(err?.message || err) }
  }
}

/**
 * 彻底删除一条规则（purge）：文件物理删除 + manifest 墓碑 + history 快照 + 单 commit。
 *
 * 与 `retireRule` 的区别：停用只切 status，文件/编号/正文/历史全保留，可随时重新启用；
 * purge 让规则从列表、提案与镜像召回里彻底消失，但**编号永不复用**——编号写进
 * `manifest.json#retired` 墓碑，未来自动编号把它算作已占用（删 17 → 新建 18；删 18 → 新建 19）。
 *
 * 顺序刻意是"快照 → **写墓碑并 fsync** → 删文件 → 重建 manifest → 单 commit"：
 * - 先写快照：最后一版正文必须留在 `history/<key>/`，删除后仍可追溯；
 * - 墓碑先落盘：任何后续失败都不得留下"文件已删、墓碑没写"（否则编号会被回收）；
 * - 墓碑进 `retired/<key>.json`（append-only 真源），manifest.retired 只是可重建的汇总；
 * - 安全行（number=0）只删文件、不写墓碑：它不占编号，墓碑会把 nextNumber 压回 1。
 *
 * 回滚：删文件失败 → 删本次新建的墓碑；manifest 失败/commit 失败 → 恢复文件 + 删墓碑 +
 * 重建 manifest + `git reset -- <paths>`，逐项失败都记进 rollbackFailures，不静默。
 *
 * @param {{root?:string, key:string, identity?:object, traceId?:string, now?:number}} args
 *   identity/traceId 只为与路由/审计同签名（本模块不写 DB）。
 * @param {{fs?:typeof nodeFs, git?:boolean, exec?:Function}} [opts]
 * @returns {{ok:boolean,key?:string,number?:number,version?:number,historySnapshot?:string,
 *   tombstone?:string,commit?:object|null,error?:string,detail?:any,rolledBack?:boolean,
 *   rollbackFailures?:string[]}}
 */
/** 删墓碑（purge 事务落盘失败时撤销）；返回失败描述或 null。 @param {object|null} tomb @param {typeof nodeFs} fs */
function dropTombstoneSafe(tomb, fs) {
  if (!tomb || !tomb.path) return null
  try { fs.unlinkSync(tomb.path); fsyncDir(dirnameOf(tomb.path), fs); return null } catch (err) {
    return `tombstone:${err?.message || err}`
  }
}

export function purgeRule({ root = '', key, identity = {}, traceId = '', now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  // requireGit 闸门（R9-05）：先于锁/墓碑/删文件，缺 git 时一条规则都不许被删。
  const gate = gitGate(base, opts)
  if (!gate.ok) return gate
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    // 仓就绪由 store 自己负责（与 writeRule 同口径）：路由不再在锁外预先 ensure，
    // 否则每次写都要 init/重建 manifest 两遍（R9-05 收口）。
    const ensured = ensureRuleRepo({ root: base, git: opts.git !== false, fs, exec: opts.exec })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
    const got = opts.skipValidation === true ? readRuleLax(base, key) : readRule(base, key)
    if (!got.ok) return { ok: false, error: got.error, detail: got.detail }
    const doc = got.rule
    const old = readRuleSource(doc.file, { fs })
    if (!old.ok) return { ok: false, error: old.error }
    const oldText = old.text
    // 同名旧候选（proposals/<key>.md）必须与正式规则一起删：只删一份会让 purge 后
    // 列表仍命中同名文件（duplicate_key 红项/幽灵规则）。
    const extras = []
    const legacyPath = join(base, 'proposals', `${key}.md`)
    if (legacyPath !== doc.file && existsSync(legacyPath)) {
      const legacy = readRuleSource(legacyPath, { fs })
      if (legacy.ok) extras.push({ path: legacyPath, text: legacy.text })
    }
    const snap = writeHistorySnapshot(base, key, oldText, { fs })
    if (!snap.ok) return { ok: false, error: 'snapshot_failed', detail: snap.error }

    const number = Number(doc.front.number)
    const tombstone = doc.front.type === 'iron-rule' && Number.isInteger(number) && number > 0
    const at = new Date(Number.isFinite(now) ? Number(now) : Date.now()).toISOString()
    let tomb = null
    if (tombstone) {
      tomb = writeTombstone(base, { key: String(doc.front.key), number, at, reason: 'purge' }, { fs })
      if (!tomb.ok) return { ok: false, error: 'tombstone_failed', detail: tomb.error }
    }

    // 事务锚点（R9-21）：墓碑已 durable、文件将删除；崩溃后恢复器按 op=purge 收敛。
    // proposalId 用 `purge:<key>:#<n>` 作 commit 标记（与既有 commit 文案兼容，不新增后缀）。
    const txnId = `purge-${key}-${Number(now) || Date.now()}-${process.pid}`
    const txn = writeTxn(base, {
      id: txnId,
      op: 'purge',
      proposalId: `rule: purge ${key} (#${number})`,
      createdAt: at,
      files: [
        { key: String(doc.front.key), path: doc.file, oldText },
        ...extras.map((item) => ({ key: String(doc.front.key), path: item.path, oldText: item.text })),
      ],
      ...(tomb ? { tombstone: tomb.path } : {}),
    }, { fs })
    const clearTxnIfAny = () => {
      if (!txn.ok) return
      try { clearTxn(base, txnId, { fs }) } catch { /* 清不掉只影响自愈，不否定已落盘结果 */ }
    }
    if (!txn.ok) {
      const failures = [dropTombstoneSafe(tomb, fs)].filter(Boolean)
      return { ok: false, error: 'txn_failed', detail: txn.error, rolledBack: failures.length === 0, rollbackFailures: failures }
    }

    const restoreFile = () => {
      for (const target of [{ path: doc.file, text: oldText }, ...extras]) {
        const restored = durableWriteFile(target.path, target.text, { fs })
        if (!restored.ok) return `restore:${restored.error}`
      }
      return null
    }
    const dropTombstone = () => {
      if (!tomb) return null
      try { fs.unlinkSync(tomb.path); fsyncDir(dirnameOf(tomb.path), fs); return null } catch (err) {
        return `tombstone:${err?.message || err}`
      }
    }

    const removedFiles = []
    let removed = { ok: true }
    for (const target of [doc.file, ...extras.map((item) => item.path)]) {
      const one = removeRuleFile(base, target, { ...opts, fs })
      if (!one.ok) { removed = one; break }
      removedFiles.push(target)
    }
    if (!removed.ok) {
      // 删到一半失败：把已删文件还原，避免“正文没了、墓碑/txn 还在”的半态固化。
      const restored = restoreFile()
      const failures = [restored, dropTombstone()].filter(Boolean)
      clearTxnIfAny()
      return { ...removed, rolledBack: failures.length === 0, rollbackFailures: failures }
    }

    // 显式路径：被删文件（git rm 已暂存，git add 也能记录删除）+ manifest + 墓碑。
    const paths = [...removedFiles.map((file) => relative(base, file)), MANIFEST_FILE,
      ...(tomb ? [relative(base, tomb.path)] : [])]
    const manifest = regenerateManifest(base, { fs })
    if (!manifest.ok) {
      const failures = [restoreFile(), dropTombstone()].filter(Boolean)
      const rebuilt = regenerateManifest(base, { fs, allowShrink: true })
      if (!rebuilt.ok) failures.push(`manifest:${rebuilt.error}`)
      // 失败也要清 index：`git rm` 的删除已暂存，文件却已还原，留着就是幻影删除（R9-03）。
      const reset = resetIndexPaths(base, paths, { exec: opts.exec })
      if (!reset.ok) failures.push(`index:${reset.error}`)
      clearTxnIfAny()
      return { ok: false, error: 'manifest_failed', detail: manifest.error, rolledBack: failures.length === 0, rollbackFailures: failures }
    }

    if (opts.git === false) {
      clearTxnIfAny()
      return {
        ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
        historySnapshot: snap.rev, tombstone: tomb?.path || '', commit: null, commitState: 'degraded',
      }
    }

    const commit = commitRuleChanges(base, `rule: purge ${key} (#${number})`, { exec: opts.exec, paths })
    if (!commit.ok) {
      // git 不可用是降级（文件已删、commit 跳过）；只有真的提交失败才回滚。
      if (isGitDegraded(commit.error)) {
        clearTxnIfAny()
        return {
          ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
          historySnapshot: snap.rev, tombstone: tomb?.path || '', commit, commitState: 'degraded',
        }
      }
      const failures = [restoreFile(), dropTombstone()].filter(Boolean)
      const rebuilt = regenerateManifest(base, { fs, allowShrink: true })
      if (!rebuilt.ok) failures.push(`manifest:${rebuilt.error}`)
      const reset = resetIndexPaths(base, paths, { exec: opts.exec })
      if (!reset.ok) failures.push(`index:${reset.error}`)
      clearTxnIfAny()
      return {
        ok: false, error: 'commit_failed', detail: { stage: 'commit', error: commit.error },
        rolledBack: failures.length === 0, rollbackFailures: failures, commitState: 'failed',
      }
    }
    clearTxnIfAny()
    return {
      ok: true, key: String(doc.front.key), number, version: Number(doc.front.version) || 1,
      historySnapshot: snap.rev, tombstone: tomb?.path || '', commit,
      commitState: commitStateOf(commit, { git: opts.git }),
    }
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------
// 编辑 / 按版本回写（R5）
// ---------------------------------------------------------------------------

/**
 * 白名单补丁 → 新 front + 新正文（纯函数；不改入参、不写盘）。
 * 条件/例外**不做过滤**（空项/非字符串原样交给 validateRule 报错），否则"空项"会被悄悄吃掉。
 * @param {object} front 当前已归一化 front
 * @param {object} patch 已确认字段合法的补丁
 * @param {number} version @param {string} updated @param {string} text
 * @returns {{front:object,text:string}}
 */
function applyPatch(front, patch, version, updated, text) {
  const next = { ...front }
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) next.priority = String(patch.priority ?? '').trim().toUpperCase()
  if (Object.prototype.hasOwnProperty.call(patch, 'scope')) next.scope = String(patch.scope ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'role')) next.role = String(patch.role ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) next.status = String(patch.status ?? '').trim()
  if (Object.prototype.hasOwnProperty.call(patch, 'conditions')) {
    next.conditions = Array.isArray(patch.conditions)
      ? patch.conditions.map((item) => (typeof item === 'string' ? item.trim() : item))
      : patch.conditions
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'exceptions')) {
    next.exceptions = Array.isArray(patch.exceptions)
      ? patch.exceptions.map((item) => (typeof item === 'string' ? item.trim() : item))
      : patch.exceptions
  }
  next.version = version
  next.updated = updated
  return { front: next, text }
}

/** 编辑是否真的改了东西（version/updated 是流程字段，不算"用户改了内容"）。 */
function patchChanged(front, text, nextFront, nextText) {
  if (String(text) !== String(nextText)) return true
  for (const field of ['priority', 'scope', 'role', 'status']) {
    if (String(front[field] ?? '') !== String(nextFront[field] ?? '')) return true
  }
  for (const field of ['conditions', 'exceptions']) {
    if (JSON.stringify(front[field] || []) !== JSON.stringify(nextFront[field] || [])) return true
  }
  return false
}

/**
 * 编辑一条规则（R5）：白名单字段 → 同一 validateRule → version+1 → 历史快照 → 原子写 → git。
 *
 * 失败语义：写入前失败什么都不动；`writeRule` 中途失败（manifest/git 等后段）时用**写入前快照**
 * 把旧文件恢复回去，并返回 `rolledBack:true` —— 面板看到"没改成功"时文件也必须真的是旧版。
 *
 * 并发：本函数是同步的，同进程多次调用天然串行；跨进程由 writeRule 内部的同 key 锁保证
 * 落盘/快照不交错。version 来自调用开始时的磁盘真源，所以串行编辑得到 2,3,4… 不会覆盖。
 *
 * @param {{root?:string,key:string,patch:object,identity?:object,traceId?:string,now?:number}} args
 *   identity/traceId 只为与路由/审计同签名，本模块不写 DB。
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,changed?:boolean,
 *   commit?:object|null,version?:number,previousVersion?:number,error?:string,detail?:any,
 *   rolledBack?:boolean}}
 */
export function updateRule({ root = '', key, patch, now = Date.now() } = {}, opts = {}) {
  const base = baseDir(root)
  const fs = opts.fs || nodeFs
  // requireGit 闸门（R9-05）：先于锁/读盘，缺 git 时不产生任何状态变化。
  const gate = gitGate(base, opts)
  if (!gate.ok) return gate
  // 锁外先拿仓库级锁：重读磁盘 → 校验 → 落盘 → manifest → 提交 全在同一临界区。
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return updateRuleLocked({ root: base, key, patch, now }, { ...opts, fs, lockHeld: true })
  } finally {
    lock.release()
  }
}

/**
 * `updateRule` 的锁内实现（调用方必须已持仓库锁）。
 * @param {{root?:string,key:string,patch:object,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} opts
 * @returns {object}
 */
function updateRuleLocked({ root = '', key, patch, now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  // 本函数用 `writeRule(git:false)` 自己控制提交文案，writeRule 因此不会 init 仓库；
  // 建仓必须由 updateRule 自己负责，否则首次编辑永远 commit_failed（not a git repository）。
  if (opts.git !== false) {
    const ensured = ensureRuleRepo({ root: base, git: true, fs, ...(opts.exec ? { exec: opts.exec } : {}) })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
  }
  const got = readRule(base, key)
  if (!got.ok) return got
  const doc = got.rule

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid_patch', detail: { reason: 'patch_must_be_object' } }
  }
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE_RULE_FIELDS.includes(field)) {
      return { ok: false, error: 'immutable_field', detail: { field } }
    }
    if (!RULE_PATCH_FIELDS.includes(field)) {
      return { ok: false, error: 'invalid_patch', detail: { field, reason: 'field_not_patchable' } }
    }
  }

  const current = doc.front
  const currentStatus = String(current.status ?? '')
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const target = String(patch.status ?? '').trim()
    if (target !== currentStatus && !(RULE_STATUS_TRANSITIONS[currentStatus] || []).includes(target)) {
      return {
        ok: false,
        error: 'invalid_patch',
        detail: {
          field: 'status',
          reason: 'invalid_status_transition',
          from: currentStatus,
          to: target,
          allowed: RULE_STATUS_TRANSITIONS[currentStatus] || [],
        },
      }
    }
  }

  const text = Object.prototype.hasOwnProperty.call(patch, 'text') ? String(patch.text ?? '') : doc.text
  const version = Number(current.version) + 1
  const nextDoc = applyPatch(current, patch, version, dateOf(now), text)

  // 编号唯一性：把自己剔出去，否则"改内容"会被自己那条规则判成撞号。
  const numbers = new Map()
  for (const other of listRules(base).rules) {
    if (String(other.front.key) === String(key)) continue
    if (!(Number.isInteger(other.front.number) && other.front.number > 0)) continue
    numbers.set(other.front.number, other.front.key)
  }
  const check = validateRule(nextDoc.front, nextDoc.text, { numbers })
  if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

  if (!patchChanged(current, doc.text, nextDoc.front, nextDoc.text)) {
    return {
      ok: true,
      changed: false,
      rule: doc,
      path: doc.file,
      history: '',
      commit: null,
      // 无写入就没有版本状态：留 null 比谎报 committed/degraded 诚实。
      commitState: null,
      version: Number(current.version),
      previousVersion: Number(current.version),
    }
  }

  let oldSource
  try { oldSource = fs.readFileSync(doc.file, 'utf8') } catch (err) {
    return { ok: false, error: 'snapshot_read_failed', detail: String(err?.message || err) }
  }

  // git:false 由本函数自己控制 commit 文案；若让 writeRule 提交，消息会是 `rules: <key> v<n>`，
  // 面板/审计需要的是 `rule: update ...`，所以这里统一由 updateRule 提交一次。
  const saved = writeRule(base, nextDoc, { fs, git: false, lockHeld: true })
  // writeRule 的失败路径已自带四处回滚（R9-03），这里不再补第二次 restore：
  // 二次 restore 用真 fs、且会掩盖 history/manifest/index 是否真的回滚干净（旧测试假绿成因）。
  if (!saved.ok) return saved

  const paths = [relative(base, saved.path), MANIFEST_FILE, ...(saved.path !== doc.file ? [relative(base, doc.file)] : [])]
  let commit = null
  if (opts.git !== false) {
    commit = commitRuleChanges(base, `rule: update ${key} v${version}`, { exec: opts.exec, paths })
    if (!commit.ok && isGitDegraded(commit.error)) {
      // 降级：文件/manifest/history 都已落盘，仅无版本记录（git 不可用 ≠ 提交失败）。
      return {
        ok: true, changed: true, rule: saved.rule, path: saved.path, history: saved.history || '',
        commit, version, previousVersion: Number(current.version), commitState: 'degraded',
      }
    }
    if (!commit.ok) {
      // commit 失败必须回滚：文件/manifest/本事务新增 history 条目/git index 四处一起回。
      const rolled = rollbackRuleWrite(base, {
        file: doc.file, oldSource, key, historyRev: saved.history, paths, fs, exec: opts.exec,
      })
      return {
        ok: false,
        error: 'commit_failed',
        detail: { stage: 'commit', error: commit.error },
        rolledBack: rolled.ok,
        rollbackFailures: rolled.failures,
        version: Number(current.version),
        previousVersion: Number(current.version),
        commitState: 'failed',
      }
    }
  }
  return {
    ok: true,
    changed: true,
    rule: saved.rule,
    path: saved.path,
    history: saved.history || '',
    commit,
    version,
    previousVersion: Number(current.version),
    commitState: commitStateOf(commit, { git: opts.git }),
  }
}

/**
 * 把指定版本（history 快照或 git 版本）的正文/front **作为新版本**写回。
 *
 * 不物理回退历史：旧版本仍在 history/ 里，新版本 version+1 并产生新快照，因此"回滚"本身
 * 也可再被回滚——这是审计链能自证的前提。
 *
 * @param {{root?:string,key:string,rev:string,identity?:object,traceId?:string,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} [opts]
 * @returns {{ok:boolean,rule?:object,path?:string,history?:string,commit?:object|null,
 *   version?:number,previousVersion?:number,revertedTo?:string,source?:string,
 *   changed?:boolean,error?:string,detail?:any,rolledBack?:boolean}}
 */
export function revertRule({ root = '', key, rev, now = Date.now() } = {}, opts = {}) {
  const base = baseDir(root)
  const fs = opts.fs || nodeFs
  // requireGit 闸门（R9-05）：先于锁/读盘。
  const gate = gitGate(base, opts)
  if (!gate.ok) return gate
  const lock = acquireRepoLock(base, { fs, timeoutMs: opts.timeoutMs, staleMs: opts.staleMs })
  if (!lock.ok) return { ok: false, error: lock.error }
  try {
    return revertRuleLocked({ root: base, key, rev, now }, { ...opts, fs, lockHeld: true })
  } finally {
    lock.release()
  }
}

/**
 * `revertRule` 的锁内实现（调用方必须已持仓库锁）。
 * @param {{root?:string,key:string,rev:string,now?:number}} args
 * @param {{fs?:typeof nodeFs,git?:boolean,exec?:Function}} opts
 * @returns {object}
 */
function revertRuleLocked({ root = '', key, rev, now = Date.now() } = {}, opts = {}) {
  const fs = opts.fs || nodeFs
  const base = baseDir(root)
  // 同 updateRule：内部 writeRule(git:false) 不建仓，revert 自己 ensure，否则首笔回滚提交不上。
  if (opts.git !== false) {
    const ensured = ensureRuleRepo({ root: base, git: true, fs, ...(opts.exec ? { exec: opts.exec } : {}) })
    if (!ensured.ok) return { ok: false, error: 'ensure_failed', detail: ensured.error }
  }
  const got = readRule(base, key)
  if (!got.ok) return got
  const doc = got.rule
  const resolved = resolveRevision({ root: base, key, rev }, opts)
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error === 'snapshot_not_found' ? 'rev_not_found' : resolved.error,
      detail: resolved.detail,
    }
  }

  const snap = resolved.rule
  const version = Number(doc.front.version) + 1
  // 身份字段永远取**当前文件**：快照里的 key/number/created 可能来自 rename 前的旧世界，
  // 真按快照覆盖会把规则改成另一条。内容字段（含 status/priority/scope）按快照还原文。
  const nextFront = {
    ...snap.front,
    key: doc.front.key,
    type: doc.front.type,
    number: doc.front.number,
    created: doc.front.created,
    origin: doc.front.origin,
    version,
    updated: dateOf(now),
  }
  const nextDoc = { front: nextFront, text: snap.text }

  const numbers = new Map()
  for (const other of listRules(base).rules) {
    if (String(other.front.key) === String(key)) continue
    if (!(Number.isInteger(other.front.number) && other.front.number > 0)) continue
    numbers.set(other.front.number, other.front.key)
  }
  const check = validateRule(nextFront, snap.text, { numbers })
  if (!check.ok) return { ok: false, error: 'invalid_rule', detail: check.errors }

  let oldSource
  try { oldSource = fs.readFileSync(doc.file, 'utf8') } catch (err) {
    return { ok: false, error: 'snapshot_read_failed', detail: String(err?.message || err) }
  }
  const saved = writeRule(base, nextDoc, { fs, git: false, lockHeld: true })
  // writeRule 的失败路径已自带四处回滚（R9-03），这里不再补第二次 restore：
  // 二次 restore 用真 fs、且会掩盖 history/manifest/index 是否真的回滚干净（旧测试假绿成因）。
  if (!saved.ok) return saved

  const paths = [relative(base, saved.path), MANIFEST_FILE, ...(saved.path !== doc.file ? [relative(base, doc.file)] : [])]
  let commit = null
  if (opts.git !== false) {
    commit = commitRuleChanges(base, `rule: revert ${key} to ${resolved.rev}`, { exec: opts.exec, paths })
    if (!commit.ok && isGitDegraded(commit.error)) {
      return {
        ok: true, changed: true, rule: saved.rule, path: saved.path, history: saved.history || '',
        commit, version, previousVersion: Number(doc.front.version),
        revertedTo: resolved.rev, source: resolved.source, commitState: 'degraded',
      }
    }
    if (!commit.ok) {
      // commit 失败必须回滚：文件/manifest/本事务新增 history 条目/git index 四处一起回。
      const rolled = rollbackRuleWrite(base, {
        file: doc.file, oldSource, key, historyRev: saved.history, paths, fs, exec: opts.exec,
      })
      return {
        ok: false,
        error: 'commit_failed',
        detail: { stage: 'commit', error: commit.error },
        rolledBack: rolled.ok,
        rollbackFailures: rolled.failures,
        version: Number(doc.front.version),
        previousVersion: Number(doc.front.version),
        revertedTo: resolved.rev,
        commitState: 'failed',
      }
    }
  }
  return {
    ok: true,
    changed: true,
    rule: saved.rule,
    path: saved.path,
    history: saved.history || '',
    commit,
    version,
    previousVersion: Number(doc.front.version),
    revertedTo: resolved.rev,
    source: resolved.source,
    commitState: commitStateOf(commit, { git: opts.git }),
  }
}

// ---------------------------------------------------------------------------
// 写失败回滚（文件 / manifest / history / git index 四处）
// ---------------------------------------------------------------------------

/**
 * 回滚一次写尝试：新建（删新文件）、更新（写回旧正文）、搬迁（删新路径 + 还原旧路径）
 * 三种形态统一走这里，回滚覆盖文件/manifest/history/git index 四处（R9-03 不变式③）。
 *
 * @param {string} base 规则仓根
 * @param {{target:string, oldFile?:string|null, oldSource?:string|null, key:string,
 *   historyRev?:string, paths?:string[], fs?:typeof nodeFs, exec?:Function}} [ctx]
 * @returns {{ok:boolean, failures:string[]}}
 */
function rollbackWriteAttempt(base, { target, oldFile = null, oldSource = null, key, historyRev = '', paths = [], fs = nodeFs, exec } = {}) {
  const failures = []
  if (oldFile && oldSource !== null && oldSource !== undefined) {
    if (target && target !== oldFile) {
      try { fs.unlinkSync(target) } catch (err) {
        if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
      }
    }
    const restored = durableWriteFile(oldFile, oldSource, { fs })
    if (!restored.ok) failures.push(`file:${restored.error}`)
  } else if (target) {
    try { fs.unlinkSync(target) } catch (err) {
      if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
    }
  }
  const historyFailure = removeHistoryEntry(base, key, historyRev, fs)
  if (historyFailure) failures.push(historyFailure)
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
  const reset = resetIndexPaths(base, paths, { exec })
  if (!reset.ok) failures.push(`index:${reset.error}`)
  return { ok: failures.length === 0, failures }
}

/** 兼容旧调用签名（同路径更新/回滚）：行为即 rollbackWriteAttempt。 */
function rollbackRuleWrite(base, { file, oldSource, key, historyRev, paths, fs, exec }) {
  return rollbackWriteAttempt(base, {
    target: file, oldFile: file, oldSource, key, historyRev, paths, fs, exec,
  })
}

/** 回滚"新建文件"：删文件 + 重建 manifest + 清 index（create 的 commit 失败路径）。 */
function rollbackCreatedFile(base, file, paths, { fs, exec }) {
  const failures = []
  try { fs.unlinkSync(file) } catch (err) {
    // 文件可能已被 git rm/失败删除；只有 ENOENT 才算已回滚，其他错误如实记。
    if (err?.code !== 'ENOENT') failures.push(`file:${err?.message || err}`)
  }
  const manifest = regenerateManifest(base, { fs })
  if (!manifest.ok) failures.push(`manifest:${manifest.error}`)
  const reset = resetIndexPaths(base, paths, { exec })
  if (!reset.ok) failures.push(`index:${reset.error}`)
  return { ok: failures.length === 0, failures }
}
