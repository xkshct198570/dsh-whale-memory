// 写入决策单测共享夹具（临时库/事件/队列/判定器）；被 writer-*.test.mjs 单向依赖，不 import 测试文件。
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, closeDb } from '../../src/core/db.js'
import { createWriteQueue } from '../../src/core/writer.js'

export const IDENT = { userId: 'u1', roleId: '', workspace: 'web' }

/** 临时库：每个用例独立目录，结束时关闭。 */
export function freshDb(t) {
  const db = openDb(mkdtempSync(join(tmpdir(), 'whale-writer-')))
  t.after(() => closeDb(db))
  return db
}

/** 造事件（缺省值对齐真实写入入口）。 */
export function event(text, extra = {}) {
  return {
    traceId: 'tr-1',
    source: 'chat',
    identity: IDENT,
    text,
    tags: [],
    at: 0,
    candidateType: 'fact',
    origin: 'unit',
    level: 'normal',
    memory_type: 'semantic',
    ...extra,
  }
}

/** auto 模式配置（可覆盖 write 段）。 */
export function auto(write = {}) {
  return { write: { reviewMode: 'auto', ...write } }
}

/** 内存 store：队列只需要 withDb 同步入口。 */
export function storeOf(db) {
  return { withDb: (fn) => fn(db) }
}

/** 判定器配置（auto 模式；judge=llm 由配置驱动，队列按 liveConfig 读取）。 */
export function judgeWrite(write = {}) {
  return { write: { reviewMode: 'auto', judge: 'llm', ...write } }
}

/** fake llm：记录调用参数，逐字 yield 模型原文（解析失败/超时由后续用例覆盖）。 */
export function fakeLlm(reply, calls) {
  return {
    async *stream(opts) {
      calls?.push(opts)
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** 判定器队列：llm/selection 由用例注入；缺省 llm 用 fakeLlm(reply)。 */
export function judgeQueue(t, db, { reply = '', calls = [], write = {}, llm, selection = { provider: 'p', model: 'm' }, log } = {}) {
  const q = createWriteQueue({
    store: storeOf(db),
    config: judgeWrite(write),
    getLlm: () => (llm === undefined ? fakeLlm(reply, calls) : llm),
    getSelection: () => selection,
    log,
  })
  t.after(() => q.dispose())
  return q
}
