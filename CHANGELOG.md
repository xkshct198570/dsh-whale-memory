# Changelog

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
