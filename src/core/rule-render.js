/**
 * 规则渲染产物（R3b/R8-06）：`AGENTS.md` 摘要块 + 台账 §2 块。
 *
 * 职责：
 * - `renderAgentsDigest`：把「global + active」规则渲染成一行一条的摘要，只替换管理块内部；
 * - `inspectMarkers` / `fileMarkers`：标记块探测（缺失/重复都返回失败码，不猜、不追加）；
 * - 原子写 + `.bak` 轮转（保留最近 5 份）+ 写前 `stat` 比对 + 仓库锁内读-改-写 + 幂等
 *   （内容不变不写，保留 mtime，避免无意义的文件变更事件）。
 *
 * 边界：
 * - **绝不追加/覆盖全文**：标记不存在返回 `no_markers`，标记重复返回 `duplicate_markers`；
 *   这两条是"块外一个字节不碰"的硬保证（架构书 §3.6/§4.1）。
 * - 只读规则数组或规则目录（listRules）；不写规则、不碰 DB、不调模型。
 * - CRLF 保持原文件 EOL：摘要块的行分隔符跟随目标文件，块外字节一字不动。
 * - 正文单行化（`\n`→空格、控制字符剔除）后入摘要；管理块标记字面量在写入闸之外再做一次
 *   防御性剔除——写入闸是 task-1 的职责，这里只保证"即使绕过闸，摘要也不能被撕开"。
 *
 * Why 管理块：AGENTS/台账是人工也在编辑的文件，渲染必须可增量、可自愈、可回滚；
 * 用显式标记把"机器负责的字节区间"钉死，才能在用户手改块外内容后依然安全重渲染。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFile, listRules } from './rule-store.js'
import * as ruleStore from './rule-store.js'

/** AGENTS 摘要块标记（勿改：客户端/R6 文档同步引用同一字面量）。 */
export const RULES_BEGIN = '<!-- whale-memory:rules:begin -->'
export const RULES_END = '<!-- whale-memory:rules:end -->'
/** 台账 §2 表体块标记（R6/R7 负责加到台账里）。 */

/** 摘要里正文摘录长度（一行一条，太长会把 AGENTS 读成本体）。 */
// 摘要要能独立读懂：60 字只剩半句，真机 AGENTS 实测看不到例外/判据。200 字≈全条正文，
// 超长铁律才截断并给省略号 + 文件指针；17 条全量约 3.4K 字符，可接受。
const EXCERPT_CHARS = 200
/** front.summary 上限（架构书 §2.2：≤120 字，只用于摘要/列表）。 */
const SUMMARY_MAX = 120
/** 标题展示上限（码点）。 */
const TITLE_MAX = 80
/** `.bak` 保留份数：`.bak`（最新）+ `.bak.1` … `.bak.4`。 */
const BACKUP_KEEP = 5
/** 读-改-写最多重试次数：块外被并发修改时重读再改，不覆盖别人的字节。 */
const WRITE_ATTEMPTS = 3
/** 句末标点（架构书 §4.1）：截断回退到最后一个句末，不切半句。 */
const SENTENCE_END_RE = /[。；！？]/
/** 控制字符（保留 \t \n \r，先做 EOL 归一再折叠空白）。 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/** 管理块标记字面量：写入闸在 task-1，这里只做渲染侧防御。 */
const MARKER_LITERAL_RE = /<!--\s*whale-memory\s*:\s*rules:/i
/** 优先级排序权重：未知值排最后。 */
const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 })

/** @param {any} value @returns {string} */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** @param {any} value @returns {string} */
function trimmed(value) {
  return textOf(value).trim()
}

/** 码点切片：绝不切半句/切代理对。 @param {string} text @param {number} max */
function sliceCodepoints(text, max) {
  const chars = Array.from(textOf(text))
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/**
 * 防御性剔除管理块标记字面量（含未闭合的孤立标记）。
 * 已闭合的注释整段去掉；未闭合的从标记处截尾——宁可少一句，也不让摘要块被撕开。
 * @param {string} text @returns {string}
 */
export function stripMarkerLiterals(text) {
  let out = textOf(text).replace(/<!--[\s\S]*?-->/g,
    (comment) => (MARKER_LITERAL_RE.test(comment) ? '' : comment))
  const at = out.search(MARKER_LITERAL_RE)
  return at === -1 ? out : out.slice(0, at)
}

/**
 * 单行化：标记剔除 → EOL 归空格 → 控制字符剔除 → 空白折叠。
 * @param {string} text @returns {string}
 */
export function singleLine(text) {
  return stripMarkerLiterals(textOf(text))
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 最后一个句末标点的码点下标；没有返回 -1。 @param {string} text @returns {number} */
function lastSentenceEnd(text) {
  const chars = Array.from(textOf(text))
  let found = -1
  for (let i = 0; i < chars.length; i += 1) if (SENTENCE_END_RE.test(chars[i])) found = i
  return found
}

/**
 * 正文摘录：≤200 码点直接全给；超长取前 200 码点并回退到最后一个句末，否则硬截 + `…`。
 * @param {string} body @returns {string}
 */
export function excerptOf(body) {
  const flat = singleLine(body)
  const chars = Array.from(flat)
  if (chars.length <= EXCERPT_CHARS) return flat
  const headChars = chars.slice(0, EXCERPT_CHARS)
  const end = lastSentenceEnd(headChars.join(''))
  const cut = end >= 0 ? headChars.slice(0, end + 1).join('') : headChars.join('')
  return `${cut}…`
}

/**
 * 摘要正文：`summary`（≤120 码点）优先，否则正文 200 码点回退句末。
 * @param {object} front @param {string} body @returns {string}
 */
export function summaryOfRule(front, body) {
  const declared = singleLine(front?.summary ?? '')
  // 硬切 ≤120（不加省略号）：架构书 §2.2 的硬顶是「字」，防御手写超长文件时也不能越界。
  if (declared) return Array.from(declared).slice(0, SUMMARY_MAX).join('')
  return excerptOf(body)
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
 * 只用于展示，绝不回写规则正文；单行化并按码点切片（不切代理对）。
 * @param {object} front @param {string} body @returns {string}
 */
export function titleOfRule(front, body) {
  const action = trimmed(front?.action)
  const object = trimmed(front?.object)
  const modality = trimmed(front?.modality)
  // 结构化标题优先：action 单独一个动词（「删」）当标题太贫，action+object 才是人读得懂的短名。
  const base = action && object ? `${action}${object}` : action
  // 模态必须体现在标题里：否则「禁止 X」会读成「X」，「只准 X」会读成「X」（真机 AGENTS 摘要实测）。
  if (base) {
    const titled = modality === 'must_not' ? `禁止${base}` : modality === 'only' ? `只准${base}` : base
    return sliceCodepoints(singleLine(titled), TITLE_MAX)
  }
  const heading = textOf(body).split('\n').map((line) => line.trim()).find((line) => line.startsWith('#'))
  if (heading) return sliceCodepoints(singleLine(heading.replace(/^#+\s*/, '')), TITLE_MAX)
  const first = textOf(body).split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean)[0] || ''
  return sliceCodepoints(singleLine(first), TITLE_MAX)
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
  // safety（number=0）不占号：用 key 展示，避免出现「铁律0」。
  const label = type === 'iron-rule' && Number.isInteger(number) && number > 0
    ? `铁律${number}`
    : trimmed(front.key)
  const excerpt = summaryOfRule(front, text)
  // 摘要必须指到「哪一条文件」：只给目录时用户还得自己找文件（真机 AGENTS 实测暴露）。
  const file = trimmed(doc.file) || (trimmed(front.key) ? `${trimmed(front.key)}.md` : '')
  const tail = file ? `（文件：${basename(file)}）` : ''
  return `- ${label} · ${titleOfRule(front, text)}（${scopeLabel(front.scope)}）：${excerpt}${tail}`
}

/** 注入/摘要排序：铁律按编号 → priority → key；普通规则 priority → key。 */
function compareDigestDocs(a, b) {
  const ironA = trimmed(a.front.type) === 'iron-rule' ? 0 : 1
  const ironB = trimmed(b.front.type) === 'iron-rule' ? 0 : 1
  if (ironA !== ironB) return ironA - ironB
  const numA = Number(a.front.number) || 0
  const numB = Number(b.front.number) || 0
  if (numA !== numB) return numA - numB
  const rankA = PRIORITY_RANK[trimmed(a.front.priority).toUpperCase()] ?? 9
  const rankB = PRIORITY_RANK[trimmed(b.front.priority).toUpperCase()] ?? 9
  if (rankA !== rankB) return rankA - rankB
  return trimmed(a.front.key).localeCompare(trimmed(b.front.key))
}

/**
 * 摘要块正文（不含标记行）：global + active 全收——铁律按编号在前，
 * 普通规则按 priority→key 在后（R8-06：普通全局规则也必须出现在 AGENTS）。
 * @param {any} rules 规则集合（数组/目录/`{rules}`）
 * @returns {{content:string, count:number, keys:string[]}}
 */
export function rulesDigestContent(rules, opts = {}) {
  // 总预算（R9-14，D4 调高）：默认 6000 码点——19 条铁律已占 3722，4000 会截掉最新规则；
  // 0/非法回落默认值（0 不是「无限」，与 injectChars 同口径）。
  const budgetRaw = Number(opts.budgetChars)
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.floor(budgetRaw) : 6000
  const docs = normalizeDocs(rules)
    .map(splitDoc)
    .filter(({ front }) => trimmed(front.status || 'active') === 'active'
      && trimmed(front.type) !== 'rule-candidate'
      // 链终点过滤（R9-14）：active 但仍带 merged_into/superseded_by 指针的是中间态，
      // 摘要里再列一遍等于同一事实出现两次；注入/摘要只取链终点。
      && !trimmed(front.merged_into) && !trimmed(front.superseded_by)
      && (trimmed(front.scope) || 'global') === 'global')
    .sort(compareDigestDocs)
  const dir = trimmed(opts.dir) || dirnameOfRules(rules)
  const header = '## 规则摘要（自动生成，勿手改）'
  const lines = [header]
  const keys = []
  const skipped = []
  // 脚注也吃预算：先预留，避免最后一行把总量顶破。
  const footer = dir ? `规则文件目录：${displayPath(dir)}` : ''
  const footerCost = footer ? Array.from(footer).length + 1 : 0
  let used = Array.from(header).length
  for (const doc of docs) {
    const line = digestLine(doc)
    const cost = Array.from(line).length + (keys.length ? 1 : 0)
    if (used + cost + footerCost > budget) {
      // 排序已是 铁律编号→priority→key：到界即截断，后面的更低优先级不再尝试塞入。
      skipped.push({ key: trimmed(doc.front.key), chars: Array.from(line).length })
      continue
    }
    lines.push(line)
    keys.push(trimmed(doc.front.key))
    used += cost
  }
  // 传数组（apply 后的 postRules）时没有目录信息，脚注宁可省略也不写半截路径。
  if (keys.length && footer) lines.push(footer)
  return {
    content: lines.join('\n'),
    count: keys.length,
    keys,
    skipped,
    chars: used + (keys.length && footer ? footerCost : 0),
    budgetChars: budget,
  }
}

/**
 * AGENTS 管理块是否陈旧（R9-14）：块存在，但文件 mtime 落后于规则目录里最新规则。
 *
 * 为什么需要：`renderAgents=false` 时摘要不重渲染，旧块里的全局规则会"零次出现"；
 * hook 必须能判定块陈旧并降级注入 global（宁可在旧块仍在时双份，也不能一条都看不见）。
 *
 * @param {{agentsPath?:string, rulesDir?:string}} [args]
 * @returns {boolean}
 */
export function agentsBlockStale({ agentsPath = '', rulesDir = '' } = {}) {
  const file = trimmed(agentsPath)
  const dir = trimmed(rulesDir)
  if (!file || !dir) return false
  let agentsMtime
  try { agentsMtime = statSync(file).mtimeMs } catch { return false }
  if (!fileHasMarkers(file)) return false
  let newest = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      try {
        const m = statSync(join(dir, name)).mtimeMs
        if (m > newest) newest = m
      } catch { /* 刚好被换掉：跳过 */ }
    }
  } catch { return false }
  return newest > agentsMtime
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

/** 目标文件的 EOL 风格（CRLF 文件继续保持 CRLF，块外字节不因换行符被改写）。 */
function detectEol(content) {
  return textOf(content).includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 替换标记块内部（保留块外全部字节 + 标记行本身）；块内行分隔符跟随原文件 EOL。
 * @param {string} content 旧全文
 * @param {string} markers 探测结果（ok=true）
 * @param {string} body 新块内容（`\n` 分隔）
 * @returns {string}
 */
function replaceBlock(content, markers, body, begin, end, eol = '\n') {
  const head = content.slice(0, markers.start)
  const tail = content.slice(markers.stop + end.length)
  const blockBody = body.split('\n').join(eol)
  return `${head}${begin}${eol}${blockBody}${eol}${end}${tail}`
}

/** 写前 `stat` 指纹：size+mtime+inode，用来发现"读完之后别人又改了文件"。 */
function statSignature(path) {
  try {
    const st = statSync(path)
    return `${st.ino}|${st.size}|${Number(st.mtimeMs)}`
  } catch {
    return ''
  }
}

/**
 * 写前 `.bak` 轮转（保留最近 5 份：`.bak` 最新 + `.bak.1` … `.bak.4`）。
 * 轮转先做 rename（同目录原子），最后原子写 `.bak` 本体。
 * @param {string} path @param {string} oldText
 * @returns {{ok:boolean, error?:string}}
 */
function rotateBackup(path, oldText) {
  try {
    const overflow = `${path}.bak.${BACKUP_KEEP - 1}` // `.bak.5` 是第 6 份：写新备份前先淘汰
    if (existsSync(overflow)) rmSync(overflow, { force: true })
    for (let i = BACKUP_KEEP - 2; i >= 1; i -= 1) {
      const from = `${path}.bak.${i}`
      if (existsSync(from)) renameSync(from, `${path}.bak.${i + 1}`)
    }
    if (existsSync(`${path}.bak`)) renameSync(`${path}.bak`, `${path}.bak.1`)
    return atomicWriteFile(`${path}.bak`, oldText)
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 原子写 + 写前 `.bak` 轮转；内容不变返回 changed:false 且不落盘（保留 mtime）。
 * @param {string} path @param {string} oldText @param {string} newText
 * @returns {{ok:boolean, changed:boolean, error?:string}}
 */
function writeWithBackup(path, oldText, newText) {
  if (newText === oldText) return { ok: true, changed: false }
  const backup = rotateBackup(path, oldText)
  if (!backup.ok) return { ok: false, changed: false, error: `backup_failed:${backup.error}` }
  const written = atomicWriteFile(path, newText)
  if (!written.ok) return { ok: false, changed: false, error: `write_failed:${written.error}` }
  return { ok: true, changed: true }
}

/** 仓库锁缺失只提示一次，避免每个渲染周期刷日志。 */
let warnedMissingRepoLock = false

/**
 * 读-改-写包在仓库锁内：优先用 task-1 的 `withRepoLock`（契约 §1）。
 * store 尚未落地时降级为直接执行并留痕（单进程渲染仍是原子写；锁到位后自动接管，无需改这里）。
 * @param {string} root @param {Function} fn @param {{lock?:Function, log?:Function}} [opts]
 */
function runWithRepoLock(root, fn, { lock = null, log = () => {} } = {}) {
  const impl = typeof lock === 'function'
    ? lock
    : (typeof ruleStore.withRepoLock === 'function' ? ruleStore.withRepoLock : null)
  if (impl && root) return impl(root, fn)
  if (!impl && !warnedMissingRepoLock) {
    warnedMissingRepoLock = true
    log('[whale-memory] render repo lock unavailable（store 尚未提供 withRepoLock），单进程原子写降级')
  }
  return fn()
}

/**
 * 锁内渲染一次标记块：读 → 探测 → 渲染 → 写前 stat 比对 → 原子写（并发变更则重读重试）。
 * @param {{path:string, begin:string, end:string, body:(content:string)=>string,
 *   log:Function, label:string}} args
 * @returns {{ok:boolean, changed?:boolean, content?:string, error?:string, code?:string}}
 */
function rewriteBlock({ path, begin, end, body, log, label, createIfMissing = false }) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    // 先取读前指纹：读→比对→写三步之间任何一步被别人改过，都重读重来。
    const before = statSignature(path)
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch (err) {
      const missing = err?.code === 'ENOENT'
      if (!missing) return { ok: false, code: `${label}_unreadable` }
      // 干净安装（R8-06 P1）：宿主还没有 AGENTS.md 时，启动自愈/播种后可创建**最小管理块**，
      // 否则 16 条默认铁律在 AGENTS 里完全不可见（只剩 hook 降级注入的几百字）。
      // 只在调用方显式允许时创建：面板手动渲染/台账渲染不得凭空造宿主资产。
      if (!createIfMissing) return { ok: false, code: 'no_markers' }
      const created = `${begin}\n${body('')}\n${end}\n`
      try {
        mkdirSync(dirname(path), { recursive: true })
      } catch { /* 目录已存在/无权限：写入会给出真实错误 */ }
      const written = atomicWriteFile(path, created)
      if (!written.ok) {
        log(`[whale-memory] render ${label} create failed: ${written.error}`)
        return { ok: false, code: 'write_failed', error: `write_failed:${written.error}` }
      }
      return { ok: true, changed: true, created: true }
    }
    const afterRead = statSignature(path)
    if (afterRead !== before) continue
    const markers = inspectMarkers(content, begin, end)
    if (!markers.ok) return { ok: false, code: markers.code }
    const nextBody = body(content)
    const next = replaceBlock(content, markers, nextBody, begin, end, detectEol(content))
    if (next === content) return { ok: true, changed: false }
    // 读完到写完之间块外（或块内）被别人改了：重读再改，别拿旧快照覆盖。
    if (statSignature(path) !== afterRead) continue
    const result = writeWithBackup(path, content, next)
    if (!result.ok) {
      log(`[whale-memory] render ${label} failed: ${result.error}`)
      return { ok: false, code: 'write_failed', error: result.error }
    }
    return { ok: true, changed: true }
  }
  return { ok: false, code: 'concurrent_write' }
}

/**
 * 重渲染 AGENTS 摘要块。
 *
 * @param {{rules:any, agentsPath:string, rulesDir?:string, root?:string,
 *   lock?:Function, createIfMissing?:boolean, log?:Function}} args
 *   `createIfMissing` 只在启动自愈/播种后由 index.js 传 true（干净安装 P1）；
 *   面板手动渲染保持默认 false（不凭空创建宿主资产）。
 * @returns {{ok:boolean, changed?:boolean, count?:number, keys?:string[], chars?:number,
 *   path?:string, code?:string, error?:string}}
 */
export function renderAgentsDigest({
  rules, agentsPath, rulesDir = '', root = '', lock = null, createIfMissing = false, log = () => {},
  budgetChars = null,
} = {}) {
  const path = trimmed(agentsPath)
  if (!path) return { ok: false, code: 'no_agents_path' }
  const lockRoot = trimmed(root) || trimmed(rulesDir) || dirnameOfRules(rules)
  const digest = rulesDigestContent(rules, { dir: rulesDir, budgetChars })
  // 空摘要不创建文件：建一个空洞的管理块只会给用户留个空壳资产。
  const allowCreate = Boolean(createIfMissing) && digest.count > 0
  let outcome
  try {
    outcome = runWithRepoLock(lockRoot, () => rewriteBlock({
      path,
      begin: RULES_BEGIN,
      end: RULES_END,
      body: () => digest.content,
      log,
      label: 'agents',
      createIfMissing: allowCreate,
    }), { lock, log })
  } catch (err) {
    log(`[whale-memory] render agents failed: ${err?.name || err?.message || err}`)
    return { ok: false, code: 'render_failed', error: String(err?.message || err) }
  }
  if (!outcome || outcome.ok !== true) {
    // withRepoLock 抢锁失败返回 {ok:false,error:'repo_locked'}（不是抛错）：映射成显式错误码，
    // 让调用方/面板知道这次是"没拿到锁"而不是"文件写坏"。
    return { ok: false, code: outcome?.code || (outcome?.error ? 'lock_failed' : 'render_failed'), error: outcome?.error }
  }
  log(`[whale-memory] render agents changed=${outcome.changed} created=${Boolean(outcome.created)} rules=${digest.count}`)
  return {
    ok: true,
    changed: outcome.changed,
    created: Boolean(outcome.created),
    count: digest.count,
    keys: digest.keys,
    chars: Array.from(digest.content).length,
    // 跳过的规则必须回报给调用方/health（黄），不得静默从摘要里消失。
    ...(digest.skipped?.length ? { skipped: digest.skipped } : {}),
    path,
  }
}

/** AGENTS 路径口径：规则目录的兄弟文件（`$DSH_HOME/rules` → `$DSH_HOME/AGENTS.md`）。 */
export function agentsPathOf(rulesDir) {
  const dir = trimmed(rulesDir)
  return dir ? join(dirname(dir), 'AGENTS.md') : ''
}
