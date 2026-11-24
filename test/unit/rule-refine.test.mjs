/**
 * R9-22 候选语义提炼：原始来源不改、模型只改措辞、校验失败保留规则稿、CAS 防覆盖已裁定候选。
 * 全部临时目录 + 假 LLM，不联网、不碰真实规则仓。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProposal, readProposal } from '../../src/core/rule-proposal.js'
import { parseRefineReply, refineProposal, validateRefine } from '../../src/core/rule-refine.js'

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-refine-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const IDENTITY = { userId: 'u1', roleId: '', workspace: '' }

test('提炼：模型只改草稿措辞，来源原文保持原样', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({
    text: '以后都记住提交前得先跑测试。', identity: IDENTITY, rulesDir: root, config: { rules: { llm: true } },
  })
  assert.equal(made.ok, true, made.code)
  const before = made.proposal.text
  const llm = { chat: async () => JSON.stringify({
    text: '每次提交前必须先跑测试。', conditions: [], exceptions: [], summary: '提交前先跑测试',
  }) }
  const out = await refineProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: { llm: true } },
    getLlm: () => llm, getSelection: () => ({ provider: 'stub', model: 'stub' }),
  })
  assert.equal(out.ok, true, out.code)
  const after = readProposal({ rulesDir: root, config: { rules: { llm: true } }, id: made.proposal.id }).proposal
  assert.equal(after.text, before, '来源片段永不改写')
  assert.equal(after.draft.text, '每次提交前必须先跑测试。')
  assert.equal(after.refine.state, 'ready')
  assert.equal(after.refine.by, 'llm')
  assert.equal(after.summary.title, '提交前先跑测试')
})

test('提炼：模型输出带围栏/闲话也能解析；不合规输出保留规则稿并标 failed', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({
    text: '以后都记住提交前得先跑测试。', identity: IDENTITY, rulesDir: root, config: { rules: { llm: true } },
  })
  const fenced = '说明文字 ```json\n{"text":"每次提交前必须先跑测试。","conditions":[],"exceptions":[],"summary":"x"}\n``` 尾巴'
  assert.equal(parseRefineReply(fenced).text, '每次提交前必须先跑测试。')
  const bad = { chat: async () => JSON.stringify({ text: '这是一句描述，不是规则。', conditions: [], exceptions: [], summary: 'x' }) }
  const out = await refineProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: { llm: true } },
    getLlm: () => bad, getSelection: () => ({ provider: 'stub', model: 'stub' }),
  })
  assert.equal(out.ok, false)
  assert.equal(out.state, 'failed')
  const after = readProposal({ rulesDir: root, config: { rules: { llm: true } }, id: made.proposal.id }).proposal
  assert.equal(after.draft.text, made.proposal.draft.text, '失败不得改写规则稿')
  assert.equal(after.refine.state, 'failed', '失败必须留痕，且不改规则正文')
})

test('提炼：候选已被裁定（rejected）后模型回包不得覆盖状态', async (t) => {
  const root = freshRoot(t)
  const made = createProposal({
    text: '以后都记住提交前得先跑测试。', identity: IDENTITY, rulesDir: root, config: { rules: { llm: true } },
  })
  // 模拟“模型调用期间用户已拒绝”：LLM 回包前把候选改成 rejected/updated。
  const file = readProposal({ rulesDir: root, config: {}, id: made.proposal.id }).proposal.file
  const llm = { chat: async () => {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.status = 'rejected'
    raw.updated = '2026-11-23T16:00:00.000Z'
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`)
    return JSON.stringify({ text: '每次提交前必须先跑测试。', conditions: [], exceptions: [], summary: 'x' })
  } }
  const out = await refineProposal({
    id: made.proposal.id, rulesDir: root, config: { rules: { llm: true } },
    getLlm: () => llm, getSelection: () => ({ provider: 'stub', model: 'stub' }),
  })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'proposal_changed')
  assert.equal(readProposal({ rulesDir: root, config: {}, id: made.proposal.id }).proposal.status, 'rejected')
})



test('validateRefine：普通 rule 的 number=null 不得被强转成 0（死开关回归）', (t) => {
  const root = freshRoot(t)
  const parsed = { text: '每次提交前必须先跑测试。', conditions: [], exceptions: [] }
  const draft = {
    key: 'rule-x', type: 'rule', number: null, priority: 'P1', scope: 'global', role: '',
    modality: 'must', action: '', object: '', conditions: [], exceptions: [],
  }
  const out = validateRefine({ draft, text: parsed.text, relation: { relation: 'new' } }, parsed, { root })
  assert.equal(out.ok, true, `rule number=null 被误判：${JSON.stringify(out.detail)}`)
  assert.equal('number' in out.patch, false, '润色不发布身份字段')
})
