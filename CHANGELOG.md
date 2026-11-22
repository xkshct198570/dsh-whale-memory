# Changelog

## 0.5.1 — 2026-11-22（采纳信号 · 未发布）

审计 backlog P1「回复引用信号（used 恒 0）」落地：注入 ≠ 采纳，之前 adoptionRate 恒 0、未采纳 Top10 等同全部已注入查询。
- 新增 `src/core/adoption.js`（无 IO 判定层）：原文 10 字窗口命中（强证据）或中文 bigram 覆盖率 ≥0.6 且 ≥5 个（改写型弱证据）即判采纳；节点 <8 字恒不采纳，宁漏判不伪造。
- `LocalBackend.recall()` 返回 `recallId` 与最终注入节点 `injectedNodes`（只含真正进上下文的节点）；新增 `markRecallUsed(recallId, used)` 只回写 `used` 列（不改 hit_ids/chars，注入事实与采纳事实分离），失败 fail-open。
- hook 接 `agent/assistant-stream`：按 (turn,step) 累积回复文本；在新一步 pre-step 或 `agent/turn-stopping`/`agent/disposed` 时结算，有引用证据才回写 used=1；无 `markRecallUsed` 的旧 backend 不崩。
- 日报「未采纳 Top10」口径文案同步（原文窗口/bigram 覆盖判定，改写幅度大的回复可能漏判）。
- 测试 215 → 231（230 pass / 1 skip）：新增 `test/adoption.test.mjs`、`test/adoption-signal.test.mjs`（含 hook→backend 全链路 used 落库断言），`test/hook.test.mjs` 扩 5 例。

## 0.5.0 — 2026-11-22（观测层批次 · 未发布）

审计 backlog P1「观测闭环」落地（架构书 §9.1/§9.2/§9.3）：
- 新增 `src/core/metrics.js`：十一项指标唯一口径 + 7 日 series；纯函数只读，落表只由日报调用（`writeMetricsRows` UPSERT）。
- `GET /stats` 增 `metrics{day,values,targets}`、`series[7]`、`health.jobs.recent_failures`（既有 totals/health 键不动）。
- 召回审计补零命中：每次召回都落 `recalls` 行（含零命中与意图预算 0），`source` 由调用方传入；`hit_ids` 改记检索命中集合（注入与否由 injected/chars 表达）；`GET /recalls` 支持 `source/since/filter=zero|unused/limit`。
- 日报新增：十一项指标表（目标/达标）、命中但未注入 Top10（低分命中的代理口径）、未采纳 Top10、24h 失败 job 表，并把指标写入 `metrics` 表。
- embed 关闭时 pending 滞留按 0 计（§9.1，避免每天挂一个不可行动的 ✗）。
- 面板概览：新增零注入率/采纳率/作业成功率/库体积指标卡（带目标达标态）、7 日曲线（注入率/零命中占比）、最近失败卡片；三语各 392 键。
- 测试 197 → 215（214 pass / 1 skip）：新增 `test/metrics.test.mjs`、`test/recalls.test.mjs`，keeper 报告与 stats 契约断言扩展。

## 0.4.3 — 2026-11-22

工程质量审计后的修复批次（对照架构书 v3.5 / 计划书 v1.5）：
- 写入保护面：NOOP 按来源可信度升级（owner>self>group>web/tool>import）、MERGE 对 owner/core/procedural 改走 REVIEW（不自动改写正文）；shadow 候选恢复 level/type/tags/source/TTL 并按原决策（MERGE/SUPERSEDE/REVIEW）执行。
- 配置契约：`/config` GET 回显 13 组全字段、POST 改叶子深合并（不再整组覆盖丢字段）；补 9 个文档字段；identity 四字段 volatile；volatile Ref 在 writer/backend 解包（关写/auto/上限真生效）。
- 数据保真：schema v2（`writes.payload`，v1→v2 幂等迁移）；导入/导出保留 status/双时态/context_note/hits；>500 字按规则边界拆分（`split_from`）或报 `too_long_single_rule`；导入后 FTS 一致性闸（docsize 比对，不一致回滚）；导出按身份过滤。
- 检索/关系：FTS 命中带 `path`(L1/L2)/`matched`；扩散分乘边 conf；worker 透传 diffusion/minConf；巩固新增 topic 边与同文去重（CONSOLIDATE 审计）。
- 观测：`/stats` 增 health（fts_aligned/vectors_pending/jobs/pressure）与今日召回/注入口径；trace_id 由 host 生成并下传。
- 面板：i18n 三语（zh/en/ja 各 377 键）+ 标记块生成 + `i18n-check` 静态门；设置页 13 组/50 控件（desc/生效徽标/danger/aria）；召回可解释（rel/mult/gain/effWeight/path/matched）；shadow 审核走服务端过滤；错误码补 13 个；窄屏表格滚动。
- 内存闸门改用 `/proc/meminfo` 的 MemAvailable（非 MemFree）。

## 0.4.2 — 2026-11-22

- S4 机制二期：写入决策流水线（ADD/NOOP/MERGE/SUPERSEDE/REVIEW/REJECT + shadow 候选审核）、jobs 状态机（单飞/退避/启动补偿/水位闸门）、关系层（标签边/1 跳扩散/context_note 200 硬顶 + 演化审计）、意图注入预算（画图链路 0 注入）。
- 评测：32 例黄金集移植 + `scripts/eval.mjs`，真实库 precision@3 = 1.0000（30/30 检索用例）、identHitRate = 1.0000。
- 检索：FTS 候选按 rank 取前 50（修此前按 rowid 取导致高相关节点落选）；`context_note` 只做 +5% 检索加权、不进注入正文。
- 设置页：新增 sync.enabled / reflect.enabled / write.searchFeed / recall.intentBudget 四个开关；写入页新增 shadow 候选接受/拒绝审核。

## 0.4.1 — 2026-11-22

- 修正后台任务内存闸门：按系统可用内存/2GB RSS，不再误把 DSH 常驻 748MB 判成告急（反思/搜索反哺恢复可跑）。

## 0.4.0 — 2026-11-22

- S4：双轨同步（pull/push dryRun）、反思（LLM+空闲调度）、搜索反哺（tools/result）、防 OOM；修复 pre-step listener 未 next() 导致 decision.kind 崩。

## 0.3.0 — 2026-11-22

- S2 记忆核心底座：schema v1（八表+双 FTS+触发器）、queryplan/tokenize/search、worker 隔离、LocalBackend、write/import/export/nodes 路由。

## 0.2.0 — 2026-11-21

- S1 拆分：Config、只读路由（stats/recent/search/recall-test 纯检索）、召回 hook、五页签只读面板。
- 边界：角色/对话不在本包；本包只认 role_id/workspace 身份。

## 0.1.0 — 2026-11-21

- S1 骨架。
