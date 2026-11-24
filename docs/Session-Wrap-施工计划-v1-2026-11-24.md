# 会话收尾沉淀（Session Wrap）· 施工计划 v1

> 状态：**W1–W6 已完成并通过回归**；剩余 live 重启验证、隔离安装验收、0.6.4 发布。后台空闲/关闭触发默认关，只有显式收尾默认开。
> 架构依据：`docs/Session-Wrap-架构书-v1-2026-11-24.md`。基线：鲸忆 0.6.3 工作树（schema v5）/ DSH 0.2.2-rc.5。

## 1. 阶段与现状

| 阶段 | 产物 | 验收证据 | 状态 |
|---|---|---|---|
| W1 纯核心 | `wrap-material/wrap-intent/distill/wrap-report` + 单测 | 44 项纯函数测试；证据/去重/意图正反例全绿 | 完成 |
| W2 采集与触发 | `host/session-capture`；三触发、意图、脱敏、advance | 11 项采集测试；显式/空闲/disposed/子代理/隐私/失败重试 | 完成 |
| W3 作业与持久化 | schema v5 `wrap_runs`、spool、`wrap` job、对账/TTL | 6 项台账 + 真宿主装载；崩溃续跑/幂等/0600/spool 清理 | 完成 |
| W4 分流与报告 | forceShadow、候选/提案、报告、清洁审计 | 11 项编排 + 6 项路由；报告无原文、写失败不 done、规则只提案 | 完成 |
| W5 UI/配置 | 设置组、概览卡、报告、候选过滤、首启推荐 | 6 项客户端契约 + 渲染冒烟；三语 924 键 | 完成 |
| W6 清洁与回归 | consolidate 入队、hygiene、全量回归 | `npm test` 1010（1009/1/0）；E1–E16、i18n、manual 全绿 | 完成 |

## 2. 剩余步骤

1. **live 重启加载 host 新码**：profile 以 `link:/home/hy/dsh-whale-memory` 指向本仓；client 可先更新，host 重启前 `/wrap`、`/wrap/status`、设置 `wrap` 组保存不可用（旧 host 白名单无该组）。重启由厂长执行，完成后验三条路由与保存。
2. **隔离干净安装**：临时 `DSH_HOME` + 临时 dataDir + `--port 0`，tarball 安装 local（可选 hybrid），说“收尾”→ run/候选/报告；重启进程不重复；删临时 home。
3. **0.6.4 发布**：CHANGELOG、`package.json` 版本、tag、Release 资产、市场索引与 PR；不覆盖 0.6.3 资产。
4. **可选优化（有实测再合，不做不算欠账）**：面板规则健康入口；`computeMetrics` 缓存；worker 连接复用。

## 3. 文件清单（已落地）

新增：
- `src/core/wrap-material.js`、`wrap-intent.js`、`distill.js`、`wrap-report.js`、`memory-hygiene.js`、`wrap-runs.js`
- `src/host/session-capture.js`、`session-wrap.js`
- 测试：`test/unit/{wrap-material,wrap-intent,distill,wrap-report,memory-hygiene}.test.mjs`、
  `test/hook/{session-capture,session-wrap}.test.mjs`、`test/contract/wrap-routes.test.mjs`、
  `test/data/wrap-runs.test.mjs`、`test/integration/session-wrap-host.test.mjs`

修改：
- `index.js`（采集/服务接线）、`src/host/config.js`（wrap 组）、`src/host/routes.js`（三路由/远端拒绝）
- `src/core/schema.js`（v5）、`keeper.js`（wrap kind）、`writer.js`（forceShadow/accept origin）、`backend.js`（forceShadow/writes origin）
- `lib/client.js`（概览卡/设置组/候选过滤/首启推荐）、`locale/*.json`
- 测试计数更新：schema v3/v5、import-export、migrate-audit、fixes-r10、keeper JOB_KINDS、client 元数据 67 字段/14 组、render smoke

## 4. 冻结契约

- `POST /wrap` 只收 trigger，不收材料；写闸/回环/JSON 闸同现有路由。
- `wrap_runs` 唯一 `(session_id,material_hash)`；状态机 `queued→running→done|failed|skipped`；`phase` 续跑断点。
- `wrap` job payload 只含 `{runId,spoolPath,materialHash}`。
- 报告字段固定：`summary/candidates/ruleProposals/openLoops/hygiene/switchReady`；不存原文。
- 候选强制 shadow（除非 `wrap.autoAccept=true`）；规则只创建 proposal。

## 5. 回滚

- 关 `wrap.enabled` 即停新触发；已排队 job 可取消/跳过。
- 清 `spool/session-wrap/`；候选批量 reject；`wrap_runs` 保留审计。
- schema v5→v4：用迁移前 `VACUUM INTO` 快照覆盖（先停写入），或保留 v5（旧代码忽略新表）。
- 0.6.4 失败不覆盖旧 Release。

## 6. 风险登记

| 风险 | 判据/处置 |
|---|---|
| 误触发（普通“结束了吗/把代码收尾”） | 问句/否定/引用/内容指代/长度排除；单测正反例 |
| 原始聊天泄露 | spool 0600/TTL/不进灾备；报告/状态/job/日志断言 |
| 模型编造 | evidence 原文校验；无证据丢弃；shadow |
| token 失控 | 1 次/材料、≤8 条、12k 素材、每日 6 次自动、可关 |
| 切会话丢失 | 显式 trigger 后 turn-stopping 立刻入队；spool 兜底 |
| 与 keeper/写队列冲突 | wrap 独立 kind；keeper 不认领 write；交叉测试 |
| 规则被自动改 | 只创建 proposal；apply 仍需确认 |
| 文档交接遗漏 | 报告含通用清单；agent 应用；四件套收尾 |

## 7. 交接入口

- 本文件：Session Wrap 施工真源。
- 架构书：`docs/Session-Wrap-架构书-v1-2026-11-24.md`。
- 小白手册：`docs/MANUAL.zh.md`（随包离线）。
- 全局交接：`/mnt/i/ai-workspace/ai-router/docs/{新会话启动Prompt.txt,会话交接摘要-一页.md,当前进度快照与待办清单.md}`。
