// 职责：收尾“整合”阶段的模型侧纯函数（提示词/容错解析/决策校验）；依赖：零 import。
//
// 语义（v2 架构书 §4）：Distill 产出候选条目后，把它们与既有记忆邻居比对，产出
// ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW 决策 + 改写后的短语义；默认只进影子候选，逐条可审。
// 本模块只管“形状与硬判据”，不查库、不调模型、不写库。

/** 允许的决策动作（与 writes.action/review accept 对齐；ARCHIVE 由 S3 新增支持）。 */
export const RECONCILE_OPS = Object.freeze(['ADD', 'UPDATE', 'MERGE', 'ARCHIVE', 'NOOP', 'REVIEW'])
const OP_SET = new Set(RECONCILE_OPS)
const HEDGE_PREFIXES = Object.freeze(['我觉得', '我感觉', '可能', '大概', '或许', '似乎', '应该是'])
const NODE_FENCE_HEAD = /^```(?:json)?\s*/i
const NODE_FENCE_TAIL = /\s*```$/
const MAX_AFTER = 200
const MAX_REASON = 160
const MAX_EVIDENCE = 400

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\s\u3000]+/gu, ' ').trim()
}

/**
 * 构造整合提示词。
 *
 * @param {Array<{kind:string,text:string,evidence?:string}>} items 蒸馏条目
 * @param {Array<{id:string,text:string,level?:string,status?:string,updated_at?:number}>} neighbors
 *   每条候选的邻居（已按身份过滤/截断），格式由调用方拼成“候选 N 的邻居”。
 * @returns {string}
 */
export function buildReconcilePrompt(items, neighbors) {
  const list = Array.isArray(items) ? items : []
  const neigh = Array.isArray(neighbors) ? neighbors : []
  const lines = [
    '你是会话收尾的记忆整合器。把下面每条候选与它的既有记忆邻居比对，输出决策。',
    '',
    '只输出一个 JSON 对象，不要解释、不要代码围栏：',
    '{"decisions":[{"item":0,"op":"MERGE","targetId":"n1","afterText":"改写后的可执行短语义（≤200字）",'
      + '"reason":"一句话依据","evidence":"邻居或候选里逐字出现的原文片段"}]}',
    `op 只能是 ${RECONCILE_OPS.join(' / ')} 之一。`,
    'ADD=新事实无相似；UPDATE=同一条目信息更新；MERGE=补充/细化既有节点；',
    'ARCHIVE=既有节点被本轮事实推翻作废（只改状态，不删行）；NOOP=重复无需变更；REVIEW=不确定或目标受保护。',
    'targetId 必须来自该候选的邻居 id，不得编造。afterText 只写能回答「做什么·何时·怎么判」的短语义，',
    '禁止「可能/大概/我觉得」等主观前缀，禁止「这次/刚才/上面」等相对指代，≤200 字。',
    'evidence 必须是候选或邻居文本里逐字出现的连续片段；找不到就不写这条决策。',
    '',
  ]
  list.forEach((item, index) => {
    lines.push(`候选 ${index}：kind=${String(item?.kind || '')}；text=${normalizeText(item?.text)}`)
    if (item?.evidence) lines.push(`  素材证据：${normalizeText(item.evidence).slice(0, MAX_EVIDENCE)}`)
    const mine = neigh.filter((row) => Number(row.itemIndex ?? -1) === index)
    if (mine.length === 0) {
      lines.push('  邻居：（无）')
    } else {
      for (const row of mine) {
        lines.push(`  邻居 ${row.id}：level=${String(row.level || '')}；updated=${Number(row.updated_at || 0)}；text=${normalizeText(row.text).slice(0, 200)}`)
      }
    }
  })
  return lines.join('\n')
}

/**
 * 容错解析模型输出（围栏/首个 `{` 到末 `}`），形状错返回 ok=false（调用方转 run=failed）。
 * @param {unknown} raw
 * @returns {{ok:boolean, decisions:Array<object>, error?:string}}
 */
export function parseReconcileOutput(raw) {
  const text = String(raw ?? '').trim().replace(NODE_FENCE_HEAD, '').replace(NODE_FENCE_TAIL, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { ok: false, decisions: [], error: 'bad_json' }
  let parsed
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return { ok: false, decisions: [], error: 'bad_json' } }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.decisions)) {
    return { ok: false, decisions: [], error: 'bad_shape' }
  }
  const decisions = parsed.decisions.map((row) => ({
    item: Number(row?.item),
    op: String(row?.op || '').toUpperCase(),
    targetId: row?.targetId === null || row?.targetId === undefined ? '' : String(row.targetId),
    mergeItems: Array.isArray(row?.mergeItems) ? row.mergeItems.map((n) => Number(n)) : [],
    afterText: normalizeText(row?.afterText),
    reason: normalizeText(row?.reason).slice(0, MAX_REASON),
    evidence: normalizeText(row?.evidence).slice(0, MAX_EVIDENCE),
    // S4 校正建议（可选）：不合法整项拒绝，避免“半套校正”写坏等级/类型。
    level: row?.level === undefined ? '' : String(row.level),
    memoryType: row?.memoryType === undefined ? '' : String(row.memoryType),
    tags: Array.isArray(row?.tags) ? row.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : [],
  }))
  return { ok: true, decisions }
}

/** 主观前缀/相对指代/超长判据：不合格返回原因。 */
function textProblem(text) {
  const value = normalizeText(text)
  if (!value) return 'empty'
  if (Array.from(value).length > MAX_AFTER) return 'too_long'
  for (const hedge of HEDGE_PREFIXES) if (value.includes(hedge)) return 'hedge'
  if (/这次|刚才|上面|上次/.test(value)) return 'relative'
  return ''
}

/**
 * 决策硬判据校验。
 *
 * @param {Array<object>} decisions parse 后的决策
 * @param {{
 *   items:Array<object>, neighbors:Array<{id:string,itemIndex:number,text:string}>,
 * }} ctx
 * @returns {{valid:Array<object>, rejected:Array<{decision:object,error:string}>}}
 */
export function validateDecisions(decisions, { items = [], neighbors = [] } = {}) {
  const list = Array.isArray(items) ? items : []
  const allowed = new Map()
  for (const row of Array.isArray(neighbors) ? neighbors : []) {
    if (row && row.id) allowed.set(String(row.id), row)
  }
  const valid = []
  const rejected = []
  const seen = new Set()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const op = String(decision?.op || '')
    const itemIndex = Number(decision?.item)
    const key = `${itemIndex}|${op}|${String(decision?.targetId || '')}`
    if (!OP_SET.has(op)) { rejected.push({ decision, error: 'bad_op' }); continue }
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= list.length) {
      rejected.push({ decision, error: 'bad_item' }); continue
    }
    const needsTarget = op === 'UPDATE' || op === 'MERGE' || op === 'ARCHIVE'
    const targetId = String(decision?.targetId || '')
    const mergeItems = Array.isArray(decision?.mergeItems) ? decision.mergeItems : []
    // S4：MERGE 允许“跨候选合并”——无 target 时必须有 mergeItems（同主题多条合成一条）。
    if (op === 'MERGE' && !targetId) {
      if (mergeItems.length === 0) { rejected.push({ decision, error: 'target_required' }); continue }
      if (mergeItems.some((n) => !Number.isInteger(n) || n < 0 || n >= list.length || n === itemIndex)) {
        rejected.push({ decision, error: 'bad_item' }); continue
      }
    } else if (needsTarget) {
      if (!targetId) { rejected.push({ decision, error: 'target_required' }); continue }
      if (!allowed.has(targetId)) { rejected.push({ decision, error: 'target_not_neighbor' }); continue }
    }
    const LEVELS = new Set(['core', 'important', 'normal'])
    const TYPES = new Set(['procedural', 'semantic', 'episodic', 'mixed'])
    if (decision?.level && !LEVELS.has(decision.level)) { rejected.push({ decision, error: 'bad_level' }); continue }
    if (decision?.memoryType && !TYPES.has(decision.memoryType)) { rejected.push({ decision, error: 'bad_memory_type' }); continue }
    if (Array.isArray(decision?.tags) && decision.tags.some((tag) => Array.from(String(tag)).length > 24)) {
      rejected.push({ decision, error: 'bad_tags' }); continue
    }
    // 去重放在形状/校正判据之后：先保证错误原因准确，再谈重复。
    if (seen.has(key)) { rejected.push({ decision, error: 'duplicate' }); continue }
    if (targetId && !allowed.has(targetId)) { rejected.push({ decision, error: 'target_not_neighbor' }); continue }
    if (op !== 'NOOP' && op !== 'ARCHIVE') {
      const problem = textProblem(decision?.afterText)
      if (problem) { rejected.push({ decision, error: `text_${problem}` }); continue }
      const evidence = normalizeText(decision?.evidence)
      const haystacks = [normalizeText(list[itemIndex]?.text), normalizeText(list[itemIndex]?.evidence)]
      for (const index of mergeItems) {
        if (Number.isInteger(index) && list[index]) {
          haystacks.push(normalizeText(list[index]?.text), normalizeText(list[index]?.evidence))
        }
      }
      if (targetId) haystacks.push(normalizeText(allowed.get(targetId)?.text))
      if (evidence && !haystacks.some((hay) => hay.includes(evidence))) {
        rejected.push({ decision, error: 'evidence_mismatch' }); continue
      }
    }
    seen.add(key)
    valid.push({
      ...decision,
      item: itemIndex,
      targetId,
      afterText: op === 'ARCHIVE' || op === 'NOOP' ? '' : decision.afterText,
      mergeItems: op === 'MERGE' && !targetId ? mergeItems : [],
      level: decision.level || '',
      memoryType: decision.memoryType || '',
      tags: Array.isArray(decision.tags) ? decision.tags : [],
    })
  }
  return { valid, rejected }
}
