# 会话收尾沉淀（Session Wrap）· 施工计划 v1

> 状态：**方案已定稿，代码未动**。本轮只完成架构书、施工计划与收尾交接；实现按阶段在下一会话进行。
> 架构依据：`docs/Session-Wrap-架构书-v1-2026-11-24.md`。基线：鲸忆 0.6.3 / DSH 0.2.2-rc.5。

## 1. 阶段拆分（每阶段可独立验收）

| 阶段 | 产物 | 验收判据 | 回滚点 |
|---|---|---|---|
| W0 文档 | 架构书/施工计划/交接指针 | 两书入仓、索引更新、无代码 | 删除两书 |
| W1 纯核心 | `core/distill.js`、`core/wrap-intent.js`、`core/wrap-report.js` + 单测 | 意图正反例、证据守卫、报告无原文全绿 | 删模块 |
| W2 采集与触发 | `host/session-capture.js`；session/event 缓冲；显式/空闲/disposed 三触发 | fake 事件测试；子代理/权限/截断/脱敏 | 关 `wrap.enabled` |
| W3 作业与持久化 | `wrap` job kind、`wrap_runs` schema v5、spool、幂等/重试 | 崩溃续跑、重复触发只一次、失败可见 | schema v5→v4 备份回滚 |
| W4 分流与报告 | 候选 shadow、规则提案、open loop、reports 文件 | 候选/提案落点断言；规则不自动 apply | 关 autoAccept/清 spool |
| W5 UI/配置 | 设置“收尾”组、概览卡、立即收尾按钮、候选过滤 | 组件渲染冒烟 + 真机操作 | 隐藏入口 |
| W6 清洁与真机 | consolidate 触发、hygiene 审计、干净安装 | 清洁报告、FTS/边/重复/备份；真机说收尾→候选 | 关 wrap |

W1–W2 可并行（纯函数 vs 事件），W3 依赖 W2 的事件形状，W4 依赖 W3。

## 2. 文件清单（预计）

新增：
- `src/core/distill.js`（纯函数：prompt/parse/validate/evidence）
- `src/core/wrap-intent.js`（词表、排除规则、归一化）
- `src/core/wrap-report.js`（Markdown 报告，无原文）
- `src/core/memory-hygiene.js`（只读审计 + 安全清洁）
- `src/host/session-capture.js`（事件订阅、环形缓冲、spool）
- `src/host/session-wrap.js`（编排、job handler、候选/提案路由）
- `test/unit/distill.test.mjs`、`test/host/session-capture.test.mjs`、`test/host/session-wrap.test.mjs`、`test/data/wrap-runs.test.mjs`
- schema v5 迁移测试。

修改：
- `src/host/config.js`（wrap 组）
- `src/core/keeper.js`（`wrap` kind/handler；不得破坏 write 独占）
- `index.js`（接线：capture/service/job；不堆业务分支）
- `src/host/routes.js`（`POST /wrap`、`GET /wrap/status`、`GET /wrap/report`）
- `src/core/schema.js`（wrap_runs + 迁移）
- `lib/client.js`（设置组/概览卡/按钮/候选过滤；locale）
- `scripts/check.mjs`（新路由/契约门）
- 文档：`README*`、`MANUAL.zh.md`、`CHANGELOG.md`、`docs/R11...`（仅接口/行为变化）。

## 3. 数据/接口契约（施工前先冻结）

- `POST /whale-memory/api/wrap` body `{trigger:'manual'|'explicit'|'idle'|'disposed', materialHash?}`；回环写闸；返回 `{ok,jobId,state}`；无素材/无模型 422/409 可判定码。
- `GET /wrap/status` 最近 run + 可切会话状态；`GET /wrap/report?id=` 返回报告文本（只读、身份过滤）。
- `wrap_runs` 唯一 `(session_id,material_hash)`；状态机 `queued→running→done|failed|skipped`；attempts ≤3。
- `wrap` job payload 只含 `{runId,spoolPath,materialHash}`；不含全文。
- 报告字段固定：`summary/candidates/ruleProposals/openLoops/hygiene/switchReady`。

## 4. 测试矩阵

| 层 | 用例 |
|---|---|
| unit | 意图词正/反例；证据缺失丢弃；长文本截断；空 material；规则句降级；去重 |
| contract | POST /wrap 写闸/幂等/错误码；GET status/report 身份隔离 |
| hook | session/event 捕获、三触发、子代理跳过、disposed flush、无模型可见 |
| data | wrap_runs 迁移/唯一键/重启续跑/重试上限/spool TTL |
| client | 设置组、概览卡、按钮、候选 origin 过滤、渲染冒烟 |
| integration | 真机干净安装：三触发各一次 → 候选/报告/清洁；重启无重复 |

## 5. 顺序与依赖

1. W0（本会话）：两书 + 交接指针；不改代码。
2. W1：distill/intent/report 纯函数；先写测试再接线。
3. W2：capture 事件；用 fake session 事件跑通显式/空闲/disposed。
4. W3：schema v5 + job；先备份/迁移测试，再落 live。
5. W4：分流；默认 shadow；规则提案只创建不 apply。
6. W5：UI/配置；组件渲染冒烟。
7. W6：清洁与真机；干净 home 验收后，才考虑版本 0.6.4 与发布。

## 6. 回滚

- 关 `wrap.enabled` 即停新触发；已排队 job 可取消/跳过。
- 清 `spool/session-wrap/`；候选批量 reject；`wrap_runs` 保留审计。
- schema v5→v4：用迁移前 `VACUUM INTO` 快照覆盖（先停写入），或保留 v5（旧代码忽略新表）不强制回滚。
- 发布前打 tag；失败不覆盖旧 Release。

## 7. 风险登记

| 风险 | 判据/处置 |
|---|---|
| 误触发（普通“结束了吗”） | 问句/长度/引用排除；单测正反例 |
| 原始聊天泄露 | spool 0600/TTL/不进灾备；报告只摘要；grep 断言 |
| 模型编造 | evidence 原文校验；无证据丢弃；shadow |
| token 失控 | 1 次/会话、≤8 条、12k 素材、每日 6 次、可关 |
| 切会话丢失 | 显式 trigger 后 turn-stopping 立刻入队；spool 兜底 |
| 与 keeper/写队列冲突 | wrap 独立 kind；不得认领 write；交叉测试 |
| 规则被自动改 | 只创建 proposal；apply 仍需确认 |
| 文档交接遗漏 | 报告含通用清单；agent 应用；四件套收尾 |

## 8. 本会话完成 / 留到下会话

本会话已完成：架构书、施工计划、本会话记忆沉淀/反思/清洁审计、交接文档更新。
留到下会话：W1–W6 代码、schema v5、UI、真机验收、0.6.4 发布；不修改 0.6.3 已发布资产。
