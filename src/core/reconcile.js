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
    afterText: normalizeText(row?.afterText),
    reason: normalizeText(row?.reason).slice(0, MAX_REASON),
    evidence: normalizeText(row?.evidence).slice(0, MAX_EVIDENCE),
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
    if (seen.has(key)) { rejected.push({ decision, error: 'duplicate' }); continue }
    const needsTarget = op === 'UPDATE' || op === 'MERGE' || op === 'ARCHIVE'
    const targetId = String(decision?.targetId || '')
    if (needsTarget) {
      if (!targetId) { rejected.push({ decision, error: 'target_required' }); continue }
      if (!allowed.has(targetId)) { rejected.push({ decision, error: 'target_not_neighbor' }); continue }
    }
    if (targetId && !allowed.has(targetId)) { rejected.push({ decision, error: 'target_not_neighbor' }); continue }
    if (op !== 'NOOP' && op !== 'ARCHIVE') {
      const problem = textProblem(decision?.afterText)
      if (problem) { rejected.push({ decision, error: `text_${problem}` }); continue }
      const evidence = normalizeText(decision?.evidence)
      const haystacks = [normalizeText(list[itemIndex]?.text), normalizeText(list[itemIndex]?.evidence)]
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
    })
  }
  return { valid, rejected }
}
