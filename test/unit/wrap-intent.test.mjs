import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectWrapIntent, WRAP_INTENT_STRONG, WRAP_INTENT_WEAK,
} from '../../src/core/wrap-intent.js'

test('强意图词：每个词单独命中（match/strong/phrase 原词）', () => {
  for (const word of WRAP_INTENT_STRONG) {
    const got = detectWrapIntent(`好，${word}`)
    assert.equal(got.match, true, `强词未命中：${word}`)
    assert.equal(got.reason, 'strong', `强词 reason 错：${word}`)
    assert.equal(got.phrase, word)
  }
})

test('弱意图词 + 上下文词：命中 weak（phrase 为弱词）', () => {
  for (const [text, word] of [
    ['这次总结一下', '总结一下'],
    ['这轮沉淀一下', '沉淀一下'],
    ['今天记一下', '记一下'],
    ['本次记一下上线流程', '记一下'],
  ]) {
    const got = detectWrapIntent(text)
    assert.equal(got.match, true, `弱词未命中：${text}`)
    assert.equal(got.reason, 'weak')
    assert.equal(got.phrase, word)
  }
})

test('弱词但无上下文词 → weak_without_context', () => {
  const got = detectWrapIntent('总结一下')
  assert.equal(got.match, false)
  assert.equal(got.reason, 'weak_without_context')
  assert.equal(got.phrase, '总结一下')
})

test('歧义强词指向外部内容 → strong_about_content（防「把这段代码收尾」误触发）', () => {
  for (const text of ['把这段代码收尾', '这篇文档收尾一下', '这个文件收工']) {
    const got = detectWrapIntent(text)
    assert.equal(got.match, false, `${text} 不应触发`)
    assert.equal(got.reason, 'strong_about_content', text)
  }
  // 带会话上下文词就回到收尾语义；非歧义强词不受内容指代影响。
  assert.equal(detectWrapIntent('这轮收尾，顺便把文件存了').match, true)
  assert.equal(detectWrapIntent('换会话，文件先不动').match, true)
})

test('弱词指向外部内容 → weak_about_content（防「总结一下这篇文章」误伤）', () => {
  for (const text of [
    '这次总结一下这篇文章',
    '这次记一下代码里的坑',
    '这轮沉淀一下这段文档',
    '本次总结一下文件内容',
  ]) {
    const got = detectWrapIntent(text)
    assert.equal(got.match, false, `内容指代未排除：${text}`)
    assert.equal(got.reason, 'weak_about_content')
  }
  // 例外：显式提到「会话」说明确实是收尾诉求。
  const withSession = detectWrapIntent('这次总结一下会话里的东西')
  assert.equal(withSession.match, true)
  assert.equal(withSession.reason, 'weak')
})

test('问句排除：? / ？ 结尾，或吗/呢/么 结尾', () => {
  for (const text of ['怎么开新会话？', '这次收尾吗', '这轮要收尾呢', '记一下么', '新会话怎么开？']) {
    const got = detectWrapIntent(text)
    assert.equal(got.match, false, `问句未排除：${text}`)
    assert.equal(got.reason, 'question')
  }
  // 尾随装饰符不影响问句识别
  assert.equal(detectWrapIntent('这次收尾吗？ ').reason, 'question')
  assert.equal(detectWrapIntent('这次收尾吗。').reason, 'question')
})

test('否定排除优先于强词：别收尾/不要记/先别收尾', () => {
  for (const text of ['别收尾', '不要记', '先别收尾', '不用记了', '别总结']) {
    const got = detectWrapIntent(text)
    assert.equal(got.match, false, `否定未排除：${text}`)
    assert.equal(got.reason, 'negated')
  }
})

test('引用块排除：任意行以 > 开头', () => {
  assert.equal(detectWrapIntent('> 收尾吧').reason, 'quoted')
  assert.equal(detectWrapIntent('看这段记录\n> 今天就收尾\n你怎么看').reason, 'quoted')
})

test('强词不受内容指代排除（强词本身就表达终止）', () => {
  const got = detectWrapIntent('收尾吧，把这次的文件记一下')
  assert.equal(got.match, true)
  assert.equal(got.reason, 'strong')
  assert.equal(got.phrase, '收尾')
})

test('空/超长/无信号', () => {
  assert.deepEqual(detectWrapIntent(''), { match: false, reason: 'empty' })
  assert.deepEqual(detectWrapIntent('   '), { match: false, reason: 'empty' })
  assert.deepEqual(detectWrapIntent(null), { match: false, reason: 'empty' })
  assert.deepEqual(detectWrapIntent(42), { match: false, reason: 'empty' })
  assert.equal(detectWrapIntent('收尾'.repeat(45)).reason, 'too_long')
  assert.equal(detectWrapIntent('今天天气不错').reason, 'no_signal')
  assert.equal(detectWrapIntent('帮我查一下端口').reason, 'no_signal')
})

test('opts.maxChars 可放宽长文本阈值', () => {
  const text = '收尾'.repeat(45)
  assert.equal(detectWrapIntent(text).reason, 'too_long')
  const got = detectWrapIntent(text, { maxChars: 200 })
  assert.equal(got.match, true)
  assert.equal(got.reason, 'strong')
})

test('意图词表冻结且内容固定（UI/文档可直接引用）', () => {
  assert.ok(Object.isFrozen(WRAP_INTENT_STRONG))
  assert.ok(Object.isFrozen(WRAP_INTENT_WEAK))
  assert.ok(WRAP_INTENT_STRONG.includes('收尾'))
  assert.ok(WRAP_INTENT_STRONG.includes('换会话'))
  assert.deepEqual([...WRAP_INTENT_WEAK], ['总结一下', '沉淀一下', '记一下'])
})
