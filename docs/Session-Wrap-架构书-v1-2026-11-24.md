# 会话收尾沉淀（Session Wrap）· 架构书 v1

> 状态：方案定稿，**代码未动**。本轮只写架构书与施工计划；按厂长令“能留到下一会话的就留”。
> 基线：鲸忆 0.6.3 / DSH 0.2.2-rc.5 / Node ≥22.13。适用对象：本机 DSH Web 的 owner 会话。
> 目标不是“多一个反思按钮”，而是把“会话收尾时该做的记忆工作”收敛成**一次可验收的收尾动作**。

## 1. 问题与现状

现在的 `reflect` 只做“读已有 episodic → 模型提炼 → 写回候选/节点”。它没有：
- 会话材料采集：插件默认不记录聊天，episodic 只来自搜索反哺/导入/面板；
- 收尾触发：只有 30 分钟空闲定时器或手动 `/reflect`，用户说完“收尾”立刻切会话就丢失；
- 证据/置信度/归类：没有“教训/决策/偏好/待办/规则”的分流；
- 收尾报告与交接清单：没有“本轮该更新哪些文档、能否切会话”的结论；
- 记忆清洁编排：巩固/保留/归档各自跑，没有收尾时的统一检查。

`agent/turn-stopping` 与 `agent/disposed` 现在只用于采纳信号结算；`session/disposed` 事件存在但未订阅。`JOB_KINDS` 没有 `wrap`/`distill` 类型。live 当前 `reflect=true`、`write.reviewMode=shadow`，反思产物可能只是待确认候选。

## 2. 目标与验收

目标：
1. 在“用户明示收尾 / 会话空闲 / 会话 dispose / 手动按钮”时，运行一次**有界、幂等、可审计**的收尾沉淀。
2. 产出分三类：记忆候选（默认 shadow）、规则提案（只提案不自动生效）、待办/交接清单；另写一份不含原始聊天的收尾报告。
3. 收尾后执行一次记忆清洁检查（去重、过期、孤儿边、FTS、备份状态），并给出“可切会话”结论。
4. 不阻塞对话；失败可见；无模型/无素材时明确跳过，不写空记忆。
5. 同一会话同一材料只跑一次；进程崩溃可续跑；不把原始聊天长期留在库/备份。

验收判据（下一会话施工时逐条断言）：
- 说“收尾/换会话/记一下这次教训”后，`wrap` job 落库并在面板出现候选；普通问句不触发。
- 空闲 10 分钟、`session/disposed` 各能触发一次；重复触发被幂等键挡住。
- 候选写入 `origin=session-wrap`，默认不进 active；规则句只产生规则提案。
- 模型缺失/坏 JSON/超时 → job `failed/skipped` 且 `/stats` 可见，不伪造成功。
- 重启后 queued/spool 中未完成 wrap 继续跑；临时数据按 TTL 清理。
- 隐私：子代理不触发；跨 identity 不触发；spool 0600、不进灾备；报告中无原始对话。
- 面板可一键“立即收尾”，显示最近一次状态；“可切会话”状态可读。

## 3. 非目标

- 不自动修改项目的任意交接文档（插件不认识各项目文档结构）；只产出结构化收尾报告 + 通用清单，由 agent/人应用。
- 不自动收录/改写铁律；规则仍走现有提案、守卫、plan/apply、人工确认。
- 不做每轮自动总结；不做无模型时的“伪提炼”；不把工具原始输出/思考过程写进记忆。
- 不引入外部服务；不把聊天上传。

## 4. 边界：与现有能力的关系

| 能力 | 现有 | Session Wrap 后 |
|---|---|---|
| 记忆反思 reflect | 空闲定时 + 手动；读 episodic | 保留为“周期性整理”；与 wrap 共用 distill 引擎/守卫 |
| 巩固 consolidate | 6h 去重/边/TTL | wrap 完成后入队一次，作为清洁步骤 |
| 归档 retention | 按天物理删 archived | 保留；清洁报告里展示，不改变用户设置 |
| 规则提案 | 只对用户规则句 | wrap 的 `rule` 类条目走同一提案，不直写 |
| 写入 shadow | 面板/导入/搜索反哺 | wrap 候选也走同一 writer/审核 |
| 交接文档 | agent 手工 | wrap 生成报告/清单；agent 应用，插件不猜路径 |

## 5. 用户流程

```
owner 对话
  ├─ 明示收尾/切会话/“记一下这次教训”
  │     └─ turn-stopping 后入队 wrap（不阻塞回复）
  ├─ 连续 idle ≥ idleMinutes（默认 10）
  │     └─ 空闲调度入队 wrap
  ├─ session/disposed（关闭/归档）
  │     └─ 缓冲区落 spool → 入队 wrap（失败重启续跑）
  └─ 面板“立即收尾”/命令
        └─ 同一条 wrap 管线
wrap：采集 → 证据校验 → 分类 → 写候选/提案 → 报告 → consolidate → 结论
```

同一会话同一 `materialHash` 只允许一条 wrap run；`sessionId + materialHash` 唯一。

## 6. 模块拆分（内部拆，外部一个动作）

新增独立模块，主流程只接线（铁律 2/10）：

1. `src/host/session-capture.js`
   - 订阅 `session/event`（`user/message`、`assistant/message`、`turn/end`），维护每会话有界环形缓冲（默认 20 轮 / 12k 码点）。
   - 订阅 `agent/pre-step` 仅做收尾意图判定（不写库、不调模型）。
   - `agent/turn-stopping`/`session/disposed` 触发 flush/enqueue；子代理、非 owner、无模型直接跳过并记原因。
   - 不把领域正则写进 hook 主流程：意图词表/归一化在 `src/core/wrap-intent.js`。

2. `src/core/distill.js`
   - 纯函数：`buildDistillPrompt(material, opts)`、`parseDistillOutput(raw)`、`validateDistillItems(items, material, opts)`。
   - 与 reflect 共用：reflect 的素材适配成同形状，避免两套提示词/两套校验。
   - 证据校验：每条必须带 `evidence` 原文片段，归一化后必须出现在素材里；否则丢弃。

3. `src/host/session-wrap.js`
   - 编排：快照 material → 创建 `wrap_runs`（幂等）→ 调模型 → 校验 → 路由写入 → 报告 → 入队 consolidate → 更新状态。
   - 由 keeper 的 `wrap` handler 执行；不在 hook 里同步调模型。

4. `src/core/wrap-report.js`
   - 生成 `reports/session-wrap-<日期>-<session>.md`：本轮事实、教训候选、规则提案、待办、清洁结果、可切会话结论；不含原始对话。

5. `src/core/memory-hygiene.js`
   - 只读审计 + 安全清洁：active 同文重复、expired、孤儿边、FTS 对齐、库体积；只对“已存在规则覆盖”的项动手（去重/TTL/孤儿边），不物理删用户记忆。
   - 复用 consolidate 的 SQL/函数，不复制第二套判据。

6. UI：设置新增“收尾”组；概览加“最近收尾”卡；“写入与关系”候选带 `origin=session-wrap` 过滤；按钮“立即收尾”。

## 7. 事件与触发契约

- `session/event`：捕获 `user/message`、`assistant/message`、`turn/end`；这是 material 的唯一来源，避免从 assistant-stream 重新拼。
- `agent/pre-step`：只读最后一条 owner 用户消息做意图判定；命中后设 `pendingIntent`，不立即调模型。
- `agent/turn-stopping`：若 `pendingIntent`，flush material 并 enqueue `wrap`；否则仅更新 lastActivity。
- `session/disposed`：flush 到 spool 并 enqueue；若 spool 失败只记可见错误，不阻塞 dispose。
- 空闲：host 内 60s tick；每会话 lastActivity 超阈值且有 material 时 enqueue；不依赖全局 reflect 的 30 分钟。
- 手动：`POST /wrap`（回环、JSON、写闸同现有路由）+ 面板按钮。
- 触发优先级：显式 > 空闲 > disposed；同一 materialHash 只跑一次。

意图词表（初版，纯确定性）：
`收尾|收工|先到这|今天到这|结束这轮|下次再|换会话|新会话|总结一下|沉淀一下|记一下这次|把教训记下`
排除：问句（`?？|吗|呢` 结尾）、长度 > 80、子代理、引用块、非 owner、明确“不要记/别记”。

## 8. 数据与存储

- `spool/session-wrap/<sessionHash>-<materialHash>.json`：`{sessionId, identity, trigger, turns:[{role,text,turn}], startedAt, endedAt}`；0600；TTL 24h；不进灾备；wrap 成功/失败终态后删除。
- `wrap_runs`（schema v5）：`id, session_id, material_hash, state(queued/running/done/failed/skipped), trigger, job_id, candidates, rule_proposals, report_path, error, created_at, updated_at`；唯一 `(session_id, material_hash)`。
- 报告进 `reports/`；候选/提案走现有 `nodes/writes/proposals`，不新增第二套记忆表。
- 迁移：v4→v5 只加表/索引；迁移前整库快照；失败保留旧 schema 可回滚。

## 9. 提炼契约（防编造/歧义）

一次模型调用，严格 JSON：

```json
{
  "summary": "一句话概括本轮工程结论",
  "items": [
    {"kind":"lesson|decision|preference|fact|open_loop|rule",
     "text":"可复用的短句（≤200 字）",
     "evidence":"素材中的原文片段",
     "confidence":0.0,
     "tags":["topic"]}
  ]
}
```

硬判据：
- `evidence` 归一化后必须出现在 material；否则整条丢弃；
- `rule` 仅当素材里有“以后都/必须/禁止/记成铁律”等规范句；否则降级为 `lesson` 或丢弃；
- 每条 ≤200 字；去重（同文/近文）；拒绝空泛、寒暄、链接堆、纯工具输出；
- 最多 8 条；无有效条目 → `skipped:no_items`，不写空记忆；
- 文本统一“结论/判据/处置”语义，不加“我觉得/可能/大概”；
- 不把模型自己的解释写进条目。

## 10. 分流与审核

| kind | 落点 | 默认状态 |
|---|---|---|
| lesson/decision/preference/fact | `backend.write`，`origin=session-wrap`，tags 含 session/date/topic | shadow 候选 |
| rule | 现有 `createProposal`（source=wrap，原文=text） | 提案待确认；不自动 apply |
| open_loop | 报告 + 面板待办；不写长期记忆 | 仅报告 |
| summary | 报告；必要时一条 `episodic` 摘要（可选，默认不写） | 报告 |

- `write.reviewMode=auto` 也不自动接受 wrap 候选，除非 `wrap.autoAccept=true` 显式打开；默认 shadow。
- 候选必须保留 `sessionId/traceId`，便于回查报告与轮次；报告不含原文。
- 去重/取代交给 writer 的 `text_hash`/关系判定；不另写冲突引擎。

## 11. 反思与清洁

- 反思：wrap 的蒸馏就是一次“针对会话材料”的反思；`reflect` 保留为周期性“对已入库 episodic 的整理”。两者共用 `distill` 引擎与证据守卫，避免口径分叉。
- 清洁：wrap 成功后入队 `consolidate`（去重、topic 边、TTL）+ 只读 hygiene 审计；报告列出：active 数、重复、过期、孤儿边、FTS、jobs 失败、备份是否最新。
- 清洁不自动物理删除用户记忆；retention 仍按用户设置；孤儿边/重复只在规则明确且可回滚时处理。

## 12. 安全 / 隐私 / 失败

- 只处理 owner 会话；`origin=subagent` 跳过；不跨 identity。
- 原始对话只进 spool，0600、TTL、不进灾备；报告/日志只写摘要、数量、session/trace，不写正文。
- 无模型/无 selection → `skipped:no_model`；模型错误/坏 JSON/证据全丢 → `failed` 或 `skipped:no_items`，`/stats` 可见。
- 同一 materialHash 幂等；wrap job 重试最多 3 次；成功后清 spool；失败保留到 TTL。
- 写候选失败不吞：报告列出失败条数；job 不标 done。
- 任何触发/采集异常 fail-open，不影响对话；但必须有日志/counter。

## 13. 配置与 UI

新增组 `wrap`（默认值待施工时定）：
- `enabled=true`（收尾自动；用户可关）
- `triggerMode='explicit+idle+disposed'`
- `idleMinutes=10`
- `maxItems=8`
- `autoAccept=false`
- `spoolTtlHours=24`
- `maxRunsPerDay=6`
- `report=true`

设置页“收尾”组 + 概览“最近收尾”卡：状态/触发/候选数/规则提案数/清洁结果/可切会话；按钮“立即收尾”。首启推荐卡需明确“会花模型 token”。

## 14. 迁移 / 回滚 / 测试

- 迁移 v4→v5：备份 → 建 `wrap_runs` 表/索引；已有节点/规则不动；失败回滚 schema 版本。
- 回滚：关 `wrap.enabled`；清 spool；候选可批量 reject；`wrap_runs` 可保留审计；不影响 recall/rules。
- 测试：
  - 意图判定正/反例（问句、子代理、引用、长度）；
  - session/event 捕获、20 轮/12k 截断、脱敏；
  - 证据校验（编造/缺证据/规范句降级）；
  - 幂等/重启续跑/模型失败可见；
  - shadow 候选 + 规则提案分流；
  - session/disposed/空闲/显式三触发；
  - 报告不含原文、spool TTL/权限；
  - 组件渲染冒烟（设置/概览/候选）；
  - 真机干净安装：说收尾 → 候选/报告/清洁；重启无重复。

## 15. 风险与拒绝方案

| 方案 | 判定 |
|---|---|
| 每轮自动反思 | 拒绝：token/噪声/重复；改为收尾一次 |
| 自动接受候选 | 拒绝：记忆污染；默认 shadow，显式 autoAccept |
| 插件直接改项目交接文档 | 拒绝：不认识项目结构；只出报告/清单，agent 应用 |
| 只靠 reflect 定时器 | 拒绝：切会话即丢；改为事件触发 |
| 只靠 agent/disposed | 拒绝：切页签不一定 dispose；空闲兜底 |
| hook 内同步调模型 | 拒绝：阻塞对话；走 keeper job |
| 新增第二套去重/规则引擎 | 拒绝：复用 writer/rule-proposal |
| 为收尾流程新增铁律 | 暂不：现有 11/12/22 覆盖；先落地功能，连续两次因规则缺失再评估 |

## 16. 施工顺序（详见施工计划）

P1 纯核心（意图/捕获/distill/报告，无 UI）→ P2 持久化（spool/wrap_runs/幂等/空闲/disposed）→ P3 UI/设置/清洁/规则提案接线 → P4 真机验收与文档。
