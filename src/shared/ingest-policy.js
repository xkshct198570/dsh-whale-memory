// 职责：写入价值闸/歧义闸的纯判据（持久性分类、歧义原因）+ ingestPolicy 缺省/映射（单一真源）。
// 依赖方向：只 import ./config-values.js（解 volatile Ref）；被 core/writer/process.js、host/session-wrap*、
// host/tools.js 与测试 import；不得 import host/core（架构书 §5.5）。
// 契约真源：docs/记忆插件-自动沉淀与工具面-架构书-v1-2026-11-26.md §5.1/§5.3。

import { value } from './config-values.js'

/**
 * ingestPolicy 缺省（与 Config `wrap.ingest.*` 缺省同值）。
 *
 * 为什么放在这里：收尾、工具、reflect 三处都要传 policy；默认值/映射若各写一份，
 * `minConfidence` 或 review 回退迟早只在一个入口生效（旧版就有"工具无 confidence 全成候选"）。
 */
export const INGEST_DEFAULTS = Object.freeze({
  mode: 'auto',
  minConfidence: 0.55,
  dropTaskInstructions: true,
})

/**
 * 配置/事件字段 → ingestPolicy（纯映射；容忍 schemastery Ref）。
 *
 * @param {unknown} raw 形如 `{mode,minConfidence,dropTaskInstructions}`（可含 Ref）
 * @param {{ confidence?: unknown }} [opts] 本次写入的置信度（tool/reflect 固定 1.0；distill 可缺省）
 * @returns {{ mode:'auto'|'review', minConfidence:number, dropTaskInstructions:boolean, confidence:number }}
 */
export function ingestPolicyOf(raw, { confidence = 1 } = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const minRaw = Number(value(cfg.minConfidence, INGEST_DEFAULTS.minConfidence))
  const minConfidence = Number.isFinite(minRaw)
    ? Math.max(0, Math.min(1, minRaw))
    : INGEST_DEFAULTS.minConfidence
  const confRaw = Number(value(confidence, 1))
  return {
    mode: value(cfg.mode) === 'review' ? 'review' : INGEST_DEFAULTS.mode,
    minConfidence,
    dropTaskInstructions: value(cfg.dropTaskInstructions) !== false,
    confidence: Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 1,
  }
}

/** 分类标签（process.js 据此映射 REJECT/CANDIDATE/auto，本文件不决定动作）。 */
export const DURABILITY = Object.freeze({
  STALE: 'stale',
  TASK: 'task',
  UNCERTAIN: 'uncertain',
  DURABLE: 'durable',
})

/**
 * 一次性状态/版本计数事实：只能证明"当时"，不能进长期库。
 * 命中即 stale，优先级最高（先于任务句与 durable 词）。
 */
// 大小写不敏感：写入入口先 normalize（ASCII 小写）再分类，大写 PID 必须仍能命中。
export const STALE_RE = /0\.\d+\.\d+|schema v\d+|PID \d+|(测试|用例)\s*\d+|active\s*\d+|候选\s*\d+|已装|已生效|待重启|重启后|当前 live|交接件已就位/i

/**
 * 句首命令/计划句：任务指令不入长期记忆。
 * 只认句首，句内引号里的“必须/应”不救（架构书 B5）。
 */
export const TASK_HEAD_RE = /^(请|帮我|需要你|下个?会话|下一步|本轮|这次先|先|再|记得|务必|去|做|改|修|审查|对比|编写|整合|推进|落地|修复|实现|补|加|删|拆分|验证|测试|检查|确认|执行)/

/** 计划/待办句首（与命令句同归 task，单独具名便于判据演进）。 */
export const PLAN_HEAD_RE = /^(下个?会话|待办|未完成|下一步|计划|安排)/

/** 相对指代/时间指代：脱离当下语境即失真，只转审核，不删词改写。 */
export const DEICTIC_RE = /这次|本次|刚才|上面|上次|上一轮|本轮|今天|昨天|目前|现在|当前/

/** 主观/不确定前缀：可能、也许、我觉得……不能当事实自动入库。 */
export const SUBJECTIVE_RE = /可能|大概|我觉得|似乎|也许|应该/

/** 长期有效的规范信号：含这些词才可能走 auto。 */
export const DURABLE_RE = /应|必须|不得|禁止|一律|默认|优先|不能|不要|因为|根因|教训|避免|先查/

/**
 * 歧义闸：只回答"为什么需要人工看"，绝不改写正文（架构书 §5.3 B7）。
 *
 * @param {unknown} text 原始（或已归一）正文
 * @returns {{ ambiguous: boolean, reasons: string[] }} reasons ∈ deictic|subjective
 */
export function detectAmbiguity(text) {
  const source = String(text ?? '')
  const reasons = []
  if (DEICTIC_RE.test(source)) reasons.push('deictic')
  if (SUBJECTIVE_RE.test(source)) reasons.push('subjective')
  return { ambiguous: reasons.length > 0, reasons }
}

/**
 * 持久性分类（严格按 §5.3 顺序：stale → task 句首/计划句 → 歧义/主观 → durable → uncertain）。
 *
 * 为什么要固定顺序：任务句里常带“必须/应”（引号内要求），durable 先判会把任务指令自动入库；
 * stale 句里也常带版本号与“必须”，必须最先拦。
 *
 * @param {unknown} text
 * @returns {'stale'|'task'|'uncertain'|'durable'}
 */
export function classifyDurability(text) {
  const source = String(text ?? '').trim()
  if (!source) return DURABILITY.UNCERTAIN
  if (STALE_RE.test(source)) return DURABILITY.STALE
  if (TASK_HEAD_RE.test(source) || PLAN_HEAD_RE.test(source)) return DURABILITY.TASK
  if (detectAmbiguity(source).ambiguous) return DURABILITY.UNCERTAIN
  if (DURABLE_RE.test(source)) return DURABILITY.DURABLE
  return DURABILITY.UNCERTAIN
}
