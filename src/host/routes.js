/**
 * Host 路由门面：对外 import 路径保持 `src/host/routes.js` 不变，只 re-export。
 *
 * P2d 拆分：装配/安全闸/分发在 ./routes/router.js；端点组在 ./routes/*.js；
 * 配置工具在 ./routes/config-util.js；前缀与通用视图在 ./routes/{prefix,common}.js。
 * 门面不承载端点分支。
 */
export { createRoutes } from './routes/router.js'
export { PREFIX } from './routes/prefix.js'
export {
  CONFIG_GROUPS,
  CONFIG_KEYS,
  deepMergeLeaf,
  echoConfig,
} from './routes/config-util.js'
export { traceIdOf } from './routes/common.js'
