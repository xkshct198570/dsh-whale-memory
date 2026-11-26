/**
 * 门面：写入决策/落库/审计/队列公开 API 唯一出口；只 re-export，不承载业务分支。
 *
 * 依赖方向（单向，无环）：review/queue → decide/audit/process → privacy；
 * 门面 → 6 个子模块；本文件不认识路由/模型编排。
 */
import { privacyCheck } from './writer/privacy.js'
import {
  slotsOf, contradiction, timeOverlap, findCandidates, decideWrite, isProtectedTarget,
} from './writer/decide.js'
import {
  isActiveHashConflict, withTx, recordWrite, recordEvolution, writePayload,
} from './writer/audit.js'
import { processEvent } from './writer/process.js'
import { createWriteQueue } from './writer/queue.js'

// 公开符号原样再导出：路径与导出名保持不变，调用方无需改动。
export {
  privacyCheck,
  slotsOf, contradiction, timeOverlap, findCandidates, decideWrite,
  isProtectedTarget, isActiveHashConflict, withTx, recordWrite, recordEvolution, writePayload,
  processEvent, createWriteQueue,
}
