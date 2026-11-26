import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { renderWrapReport, wrapReportFileName } from '../../src/core/wrap-report.js'

const HEADINGS = ['## 结论', '## 记忆候选', '## 规则提案', '## 待办', '## 清洁检查', '## 可切会话']

test('wrapReportFileName：日期 + 会话 hash + runId，runId 缺失/非法落 r0', () => {
  const sid = 'sess-abc'
  const hash = createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 8)
  assert.equal(
    wrapReportFileName({ day: '2026-11-24', sessionId: sid, runId: 7 }),
    `session-wrap-2026-11-24-${hash}-r7.md`,
  )
  assert.equal(
    wrapReportFileName({ day: '2026-11-24', sessionId: sid }),
    `session-wrap-2026-11-24-${hash}-r0.md`,
  )
  assert.match(wrapReportFileName({ day: '2026-11-24', sessionId: sid, runId: 0 }), /-r0\.md$/)
  assert.match(wrapReportFileName({ day: '2026-11-24', sessionId: sid, runId: 'x'.repeat(60) }), /-r0\.md$/)
})

test('wrapReportFileName：sessionId 缺失按 unknown hash，同日不同 runId 不互相覆盖', () => {
  const a = wrapReportFileName({ day: '2026-11-24' })
  const expectedHash = createHash('sha256').update('unknown', 'utf8').digest('hex').slice(0, 8)
  assert.equal(a, `session-wrap-2026-11-24-${expectedHash}-r0.md`)
  const b = wrapReportFileName({ day: '2026-11-24', sessionId: 'same', runId: 1 })
  const c = wrapReportFileName({ day: '2026-11-24', sessionId: 'same', runId: 2 })
  assert.notEqual(b, c)
  assert.match(b, /^session-wrap-2026-11-24-[0-9a-f]{8}-r1\.md$/)
})

test('wrapReportFileName：路径穿越输入被挡死（日期/runId 白名单 + 会话 hash）', () => {
  const name = wrapReportFileName({
    day: '../../../etc/passwd', sessionId: '../../secret', runId: '../../x',
  })
  assert.ok(!name.includes('/'), '文件名不得含路径分隔符')
  assert.match(name, /^session-wrap-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-r0\.md$/)
  const invalidDay = wrapReportFileName({ day: '2026-02-31', sessionId: 's' })
  assert.match(invalidDay, /^session-wrap-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-r0\.md$/)
  assert.ok(!invalidDay.includes('2026-02-31'), '不存在的日期不得进文件名')
})

test('renderWrapReport：六个二级标题固定且顺序一致，元信息含 trigger/runId/生成时间', () => {
  const report = renderWrapReport({
    run: { day: '2026-11-24', trigger: 'manual', runId: 7 },
    summary: '完成收尾',
    items: [{ kind: 'lesson', text: '依赖装法统一用 pnpm', status: 'review' }],
    ruleProposals: ['收尾前必须先备份'],
    openLoops: ['补测孤儿边'],
    hygiene: { checks: [{ key: 'fts_aligned', status: 'ok', detail: 'nodes=1' }] },
    switchReady: { ready: true, blockers: [] },
    generatedAt: '2026-11-24T17:00:00+08:00',
  })
  assert.ok(report.startsWith('# 会话收尾报告 2026-11-24'))
  assert.match(report, /trigger: manual · runId: 7 · 生成时间: 2026-11-24T17:00:00\+08:00/)
  const found = [...report.matchAll(/^## .+$/gm)].map((hit) => hit[0])
  assert.deepEqual(found, HEADINGS)
  assert.match(report, /## 结论\n\n完成收尾/)
  assert.match(report, /## 记忆候选\n\n待审 1 条（正文仅供人工审核）：\n- \[lesson\] 依赖装法统一用 pnpm/)
  assert.match(report, /## 规则提案\n\n- 收尾前必须先备份/)
  assert.match(report, /## 待办\n\n- 补测孤儿边/)
  assert.match(report, /## 清洁检查\n\n- fts_aligned: ok — nodes=1/)
  assert.match(report, /## 可切会话\n\n- 可切：是/)
})

test('renderWrapReport：失败状态进行尾（写入失败/未创建），其余 status 忽略', () => {
  const report = renderWrapReport({
    run: { day: '2026-11-24', trigger: 'manual', runId: 3 },
    summary: '续跑',
    items: [
      { kind: 'fact', text: '端口 3080', status: 'write_failed:EACCES' },
      { kind: 'fact', text: '库在 whale.db', status: 'ingested', nodeId: 'n-1' },
      { kind: 'fact', text: '无状态条目' },
    ],
    ruleProposals: [
      { text: '规则甲', status: 'proposal_rejected:重复' },
      '规则乙',
      { text: '规则丙', status: 'write_failed:proposal_error' },
    ],
    switchReady: { ready: false, blockers: ['fts_aligned 未对齐'] },
    generatedAt: '2026-11-24T17:00:00+08:00',
  })
  assert.match(report, /写入失败 1 条：EACCES×1/)
  assert.ok(!report.includes('端口 3080'), '写入失败条不得打印正文')
  assert.match(report, /入库 1 条（node: n-1）/)
  assert.ok(!report.includes('库在 whale.db'), '已入库条不得打印正文')
  assert.match(report, /- 规则甲 （未创建：重复）/)
  assert.match(report, /- 规则乙\n/)
  assert.match(report, /- 规则丙 （未创建：proposal_error）/)
  assert.match(report, /- 可切：否\n- 阻塞：\n  - fts_aligned 未对齐/)
})

test('renderWrapReport：空输入可渲染，缺失项降级为占位文案', () => {
  const report = renderWrapReport()
  assert.ok(report.startsWith('# 会话收尾报告 '))
  const found = [...report.matchAll(/^## .+$/gm)].map((hit) => hit[0])
  assert.deepEqual(found, HEADINGS)
  assert.match(report, /## 结论\n\n（无摘要）/)
  assert.match(report, /## 记忆候选\n\n（无）/)
  assert.match(report, /## 规则提案\n\n（无）/)
  assert.match(report, /## 待办\n\n（无）/)
  assert.match(report, /## 清洁检查\n\n（未运行）/)
  assert.match(report, /## 可切会话\n\n- 可切：否/)
  assert.match(report, /trigger: - · runId: - · 生成时间: -/)
})

test('renderWrapReport：绝不输出原始对话/素材字段（只认结构化入参）', () => {
  const secret = '用户原始对话：我的密码是 hunter2，token=sk-live-123'
  const report = renderWrapReport({
    run: {
      day: '2026-11-24', trigger: 'manual', runId: 9,
      material: { turns: [{ role: 'user', text: secret }] },
      turns: [{ role: 'user', text: secret }],
    },
    summary: '完成收尾',
    items: [],
    generatedAt: '2026-11-24T17:00:00+08:00',
  })
  assert.ok(!report.includes('hunter2'), '报告不得泄露原始对话')
  assert.ok(!report.includes('sk-live-123'))
  assert.ok(!/\bmaterial\b/.test(report))
  assert.ok(!/\bturns\b/.test(report))
})

test('renderWrapReport：run 无 day 时用 generatedAt 推断；数字 runId 正常展示', () => {
  const report = renderWrapReport({
    run: { id: 12, trigger: 'manual' },
    summary: '续跑',
    generatedAt: '2026-11-25T09:30:00.000Z',
  })
  assert.ok(report.startsWith('# 会话收尾报告 2026-11-25'))
  assert.match(report, /runId: 12/)
})

test('renderWrapReport：dropped 只输出按原因聚合的计数，不输出丢弃正文', () => {
  const report = renderWrapReport({
    summary: '完成',
    items: [{ kind: 'lesson', text: '保留项', status: 'review' }],
    dropped: [
      { text: '不该出现的原文甲', reason: 'evidence_not_found' },
      { text: '不该出现的原文乙', reason: 'evidence_not_found' },
      { text: '不该出现的原文丙', reason: 'duplicate' },
    ],
  })
  assert.match(report, /（蒸馏剔除 3 条：evidence_not_found×2、duplicate×1）/)
  assert.ok(!report.includes('不该出现的原文'))
})

test('renderWrapReport：条目必须是结构化对象；对象提案/待办都能渲染，不丢信息', () => {
  const report = renderWrapReport({
    items: [{ kind: 'fact', text: '对象候选', status: 'review' }],
    ruleProposals: [{ text: '对象提案' }],
    openLoops: [{ text: '对象待办' }],
    switchReady: true,
  })
  assert.match(report, /- \[fact\] 对象候选/)
  assert.match(report, /- 对象提案/)
  assert.match(report, /- 对象待办/)
  assert.match(report, /- 可切：是/)
})

test('renderWrapReport：ingested 只列计数+node id，skipped 只列分类码，均不含正文', () => {
  const report = renderWrapReport({
    items: [
      { kind: 'lesson', text: '已入库的正文甲', status: 'ingested', nodeId: 'n-a' },
      { kind: 'lesson', text: '已入库的正文乙', status: 'ingested', nodeId: 'n-b' },
      { kind: 'decision', text: '任务句正文不得出现', status: 'skipped:gate:task' },
      { kind: 'fact', text: '过期状态正文不得出现', status: 'skipped:gate:stale' },
      { kind: 'fact', text: '待审正文必须出现', status: 'review' },
    ],
  })
  assert.match(report, /入库 2 条（node: n-a, n-b）/)
  assert.match(report, /跳过 2 条：gate:task×1 · gate:stale×1/)
  assert.ok(!report.includes('已入库的正文'))
  assert.ok(!report.includes('任务句正文'))
  assert.ok(!report.includes('过期状态正文'))
  assert.match(report, /待审 1 条（正文仅供人工审核）：\n- \[fact\] 待审正文必须出现/)
})
