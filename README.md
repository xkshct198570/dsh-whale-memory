# dsh-whale-memory

本地长期记忆中枢（DeepSeek Harness 插件）。

**状态：S1 骨架（0.1.0，未发布）** —— 包结构/manifest/空面板已就位；记忆核心、检索、注入、面板与开关按施工计划书 S2–S5 落地。

## 安装（开发期）

见 `docs/` 与仓库根 `cordis.patch.yml`；发布后从插件市场安装。

## 设计要点（施工中）

- 默认本地 `node:sqlite`，零运行时第三方依赖；外部服务是可选后端。
- 检索/打分在 `worker_threads` 中执行，主线程不跑大批量 SQL。
- 记忆身份按 `user_id / role_id / workspace` 三元隔离。
- 面板 API 默认只接受回环请求。
