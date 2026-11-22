/**
 * 写入判定器纯函数单测（脱库）：候选短 id 映射、提示词、裁决解析。
 *
 * 覆盖口径：
 * - mapCandidates 只给短整数 id，行里只有层级/类型/正文截断，真实节点 id 不出现在提示词里
 *   （防模型复述/编造真实 id）。
 * - parseJudgeOutput 的正例（围栏/夹带解释/0=ADD）与反例（坏 JSON/越界 id/非法动作/无目标却合并）。
 * - 失败一律 {ok:false,error}：调用方据此回落规则，绝不当成合法裁决。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJudgePrompt, JUDGE_ACTIONS, mapCandidates, parseJudgeOutput } from '../../src/core/judge.js'

const ROWS = [
  { id: 'n1700000000000_abcdef0123', text: '网关回调端口是 3982', level: 'core', memory_type: 'procedural' },
  { id: 'n1700000000001_abcdef0124', text: '项目部署在测试环境', level: 'normal', memory_type: 'semantic' },
]

test('mapCandidates：短整数编号稳定、行含层级/类型、真实 id 不进展示文本', () => {
  const { map, lines } = mapCandidates(ROWS)
  assert.deepEqual(Object.keys(map), ['1', '2'])
  assert.deepEqual(map, { 1: ROWS[0].id, 2: ROWS[1].id })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^1\. \[core\/procedural\] 网关回调端口是 3982$/)
  assert.match(lines[1], /^2\. \[normal\/semantic\] 项目部署在测试环境$/)
  for (const line of lines) {
    for (const row of ROWS) assert.equal(line.includes(row.id), false, '提示词行不得含真实节点 id')
  }
  // 顺序稳定：同一输入重复调用结果一致
  assert.deepEqual(mapCandidates(ROWS), mapCandidates(ROWS))
  // 缺 id 的行跳过，编号连续；空输入不产出
  const sparse = mapCandidates([{ id: '' }, { text: 'x' }, { id: 'n2_x' }, { id: 'n3_y' }])
  assert.deepEqual(sparse.map, { 1: 'n2_x', 2: 'n3_y' })
  assert.deepEqual(mapCandidates(null), { map: {}, lines: [] })
})

test('mapCandidates：正文截断 300 字（长候选不把提示词撑爆）', () => {
  const { lines } = mapCandidates([{ id: 'n1_x', text: '字'.repeat(600), level: 'normal', memory_type: 'semantic' }])
  assert.equal(lines[0].length, '1. [normal/semantic] '.length + 300)
  // 新事件按 writer 的 500 字硬顶上送（判定要看全文，候选才截 300）
  const prompt = buildJudgePrompt('新'.repeat(600), lines)
  assert.ok(prompt.includes('新'.repeat(500)))
  assert.equal(prompt.includes('新'.repeat(501)), false)
})

test('buildJudgePrompt：只回一个 JSON 对象、口径齐全、不含真实 id', () => {
  const { map, lines } = mapCandidates(ROWS)
  const prompt = buildJudgePrompt('网关回调端口改成 4000', lines)
  assert.match(prompt, /候选记忆/)
  assert.match(prompt, /新事件：\n网关回调端口改成 4000/)
  assert.match(prompt, /\{"id":<候选编号整数或0>,"action":"NOOP\|MERGE\|SUPERSEDE\|ADD","reason":"≤40字"\}/)
  assert.match(prompt, /id=0 表示与所有候选都无关/)
  assert.match(prompt, /只复述候选里出现的事实/)
  for (const id of Object.values(map)) assert.equal(prompt.includes(id), false, '提示词不得含真实节点 id')
  assert.match(buildJudgePrompt('', []), /（无候选）/)
})

test('parseJudgeOutput：合法裁决（含围栏/夹带解释）还原真实 id', () => {
  const { map } = mapCandidates(ROWS)
  const plain = parseJudgeOutput('{"id":1,"action":"SUPERSEDE","reason":"端口已改"}', map)
  assert.deepEqual(plain, { ok: true, id: 1, targetId: ROWS[0].id, action: 'SUPERSEDE', reason: '端口已改' })

  const fenced = parseJudgeOutput('```json\n{"id":2,"action":"noop","reason":"重复"}\n```\n', map)
  assert.equal(fenced.ok, true)
  assert.equal(fenced.action, 'NOOP', '动作统一转大写')
  assert.equal(fenced.targetId, ROWS[1].id)

  const wrapped = parseJudgeOutput('裁决如下：{"id":1,"action":"MERGE","reason":"补充同一事实"} 完毕', map)
  assert.equal(wrapped.ok, true)
  assert.equal(wrapped.action, 'MERGE')

  const zero = parseJudgeOutput('{"id":0,"action":"ADD","reason":"无关"}', map)
  assert.deepEqual(zero, { ok: true, id: 0, targetId: null, action: 'ADD', reason: '无关' })
})

test('parseJudgeOutput：反例一律 ok:false（坏 JSON/越界 id/非法动作/0 却要合并/超长理由截断）', () => {
  const { map } = mapCandidates(ROWS)
  assert.deepEqual(parseJudgeOutput('not json', map), { ok: false, error: 'no_json' })
  assert.deepEqual(parseJudgeOutput('{"id":1,"action":', map), { ok: false, error: 'bad_json' })
  assert.deepEqual(parseJudgeOutput('{"id":1}', map), { ok: false, error: 'bad_action' })
  assert.deepEqual(parseJudgeOutput('{"id":3,"action":"NOOP"}', map), { ok: false, error: 'unknown_target' })
  assert.deepEqual(parseJudgeOutput('{"id":1,"action":"REVIEW"}', map), { ok: false, error: 'bad_action' })
  assert.deepEqual(parseJudgeOutput('{"id":0,"action":"MERGE"}', map), { ok: false, error: 'target_required' })
  assert.deepEqual(parseJudgeOutput('{"id":1.5,"action":"NOOP"}', map), { ok: false, error: 'bad_id' })
  assert.deepEqual(parseJudgeOutput('{"id":-1,"action":"ADD"}', map), { ok: false, error: 'bad_id' })

  const long = parseJudgeOutput(`{"id":1,"action":"NOOP","reason":"${'很长的理由'.repeat(20)}"}`, map)
  assert.equal(long.ok, true)
  assert.equal(long.reason.length, 40)

  // 枚举就是落库分支的那四种：写入侧新增动作必须同步这里，否则模型只能靠回落
  assert.deepEqual([...JUDGE_ACTIONS].sort(), ['ADD', 'MERGE', 'NOOP', 'SUPERSEDE'])
})
