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
    id: z.string().default(''),
    mode: z.union(['local', 'http', 'hybrid']).default('local'),
    url: z.string().default(''),
    timeoutMs: z.natural().min(200).max(30000).default(3000),
  }).default({}),

  identity: z.object({
    mode: z.union(['auto', 'fixed']).default('auto').volatile(),
    userId: z.string().max(128).default('').volatile(),
    roleId: z.string().max(64).default('').volatile(),
    workspace: z.string().max(64).default('').volatile(),
  }).default({}),

  recall: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxHits: z.natural().min(0).max(20).default(5).volatile(),
    // 0 = 关闭注入（代码语义）；架构书 §4 S11 写"0 = 不限制"，以代码为准。
    charBudget: z.natural().min(0).max(8000).default(1500).volatile(),
    intentBudget: z.boolean().default(true).volatile(),
    minRel: z.number().min(0).max(1).default(0.34).volatile(),
    timeoutMs: z.natural().min(100).max(10000).default(2000),
    injectLevels: z.array(z.union(['core', 'important', 'normal'])).default(['core', 'important']).volatile(),
    showSources: z.boolean().default(true).volatile(),
  }).default({}),

  write: z.object({
    enabled: z.boolean().default(true).volatile(),
    reviewMode: z.union(['shadow', 'auto']).default('shadow').volatile(),
    maxChars: z.natural().min(20).max(500).default(500).volatile(),
    dailyCap: z.natural().min(1).max(2000).default(200).volatile(),
    judge: z.union(['rules', 'llm']).default('rules').volatile(),
    searchFeed: z.boolean().default(false).volatile(),
    searchTtlHours: z.natural().min(1).max(720).default(24).volatile(),
    model: z.string().default(''),
    ignorePatterns: z.array(z.string()).default([]),
  }).default({}),

  reflect: z.object({
    enabled: z.boolean().default(false),
    model: z.string().default(''),
    idleMinutes: z.natural().min(5).max(1440).default(30),
    maxItems: z.natural().min(1).max(32).default(8).volatile(),
    maxRunsPerDay: z.natural().min(1).max(96).default(24),
  }).default({}),

  consolidate: z.object({
    enabled: z.boolean().default(true).volatile(),
    intervalHours: z.natural().min(1).max(168).default(6),
  }).default({}),

  embed: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().default(''),
    model: z.string().default(''),
    batch: z.natural().min(1).max(128).default(16),
  }).default({}),

  privacy: z.object({
    redact: z.boolean().default(true).volatile(),
    retentionDays: z.natural().min(0).max(3650).default(0),
  }).default({}),

  edges: z.object({
    diffusion: z.boolean().default(true).volatile(),
    minConf: z.number().min(0).max(1).default(0.6).volatile(),
  }).default({}),

  sync: z.object({
    enabled: z.boolean().default(false).volatile(),
    mode: z.union(['off', 'push', 'pull', 'both']).default('off').volatile(),
    intervalMin: z.natural().min(1).max(10080).default(15),
    httpTimeoutMs: z.natural().min(200).max(30000).default(800).volatile(),
    batch: z.natural().min(1).max(500).default(100).volatile(),
    bridgeUrl: z.string().default(''), // 空=未配置；由 profile 注入本机桥地址（A 包不得出现本机桥字面量）
    dryRun: z.boolean().default(true).volatile(),
  }).default({}),

  // 规则仓储（R3a）：文件是真源，DB 镜像只做召回入口。
  // dir 空 = `$DSH_HOME/rules`；enabled/llm 与 recall 同口径标为运行时可变。
  rules: z.object({
    enabled: z.boolean().default(true).volatile(),
    dir: z.string().default(''),
    requireGit: z.boolean().default(false),
    askMode: z.union(['panel+chat', 'panel', 'off']).default('panel+chat'),
    llm: z.boolean().default(false).volatile(),
    maxProposals: z.natural().min(1).max(200).default(20),
    guardStrict: z.boolean().default(true),
    mirrorAuto: z.boolean().default(true),
    askCooldownDays: z.natural().min(0).max(3650).default(30),
    // AGENTS 摘要重渲染开关（R3b）：关=只写规则文件，渲染由面板手动触发。
    // 与 enabled/llm 同口径标 volatile：hook/routes 每次现取，改了立即生效，不用重挂。
    renderAgents: z.boolean().default(true).volatile(),
    // 作用域规则每轮注入预算（字符；global 不注入，只作 AGENTS 缺标记时的降级）。
    injectChars: z.natural().min(0).max(4000).default(600).volatile(),
  }).default({}),

  panel: z.object({
    allowRemote: z.boolean().default(false).volatile(),
    pollMs: z.natural().min(5000).max(600000).default(60000).volatile(),
    tab: z.union(['overview', 'memory', 'rules', 'recall', 'writes', 'settings']).default('overview'),
  }).default({}),

  advanced: z.object({
    traceId: z.string().max(64).default('').volatile(),
    logLevel: z.union(['error', 'warn', 'info', 'debug']).default('warn').volatile(),
    worker: z.boolean().default(true).volatile(),
  }).default({}),
})
