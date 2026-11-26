// 职责：模型记忆工具的输出契约——五工具的 output schema、text render、节点/边投影（纯投影，无 IO）。
// 依赖方向：只 import shared/tags.js；被 host/tools.js 与测试引用；不 import core/host 其它模块。

import { parseTags } from '../shared/tags.js'

/** 成功动作全集（与 writer 落库 action 同一词表；不在这里发明第二种叫法）。 */
export const ACTIONS = ['ADD', 'MERGE', 'SUPERSEDE', 'NOOP', 'CANDIDATE']
export const LEVELS = ['core', 'important', 'normal']
export const MEMORY_TYPES = ['semantic', 'procedural', 'episodic', 'mixed']
export const TAGS_LIMIT = 32

/** 模型可见文本块（render 唯一出口）。 */
export const textResult = (text) => [{ type: 'text', text: String(text) }]
/** 数字归一（schema 里 number 字段必须是有限数，null/坏值回落）。 */
export const num = (raw, fallback = 0) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback)
/** 检索分保留 4 位：模型只需要可比序，不需要浮点噪声。 */
export const round4 = (raw) => Math.round(num(raw, 0) * 10000) / 10000

/** 模型可读的节点投影：不含 text_hash/向量态/审计 origin/trace 等内部列。 */
export const NODE_OUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    text: { type: 'string', required: true },
    level: { type: 'string', required: true, enum: LEVELS },
    memory_type: { type: 'string', required: true, enum: MEMORY_TYPES },
    source: { type: 'string', required: true },
    status: { type: 'string', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    pinned: { type: 'integer', required: true },
    weight: { type: 'number', required: true },
    hits: { type: 'integer', required: true },
    created_at: { type: 'number', required: true },
    updated_at: { type: 'number', required: true },
    valid_at: { type: 'number', required: true },
    expired_at: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    superseded_by: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
}

export const EDGE_OUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    etype: { type: 'string', required: true },
    conf: { type: 'number', required: true },
  },
}

/** 节点投影（唯一一份；memory_read 用）。 */
export function projectNode(row) {
  return {
    id: String(row.id),
    text: String(row.text ?? ''),
    level: String(row.level ?? 'normal'),
    memory_type: String(row.memory_type ?? 'semantic'),
    source: String(row.source ?? ''),
    status: String(row.status ?? ''),
    tags: parseTags(row.tags),
    pinned: num(row.pinned, 0),
    weight: num(row.weight, 1),
    hits: num(row.hits, 0),
    created_at: num(row.created_at, 0),
    updated_at: num(row.updated_at, 0),
    valid_at: num(row.valid_at, 0),
    expired_at: row.expired_at === null || row.expired_at === undefined ? null : num(row.expired_at, 0),
    superseded_by: row.superseded_by === null || row.superseded_by === undefined || row.superseded_by === ''
      ? null
      : String(row.superseded_by),
  }
}

/** 五工具的输出契约（schema 与 render 必须在同一处定义，值形状才不会两处漂移）。 */
export const TOOL_OUTPUT = Object.freeze({
  remember: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        action: { type: 'string', required: true, enum: ACTIONS },
        id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        reason: { type: 'string', required: true },
      },
    },
    render: (_args, out) => textResult(out.action === 'CANDIDATE'
      ? `已转人工审核（CANDIDATE，本次未落库）；原因：${out.reason || '-'}`
      : `记忆已写入（${out.action}）节点 ${out.id}`),
  },
  search: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        hits: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              text: { type: 'string', required: true },
              level: { type: 'string', required: true, enum: LEVELS },
              memory_type: { type: 'string', required: true, enum: MEMORY_TYPES },
              score: { type: 'number', required: true },
            },
          },
        },
      },
    },
    render: (_args, out) => textResult(out.hits.length
      ? out.hits.map((hit, index) => `${index + 1}. id=${hit.id} level=${hit.level} type=${hit.memory_type} score=${hit.score}\n${hit.text}`).join('\n\n')
      : '未命中记忆。'),
  },
  read: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        node: NODE_OUT,
        edges: { type: 'array', items: EDGE_OUT },
      },
    },
    render: (_args, out) => {
      const node = out.node
      const tags = node.tags.length ? node.tags.join('、') : '-'
      const edges = out.edges.length
        ? `\n邻居边：${out.edges.map((edge) => `${edge.from}→${edge.to} (${edge.etype})`).join('；')}`
        : ''
      return textResult(`id=${node.id} status=${node.status} level=${node.level} type=${node.memory_type}\n${node.text}\n标签：${tags}${edges}`)
    },
  },
  update: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        id: { type: 'string', required: true },
        updatedAt: { type: 'number', required: true },
      },
    },
    render: (_args, out) => textResult(`已更新节点 ${out.id}（updatedAt=${out.updatedAt}）。`),
  },
  forget: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', const: true, required: true },
        id: { type: 'string', required: true },
        status: { type: 'string', required: true, const: 'archived' },
      },
    },
    render: (_args, out) => textResult(`已归档节点 ${out.id}（status=archived，未物理删除）。`),
  },
})
