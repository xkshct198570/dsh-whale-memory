/**
 * 默认铁律内容单测：包内 `defaults/` 是市场安装后的默认铁律。
 *
 * 口径：
 * - `defaults/rules/` = 16 文件：15 条带编号（1–17 除空号 6、除 13）+ 1 条无编号安全行（number: 0，key=iron-rule-safety）；
 * - `defaults/rules-local/iron-rule-13.md` = 本机对照组专属，仅 workspace 作用域，不参与默认播种；
 * - 每条都必须能被规则仓同一套 parse/normalize/validate 口径接受，正文指令形态、无理由句与模糊词。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RULE_FIELDS,
  normalizeRuleDoc,
  parseRuleDocument,
  serializeRuleDocument,
  validateRule,
} from '../../src/core/rule-store.js'
import { detectSignals } from '../../src/core/rules.js'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const rulesDir = join(root, 'defaults', 'rules')
const localDir = join(root, 'defaults', 'rules-local')
const readmePath = join(root, 'defaults', 'README.md')

const VAGUE_RE = /(尽量|最好|尽可能|大概|也许|可能)/
const REASON_RE = /(因为|由于|理由是)/
const EXPECTED_NUMBERS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]

/** 读一个目录下的 .md 文件（README 不算规则），返回原文与解析结果。 */
function loadDocs(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort()
  return names.map((name) => {
    const source = readFileSync(join(dir, name), 'utf8')
    const parsed = parseRuleDocument(source)
    const doc = parsed.ok ? normalizeRuleDoc(parsed.front, parsed.text) : null
    return { name, source, parsed, doc }
  })
}

const generalDocs = loadDocs(rulesDir)
const localDocs = loadDocs(localDir)
const allDocs = [...generalDocs, ...localDocs]

test('defaults/rules 是 16 个文件：15 条带号 + 1 条无编号安全行', () => {
  assert.equal(generalDocs.length, 16)
  const safety = generalDocs.filter(({ name }) => name === 'iron-rule-safety.md')
  assert.equal(safety.length, 1, '安全行必须单独成文件')
  assert.equal(generalDocs.filter(({ name }) => name !== 'iron-rule-safety.md').length, 15)
})

test('rules-local 只有本机专用的 iron-rule-13.md', () => {
  assert.equal(localDocs.length, 1)
  assert.deepEqual(localDocs.map(({ name }) => name), ['iron-rule-13.md'])
})

test('17 个文件全部可解析，且 front 字段与 serializeRuleDocument 顺序一致（19 字段，summary 可选）', () => {
  assert.equal(allDocs.length, 17)
  for (const { name, parsed } of allDocs) {
    assert.ok(parsed.ok, `${name} 解析失败：${parsed.error}`)
  }
  // summary 是可选展示字段（R8-06）：默认文件不带它，因此期望字段 = RULE_FIELDS 去掉 summary，
  // 顺序必须与序列化口径一致（append 在 origin 之后，不扰动既有文件的字段顺序）。
  const expected = RULE_FIELDS.filter((field) => field !== 'summary')
  for (const { name, doc } of allDocs) {
    assert.deepEqual(Object.keys(doc.front), expected, `${name} 字段集/顺序不符合序列化口径`)
    assert.equal(Number(doc.front.version), 1, `${name} version 必须是 1`)
  }
  // 追加断言：带 summary 的文档按 RULE_FIELDS 全序序列化并能 round-trip，且 summary 在末尾。
  const sample = serializeRuleDocument({ front: { ...allDocs[0].doc.front, summary: '一句话摘要' }, text: allDocs[0].doc.text })
  assert.equal(sample.ok, true, sample.error)
  const reparsed = parseRuleDocument(sample.text)
  assert.equal(reparsed.front.summary, '一句话摘要')
  assert.deepEqual(Object.keys(reparsed.front), [...RULE_FIELDS])
})

test('全部文件通过 validateRule（numbers Map 排除自身）', () => {
  const numbers = new Map(allDocs.map(({ doc }) => [doc.front.number, doc.front.key]))
  for (const { name, doc } of allDocs) {
    const own = new Map(numbers)
    own.delete(doc.front.number)
    const result = validateRule(doc.front, doc.text, { numbers: own })
    const codes = result.errors.map((err) => `${err.code}:${err.field ?? ''}`).join(',')
    assert.ok(result.ok, `${name} 校验失败：${codes}`)
  }
})

test('编号集合 = 1–17 除空号 6 的 15 个带号 + 1 个 number=0，且无重复', () => {
  const numbers = generalDocs.map(({ doc }) => doc.front.number).sort((a, b) => a - b)
  assert.deepEqual([...new Set(numbers)], numbers, 'rules/ 内编号不得重复')

  const zero = numbers.filter((n) => n === 0)
  assert.equal(zero.length, 1, '必须恰有一条无编号（number: 0）的安全行')

  const numbered = numbers.filter((n) => n > 0)
  assert.deepEqual(numbered, EXPECTED_NUMBERS.filter((n) => n !== 6 && n !== 13), '带号规则只允许 1–17 除 6 与 13')
  assert.ok(!numbers.includes(6), '空号 6 永不复用')
  assert.ok(!numbers.includes(18), '安全行不是「铁律18」')
  assert.equal(numbered.length, 15)
})

test('安全行：key=iron-rule-safety、number=0、全局作用域', () => {
  const safety = generalDocs.find(({ name }) => name === 'iron-rule-safety.md')
  assert.ok(safety, '缺 iron-rule-safety.md')
  assert.equal(safety.doc.front.key, 'iron-rule-safety')
  assert.equal(safety.doc.front.number, 0)
  assert.equal(safety.doc.front.type, 'iron-rule')
  assert.equal(safety.doc.front.scope, 'global')
})

test('第 13 条：只在 rules-local，scope 是 workspace 绝对路径，不在 rules/', () => {
  const rule13 = localDocs[0]
  assert.equal(rule13.doc.front.number, 13)
  assert.equal(rule13.doc.front.key, 'iron-rule-13')
  assert.match(rule13.doc.front.scope, /^workspace:\//, '13 必须是 workspace 作用域')
  assert.ok(!generalDocs.some(({ name }) => name === 'iron-rule-13.md'), '13 不得出现在通用目录')
})

test('通用规则作用域全为 global', () => {
  for (const { name, doc } of generalDocs) {
    assert.equal(doc.front.scope, 'global', `${name} 必须是 global（13 除外，已在 local）`)
  }
})

test('每篇正文 ≤500 字且是指令形态', () => {
  for (const { name, doc } of allDocs) {
    const chars = Array.from(doc.text).length
    assert.ok(chars > 0 && chars <= 500, `${name} 正文 ${chars} 字，必须在 1–500 之间`)
    assert.equal(detectSignals(doc.text).imperative, true, `${name} 正文不是指令形态`)
  }
})

test('每篇正文无模糊词、无理由句、不触发隐私拒绝', () => {
  for (const { name, doc } of allDocs) {
    assert.ok(!VAGUE_RE.test(doc.text), `${name} 含模糊词`)
    assert.ok(!REASON_RE.test(doc.text), `${name} 含理由句`)
    assert.notEqual(detectSignals(doc.text).rejectReason, 'privacy', `${name} 触发隐私拒绝`)
  }
})

test('origin 以 default: 开头，key 与文件名一致', () => {
  for (const { name, doc } of allDocs) {
    assert.match(doc.front.origin, /^default:/, `${name} origin 必须标明默认来源`)
    assert.equal(`${doc.front.key}.md`, name, `${name} 内 key 与文件名不一致`)
  }
})

test('统一 front 口径：iron-rule / P0 / active / 日期 2026-11-22 / 未合并', () => {
  for (const { name, doc } of allDocs) {
    assert.equal(doc.front.type, 'iron-rule', `${name} type`)
    assert.equal(doc.front.priority, 'P0', `${name} priority`)
    assert.equal(doc.front.status, 'active', `${name} status`)
    assert.equal(doc.front.created, '2026-11-22', `${name} created`)
    assert.equal(doc.front.updated, '2026-11-22', `${name} updated`)
    assert.equal(doc.front.merged_into, '', `${name} merged_into`)
    assert.equal(doc.front.superseded_by, '', `${name} superseded_by`)
    assert.equal(doc.front.role, '', `${name} role`)
  }
})

test('例外清单不丢：17 保留 5 条、14 保留 pin 例外、11 保留 4 类不收', () => {
  const byKey = new Map(allDocs.map(({ doc }) => [doc.front.key, doc]))
  assert.equal(byKey.get('iron-rule-17').front.exceptions.length, 5)
  assert.ok(byKey.get('iron-rule-14').front.exceptions.some((item) => item.includes('pin')))
  assert.equal(byKey.get('iron-rule-11').front.exceptions.length, 4)
})

test('defaults/README.md 说明默认值可改可停用可删除，且 13 不参与播种', () => {
  assert.ok(existsSync(readmePath), '缺 defaults/README.md')
  const readme = readFileSync(readmePath, 'utf8')
  assert.match(readme, /可改/)
  assert.match(readme, /可删除/)
  assert.match(readme, /不参与默认播种/)
  assert.match(readme, /§2/)
})
