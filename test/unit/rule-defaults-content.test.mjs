/**
 * 默认铁律内容单测：包内 `defaults/` 是市场安装后的默认铁律。
 *
 * 口径：
 * - `defaults/rules/` = 20 文件：19 条带编号（1–19 除空号 6、除本地专用 13，另含 21／22）+ 1 条无编号安全行（number: 0，key=iron-rule-safety）；
 * - `iron-rule-8` 已并入 `iron-rule-7`（`merged_into: iron-rule-7`），文件与编号保留作指针；
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
const EXPECTED_NUMBERS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22]

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

test('defaults/rules 是 20 个文件：19 条带号 + 1 条无编号安全行', () => {
  assert.equal(generalDocs.length, 20)
  const safety = generalDocs.filter(({ name }) => name === 'iron-rule-safety.md')
  assert.equal(safety.length, 1, '安全行必须单独成文件')
  assert.equal(generalDocs.filter(({ name }) => name !== 'iron-rule-safety.md').length, 19)
})

test('rules-local 只有本机专用的 iron-rule-13.md', () => {
  assert.equal(localDocs.length, 1)
  assert.deepEqual(localDocs.map(({ name }) => name), ['iron-rule-13.md'])
})

test('21 个文件全部可解析，且 front 字段与 serializeRuleDocument 顺序一致（19 字段，summary 可选）', () => {
  assert.equal(allDocs.length, 21)
  for (const { name, parsed } of allDocs) {
    assert.ok(parsed.ok, `${name} 解析失败：${parsed.error}`)
  }
  // summary 是可选展示字段（R8-06）：默认文件不带它，因此期望字段 = RULE_FIELDS 去掉 summary，
  // 顺序必须与序列化口径一致（append 在 origin 之后，不扰动既有文件的字段顺序）。
  const expected = RULE_FIELDS.filter((field) => field !== 'summary')
  for (const { name, doc } of allDocs) {
    assert.deepEqual(Object.keys(doc.front), expected, `${name} 字段集/顺序不符合序列化口径`)
    // version 是规则自身的版本号：17 在真源被升过版（v2），默认包跟随真源；只要求正整数。
    assert.ok(Number.isInteger(Number(doc.front.version)) && Number(doc.front.version) >= 1, `${name} version 必须是正整数`)
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

test('编号集合 = 1–19 除空号 6 与 13、再加 21／22 的 19 个带号 + 1 个 number=0，且无重复', () => {
  const numbers = generalDocs.map(({ doc }) => doc.front.number).sort((a, b) => a - b)
  assert.deepEqual([...new Set(numbers)], numbers, 'rules/ 内编号不得重复')

  const zero = numbers.filter((n) => n === 0)
  assert.equal(zero.length, 1, '必须恰有一条无编号（number: 0）的安全行')

  const numbered = numbers.filter((n) => n > 0)
  assert.deepEqual(numbered, EXPECTED_NUMBERS.filter((n) => n !== 6 && n !== 13), '带号规则只允许 1–19 除 6 与 13，加 21／22')
  assert.ok(!numbers.includes(6), '空号 6 永不复用')
  assert.ok(numbers.includes(18) && numbers.includes(19), '18/19 必须随包播种（D2）')
  assert.ok(numbers.includes(21) && numbers.includes(22), '21/22 必须随包播种（R11/WP4）')
  assert.ok(!numbers.includes(20), '墓碑编号 20 不得随包复活')
  assert.equal(numbered.length, 19)
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

test('origin 标明默认来源或本机手工入仓，key 与文件名一致', () => {
  for (const { name, doc } of allDocs) {
    // 21/22 是真源手工入仓（origin: manual:），默认包逐字跟随真源，不改写 front。
    assert.match(doc.front.origin, /^(default|manual):/, `${name} origin 必须标明来源`)
    assert.equal(`${doc.front.key}.md`, name, `${name} 内 key 与文件名不一致`)
  }
})

test('统一 front 口径：iron-rule / P0 / active / 入仓日期（22–24）/ 只有 8 带合并指针', () => {
  for (const { name, doc } of allDocs) {
    assert.equal(doc.front.type, 'iron-rule', `${name} type`)
    assert.equal(doc.front.priority, 'P0', `${name} priority`)
    assert.equal(doc.front.status, 'active', `${name} status`)
    // 18/19 是 2026-11-23 入仓，21/22 是 2026-11-24；其余 2026-11-22，R11 重编后 updated 统一 2026-11-24。
    assert.ok(['2026-11-22', '2026-11-23', '2026-11-24'].includes(doc.front.created), `${name} created=${doc.front.created}`)
    assert.ok(['2026-11-22', '2026-11-23', '2026-11-24'].includes(doc.front.updated), `${name} updated=${doc.front.updated}`)
    if (doc.front.key === 'iron-rule-8') {
      // 8 并入 7：指针是唯一合法非空 merged_into（链终点 7 仍 active）。
      assert.equal(doc.front.merged_into, 'iron-rule-7', `${name} 合并指针必须指向 7`)
    } else {
      assert.equal(doc.front.merged_into, '', `${name} merged_into`)
    }
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

test('defaults/README.md 说明默认值可改可停用可删除，计 20 文件，且 13 不参与播种', () => {
  assert.ok(existsSync(readmePath), '缺 defaults/README.md')
  const readme = readFileSync(readmePath, 'utf8')
  assert.match(readme, /可改/)
  assert.match(readme, /可删除/)
  assert.match(readme, /不参与默认播种/)
  assert.match(readme, /20 个文件/, 'README 必须写对文件数')
  assert.match(readme, /19 条带编号/, 'README 必须写对带号条数')
  assert.match(readme, /merged_into: iron-rule-7/, 'README 必须说明 8 并入 7')
  assert.match(readme, /23/, 'README 必须写对下一条编号')
})
