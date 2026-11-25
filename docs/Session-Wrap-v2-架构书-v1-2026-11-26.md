# 会话收尾 v2（Session Wrap v2）· 架构书 v1

> 状态：设计稿（2026-11-26，未施工）。基线：鲸忆 0.6.7（main `e06750a`，tag `v0.6.7`）／人设 0.5.3／DSH 0.2.2-rc.5／Node ≥22.13。
> 施工计划：`Session-Wrap-v2-施工计划-v1-2026-11-26.md`。上一版：`Session-Wrap-架构书-v1-2026-11-24.md`（W1–W6 已落地）。
> 触发背景（2026-11-26 01:2x，厂长）：面板点「立即收尾」无反应；希望可选“收尾哪一段会话”、有“自动收尾”勾选；并确认收尾语义＝总结本轮踩坑/经验→归纳提炼→能进铁律的提案、不能的进记忆库，且表述去歧义。

## 1. 目标与验收

目标（按优先级）：

1. **点得动、看得懂**：手动收尾在任何合法原因下都有可见反馈（成功 runId／失败原因中文映射／忙碌态），不再“点了没反应”。
2. **可指定会话**：面板可选择“收尾哪个会话”，不再只能取“最近一个有材料的”。
3. **自动收尾可控**：卡片上一个显式勾选（默认关，标注会花模型 token）＋每会话“跳过自动收尾”，空闲触发沿用现有 idleMinutes。
4. **收尾=“蒸馏＋整合”两段**：
   - 蒸馏（已有）：从会话素材提取 lesson/decision/preference/fact/open_loop/rule，证据必须逐字命中素材。
   - 整合（新增）：把候选与**已入库记忆**比对，产出 ADD / UPDATE / MERGE / ARCHIVE / NOOP 决策（含改写后的短语义），默认仍只进 shadow 候选、逐条可审；规则句仍只走规则提案。
5. **去歧义与归类**：改写后文本必须能回答“做什么·何时·怎么判”、≤200 字、无主观前缀、无“可能/大概”；kind→记忆层/类型的映射与关键词、标签校正一并落决策。
6. **纯粹与安全**：收尾本身不直接改 active 记忆、不自动改规则、不碰项目文档；只产出候选/提案/决策/报告。失败可见、可续跑、幂等、不泄原文。

验收（下一会话施工后逐条断言）：

- 面板：下拉能列出“最近有材料”的会话（含进行中/可跳过的标记）；选中后 POST 指定 sessionId，run 归属正确。
- 空闲自动：勾选并设 idleMinutes=5 后，5 分钟空闲触发一次；同一材料不重复；关掉勾选后不再触发；单会话“跳过”后该会话不再自动触发（重启后仍生效）。
- 反馈：进行中点按钮 → 卡片显示“当前会话正在回复，稍后或换一个会话”，不是静默；busy/status 加载失败也有文案。
- 整合：给一条与既有节点高相似的候选 → 决策为 MERGE/UPDATE 且 before/after 入审计；冲突事实（旧“端口 3080” vs 新“端口 4090”）→ SUPERSEDE/ARCHIVE 旧节点且历史保留；不确定 → NOOP/REVIEW，不硬改。
- 证据与越权：决策 targetId 必须同 identity/workspace；跨会话/跨工作区目标一律拒绝；改写文本证据须能在素材或目标旧文中找到。
- 规则：rule 条目无规范句 → 降级 lesson；有 → 只提案，不 apply。
- 失败：坏 JSON/超时/目标节点消失 → run=failed 且 status/面板可见；重试幂等；不写半成品。
- 隐私：报告/日志/status/job payload 无聊天原文；spool 0600、TTL 24h、不进灾备。

## 2. 非目标

- 不做“每轮自动总结”；不把工具输出/思考过程写进候选。
- 不自动 apply 规则提案；不改铁律文件。
- 不替 agent 改各项目交接文档；只产报告/清单。
- 不做跨用户/跨工作区记忆合并；不做向量检索（沿用 FTS/关键词）。
- 不引入外部服务；不把聊天上传。

## 3. 现状与代码地图（2026-11-26 实测）

| 文件 | 行数 | 职责 | 备注 |
|:--|--:|:--|:--|
| `src/host/session-wrap.js` | 299 | 收尾编排/状态/面板端点出口 | <800 |
| `src/host/session-capture.js` | 453 | 会话事件采集、意图判定、`triggerRecent`、空闲 tick、per-session 状态（内存） | 选择会话的现状源头 |
| `src/host/session-wrap/distill.js` | 132 | 模型调用→解析→证据校验（0.6.6 起 4096 预算 + 单次重试） | S3 复用 |
| `src/host/session-wrap/report.js` | 164 | 无原文报告 | 不改 |
| `src/host/session-wrap/spool-run.js` | 295 | spool/断点/keeper 续跑 | 不改 |
| `src/host/session-wrap/dispatch.js` | 119 | 候选/提案/清理分流 | S3 接线 |
| `src/host/routes/wrap.js` | 57 | `/wrap`、`/wrap/status`、`/wrap/report` | 新增 sessions/prefs 端点 |
| `src/core/distill.js` | 292 | 提示词/容错解析/证据校验 | 不改判据 |
| `src/core/wrap-runs.js` | 242 | run 状态机/断点 | phase 扩展 |
| `src/core/writer/decide.js` | 602 | 确定性去重：同 hash NOOP、相似 MERGE、冲突 SUPERSEDE、保护面 | 整合落地复用 |
| `src/core/writer/process.js` | 266 | 节点插入/事件编排 | 复用 |
| `src/core/writer/{queue,review,audit,privacy}.js` | 418/149/113/84 | 候选队列/审阅/审计/脱敏 | 复用 |
| `src/core/schema.js` | 387 | schema v5 | v6 增 `wrap_session_prefs` |
| `lib/client-src/50-overview.js` | 394 | 收尾卡片/按钮/报告 | 拆出卡片模块 |
| `lib/client-src/95-settings-01.js` | 384 | 收尾设置组 | 复用 |

现状行为（实测）：

- `POST /wrap` 只接受无参触发；`turn_in_progress` 时返回 409（01:26–01:27 连续 8 次探测全部 409），前端只在按钮下方渲染一行小字，视觉上≈“无反应”。
- `triggerRecent` 取“最近有材料且无进行中 turn 的会话”（`session-capture.js:367`），无选择入口。
- 自动空闲开关只有配置 `wrap.idle`（默认 false）＋设置页，不在卡片上；无 per-session 跳过。
- 整合层现状：writer 在**写入/审阅时**做确定性去重（文本相似度 ≥0.85 MERGE、冲突 SUPERSEDE、同 hash NOOP，`decide.js`），但**蒸馏阶段不与既有记忆比对**，也没有 LLM 语义改写/拆分/关键词校正/跨候选归纳。
- 旧失败：run1/2 `distill_bad_json` 根因（推理档烧预算且无重试）已于 0.6.6 修复，历史记录已留证清理。

## 4. 语义定义（收尾到底做什么）

一句话：**收尾＝把“这一轮值得留下的东西”提炼成可执行短语义，并把它与已有记忆对齐后交给人审。**

| 阶段 | 输入 | 输出 | 谁做 | 判据 |
|:--|:--|:--|:--|:--|
| Distill | 会话素材（≤12000 码点、最近 20 轮） | summary + items{kind,text,evidence,confidence,tags} | 模型 1 次 | evidence 逐字命中素材；text≤200；去主观前缀 |
| Reconcile | items + 每条邻居（FTS topK≤5，带 id/updated_at/level/status） | decisions{op,targetId?,afterText?,reason,evidence} | 模型 1 次（无候选则跳过） | op 合法；target 同 identity；afterText 规则同 Distill；时间戳新者优先 |
| Apply | decisions + 审阅 | writes 审计行（shadow 默认）/规则提案/报告 | 现有 writer | 保护面→REVIEW；跨身份→拒绝；不物理删除 |

op 语义（与 `writes.action` 对齐）：

- `ADD`：新事实，无相似节点。
- `UPDATE`：同一条目信息更新（如端口 3080→4090），afterText 覆盖，旧值进审计 before_text。
- `MERGE`：候选补充/细化既有节点（相似但信息增益≥8 字），合并成一条 afterText。
- `ARCHIVE`：既有节点已被本轮事实推翻/作废 → status=archived（不删，双时态保留）。
- `NOOP`：重复或无需变更；仍记审计，不新建节点。
- 不确定或目标受保护（pinned/规则镜像/跨工作区）→ `REVIEW`（候选保留，人审）。

归类规则：kind→level/type 映射沿用现有 dispatch（lesson→procedural/important；fact→semantic 等），但 Reconcile 可给出 `level`/`memoryType`/`tags` 校正建议；歧义改写要求：

- 禁止“可能/大概/我觉得/应该”等主观前缀（沿用 Distill 的 HEDGE 规则）；
- 每条尽量含“触发条件/动作/判据”，缺判据的事实类可保留但 confidence≤0.6；
- 不写“这次/刚才/上面”等相对指代；时间用绝对日期或事件锚点；
- 同一事实只留一条 active；更新走 UPDATE/MERGE，不新增副本。

## 5. 目标设计与边界

```
采集（已有） ──► run 落库（已有） ──► Distill（已有，0.6.6 修） ──► 候选 items
                                                        │
                                                        ▼
                                      Reconcile（新，1 次模型调用）
                                   items × 邻居 → decisions（ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW）
                                                        │
                        ┌───────────────────────────────┼───────────────────────────┐
                        ▼                               ▼                           ▼
                 记忆候选（shadow）                规则提案（只提案）            报告（无原文）
                        │
                        ▼
                面板审阅 accept/reject（已有 /writes、/write/review）
```

依赖方向：`host/session-wrap/*` → `core/distill`、`core/reconcile`、`core/wrap-*`、`core/writer/*`；core 不 import host。新增模块：

- `src/core/reconcile.js`（提示词/容错解析/决策校验，≤300 行）
- `src/host/session-wrap/reconcile.js`（邻居检索→模型→决策落地，≤350 行）
- `src/core/wrap-prefs.js`（per-session 跳过/自动，≤120 行）
- `lib/client-src/51-wrap-card.js`（卡片 UI，≤350 行；`50-overview` 只装配）

### 5.1 接口契约

| 端点 | 方法 | 请求 | 响应 | 说明 |
|:--|:--|:--|:--|:--|
| `/wrap` | POST | `{sessionId?, trigger?}` | 200 `{ok,runId,sessionId}`；409 `{ok:false,error}` | sessionId 缺省=旧行为；错误码见 §5.2 |
| `/wrap/sessions` | GET | — | `{ok,items:[{sessionId,lastActivity,materialTurns,open,skipAuto,lastRunId,lastRunState}],auto:{enabled,idleMinutes}}` | 不含正文/标题；按 lastActivity 倒序；远端读拒绝 |
| `/wrap/session` | PATCH | `{sessionId,skipAuto}` | `{ok,skipAuto}` | 持久化到 `wrap_session_prefs`；仅 owner 身份 |
| `/wrap/status` | GET | — | 增加 `sessions[]`、`auto`、`lastFeedback` | 兼容旧字段 |
| `/wrap/report` | GET | `?id=` | 不变 | 无原文 |

### 5.2 错误码（前端必须给中文一句话）

| error | 含义 | 前端文案 |
|:--|:--|:--|
| `turn_in_progress` | 目标会话正在回复/工具中 | 当前会话正在回复，等它结束或换一个会话 |
| `no_material` | 没有可收尾材料 | 这个会话还没有可收尾的对话 |
| `busy_wrap` | 已有收尾在跑 | 上一次收尾还没跑完 |
| `wrap_disabled` | 总开关/自动开关关 | 收尾功能已关闭 |
| `same_material` | 同一材料已收尾过 | 这段已经收尾过了（有新对话才会重跑） |
| `capture_unavailable` | 采集器未就绪 | 采集器未就绪，稍后再试 |
| `unsupported_backend` | http 后端 | 当前后端不支持本地收尾 |

### 5.3 数据模型（schema v6）

```sql
CREATE TABLE IF NOT EXISTS wrap_session_prefs (
  session_id TEXT PRIMARY KEY,
  skip_auto  INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);
```

`wrap_runs.phase` 扩展：`created → distilled → reconciled → done`（旧值兼容；`reconciled` 仅当 Reconcile 跑过）。决策 JSON 存 `distilled_json.reconcile`（断点续跑不再调模型），审计仍只认 `writes` 表。

## 6. 自动化与控制

- 触发源：显式意图（已有）、面板手动（可指定会话）、空闲（需勾选）、会话 dispose（已有，默认关）、可选 `/wrap` 命令（P2，非本期）。
- 空闲判定：`now-lastActivity ≥ idleMinutes` 且该会话无 open turn、有材料、未被跳过、与上次材料 hash 不同。
- 闸门：`wrap.enabled`、`maxRunsPerDay`（默认 6）、单会话同时最多 1 个 run、失败退避（30 分钟后才允许同会话再试）、全局 busy。
- 成本与模型：自动触发默认关，卡片勾选时显示“会花模型 token”；`wrap.provider`/`wrap.model` 可把收尾切到非推理/低成本模型（0.6.7 已落地，本机配 `deepseek-account/deepseek-flash`）；`maxItems`/`maxMaterialChars`/`timeoutMs` 沿用；Reconcile 仅在有候选时调用一次，邻居 topK≤5、单条邻居截断 200 字。
- 峰时抑制（借鉴 meow-memory 的 dream）：可选 `wrap.autoSuppressWindows`（默认空数组，不默认启用），命中窗口只跳过自动触发，手动不受影响。
- 幂等：同会话同材料 hash 只跑一次；进程崩溃后 keeper 续跑；per-session skip 持久化。

## 7. 面板 UX

- 收尾卡片：`会话` 下拉（只列有材料的捕获会话，显示 `最后活动 · 轮数 · 进行中/已跳过`）＋ `立即收尾` 按钮＋ `自动收尾` 勾选（右侧说明“空闲 10 分钟 · 会花 token”）＋ 上次结果行。
- 反馈：成功→“已排队，run #N”＋自动刷新；失败→按 §5.2 的中文一句话（红色，紧贴按钮）；busy→按钮转圈禁用。
- 会话下拉每行有“跳过自动收尾”开关（写 `/wrap/session`），并标注进行中不可手动收尾。
- 报告：沿用按需查看；报告内增加 `decisions` 摘要（ADD/UPDATE/MERGE/ARCHIVE/NOOP 计数），不列原文。
- 设置页：保留既有「收尾沉淀」组；新增“自动触发抑制时段”高级项（默认空）。

## 8. 测试策略

1. 契约单元：`/wrap/sessions` 不泄露正文/标题；PATCH skipAuto 持久化；409 错误码矩阵。
2. Reconcile 解析与校验：坏 JSON→failed 可见；op 白名单；target 跨 identity 拒绝；afterText 超长/带主观前缀拒绝；不确定→REVIEW。
3. 落地集成（假 LLM + 真 writer）：ADD 落 shadow 候选；UPDATE 审计 before/after；MERGE 不新增副本；ARCHIVE 只改状态不删行；保护面→REVIEW。
4. 自动化：idleMinutes=1 的空闲触发、skipAuto 生效且重启后仍生效、同材料幂等、失败退避。
5. UI：卡片渲染冒烟（下拉/勾选/错误文案/报告开关），走现有 client harness。
6. 故障注入：模型超时/坏 JSON/目标节点被删/并发 run，run 终态可见、不写半成品。
7. live（厂长重启后）：3 个会话（短、无材料、长）选择收尾；勾自动+1 分钟验证；审阅一条 UPDATE/MERGE；报告无原文；面板无白屏。

## 9. 风险与回退

| 风险 | 处置 |
|:--|:--|
| 错误合并覆盖好记忆 | 默认 shadow；证据＋时间戳；afterText 需保留旧事实关键词；ARCHIVE 不删行；保护面强制 REVIEW；审阅页 before/after 对照 |
| 模型乱判 | 不确定→NOOP/REVIEW；置信度低于阈值不自动；一次只处理 topK 邻居 |
| 成本失控 | 自动默认关；每日上限；单次 1+1 调用；超时中断；勾选即提示 |
| 并发/崩溃 | 单会话单 run；`wrap_runs` 断点；keeper 续跑；DB 事务 |
| 隐私 | 邻居只取同 identity；报告/日志无原文；spool 0600/TTL |
| 兼容 | schema v6 可空表；无 prefs 行=默认不跳过；`wrap.reconcile.enabled` 默认 false 直到 live 验证 |
| 回退 | S1/S2 独立可回退；S3 关配置即退回 0.6.6 行为；数据回退用动库前备份 |

## 10. 施工阶段（详见施工计划）

- S1 反馈与会话选择（无 schema）→ live 可验。
- S2 自动开关与 per-session skip（schema v6）→ live 可验。
- S3 Reconcile 整合（默认 shadow，配置可关）→ 单测+集成+live 单条审阅。
- S4 归纳/拆分/关键词校正与报告决策摘要。
- S5 发布 0.7.0 + 四件套 + 灾备。

体量预算：新增文件均 ≤350 行；`50-overview.js` 拆出卡片后 ≤300；测试新增文件 ≤800；不动 `distill.js` 判据。
