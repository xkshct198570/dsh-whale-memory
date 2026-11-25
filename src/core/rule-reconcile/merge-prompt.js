// 职责：合并/改写提示词构建与 LLM 回包容错解析；依赖：./compile.js（textOf/trimmed/normalizeDoc）；不 import 门面。
import { normalizeDoc, textOf, trimmed } from './compile.js'

// ---------------------------------------------------------------------------
// 合并提示词 / 回包解析
// ---------------------------------------------------------------------------

/** 规则要点摘要（prompt 用；不塞整份文件，省 token 也避免模型抄格式）。 */
function ruleBrief(doc) {
  const { front, text } = normalizeDoc(doc)
  return {
    key: trimmed(front.key),
    number: front.number ?? null,
    type: trimmed(front.type),
    scope: trimmed(front.scope),
    modality: trimmed(front.modality),
    conditions: Array.isArray(front.conditions) ? front.conditions : [],
    exceptions: Array.isArray(front.exceptions) ? front.exceptions : [],
    text: textOf(text),
  }
}

/**
 * 合并/改写提示词（架构书 §4.4）：模型只改措辞，不改结构、不扩权。
 * @param {{draft:object, affected?:Array<any>}} args
 * @returns {{system:string, user:string}}
 */
export function buildMergePrompt({ draft = null, affected = [] } = {}) {
  const system = [
    '你是规则文本编辑器，只做措辞合并，不做规则判定。',
    '硬约束：',
    '1. 不得新增原文没有的义务，不得删除任何旧「例外」条目；',
    '2. 不得弱化模态（禁止/不得 不得改成 尽量/建议；必须 不得改成 建议）；',
    '3. 不得改变作用域 scope、编号 number、类型 type；',
    '4. 正文 1–500 字、指令形态、无理由句、无链接、无模糊词（尽量/最好/尽可能/酌情）；',
    '5. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  ].join('\n')
  const payload = {
    draft: draft ? {
      key: trimmed(draft.key),
      type: trimmed(draft.type),
      scope: trimmed(draft.scope),
      modality: trimmed(draft.modality),
      action: trimmed(draft.action),
      object: trimmed(draft.object),
      conditions: Array.isArray(draft.conditions) ? draft.conditions : [],
      exceptions: Array.isArray(draft.exceptions) ? draft.exceptions : [],
      text: textOf(draft.text),
    } : null,
    affected: (Array.isArray(affected) ? affected : []).map(ruleBrief),
  }
  const user = [
    '把下面的新草案与受影响旧规则合并成一条正文（只改措辞）。',
    '输入：',
    JSON.stringify(payload, null, 2),
    '输出 JSON 结构：',
    '{"merged_text":"合并后的规则正文","affected":[{"key":"旧规则 key","new_text":"该旧规则改写后的正文"}],"preserved":["保留的子句"],"dropped":["丢弃的子句"]}',
    'affected 只列出确实需要改写的旧规则；无需改写时给 []。',
  ].join('\n')
  return { system, user }
}

/** 从模型回包里抠出第一个 JSON 对象（容忍 ```json 围栏与前后解释文字）。 */
function firstJsonObject(raw) {
  const text = textOf(raw).replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')
  const start = text.indexOf('{')
  if (start < 0) return ''
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
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 容错解析 LLM 合并回包。
 * 只信 `merged_text`（也容忍 `merged`/`body` 这类漂移字段名）；结构不对就报错，
 * 绝不"猜"正文——猜出来的规则会绕过守卫的语义校验。
 *
 * @param {string} text
 * @returns {{ok:true, value:{merged_text:string, affected:Array<{key:string,new_text:string}>,
 *   preserved:string[], dropped:string[]}} | {ok:false, error:string}}
 */
export function parseMergeReply(text) {
  const json = firstJsonObject(text)
  if (!json) return { ok: false, error: 'no_json' }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'bad_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'not_object' }
  const mergedText = trimmed(parsed.merged_text ?? parsed.merged ?? parsed.body)
  if (!mergedText) return { ok: false, error: 'merged_text_missing' }
  const affected = []
  for (const item of Array.isArray(parsed.affected) ? parsed.affected : []) {
    const key = trimmed(item?.key)
    const newText = trimmed(item?.new_text ?? item?.text)
    if (!key || !newText) continue
    affected.push({ key, new_text: newText })
  }
  const listOf = (value) => (Array.isArray(value) ? value.map((x) => trimmed(x)).filter(Boolean) : [])
  return {
    ok: true,
    value: { merged_text: mergedText, affected, preserved: listOf(parsed.preserved), dropped: listOf(parsed.dropped) },
  }
}
