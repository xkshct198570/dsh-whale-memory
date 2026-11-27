// 规则提案单测共享夹具（临时规则根/假 backend/假 git）；被 rule-proposal-*.test.mjs 单向依赖，不 import 测试文件。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRule } from '../../src/core/rule-store.js'

export const IDENTITY = { userId: 'u1', roleId: 'reviewer', workspace: '' }

/** 临时规则根（每个用例独立；after 时整目录删掉）。 */
export function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'whale-proposal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

export function frontOf(overrides = {}) {
  return {
    key: 'rule-src-keep',
    type: 'rule',
    number: 1,
    priority: 'P1',
    scope: 'global',
    role: '',
    modality: 'must',
    action: '保留',
    object: '源文件',
    conditions: [],
    exceptions: ['正在被引用的文件'],
    status: 'active',
    merged_into: '',
    superseded_by: '',
    created: '2026-11-22',
    updated: '2026-11-22',
    version: 1,
    origin: 'unit',
    ...overrides,
  }
}

/** 写一条既有规则（真源文件；git 关掉，避免每个用例 spawn）。 */
export function seed(root, overrides = {}, text = '源文件必须保留。') {
  const got = writeRule(root, { front: frontOf(overrides), text }, { git: false })
  assert.equal(got.ok, true, JSON.stringify(got.detail || got.error))
  return got
}

/** 审计用假 backend：只记录 SQL，不开库。 */
export function fakeBackend() {
  const calls = []
  const db = {
    prepare(sql) {
      return {
        get: (...args) => { calls.push({ kind: 'get', sql, args }); return null },
        all: () => [],
        run: (...args) => { calls.push({ kind: 'run', sql, args }); return { changes: 1 } },
      }
    },
  }
  return { calls, withDb: (fn) => fn(db) }
}

/** 假 git：add/diff/commit 全部本地模拟；failCommit 用来验证回滚。 */
export function fakeGit({ failCommit = false } = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push({ file, args })
    if (file === 'git' && args[0] === '--version') return 'git version 2.43.0'
    const cmd = ['rev-parse', 'init', 'add', 'diff', 'commit'].find((name) => args.includes(name))
    if (cmd === 'rev-parse') return 'true'
    if (cmd === 'diff') { const err = new Error('diff exit 1'); err.code = 1; throw err }
    if (cmd === 'commit') {
      if (failCommit) { const err = new Error('commit boom'); err.stderr = 'boom'; throw err }
      return 'committed'
    }
    return ''
  }
  return { exec, calls }
}

/** 规则文件（排除 README.md：ensureRuleRepo 会建它，不能算规则）。 */
export function ruleFiles(root) {
  return readdirSync(root).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
}

export function readRuleText(root, key) {
  return readFileSync(join(root, `${key}.md`), 'utf8')
}

export function jsonFile(root, name) {
  return JSON.parse(readFileSync(join(root, 'proposals', name), 'utf8'))
}
