import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlan } from '../../src/core/queryplan.js'
import { normalize, bigrams, contentHash, subwords, similarity } from '../../src/core/tokenize.js'

// ---------- 混合查询：ASCII / 标识符 / IPv4 / 中文 ----------

test('plan：混合查询拆出 ascii、ident 子词、IPv4、中文与 bigram', () => {
  const q = 'WSL 断网 resolv.conf 8.8.8.8'
  const plan = buildPlan(q)

  assert.equal(plan.raw, q)
  assert.equal(plan.minLenOk, true)
  assert.deepEqual(plan.ips, ['8.8.8.8'])
  assert.ok(plan.asciiTerms.includes('wsl'))
  assert.ok(plan.asciiTerms.includes('resolv.conf'))
  assert.ok(!plan.asciiTerms.includes('8.8.8.8'), 'IP 不进 asciiTerms')
  assert.ok(plan.idents.includes('resolv.conf'))
  assert.ok(plan.idents.includes('resolv'))
  assert.ok(plan.idents.includes('conf'))
  assert.ok(plan.cjkTerms.includes('断网'))
  assert.ok(plan.cjkGrams.includes('断网'))
  assert.equal(plan.intent, null)
})

test('plan：rdclientax.dll 出整词与子词', () => {
  const plan = buildPlan('rdclientax.dll')
  assert.ok(plan.asciiTerms.includes('rdclientax.dll'))
  assert.ok(plan.idents.includes('rdclientax'))
  assert.ok(plan.idents.includes('dll'))
  assert.ok(!plan.idents.includes(''), '空子词必须被丢弃')
  assert.equal(plan.minLenOk, true)
})

test('plan：驼峰标识符（小写后仍进 idents）', () => {
  const plan = buildPlan('MyGateway 报错')
  assert.ok(plan.asciiTerms.includes('mygateway'))
  assert.ok(plan.idents.includes('mygateway'))
  assert.ok(plan.cjkTerms.includes('报错'))
})

// ---------- 2 字中文 / 虚词 / 否定 ----------

test('plan：2 字中文只走 bigram（不进 trigram 短语）', () => {
  const plan = buildPlan('网关')
  assert.deepEqual(plan.cjkTerms, ['网关'])
  assert.deepEqual(plan.cjkGrams, ['网关'])
  assert.deepEqual(plan.asciiTerms, [])
  assert.ok(plan.cjkTerms.every((t) => t.length < 3))
  assert.equal(plan.minLenOk, true)
  assert.equal(plan.intent, null)
})

test('plan：虚词过滤后只剩实词', () => {
  const plan = buildPlan('我的网关怎么了')
  assert.deepEqual(plan.cjkTerms, ['网关'])
  assert.deepEqual(plan.cjkGrams, ['网关'])
  assert.ok(!plan.cjkTerms.some((t) => t.includes('的')))
  assert.ok(!plan.cjkTerms.some((t) => t.includes('怎么')))
  assert.equal(plan.intent, 'procedural')

  const plain = buildPlan('我的网关')
  assert.deepEqual(plain.cjkTerms, ['网关'])
  assert.equal(plain.intent, null)
})

test('plan：否定词单独收集且不留在中文实词里', () => {
  const plan = buildPlan('别用 8.8.8.8 也别重启')
  assert.deepEqual(plan.ips, ['8.8.8.8'])
  assert.ok(plan.negations.includes('别'))
  assert.ok(plan.cjkTerms.includes('重启'))
  assert.ok(!plan.cjkTerms.some((t) => t.includes('别')))
  assert.ok(!plan.cjkTerms.some((t) => t.includes('8')))
})

// ---------- 意图 / 长度 / IP 校验 ----------

test('plan：意图 procedural 优先、episodic 次之', () => {
  const p1 = buildPlan('怎么配置 WSL 网关')
  assert.equal(p1.intent, 'procedural')
  assert.ok(p1.asciiTerms.includes('wsl'))

  const p2 = buildPlan('如何排障 网关')
  assert.equal(p2.intent, 'procedural')

  const e1 = buildPlan('上次 断网 记得')
  assert.equal(e1.intent, 'episodic')
  assert.ok(e1.cjkTerms.includes('断网'))
  assert.ok(e1.cjkTerms.includes('记得'))
})

test('plan：空串 / 空白 / 1 字 → minLenOk=false 且无词项', () => {
  for (const q of ['', '   ', '网', '。']) {
    const plan = buildPlan(q)
    assert.equal(plan.minLenOk, false, `minLenOk(${JSON.stringify(q)})`)
    assert.deepEqual(plan.cjkTerms, [])
    assert.deepEqual(plan.cjkGrams, [])
    assert.deepEqual(plan.asciiTerms, [])
    assert.deepEqual(plan.idents, [])
    assert.deepEqual(plan.ips, [])
  }
  // 纯符号：长度够但没有词项（上层据此直接空结果）
  const sym = buildPlan('!!??')
  assert.equal(sym.minLenOk, true)
  assert.deepEqual(sym.cjkTerms, [])
  assert.deepEqual(sym.asciiTerms, [])
})

test('plan：IPv4 校验（999.1.1.1 不算地址）', () => {
  assert.deepEqual(buildPlan('0.0.0.0').ips, ['0.0.0.0'])
  assert.deepEqual(buildPlan('999.1.1.1').ips, [])
  assert.ok(buildPlan('999.1.1.1').asciiTerms.includes('999.1.1.1'))
})

// ---------- tokenize 同口径 ----------

test('normalize：NFKC/全角转半角/空白压缩/ASCII 小写/中文保留', () => {
  assert.equal(normalize('ＡＢＣ　１２３'), 'abc 123')
  assert.equal(normalize('  网关   断网  '), '网关 断网')
  assert.equal(normalize('Hello 世界'), 'hello 世界')
  assert.equal(normalize(12345), '')
  assert.equal(normalize(null), '')
})

test('bigrams：中文 2 字窗口、去重、空格连接', () => {
  assert.equal(bigrams('中国人'), '中国 国人')
  assert.equal(bigrams('网关 3982 回调'), '网关 回调')
  assert.equal(bigrams('中华 人民'), '中华 人民')
  assert.equal(bigrams(''), '')
  assert.equal(bigrams('abc'), '')
})

test('contentHash：normalize 后 sha256（大小写/全半角/空白不产生新哈希）', () => {
  assert.match(contentHash('网关'), /^[0-9a-f]{64}$/)
  assert.equal(contentHash('网关'), contentHash(' 网关 '))
  assert.equal(contentHash('ＡＢＣ'), contentHash('abc'))
  assert.notEqual(contentHash('断网'), contentHash('网关'))
})

test('subwords：按分隔符切且保留原词', () => {
  assert.deepEqual(subwords('whale.db'), ['whale.db', 'whale', 'db'])
  const rdc = subwords('rdclientax.dll')
  assert.equal(rdc[0], 'rdclientax.dll')
  assert.ok(rdc.includes('rdclientax'))
  assert.ok(rdc.includes('dll'))
  assert.ok(subwords('wsl-ubuntu').includes('ubuntu'))
  assert.deepEqual(subwords(''), [])
})

test('similarity：bigram Jaccard 稳定落在 0..1', () => {
  assert.equal(similarity('网关', '网关'), 1)
  assert.equal(similarity('网关', '断网'), 0)
  const partial = similarity('网关不通', '网关故障')
  assert.ok(partial > 0 && partial < 1)
  assert.equal(similarity('', ''), 0)
})
