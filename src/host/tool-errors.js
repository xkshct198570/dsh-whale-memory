// 职责：模型记忆工具的稳定错误码与 HarnessError 构造（文案中文；绝不携带记忆正文/查询原文）。
// 依赖方向：只 import @deepseek-ai/dsh-error（与宿主同一类的基类）；被 host/tools.js 与测试引用；不 import 路由/DB。

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * 工具失败码（模型/策略按码路由，不解析文案）。
 *
 * 为什么固定成一张表：tool 失败必须让调用方知道"不是成功"（铁律 22），
 * 而流水线只把 `HarnessError.code` 透出为 `ToolErrorInfo.code`；
 * 各工具各自 new 错误会让码随实现漂移。
 */
export const TOOL_ERROR = Object.freeze({
  IDENTITY_REQUIRED: 'IDENTITY_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_MEMORY: 'NOT_MEMORY',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  NODE_CHANGED: 'NODE_CHANGED',
  DUPLICATE_ACTIVE: 'DUPLICATE_ACTIVE',
  PROTECTED_TARGET: 'PROTECTED_TARGET',
  WRITE_DISABLED: 'WRITE_DISABLED',
  WRITE_REJECTED: 'WRITE_REJECTED',
  WRITE_FAILED: 'WRITE_FAILED',
  BACKEND_FAILED: 'BACKEND_FAILED',
  SUBAGENT_FORBIDDEN: 'SUBAGENT_FORBIDDEN',
})

/** 稳定码 → 模型可读文案（不含任何记忆正文）。 */
const MESSAGES = Object.freeze({
  [TOOL_ERROR.IDENTITY_REQUIRED]: '当前会话没有可用的记忆身份（缺少会话工作目录），无法确定记忆分区。',
  [TOOL_ERROR.RATE_LIMITED]: '本轮记忆写入尝试次数已达上限。',
  [TOOL_ERROR.INVALID_ARGS]: '参数不合法。',
  [TOOL_ERROR.NOT_MEMORY]: '该内容不属于长期记忆（任务指令或一次性状态），未写入。',
  [TOOL_ERROR.NODE_NOT_FOUND]: '记忆节点不存在，或不在当前会话的身份分区内。',
  [TOOL_ERROR.NODE_CHANGED]: '记忆节点已被其他写入修改；先 memory_read 取最新 updatedAt 再重试。',
  [TOOL_ERROR.DUPLICATE_ACTIVE]: '修改后的正文与另一条活跃记忆重复；先合并或归档冲突项。',
  [TOOL_ERROR.PROTECTED_TARGET]: '该记忆受保护（owner 来源 / core 等级 / procedural 类型），模型工具不能修改或归档。',
  [TOOL_ERROR.WRITE_DISABLED]: '记忆写入已关闭（write.enabled=false）。',
  [TOOL_ERROR.WRITE_REJECTED]: '写入被拒绝。',
  [TOOL_ERROR.WRITE_FAILED]: '记忆写入失败。',
  [TOOL_ERROR.BACKEND_FAILED]: '记忆后端调用失败（读/写不可用）。',
  [TOOL_ERROR.SUBAGENT_FORBIDDEN]: '子代理会话不能使用记忆工具；请回到主会话操作记忆。',
})

/**
 * 构造一个工具失败（HarnessError 同一类，code 稳定）。
 *
 * @param {string} code `TOOL_ERROR` 中的码
 * @param {string} [detail] 极短的可判定细节（分类码/参数名，禁止正文）
 * @param {ErrorOptions} [options] 保留 cause 链
 * @returns {HarnessError}
 */
export function toolError(code, detail = '', options = undefined) {
  const base = MESSAGES[code] || MESSAGES[TOOL_ERROR.WRITE_FAILED]
  const suffix = String(detail || '').trim()
  return new HarnessError(suffix ? `${base}（${suffix}）` : base, code, options)
}
