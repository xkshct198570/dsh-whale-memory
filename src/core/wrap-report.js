/**
 * 整合决策摘要：只渲染计数与拒绝原因（无正文、无候选原文）。
 * @param {{total?:number, counts?:Record<string,number>, rejected?:Array<string>, merged?:number}} decisions
 * @returns {string}
 */
export function renderDecisions(decisions) {
  const input = decisions && typeof decisions === 'object' ? decisions : {}
  const counts = input.counts && typeof input.counts === 'object' ? input.counts : {}
  const order = ['ADD', 'UPDATE', 'MERGE', 'ARCHIVE', 'NOOP', 'REVIEW']
  const parts = order.filter((op) => Number(counts[op] || 0) > 0).map((op) => `${op} ${Number(counts[op])}`)
  const lines = [`共 ${Number(input.total || 0)} 条决策：${parts.length ? parts.join(' · ') : EMPTY}`]
  if (Number(input.merged || 0) > 0) lines.push(`跨候选合并：${Number(input.merged)} 条并入`)
  const reasons = Array.isArray(input.rejected) ? input.rejected : []
  if (reasons.length > 0) {
    const tally = new Map()
    for (const reason of reasons) tally.set(String(reason), (tally.get(String(reason)) || 0) + 1)
    lines.push(`校验拒绝：${[...tally].map(([reason, n]) => `${reason}×${n}`).join(' · ')}`)
  }
  return lines.join('\n')
}

/**
 * 收尾报告渲染：结构化入参 → Markdown 文件。
 *
 * 为什么入参是结构化的、绝不接受 material/turns：
 * 报告会被写进文档目录、可能被分享或上传，原始对话里可能带凭据、私人信息、大段工具输出。
 * 渲染层只认识「摘要/候选/规则提案/待办/清洁检查/可切判定」六类结构化事实，
 * 从接口上就没有把原文漏出去的路径；需要证据时给的是 hash 与素材行号，由调用方另行保管。
 *
 * 为什么全部输入缺失都降级为空而不抛：收尾报告是「最后的记录」——模型失败、蒸馏没跑、
 * 清洁检查没执行时，也应该留下一条可读的收尾记录，而不是因为一个字段缺失整轮收尾失败。
 */
import { createHash } from 'node:crypto'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const EMPTY = '（无）'
const NO_SUMMARY = '（无摘要）'
/** runId 白名单：只允许字母数字与下划线/连字符（宿主 run id 是自增数字，但别把路径交给上游拼）。 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/**
 * 安全日期：只接受严格的 YYYY-MM-DD 且必须是真实存在的日期（2 月 31 日过得了正则但不是日期）。
 * 不合法一律回落当天 UTC 日期——文件名绝不能由调用方任意字符串拼出来。
 *
 * @param {unknown} value
 * @returns {string} YYYY-MM-DD
 */
function safeDay(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (DAY_RE.test(text)) {
    const date = new Date(`${text}T00:00:00Z`)
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text) return text
  }
  return new Date().toISOString().slice(0, 10)
}

/**
 * 报告文件名：`session-wrap-<YYYY-MM-DD>-<sha256(sessionId) 前 8 位>-r<runId>.md`。
 *
 * 为什么 sessionId 要 hash 而不是直接用：sessionId 由宿主生成，格式不受本仓控制；
 * 直接拼进路径就等于把路径穿越风险交给上游。hash 后只剩 [0-9a-f]，天然安全，
 * 同时仍能对同一会话稳定复现。
 * 为什么必须带 runId：同一会话同一天可能多次收尾（手动重试、断点续跑），
 * 只用日期+会话 hash 会互相覆盖；runId 是 run 表自增 id，天然区分每次收尾。
 *
 * @param {{day?: string, sessionId?: string, runId?: string|number}} [input]
 *   sessionId 缺失按 'unknown' 参与 hash；runId 缺失/非法落 '0'（即 r0）
 * @returns {string} 只由固定前缀 + 安全日期 + 安全 hash + 安全 runId 组成的文件名
 */
export function wrapReportFileName({ day, sessionId, runId } = {}) {
  const date = safeDay(day)
  const rawId = sessionId === undefined || sessionId === null ? '' : String(sessionId)
  const source = rawId.trim() ? rawId : 'unknown'
  const hash = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 8)
  const rawRun = runId === undefined || runId === null ? '' : String(runId).trim()
  // 非白名单字符一律回 0：文件名绝不能由调用方任意字符串拼出来（路径穿越在这里被切断）。
  const runToken = RUN_ID_RE.test(rawRun) ? rawRun : '0'
  return `session-wrap-${date}-${hash}-r${runToken}.md`
}

/** runId 可能是数字（wrap_runs.id 自增）也可能是字符串，统一转成非空字符串。 */
function pickId(value, fields = []) {
  const text = pickText(value, fields)
  if (text) return text
  if (!value || typeof value !== 'object') return ''
  for (const field of fields) {
    const got = value[field]
    if (typeof got === 'number' && Number.isFinite(got)) return String(got)
  }
  return ''
}

/** 任意值取非空字符串（对象按给定字段顺序取第一个可用的）。 */
function pickText(value, fields = []) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  for (const field of fields) {
    const got = value[field]
    if (typeof got === 'string' && got.trim()) return got.trim()
  }
  return ''
}

/**
 * 状态后缀：只认指定前缀的 status，其余忽略。
 *
 * 为什么需要：续跑断点会把「写库失败 / 规则提案被拒」记进条目的 status；
 * 报告若只显示条目本身，读者会以为已经落库，实际库里一行没有——必须当场可见。
 */
function statusSuffix(status, prefix, label) {
  if (typeof status !== 'string') return ''
  const trimmed = status.trim()
  if (!trimmed.startsWith(prefix)) return ''
  const reason = trimmed.slice(prefix.length).trim()
  return reason ? `（${label}：${reason}）` : `（${label}）`
}

/** 渲染候选列表：每行 `- [kind] text`；字符串条目按 fact 处理（不要静默丢信息）。 */
function renderCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  const lines = []
  for (const item of list) {
    const text = pickText(item, ['text', 'summary'])
    if (!text) continue
    const kind = typeof item === 'object' && item && typeof item.kind === 'string' && item.kind.trim()
      ? item.kind.trim()
      : 'fact'
    const suffix = statusSuffix(item && item.status, 'write_failed:', '写入失败')
    lines.push(`- [${kind}] ${text}${suffix ? ` ${suffix}` : ''}`)
  }
  return lines.length ? lines.join('\n') : EMPTY
}

/**
 * 蒸馏剔除说明：把 dropped 按 reason 聚合成一行。
 *
 * 为什么需要：validateDistillItems 会把「证据找不到/重复/超长」的条目丢掉，
 * 若报告只显示保留项，读者会以为模型什么都没产出——丢弃必须可见（铁律 22）。
 */
function renderDroppedNote(dropped) {
  const list = Array.isArray(dropped) ? dropped : []
  if (!list.length) return ''
  const reasons = new Map()
  for (const entry of list) {
    const reason = entry && typeof entry === 'object' && typeof entry.reason === 'string' && entry.reason
      ? entry.reason
      : 'unknown'
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
  }
  const parts = [...reasons].map(([reason, n]) => `${reason}×${n}`)
  return `（蒸馏剔除 ${list.length} 条：${parts.join('、')}）`
}

/** 渲染规则提案：每行 `- text`，被拒的提案带上原因。 */
function renderProposals(ruleProposals) {
  const list = Array.isArray(ruleProposals) ? ruleProposals : []
  const lines = []
  for (const item of list) {
    const text = pickText(item, ['text', 'summary', 'rule'])
    if (!text) continue
    // 规则提案只有「已创建」与「未创建」两种结果：proposal_rejected 和提案写入异常
    // （status=write_failed:*）都代表库里没有这条规则，报告必须说「未创建」，不能当成已提案。
    const rejected = statusSuffix(item && item.status, 'proposal_rejected:', '未创建')
    const failed = rejected ? '' : statusSuffix(item && item.status, 'write_failed:', '未创建')
    const suffix = rejected || failed
    lines.push(`- ${text}${suffix ? ` ${suffix}` : ''}`)
  }
  return lines.length ? lines.join('\n') : EMPTY
}

/** 渲染待办：open loop 可能是字符串、或带 text/summary/what 的对象。 */
function renderOpenLoops(openLoops) {
  const list = Array.isArray(openLoops) ? openLoops : []
  const lines = list.map((item) => pickText(item, ['text', 'summary', 'what'])).filter(Boolean)
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : EMPTY
}

/** 渲染清洁检查：`- key: status — detail`；未运行时写「（未运行）」。 */
function renderHygiene(hygiene) {
  const checks = hygiene && Array.isArray(hygiene.checks) ? hygiene.checks : []
  const lines = []
  for (const check of checks) {
    if (!check || typeof check !== 'object') continue
    const key = typeof check.key === 'string' && check.key.trim() ? check.key.trim() : 'unknown'
    const status = typeof check.status === 'string' && check.status.trim() ? check.status.trim() : 'warn'
    const detail = typeof check.detail === 'string' ? check.detail.trim() : ''
    lines.push(`- ${key}: ${status}${detail ? ` — ${detail}` : ''}`)
  }
  return lines.length ? lines.join('\n') : '（未运行）'
}

/** 渲染可切判定：boolean 或 {ready, blockers} 两种入参都吃，缺失当「否」。 */
function renderSwitchReady(switchReady) {
  const source = switchReady && typeof switchReady === 'object' ? switchReady : { ready: switchReady }
  const ready = Boolean(source && source.ready)
  const blockers = source && Array.isArray(source.blockers)
    ? source.blockers.map((item) => pickText(item, ['text', 'reason'])).filter(Boolean)
    : []
  const lines = [`- 可切：${ready ? '是' : '否'}`]
  if (blockers.length) {
    lines.push('- 阻塞：')
    for (const blocker of blockers) lines.push(`  - ${blocker}`)
  }
  return lines.join('\n')
}

/**
 * 渲染收尾报告 Markdown。
 *
 * 二级标题固定且仅这六个：结论 / 记忆候选 / 规则提案 / 待办 / 清洁检查 / 可切会话。
 * 多一个标题都会让下游的「按节解析」出错，所以任何诊断信息只能进正文行，不进标题。
 *
 * @param {object} input
 * @param {{day?: string, trigger?: string, runId?: string, id?: string}} [input.run] 本次收尾元信息
 * @param {string} [input.summary] 一句话结论
 * @param {Array<{kind?: string, text?: string}>} [input.candidates] 记忆候选
 * @param {Array<string|{text?: string}>} [input.ruleProposals] 规则提案
 * @param {Array<string|{text?: string}>} [input.openLoops] 待办 / open loops
 * @param {{checks?: Array<{key: string, status: string, detail?: string}>}} [input.hygiene] 清洁检查结果
 * @param {boolean|{ready?: boolean, blockers?: string[]}} [input.switchReady] 可切会话判定
 * @param {string} [input.generatedAt] 生成时间（原样展示，不做时区推断）
 * @param {Array<{reason?: string}>} [input.dropped] 蒸馏剔除项（只输出按原因聚合的计数，不输出正文）
 * @returns {string} Markdown 报告
 */
export function renderWrapReport({
  run, summary, candidates, ruleProposals, openLoops, hygiene, switchReady, generatedAt, dropped, decisions = null,
} = {}) {
  const runMeta = run && typeof run === 'object' ? run : {}
  const runId = pickId(runMeta, ['runId', 'id']) || '-'
  const trigger = pickText(runMeta, ['trigger']) || '-'
  const day = safeDay(
    typeof runMeta.day === 'string' && DAY_RE.test(runMeta.day.trim())
      ? runMeta.day
      : typeof generatedAt === 'string' && DAY_RE.test(generatedAt.slice(0, 10))
        ? generatedAt.slice(0, 10)
        : '',
  )
  const conclusion = typeof summary === 'string' && summary.trim() ? summary.trim() : NO_SUMMARY
  const droppedNote = renderDroppedNote(dropped)
  const candidatesSection = droppedNote
    ? `${renderCandidates(candidates)}\n\n${droppedNote}`
    : renderCandidates(candidates)
  const metaLine = `trigger: ${trigger} · runId: ${runId} · 生成时间: ${
    typeof generatedAt === 'string' && generatedAt.trim() ? generatedAt.trim() : '-'
  }`
  return [
    `# 会话收尾报告 ${day}`,
    '',
    metaLine,
    '',
    '## 结论',
    '',
    conclusion,
    '',
    '## 记忆候选',
    '',
    candidatesSection,
    '',
    ...(decisions ? ['## 整合决策', '', renderDecisions(decisions), ''] : []),
    '## 规则提案',
    '',
    renderProposals(ruleProposals),
    '',
    '## 待办',
    '',
    renderOpenLoops(openLoops),
    '',
    '## 清洁检查',
    '',
    renderHygiene(hygiene),
    '',
    '## 可切会话',
    '',
    renderSwitchReady(switchReady),
    '',
  ].join('\n')
}
