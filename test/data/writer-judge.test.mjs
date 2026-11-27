// write.judge=llm 判定器端到端（候选→裁决→既有分支/回落）；依赖 writer-harness.mjs 的判定器夹具，不 import 其它测试文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb, now } from '../../src/core/db.js'
import { bigrams, contentHash } from '../../src/core/tokenize.js'
import { Config } from '../../src/host/config.js'
import { createBackend } from '../../src/core/backend.js'
import { createKeeper } from '../../src/core/keeper.js'
import {
  contradiction, createWriteQueue, decideWrite, findCandidates, privacyCheck, processEvent,
  recordWrite, slotsOf, timeOverlap,
} from '../../src/core/writer.js'
import { IDENT, auto, event, fakeLlm, freshDb, judgeQueue, judgeWrite, storeOf } from './writer-harness.mjs'

test('findCandidates：同身份 active 候选（规则与判定器共用同一口径）', (t) => {
  const db = freshDb(t)
  const first = processEvent(db, event('候选口径第一条'), auto())
  const second = processEvent(db, event('候选口径第二条'), auto())
  // 跨分区与已失效节点都不是候选
  processEvent(db, { ...event('别人分区的候选'), identity: { userId: 'u2', roleId: '', workspace: 'web' } }, auto())
  const stale = processEvent(db, event('候选口径第三条'), auto())
  db.prepare("UPDATE nodes SET status='superseded' WHERE id=?").run(stale.id)

  const ids = findCandidates(db, event('新事件')).map((r) => String(r.id))
  assert.deepEqual(ids.sort(), [first.id, second.id].sort())
  const row = findCandidates(db, event('新事件')).find((r) => String(r.id) === second.id)
  for (const col of ['text', 'level', 'memory_type', 'source', 'valid_at', 'invalid_at']) {
    assert.ok(col in row, `候选行缺列 ${col}（判定器提示词/保护面都靠它）`)
  }
})

test('judge=llm：候选重复 → NOOP（规则会 ADD，裁决优先）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  assert.equal(old.action, 'ADD')
  const rules = decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '基线必须是 ADD，否则证明不了裁决生效')

  const calls = []
  const logs = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP","reason":"重复事实"}',
    calls,
    log: (line) => logs.push(line),
  })
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.action, 'NOOP')
  assert.equal(result.reason, 'judge_noop')
  assert.deepEqual(result.judge, { used: true, action: 'NOOP', targetId: old.id })
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, 'NOOP 不新增节点')
  assert.equal(Number(db.prepare('SELECT hits FROM nodes WHERE id=?').get(old.id).hits), 1, 'NOOP 记命中')

  assert.equal(calls.length, 1, '有候选才调模型')
  assert.equal(calls[0].model, 'm', 'write.model 为空时用默认选择')
  assert.deepEqual(calls[0].messages[0].content[0].text.includes(old.id), false, '提示词不得暴露真实节点 id')
  assert.match(calls[0].messages[0].content[0].text, /候选记忆/)
  assert.ok(logs.some((line) => line.includes('judge used=true action=NOOP')), '成功日志口径')
  // 裁决理由落审计？reason 是 judge_noop（裁决理由只进日志/解析结果，不覆盖落库口径）
  const audit = db.prepare('SELECT action,reason FROM writes ORDER BY id DESC LIMIT 1').get()
  assert.equal(audit.action, 'NOOP')
  assert.equal(audit.reason, 'judge_noop')
})

test('judge=llm：矛盾 → SUPERSEDE（旧节点失效 + supersede 边 + evolution）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('配色偏好是深色主题'), auto())
  const rules = decideWrite(db, event('配色偏好改成浅色主题'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '规则只看到弱相似，基线是 ADD')

  const q = judgeQueue(t, db, { reply: '{"id":1,"action":"SUPERSEDE","reason":"同一偏好被新决定矛盾取代"}' })
  const result = await q.enqueue(event('配色偏好改成浅色主题'))
  assert.equal(result.action, 'SUPERSEDE')
  assert.equal(result.judge?.used, true)
  assert.equal(result.judge?.action, 'SUPERSEDE')
  assert.equal(result.judge?.targetId, old.id)

  const oldRow = db.prepare('SELECT status,superseded_by,invalid_at,expired_at FROM nodes WHERE id=?').get(old.id)
  assert.equal(oldRow.status, 'superseded')
  assert.equal(oldRow.superseded_by, result.id)
  assert.ok(Number(oldRow.invalid_at) > 0)
  assert.ok(Number(oldRow.expired_at) > 0)
  assert.equal(db.prepare("SELECT text FROM nodes WHERE id=?").get(result.id).text, '配色偏好改成浅色主题')
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM edges WHERE etype='supersede'").get().n), 1)
  const evo = db.prepare("SELECT field,old_value,new_value FROM evolution WHERE from_id=? ORDER BY id").all(old.id)
  assert.ok(evo.some((row) => row.field === 'status' && row.new_value === 'superseded'), '状态迁移留痕')
  assert.ok(evo.some((row) => row.field === 'text' && row.old_value === '配色偏好是深色主题'), '正文替换留痕')
})

test('judge=llm：补充同一事实 → MERGE（改目标正文，不新增节点）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const rules = decideWrite(db, event('回调端口 3982 只接受 POST 请求'), { mode: 'auto' })
  assert.equal(rules.action, 'ADD', '相似度不足，规则基线是 ADD')

  const q = judgeQueue(t, db, { reply: '{"id":1,"action":"MERGE","reason":"同一端口的补充说明"}' })
  const result = await q.enqueue(event('回调端口 3982 只接受 POST 请求'))
  assert.equal(result.action, 'MERGE')
  assert.equal(result.id, old.id)
  assert.equal(result.judge?.action, 'MERGE')
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM nodes').get().n), 1, 'MERGE 不新增节点')
  const row = db.prepare('SELECT text,text_hash FROM nodes WHERE id=?').get(old.id)
  assert.equal(row.text, '回调端口 3982 只接受 post 请求', 'normalize 会把英文小写（落库口径不变）')
  assert.equal(row.text_hash, contentHash('回调端口 3982 只接受 post 请求'), '正文与 hash 同步更新')
})

test('judge=llm：模型缺失/抛错/坏 JSON → 回落规则（结果与 rules 一致）', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  // 每个子用例用不同正文：回落的 ADD 会落库，复用同一正文会让后续用例命中同 hash NOOP。
  const rulesOf = (text) => decideWrite(db, event(text), { mode: 'auto' })
  const cases = [
    ['场景甲 网关回调端口是 3982', { llm: null }, 'judge_fallback:llm_unavailable', '模型缺失'],
    ['场景乙 网关回调端口是 3982', { reply: '我认为应该合并' }, 'judge_fallback:no_json', '坏 JSON'],
    ['场景丙 网关回调端口是 3982', { llm: { async *stream() { throw new Error('boom') } } }, 'judge_fallback:llm_error', '模型抛错'],
    ['场景丁 网关回调端口是 3982', { reply: '{"id":1,"action":"NOOP"}', selection: {} }, 'judge_fallback:no_model', '无可用模型'],
    ['场景戊 网关回调端口是 3982', { reply: '{"id":99,"action":"NOOP","reason":"幻觉编号"}' }, 'judge_fallback:unknown_target', '越界编号'],
  ]
  for (const [text, opts, expectedError, why] of cases) {
    const base = rulesOf(text)
    // 用例正文包含既有旧文（旧文≥8 字）→ §5.3 第 4 条会把基线判成 MERGE；这里只锁“回落与规则一致”。
    assert.ok(['ADD', 'MERGE', 'SUPERSEDE'].includes(base.action), `${why}：基线动作非法 ${base.action}`)
    const q = judgeQueue(t, db, opts)
    const result = await q.enqueue(event(text))
    assert.equal(result.action, base.action, `${why}：回落规则后动作与 rules 一致`)
    assert.equal(result.reason, base.reason, `${why}：回落规则后 reason 与 rules 一致`)
    assert.equal(result.judge?.used, false, `${why}：judge.used=false`)
    assert.equal(result.judge?.error, expectedError, `${why}：judge 错误码`)
  }
})

test('judge=llm：受保护 owner 目标 → 回落规则并记 judge_fallback:protected_target', async (t) => {
  const db = freshDb(t)
  const owner = processEvent(db, event('网关回调端口是 3982', { source: 'owner' }), auto())
  assert.equal(owner.action, 'ADD')
  assert.equal(db.prepare('SELECT source FROM nodes WHERE id=?').get(owner.id).source, 'owner')

  const logs = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP","reason":"重复"}',
    log: (line) => logs.push(line),
  })
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.judge?.used, false)
  assert.equal(result.judge?.error, 'judge_fallback:protected_target')
  // 规则口径不变：弱相似 → ADD，owner 正文一行不动
  assert.equal(result.action, 'ADD')
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(owner.id).text, '网关回调端口是 3982')
  assert.ok(logs.some((line) => line.includes('judge fallback reason=judge_fallback:protected_target')), '回落日志口径')
})

test('judge=llm：模型超时（2s AbortController）→ 回落规则，不拖死队列', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const calls = []
  const hang = {
    async *stream(opts) {
      calls.push(opts)
      // 永不产出：靠队列侧 2s 超时 abort + finish(timeout) 结束
      await new Promise((resolve) => {
        if (opts.signal?.aborted) { resolve(); return }
        opts.signal?.addEventListener('abort', () => resolve())
      })
    },
  }
  const rulesAction = decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' }).action
  const q = judgeQueue(t, db, { llm: hang })
  const started = Date.now()
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.judge?.error, 'judge_fallback:timeout')
  assert.equal(result.action, rulesAction)
  assert.ok(calls[0].signal instanceof AbortSignal, '必须把 AbortController.signal 交给模型')
  assert.ok(Date.now() - started >= 1800, '超时口径是秒级（不是立即回落）')
  assert.equal(db.prepare('SELECT status FROM nodes WHERE id=?').get(old.id).status, 'active')
})

test('judge=rules 零模型调用；judge=llm 无候选直接 ADD 也不调模型', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  let calls = 0
  const llm = { async *stream() { calls += 1; yield { type: 'text-delta', text: '{"id":1,"action":"NOOP"}' } } }
  const rulesQ = createWriteQueue({
    store: storeOf(db),
    config: auto(), // judge 缺省 = rules
    getLlm: () => llm,
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => rulesQ.dispose())
  const r = await rulesQ.enqueue(event('网关回调端口 3982'))
  assert.equal(calls, 0, 'judge=rules 时零 llm 调用')
  assert.equal(r.judge, undefined, 'rules 路径结果不带 judge 字段（旧契约不变）')
  assert.equal(r.action, 'ADD')

  // judge=llm 但库为空：无候选不花模型钱，直接按规则 ADD
  const emptyDb = freshDb(t)
  let emptyCalls = 0
  let getLlmCalls = 0
  const emptyQ = createWriteQueue({
    store: storeOf(emptyDb),
    config: judgeWrite(),
    getLlm: () => { getLlmCalls += 1; return { async *stream() { emptyCalls += 1 } } },
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => emptyQ.dispose())
  const added = await emptyQ.enqueue(event('空库里的第一条记忆'))
  assert.equal(added.action, 'ADD')
  assert.equal(emptyCalls, 0)
  assert.equal(getLlmCalls, 0)
  assert.equal(added.judge, undefined, '未调模型就没有 judge 元信息')
})

test('judge=llm：write.model 非空时作为 modelOverride', async (t) => {
  const db = freshDb(t)
  processEvent(db, event('网关回调端口是 3982'), auto())
  const calls = []
  const q = judgeQueue(t, db, {
    reply: '{"id":1,"action":"NOOP"}',
    calls,
    write: { model: 'judge-model-x' },
    selection: { provider: 'p', model: 'default-model' },
  })
  await q.enqueue(event('网关回调端口 3982'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'judge-model-x')
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].temperature, 0)
})

test('decideWrite judgeVerdict：合法裁决按既有分支执行（含影子降级）', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())

  const noop = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: old.id, action: 'NOOP' },
  })
  assert.equal(noop.action, 'NOOP')
  assert.deepEqual(noop.judge, { used: true, action: 'NOOP', targetId: old.id })

  const add = decideWrite(db, event('完全无关的第四条事实'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: null, action: 'ADD' },
  })
  assert.equal(add.action, 'ADD')
  assert.equal(add.reason, 'judge_add')
  assert.deepEqual(add.judge, { used: true, action: 'ADD', targetId: null })

  // 影子模式：裁决的动作仍按 CANDIDATE 降级，judge.action 报告语义动作（面板可解释）
  const shadow = decideWrite(db, event('回调端口 3982 只接受 POST 请求'), {
    mode: 'shadow', judgeVerdict: { ok: true, targetId: old.id, action: 'MERGE' },
  })
  assert.equal(shadow.action, 'CANDIDATE')
  assert.equal(shadow.shadowOf, 'MERGE')
  assert.equal(shadow.judge?.used, true)
  assert.equal(shadow.judge?.action, 'MERGE')
  assert.equal(shadow.beforeText, '网关回调端口是 3982')
})

test('decideWrite judgeVerdict：目标不可用/受保护/越权分区/坏裁决 → 回落规则并记 reason', (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const base = () => decideWrite(db, event('网关回调端口 3982'), { mode: 'auto' })

  const missing = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: 'n0_notthere', action: 'NOOP' },
  })
  assert.equal(missing.action, base().action)
  assert.deepEqual(missing.judge, { used: false, error: 'judge_fallback:target_unavailable' })

  const badAction = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: old.id, action: 'REVIEW' },
  })
  assert.equal(badAction.action, base().action)
  assert.equal(badAction.judge?.error, 'judge_fallback:bad_action')

  const failed = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: false, error: 'judge_fallback:timeout' },
  })
  assert.equal(failed.action, base().action)
  assert.deepEqual(failed.judge, { used: false, error: 'judge_fallback:timeout' })

  // 跨身份分区：目标在 u2，事件属于 u1 → 不可见（判定器不能越权改写别人的记忆）
  const other = processEvent(db, { ...event('别人分区的记忆'), identity: { userId: 'u2', roleId: '', workspace: 'web' } }, auto())
  const cross = decideWrite(db, event('网关回调端口 3982'), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: other.id, action: 'NOOP' },
  })
  assert.equal(cross.judge?.error, 'judge_fallback:target_unavailable')

  // 受保护 owner：判定器说 MERGE 也不许改正文，回落规则走 REVIEW(protected_merge)
  const ownerText = '生产库连接池上限设置为 200 并开启慢查询日志与连接复用'
  const owner = processEvent(db, event(ownerText, { source: 'owner' }), auto())
  const prot = decideWrite(db, event(`${ownerText}功能`), {
    mode: 'auto', judgeVerdict: { ok: true, targetId: owner.id, action: 'MERGE' },
  })
  assert.equal(prot.judge?.error, 'judge_fallback:protected_target')
  assert.equal(prot.action, 'REVIEW', '保护面由规则口径兜住')
  assert.match(prot.reason, /protected_merge/)
  assert.equal(db.prepare('SELECT text FROM nodes WHERE id=?').get(owner.id).text, ownerText)
})

test('createBackend 透传 getLlm/getSelection：直连 LocalBackend 的 judge=llm 也走判定器', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-judge-backend-'))
  const calls = []
  const backend = createBackend({ mode: 'local' }, {
    dataDir: dir,
    useWorker: false,
    log: () => {},
    config: { write: { reviewMode: 'auto', judge: 'llm', model: 'wired-model' } },
    getLlm: () => fakeLlm('{"id":1,"action":"NOOP","reason":"重复事实"}', calls),
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => backend.dispose())

  const first = await backend.write({ text: '网关回调端口是 3982', identity: IDENT, source: 'manual' })
  assert.equal(first.ok, true)
  assert.equal(first.action, 'ADD')
  const second = await backend.write({ text: '网关回调端口 3982', identity: IDENT, source: 'manual' })
  assert.equal(second.ok, true)
  assert.equal(second.action, 'NOOP', '规则会 ADD，NOOP 证明后端把模型入口透传到了队列')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'wired-model', 'write.model 经 LocalBackend 透传到判定器')
  assert.equal(Number(backend.withDb((db) => db.prepare('SELECT count(*) AS n FROM nodes').get().n)), 1)
})

test('judge Ref 解包：真实 Config 的 write.judge=llm 生效（面板开关不再是假开关）', async (t) => {
  const db = freshDb(t)
  const old = processEvent(db, event('网关回调端口是 3982'), auto())
  const cfg = Config({ write: { judge: 'llm', reviewMode: 'auto', model: 'panel-model' } })
  assert.equal(cfg.write.judge.get(), 'llm', 'schema 里 judge 是 volatile Ref，必须解包后生效')
  const calls = []
  const q = createWriteQueue({
    store: storeOf(db),
    config: cfg,
    getLlm: () => fakeLlm('{"id":1,"action":"NOOP","reason":"重复"}', calls),
    getSelection: () => ({ provider: 'p', model: 'm' }),
  })
  t.after(() => q.dispose())
  const result = await q.enqueue(event('网关回调端口 3982'))
  assert.equal(result.action, 'NOOP', 'Ref 未解包时开关恒假，会回落规则 ADD')
  assert.equal(result.judge?.targetId, old.id)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'panel-model')
})
