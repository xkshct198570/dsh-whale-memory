// 职责：模型侧记忆工具面（memory_remember/search/read/update/forget）——五工具定义、身份闸、每回合写限次接线、
// 注册/卸载。输出契约在 tool-output.js，错误码在 tool-errors.js，限次在 tool-rate-limit.js。
// 依赖方向：host → core 门面（backend.* + writer.isProtectedTarget）；身份只走 identity.js；
// 不 import 路由/DB/规则仓，不复制价值闸判据（由 backend.write 的 __ingest 统一应用）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { deriveWorkspace, resolveIdentity } from './identity.js'
import { value } from '../shared/config-values.js'
import { ingestPolicyOf } from '../shared/ingest-policy.js'
import { normalizeTags } from '../shared/tags.js'
import { isProtectedTarget } from '../core/writer.js'
import { createWriteRateLimiter } from './tool-rate-limit.js'
import { TOOL_ERROR, toolError } from './tool-errors.js'
import {
  LEVELS, MEMORY_TYPES, TAGS_LIMIT, TOOL_OUTPUT, num, projectNode, round4,
} from './tool-output.js'

/** 子代理会话判据（origin 或持久化的 delegationDepth；两条都认，避免 header 变体漏判）。 */
function isDelegatedHeader(header) {
  return header?.origin === 'subagent' || Number(header?.delegationDepth) > 0
}

/** 写类工具（受每回合限次）；读工具不限次。 */
export const WRITE_TOOL_NAMES = Object.freeze(['memory_remember', 'memory_update', 'memory_forget'])

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const TEXT_LIMIT = 500
const REASON_LIMIT = 200

/**
 * 一个工具集合的运行时上下文（身份/限次/策略只在这一处取值）。
 * @param {{ backend: any, config: any, getIdentityCfg: () => any, getIdentityHint: () => any,
 *   getHostUserId: () => string, limiter: ReturnType<typeof createWriteRateLimiter> }} deps
 */
function makeContext(deps) {
  const { backend, config, getIdentityCfg, getIdentityHint, getHostUserId, limiter, log = () => {} } = deps

  const maxWrites = () => {
    const raw = num(value(config?.tools?.maxWritesPerTurn), DEFAULT_LIMIT)
    return Math.max(1, Math.min(50, Math.trunc(raw)))
  }

  /**
   * 当前会话身份（工具只接受会话身份，不接受任何跨分区参数）。
   * 为什么先查会话 cwd：resolveIdentity 在 auto 模式恒 ok；cfg.identity.workspace 非空时
   * 缺 cwd 会回落成 config 分区（'web'），等于把不同工作区混成一个分区。
   */
  const identityOf = (exec) => {
    const header = exec?.agent?.session?.header
    // 执行期兜底（2026-11-27 live 实测：子代理的工具集仍含 memory_* 且可执行，
    // 说明 step 准入的 when 在真实宿主里不够；这里对同一判据再拦一次，绝不静默放行）。
    if (isDelegatedHeader(header)) throw toolError(TOOL_ERROR.SUBAGENT_FORBIDDEN)
    const sessionWorkspace = header ? deriveWorkspace(header) : ''
    if (!header || !sessionWorkspace) throw toolError(TOOL_ERROR.IDENTITY_REQUIRED)
    const resolved = resolveIdentity(getIdentityCfg(), getIdentityHint(), getHostUserId(), sessionWorkspace)
    if (!resolved?.ok || !resolved.identity.userId || !resolved.identity.workspace) {
      throw toolError(TOOL_ERROR.IDENTITY_REQUIRED)
    }
    return resolved.identity
  }

  /** 写工具入口：先过限次再进写路径；超限抛 RATE_LIMITED（文案带本次计数）。 */
  const beforeWrite = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const result = limiter.attempt(String(sessionId ?? ''), maxWrites())
    if (!result.allowed) throw toolError(TOOL_ERROR.RATE_LIMITED, `${result.count}/${result.max}`)
  }

  /** 与收尾同一 ingestPolicy（缺省/映射的唯一真源在 shared/ingest-policy.js）；工具置信度固定 1.0。 */
  const ingestPolicy = () => ingestPolicyOf(value(config?.wrap?.ingest), { confidence: 1 })

  /**
   * 后端调用包装：任何非预期异常都收敛成 HarnessError（带短标签，不携带正文），
   * 避免 TypeError/后端已释放之类的原始错误绕过工具失败码。
   */
  const call = async (label, fn) => {
    try { return await fn() } catch (err) {
      throw toolError(TOOL_ERROR.BACKEND_FAILED, label, { cause: err })
    }
  }

  /** 同身份读节点：只有明确的 node_not_found 映射 NODE_NOT_FOUND，其它失败不伪装成“不存在”。 */
  const readNode = async (identity, id) => {
    const res = await call('getNode', () => backend.getNode(id, { identity }))
    if (res?.ok) return res
    const code = String(res?.error || 'backend_failed')
    if (code === 'node_not_found') throw toolError(TOOL_ERROR.NODE_NOT_FOUND)
    throw toolError(TOOL_ERROR.BACKEND_FAILED, code)
  }

  return { backend, identityOf, beforeWrite, ingestPolicy, call, readNode, log }
}

/** backend.write 失败 → 稳定工具错误码（gate 分类码不含正文，可以进文案）。 */
function writeFailure(res) {
  const code = String(res?.error || res?.reason || 'write_rejected')
  if (code === 'identity_required') return toolError(TOOL_ERROR.IDENTITY_REQUIRED)
  if (code === 'write_disabled') return toolError(TOOL_ERROR.WRITE_DISABLED)
  if (code === 'invalid_text' || code === 'text_too_long') return toolError(TOOL_ERROR.INVALID_ARGS, code)
  if (code.startsWith('gate:stale') || code.startsWith('gate:task')) return toolError(TOOL_ERROR.NOT_MEMORY, code)
  return toolError(TOOL_ERROR.WRITE_REJECTED, code)
}

/** backend.updateNode 失败 → 稳定工具错误码。 */
function updateFailure(error) {
  const code = String(error || 'write_failed')
  if (code === 'node_not_found') return toolError(TOOL_ERROR.NODE_NOT_FOUND)
  if (code === 'node_changed') return toolError(TOOL_ERROR.NODE_CHANGED)
  if (code === 'protected_target') return toolError(TOOL_ERROR.PROTECTED_TARGET)
  if (code === 'duplicate_active') return toolError(TOOL_ERROR.DUPLICATE_ACTIVE)
  if (code === 'invalid_text' || code === 'invalid_level' || code === 'invalid_status') return toolError(TOOL_ERROR.INVALID_ARGS, code)
  return toolError(TOOL_ERROR.WRITE_FAILED, code)
}

/**
 * 五工具定义（纯装配：不注册、不监听；便于测试直接执行并校验 output schema）。
 *
 * @param {{ backend: any, config: any, getIdentityCfg: () => any, getIdentityHint: () => any,
 *   getHostUserId: () => string, limiter: ReturnType<typeof createWriteRateLimiter> }} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]}
 */
export function createMemoryToolDefinitions(deps) {
  const c = makeContext(deps)

  const remember = defineTool({
    name: 'memory_remember',
    description: '把一条值得长期保留的记忆写入当前会话的记忆库。只用于长期有效的规则/事实/偏好/教训；'
      + '任务指令、一次性状态（版本号/PID/计数/“现在如何”）会被价值闸拒绝（NOT_MEMORY）；'
      + '歧义或受保护目标转人工审核（CANDIDATE，本次不落库）。身份固定为当前会话，不能指定分区。',
    parameters: {
      text: { type: 'string', required: true, description: `记忆正文，1..${TEXT_LIMIT} 字；写事实本身，不写“记得”。` },
      level: { type: 'string', enum: LEVELS, description: '重要度：core（核心，慎用）/ important / normal（默认）。' },
      memory_type: { type: 'string', enum: MEMORY_TYPES, description: '类型：semantic（默认）/ procedural / episodic / mixed。' },
      tags: { type: 'array', items: { type: 'string' }, description: `标签（可选，≤${TAGS_LIMIT} 个）。` },
    },
    output: TOOL_OUTPUT.remember,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const text = String(args.text ?? '').trim()
      if (!text) throw toolError(TOOL_ERROR.INVALID_ARGS, 'text 为空')
      if (text.length > TEXT_LIMIT) throw toolError(TOOL_ERROR.INVALID_ARGS, `text>${TEXT_LIMIT}`)
      if (Array.isArray(args.tags) && args.tags.length > TAGS_LIMIT) {
        throw toolError(TOOL_ERROR.INVALID_ARGS, `tags>${TAGS_LIMIT}`)
      }
      const identity = c.identityOf(exec)
      c.beforeWrite(exec)
      const res = await c.call('write', () => c.backend.write({
        text,
        level: args.level,
        memory_type: args.memory_type,
        tags: normalizeTags(args.tags).slice(0, TAGS_LIMIT),
        source: 'tool',
        origin: 'tool',
        identity,
        ingestPolicy: c.ingestPolicy(),
      }))
      if (!res?.ok) throw writeFailure(res)
      return {
        ok: true,
        action: String(res.action || ''),
        id: res.id ? String(res.id) : null,
        reason: String(res.reason || ''),
      }
    },
  })

  const search = defineTool({
    name: 'memory_search',
    description: '在当前会话的记忆分区内检索长期记忆（FTS + 一跳扩散）。只返回当前身份可见的节点；跨分区内容不可见。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（自然语言片段即可）。' },
      limit: { type: 'integer', description: `返回条数 1..${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}。` },
    },
    output: TOOL_OUTPUT.search,
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (!query) throw toolError(TOOL_ERROR.INVALID_ARGS, 'query 为空')
      const identity = c.identityOf(exec)
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(num(args.limit, DEFAULT_LIMIT))))
      const res = await c.call('search', () => c.backend.search({ query, limit, identity }))
      if (!res || !Array.isArray(res.hits)) throw toolError(TOOL_ERROR.BACKEND_FAILED, 'search_empty_result')
      const hits = res.hits.slice(0, limit).map((hit) => ({
        id: String(hit.id),
        text: String(hit.text ?? ''),
        level: String(hit.level ?? 'normal'),
        memory_type: String(hit.type ?? hit.memory_type ?? 'semantic'),
        score: round4(hit.score),
      }))
      return { ok: true, hits }
    },
  })

  const read = defineTool({
    name: 'memory_read',
    description: '按 id 读取一条记忆的详情与一跳邻居边。id 不属于当前会话分区时按“不存在”处理（NODE_NOT_FOUND）。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆节点 id（memory_search 返回的 id）。' },
    },
    output: TOOL_OUTPUT.read,
    async execute(args, exec) {
      const id = String(args.id ?? '').trim()
      if (!id) throw toolError(TOOL_ERROR.INVALID_ARGS, 'id 为空')
      const identity = c.identityOf(exec)
      const res = await c.readNode(identity, id)
      return {
        ok: true,
        node: projectNode(res.node),
        edges: (res.edges || []).map((edge) => ({
          id: num(edge.id, 0),
          from: String(edge.from_id ?? ''),
          to: String(edge.to_id ?? ''),
          etype: String(edge.etype ?? ''),
          conf: num(edge.conf, 0),
        })),
      }
    },
  })

  const update = defineTool({
    name: 'memory_update',
    description: '修改一条记忆的正文/等级/标签（至少给一项）。受保护记忆（owner/core/procedural）不可改（PROTECTED_TARGET）；'
      + '并发编辑用 expectedUpdatedAt 做 CAS，期间被改过返回 NODE_CHANGED。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆节点 id。' },
      text: { type: 'string', description: `新正文，1..${TEXT_LIMIT} 字。` },
      level: { type: 'string', enum: LEVELS, description: '新等级。' },
      tags: { type: 'array', items: { type: 'string' }, description: `新标签集合（整体替换，≤${TAGS_LIMIT} 个）。` },
      expectedUpdatedAt: { type: 'number', description: 'CAS 基线：memory_read 返回的 updatedAt；不一致则拒绝。' },
    },
    output: TOOL_OUTPUT.update,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = String(args.id ?? '').trim()
      if (!id) throw toolError(TOOL_ERROR.INVALID_ARGS, 'id 为空')
      const patch = {}
      if (args.text !== undefined) {
        const text = String(args.text ?? '').trim()
        if (!text) throw toolError(TOOL_ERROR.INVALID_ARGS, 'text 为空')
        if (text.length > TEXT_LIMIT) throw toolError(TOOL_ERROR.INVALID_ARGS, `text>${TEXT_LIMIT}`)
        patch.text = text
      }
      if (args.level !== undefined) patch.level = String(args.level)
      if (args.tags !== undefined) {
        if (Array.isArray(args.tags) && args.tags.length > TAGS_LIMIT) {
          throw toolError(TOOL_ERROR.INVALID_ARGS, `tags>${TAGS_LIMIT}`)
        }
        patch.tags = normalizeTags(args.tags)
      }
      if (Object.keys(patch).length === 0) throw toolError(TOOL_ERROR.INVALID_ARGS, '无变更字段')
      const identity = c.identityOf(exec)
      const current = await c.readNode(identity, id)
      if (isProtectedTarget(current.node, { protect: true })) throw toolError(TOOL_ERROR.PROTECTED_TARGET)
      c.beforeWrite(exec)
      const res = await c.call('updateNode', () => c.backend.updateNode(id, patch, {
        identity, expectedUpdatedAt: args.expectedUpdatedAt, origin: 'tool',
      }))
      if (!res?.ok) throw updateFailure(res.error)
      return { ok: true, id: String(res.id || id), updatedAt: num(res.updated_at, 0) }
    },
  })

  const forget = defineTool({
    name: 'memory_forget',
    description: '归档一条记忆（只改状态为 archived，不物理删除，可审计可回溯）。受保护记忆不可归档（PROTECTED_TARGET）。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆节点 id。' },
      reason: { type: 'string', required: true, description: `归档原因，1..${REASON_LIMIT} 字（写进审计行）。` },
    },
    output: TOOL_OUTPUT.forget,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = String(args.id ?? '').trim()
      if (!id) throw toolError(TOOL_ERROR.INVALID_ARGS, 'id 为空')
      const reason = String(args.reason ?? '').trim()
      if (!reason) throw toolError(TOOL_ERROR.INVALID_ARGS, 'reason 为空')
      if (reason.length > REASON_LIMIT) throw toolError(TOOL_ERROR.INVALID_ARGS, `reason>${REASON_LIMIT}`)
      const identity = c.identityOf(exec)
      const current = await c.readNode(identity, id)
      if (isProtectedTarget(current.node, { protect: true })) throw toolError(TOOL_ERROR.PROTECTED_TARGET)
      if (String(current.node.status || '') === 'archived') {
        // 幂等：已归档不再发 UPDATE/审计；留一行证据（无正文），不把“没做什么”伪装成成功写入。
        c.log(`[whale-memory] memory_forget noop id=${id} (already archived)`)
        return { ok: true, id, status: 'archived' }
      }
      c.beforeWrite(exec)
      const res = await c.call('updateNode', () => c.backend.updateNode(id, { status: 'archived' }, {
        identity, origin: 'tool', reason,
      }))
      if (!res?.ok) throw updateFailure(res.error)
      return { ok: true, id, status: 'archived' }
    },
  })

  return [remember, search, read, update, forget]
}

/**
 * 安装工具面：注册五工具 + 每回合写限次监听；返回与宿主生命周期同源的 dispose。
 *
 * `when` 同时表达两件事（step 级生效，改配置即时生效）：
 * - `tools.enabled=false` → 不出现在工具集；
 * - 子代理会话（header.origin==='subagent'）→ 不出现在工具集（子代理没有可裁定的 owner，与召回/收尾同口径）。
 *
 * @param {{ ctx: any, backend: any, config: any, getIdentityCfg: () => any, getIdentityHint: () => any,
 *   getHostUserId: () => string, log?: (line: string) => void }} args
 * @returns {{ dispose: () => void, definitions: Array<object> }}
 */
export function installMemoryTools({ ctx, backend, config, getIdentityCfg, getIdentityHint, getHostUserId, log = () => {} }) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  if (!registry || typeof registry.register !== 'function') {
    // 直接 apply 的测试/嵌入场景可达；inject 生效的宿主里由 cordis 保证 tools 已就位。
    log('[whale-memory] tools service unavailable: model memory tools not registered')
    return { dispose() {}, definitions: [] }
  }
  // 能力闸：http 远端协议只有 write/search/recall，没有同身份 getNode/updateNode；
  // 没有读改能力的后端不能开工具面（否则 read 会抛 TypeError、write 的远端 action 词表还会破坏输出 schema）。
  const missing = ['write', 'search', 'getNode', 'updateNode'].filter((name) => typeof backend?.[name] !== 'function')
  if (missing.length > 0) {
    log(`[whale-memory] backend mode=${String(backend?.mode || 'custom')} lacks ${missing.join(',')}: model memory tools not registered`)
    return { dispose() {}, definitions: [] }
  }
  const limiter = createWriteRateLimiter({ ctx, log })
  const definitions = createMemoryToolDefinitions({
    backend, config, getIdentityCfg, getIdentityHint, getHostUserId, limiter, log,
  })
  const traced = new Set()
  const when = (context) => {
    const header = context?.agent?.session?.header
    const sessionId = String(context?.agent?.session?.id || '')
    if (sessionId && !traced.has(sessionId)) {
      traced.add(sessionId)
      log(`[whale-memory] tools.when session=${sessionId} origin=${header?.origin ?? '-'} depth=${header?.delegationDepth ?? '-'} parent=${header?.parentSession ? 'y' : 'n'} enabled=${String(value(config?.tools?.enabled))}`)
    }
    if (value(config?.tools?.enabled) === false) return false
    return !isDelegatedHeader(header)
  }
  const offs = []
  try {
    for (const definition of definitions) offs.push(registry.register(definition, { when }))
  } catch (err) {
    for (const off of offs) { try { off() } catch { /* 安装回滚：逐个释放已注册工具 */ } }
    limiter.dispose()
    throw err
  }
  let disposed = false
  return {
    definitions,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs) { try { off() } catch { /* 宿主卸载中：忽略 */ } }
      limiter.dispose()
    },
  }
}
