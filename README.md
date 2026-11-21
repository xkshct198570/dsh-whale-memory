# dsh-whale-memory

本地长期记忆中枢（DeepSeek Harness 插件）。

**状态：S4 机制二期（0.4.2，未发布）** —— schema v1、QueryPlan/两段式打分、worker 隔离、本地 backend、写入决策流水线、后台 jobs、关系扩散、意图预算、五页签面板与设置开关已就位；发布封板（S5）待做。

## 安装（开发期）

见 `docs/` 与仓库根 `cordis.patch.yml`；发布后从插件市场安装。

## 设计要点（施工中）

- 默认本地 `node:sqlite`，零运行时第三方依赖；外部服务是可选后端。
- 检索/打分在 `worker_threads` 中执行，主线程不跑大批量 SQL。
- 记忆身份按 `user_id / role_id / workspace` 三元隔离；本包不注入角色文本、不做对话，只认身份键。
- 本包只认身份键（`user_id / role_id / workspace`）；角色资产与网页端展示由独立插件负责，切换时只向本包发身份提示。
- 面板 API 默认只接受回环请求。
