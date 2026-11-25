/**
 * 门面：只 re-export，不承载业务分支（架构书 §5.4）。
 *
 * 实现：本地底座/装配 `backend/local-db.js`，读 API `backend/query-api.js`，写 API `backend/write-api.js`，
 * 导入导出 `backend/transfer.js`，共同底座 `backend/base.js`，远端桥/工厂 `backend/hybrid-bridge.js`。
 */
export { LocalBackend } from './backend/local-db.js'
export { HttpBackend, WHALE_PROTOCOL, createBackend } from './backend/hybrid-bridge.js'
