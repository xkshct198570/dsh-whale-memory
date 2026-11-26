/**
 * 收尾卡拆分拓扑与预算（S5）：防「拆完又塞回主体」的回潮。
 *
 * 为什么需要：`51-wrap-card` 是 Session-Wrap v2 的单文件设计预算 350 行（架构书 §2 表）；
 * lint-size 只查铁律 23 的 800 闸，查不到 350 这条产品预算，也查不到「实现是否被搬回主体」。
 * 本文件只断言三件事：MANIFEST 三片登记且顺序在主体前、主体不再复写被搬实现、有效行 ≤ 350。
 * 有效行由 `scripts/lint-size.mjs` 的 effectiveLines 计（唯一计行实现，不在测试里抄一份）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveLines } from '../../scripts/lint-size.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC_DIR = path.join(ROOT, 'lib/client-src')
const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'MANIFEST.json'), 'utf8'))

/** 读片段原文。 */
function slice(file) {
  return fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
}

const SLICES = ['51-wrap-card-actions.js', '51-wrap-card-report.js', '51-wrap-card-settings.js']
const MAIN = '51-wrap-card.js'

test('收尾卡三片已登记在 MANIFEST，且顺序在主体之前（装配可读）', () => {
  const files = manifest.map((entry) => entry.file)
  const mainIndex = files.indexOf(MAIN)
  assert.ok(mainIndex > 0, `${MAIN} 未登记`)
  for (const file of SLICES) {
    const index = files.indexOf(file)
    assert.ok(index >= 0, `${file} 未登记进 MANIFEST`)
    assert.ok(index < mainIndex, `${file} 应在 ${MAIN} 之前（主体只装配子片）`)
    assert.ok(index > files.indexOf('50-overview.js'), `${file} 应紧跟概览页之后`)
    const entry = manifest[index]
    assert.ok(entry.responsibility.trim().length >= 12, `${file} 的 responsibility 过短`)
  }
  // 主体职责必须写明它只装配（不得再写“取数/报告/设置”实现）。
  const mainEntry = manifest[mainIndex]
  assert.match(mainEntry.responsibility, /装配|卡壳|小件/, '主体 responsibility 未说明只装配')
})

test('主体不复写被搬走的实现（文案映射/useWrapCard/报告/设置区只留在各自分片）', () => {
  const main = slice(MAIN)
  for (const forbidden of [
    'const WRAP_ERROR_TEXT',
    'const WRAP_SKIP_TEXT',
    'function useWrapCard',
    'function WrapReport',
    'function WrapControls',
    'const copyReport',
    'const downloadReport',
  ]) {
    assert.ok(!main.includes(forbidden), `${MAIN} 不应再包含 ${forbidden}（应留在分片）`)
  }
  // 主体必须真的装配三片产物，否则拆分等于白搬。
  assert.match(main, /h\(WrapControls, \{/, '主体未装配 WrapControls')
  assert.match(main, /h\(WrapReport, \{/, '主体未装配 WrapReport')
  // 分片各自持有实现。
  assert.match(slice('51-wrap-card-actions.js'), /function useWrapCard/)
  assert.match(slice('51-wrap-card-report.js'), /function WrapReport/)
  assert.match(slice('51-wrap-card-settings.js'), /function WrapControls/)
})

test('主体有效行 ≤ 350（Session-Wrap v2 设计预算；lint-size 的 800 闸看不到这条）', () => {
  const count = effectiveLines(slice(MAIN), MAIN, true)
  assert.ok(count <= 350, `${MAIN} 有效行 ${count} > 350；新增内容请落到 actions/报告/设置分片或新分片`)
  assert.ok(count >= 100, `${MAIN} 有效行 ${count} 过少，疑似把主体也搬空了`)
})

test('三片各自只做一件事：分片里有职责注释首行，且不互相装配', () => {
  const actions = slice('51-wrap-card-actions.js')
  const report = slice('51-wrap-card-report.js')
  const settings = slice('51-wrap-card-settings.js')
  for (const [file, text] of [[SLICES[0], actions], [SLICES[1], report], [SLICES[2], settings]]) {
    const head = text.split('\n').slice(0, 5).join('\n')
    assert.match(head, /职责：/, `${file} 首行块缺职责说明（铁律 23）`)
    assert.match(head, /依赖同一 factory 作用域/, `${file} 首行块缺依赖方向（铁律 23）`)
  }
  assert.ok(!actions.includes("h('div'"), 'actions 分片不应渲染（h 只属于报告/设置/主体）')
  assert.ok(!report.includes('useWrapCard'), '报告分片不应取数')
  assert.ok(!settings.includes('callJson'), '设置分片不应取数')
})
