/**
 * 蒸馏阶段：推理模型把预算烧在思考上、首答不是 JSON 时的重试与失败可见性。
 * 依赖方向：只测 host/session-wrap/distill.js 的对外函数，注入假 llm，不落库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { distillPhase, collectModelText, distillRetryPrompt, DISTILL_MAX_TOKENS } from '../../src/host/session-wrap/distill.js'

const MATERIAL = { turns: [{ role: 'user', text: '部署端口是 3080，后端是 3098，别改。' }] }
const GOOD = JSON.stringify({
  summary: '端口与后端',
  items: [{ kind: 'fact', text: '端口 3080、后端 3098', evidence: '端口是 3080', confidence: 0.8, tags: [] }],
})

/** 构造按脚本回放的假 llm：每个元素是一次调用的 chunk 数组或 Error。 */
function scriptedLlm(replies, seen = []) {
  let index = 0
  return {
    stream(options) {
      seen.push(options)
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (reply instanceof Error) throw reply
      return (async function* emit() {
        for (const chunk of reply) yield chunk
      })()
    },
  }
}

function deps(llm, selection, { cfg = {}, run = {}, log = () => {} } = {}) {
  const finalized = []
  const updates = []
  return {
    finalized,
    updates,
    args: {
      runId: 7,
      run,
      spool: { material: MATERIAL },
      spoolPath: '/tmp/spool-run-7.json',
      cfg: { maxItems: 8, maxMaterialChars: 12000, model: '', timeoutMs: 5000, ...cfg },
      withDb: (fn) => { updates.push(fn) },
      getLlm: () => llm,
      getSelection: () => selection,
      finalize: (runId, state, extra, opts) => { finalized.push({ runId, state, extra, opts }) },
      log,
    },
  }
}

test('蒸馏：首答非 JSON 时自动重试一次，重试成功即产出 entries', async () => {
  const seen = []
  const llm = scriptedLlm([[{ type: 'text-delta', text: '抱歉，先解释一下……' }], [{ type: 'text-delta', text: GOOD }]], seen)
  const { args, finalized, updates } = deps(llm, { provider: 'p', model: 'm' })
  const out = await distillPhase(args)
  assert.equal(seen.length, 2, '应调用两次模型')
  assert.equal(out.distilled.items.length, 1)
  assert.equal(out.distilled.items[0].status, 'pending')
  assert.equal(updates.length, 1, '断点应写一次')
  assert.equal(finalized.filter((f) => f.state === 'failed').length, 0)
})

test('蒸馏：两次都坏 → failed 且抛出 distill_bad_json（失败可见，不静默）', async () => {
  const llm = scriptedLlm([[{ type: 'text-delta', text: '不是 JSON' }], [{ type: 'text-delta', text: '还是不是' }]])
  const logs = []
  const { args, finalized } = deps(llm, { provider: 'p', model: 'm' }, { log: (line) => logs.push(line) })
  await assert.rejects(() => distillPhase(args), /distill_bad_json/)
  const failed = finalized.filter((f) => f.state === 'failed')
  assert.equal(failed.length, 1)
  assert.match(String(failed[0].extra.error), /^bad_json:/)
  assert.ok(logs.some((line) => line.includes('distill bad_json attempt=1')), '首答失败要留日志')
})

test('蒸馏：思考字数单独统计，且预算用 4096 而不是 1800', async () => {
  const seen = []
  const llm = scriptedLlm([[
    { type: 'reasoning-delta', text: '先想一想……' },
    { type: 'text-delta', text: '{"summary":"","items":[]}' },
  ]], seen)
  const got = await collectModelText(llm, { provider: 'p', model: 'm' }, 'prompt', { providerOverride: 'q' })
  assert.equal(got.ok, true)
  assert.equal(got.text, '{"summary":"","items":[]}')
  assert.equal(got.reasoningChars, '先想一想……'.length)
  assert.equal(seen[0].provider, 'q', 'wrap.provider 覆盖必须传给 llm')
  assert.equal(seen[0].maxTokens, DISTILL_MAX_TOKENS)
  assert.ok(DISTILL_MAX_TOKENS >= 4096)
})

test('重试提示：要求第一个字符是 JSON 对象，且不含代码围栏', () => {
  const prompt = distillRetryPrompt('原始提示词')
  assert.match(prompt, /原始提示词/)
  assert.match(prompt, /只输出一个 JSON 对象/)
  assert.match(prompt, /第一个字符必须是 \{/)
})
