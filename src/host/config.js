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

  // 模型侧记忆工具面（S2）：enabled=false 时五工具不出现在 step 工具集；
  // maxWritesPerTurn 只限 remember/update/forget 的每回合尝试次数（读工具不限）。
  tools: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxWritesPerTurn: z.natural().min(1).max(50).default(5).volatile(),
  }).default({}),

  reflect: z.object({
    enabled: z.boolean().default(false),
    model: z.string().default(''),
    idleMinutes: z.natural().min(5).max(1440).default(30),
    maxItems: z.natural().min(1).max(32).default(8).volatile(),
    maxRunsPerDay: z.natural().min(1).max(96).default(24),
  }).default({}),

  // 会话收尾（Session Wrap）：显式/空闲/dispose 三触发 → 有界提炼 → shadow 候选/规则提案/报告。
  // 默认 enabled=true 但只跑一次/材料，且 idle 受 maxRunsPerDay 限制；首启推荐卡会明确“会花模型 token”。
  wrap: z.object({
    enabled: z.boolean().default(true).volatile(),
    explicit: z.boolean().default(true).volatile(),
    // 升级即开启后台空闲/关闭收尾会在用户不知情下花模型 token（审查 P1）：默认只留显式，
    // 后台两路需用户在设置里显式打开；首启卡与组说明都写明这一点。
    idle: z.boolean().default(false).volatile(),
    disposed: z.boolean().default(false).volatile(),
    idleMinutes: z.natural().min(5).max(1440).default(10),
    maxItems: z.natural().min(1).max(32).default(8).volatile(),
    // 普通记忆自动入库（S1）：auto=价值闸放行的 durable 直接落 active；review=全部影子候选（0.7.3 回退）。
    // minConfidence：distill 未给 confidence 时按 0.5 计，低于阈值转审核；dropTaskInstructions=false 时
    // 任务句转审核而不是直接拒绝（仍不入库）。
    ingest: z.object({
      mode: z.union(['auto', 'review']).default('auto').volatile(),
      minConfidence: z.number().min(0).max(1).default(0.55).volatile(),
      dropTaskInstructions: z.boolean().default(true).volatile(),
    }).default({}),
    spoolTtlHours: z.natural().min(1).max(720).default(24),
    // 终态 run/报告的保留天数；0=永久。queued/running 永不删。
    retentionDays: z.natural().min(0).max(3650).default(180),
    maxRunsPerDay: z.natural().min(1).max(96).default(6),
    // S1b：点击即排队的全局上限（同会话恒 ≤1）；进程内存队列，重启清空。
    maxQueued: z.natural().min(1).max(32).default(8),
    report: z.boolean().default(true).volatile(),
    // 收尾模型可与对话模型分离：推理档模型会把预算烧在思考上（真机 textLen=0/2526、reasoning=9k+），
    // 建议收尾走非推理/低成本模型；空=沿用当前会话选择。
    provider: z.string().default('').volatile(),
    model: z.string().default(''),
    maxMaterialChars: z.natural().min(1000).max(50000).default(12000),
    timeoutMs: z.natural().min(5000).max(600000).default(60000),
    // S3 整合（Reconcile）：默认关；开启也只产影子候选/审计，不直接改 active 记忆。
    reconcile: z.object({
      enabled: z.boolean().default(false).volatile(),
      topK: z.natural().min(1).max(10).default(5),
      maxNeighborChars: z.natural().min(40).max(500).default(200),
    }).default({}),
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
    // 空机首次启动时若 AGENTS.md 不存在，创建最小管理块（已有文件绝不追加）。
    createAgentsIfMissing: z.boolean().default(true).volatile(),
    // 作用域规则每轮注入预算（字符；global 不注入，只作 AGENTS 缺标记时的降级）。
    injectChars: z.natural().min(0).max(4000).default(600).volatile(),
    // AGENTS 摘要总预算（码点）：19 条铁律约 3.7k，默认 6k 留余量；超限按优先级截断并 health 黄。
    summaryBudgetChars: z.natural().min(200).max(20000).default(6000).volatile(),
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
