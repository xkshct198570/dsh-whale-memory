/**
 * Config schema（空配置必须通过校验；默认值即开箱行为）。
 *
 * S1 只接线 backend/identity/recall/panel 四组；其余字段先定义、S2–S4 逐步生效，
 * 避免"装上了但面板写着能调、实际没实现"的假开关（先定义不显示）。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  dataDir: z.string().default(''),

  backend: z.object({
    mode: z.union(['local', 'http', 'hybrid']).default('local'),
    url: z.string().default(''),
    timeoutMs: z.natural().min(200).max(30000).default(3000),
  }).default({}),

  identity: z.object({
    mode: z.union(['auto', 'fixed']).default('auto'),
    userId: z.string().default(''),
    roleId: z.string().default(''),
    workspace: z.string().default(''),
  }).default({}),

  recall: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxHits: z.natural().min(0).max(20).default(5).volatile(),
    charBudget: z.natural().min(0).max(8000).default(1500).volatile(),
    minRel: z.number().min(0).max(1).default(0.34).volatile(),
    timeoutMs: z.natural().min(100).max(10000).default(2000),
  }).default({}),

  write: z.object({
    enabled: z.boolean().default(true).volatile(),
    reviewMode: z.union(['shadow', 'auto']).default('shadow').volatile(),
    maxChars: z.natural().min(20).max(500).default(500).volatile(),
  }).default({}),

  panel: z.object({
    allowRemote: z.boolean().default(false).volatile(),
    pollMs: z.natural().min(5000).max(600000).default(60000).volatile(),
    tab: z.union(['overview', 'memory', 'recall', 'writes', 'settings']).default('overview'),
  }).default({}),

  advanced: z.object({
    traceId: z.string().default('').volatile(),
    logLevel: z.union(['error', 'warn', 'info', 'debug']).default('warn').volatile(),
    worker: z.boolean().default(true).volatile(),
  }).default({}),
})
