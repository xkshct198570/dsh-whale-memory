/**
 * 写入判定器（`write.judge='llm'`）：候选 → 短整数 id → 模型裁决 → 还原真实节点。
 *
 * 为什么用短整数而不是真实节点 id：
 * - 真实 id 是 `n<毫秒>_<hash 前 10 位>`，模型复述时容易错一位；短 id 由本地映射表唯一还原，
 *   越界/编造的编号一律解析失败并回落规则，不会被当成合法目标。
 * - 提示词里只出现编号与正文，不出现真实 id：模型无法编造"看起来像 id"的东西，
 *   幻觉最多命中一个候选编号，而不是凭空指向库里的另一行。
 * - 三个函数都是纯函数（不依赖库、模型、时钟），可脱库单测；模型调用与超时在队列侧。
 */

/** 单条候选正文截断（提示词体积与审计 P0 的 token 成本闸门）。 */
const MAX_LINE_CHARS = 300
/** 新事件正文上限（与 writer 的 TEXT_LIMIT=500 同值：判定要看全文，不能只喂前 300 字）。 */
const MAX_NEW_CHARS = 500
/** 裁决理由上限（落审计/日志，不占正文）。 */
const MAX_REASON_CHARS = 40
/** 合法动作枚举（与 writer.js 的既有落库分支一一对应）。 */
export const JUDGE_ACTIONS = ['NOOP', 'MERGE', 'SUPERSEDE', 'ADD']
const ACTION_SET = new Set(JUDGE_ACTIONS)

/**
 * 候选节点 → 短整数 id 映射 + 提示词行。
 *
 * 顺序即编号顺序（调用方决定，通常是最新优先），同一批候选重复调用结果稳定。
 * 行里只放 `层级/类型/正文截断`，真实 id 不出现在任何返回字段的展示文本里。
 *
 * @param {Array<{ id?: unknown, text?: unknown, level?: unknown, memory_type?: unknown }>} candidates
 * @returns {{ map: Record<string, string>, lines: string[] }}
 *   map: `{ '1': 'n...', ... }`（编号 → 真实节点 id）
 */
export function mapCandidates(candidates) {
  const map = {}
  const lines = []
  let n = 0
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const nodeId = row?.id === null || row?.id === undefined ? '' : String(row.id)
    if (!nodeId) continue
    n += 1
    map[String(n)] = nodeId
    const level = String(row?.level ?? '') || 'normal'
    const type = String(row?.memory_type ?? '') || 'semantic'
    const text = String(row?.text ?? '').slice(0, MAX_LINE_CHARS)
    lines.push(`${n}. [${level}/${type}] ${text}`)
  }
  return { map, lines }
}

/**
 * 判定提示词：只复述候选，不许编造；只回一个 JSON 对象。
 * @param {string} newText 新事件正文（已脱敏）
 * @param {string[]} lines mapCandidates 产出的候选行
 * @returns {string}
 */
export function buildJudgePrompt(newText, lines) {
  const body = (Array.isArray(lines) ? lines : []).join('\n')
  const text = String(newText ?? '').slice(0, MAX_NEW_CHARS)
  return [
    '你是记忆写入判定器：判断下面这条新事件与候选记忆的关系。',
    '',
    '候选记忆（编号. [层级/类型] 正文）：',
    body || '（无候选）',
    '',
    '新事件：',
    text,
    '',
    '只输出一个 JSON 对象，不要输出解释、不要输出多个对象：',
    '{"id":<候选编号整数或0>,"action":"NOOP|MERGE|SUPERSEDE|ADD","reason":"≤40字"}',
    '判定口径：',
    '- id=0 表示与所有候选都无关，此时 action 必须是 ADD（新增一条）。',
    '- NOOP：新事件与候选是同一事实的重复，不新增。',
    '- MERGE：新事件是对候选的补充（同一事实更完整），合并进该候选。',
    '- SUPERSEDE：新事件与候选矛盾且更新，取代该候选。',
    '- 只复述候选里出现的事实，不许编造候选之外的记忆或编号。',
  ].join('\n')
}

/**
 * 解析裁决：剥 ```json 围栏 → 取首个配平的 `{...}` → JSON.parse → 校验编号与动作。
 *
 * 校验口径：id 必须是整数且 ∈ map（或 0）；id=0 只允许 ADD（没有目标却要合并/取代是矛盾输出）；
 * 动作必须在枚举内；reason 截 40 字。任何一项不过都返回 `{ok:false,error}`，由调用方回落规则。
 *
 * @param {unknown} raw 模型原文
 * @param {Record<string, string>} map 编号 → 真实 id
 * @returns {{ ok: true, id: number, targetId: string|null, action: string, reason: string }
 *   | { ok: false, error: string }}
 */
export function parseJudgeOutput(raw, map) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = text.indexOf('{')
  if (start === -1) return { ok: false, error: 'no_json' }

  // 配平首个对象：模型常把 JSON 包在解释文字里，indexOf('}')/lastIndexOf('}') 都会截错。
  let end = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end <= start) return { ok: false, error: 'bad_json' }

  let obj
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ok: false, error: 'bad_json' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'bad_json' }

  const id = Number(obj.id)
  if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'bad_id' }
  const action = String(obj.action ?? '').trim().toUpperCase()
  if (!ACTION_SET.has(action)) return { ok: false, error: 'bad_action' }
  /** @type {string|null} */
  let targetId = null
  if (id !== 0) {
    const hit = map?.[String(id)]
    if (!hit) return { ok: false, error: 'unknown_target' }
    targetId = String(hit)
  } else if (action !== 'ADD') {
    return { ok: false, error: 'target_required' }
  }
  const reason = String(obj.reason ?? '').trim().slice(0, MAX_REASON_CHARS)
  return { ok: true, id, targetId, action, reason }
}
