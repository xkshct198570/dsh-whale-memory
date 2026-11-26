# 会话收尾沉淀（Session Wrap）· 架构书 v1（已落地）

> 状态：**W1–W6 已实现并通过 1011 项测试**（1010 pass / 1 skip / 0 fail）；尚未做 live 重启验证与 0.6.4 发布。
> 基线：鲸忆 0.6.4 工作树（schema v5）/ DSH 0.2.2-rc.5 / Node ≥22.13。
> 适用对象：local / hybrid 后端的 owner 会话；http 后端明确不支持（无本地 run 台账）。

目标不是“多一个反思按钮”，而是把“会话收尾时该做的记忆工作”收敛成**一次可验收的收尾动作**：
显式/空闲/关闭三触发 → 有界采集 → 单次蒸馏 → 证据校验 → shadow 候选/规则提案/待办 → 不含原文的报告 → 只读清洁审计 → 可切会话结论。

## 1. 目标与验收

目标：
1. “用户明示收尾 / 会话空闲 / 会话 dispose / 面板按钮”时运行一次有界、幂等、可审计的收尾沉淀。
2. 产出分三类：记忆候选（默认 shadow）、规则提案（只提案不生效）、待办/交接清单；另写不含原始聊天的报告。
3. 收尾后执行一次记忆清洁检查（FTS、重复、孤儿边、过期、失败 job、备份、库体积），给出“可切会话”结论。
4. 不阻塞对话；失败可见；无模型/无素材明确跳过，不写空记忆。
5. 同一会话同一材料只跑一次；进程崩溃可续跑；原始聊天只短暂存在 spool。

验收判据（已由测试断言）：
- 说“收尾/换会话/记一下这次教训”后 `wrap` job 落库，面板出现 run；问句/否定/引用/外部内容不触发。
- 空闲 10 分钟、`session/disposed` 各能触发；同材料重复触发被幂等键挡住。
- 候选 `origin=session-wrap`，默认不进 active；规则句只产生规则提案。
- 模型缺失/坏 JSON/超时 → `skipped:no_model` / `failed` 且 `/wrap/status` 可见，不伪造成功。
- 重启后 queued/running run 自动补 job 续跑；spool TTL 清理。
- 隐私：子代理/跨 identity 不触发；spool 0600、不进灾备；报告/日志/status/job payload 无原文。
- 面板可“立即收尾”、显示最近状态/可切会话、按需查看报告；收尾候选可过滤。

## 2. 非目标

- 不自动修改项目交接文档（插件不认识各项目文档结构）；只产出报告 + 结构化清单，由 agent/人应用。
- 不自动收录/改写铁律；规则仍走现有提案、守卫、plan/apply、人工确认。
- 不做每轮自动总结；无模型时不“伪提炼”；不把工具原始输出/思考过程写进记忆。
- 不引入外部服务；不把聊天上传。

## 3. 边界：与现有能力的关系

| 能力 | 现状 | Session Wrap |
|---|---|---|
| 记忆反思 reflect | 空闲定时 + 手动；读已入库 episodic | 保留为周期性整理；与 wrap 共用 distill 校验口径 |
| 巩固 consolidate | 6h 去重/边/TTL | wrap 成功后入队一次（已有排队则不叠加） |
| 归档 retention | 按天物理删 archived | 保留；清洁报告只展示，不改用户设置 |
| 规则提案 | 只对用户规则句 | wrap 的 `rule` 条目走同一 `createProposal` |
| 写入 shadow | 面板/导入/搜索反哺 | wrap 候选走同一 writer；单条 `forceShadow` 强制候选 |
| 交接文档 | agent 手工 | wrap 生成报告/清单；agent 应用，插件不猜路径 |

## 4. 用户流程

```
owner 对话
  ├─ 明示收尾/切会话/“记一下这次教训”
  │     └─ pre-step 判定意图 → turn-stopping 入队（不阻塞回复）
  ├─ 连续 idle ≥ wrap.idleMinutes（默认 10）
  │     └─ 60s tick 入队（无进行中 turn、有材料）
  ├─ session/disposed（关闭/归档）
  │     └─ flush → spool → 入队
  └─ 面板“立即收尾”
        └─ 取最近有材料的会话，同一条 wrap 管线
wrap：采集快照 → 幂等 run → 蒸馏 → 证据校验 → 分流 → 报告 → 清洁 → 可切会话
```

## 5. 模块拆分（外部一个动作，内部独立模块）

| 文件 | 职责 |
|---|---|
| `src/core/wrap-material.js` | 纯函数：材料归一、文本渲染、sha256 材料 hash、按整轮裁剪 |
| `src/core/wrap-intent.js` | 纯函数：意图词表/排除/归一；强词歧义按“内容指代”降级 |
| `src/core/distill.js` | 纯函数：提示词、JSON 容错解析、证据校验、去重/降级、摘要压平 |
| `src/core/wrap-report.js` | 纯函数：安全报告文件名（含 runId）、无原文 Markdown |
| `src/core/memory-hygiene.js` | 只读审计：FTS(_docsize)/重复/孤儿边/过期/job/备份/体积 |
| `src/core/wrap-runs.js` | `wrap_runs` 唯一读写入口：幂等键、状态机、重置、查询 |
| `src/host/session-capture.js` | `session/event` 有界缓冲；三触发；意图；隐私脱敏；advance |
| `src/host/session-wrap.js` | 编排：spool→run→job→蒸馏→分流→报告→清洁→结论；对账/TTL |
| `src/host/routes.js` | `POST /wrap`、`GET /wrap/status`、`GET /wrap/report` |
| `src/core/schema.js` | schema v5：新增 `wrap_runs` 表/索引 |
| `src/core/writer.js` / `backend.js` | 单条 `__forceShadow`；候选 accept 保留原始 `origin`；writes 列表带 `origin` |
| `lib/client.js` | 设置“收尾”组、概览“最近收尾”卡/按钮/报告、候选过滤与徽标、首启推荐 |

分层硬约束：意图/提炼/报告/审计是纯核心；host 只做事件与 I/O；模型调用只在 keeper job 中执行。

## 6. 事件与触发契约

- `session/event(session, event)`：捕获 `turn/start|turn/end|user/message|assistant/message`。
  - 只收 `user/message` 且 `source.kind==='user'`（直发人类消息）；`agent.inject`/goal/schedule 等合成 context 不入材料。
  - `assistant/message` 只取 `message.content` 的 text 块；不收思考/工具调用/工具结果。
  - `header.origin==='subagent'` 的会话在入口即丢弃，不占缓冲。
- `agent/pre-step(payload, next)`：先 `next()`；仅当 `decision.kind==='enter'` 且有直发用户文本时做确定性意图判定，记 `pendingIntent`（TTL 10 分钟）；不调模型、不写库。
- `agent/turn-stopping({agent})`：消费 `pendingIntent` → flush + enqueue `explicit`；无意图只更新活动时间。
- `session/disposed(session)`：flush + enqueue；未消费的显式意图优先，否则 `disposed`；失败只记日志，不阻塞 dispose。
- 空闲：host 内 60s tick；无 open turn、有材料、超 `idleMinutes`、自动闸通过才入队；同材料 hash 与上次触发相同则跳过。
- 手动：`POST /wrap` → 采集器 `triggerRecent('manual')`；没有 live 材料返回 409 `no_material`。
- 优先级：显式 > 空闲 > disposed；同一 `(session_id, material_hash)` 只允许一条 run。
- 阈值：每会话最多 20 轮 / `wrap.maxMaterialChars`（默认 12000 码点），按**整轮**裁剪；单条消息截 2000 码点。

意图词（初版）：
- 强词：`收尾|收工|先到这|今天到这|结束这轮|换会话|新会话|下次再聊|下次再说|记一下这次|把教训记下|记录这次|沉淀一下这次|总结一下这次|这轮就到这`
- 弱词：`总结一下|沉淀一下|记一下`（必须带 `这次|这轮|本轮|今天|刚才|本次|会话`，且不含 `文章|代码|文件|文档|这段|这篇`）
- 排除：问句（`?？|吗|呢|么` 结尾）、否定（`不要记|别记|…|先别收尾`）、引用块、>80 码点、子代理。
- 强词 `收尾|收工` 若同时出现内容指代且无会话上下文词，判 `strong_about_content`（“把这段代码收尾”不触发）。

## 7. 数据与存储

### 7.1 `wrap_runs`（schema v5）

列：`id, session_id, material_hash, state, trigger, user_id, role_id, workspace, job_id, attempts, phase,
summary, distilled_json, candidates, rule_proposals, open_loops, report_path, hygiene_json,
switch_ready_json, error, created_at, updated_at`；唯一 `(session_id, material_hash)`；索引 `created_at`、`(state,updated_at)`。

- `state`：`queued|running|done|failed|skipped`；`phase`：`created|distilled|written|reported|done`。
- `skipped` 是有明确原因的正常终态（无模型/无条目/写关闭），不是失败。
- `distilled_json` 保存 `{summary, items:[{...,status}], dropped}`；每条 status 是续跑断点：
  `pending|written|proposal|proposal_rejected:<code>|open_loop|skipped:<code>|write_failed:<reason>`。
- 迁移：v4→v5 只建新表/索引；`openDb` 在版本跨迁前 `VACUUM INTO backup/whale-<ts>.db`。旧代码可忽略新表（不强制回滚）。

### 7.2 spool

- `<dataDir>/spool/session-wrap/run-<runId>-<materialHash>.json`；`{runId, sessionId, identity, header{id,cwd}, trigger, hash, startedAt, material{turns,seqTo,chars}}`。
- 目录 0700、文件 0600、原子写（同目录 tmp+rename）；TTL `wrap.spoolTtlHours`（默认 24h）；`backup-dsh.sh` 明确排除 `whale-memory/spool`。
- 成功/`no_items`/`wrap_disabled` 终态删 spool；`failed`/`no_model` 保留供手动重试；启动 1.5s 后对账，30min 清扫超期文件。

### 7.3 报告

- `<dataDir>/reports/session-wrap-<YYYY-MM-DD>-<sessionHash8>-r<runId>.md`；0600。
- 固定标题：结论 / 记忆候选 / 规则提案 / 待办 / 清洁检查 / 可切会话；不输出原始对话或 evidence 原文。
- 报告名只由固定前缀+日期+hash+数字 runId 组成；读取时 `relative(reportDir, path)` 拒绝越界。

## 8. 提炼契约（防编造/歧义）

一次模型调用，严格 JSON 对象：

```json
{
  "summary": "一句话概括本轮工程结论",
  "items": [
    {"kind":"lesson|decision|preference|fact|open_loop|rule",
     "text":"可复用的短句（≤200 字）",
     "evidence":"素材中的连续原文片段",
     "confidence":0.0,
     "tags":["topic"]}
  ]
}
```

硬判据：
- `evidence` 必须出现在材料（NFKC/空白折叠/小写归一后 `includes`），且 ≥4 码点；否则丢弃 `evidence_not_found`。
- `rule` 仅当 evidence 含规范句标记（`以后都|必须|禁止|不得|别再|一定要|记成铁律|当作规则|定为规则`）；否则降级 `lesson`。
- 每条 text ≤200 字；剥掉主观前缀；拒绝空文本、URL 堆；同文/包含度 ≥0.8 去重；最多 `maxItems` 条。
- 无有效条目 → `skipped:no_items`，不写空记忆。
- 模型超时（AbortController）→ failed `model_timeout`；坏 JSON → failed `bad_json`；重试 ≤4（keeper 退避）。

## 9. 分流与审核

| kind | 落点 | 默认状态 |
|---|---|---|
| lesson/decision/preference/fact | `backend.write`，`origin=session-wrap`，`traceId=wrap:<runId>`，tags 含 session-wrap | shadow 候选（单条强制） |
| rule | 现有 `createProposal`（source=session-wrap，rulesDir 同配置） | 提案待确认；不自动 apply |
| open_loop | 报告 + 面板计数 | 仅报告 |
| summary | 报告 | 仅报告 |

- 0.8.0 起：wrap 普通项走 `ingestPolicy`（`wrap.ingest.mode=auto` 默认）——durable 自动入库，歧义/低置信转候选；`mode=review` 回退全部候选。
- 候选 accept 保留原始 `origin`（不再统一改写 `shadow-review`），受理后可回查来源；旧候选无 origin 仍回落 `shadow-review`。
- `/writes` 返回条目附扁平 `origin` 供面板过滤；不返回整段 payload。

## 10. 幂等、崩溃与续跑

- 触发即 `INSERT OR IGNORE` + 读回；同键 active 不重复入队；done 不重跑；failed/skipped 只在显式/手动触发时重置同一行。
- 入队顺序：建/重置 run → 原子写 spool → keeper `wrap` job（payload 只含 `{runId, spoolPath, materialHash}`）→ 回写 `job_id`。
- 执行顺序：读 run/spool → `state=running,attempts+1` → 蒸馏（有 `distilled_json` 则跳过模型）→ 逐条分流并持久化 item.status → 报告 → 审计 → 终态。
- 写失败：该条保持可重试状态，报告先落盘，run 标 `failed` 并抛错，让 keeper 退避重试；job 不标 done，spool 保留。
- 启动对账：`queued|running` 且没有活 job 的 run，spool 存在则补 job，缺失则标 `failed:spool_missing`。
- 成功后才推进采集缓冲（按 material.seqTo 删已沉淀轮次）；同一材料 done 再次触发也推进，避免旧轮次被下一个 run 重复消费。

## 11. 安全 / 隐私 / 失败

- 只处理 owner 会话；子代理不采集；跨 identity 不触发；spool 存触发时解析的身份三元组。
- 消息入缓冲前过 `privacyCheck`（与写入路径同一脱敏规则）；spool 与模型提示词都拿不到明文密钥。
- 报告/日志/status/job payload 只写摘要、数量、runId/session id；不写正文。
- 报告/状态 GET 在 `panel.allowRemote` 下也拒绝远端读取（回环面板可用）。
- 无模型/无 selection → `skipped:no_model`（保留 spool，手动配置模型后可重置重跑）。
- 写/提案异常不吞：失败条计入 `candidate_write_failed`，run=failed 且 `/wrap/status` 可见；`write_disabled`/`privacy`/`text_too_long` 等永久原因标记 skip 而非失败。
- 任何触发/采集异常 fail-open，不影响对话，但日志可查。

## 12. 配置（默认值即开箱行为）

| 键 | 默认 | 生效 | 说明 |
|---|---|---|---|
| `wrap.enabled` | true | 即时 | 总开关 |
| `wrap.explicit` | true | 即时 | 显式收尾 |
| `wrap.idle` | false | 即时 | 空闲收尾（后台模型调用，默认关） |
| `wrap.disposed` | false | 即时 | 会话关闭收尾（默认关） |
| `wrap.idleMinutes` | 10 | 重载 | 空闲阈值（5–1440） |
| `wrap.maxItems` | 8 | 即时 | 单次最多条目 |
| `wrap.ingest.mode` | auto | 即时 | auto＝价值闸放行直接入库；review＝全部先审（回退 0.7.3） |
| `wrap.spoolTtlHours` | 24 | 重载 | spool 保留 |
| `wrap.retentionDays` | 180 | 重载 | 终态 run/报告保留天数；0=永久；queued/running 不删 |
| `wrap.maxRunsPerDay` | 6 | 重载 | **只限制 idle/disposed**；显式/手动是人工动作不受限 |
| `wrap.report` | true | 即时 | 写报告 |
| `wrap.model` | '' | 重载 | 覆盖模型 id；provider 仍取默认选择 |
| `wrap.maxMaterialChars` | 12000 | 重载 | 材料码点预算 |
| `wrap.timeoutMs` | 60000 | 重载 | 单次蒸馏硬超时 |

- 后台空闲/关闭两路默认关：升级不会在用户不知情时花模型 token；显式收尾是用户主动动作，默认开。
- 首启推荐卡明确“会花模型 token”，取消勾选即关 `wrap.enabled`；已有非默认配置不弹。
- 设置页“收尾”组 13 项；概览“最近收尾”卡；写入页“只看收尾候选（n）”与来源徽标。

## 13. API 契约

- `POST /whale-memory/api/wrap` body `{trigger?:'manual'}`：回环写闸 + JSON 闸；返回 `{ok,runId,state}`；错误码 `wrap_disabled/no_material/turn_in_progress/busy` 409、`unsupported_backend` 501、`db_error` 502、`identity_required` 400。
- `GET /wrap/status`：`{ok,supported,enabled,runsToday,maxRunsPerDay,jobs,latest{id,state,trigger,phase,attempts,createdAt,updatedAt,candidates,ruleProposals,openLoops,switchReady,error,reportAvailable},recent[],spool,capture,lastSkip,lastManual}`；无身份参数看本机最近一条，显式 `userId/roleId/workspace` 则同分区过滤。
- `GET /wrap/report?id=<runId>`：返回 `{ok,runId,text}`；404 `report_missing`，403 `report_path_outside`；远端不可读。
- 未安装 wrap 服务：三类端点 502 `wrap_unavailable`，不抛裸异常。

## 14. 可切会话结论

`switch_ready_json = {ready, blockers[], warnings[], at}`：
- blockers：`report_missing`（要求报告但未落盘）、`wrap_jobs_pending:<n>`（还有别的 wrap job 排队/运行）、`wrap_jobs_unreadable`。
- warnings：hygiene 的 blockers/warnings（如 FTS 未对齐、孤儿边、过期未归档、无备份），只提示不阻塞切换。
- 报告里的“可切会话”不计报告自身（生成时尚未落盘）；最终结论以 run 行与 `/wrap/status` 为准。

## 15. 测试与证据

- 全量：`npm test` → **1011 tests / 1010 pass / 1 skip / 0 fail**（17s）。
- 新增分层：意图/材料/蒸馏/报告/审计单测 49+；采集 11；编排 11；路由契约 6；run 台账 6；真宿主装载 1；客户端渲染冒烟 +2。
- 静态门：`node scripts/check.mjs` E1–E16 全通过；`i18n` 三语 926 键；`manual --check` 一致。
- 关键断言：job payload/status/report 无原文；spool 0600；done 不重跑；断点续跑不重复调模型；写失败 job 不 done；候选 forceShadow；accept 保留 origin；report 越界拒绝；rate limit 只拦自动。

## 16. 迁移 / 回滚 / 风险

- 迁移：v4→v5 加法（新表/索引）；打开前整库快照；失败保留 v4 可回滚。
- 回滚：关 `wrap.enabled` 停新触发；清 `spool/session-wrap/`；候选批量 reject；`wrap_runs` 保留审计；不影响 recall/rules。
- 风险与处置：
  - 误触发 → 问句/否定/引用/内容指代/长度排除 + 单测正反例；
  - 原文泄露 → spool 0600/TTL/不进灾备；报告/状态/日志断言；
  - 模型编造 → evidence 原文校验；无证据丢弃；默认 shadow；
  - token 失控 → 每材料一次、≤8 条、12k 材料、每日 6 次自动、可关；
  - 切会话丢失 → 显式 trigger 在 turn-stopping 入队；spool 兜底；
  - 与 keeper/写队列冲突 → wrap 独立 kind，keeper 不认领 write；交叉测试；
  - 规则被自动改 → 只创建 proposal；
  - 文档交接遗漏 → 报告 + 会话收尾四件套。

## 17. 剩余工作

1. live 重启加载 host 新码（当前 profile 以 link 指向本仓，client 可先于 host 更新；host 重启前 `/wrap` 与设置保存不可用，属预期窗口）。
2. 隔离 home 干净安装验收（tarball 装 local/hybrid，说收尾→候选→报告→重启不重复）。
3. 版本 0.6.4 发布（CHANGELOG/tag/Release/市场索引；不覆盖 0.6.3 资产）。
