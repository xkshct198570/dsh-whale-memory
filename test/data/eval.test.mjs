/**
 * 黄金评测回归：runEval 判定口径 + fixture 形态。
 *
 * 为什么：评测脚本一旦判定写错（例如空集被"全命中"真空通过），precision 会虚高，
 * 后续任何检索改动都能"绿着"上线。这里用临时库构造可手算的小样本，钉住计数、缺词、
 * 空集通过条件与 fixture 字段，和真实库跑分互不耦合。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { openDb, closeDb, now } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { runEval } from '../../scripts/eval.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/eval.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/eval.json', import.meta.url))

let dir
let db

function addNode(id, text, extra = {}) {
  const ts = extra.createdAt ?? now()
  db.prepare(
    `INSERT INTO nodes
       (id, text, text_hash, text_bigrams, level, memory_type, source, status,
        role_id, user_id, workspace, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    text,
    contentHash(text),
    bigrams(text),
    extra.level ?? 'normal',
    extra.type ?? 'semantic',
    extra.source ?? 'self',
    extra.status ?? 'active',
    extra.roleId ?? '',
    extra.userId ?? '',
    extra.workspace ?? '',
    ts,
    ts,
  )
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'whale-eval-'))
  db = openDb(dir)
  addNode('e1', '群主转让 冻结期 七天', { level: 'important' })
  addNode('e2', 'WSL 断网 resolv.conf 改为 8.8.8.8')
  addNode('e3', 'rdclientax.dll 报错 0xc000007b', { source: 'tool' })
  addNode('e4', '灾备 备份包 上传')
})

after(() => {
  closeDb(db)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// 4 条小样本：1 过 / 1 命中但缺词（必挂）/ 1 ident / 1 空集零命中。
const MINI_CASES = [
  { id: 'm1', kind: 'cjk', query: '群主转让 冻结期', must_hit_keywords: ['冻结期'] },
  { id: 'm2', kind: 'ident', query: 'rdclientax', must_hit_keywords: ['rdclientax'] },
  { id: 'm3', kind: 'cjk', query: '群主转让 冻结期', must_hit_keywords: ['冻结期', '七日'] },
  { id: 'm4', kind: 'empty', query: 'zzqqxx', must_hit_keywords: [], expect_empty: true },
]

test('runEval：可手算的计数、缺词与空集判定', () => {
  const result = runEval({ db, cases: MINI_CASES, topN: 3, identity: { userId: 'alice' } })

  assert.equal(result.total, 4)
  assert.equal(result.keywordTotal, 3)
  assert.equal(result.passed, 2, '空集不进 precision 分母')
  assert.equal(result.precision, 2 / 3)
  assert.equal(result.identTotal, 1)
  assert.equal(result.identPassed, 1)
  assert.equal(result.identHitRate, 1)
  assert.equal(result.zeroTotal, 1)
  assert.equal(result.zeroRate, 0.25)
  assert.equal(result.emptyTotal, 1)
  assert.equal(result.emptyClean, 1)
  assert.equal(result.rows.length, 4)

  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]))
  assert.equal(byId.m1.passed, true)
  assert.deepEqual(byId.m1.missing, [])
  assert.equal(byId.m1.hits[0].id, 'e1')
  assert.match(byId.m1.hits[0].text, /冻结期/)

  assert.equal(byId.m2.passed, true)
  assert.ok(byId.m2.hits.some((hit) => hit.id === 'e3'))

  // 命中数非零但缺一个词 → 必挂，且缺词要能指出来。
  assert.equal(byId.m3.passed, false)
  assert.deepEqual(byId.m3.missing, ['七日'])
  assert.ok(byId.m3.hits.length > 0)

  // 空集没有关键词；只有 0 命中才算通过。
  assert.equal(byId.m4.passed, true)
  assert.deepEqual(byId.m4.hits, [])

  for (const row of result.rows) {
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.kind, 'string')
    assert.equal(typeof row.query, 'string')
    assert.ok(Array.isArray(row.hits))
    assert.ok(Array.isArray(row.missing))
    for (const hit of row.hits) {
      assert.equal(typeof hit.id, 'string')
      assert.equal(typeof hit.text, 'string')
    }
  }
})

test('runEval：topN 截断命中，缺失词不会跨节点拼出来', () => {
  const result = runEval({
    db,
    cases: [
      { id: 't1', kind: 'cjk', query: '群主转让 冻结期', must_hit_keywords: ['冻结期'] },
      { id: 't2', kind: 'cjk', query: '群主转让 冻结期', must_hit_keywords: ['群主转让', 'rdclientax'] },
    ],
    topN: 1,
    identity: { userId: 'alice' },
  })
  assert.equal(result.rows[0].hits.length, 1)
  assert.equal(result.rows[1].passed, false, '关键词必须出现在同一次 topN 的某个文本里，不能靠跨节点拼凑')
  assert.deepEqual(result.rows[1].missing, ['rdclientax'])
})

test('fixture：32 条、字段合法、无本机身份', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  assert.equal(fixture.version, 1)
  assert.equal(fixture.source, 'v2 黄金评测集移植')
  assert.equal(fixture.role_id, undefined)
  assert.equal(fixture.user_id, undefined)
  assert.equal(fixture.notes, undefined)
  assert.equal(fixture.cases.length, 32)

  const ids = new Set()
  let keywordCases = 0
  for (const item of fixture.cases) {
    assert.equal(typeof item.id, 'string')
    assert.ok(item.id.length > 0)
    assert.equal(typeof item.kind, 'string')
    assert.ok(item.kind.length > 0)
    assert.equal(typeof item.query, 'string')
    assert.ok(item.query.trim().length > 0, `${item.id} 的 query 不能为空`)
    assert.ok(Array.isArray(item.must_hit_keywords), `${item.id} 的 must_hit_keywords 必须是数组`)
    for (const keyword of item.must_hit_keywords) {
      assert.equal(typeof keyword, 'string', `${item.id} 的关键词必须是字符串`)
      assert.ok(keyword.trim().length > 0, `${item.id} 的关键词不能为空串`)
    }
    assert.ok(!ids.has(item.id), `重复 id：${item.id}`)
    ids.add(item.id)

    if (item.kind === 'empty') {
      // 空集用例没有可命中的关键词：以 expect_empty 表达"必须 0 命中"。
      assert.equal(item.expect_empty, true, `${item.id} 空集用例必须标 expect_empty`)
      assert.equal(item.must_hit_keywords.length, 0)
    } else {
      keywordCases += 1
      assert.ok(item.must_hit_keywords.length > 0, `${item.id} 必须至少一个关键词`)
    }
  }
  assert.equal(ids.size, 32)
  assert.equal(keywordCases, 30)
  assert.equal(fixture.cases.filter((item) => item.kind === 'empty').length, 2)
})

test('CLI：--json 只输出 JSON，退出码按 precision 门限', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--db', dir, '--topn', '3', '--min', '0', '--json'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  const parsed = JSON.parse(ok.stdout)
  assert.equal(parsed.total, 32)
  assert.equal(typeof parsed.precision, 'number')
  assert.equal(typeof parsed.identHitRate, 'number')
  assert.equal(parsed.rows.length, 32)

  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /未知参数/)

  const missing = spawnSync(process.execPath, [SCRIPT, '--db', join(dir, 'nope'), '--json'], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.equal(missing.stdout.trim(), '')
})
