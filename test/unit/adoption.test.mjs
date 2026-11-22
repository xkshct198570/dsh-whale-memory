/**
 * 采纳弱信号判定单测（审计 backlog P1「回复引用信号 used 恒 0」）：
 * 断言判定函数的真实结论（命中/漏判/误判边界），不是"函数没抛异常"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeAdoption, judgeReply, nodeEvidence } from '../../src/core/adoption.js'

test('原文复述：10 字窗口命中 → 采纳（window 证据）', () => {
  const node = '网关端口 3982 是回调端口，直连 gateway.py 会回落 write=0'
  const reply = '按记忆里的口径：网关端口 3982 是回调端口，所以我用 start-gateway.sh 起。'
  const verdict = judgeAdoption(reply, node)
  assert.equal(verdict.adopted, true)
  assert.equal(verdict.reason, 'window')
  assert.ok(verdict.matched.length >= 10)
})

test('改写型回复：原文窗口不命中、bigram 覆盖过半 → 采纳（bigram 弱证据）', () => {
  const node = '记忆中枢的召回要落 recalls 审计行，零命中也要落库'
  const reply = '按记忆中枢的要求，召回要落审计行；零命中也要落库记录。'
  const verdict = judgeAdoption(reply, node)
  assert.equal(verdict.adopted, true)
  assert.equal(verdict.reason, 'bigram')
})

test('无关回复：既无窗口也无 bigram 覆盖 → 不采纳', () => {
  const verdict = judgeAdoption('今天下午三点开会，先改面板配色。', '网关端口 3982 是回调端口')
  assert.equal(verdict.adopted, false)
  assert.equal(verdict.reason, 'no_evidence')
})

test('短节点（<8 字）恒不采纳：避免"端口"这类词到处撞', () => {
  const verdict = judgeAdoption('网关端口已经改成 4000 了', '网关端口')
  assert.equal(verdict.adopted, false)
  assert.equal(verdict.reason, 'too_short')
})

test('归一化生效：全角括号/大小写差异不影响命中', () => {
  const verdict = judgeAdoption('用的就是 ＧＡＴＥＷＡＹ 回调 3982 那条规则', 'gateway 回调 3982 那条规则')
  assert.equal(verdict.adopted, true)
})

test('judgeReply：只报被引用的节点 id；空节点集合不采纳', () => {
  const nodes = [
    { id: 'n1', text: '网关端口 3982 是回调端口，出站走 3002' },
    { id: 'n2', text: 'ComfyUI 出图走 8188，夜间不跑批' },
  ]
  const hit = judgeReply('网关端口 3982 是回调端口，这条我记住了。', nodes)
  assert.equal(hit.adopted, true)
  assert.deepEqual(hit.nodeIds, ['n1'])
  assert.equal(judgeReply('网关端口 3982 是回调端口，这条我记住了。', []).adopted, false)
  assert.equal(judgeReply('', nodes).adopted, false)
})

test('nodeEvidence：窗口数按 10 字滑窗、bigram 去重', () => {
  const ev = nodeEvidence('记忆中枢的召回要落审计行')
  assert.equal(ev.chars, 12)
  assert.equal(ev.windows.length, 3)
  assert.ok(ev.bigrams.length >= 10)
})
