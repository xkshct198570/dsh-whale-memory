// 职责：历史快照/版本读取/diff/版本解析与快照删除；依赖：./paths.js、./io.js、./parse.js、./git.js（git 版本查询）。
import { readdirSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { baseDir } from './paths.js'
import { durableWriteFile, uniqueStamp } from './io.js'
import { KEY_RE, isValidRuleKey, normalizeRuleDoc, parseRuleDocument, readRuleSource } from './parse.js'
import { gitShow, isGitRepo } from './git.js'

// ---------------------------------------------------------------------------
// 常量（历史快照与 diff）
// ---------------------------------------------------------------------------

export const HISTORY_KEEP = 20
/** 单次 diff 的行数硬顶（5000 行 ≈ 面板可读上限，超出直接报错而不是卡死浏览器）。 */
export const DIFF_LINE_LIMIT = 5000

/**
 * 快照名排序键：`(17 位戳, 同毫秒序号)`，序号缺省=1。
 *
 * 为什么不能用字典序：`...000-10.md` 字典序小于 `...000-2.md`，pruneHistory 会把"最新"
 * 当"最旧"删掉、历史列表顺序也会错。数值比较才不会把同毫秒的第 10 份当第 2 份。
 * @param {string} name @returns {number[]|null}
 */
function revSortKey(name) {
  const m = String(name).replace(/\.md$/i, '').match(/^(\d{17})(?:-(\d+))?$/)
  if (!m) return null
  return [Number(m[1]), m[2] ? Number(m[2]) : 1]
}

/** 快照名比较：合法戳按数值，非法名退回字典序（不把坏名混进数值序列）。 */
function compareRevs(a, b) {
  const ka = revSortKey(a)
  const kb = revSortKey(b)
  if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1]
  if (ka) return 1
  if (kb) return -1
  return String(a).localeCompare(String(b))
}

function pruneHistory(dir, fs) {
  let names
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(compareRevs) } catch { return [] }
  const removed = []
  for (const name of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) {
    try { fs.unlinkSync(join(dir, name)); removed.push(name) } catch { /* 删不掉就留着，历史多一份比丢一份安全 */ }
  }
  return removed
}

/**
 * 写入前把旧文件全文快照到 `history/<key>/<ts>.md`，只保留 20 份。
 * @param {string} root @param {string} key @param {string} content @param {{fs?: typeof nodeFs}} [opts]
 * @returns {{ok:boolean,rev?:string,error?:string}}
 */
export function writeHistorySnapshot(root, key, content, opts = {}) {
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const fs = opts.fs || nodeFs
  const dir = join(baseDir(root), 'history', key)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const rev = uniqueStamp(dir, fs)
    // 快照也要 fsync：断电后「正文已新、旧版本没落盘」等于丢了可回滚的上一版。
    const written = durableWriteFile(join(dir, `${rev}.md`), String(content), { fs })
    if (!written.ok) return { ok: false, error: `snapshot_write_failed:${written.error}` }
    pruneHistory(dir, fs)
    return { ok: true, rev }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * 历史列表（新→旧）。source 取快照 front.origin；解析失败也给空 front，不丢文件记录。
 * `version` 供 `/rules/versions` 面板直读（解析失败给 null，不猜）。
 * @param {string} root @param {string} key
 * @returns {{ok:boolean,entries?:Array<{rev:string,ts:string,version:number|null,source:string,text:string}>,error?:string}}
 */
export function readHistory(root, key) {
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const base = baseDir(root)
  const dir = join(base, 'history', key)
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort(compareRevs).reverse() } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, entries: [] }
    return { ok: false, error: String(err?.message || err) }
  }
  const entries = []
  for (const name of names) {
    const rev = name.replace(/\.md$/, '')
    const parsed = readSnapshotFile(base, key, rev)
    entries.push({
      rev,
      ts: isoOfRev(rev),
      version: parsed.ok && Number.isInteger(parsed.rule.front.version) ? parsed.rule.front.version : null,
      source: parsed.ok ? String(parsed.rule.front.origin || 'file') : 'file',
      text: parsed.ok ? parsed.rule.text : '',
    })
  }
  return { ok: true, entries }
}

function readSnapshotFile(base, key, rev) {
  const file = join(base, 'history', key, `${rev}.md`)
  // 快照与规则同一个读取闸：坏 UTF-8 的旧快照不能靠 U+FFFD 混成"看起来正常的旧版"。
  const read = readRuleSource(file)
  if (!read.ok) return { ok: false, error: read.error === 'rule_not_found' ? 'snapshot_not_found' : read.error }
  const parsed = parseRuleDocument(read.text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const normalized = normalizeRuleDoc(parsed.front, parsed.text)
  return { ok: true, rule: { ...normalized, bodyStart: parsed.bodyStart, file } }
}

/** 17 位戳 → ISO（失败给空串，历史列表不该因命名异常整列失败）。 */
function isoOfRev(rev) {
  const m = String(rev).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/)
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}`
}

/**
 * 读某个历史快照（不写盘）。
 * @param {string} root @param {string} key @param {string} rev
 * @returns {{ok:boolean,rule?:object,error?:string}}
 */
export function readSnapshot(root, key, rev) {
  if (!KEY_RE.test(String(key ?? ''))) return { ok: false, error: 'invalid_key' }
  if (!/^[0-9-]+$/.test(String(rev ?? ''))) return { ok: false, error: 'invalid_rev' }
  return readSnapshotFile(baseDir(root), key, rev)
}

/**
 * revision 归一成 history 快照文件名（17 位戳，含同毫秒 `-N` 后缀）。
 * 支持三种写法：`20261122191022000`、`20261122191022000.md`、ISO `2026-11-22T19:10:22.000`。
 * 不匹配返回空串（由调用方继续尝试 git sha）。
 * @param {string} rev @returns {string}
 */
function historyRevOf(rev) {
  const s = String(rev ?? '').trim().replace(/\.md$/i, '')
  if (/^\d{17}(?:-\d+)?$/.test(s)) return s
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
  if (!m) return ''
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}${(m[7] || '').padEnd(3, '0')}`
}

/** 正文按行切（空串是 0 行；末尾换行不制造幽灵空行）。 */
function splitDiffLines(text) {
  const s = String(text ?? '')
  return s === '' ? [] : s.split('\n')
}

/**
 * 纯函数行 diff（不引库）：`[{type:'same'|'add'|'del',text}]`，顺序即面板渲染顺序。
 *
 * 算法：先剥公共前缀/后缀（手改规则文件时 90% 只有一小段变化，剥完中间通常只剩几行），
 * 中间段用 LCS 动态规划回溯；中间段超过约 2000×2000 时退化为"整段删+整段加"，
 * 这条降级只影响展示粒度，不会给出错误结论（也不会 OOM 把面板拖死）。
 *
 * @param {string} oldText @param {string} newText
 * @returns {Array<{type:'same'|'add'|'del',text:string}>}
 */
export function diffLines(oldText, newText) {
  const a = splitDiffLines(oldText)
  const b = splitDiffLines(newText)
  const out = []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push({ type: 'same', text: a[start] })
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length === 0) {
    for (const line of midB) out.push({ type: 'add', text: line })
  } else if (midB.length === 0) {
    for (const line of midA) out.push({ type: 'del', text: line })
  } else if ((midA.length + 1) * (midB.length + 1) > 4_000_000) {
    for (const line of midA) out.push({ type: 'del', text: line })
    for (const line of midB) out.push({ type: 'add', text: line })
  } else {
    const width = midB.length + 1
    const dp = new Uint32Array((midA.length + 1) * width)
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i * width + j] = midA[i] === midB[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ type: 'same', text: midA[i] })
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        out.push({ type: 'del', text: midA[i] })
        i += 1
      } else {
        out.push({ type: 'add', text: midB[j] })
        j += 1
      }
    }
    while (i < midA.length) { out.push({ type: 'del', text: midA[i] }); i += 1 }
    while (j < midB.length) { out.push({ type: 'add', text: midB[j] }); j += 1 }
  }

  for (let k = endA; k < a.length; k += 1) out.push({ type: 'same', text: a[k] })
  return out
}

/**
 * 把 `rev` 解析成某个版本的规则文档（只读，不写盘）。
 *
 * rev 的解析顺序**先 history 再 git**：17 位数字/ISO 是快照命名，纯 4–40 位十六进制才是 git
 * 短 sha（两者偶尔重叠的极端情况优先本地快照，因为它更贴"面板选中的那一版"）。
 *
 * @param {{root?:string,key:string,rev:string}} args
 * @param {{exec?:Function}} [opts]
 * @returns {{ok:boolean,rev?:string,source?:'history'|'git',rule?:object,raw?:string,
 *   error?:string,detail?:any}}
 */
export function resolveRevision({ root = '', key, rev } = {}, opts = {}) {
  const base = baseDir(root)
  if (!isValidRuleKey(key)) return { ok: false, error: 'invalid_key' }
  const raw = String(rev ?? '').trim().replace(/\.md$/i, '')
  if (!raw) return { ok: false, error: 'invalid_rev', detail: { rev: '' } }

  const historyRev = historyRevOf(raw)
  if (historyRev) {
    const snap = readSnapshot(base, key, historyRev)
    if (!snap.ok) {
      return {
        ok: false,
        error: snap.error === 'snapshot_not_found' ? 'rev_not_found' : snap.error,
        detail: { rev: raw, kind: 'history' },
      }
    }
    return { ok: true, rev: historyRev, source: 'history', rule: snap.rule }
  }

  if (/^[0-9a-f]{4,40}$/i.test(raw)) {
    const sha = raw.toLowerCase()
    // 正式规则与候选落在不同目录，同一 sha 下要两个路径都试；都不在才算 rev_not_found。
    for (const rel of [`${key}.md`, `proposals/${key}.md`]) {
      const shown = gitShow(base, `${sha}:${rel}`, { exec: opts.exec })
      if (!shown.ok) continue
      const parsed = parseRuleDocument(shown.text)
      if (!parsed.ok) continue
      const normalized = normalizeRuleDoc(parsed.front, parsed.text)
      return {
        ok: true,
        rev: sha,
        source: 'git',
        file: rel,
        raw: shown.text,
        rule: { ...normalized, bodyStart: parsed.bodyStart, file: join(base, rel) },
      }
    }
    const repo = isGitRepo(base, { exec: opts.exec })
    // git 没装才报 git_unavailable；装了但当前目录不是仓库 → 这个 sha 不可能存在。
    if (!repo.ok && repo.error && repo.error !== 'not_a_git_repo') {
      return { ok: false, error: repo.error, detail: { rev: raw, kind: 'git' } }
    }
    return { ok: false, error: 'rev_not_found', detail: { rev: raw, kind: 'git' } }
  }

  return { ok: false, error: 'invalid_rev', detail: { rev: raw } }
}

/** 删除本事务新增的 history 快照；返回失败描述或 null（幂等：没 rev 时不动）。 */
export function removeHistoryEntry(base, key, rev, fs = nodeFs) {
  if (!rev) return null
  try {
    fs.unlinkSync(join(base, 'history', key, `${rev}.md`))
    return null
  } catch (err) {
    // ENOENT = 快照本来就不存在（重复回滚/写失败前未落盘）：视为已回滚，不制造假半写。
    if (err?.code === 'ENOENT') return null
    return `history:${err?.message || err}`
  }
}
