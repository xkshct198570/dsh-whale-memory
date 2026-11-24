import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTILL_KINDS, buildDistillPrompt, clampSummary, normalizeEvidence,
  parseDistillOutput, validateDistillItems,
} from '../../src/core/distill.js'

const MATERIAL = {
  turns: [
    { role: 'user', text: '以后都用 pnpm 装依赖，禁止直接 npm install。' },
    { role: 'assistant', text: '收到，仓库是 dsh-whale-memory，端口 3080。' },
  ],
}

test('buildDistillPrompt：含 JSON 对象契约/条数上限/证据硬规则/不得编造', () => {
  const prompt = buildDistillPrompt(MATERIAL, { maxItems: 5 })
  assert.match(prompt, /只输出一个 JSON 对象/)
  assert.match(prompt, /summary/)
  assert.match(prompt, /items 最多 5 条/)
  assert.match(prompt, /kind 只能是 lesson \/ decision \/ preference \/ fact \/ open_loop \/ rule/)
  assert.match(prompt, /evidence 必须是素材里出现过的连续原文片段/)
  assert.match(prompt, /不要寒暄/)
  assert.match(prompt, /不要编造/)
  assert.match(prompt, /没有可提炼的内容就输出/)
  assert.match(prompt, /\[u1\] 以后都用 pnpm 装依赖/)
})

test('buildDistillPrompt：素材按码点截断，且空素材不抛', () => {
  const material = {
    turns: [{ role: 'user', text: `${'A'.repeat(50)}ZZZTAIL${'B'.repeat(50)}` }],
  }
  const prompt = buildDistillPrompt(material, { maxChars: 60 })
  assert.ok(!prompt.includes('ZZZTAIL'), '超预算的尾部素材不应进入提示词')
  assert.match(prompt, /AAAAA/)
  const empty = buildDistillPrompt({})
  assert.match(empty, /（无素材）/)
})

test('parseDistillOutput：剥代码围栏、夹值、标签收敛、非法 kind 归一 fact', () => {
  const raw = `\`\`\`json
{"summary":" 做了收尾 ",
 "items":[
   {"kind":"lesson","text":" 甲 ","evidence":" 素材甲 ","confidence":2,"tags":["a","b","c","d","e","f","${'x'.repeat(30)}"]},
   {"kind":"weird","text":"乙","confidence":-1},
   {"text":42},
   {"text":"   "}
 ]}
\`\`\``
  const out = parseDistillOutput(raw)
  assert.equal(out.ok, true)
  assert.equal(out.summary, '做了收尾')
  assert.equal(out.items.length, 2)
  assert.equal(out.items[0].kind, 'lesson')
  assert.equal(out.items[0].text, '甲')
  assert.equal(out.items[0].evidence, '素材甲')
  assert.equal(out.items[0].confidence, 1)
  assert.deepEqual(out.items[0].tags, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(out.items[1].kind, 'fact')
  assert.equal(out.items[1].confidence, 0)
  assert.deepEqual(out.items[1].tags, [])
})

test('parseDistillOutput：标签按码点截到 24、非字符串标签丢弃', () => {
  const out = parseDistillOutput(`{"items":[{"text":"甲","tags":["${'x'.repeat(30)}",42,"","乙"]}]}`)
  assert.deepEqual(out.items[0].tags, ['x'.repeat(24), '乙'])
})

test('parseDistillOutput：顶层数组视为 items、summary 为空；坏 JSON 报 bad_json', () => {
  const arrayOut = parseDistillOutput('[{"text":"甲","kind":"rule","confidence":0.7}]')
  assert.equal(arrayOut.ok, true)
  assert.equal(arrayOut.summary, '')
  assert.equal(arrayOut.items.length, 1)
  assert.equal(arrayOut.items[0].kind, 'rule')
  assert.deepEqual(parseDistillOutput('not json'), {
    ok: false, summary: '', items: [], error: 'bad_json',
  })
  assert.deepEqual(parseDistillOutput('null'), {
    ok: false, summary: '', items: [], error: 'bad_json',
  })
  assert.deepEqual(parseDistillOutput(undefined), {
    ok: false, summary: '', items: [], error: 'bad_json',
  })
})

test('parseDistillOutput：缺省 confidence 0.5，缺失 items 落空数组', () => {
  const out = parseDistillOutput('{"summary":"结论","items":"不合法"}')
  assert.equal(out.ok, true)
  assert.equal(out.summary, '结论')
  assert.deepEqual(out.items, [])
  const single = parseDistillOutput('{"items":[{"text":"甲"}]}')
  assert.equal(single.items[0].confidence, 0.5)
  assert.equal(single.items[0].kind, 'fact')
})

test('normalizeEvidence：NFKC、空白折叠、小写、不删标点汉字', () => {
  assert.equal(normalizeEvidence('  ＡＢＣ　　ｄｅｆ  '), 'abc def')
  assert.equal(normalizeEvidence('禁止，直接！'), '禁止,直接!')
  assert.equal(normalizeEvidence('  多个\n\n空白\t行  '), '多个 空白 行')
  assert.equal(normalizeEvidence(''), '')
  assert.equal(normalizeEvidence(null), '')
})

test('DISTILL_KINDS 冻结且内容固定', () => {
  assert.ok(Object.isFrozen(DISTILL_KINDS))
  assert.deepEqual([...DISTILL_KINDS], ['lesson', 'decision', 'preference', 'fact', 'open_loop', 'rule'])
})

test('validateDistillItems：证据必须能在素材里逐字找到，逐条判据与降级', () => {
  const items = [
    // 保留：rule 且有「以后都」规范句支撑
    { kind: 'rule', text: '以后都用 pnpm 装依赖', evidence: '以后都用 pnpm 装依赖', confidence: 1.4, tags: ['pnpm', 42, 'pnpm'] },
    // 保留：fact
    { kind: 'fact', text: '仓库是 dsh-whale-memory', evidence: '仓库是 dsh-whale-memory', confidence: 0.8 },
    // 编造证据
    { kind: 'lesson', text: '端口是 3081', evidence: '从未出现过的片段' },
    // 纯链接堆
    { kind: 'fact', text: 'https://example.com/a https://example.com/b', evidence: '端口 3080' },
    // rule 无规范句标记 → 降级 lesson（保留）
    { kind: 'rule', text: '端口是 3080', evidence: '端口 3080', confidence: 0.9 },
    // 与第一条完全重复
    { kind: 'fact', text: '以后都用 pnpm 装依赖', evidence: '以后都用 pnpm 装依赖' },
    // 超长
    { kind: 'fact', text: 'x'.repeat(201), evidence: '端口 3080' },
    // 主观前缀剥完为空
    { kind: 'fact', text: '我觉得', evidence: '端口 3080' },
    // 证据太短
    { kind: 'fact', text: '端口 3080 是 web', evidence: '端口' },
    // 包含关系 + 长度比 ≥0.8 → duplicate
    { kind: 'fact', text: '以后都用 pnpm 装依赖吧', evidence: '以后都用 pnpm 装依赖' },
  ]
  const out = validateDistillItems(items, MATERIAL, { summary: '一句话结论' })
  assert.equal(out.summary, '一句话结论')
  assert.deepEqual(out.items.map((item) => [item.kind, item.text]), [
    ['rule', '以后都用 pnpm 装依赖'],
    ['fact', '仓库是 dsh-whale-memory'],
    ['lesson', '端口是 3080'],
  ])
  assert.equal(out.items[0].confidence, 1)
  assert.deepEqual(out.items[0].tags, ['pnpm'])
  assert.equal(out.items[0].evidenceNorm, '以后都用 pnpm 装依赖')
  assert.equal(out.items[2].evidence, '端口 3080')

  const reasons = new Map(out.dropped.map((entry) => [entry.text, entry.reason]))
  assert.equal(reasons.get('端口是 3081'), 'evidence_not_found')
  assert.equal(reasons.get('https://example.com/a https://example.com/b'), 'link_only')
  assert.equal(reasons.get('以后都用 pnpm 装依赖'.repeat(1)), 'duplicate')
  assert.equal(reasons.get('x'.repeat(201)), 'too_long')
  assert.equal(reasons.get('我觉得'), 'empty_text')
  assert.equal(reasons.get('端口 3080 是 web'), 'evidence_too_short')
  assert.equal(reasons.get('以后都用 pnpm 装依赖吧'), 'duplicate')
})

test('validateDistillItems：主观前缀剥离后保留可执行正文', () => {
  const out = validateDistillItems([
    { kind: 'fact', text: '我觉得 这个方案要收尾', evidence: '端口 3080' },
    { kind: 'fact', text: '可能 大概是 3080', evidence: '端口 3080' },
  ], MATERIAL)
  assert.deepEqual(out.items.map((item) => item.text), ['这个方案要收尾', '是 3080'])
})

test('validateDistillItems：maxItems 截断记 over_limit，非法入参不抛', () => {
  const out = validateDistillItems([
    { kind: 'fact', text: '仓库是 dsh-whale-memory', evidence: '仓库是 dsh-whale-memory' },
    { kind: 'fact', text: '以后都用 pnpm 装依赖', evidence: '以后都用 pnpm 装依赖' },
  ], MATERIAL, { maxItems: 1 })
  assert.equal(out.items.length, 1)
  assert.deepEqual(out.dropped.map((entry) => entry.reason), ['over_limit'])
  assert.deepEqual(validateDistillItems(null, MATERIAL).items, [])
  assert.deepEqual(validateDistillItems([{ kind: 'fact', text: '甲' }], {}).dropped[0].reason, 'evidence_missing')
})

test('clampSummary：折叠空白、码点截断补省略号', () => {
  assert.equal(clampSummary(' 做了\n\n收尾  '), '做了 收尾')
  const long = clampSummary('a'.repeat(250), 200)
  assert.equal(Array.from(long).length, 201)
  assert.ok(long.endsWith('…'))
  assert.equal(clampSummary('b'.repeat(200), 200), 'b'.repeat(200))
  assert.equal(clampSummary(null), '')
})
