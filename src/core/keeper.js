/**
 * keeper 门面：对外 import 路径保持 `src/core/keeper.js` 不变，只 re-export。
 *
 * P2b 拆分：调度状态机/装配在 ./keeper/scheduler.js；默认 handlers 在 ./keeper/handlers.js；
 * 通用小工具在 ./keeper/util.js（私有）。门面不承载业务分支。
 */
export {
  JOB_KINDS,
  KEEPER_RESERVED_KINDS,
  backoffSeconds,
  createKeeper,
  recoverRunningJobs,
  installKeeper,
} from './keeper/scheduler.js'
export { convergeDuplicateHashes, buildTopicEdges, archiveScope } from './keeper/handlers.js'
