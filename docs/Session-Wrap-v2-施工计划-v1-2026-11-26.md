# 会话收尾 v2（Session Wrap v2）· 施工计划 v1

> 配套：`Session-Wrap-v2-架构书-v1-2026-11-26.md`（契约、语义、风险以架构书为准）。
> 基线：鲸忆 0.6.7（`e06750a` / tag `v0.6.7`）；施工分支从 main 起，**不提前改版本**，发布阶段在 main 落 0.7.0。
> 纪律：每阶段独立 commit + 全量门禁绿才进下一阶段；每阶段末 live 可验项必须验；不绿不合、不 push。

## 阶段总览

| 阶段 | 内容 | 产物 | 验收 | 回滚 |
|:--|:--|:--|:--|:--|
| S1 | 反馈与会话选择 | `/wrap/sessions`、`POST /wrap{sessionId}`、卡片下拉＋错误文案 | 契约测试＋面板手点：进行中/无材料/成功三种反馈可见 | 回退 S1 提交 |
| S2 | 自动开关＋会话语义 | schema v6 `wrap_session_prefs`、`PATCH /wrap/session`、卡片勾选、重启后 skip 保持 | 单测＋live：勾选后 idle 触发、skip 后不再触发 | 回退提交（表可空） |
| S3 | Reconcile 整合 | `core/reconcile.js`、`host/session-wrap/reconcile.js`、决策落地 shadow、配置开关 | 解析/校验/落地/保护面/跨身份 5 组测试＋live 单条 UPDATE 审阅 | 关配置即回 0.6.6 |
| S4 | 归纳与报告 | 多候选归纳、拆分、关键词/标签校正、报告决策摘要 | 测试＋面板报告只读核对（无原文） | 回退提交 |
| S5 | 发布 0.7.0 | CHANGELOG/README/版本、tag、Release、市场索引、四件套、灾备 | 全量门禁＋live 矩阵＋干净桌面安装冒烟 | tag 回滚 p6 线 |

## S1 · 反馈与会话选择（无 schema）

改动：

- `src/host/session-capture.js`：导出 `listSessions()`（id、lastActivity、materialTurns、open、lastRun 摘要），不返回正文；`flush` 支持指定 sessionId。
- `src/host/session-wrap.js`：`manual({sessionId})`；`triggerRecent` 保留为缺省；新增 `sessions()` 视图。
- `src/host/routes/wrap.js`：`GET ${PREFIX}/wrap/sessions`（远端读拒绝）；`POST /wrap` 支持 `sessionId`。
- `lib/client-src/51-wrap-card.js`：卡片主体从 `50-overview.js` 拆出；下拉、按钮、反馈行、busy 态。
- UI 审查 P1/P2（`Session-Wrap-v2-UI审查与排版建议-2026-11-26.md`）：`StateBadge` 状态行、错误码→中文映射、4 个 `StatTile` 替 `metaGrid+Row`、失败折叠（避免同页重复整块）、空态引导、`settingHead` 换行、页签单行横滚、间距阶梯 4/8/12/16、focus ring/aria。
- 禁用按钮 tooltip（加载中/未启用/后端不支持），成功提示带“查看报告”入口。
- `lib/client-src/generated/locale.js` 与 i18n 源：新增键（会话/自动收尾/错误文案/空态/折叠），必须走 `i18n-check --write`。

判据：

- 断言没有正文/标题字段泄露（直接断言响应 JSON 键集合）。
- 进行中点手动：返回 409 `turn_in_progress`，卡片出现中文一句话（组件渲染冒烟）。
- UI：1280×800 与 900×700 两档渲染冒烟断言无溢出/无 NaN；页签单行横滚；失败默认折叠。
- 指定 sessionId：run 归属正确；不存在的 id → 409 `no_session`。

回滚点：S1 单 commit，面板回旧卡片即可。

## S1b · 点击即排队＋进度

- 契约与逐条验收：**`下一会话创造模式总纲-架构书-v1-2026-11-26.md` §5（唯一真源）**；会话级排期：`下一会话创造模式施工计划-v1-2026-11-26.md` S1b。
- 范围：202 入队＋内存队列/position＋status 队列字段＋进度/文案＋`GET /wrap/sessions`；**不含** PATCH、schema v6、per-session skip、keeper 自动重试、每日上限（S2）。
- 本文件不重复状态码/幂等/文案矩阵，避免与总纲冲突。

## S2 · 自动开关＋per-session skip

改动：

- `src/core/schema.js`：v6 迁移 `wrap_session_prefs`（幂等建表）；`wrap_runs.phase` 允许新值不改约束。
- `src/core/wrap-prefs.js`：读写 prefs（`skipAuto`），缺省=0。
- `src/host/session-capture.js`：tick 前查 skipAuto；捕获会话时带出；重启后从库回填。
- `src/host/routes/wrap.js`：`PATCH /wrap/session`。
- 客户端：勾选“自动收尾”写 `wrap.idle`；每会话 skip 开关。

判据：

- 勾选后（临时 idleMinutes=5）5 分钟空闲触发一次；再 idle 不重复（同 hash）。
- skipAuto=1 的会话不被自动触发；重启（隔离 home）后仍 skip。
- 失败退避：同会话失败后 30 分钟内不再自动触发（假时钟测试）。

回滚点：S2 提交；表可空、旧代码忽略。

## S3 · Reconcile 整合

改动：

- `src/core/reconcile.js`：`buildReconcilePrompt(items, neighbors)`、`parseReconcileOutput(raw)`、`validateDecisions(decisions,{items,neighbors,identity})`；容错解析沿用 distill 口径（围栏/首个 `{` 到末 `}`）；任何形状错→`bad_json` 失败可见。
- `src/host/session-wrap/reconcile.js`：每条候选 FTS topK≤5 邻居（同 identity，截断 200 字）→ 模型 1 次 → 决策校验 → 落 `run.distilled_json.reconcile` 断点 → 调 writer。
- `src/host/session-wrap/dispatch.js`：候选分流改为“决策驱动”；`wrap.reconcile.enabled` 默认 false，关闭时走 0.6.6 原路。
- 配置：`wrap.reconcile.{enabled,topK,maxNeighborChars}`（`enabled` 默认 false，live 验证后默认可改 true）。
- 审计：决策复用 `writes`（action/before_text/after_text/payload），不新增表。

判据（全部为断言，不是人工目测）：

1. op 白名单与 target 归属：跨 identity/workspace 拒绝并记 `REVIEW`。
2. 坏 JSON/超时：run=failed，`/wrap/status` 可见，不写半成品。
3. 落地：ADD→CANDIDATE；UPDATE→before/after 审计；MERGE→不新增副本；ARCHIVE→status=archived 且历史行保留；pinned/规则镜像→REVIEW。
4. 幂等：同 run 重跑不重复写决策（断点命中）。
5. 关配置：行为与 0.6.6 完全一致（表征测试对比）。

回滚点：S3 提交；配置关。

## S4 · 归纳与报告

改动：

- Reconcile 输出支持 `integrate`：把多条同主题候选合并成 1 条（`MERGE` 跨候选），或拆 `SPLIT`（仅建议，不自动落）。
- 关键词/标签/level 校正建议；歧义检查（相对指代/主观前缀/超 200）在 `validateDecisions` 拒绝。
- 报告：`decisions` 计数摘要（ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW），仍不含原文。

判据：

- 3 条同主题候选 → 1 条合并决策或明确 NOOP，不产生 3 条副本（断言节点数）。
- 报告只含计数与 run 元数据（断言无素材片段）。

## S5 · 发布收口

- 版本 0.7.0；CHANGELOG（用户可见：会话选择、自动开关、整合审阅、反馈）；README 高亮更新。
- 全量测试/E1–E17/deps/build/compare/pack；live 矩阵（S1–S4 判据）；干净桌面 DSH 安装冒烟。
- tag `v0.7.0`→Release；`market-index.json` 钉 tag commit；四件套 + 灾备包 + INDEX。

## 测试与门禁（每阶段）

- `npm test`（全量）、`node scripts/check.mjs`、`build-client --check`、`check-deps`、`lint-size`、`compare-baseline`、`npm pack --json`（644 归一）。
- 故障注入至少：坏 JSON、超时、目标节点被删、并发 run、skip 重启。
- 体量：新增文件 ≤350 行；`50-overview.js` 拆后 ≤300；任何文件 >800 必须先拆。

## 顺序依赖与停点

- S1 → S2 可并行开发但 S2 依赖 S1 的 sessions 视图合并顺序；S3 依赖 S2 的 prefs（同会话单 run）。
- 任何阶段出现“需要改 Writer 判据/证据判据”的冲突：停，回到架构书评审，不在阶段内偷改判据。
- live 验证必须等厂长重启窗口；重启前只写“待重启生效”，不记已修。

## 交付清单

- 代码：4 个新模块 + wrap/capture/routes/schema/config/client 改动。
- 文档：架构书/施工计划（本文）、CHANGELOG、README、Session-Wrap 使用说明（面板新增项）。
- 测试：契约、reconcile 解析/校验、落地集成、自动化、UI 冒烟、故障注入。
- 四件套：启动 Prompt、一页摘要、快照、v4 清单（插件项）+ 灾备 INDEX。
