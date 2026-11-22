/**
 * 规则渲染产物（R3b）：`AGENTS.md` 摘要块 + 台账 §2 块。
 *
 * 职责：
 * - `renderAgentsDigest`：把「global active 铁律」渲染成一行一条的摘要，只替换管理块内部；
 * - `renderLedgerDigest`：把台账 §2 表体（iron-rule 全文本）渲染进台账管理块；
 * - `inspectMarkers` / `fileMarkers`：标记块探测（缺失/重复都返回失败码，不猜、不追加）；
 * - 原子写 + 写前 `.bak` + 幂等（内容不变不写，保留 mtime，避免无意义的文件变更事件）。
 *
 * 边界：
 * - **绝不追加/覆盖全文**：标记不存在返回 `no_markers`，标记重复返回 `duplicate_markers`；
 *   这两条是"块外一个字节不碰"的硬保证（架构书 §3.6）。
 * - 只读规则数组或规则目录（listRules）；不写规则、不碰 DB、不调模型。
 * - R3b 只提供 `renderLedgerDigest` 函数与测试；台账标记块由 R6/R7 加，R3b 不主动调用。
 *
 * Why 管理块：AGENTS/台账是人工也在编辑的文件，渲染必须可增量、可自愈、可回滚；
 * 用显式标记把"机器负责的字节区间"钉死，才能在用户手改块外内容后依然安全重渲染。
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFile, listRules } from './rule-store.js'

/** AGENTS 摘要块标记（勿改：客户端/R6 文档同步引用同一字面量）。 */
export const RULES_BEGIN = '<!-- whale-memory:rules:begin -->'
export const RULES_END = '<!-- whale-memory:rules:end -->'
/** 台账 §2 表体块标记（R6/R7 负责加到台账里）。 */
export const LEDGER_BEGIN = '<!-- whale-memory:ledger:begin -->'
export const LEDGER_END = '<!-- whale-memory:ledger:end -->'

/** 摘要里正文摘录长度（一行一条，太长会把 AGENTS 读成本体）。 */
const EXCERPT_CHARS = 60

/** @param {any} value @returns {string} */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {any} value @returns {string} */
function trimmed(value) {
  return textOf(value).trim()
}

/**
 * 规则数组 / 规则根目录 / `{rules:[...]}` → `{front,text}` 数组。
 * @param {any} rules @returns {Array<{front:object,text:string}>}
 */
function normalizeDocs(rules) {
  if (Array.isArray(rules)) return rules
  if (typeof rules === 'string' && rules.trim()) return listRules(rules.trim()).rules
  if (rules && Array.isArray(rules.rules)) return rules.rules
  if (rules && typeof rules.root === 'string' && rules.root.trim()) return listRules(rules.root).rules
  return []
}

/** @param {any} doc @returns {{front:object,text:string}} */
function splitDoc(doc) {
  if (doc && typeof doc === 'object' && doc.front && typeof doc.front === 'object') {
    return { front: doc.front, text: textOf(doc.text ?? doc.body) }
  }
  return { front: doc && typeof doc === 'object' ? doc : {}, text: textOf(doc?.text ?? doc?.body) }
}

/**
 * 标题：`action` 优先（结构化字段最稳定），否则正文首个 `# ` 行，否则首句。
 * 只用于展示，绝不回写规则正文。
 * @param {object} front @param {string} body @returns {string}
 */
export function titleOfRule(front, body) {
  const action = trimmed(front?.action)
  const object = trimmed(front?.object)
  // 结构化标题优先：action 单独一个动词（「删」）当标题太贫，action+object 才是人读得懂的短名。
  if (action && object) return `${action}${object}`.slice(0, 80)
  if (action) return action.slice(0, 80)
  const heading = textOf(body).split('\n').map((line) => line.trim()).find((line) => line.startsWith('#'))
  if (heading) return heading.replace(/^#+\s*/, '').slice(0, 80)
  return (textOf(body).split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 80)
}

/** 路径展示：$HOME 下的绝对路径压成 `~/…`，避免把本机绝对路径写进 AGENTS。 */
export function displayPath(absPath) {
  const raw = trimmed(absPath)
  if (!raw) return ''
  const home = trimmed(homedir())
  if (home && (raw === home || raw.startsWith(`${home}/`))) return `~${raw.slice(home.length)}`
  return raw
}

/** 作用域展示：global → `全局`，其余原样（防串场的唯一提示，不得省略）。 */
function scopeLabel(scope) {
  const value = trimmed(scope) || 'global'
  return value === 'global' ? '全局' : `作用域：${value}`
}

/** 摘要一行：铁律用编号，普通规则用 key（编号对普通规则无稳定语义）。 */
function digestLine(doc) {
  const { front, text } = splitDoc(doc)
  const type = trimmed(front.type)
  const number = Number(front.number)
  const label = type === 'iron-rule' && Number.isInteger(number) && number > 0
    ? `铁律${number}`
    : trimmed(front.key)
  const chars = Array.from(text)
  const cut = chars.slice(0, EXCERPT_CHARS).join('')
  const excerpt = chars.length > EXCERPT_CHARS ? `${cut}…` : cut
  // 摘要必须指到「哪一条文件」：只给目录时用户还得自己找文件（真机 AGENTS 实测暴露）。
  const file = trimmed(doc.file) || (trimmed(front.key) ? `${trimmed(front.key)}.md` : '')
  const tail = file ? `（文件：${basename(file)}）` : ''
  return `- ${label} · ${titleOfRule(front, text)}（${scopeLabel(front.scope)}）：${excerpt}${tail}`
}

/**
 * 摘要块正文（不含标记行）：global + active + iron-rule，按编号升序。
 * @param {any} rules 规则集合（数组/目录/`{rules}`）
 * @returns {{content:string, count:number, keys:string[]}}
 */
export function rulesDigestContent(rules, opts = {}) {
  const docs = normalizeDocs(rules)
    .map(splitDoc)
    .filter(({ front }) => trimmed(front.status || 'active') === 'active'
      && trimmed(front.type) === 'iron-rule'
      && (trimmed(front.scope) || 'global') === 'global')
    .sort((a, b) => (Number(a.front.number) || 0) - (Number(b.front.number) || 0))
  const lines = ['## 规则摘要（自动生成，勿手改）']
  for (const doc of docs) lines.push(digestLine(doc))
  const dir = trimmed(opts.dir) || dirnameOfRules(rules)
  // 传数组（apply 后的 postRules）时没有目录信息，脚注宁可省略也不写半截路径。
  if (docs.length && dir) lines.push(`规则文件目录：${displayPath(dir)}`)
  return {
    content: lines.join('\n'),
    count: docs.length,
    keys: docs.map(({ front }) => trimmed(front.key)),
  }
}

/** 规则来源目录（用于「完整正文」脚注）；没有目录时给 `~/.dsh/rules` 口径的空串。 */
function dirnameOfRules(rules) {
  if (typeof rules === 'string') return trimmed(rules)
  if (rules && typeof rules.root === 'string') return trimmed(rules.root)
  // 数组形态（apply 后的 postRules / 测试直接给 doc）用第一条的 file 反推目录，
  // 保证"同一批规则不管用哪种形态渲染"脚注一致 → 幂等不被调用形态破坏。
  if (Array.isArray(rules)) {
    for (const doc of rules) {
      const file = trimmed(doc?.file)
      if (file) return dirname(file)
    }
  }
  return ''
}

/**
 * 标记块探测（纯函数）：返回出现次数与位置，供"缺失/重复"两类拒绝。
 * @param {string} content 文件全文
 * @param {string} [begin] @param {string} [end]
 * @returns {{beginCount:number, endCount:number, start:number, stop:number, ok:boolean, code:string}}
 */
export function inspectMarkers(content, begin = RULES_BEGIN, end = RULES_END) {
  const text = textOf(content)
  const countOf = (needle) => {
    let count = 0
    let idx = 0
    while ((idx = text.indexOf(needle, idx)) !== -1) { count += 1; idx += needle.length }
    return count
  }
  const beginCount = countOf(begin)
  const endCount = countOf(end)
  if (beginCount === 0 || endCount === 0) {
    return { beginCount, endCount, start: -1, stop: -1, ok: false, code: 'no_markers' }
  }
  if (beginCount > 1 || endCount > 1) {
    return { beginCount, endCount, start: -1, stop: -1, ok: false, code: 'duplicate_markers' }
  }
  const start = text.indexOf(begin)
  const stop = text.indexOf(end)
  if (stop < start) return { beginCount, endCount, start, stop, ok: false, code: 'markers_out_of_order' }
  return { beginCount, endCount, start, stop, ok: true, code: '' }
}

/** 文件是否含完整单例标记块；读不到/没有都算 false（hook 的降级注入判据）。 */
export function fileHasMarkers(path, begin = RULES_BEGIN, end = RULES_END) {
  const raw = trimmed(path)
  if (!raw) return false
  let content
  try {
    content = readFileSync(raw, 'utf8')
  } catch {
    return false
  }
  return inspectMarkers(content, begin, end).ok
}

/**
 * 替换标记块内部（保留块外全部字节 + 标记行本身）。
 * @param {string} content 旧全文
 * @param {string} marker 探测结果（ok=true）
 * @param {string} body 新块内容
 * @returns {string}
 */
function replaceBlock(content, markers, body, begin, end) {
  const head = content.slice(0, markers.start)
  const tail = content.slice(markers.stop + end.length)
  return `${head}${begin}\n${body}\n${end}${tail}`
}

/**
 * 原子写 + 写前 `.bak`；内容不变返回 changed:false 且不落盘（保留 mtime）。
 * @param {string} path @param {string} oldText @param {string} newText
 * @returns {{ok:boolean, changed:boolean, error?:string}}
 */
function writeWithBackup(path, oldText, newText) {
  if (newText === oldText) return { ok: true, changed: false }
  const backup = atomicWriteFile(`${path}.bak`, oldText)
  if (!backup.ok) return { ok: false, changed: false, error: `backup_failed:${backup.error}` }
  const written = atomicWriteFile(path, newText)
  if (!written.ok) return { ok: false, changed: false, error: `write_failed:${written.error}` }
  return { ok: true, changed: true }
}

/**
 * 重渲染 AGENTS 摘要块。
 *
 * @param {{rules:any, agentsPath:string, log?:Function}} args
 * @returns {{ok:boolean, changed?:boolean, count?:number, keys?:string[], chars?:number,
 *   path?:string, code?:string, error?:string}}
 */
export function renderAgentsDigest({ rules, agentsPath, rulesDir = '', log = () => {} } = {}) {
  const path = trimmed(agentsPath)
  if (!path) return { ok: false, code: 'no_agents_path' }
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    // 目标文件不存在时**不创建**：AGENTS 是宿主/用户资产，插件只改既有管理块。
    return { ok: false, code: err?.code === 'ENOENT' ? 'no_markers' : 'agents_unreadable' }
  }
  const markers = inspectMarkers(content, RULES_BEGIN, RULES_END)
  if (!markers.ok) return { ok: false, code: markers.code }
  const digest = rulesDigestContent(rules, { dir: rulesDir })
  const next = replaceBlock(content, markers, digest.content, RULES_BEGIN, RULES_END)
  const result = writeWithBackup(path, content, next)
  if (!result.ok) {
    log(`[whale-memory] render agents failed: ${result.error}`)
    return { ok: false, code: 'write_failed', error: result.error }
  }
  log(`[whale-memory] render agents changed=${result.changed} rules=${digest.count}`)
  return {
    ok: true,
    changed: result.changed,
    count: digest.count,
    keys: digest.keys,
    chars: Array.from(digest.content).length,
    path,
  }
}

/**
 * 台账 §2 表体（iron-rule 全文本；无编号的 P0 规则排表尾）。
 * @param {any} rules
 * @returns {{content:string, count:number, keys:string[]}}
 */
export function ledgerDigestContent(rules) {
  const docs = normalizeDocs(rules).map(splitDoc).filter(({ front }) => {
    const status = trimmed(front.status || 'active')
    const type = trimmed(front.type)
    if (status !== 'active' || type === 'rule-candidate') return false
    if (type === 'iron-rule') return true
    return trimmed(front.priority).toUpperCase() === 'P0'
  })
  const numbered = docs
    .filter(({ front }) => Number.isInteger(Number(front.number)) && Number(front.number) > 0)
    .sort((a, b) => Number(a.front.number) - Number(b.front.number))
  const tail = docs.filter(({ front }) => !(Number.isInteger(Number(front.number)) && Number(front.number) > 0))
  const rows = []
  for (const { front, text } of [...numbered, ...tail]) {
    const number = Number.isInteger(Number(front.number)) && Number(front.number) > 0 ? String(front.number) : '—'
    const scope = trimmed(front.scope) || 'global'
    rows.push(`| ${number} | ${titleOfRule(front, text)} | ${scope} | ${text.replace(/\|/g, '\\|')} |`)
  }
  return {
    content: rows.join('\n'),
    count: rows.length,
    keys: [...numbered, ...tail].map(({ front }) => trimmed(front.key)),
  }
}

/**
 * 重渲染台账 §2 表体块（同 AGENTS 机制：缺标记/重复标记都拒绝，绝不追加）。
 * R3b 只提供函数；台账标记块由 R6/R7 落。
 *
 * @param {{rules:any, ledgerPath:string, log?:Function}} args
 * @returns {{ok:boolean, changed?:boolean, count?:number, keys?:string[], chars?:number,
 *   path?:string, code?:string, error?:string}}
 */
export function renderLedgerDigest({ rules, ledgerPath, log = () => {} } = {}) {
  const path = trimmed(ledgerPath)
  if (!path) return { ok: false, code: 'no_ledger_path' }
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, code: err?.code === 'ENOENT' ? 'no_markers' : 'ledger_unreadable' }
  }
  const markers = inspectMarkers(content, LEDGER_BEGIN, LEDGER_END)
  if (!markers.ok) return { ok: false, code: markers.code }
  const digest = ledgerDigestContent(rules)
  const next = replaceBlock(content, markers, digest.content, LEDGER_BEGIN, LEDGER_END)
  const result = writeWithBackup(path, content, next)
  if (!result.ok) {
    log(`[whale-memory] render ledger failed: ${result.error}`)
    return { ok: false, code: 'write_failed', error: result.error }
  }
  log(`[whale-memory] render ledger changed=${result.changed} rules=${digest.count}`)
  return {
    ok: true,
    changed: result.changed,
    count: digest.count,
    keys: digest.keys,
    chars: Array.from(digest.content).length,
    path,
  }
}

/** AGENTS 路径口径：规则目录的兄弟文件（`$DSH_HOME/rules` → `$DSH_HOME/AGENTS.md`）。 */
export function agentsPathOf(rulesDir) {
  const dir = trimmed(rulesDir)
  return dir ? join(dirname(dir), 'AGENTS.md') : ''
}
