#!/usr/bin/env node
/**
 * S2 收尾压测：600+ 节点、200 次随机查询、worker p50/p99、worker 崩溃重建。
 * 用法：node scripts/stress.mjs [--nodes=600] [--queries=200]
 * 只写临时目录，不碰 ~/.dsh。
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../src/core/db.js'
import { bigrams, contentHash } from '../src/core/tokenize.js'
import { DbWorkerClient } from '../src/core/workers/client.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const N = Number(args.nodes || 600)
const Q = Number(args.queries || 200)
const dir = mkdtempSync(join(tmpdir(), 'whale-stress-'))
const db = openDb(dir)
const ts = Date.now() / 1000
const insert = db.prepare(`INSERT INTO nodes
  (id,text,text_hash,text_bigrams,level,memory_type,source,status,role_id,user_id,workspace,tags,
   context_note,weight,hits,vector_state,origin,trace_id,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?, 'active','','u1','web','[]','',1,0,'none','stress','',?,?)`)
const topics = ['网关端口', '记忆中枢', 'worker 线程', '导入导出', 'WSL 断网', '群主转让', '记忆反思', '备份恢复', '插件市场', '配置开关']
const idents = ['gateway.py', 'whale.db', '3982', 'rdclientax.dll', 'resolv.conf', '8.8.8.8']
db.exec('BEGIN IMMEDIATE')
for (let i = 0; i < N; i += 1) {
  const text = `${topics[i % topics.length]} 规则 ${i}｜${idents[i % idents.length]}｜中文检索样本 ${i % 37}`
  insert.run(`n${i}_${contentHash(text).slice(0, 8)}`, text, contentHash(text), bigrams(text), i % 10 === 0 ? 'core' : 'normal', 'semantic', i % 3 === 0 ? 'owner' : 'self', ts, ts)
}
db.exec('COMMIT')
const nodeCount = db.prepare('SELECT count(*) AS n FROM nodes').get().n
closeDb(db)
console.log(`[stress] nodes=${nodeCount} dir=${dir}`)

const client = new DbWorkerClient({ timeoutMs: 1200 })
const times = []
let failures = 0
for (let i = 0; i < Q; i += 1) {
  const q = i % 4 === 0 ? `${topics[i % topics.length]} ${idents[i % idents.length]}` : `${topics[i % topics.length]} ${i % 37}`
  const t0 = performance.now()
  try {
    const r = await client.search({ dbPath: join(dir, 'memory.db'), query: q, limit: 8, identity: { userId: 'u1', roleId: '', workspace: 'web' } })
    if (!r || !Array.isArray(r.hits)) failures += 1
  } catch { failures += 1 }
  times.push(performance.now() - t0)
}
times.sort((a, b) => a - b)
const p = (x) => times[Math.min(times.length - 1, Math.floor(times.length * x))]
const p50 = p(0.5); const p99 = p(0.99); const max = times[times.length - 1]
console.log(`[stress] queries=${Q} p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms failures=${failures}`)

// 崩溃重建：强行 terminate 正在跑的 worker，随后主线程必须能继续查（不抛未捕获异常）。
let crashOk = false
try {
  const active = client._worker
  if (active) await active.terminate()
  const r = await client.search({ dbPath: join(dir, 'memory.db'), query: '网关端口', limit: 3, identity: { userId: 'u1', roleId: '', workspace: 'web' } })
  crashOk = Boolean(r && Array.isArray(r.hits))
} catch (err) {
  console.log(`[stress] crash-probe error: ${err?.code || err?.message || err}`)
}
console.log(`[stress] worker-crash-rebuild=${crashOk}`)
client.dispose()

// 异步导入：600 行分片，统计导入期间主线程事件循环 tick（>0 即未卡死）。
process.env.DSH_HOME = dir
const { LocalBackend } = await import('../src/core/backend.js')
const backend = new LocalBackend({ dataDir: join(dir, 'import-home'), useWorker: false })
const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ text: `导入样本 ${i}｜batch`, user_id: 'u1' })).join('\n')
let ticks = 0
const timer = setInterval(() => { ticks += 1 }, 1)
const started = await backend.startImport({ jsonl: lines, identity: { userId: 'u1', roleId: '', workspace: 'web' } })
let st
for (let i = 0; i < 200; i += 1) {
  st = await backend.importStatus(started.jobId)
  if (st.job?.state === 'done') break
  await new Promise((r) => setTimeout(r, 10))
}
clearInterval(timer)
backend.dispose()
console.log(`[stress] import600 ticks=${ticks} state=${st?.job?.state} added=${st?.job?.added}`)
const importOk = st?.job?.state === 'done' && st?.job?.added === 600 && ticks > 0

const ok = failures === 0 && p99 < 1200 && crashOk && importOk
if (!ok) { console.error('[stress] FAIL'); process.exitCode = 1 } else { console.log('[stress] PASS') }
