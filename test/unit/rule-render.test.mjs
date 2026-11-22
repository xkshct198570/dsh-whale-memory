/**
 * 规则渲染单测（R3b）：AGENTS 摘要块 / 台账 §2 块。
 * 关键口径：只改标记块内部、缺标记与重复标记都拒绝、内容不变不落盘（保 mtime）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEDGER_BEGIN, LEDGER_END, RULES_BEGIN, RULES_END,
  agentsPathOf, fileHasMarkers, inspectMarkers, ledgerDigestContent,
  renderAgentsDigest, renderLedgerDigest, rulesDigestContent, titleOfRule,
} from '../../src/core/rule-render.js'

function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function doc({
  key = 'k1', number = 1, type = 'iron-rule', scope = 'global', priority = 'P0', status = 'active',
  action = '', text = '必须保留审计日志。', file = '',
} = {}) {
  return {
    ...(file ? { file } : {}),
    front: {
      key,
      type,
      number,
      priority,
      scope,
      role: '',
      modality: 'must',
      action,
      object: '',
      conditions: [],
      exceptions: [],
      status,
      merged_into: '',
      superseded_by: '',
      created: '2026-11-22',
      updated: '2026-11-22',
      version: 1,
      origin: 'unit',
    },
    text,
  }
}

/** 带管理块的 AGENTS（块外内容必须原样保留）。 */
function agentsFile(dir, body = '- 旧行') {
  const path = join(dir, 'AGENTS.md')
  const content = [
    '# 本机说明书',
    '',
    '块外内容第一行。',
    '',
    RULES_BEGIN,
    body,
    RULES_END,
    '',
    '块外内容最后一行。',
    '',
  ].join('\n')
  writeFileSync(path, content, 'utf8')
  return { path, content }
}

// ---------------------------------------------------------------------------
// 内容口径
// ---------------------------------------------------------------------------

test('rulesDigestContent：只收 global+active 铁律，按编号排序，正文截 200 字', () => {
  const long = '必须'.repeat(120)
  const got = rulesDigestContent([
    doc({ key: 'iron-rule-17', number: 17, text: '删文档前先核对绝对路径。' }),
    doc({ key: 'iron-rule-13', number: 13, text: '只在本工作区生效。' }),
    doc({ key: 'rule-1', number: 1, type: 'rule', text: '普通规则不该进摘要。' }),
    doc({ key: 'iron-rule-18', number: 18, scope: 'workspace:/tmp/ws', text: '工作区规则不该进摘要。' }),
    doc({ key: 'iron-rule-19', number: 19, status: 'superseded', text: '退役规则不该进摘要。' }),
    doc({ key: 'iron-rule-20', number: 20, text: long }),
  ])
  assert.equal(got.count, 3)
  assert.deepEqual(got.keys, ['iron-rule-13', 'iron-rule-17', 'iron-rule-20'])
  assert.match(got.content, /^## 规则摘要（自动生成，勿手改）/)
  assert.match(got.content, /- 铁律13 · /)
  const longLine = got.content.split('\n').find((line) => line.startsWith('- 铁律20'))
  // 摘要 60 字后追加「（文件：…）」指针，取两者之间的正文再数长度。
  const excerpt = longLine.slice(longLine.indexOf('：') + 1, longLine.indexOf('（文件：'))
  // 200 字 + 截断省略号（长文本才有）
  assert.equal(Array.from(excerpt).length, 201)
  assert.match(excerpt, /…$/)
  assert.match(longLine, /（文件：iron-rule-20\.md）$/)
})

test('rulesDigestContent：标题取 action，缺省退正文首句；作用域规则只注入不进摘要', () => {
  assert.equal(titleOfRule({ action: '删源文件' }, '正文'), '删源文件')
  assert.equal(titleOfRule({}, '文档删除前先核路径。'), '文档删除前先核路径')
  // 作用域规则在摘要里没有一行（R3b 口径：摘要只负责 global，作用域规则靠注入可见）。
  const got = rulesDigestContent([doc({ key: 'iron-rule-13', number: 13, scope: 'role:reviewer', action: '只审不施工' })])
  assert.equal(got.count, 0)
  assert.equal(got.content.includes('role:reviewer'), false)
})

test('inspectMarkers：缺失/重复/顺序错乱都返回失败码', () => {
  assert.equal(inspectMarkers('没有标记').code, 'no_markers')
  assert.equal(inspectMarkers(`${RULES_BEGIN}\n${RULES_END}\n${RULES_BEGIN}\n${RULES_END}`).code, 'duplicate_markers')
  assert.equal(inspectMarkers(`${RULES_END}\n${RULES_BEGIN}`).code, 'markers_out_of_order')
  const ok = inspectMarkers(`a\n${RULES_BEGIN}\nb\n${RULES_END}\nc`)
  assert.equal(ok.ok, true)
})

test('agentsPathOf：规则目录的兄弟文件（$DSH_HOME/rules → $DSH_HOME/AGENTS.md）', () => {
  assert.match(agentsPathOf('/tmp/dsh-home/rules'), /\/tmp\/dsh-home\/AGENTS\.md$/)
  assert.equal(agentsPathOf(''), '')
})

// ---------------------------------------------------------------------------
// renderAgentsDigest
// ---------------------------------------------------------------------------

test('renderAgentsDigest：无标记 → no_markers，绝不追加全文', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const content = '# 说明书\n\n没有任何管理块。\n'
  writeFileSync(path, content, 'utf8')
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: path })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_markers')
  assert.equal(readFileSync(path, 'utf8'), content, '缺标记时一个字节都不能动')
})

test('renderAgentsDigest：标记重复 → duplicate_markers（不猜哪一块）', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const dup = `${RULES_BEGIN}\na\n${RULES_END}\n${RULES_BEGIN}\nb\n${RULES_END}\n`
  writeFileSync(path, dup, 'utf8')
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: path })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'duplicate_markers')
  assert.equal(readFileSync(path, 'utf8'), dup)
})

test('renderAgentsDigest：文件不存在 → no_markers（不创建宿主资产）', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: path })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_markers')
  assert.equal(existsSync(path), false)
})

test('renderAgentsDigest：只替换块内部，块外字节与标记保留，并留 .bak', (t) => {
  const dir = freshDir(t)
  const { path, content } = agentsFile(dir)
  const rulesDir = join(dir, 'rules')
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-17', number: 17, action: '删文档前先核路径', text: '删文档前先核对绝对路径。' })],
    agentsPath: path,
    rulesDir,
  })
  assert.equal(got.ok, true, got.code)
  assert.equal(got.changed, true)
  assert.equal(got.count, 1)
  const after = readFileSync(path, 'utf8')
  assert.ok(after.startsWith('# 本机说明书'), '块外开头保留')
  assert.match(after, /块外内容第一行。/)
  assert.match(after, /块外内容最后一行。/)
  assert.equal(after.includes(RULES_BEGIN), true)
  assert.equal(after.includes(RULES_END), true)
  assert.match(after, /- 铁律17 · 删文档前先核路径（全局）：删文档前先核对绝对路径。/)
  assert.match(after, /规则文件目录：/)
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), content, '.bak 必须是替换前全文')
  // 同一批规则用 doc.file 反推目录，渲染结果必须与显式 rulesDir 完全一致（幂等性不依赖调用形态）。
  const viaFile = renderAgentsDigest({
    rules: [{ ...doc({ key: 'iron-rule-17', number: 17, action: '删文档前先核路径', text: '删文档前先核对绝对路径。' }), file: join(rulesDir, 'iron-rule-17.md') }],
    agentsPath: path,
  })
  assert.equal(viaFile.changed, false, '脚注目录口径必须一致')
})

test('renderAgentsDigest：幂等（内容不变不写，mtime 不变，不再刷 .bak）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const rules = [doc({ key: 'iron-rule-17', number: 17, action: '删文档前先核路径' })]
  assert.equal(renderAgentsDigest({ rules, agentsPath: path }).changed, true)
  const mtimeAfterFirst = statSync(path).mtimeMs
  const second = renderAgentsDigest({ rules, agentsPath: path })
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(statSync(path).mtimeMs, mtimeAfterFirst, '内容不变必须保留 mtime')
})

test('renderAgentsDigest：空规则集渲染占位说明（块仍有效、可再渲染）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const got = renderAgentsDigest({ rules: [], agentsPath: path })
  assert.equal(got.ok, true)
  assert.equal(got.count, 0)
  const after = readFileSync(path, 'utf8')
  assert.match(after, /## 规则摘要（自动生成，勿手改）/)
  assert.equal(fileHasMarkers(path), true)
})

// ---------------------------------------------------------------------------
// renderLedgerDigest
// ---------------------------------------------------------------------------

function ledgerFile(dir) {
  const path = join(dir, '台账.md')
  const content = [
    '# 台账',
    '',
    '## 2. 核心铁律',
    '',
    '| 编号 | 标题 | 作用域 | 正文 |',
    '| --- | --- | --- | --- |',
    LEDGER_BEGIN,
    '| 1 | 旧 | global | 旧正文 |',
    LEDGER_END,
    '',
    '## 3. 其它',
    '',
  ].join('\n')
  writeFileSync(path, content, 'utf8')
  return { path, content }
}

test('ledgerDigestContent：iron 全文本 + 无编号 P0 排表尾', () => {
  const got = ledgerDigestContent([
    doc({ key: 'iron-rule-17', number: 17, action: '文件卫生', text: '删文档前先核对绝对路径。' }),
    doc({ key: 'rule-safety', number: null, type: 'rule', priority: 'P0', action: '安全', text: '密钥只走环境变量。' }),
    doc({ key: 'rule-p1', number: 5, type: 'rule', priority: 'P1', text: '普通 P1 不进台账。' }),
  ])
  assert.equal(got.count, 2)
  assert.match(got.content.split('\n')[0], /^\| 17 \| 文件卫生 \| global \| 删文档前先核对绝对路径。 \|$/)
  assert.match(got.content.split('\n')[1], /^\| — \| 安全 \| global \| 密钥只走环境变量。 \|$/)
})

test('renderLedgerDigest：只替换表体块；无标记 → no_markers；幂等', (t) => {
  const dir = freshDir(t)
  const { path } = ledgerFile(dir)
  const rules = [doc({ key: 'iron-rule-17', number: 17, action: '文件卫生', text: '删文档前先核对绝对路径。' })]
  const first = renderLedgerDigest({ rules, ledgerPath: path })
  assert.equal(first.ok, true, first.code)
  const after = readFileSync(path, 'utf8')
  assert.match(after, /## 2\. 核心铁律/)
  assert.match(after, /\| 编号 \| 标题 \| 作用域 \| 正文 \|/, '表头是静态的，不在块内')
  assert.match(after, /\| 17 \| 文件卫生 \| global \|/)
  assert.match(after, /## 3\. 其它/)
  assert.equal(renderLedgerDigest({ rules, ledgerPath: path }).changed, false)

  const plain = join(dir, 'plain.md')
  writeFileSync(plain, '没有标记\n', 'utf8')
  const missing = renderLedgerDigest({ rules, ledgerPath: plain })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'no_markers')
  assert.equal(renderLedgerDigest({ rules, ledgerPath: '' }).code, 'no_ledger_path')
})

test('renderAgentsDigest：路径参数缺失 → no_agents_path（不猜默认路径）', () => {
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: '' })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_agents_path')
})
