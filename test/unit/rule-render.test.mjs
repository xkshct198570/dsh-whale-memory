/**
 * 规则渲染单测（R3b）：AGENTS 摘要块 / 台账 §2 块。
 * 关键口径：只改标记块内部、缺标记与重复标记都拒绝、内容不变不落盘（保 mtime）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utimesSync } from 'node:fs'
import {
  RULES_BEGIN, RULES_END,
  agentsBlockStale, agentsNeedsRepair, agentsPathOf, fileHasMarkers, inspectMarkers,
  renderAgentsDigest, rulesDigestContent, titleOfRule,
} from '../../src/core/rule-render.js'

function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function doc({
  key = 'k1', number = 1, type = 'iron-rule', scope = 'global', priority = 'P0', status = 'active',
  action = '', text = '必须保留审计日志。', file = '', summary = '',
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
      ...(summary !== '' ? { summary } : {}),
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

// R8-06 契约变更：摘要由「global active 铁律」扩为「global active 全收」——普通全局规则
// 也必须出现在 AGENTS（铁律按编号在前、普通规则按 priority→key 在后），否则普通规则只剩
// 面板可见、模型永远读不到。原断言 `count=3` / 普通规则不进摘要按 v3.8 §4.1 作废。
test('rulesDigestContent：只收 global+active（铁律按编号前、普通按 priority→key 后），正文截 500 字', () => {
  const long = '必须'.repeat(300)
  const got = rulesDigestContent([
    doc({ key: 'iron-rule-17', number: 17, text: '删文档前先核对绝对路径。' }),
    doc({ key: 'iron-rule-13', number: 13, text: '只在本工作区生效。' }),
    doc({ key: 'rule-1', number: null, type: 'rule', priority: 'P1', text: '普通全局规则也要进摘要。' }),
    doc({ key: 'rule-0', number: null, type: 'rule', priority: 'P0', text: 'P0 普通规则排在 P1 前。' }),
    doc({ key: 'iron-rule-18', number: 18, scope: 'workspace:/tmp/ws', text: '工作区规则不该进摘要。' }),
    doc({ key: 'iron-rule-19', number: 19, status: 'superseded', text: '退役规则不该进摘要。' }),
    doc({ key: 'iron-rule-20', number: 20, text: long }),
  ])
  assert.equal(got.count, 5)
  assert.deepEqual(got.keys, [
    'iron-rule-13', 'iron-rule-17', 'iron-rule-20', 'rule-0', 'rule-1',
  ])
  assert.match(got.content, /^## 规则摘要（自动生成，勿手改）/)
  assert.match(got.content, /- 铁律13 · /)
  assert.match(got.content, /- rule-0 · P0 普通规则排在 P1 前（全局）：/)
  assert.match(got.content, /- rule-1 · 普通全局规则也要进摘要（全局）：/)
  const longLine = got.content.split('\n').find((line) => line.startsWith('- 铁律20'))
  // 摘要 60 字后追加「（文件：…）」指针，取两者之间的正文再数长度。
  const excerpt = longLine.slice(longLine.indexOf('：') + 1, longLine.indexOf('（文件：'))
  // 500 字 + 截断省略号（长文本才有）
  assert.equal(Array.from(excerpt).length, 501)
  assert.match(excerpt, /…$/)
  assert.match(longLine, /（文件：iron-rule-20\.md）$/)
})

test('rulesDigestContent：front.summary 优先（≤120 码点），超长硬切不留 121 字', () => {
  const longSummary = '摘'.repeat(130)
  const got = rulesDigestContent([
    doc({ key: 'iron-rule-21', number: 21, summary: '一句摘要。', text: '正文'.repeat(120) }),
    doc({ key: 'iron-rule-22', number: 22, summary: longSummary }),
  ])
  const lines = got.content.split('\n')
  const line21 = lines.find((line) => line.startsWith('- 铁律21'))
  assert.match(line21, /：一句摘要。（文件：iron-rule-21\.md）$/, 'summary 必须优先于正文摘录')
  const line22 = lines.find((line) => line.startsWith('- 铁律22'))
  const excerpt22 = line22.slice(line22.indexOf('：') + 1, line22.indexOf('（文件：'))
  assert.equal(Array.from(excerpt22).length, 120)
})

test('rulesDigestContent：正文单行化 + 控制字符剔除 + 标记字面量防御性剔除', () => {
  const text = '第一行\n第二行\r\n第三行\u0007结束。<!-- whale-memory:rules:end -->余下'
  const got = rulesDigestContent([doc({ key: 'iron-rule-23', number: 23, text })])
  const line = got.content.split('\n').find((item) => item.startsWith('- 铁律23'))
  assert.equal(line.includes('\u0007'), false, '控制字符必须剔除')
  assert.equal(got.content.includes('whale-memory:rules:'), false, '标记字面量必须防御性剔除')
  assert.match(line, /第一行 第二行 第三行结束。余下/)
})

test('rulesDigestContent：无 summary 时 500 码点回退最后一个句末（不切半句）', () => {
  const head = `${'甲'.repeat(100)}。`
  const text = `${head}${'乙'.repeat(500)}。`
  const got = rulesDigestContent([doc({ key: 'iron-rule-25', number: 25, text })])
  const line = got.content.split('\n').find((item) => item.startsWith('- 铁律25'))
  const excerpt = line.slice(line.indexOf('：') + 1, line.indexOf('（文件：'))
  assert.equal(excerpt, `${head}…`, '前 500 码点内最后句末在第 100 位，必须回退到句末')
})

test('titleOfRule：标题压单行并按码点切片（不切代理对）', () => {
  const title = titleOfRule({ action: '😀'.repeat(100) }, '正文')
  assert.equal(Array.from(title).length, 81, '80 码点 + 省略号')
  assert.equal(title.endsWith('…'), true)
  assert.equal(title.includes('\uFFFD'), false, '不得出现半个代理对')
  assert.equal(titleOfRule({ action: '删\n源文件' }, '正文'), '删 源文件', '标题必须单行')
})


test('rulesDigestContent：标题取 action，缺省退正文首句；作用域规则只注入不进摘要', () => {
  assert.equal(titleOfRule({ action: '删源文件' }, '正文'), '删源文件')
  assert.equal(titleOfRule({ action: '删源文件', modality: 'must_not' }, '正文'), '禁止删源文件')
  assert.equal(titleOfRule({ action: '存放凭据', modality: 'only' }, '正文'), '只准存放凭据')
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

test('renderAgentsDigest：路径参数缺失 → no_agents_path（不猜默认路径）', () => {
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: '' })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_agents_path')
})

// ---------------------------------------------------------------------------
// R8-06：CRLF / .bak 轮转 / 标记防御 / 仓库锁注入
// ---------------------------------------------------------------------------

test('renderAgentsDigest：CRLF 文件保持 CRLF，块外字节一字不动', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const eol = '\r\n'
  const content = ['# 说明', '', RULES_BEGIN, '- 旧行', RULES_END, '', '尾行', ''].join(eol)
  writeFileSync(path, content, 'utf8')
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-26', number: 26, text: 'CRLF 文件也要能渲染。' })],
    agentsPath: path,
  })
  assert.equal(got.ok, true, got.code)
  const after = readFileSync(path, 'utf8')
  assert.ok(after.startsWith(`# 说明${eol}`), '块外开头逐字节保留')
  assert.ok(after.endsWith(`尾行${eol}`), '块外结尾逐字节保留')
  assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, '不得出现孤立 LF（CRLF 必须保持）')
  assert.ok(after.includes(`${RULES_BEGIN}${eol}`), '块内行分隔符跟随原文件 EOL')
  assert.ok(after.includes(`${eol}${RULES_END}`))
  assert.equal(inspectMarkers(after).ok, true)
})

test('renderAgentsDigest：正文含管理块标记也不撕开摘要块（防御性剔除）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-24', number: 24, text: '危险 <!-- whale-memory:rules:end --> 注入' })],
    agentsPath: path,
  })
  assert.equal(got.ok, true, got.code)
  assert.equal(fileHasMarkers(path), true, '管理块仍完整单例')
  const markers = inspectMarkers(readFileSync(path, 'utf8'))
  assert.equal(markers.beginCount, 1)
  assert.equal(markers.endCount, 1)
})

test('renderAgentsDigest：.bak 轮转保留最近 5 份', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  for (let i = 1; i <= 7; i += 1) {
    const got = renderAgentsDigest({
      rules: [doc({ key: 'iron-rule-27', number: 27, text: `第 ${i} 版正文。` })],
      agentsPath: path,
    })
    assert.equal(got.ok, true, got.code)
  }
  assert.equal(existsSync(`${path}.bak`), true)
  for (let i = 1; i <= 4; i += 1) assert.equal(existsSync(`${path}.bak.${i}`), true, `.bak.${i} 必须保留`)
  assert.equal(existsSync(`${path}.bak.5`), false, '超过 5 份必须淘汰')
  assert.match(readFileSync(`${path}.bak`, 'utf8'), /第 6 版正文/, '.bak 永远是最新一次替换前全文')
})

test('renderAgentsDigest：读-改-写包在仓库锁内（契约 §1 withRepoLock，注入 fake）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const rulesDir = join(dir, 'rules')
  const calls = []
  const fakeLock = (root, fn) => {
    calls.push(root)
    return fn()
  }
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-28', number: 28 })],
    agentsPath: path,
    rulesDir,
    lock: fakeLock,
  })
  assert.equal(got.ok, true, got.code)
  assert.deepEqual(calls, [rulesDir], '锁根必须是规则仓（.locks 与 manifest 同根）')

  // 锁抛错：fail-open 返回错误码，不抛、不写坏文件。
  const before = readFileSync(path, 'utf8')
  const failed = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-29', number: 29 })],
    agentsPath: path,
    rulesDir,
    lock: () => { throw new Error('rule_locked') },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'render_failed')
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('renderAgentsDigest：渲染时恒重读磁盘（块外手改不丢字节）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const rules = [doc({ key: 'iron-rule-30', number: 30 })]
  assert.equal(renderAgentsDigest({ rules, agentsPath: path }).changed, true)
  // 用户手改块外：再渲染必须重读，保留手改内容。
  const edited = readFileSync(path, 'utf8').replace('块外内容第一行。', '块外内容第一行（用户手改）。')
  writeFileSync(path, edited, 'utf8')
  const got = renderAgentsDigest({ rules: [doc({ key: 'iron-rule-31', number: 31 })], agentsPath: path })
  assert.equal(got.ok, true)
  assert.match(readFileSync(path, 'utf8'), /块外内容第一行（用户手改）。/)
})

// ---------------------------------------------------------------------------
// R8-06 P1：干净安装时创建最小管理块（只有显式 createIfMissing 才创建）
// ---------------------------------------------------------------------------

test('renderAgentsDigest：createIfMissing=true 且文件不存在 → 创建最小管理块', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-40', number: 40, text: '干净安装也要看得见默认铁律。' })],
    agentsPath: path,
    createIfMissing: true,
  })
  assert.equal(got.ok, true, got.code)
  assert.equal(got.changed, true)
  assert.equal(got.created, true)
  assert.equal(got.count, 1)
  assert.equal(existsSync(path), true, '干净安装必须落 AGENTS.md')
  const content = readFileSync(path, 'utf8')
  assert.ok(content.startsWith(`${RULES_BEGIN}\n`), '首行就是 begin 标记')
  assert.ok(content.endsWith(`${RULES_END}\n`), '末行就是 end 标记')
  assert.match(content, /- 铁律40 · 干净安装也要看得见默认铁律/)
  const markers = inspectMarkers(content)
  assert.equal(markers.ok, true, '创建出来的块必须完整单例')
  assert.equal(markers.beginCount, 1)
  assert.equal(markers.endCount, 1)
  assert.equal(fileHasMarkers(path), true)
})

test('renderAgentsDigest：createIfMissing 默认关闭（手动渲染不造宿主资产）', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: path })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_markers')
  assert.equal(existsSync(path), false)
})

test('renderAgentsDigest：createIfMissing=true 但文件存在且无标记 → 仍不追加', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const content = '# 用户自己的说明书\n\n没有任何管理块。\n'
  writeFileSync(path, content, 'utf8')
  const got = renderAgentsDigest({ rules: [doc()], agentsPath: path, createIfMissing: true })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_markers')
  assert.equal(readFileSync(path, 'utf8'), content, '用户资产一个字节都不动')
})

test('renderAgentsDigest：createIfMissing=true 且已有标记 → 正常块内替换，块外不变', (t) => {
  const dir = freshDir(t)
  const { path, content } = agentsFile(dir)
  const got = renderAgentsDigest({
    rules: [doc({ key: 'iron-rule-41', number: 41 })],
    agentsPath: path,
    createIfMissing: true,
  })
  assert.equal(got.ok, true, got.code)
  assert.equal(got.changed, true)
  assert.equal(got.created, false, '已有文件不应标记为创建')
  const after = readFileSync(path, 'utf8')
  assert.ok(after.startsWith('# 本机说明书'), '块外开头保留')
  assert.match(after, /块外内容最后一行。/)
  assert.equal(after.replace(/\n/g, '').length > 0, true)
})

test('renderAgentsDigest：创建后再次渲染幂等（changed=false，mtime 不变，不刷 .bak）', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const rules = [doc({ key: 'iron-rule-42', number: 42 })]
  const first = renderAgentsDigest({ rules, agentsPath: path, createIfMissing: true })
  assert.equal(first.created, true)
  const mtime = statSync(path).mtimeMs
  const second = renderAgentsDigest({ rules, agentsPath: path, createIfMissing: true })
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(second.created, false)
  assert.equal(statSync(path).mtimeMs, mtime, '内容不变必须保留 mtime')
  assert.equal(existsSync(`${path}.bak`), false, '创建不是替换，不产生 .bak')
})

test('renderAgentsDigest：createIfMissing=true 但规则为空 → 不创建空壳管理块', (t) => {
  const dir = freshDir(t)
  const path = join(dir, 'AGENTS.md')
  const got = renderAgentsDigest({ rules: [], agentsPath: path, createIfMissing: true })
  assert.equal(got.ok, false)
  assert.equal(got.code, 'no_markers')
  assert.equal(existsSync(path), false)
})

test('R9-14：摘要总预算——超出按 priority→key 截断，被切规则回报 skipped', () => {
  const docs = [
    doc({ key: 'iron-rule-1', number: 1, text: '必须保留审计日志，并在每次写入后核对快照。' }),
    doc({ key: 'rule-a', type: 'rule', number: null, priority: 'P1', text: '必须把过程稿归档到临时目录。' }),
    doc({ key: 'rule-b', type: 'rule', number: null, priority: 'P2', text: '必须每周清理一次候选冷却日志。' }),
  ]
  const got = rulesDigestContent(docs, { budgetChars: 120 })
  assert.ok(got.skipped.length >= 1, `低优先级规则应被截断：${JSON.stringify(got)}`)
  assert.equal(got.count + got.skipped.length, docs.length, '不能被截断的规则必须原样留在摘要里')
  for (const item of got.skipped) {
    assert.equal(got.keys.includes(item.key), false, `被截断的 ${item.key} 不得同时在摘要里`)
  }
  // 预算内的结果必须真的在预算内（脚注也计入）。
  assert.ok(Array.from(got.content).length <= 120, `content 超预算：${got.chars}`)
})

test('R9-14：链终点过滤——active 但带 merged_into/superseded_by 指针的规则不进摘要', () => {
  const merged = doc({ key: 'rule-old', type: 'rule', number: null, text: '这条已被合并。' })
  merged.front.merged_into = 'rule-new'
  const superseded = doc({ key: 'rule-gone', type: 'rule', number: null, text: '这条已被取代。' })
  superseded.front.superseded_by = 'rule-new'
  const terminal = doc({ key: 'rule-new', type: 'rule', number: null, text: '这是链终点。' })
  const got = rulesDigestContent([merged, superseded, terminal])
  assert.deepEqual(got.keys, ['rule-new'], '只允许链终点进摘要')
  assert.equal(got.content.includes('已被合并'), false)
})

test('agentsBlockStale：内容已对齐时 render 必须解除陈旧（禁止每步重渲染）', (t) => {
  const dir = freshDir(t)
  const { path } = agentsFile(dir)
  const rulesDir = join(dir, 'rules')
  const rules = [doc({ key: 'iron-rule-17', number: 17, action: '删文档前先核路径', text: '删文档前先核对绝对路径。' })]
  // 第一次渲染：内容从无到有，changed=true。
  assert.equal(renderAgentsDigest({ rules, agentsPath: path, rulesDir }).changed, true)
  // 模拟规则文件比 AGENTS 块新（git pull/touch 都会发生）：旧实现会判陈旧且永不解除。
  const ruleFile = join(rulesDir, 'iron-rule-17.md')
  writeFileSync(ruleFile, 'mtime 探针', 'utf8')
  utimesSync(ruleFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  const newest = statSync(ruleFile).mtimeMs
  assert.equal(agentsNeedsRepair({ agentsPath: path, rulesDir, newest, freshUpTo: 0 }), true)
  // 第二次渲染：内容一致 → changed=false（不落盘、mtime 不动，保持幂等契约）。
  const again = renderAgentsDigest({ rules, agentsPath: path, rulesDir })
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  // hook 在渲染成功后把 freshUpTo 前移到 newest：陈旧判据必须解除，否则每步重渲染。
  assert.equal(agentsNeedsRepair({ agentsPath: path, rulesDir, newest, freshUpTo: newest }), false)
  // 新的规则改动（更大的 mtime）仍要能触发一次修复。
  assert.equal(agentsNeedsRepair({ agentsPath: path, rulesDir, newest: newest + 1000, freshUpTo: newest }), true)
})

test('agentsBlockStale：给了期望摘要就按内容判（mtime 假黄灯不再误报）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-agents-stale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const rulesDir = join(dir, 'rules')
  mkdirSync(rulesDir)
  const agents = join(dir, 'AGENTS.md')
  writeFileSync(agents, `# hi\n<!-- whale-memory:rules:begin -->\n期望正文\n<!-- whale-memory:rules:end -->\n`)
  writeFileSync(join(rulesDir, 'iron-rule-1.md'), 'newer rule file')
  // 让规则文件明确新于 AGENTS（mtime 判据下会判陈旧）
  utimesSync(join(rulesDir, 'iron-rule-1.md'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  assert.equal(agentsBlockStale({ agentsPath: agents, rulesDir }), true, '无期望摘要时仍按 mtime 判陈旧')
  assert.equal(
    agentsBlockStale({ agentsPath: agents, rulesDir, expectedContent: '期望正文' }),
    false,
    '内容一致（只是 mtime 旧）不得报陈旧',
  )
  assert.equal(
    agentsBlockStale({ agentsPath: agents, rulesDir, expectedContent: '换了一份正文' }),
    true,
    '内容不一致必须报陈旧（不看 mtime）',
  )
})
