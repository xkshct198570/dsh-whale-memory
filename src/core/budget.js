/**
 * 注入预算（架构书 §5.4）：按意图分档，纯函数、无 IO、无 SQL。
 *
 * 为什么按意图分档：默认 5 条/1500 字的固定预算在闲聊时白烧 token，在排障时又不够；
 * 画图/创作链路必须 0 注入（生成 prompt 不能被旧事污染）。分档表是唯一真源，
 * 面板/文档/测试都从这里取值，禁止在 hook 或 backend 里再写第二份。
 *
 * 裁剪顺序（§5.4 定死）：低分条目 → normal 层级 → 单条超长截断（保留首句 + 省略号）。
 * 截断只发生在注入侧，绝不回写库（库内保留 500 字原文）。
 */

/** 单条注入硬顶（字）：库内可存 500，注入最多 300。 */
export const NODE_INJECT_CAP = 300

/** 意图 → 预算（唯一表）。 */
export const INTENT_TABLE = {
  chat: { maxHits: 3, charBudget: 1200 },
  procedural: { maxHits: 5, charBudget: 2500 },
  episodic: { maxHits: 4, charBudget: 1600 },
  creative: { maxHits: 0, charBudget: 0 },
}

const CREATIVE_RE = /(画图|绘图|出图|生成图|生成图片|生成视频|文生图|图生图|做一张|画一张|配图|海报|封面图|comfyui)/i
const EPISODIC_RE = /(上次|上回|之前|以前|记得|那天|昨晚|刚才|上次说)/
const PROCEDURAL_RE = /(怎么做|如何|步骤|排障|为什么|规则|流程|方法|配置|开启|关闭|修复|报错|失败|判据)/

/**
 * 从查询文本推断意图（不调模型；关键词规则即可解释、可测试）。
 * @param {string} query
 * @returns {'creative'|'episodic'|'procedural'|'chat'}
 */
export function inferIntent(query) {
  const text = String(query || '').trim()
  if (!text) return 'chat'
  // 创作链路优先：即使句子里有"怎么做"，画图请求也必须 0 注入。
  if (CREATIVE_RE.test(text)) return 'creative'
  if (EPISODIC_RE.test(text)) return 'episodic'
  if (PROCEDURAL_RE.test(text)) return 'procedural'
  return 'chat'
}

/**
 * 取意图预算，并与用户配置取小（用户调小后预算不得反被表放大）。
 * @param {string} intent
 * @param {{ intentBudget?: boolean, maxHits?: number, charBudget?: number }} [cfg]
 * @returns {{ intent: string, maxHits: number, charBudget: number }}
 */
export function forIntent(intent, cfg = {}) {
  const userMax = Number(cfg.maxHits)
  const userChars = Number(cfg.charBudget)
  // 未传配置 = 用表值；传了配置才取小（面板把全局字符上限调小后，分档不得反把它放大）。
  const fixedHits = Number.isFinite(userMax) ? Math.max(0, Math.floor(userMax)) : Infinity
  const fixedChars = Number.isFinite(userChars) ? Math.max(0, Math.floor(userChars)) : Infinity
  if (cfg.intentBudget === false) {
    return {
      intent: intent || 'chat',
      maxHits: Number.isFinite(fixedHits) ? fixedHits : 5,
      charBudget: Number.isFinite(fixedChars) ? fixedChars : 1500,
    }
  }

  const row = INTENT_TABLE[intent] || INTENT_TABLE.chat
  return {
    intent: INTENT_TABLE[intent] ? intent : 'chat',
    maxHits: Math.min(row.maxHits, fixedHits),
    charBudget: Math.min(row.charBudget, fixedChars),
  }
}

/**
 * 单条注入截断：优先在句读处收尾，找不到就硬切，尾部加省略号。
 * @param {string} text
 * @param {number} [cap]
 * @returns {string}
 */
export function clipForInject(text, cap = NODE_INJECT_CAP) {
  const raw = String(text || '')
  const limit = Math.max(1, Math.floor(cap))
  if (raw.length <= limit) return raw
  const window = raw.slice(0, limit)
  let cut = -1
  for (let i = window.length - 1; i >= 60; i -= 1) {
    if ('。！？；.!?;'.includes(window[i])) { cut = i + 1; break }
  }
  const body = cut > 0 ? window.slice(0, cut) : window.slice(0, limit - 1)
  return `${body}…`
}

/**
 * 按预算裁剪命中（不改库，只改注入副本）。
 * @param {Array<{text:string, level?:string, score?:number}>} hits 已按分数降序
 * @param {{ maxHits?: number, charBudget?: number, cap?: number }} [limits]
 * @returns {{ hits: any[], chars: number, dropped: number, clipped: number }}
 */
export function trimHits(hits, limits = {}) {
  const maxHits = Math.max(0, Math.floor(Number(limits.maxHits ?? 5)))
  const charBudget = Math.max(0, Math.floor(Number(limits.charBudget ?? 1500)))
  const cap = Math.max(1, Math.floor(Number(limits.cap ?? NODE_INJECT_CAP)))

  let clipped = 0
  const selected = (Array.isArray(hits) ? hits : []).slice(0, maxHits).map((hit) => {
    const text = clipForInject(hit?.text, cap)
    if (text !== String(hit?.text ?? '')) clipped += 1
    return { ...hit, text }
  })

  let chars = selected.reduce((sum, hit) => sum + String(hit.text).length, 0)
  let dropped = 0
  while (chars > charBudget && selected.length > 0) {
    // 低分优先：尾部找 normal；全是 core/important 时砍最后一条（预算硬顶不可破）。
    let idx = -1
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      if (selected[i].level === 'normal' || !selected[i].level) { idx = i; break }
    }
    if (idx === -1) idx = selected.length - 1
    chars -= String(selected[idx].text).length
    selected.splice(idx, 1)
    dropped += 1
  }
  return { hits: selected, chars, dropped, clipped }
}

/**
 * 一次性算好本轮预算（hook/backend 共用入口）。
 * @param {string} query
 * @param {{ intentBudget?: boolean, maxHits?: number, charBudget?: number }} cfg
 */
export function planBudget(query, cfg = {}) {
  const intent = inferIntent(query)
  return forIntent(intent, cfg)
}
