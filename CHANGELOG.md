# Changelog

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
