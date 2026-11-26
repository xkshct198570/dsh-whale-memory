// 职责：反思提示词与输出解析（纯函数，不 import DB/模型/host）；被 core/reflect.js 与测试 import。
// 依赖方向：零依赖；禁止在这里读配置或落库。

const MAX_MATERIAL = 6000
const MAX_ITEM_CHARS = 500

export function buildReflectPrompt(items, { maxItems = 8 } = {}) {
  const body = (items || []).map((it, i) => `${i + 1}. ${String(it.text || '').slice(0, 500)}`).join('\n')
  return [
    '你是记忆整理器。把下面的经历片段提炼成可长期复用的规则/事实。',
    `最多 ${maxItems} 条；只输出 JSON 数组，每项 {"text":"...","type":"semantic|procedural"}。`,
    '要求：只复述素材里出现的事实；不要编造、不要写解释、不要超过 500 字；没有可提炼的就输出 []。',
    '',
    body,
  ].join('\n').slice(0, MAX_MATERIAL)
}

export function parseReflectOutput(raw) {
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let arr
  try { arr = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({
      text: x.text.trim().slice(0, MAX_ITEM_CHARS),
      type: x.type === 'procedural' ? 'procedural' : 'semantic',
    }))
}
