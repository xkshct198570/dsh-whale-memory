// 职责：workers 域门面——只 re-export worker 客户端；跨域引用一律走本文件（架构书 §5.4）。
export { DbWorkerClient } from './client.js'
