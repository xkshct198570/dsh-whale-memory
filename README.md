# dsh-whale-memory

本地长期记忆中枢（DeepSeek Harness 插件）。

**状态：S1 拆分完成（0.2.0，未发布）** —— Config、只读路由（含纯检索测试）、召回注入 hook、五页签只读面板已就位；本地记忆核心/写入/开关按 S2–S5 落地。

## 安装（开发期）

见 `docs/` 与仓库根 `cordis.patch.yml`；发布后从插件市场安装。

## 设计要点（施工中）

- 默认本地 `node:sqlite`，零运行时第三方依赖；外部服务是可选后端。
- 检索/打分在 `worker_threads` 中执行，主线程不跑大批量 SQL。
- 记忆身份按 `user_id / role_id / workspace` 三元隔离；本包不注入角色文本、不做对话，只认身份键。
- 本包只认身份键（`user_id / role_id / workspace`）；角色资产与网页端展示由独立插件负责，切换时只向本包发身份提示。
- 面板 API 默认只接受回环请求。
