# Changelog

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
