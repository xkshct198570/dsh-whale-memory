# Changelog

## 0.8.2 — 未发布（单实例租约 + keeper handler 超时）

- **单实例租约（0.8.1-07）**：新增 `src/core/keeper/lock.js`——`<dataDir>/keeper.lock`（0600）`wx` 独占；存活判据 `kill(pid,0)` + `/proc/<pid>/stat` starttime 挡 PID 复用；死进程/坏文件接管并留日志；`release()` 只删自己的 `instanceId`。`installKeeper` 只在持锁时做 `recoverRunningJobs`；只读进程不复位 `running`、不建定时器、`tick/runNow` 返回可判定的 `locked`，仍可入队由 owner 消费。`advanced.singleInstanceLock`（默认开）关掉即回现状。
- **handler 硬超时**：`advanced.keeperHandlerTimeoutMs`（默认 900000，0=不限）——到点按失败收尾（`handler_timeout:<kind>:<id>:<ms>`、attempts+1 退避、日志），一个卡死的 kind 不再堵住整个队列；迟到结算被吞，不产生未处理拒绝。
- 面板高级组新增两卡（三语）；回归 `test/data/keeper-lock.test.mjs` 6 例。全量 **1252（1251/1/0）**。
- **语义召回（embed）代码层封存**：面板组与概览「待处理」位不再渲染，`vector` job 变零算力 stub（恒 `skipped:'shelved'`），`/stats` 不再全表扫 `vector_pending`；`embed` 配置与 `embedding`/`vector_state` 两列保留免迁移，各处留 `[SHELVED 封存]` 注释指向恢复步骤；三语文案保留。以后可能重启，按延后文档 §1.1 接线。

## 0.8.1 — 2026-11-27（jobs 正文治理 + 日限落库 + 反思身份原因 + 工具分层 + 测试拆分）

- **jobs.payload 正文治理（0.8.1-01）**：新增 `src/core/job-payload.js`——终态判据（`done`，或 `failed` 且 `attempts>=RETRY_MAX_ATTEMPTS`）与 payload 白名单（`reason/sessionId/identity/runId/spoolPath/materialHash/total/result`）唯一真源。终态转移同轮脱敏：keeper `finishDone`/终态 `finishFailed`、写队列 done/最终 failed 不再保留写入正文与 import 的 `jsonl`；`queued`/`running` 与可重排 `failed` 原样保留（续跑证据）。新增 `maintenance` job（启动 +120s、每日一次）修补式扫库清历史正文，并按 `privacy.jobPayloadTtlDays`（默认 0=不删）物理删除超期终态行；面板隐私组新增该开关（三语）。
- **反思自动日限落库（0.8.1-09）**：`keeper.countRuns(kind,{sinceSec,reasons})` 成为唯一计入口；`scheduleAuto` 按 `localDayStart`（本地自然日）统计当日 `reason∈{turn_steps,idle}` 的 `reflect` 行，重启后同日不超限；手动 `manual` 不计入且仍绕过日限；查询失败回落进程内计数并记可见日志。
- **手动反思身份原因（0.8.1-10）**：`/reflect` 400 增机器可读 `reason`（`no_session_identity` / `fixed_identity_incomplete` / `identity_incomplete`）；面板把 `identity_required` 渲染成可行动文案（先发一句话 / 或 fixed+workspace），`reason` 落 `data-reason`；删除死字段 `caps.reflectEnabled` 与重复 `setIdentity`；路由仍拒写未知 workspace。
- **工具写入分层（0.8.1-04）**：`memory_remember` 落 `layerOfMemoryType(memory_type)`（procedural→lesson、semantic→fact；episodic/mixed→NULL）；`memory_update` 仅在正文改写时按目标节点 `memory_type` 重算层，只改等级/标签不动层，不做 NULL 回填；`updateNode` 接受显式 `layer` 并写 `writes.payload.layer` + `evolution('layer')`。
- **测试拆分（0.8.1-05）**：`rules-routes` 1157 / `writer` 974 / `rule-proposal` 849 按职责拆成 5/5/4 片 + 3 个夹具模块（非 `*.test.mjs`）；断言按 AST 逐字节搬移，三组 pass/fail/skip 拆分前后逐项相等（36/45/45）。
- 测试：全量 **1246（1245 pass / 1 skip / 0 fail）**；新增 12 例（jobs payload 6、反思日限 3、反思面板 2、工具分层 1），拆分不增不减。

## 0.8.0 — 2026-11-27（普通记忆自动入库 + 模型记忆工具面 + 分层/首轮画像 + 反思触发与峰时）

- **自动入库**：收尾普通记忆默认走 `process.js` 唯一闸——durable→active；task/stale→REJECT（before/after 均为 NULL，不存正文）；歧义/主观/低置信→审核候选。来源固定 `source=self`（owner 只留给用户手工/导入，避免保护面锁死后续 MERGE）。
- **价值闸/歧义闸**：新增 `src/shared/ingest-policy.js`（纯判据，零 import）与 `classifyDurability`/`detectAmbiguity`；顺序 stale→task 句首/计划句→歧义→durable→uncertain，歧义只返回原因、不改写正文。
- **配置**：新增 `wrap.ingest.{mode,minConfidence,dropTaskInstructions}`（volatile，面板可调）；删除 `wrap.autoAccept` 及三语设置文案。`mode=review` 即 0.7.3 回退（全部影子候选）；启动时幂等清理 profile 里残留的旧键并记 `config_migrated:wrap.autoAccept`。
- **判重**：字符袋相同/语序反转→审核（不 NOOP、不 MERGE）；矛盾先行；新文包含旧文且旧文≥8 字→MERGE（不受 0.85 相似度限制）；近文/疑似改写无增益→审核候选。语义同义判重仍留 0.8.1。
- **计数与报告**：run 落 `distilled_json.counts={ingested,reviewed,skipped}`，`/wrap/status.latest.counts` 同源；面板收尾卡显示入库/待审/跳过三计数；报告只打印待审正文，已入库只列 node id，跳过只列分类码。
- **迁移**：`scripts/migrate-wrap-candidates.mjs`（随包发布）默认 dry-run；`--apply` 自动备份后重放旧候选，原行改 `MIGRATED`，历史 `auto_ingested:%` REJECT 归一；靠 `trace_id=migrate:*` 排除自身产物，两遍幂等。
- **模型记忆工具面（S2）**：新增 `memory_remember / memory_search / memory_read / memory_update / memory_forget`（`src/host/tools.js` + `tool-output.js` / `tool-errors.js` / `tool-rate-limit.js`）。身份固定当前会话，缺会话 cwd 一律 `IDENTITY_REQUIRED`；跨分区 id 按不存在（`NODE_NOT_FOUND`）；remember 走与收尾同一 `ingestPolicy`（含 `wrap.ingest.mode=review` 回退），任务/一次性句抛 `NOT_MEMORY`，歧义/保护面转 CANDIDATE；update 有 CAS（`NODE_CHANGED`）、保护面/重复正文分别拒；forget 只归档不物理删。
- **限次与开关（S2）**：每回合 `remember/update/forget` 写尝试上限 `tools.maxWritesPerTurn`（默认 5，第 6 次 `RATE_LIMITED`，turn 变化清零）；`tools.enabled=false` 或子代理会话时调用被拒（`TOOLS_DISABLED`/`SUBAGENT_FORBIDDEN`，live rc.5 准入不调用 `when`，执行期闸为真关闭）；设置页新增「模型工具」组（三语）。
- **审计与重构（S2）**：`updateNode` 审计行补 `writes.payload.origin`（面板/同步/工具三口径）并复用 `isProtectedTarget`（删除抄写）；`writePayload` 抽成唯一构造；tags 归一/解析移到 `src/shared/tags.js`（关系层再导出）；`write()` 透传 reason。
- **分层与首轮画像（S3）**：schema v7 `nodes.layer`（`fact|lesson|user`，加法列、旧行 NULL、不加 CHECK）；收尾 kind→layer 单一映射（`lesson→lesson`、`decision/fact→fact`、`preference→user`、rule 无）；`validLayer` 唯一白名单（写入/导入共用），落列只在 `writer.process.insertNodeRow`；MERGE 保留目标 layer、SUPERSEDE 用本次事件 layer；导出末尾补 `layer`、导入补列/绑定（旧 JSONL 按 NULL 保真）。
- **迁移 fail-closed（S3）**：迁移前快照失败 → `migration_backup_failed:<reason>` 且**不执行迁移**（`backend.ready=false`，原因进程内记忆、修好磁盘不自动重试，重启才重试）；`/stats` 返回 502 带完整原因（`backend.ready=false`），`/version` 阻断期间仍 200。
- **首轮画像（S3）**：新增 `src/host/profile-context.js`——会话首轮把同身份 `user` top5 / `lesson` top5 / `fact` top3（`pinned DESC, weight DESC, updated_at DESC`）渲染成 ≤800 码点的「长期画像」，`systemPrompt.context` name=`whale-memory:profile`、order=129、零 IO 装配；每会话一次、第二轮不再出现，子代理/身份不可判定/中止跳过，失败只记日志，缓存上限 200 并随 `agent/disposed` 清理。
- **身份判据收敛（S3）**：`sessionIdentityOf`（会话 cwd 派生 + `resolveIdentity`）与 `isDelegatedHeader` 收敛到 `identity.js` 唯一实现，工具与画像共用。
- **S3 复核修复批**：候选转正保分层（`writes.payload.layer` + `acceptCandidate` 还原）；迁移 fail-closed 判据改 `schemaStateOf`（版本行缺失/版本与列形态不符也必须先快照，空库不空快照）；落列点 `insertNodeRow` 再过 `validLayer`（门面直出 `processEvent` 也不能写脏值）；hybrid 透传 `profileLayers`/`openError`，http 无能力时安装即跳过；子代理判据收敛（hook/session-capture 改用 `isDelegatedHeader`）；画像在 `turn/end` 就摘 `active`（rc.5 assemble 先于 pre-step，防第二轮装配期带旧画像）、查询 await 后被中止不写缓存；迁移阻断原因在 `/stats` 与 `/nodes`/`/write` 等数据路由统一 `migration_backup_failed:<reason>`；分层词汇收敛 `src/shared/layers.js`。
- **身份四态裁定（S4）**：`auto` 不再在宿主 `deepseekAccount` 身份未就绪时回落 Config/`local`——`identity-source` 暴露 `absent/pending/empty/ready` 四态，只有 `absent`（老宿主无账号服务）允许回落；`pending/empty` 一律 `identity_required`，杜绝同 workspace 在启动窗口写两个分区（live 实测 6+15 条并存）。收尾/工具/反思/画像统一 `sessionIdentityOf`，`hook`/`session-capture`/`search-feed` 收敛同一判据；`identityState.lastRecall` 增 `sessionId`；`workspace=''` 不再是合法写入分区（规则镜像/导入/控制面例外）。
- **反思触发（S4）**：新增 `src/host/reflect-trigger.js`——`agent/pre-step` 维护 `(turn,step)`，`tools/result` 标记非 memory 工具活动（排除 `memory_*`/`run_code`/委派/PTC 子调用），turn 结束或下一 turn 预步骤评估 distinct step 数，`≥7` 触发一次；abort/error 由下一 turn 补评估；子代理不计数；会话状态有界淘汰。
- **反思身份四点（S4）**：keeper handler 改 `(payload)=>run(payload)`；空闲 tick 与 turn 触发 payload 显式带 `{identity,sessionId,reason}`；`runReflect` 双验 `userId && workspace`（缺→`identity_required` 不写库）；`run()` 不再现取 Config 身份；空闲只用最近会话身份，无会话身份就跳过。
- **峰时/日限单一闸（S4）**：`scheduleAuto` 统一 `reflect.enabled`（默认 false）/队列已有/本地自然日日限/`maintenance.suppressWindows`（本地时区 `HH:MM-HH:MM`，跨午夜、坏值 fail-open 并记一次日志）；空闲与 turn 触发共用；手动 `/reflect` 绕过峰时/日限但仍要求身份，无 workspace 返回 400 `identity_required`。
- **反思落库（S4）**：`source='self'`、`origin='reflect'`、`ingestPolicyOf(wrap.ingest,{confidence:1})`（`wrap.ingest.mode=review` 时反思同样只产候选）；`memory_type` 按 `LAYER_OF_TYPE` 落 `lesson/fact`（反思教训可进首轮画像）；日志只记 `added/review/rejected` 计数，无正文。
- **S4 对抗复核修复批（独立第二执行体）**：身份源「曾 ready 后服务消失」不再改判 `absent` 回落 Config（保留最后已落定态，`absent` 只给从未见过服务）；身份读取加 4s 超时并按异常进 `pending` 重试；登录/登出 phase 迁移留无正文日志。反思写库区分条目级拒绝与基础设施失败（队列超时/落库失败计 `failed`，`runReflect.ok=false`，keeper handler 抛出退避，不再标 done）；NOOP 计 `duplicate` 不再冒充 added；`llm_unavailable/no_model/memory_pressure` 早退留日志。`reflect-trigger` 不足 7 步不锁存（steer 续跑同一 turn 不丢触发）。`/reflect` 只接受最近会话身份，仅 fixed 允许固定身份兜底（auto 的 local 兜底不得触发写）。`keeper.countActive(kind)` 精确判断队列已有；hybrid `listEpisodic/reviewWrite` 透传身份 opts；`maintenance` 注释收敛为只抑制自动反思。提示/解析拆 `src/core/reflect-prompt.js`（纯函数）。新增真库行级回归 `test/data/reflect-ingest.test.mjs`（nodes/writes/payload 对账）与身份消失/超时/迁移、真并行、steer、失败计数等 12 例。
- **S5 收尾（0.8.0）**：`51-wrap-card` 拆成 actions/报告/设置三片（主体 150 有效行 ≤350，行为等价、渲染冒烟 12 例 + client 38 例全绿）；新增拆分拓扑用例（三片登记/职责首行/主体不再复写实现/≤350，有效行由 `scripts/lint-size.mjs` 计）。
- **反思峰时窗口面板（P2-8）**：设置 →「反思」新增「反思峰时窗口」文本卡（`maintenance.suppressWindows`，本地时区 `HH:MM-HH:MM`、跨午夜、运行期坏值 fail-open），保存按行 trim/去空行且只提交差异叶子；三语新增文案；`reflect.enabled`/分组说明口径改为「≥7 工具步或空闲自动、手动不受开关限制、峰时只抑制自动」。
- **测试双件抽共享**：`test/client/render-harness.mjs` 统一最小 React/hooks + fetch/localStorage 桩；修两处保真坑——`props.children`（FieldCard 渲染函数）不再被空 variadic 覆盖（此前设置卡在冒烟里恒空＝假绿），`useEffect` 遵守 deps（避免 mount 重跑加载 effect 把 draft 覆盖回服务端值）。
- 测试：全量 **1231（1230 pass / 1 skip / 0 fail）**（S5 收口后）；新增写入闸 §7.1 十二条 + §7.2 判重、dispatch/reconcile 集成、迁移幂等、配置清理用例、工具面 19 例、真注册表 1 例、审计来源 3 例、schema v7 7 例、layer 数据面 5 例（含候选转正/门面兜底）、收尾映射 2 例、画像 17 例 + 真库端到端 + 真 SystemPrompt 机制、分层词汇 3 例、身份矩阵/四态 3 例、hybrid 画像 1 例、反思触发矩阵 7 例、反思调度/计数 7 例、峰时窗口 3 例、搜索反哺身份会话分区 1 例。

## 0.7.3 — 2026-11-26（面板页签不可见修复）

- 修复：面板六个页签在 0.7.x 后整行不可见（只剩 8px 空白）——S1 把 `tabs` 改为横向滚动（`overflowX:auto`）后，作为 flex-column 面板的 flex 子项，其自动最小高度变为 0，被固定高度父容器压成 0 高；`overflowY:hidden` 再把文字裁掉。表现为记忆库/规则/召回/写入与关系/设置全部“消失”。
- 修复：`tabs` 显式 `flexShrink:0` + `minHeight:36px`；`tab/tabActive` 显式 `display:inline-flex`、`height:28px`、`box-sizing:border-box`、`lineHeight:18px`，不再依赖宿主 button 重置。选中页签加 `fontWeight:600`。
- 回归：渲染测试断言 nav 不可压缩、六页签齐全且盒高 28px；真机 1280×800 复核六页签可见可点。
- 测试：全量 1103（1102 pass / 1 skip / 0 fail）。

## 0.7.2 — 2026-11-26（反思产出修复）

- 修复：反思（reflect）输出同时累加 `text-delta` 与 `block-end.text`，JSON 被拼两遍 → `parseReflectOutput` 解析为空 → 真机 47/47 次 `items=0`。改为“有增量用增量，无增量用整块”，与收尾蒸馏同口径。
- 修复：反思输出预算 1200 → 8192。默认推理模型把思考计入 `maxTokens`，1200 会被思考吃光、正文为空；日志补 `textLen/reasoning` 便于归因（不记正文）。
- 修复：正文非空但解析为空时按收尾口径重试一次（只追加“只输出 JSON 数组”约束）；空正文单独给诊断日志，不再静默 `items=0`。
- 测试：新增“delta+block-end 不得拼两遍”回归；全量 1102（1101 pass / 1 skip / 0 fail）。

## 0.7.1 — 2026-11-26（收尾卡可用性热修）

- 修复：**回合进行中点击「立即收尾」不再被 `turn_in_progress` 拒绝**——手动收尾允许按“此刻快照”入队（202 + 进度），未结束回合的材料由队列稍后执行；自动空闲触发仍跳过 open turn，不会误收半轮。
- 修复：只有进行中会话、没有已结束回合时，`triggerRecent` 也取最近会话快照（旧逻辑直接 409，表现为“点了没反应”）。
- 修复：收尾卡自动开关优先读 `/wrap/status.auto`（`/wrap/sessions` 尚未返回时不再显示成关闭）；会话/状态最多 10s 刷新一次，新会话不必等 60s；`/wrap/sessions` 失败两次后显示中文错误行，不再静默空列表。
- 测试：新增“只有进行中会话也可手动快照入队”回归；全量 1101（1100 pass / 1 skip / 0 fail）。

## 0.7.0 — 2026-11-26（Session Wrap v2：会话选择/排队/自动开关/整合）

- **会话选择**：面板收尾卡新增“会话”下拉（只列有材料的采集会话，显示轮数/进行中/已跳过）；`POST /wrap {sessionId}` 指定会话收尾；`GET /wrap/sessions` 无正文/标题/cwd。
- **点击即排队（S1b）**：运行中点「立即收尾」返回 **202 入队**（不再报 `busy_wrap`）；同材料幂等 200、同会话第二条 409 `session_queue_full`、全局满 409 `busy_queue_full`；卡片显示排队位次与阶段进度点；进程重启队列清空并以 `queue_cleared` 明确提示。
- **自动开关与 per-session skip（S2，schema v6）**：卡片可直接勾「自动收尾」（写 `wrap.idle`，标注会花 token）；每个会话可“跳过自动收尾”（`PATCH /wrap/session`，落 `wrap_session_prefs`，重启保持）；`latest.retrying` 显示“正在重试 N/4”。
- **整合 Reconcile（S3/S4，默认关）**：`wrap.reconcile.enabled=false` 时行为与 0.6.10 完全一致；开启后把候选与同身份既有记忆比对，产出 ADD/UPDATE/MERGE/ARCHIVE/NOOP/REVIEW 决策与改写短语义，默认只产影子候选/审计（ARCHIVE 只改状态不删行，保护面拒绝）；支持跨候选合并（同主题多条→1 条）与 level/类型/tags 校正；报告新增“整合决策”计数段（无正文），卡片报告可复制/下载 .md。
- **身份与安全修复**：身份对象存在即三列必过滤（空串是分区而非“不过滤”，修复跨工作区列表/详情/导出）；保留期清理在身份不可判定时拒绝执行且删除前必备份；HTTP 导入强制请求身份；`/import/status` 与 `/wrap/report` 显式身份作用域；allowRemote 远端读面新增 config/writes/import-status/wrap-sessions 拒绝。
- **数据完整性**：迁移去重与巩固收敛共用质量序（高信任行不再被顶掉）；每日配额只数 ADD/MERGE/SUPERSEDE；节点落库与 writes 审计同事务；auto MERGE 补 evolution；openDb 失败关连接；启动回收不抢 write job。
- **门禁**：`lint-size` 接入 pretest/CI 并刷新基线；`AGENTS` 陈旧自愈加退避（不再每步重渲染）、规则 mtime 复用单次扫描；测试计数基线锁死。
- 测试：全量 1100（1099 pass / 1 skip / 0 fail），`check.mjs` E1–E17、check-deps 0 环、pack 权限 644。

## 0.6.10 — 2026-11-26（收尾正文双写修复；本地未推）

- 修复：`collectModelText` 同时累加 `text-delta` 与 `block-end.text`，正文被拼两遍（真机 run6：textLen 2804 ≈ JSON 1400 的两倍），`parseDistillOutput` 取“首个 { 到末个 }”跨两段 → 恒 `bad_json`。口径改为“有增量用增量，无增量才用整块”。
- 回归：新增“delta+block-end 不得拼两遍”用例；全量 1049（1048 pass / 1 skip / 0 fail）。
- 佐证：同一素材用同模型单跑一次，输出是合法 JSON（3 条 items），说明模型没问题、问题在采集。

## 0.6.9 — 2026-11-26（收尾输出预算 32768；未推 GitHub）

- 修复：蒸馏输出预算 8192 → 32768。真机证据（deepseek-account/deepseek-flash）：reasoning 12,752–17,334 字符 + 正文 4,140–4,718 字符，8192 仍被思考截断 → `bad_json`。
- 说明：收尾低频（自动默认关），一次装下“思考+JSON”；超预算仍会截断且日志提示换非推理模型。
- 该版本按厂长令**只留本地**，等 Session Wrap v2 完善后再推 GitHub；测试 1048（1047/1/0）。

## 0.6.8 — 2026-11-26（wrap.provider 投影修复）

- 修复：`wrapCfg()` 未把 `wrap.provider` 投影给蒸馏阶段，配置了也被会话选择覆盖（真机 01:44 run4 日志 `model=gui-ji-liu-dong/deepseek-flash`、正文/思考均为 0）。
- 回归：新增“cfg.provider 必须传到 llm”用例；测试 1048（1047 pass / 1 skip / 0 fail）。

## 0.6.7 — 2026-11-26（收尾模型可分离＋推理占优诊断）

- 新增 `wrap.provider`：收尾蒸馏可单独指定模型供应商（`wrap.model` 已有），默认空=沿用当前会话选择；本机默认对话模型是推理档，思考会吃光输出预算（真机：attempt1 textLen=2526/reasoning=8542，attempt2 textLen=0/reasoning=9371）。
- 蒸馏输出预算 4096 → 8192（给推理模型留余量）；失败日志在思考字数超过正文时追加提示，建议换非推理模型。
- 测试：1047（1046 pass / 1 skip / 0 fail），新增 provider 覆盖断言。

## 0.6.6 — 2026-11-26（Session Wrap 蒸馏健壮性修复）

- 修复：蒸馏请求输出预算 1800 → 4096。默认模型是推理档（high 思考计入 maxTokens）时，1800 会被思考吃光、真机 4/4 次 `distill_bad_json`。
- 修复：首答不是合法 JSON 时自动重试一次，重试提示只追加“只输出一个 JSON 对象、第一个字符必须是 {”，不改素材与证据判据。
- 诊断：失败日志只记模型、文本长度与思考字数（不记输出正文），面板「最近失败」仍可见失败，不静默。
- 测试：1047（1046 pass / 1 skip / 0 fail），新增蒸馏重试/预算/思考计数 4 例。

## 0.6.5 — 2026-11-25（内部重构，零用户可见行为变化）

- 内部重构：按职责拆分源模块并固化构建/门禁（`rules`/`writer`/`backend`/`routes`/规则路由；门面降为纯 re-export + 导出面机检 E17 + shared-drift 差异审计 + 包清单闸 JSON 化）。
- 接口、数据模型、配置项与面板行为不变；测试基线 1043（1042 pass / 1 skip / 0 fail），`check-deps` 109/335、E1–E17 全绿，client 产物 sha `2c30735a…` 不变，`npm pack` 170 项/778,239 B。

## 0.6.4 — 2026-11-24（R12 会话收尾沉淀）

- 新增 Session Wrap：显式（“收尾/换会话/记一下这次教训”）、空闲（默认关，可在设置打开）、`session/disposed`（默认关）、面板「立即收尾」四入口走同一条有界管线：采集最近 20 轮/12000 码点 → 单次模型蒸馏 → 原文 evidence 校验 → shadow 候选/规则提案/待办 → 不含原文的报告 → 只读清洁审计 → 可切会话结论。
- 数据：schema v5 新增 `wrap_runs`（唯一 `(session_id, material_hash)`，状态机 + `phase` + `distilled_json` 断点）；迁移前整库快照；`wrap` 成为 keeper 第 8 种 job，原始材料只进 0600 spool（TTL 24h、不进灾备），崩溃后启动对账补 job、终态删 spool。
- 写入：新增单条 `forceShadow`，即使全局 `write.reviewMode=auto`，收尾候选仍进 shadow；候选 accept 保留原始 `origin`（不再统一改写 `shadow-review`），`/writes` 返回扁平 `origin` 供面板过滤。
- 安全：只处理 owner 会话、子代理不采集；消息入缓冲前复用 `privacyCheck` 脱敏；报告/状态/日志/job payload 无原文；报告读取用路径相对性拒绝越界；allowRemote 下收尾状态/报告也拒绝远端。
- 触发体验：入队后主动踢一次 keeper tick，「立即收尾」不再等 10 分钟定时器；`wrap.retentionDays=180` 清理超期终态 run 与不再被引用的旧报告（queued/running 永不删）。
- 客户端：生成的 locale 块由 2782 行压缩为单行紧凑数据，`lib/client.js` 从 9745 降至 6971 行（源码逻辑未变）。
- UI：概览「最近收尾」卡（状态/触发/候选/提案/待办/可切会话/错误/立即收尾/按需查看报告）；设置新增「收尾沉淀」组 13 项；写入页「只看收尾候选（n）」与来源徽标；首启推荐卡明确会花模型 token。
- 规则：收尾的 `rule` 条目只走 `createProposal`（source=session-wrap），不自动 apply；无规范句证据的条目降级为 lesson。
- 失败语义：无模型 → `skipped:no_model`（保留 spool，可手动重试）；坏 JSON/超时 → failed 重试；候选写失败 → run=failed 且 job 不标 done，报告先落盘；`write_disabled/privacy/text_too_long` 等永久原因标记 skip 不重试。
- 测试：1011（1010 pass / 1 skip / 0 fail）；新增意图/材料/蒸馏/报告/审计/台账/采集/编排/路由/真宿主/渲染冒烟；E1–E16、三语 926 键、manual 生成块全绿。
- 契约变更（同轮测试同步改写）：`JOB_KINDS` 增加 `wrap`；schema 版本 5；shadow accept 的 `origin` 保真；`SETTINGS_META` 67 字段/14 组。

## 0.6.3 — 2026-11-24（R11 设置体验、使用说明、铁律重编 + 上架前审查修复）

- 设置首启推荐：全新安装且配置全为默认值时出现「推荐配置」卡；应用只提交与基线不同的叶子，跳过/保存过就不再出现；已有配置不弹、不覆盖。同步推荐以 `dryRun=true` 起步（先记录待同步项、不改远端），反思需模型才建议开；四个需外部条件的开关带「推荐开启」徽标。
- 设置信息架构：分组顺序改为召回→写入→身份→规则→接入→同步→反思→巩固→隐私→边界→面板→高级→未启用能力；首屏只展开前四组，其余折叠并记住展开状态；危险区恒展开。
- 布局根因修复：设置输入框不再在 column 容器里继承 `flex-basis:220px` 被拉成方块；分组 grid 改 `align-items:start` 不再把矮卡拉高；数值输入限宽 180px；卡片高度自适应。规则/候选编辑表单同步受益。
- 小白说明书：新增 `docs/MANUAL.zh.md`（7 节：上手/日常/页签/8 个设置/术语表/FAQ/排障）+ `scripts/manual-build.mjs` 生成离线常量块 + 页头「使用说明」按钮与可滚/Esc 关闭抽屉 + 设置页术语表入口；CI 与静态门（E16）校验 MD 与生成块一致。
- 铁律重编：21 条按「何时/做什么/怎么判」重写（≤500 码点，无历史由来段）；铁律 8 并入 7（`merged_into`，编号不复用），其余候选按判据不合并并在交接说明理由；`defaults/rules` 同步为 20 文件（19 带号 + safety，含 21/22），本机专用 13 同步 v2。
- 修复：`mirrorStatus` 把 `front.updated` 日期按 UTC 零点当时刻比较，UTC+8 凌晨会「刚重建完仍全量 stale」；`write.ignorePatterns` 从假开关接线为真实忽略规则（命中写 REJECT/ignored 审计，坏正则不阻断其它写入）；规则镜像文案改为「供面板检索，召回不读」；干净安装摘要计数按链终点断言。
- 性能：召回扩散排除规则镜像改由 SQL（`origin NOT LIKE 'rule:%'`）直接过滤，去掉每轮全表拉 id 集合。
- 测试：911（910 pass / 1 skip / 0 fail）；新增 WP1/WP2/WP3 契约断言、忽略规则与 mirror 日期回归。
- 上架前独立审查修复（P1/P2）：
  - 安全：`allowRemote` 改为 peer 硬闸 + 只读端点白名单；伪造本机 Host 不再获得写/改配置/跨分区权限；远端只读检索保留、整库导出与所有写入口拒绝。
  - 数据：写队列成为 `write` job 唯一消费者（keeper 不再抢占导致“标 done 但零落库”）；失败按 1m/5m/30m 在队列内重试；反思按当前身份取 episodic 并写回同分区；hybrid 远端无采纳回写时不再错写本地；巩固去重豁免规则镜像；扩散邻居按 conf 排序后再截断；节点分页补稳定次序。
  - 规则：序列化后自检解析（含 Windows 路径尾反斜杠），不再产出自己读不回的文件；恢复事务持仓库锁；`requireGit` 不满足时 health 红。
  - 面板：首启推荐卡恢复出现（`dataDir` 顶层键不再恒判非默认）；详情保存回写新 `updated_at`，连续保存不再 409；状态下拉不再提供必失败的 `superseded`。
  - 契约：列表端点缺省 limit 恢复声明值；错误码表与路由状态码对齐；畸形节点 id 返回 400 而非 502。
- 打包与发布：Node 引擎改为 `>=22.13.0`（`node:sqlite` 去 flag 的最低版本）；包内不再夹带内部施工计划与截图；补 repository/homepage/bugs；新增 tag→Release 工作流（固定资产名 `dsh-whale-memory.tgz`）。

## 0.6.2 — 2026-11-24（未发布 · R10 数据不变式与安全收口）

严苛自审后的修复批：把“看起来正常、实际静默失效”的坑逐条收口，并补回归测试。
- schema v4：`nodes` 活跃同文唯一索引（部分索引，规则镜像 `origin=rule:*` 豁免）；迁移前先收敛旧重复行（保最早，其余 superseded 并指向规范行），迁移前整库快照由 v3→v4 触发。
- `withTx` 只把“已在事务内”当嵌套；锁冲突/只读/磁盘错误不再被吞成无事务执行（审计 P1-4）。
- 影子审核：accept 必须带当前身份，候选/目标均校验身份三列与 `status='active'`；跨分区 id 返回 `candidate_not_found`，失效目标 `target_not_active`。
- 写队列：唯一索引竞态（后到的同文 ADD/MERGE/SUPERSEDE/REVIEW）回落 NOOP/MERGE 语义，不再让 job 永久失败；`enqueue` 增终态扫地机，跨 drain/跨进程抢先处理也会结算 waiter（120s 上限）。
- 可观测：FTS 查询失败计数进 `/stats health`；`ready` 改为真探测；打开库先 `PRAGMA quick_check`，坏库改名隔离（保留现场）并记录；新增写/召回/作业/边索引。
- 异步导入落 `jobs.payload`（cursor + 统计），崩溃后由 keeper `import` handler 从断点续跑；状态接口不再回传 4MB jsonl。
- 规则仓：首播先写 `status:'seeding'` marker，中断后只补 planned 里缺失 key（不再“盘上任意规则=已采纳全部”）；`duplicate_key` 跨根/proposals 进红项，purge 同名旧候选一并删；空规则列表也跑镜像归档孤儿；AGENTS 无管理标记与僵尸锁进 health 黄灯；`restoreDefaultRule` 落地（清墓碑 + allowShrink 重建 manifest）。
- 配置保存：按叶子合并并保留 cosmokit Volatile Ref 引用身份（宿主后续 volatile 更新不再静默失效）；面板只提交与基线不同的叶子。
- 召回 context order 100→130（避开宿主 WORKING_DIRECTORY 保留位）；`updateNode` 增 updated_at CAS；邻居注记查询固定排序。
- 文档：`defaults/README.md` 计数改为 18 文件/17 编号；README 的 allowRemote 口径改为“只放行 webServer 绑定地址”。

## 0.6.1 — 2026-11-23（未发布 · R9 稳定性修复）

真机链路与写不变式（架构书 v3.9 / 计划 v1.9 的 R9-01/02/03）。
- hook：提案检测调度改宿主无关 `setImmediate`，不再读取 `ctx.setTimeout`（cordis `timer` accessor，未 inject 即抛 → 真机聊天提案 0 次成功）；日志拆 `pre-step fail-open` 与独立 `rules proposal fail-open`。
- rule-store：编号占用真源 = `iron-rule-<n>.md` 文件名编号 ∪ 解析成功 front 编号 ∪ 墓碑（非法 front 文件也占号，create 不再复用编号/覆盖原文件；>999 文件名不锁死分配）；manifest / `/rules/health` / 列表 nextNumber / plan / 提案同口径。
- rule-store：写失败四处回滚（文件 / manifest / history / git index）；正文与 history 快照 durable 写（fsync）；非降级 commit 失败返回 `commit_failed` 并回滚，不再 `ok:true` 丢提交；history ENOENT 视为已回滚。
- 契约变更（测试语义同步改写）：提案期 `draft.number` 与 manifest 同口径（文件名∪front∪墓碑），不再『先按 active 给号、apply 才顺延』；`rule-proposal` 相应用例按新契约改写（断言 draft=4 而非 3+顺延）。
- 测试：808（807 pass / 1 skip / 0 fail），新增 `rule-store-r9`（编号占用/manifest 半写/commit 回滚/fsync/>999/提案同口径）与 `proposal-scheduler`（Proxy 复刻 cordis accessor + 失败标签）回归。

## 0.6.0 — 2026-11-22（规则化 · 文件卫生 · 已发布）

规则真源从数据库迁到本地 git 规则仓（`~/.dsh/rules/`），DB 只做镜像；提案制（识别→编译→关系判定→守卫→用户确认→git commit→渲染/镜像）。
- `src/core/rule-store.js`：YAML 子集 front matter、严格校验、原子写、history 快照（20/key）、manifest 编号（空号 6 不复用）、git commit/log/show/revert、同 key 跨进程锁。
- `rule-reconcile.js`：结构化编译（模态/动作/对象/条件/例外，主句完整性/例外吞没拒绝）、确定性关系判定（new/duplicate/refine/merge/conflict）、LLM 只改措辞的守卫校验。
- `rule-proposal.js`：候选、30 天冷却、拒绝、单一 apply 事务（文件+git commit+镜像+AGENTS+审计+失败回滚）、会话确认。
- `rule-render.js`：AGENTS 摘要管理块（一行一条，全文≤200 字+文件指针），无标记绝不追加；台账渲染函数保留未接线（避免双源）。
- `rule-mirror.js`：文件→nodes 镜像（origin=`rule:<key>`），孤儿归档；`git-detector.js`：git 三态检测+安装指引+requireGit 闸门。
- hook：作用域规则注入（workspace/role，global 靠 AGENTS 摘要）、提案提示、确认自动收录、启动自愈镜像/摘要。
- 路由：rules 列表/详情/git-status/rebuild/import-legacy/propose/apply/reject/render-agents/update/diff/versions/revert。
- UI：新增「规则」页签（规则库/待确认/历史）、提案收录/改写/拒绝、编辑/diff/回滚、Git 状态条与安装指引、设置「规则」组 11 字段；三语 812 键。
- 文件卫生：配套 `~/ops/file-hygiene.mjs`（scan/trash/purge/extract-check/backup-check）与灾备排除项；铁律 17 入台账。
- 测试 799（798 pass/1 skip）；干净 profile 单装/共装归档证据 5/6（whale/persona/both 的目录/部分 tarball 源；6/6 待 R9-15 重跑）；旧 `~/ops/dsh-blank-install-test.mjs` 本轮未复跑。
- 默认铁律：`defaults/` 内置 16 条通用默认铁律（1–5、7–12、14–17 + 无编号 safety；铁律 13 为本机对照组专用，留在本地仓，不进公开包）。首次启动自动播种到空规则仓并单次 commit；`.seeded.json` 标记保证用户删/停用后不复活。
- 规则管理：`POST /rules/create`（自动编号，铁律 1–17 占用后从 18 起）、`POST /rules/delete {mode:retire|reactivate}`（保留文件/编号/历史）；面板新增「新建规则」、详情「停用/重新启用」、默认铁律徽标与说明。
- R8 返工：plan/apply（planHash+oldHash CAS、逐文件守卫、.txn 崩溃恢复、仓库锁、显式 git paths）、墓碑独立 `retired/`、编号只归铁律、镜像退出召回、摘要单行/标记防御、CSRF/JSON 闸、`/rules/health`、UI needs_manual/历史/默认徽标。

## 0.5.1 — 2026-11-22（采纳信号 · 后端与集成 · 未发布）

审计 backlog P1「回复引用信号（used 恒 0）」落地：注入 ≠ 采纳，之前 adoptionRate 恒 0、未采纳 Top10 等同全部已注入查询。
- 新增 `src/core/adoption.js`（无 IO 判定层）：原文 10 字窗口命中（强证据）或中文 bigram 覆盖率 ≥0.6 且 ≥5 个（改写型弱证据）即判采纳；节点 <8 字恒不采纳，宁漏判不伪造。
- `LocalBackend.recall()` 返回 `recallId` 与最终注入节点 `injectedNodes`（只含真正进上下文的节点）；新增 `markRecallUsed(recallId, used)` 只回写 `used` 列（不改 hit_ids/chars，注入事实与采纳事实分离），失败 fail-open。
- hook 接 `agent/assistant-stream`：按 (turn,step) 累积回复文本；在新一步 pre-step 或 `agent/turn-stopping`/`agent/disposed` 时结算，有引用证据才回写 used=1；无 `markRecallUsed` 的旧 backend 不崩。
- 日报「未采纳 Top10」口径文案同步（原文窗口/bigram 覆盖判定，改写幅度大的回复可能漏判）。
- 测试 215 → 231（230 pass / 1 skip）：新增 `test/unit/adoption.test.mjs`、`test/hook/adoption-signal.test.mjs`（含 hook→backend 全链路 used 落库断言），`test/hook/hook.test.mjs` 扩 5 例。

同版本收尾批（后端接线 / 身份 / 迁移 / 测试分层 / 发布文档）：
- 测试分层：`test/` 按 `unit/contract/hook/data/worker/lifecycle/sync/client` 八层重排；`npm test` 改为 8 条目录 glob（此前只跑根目录，子目录静默漏跑）；当前 **268 例**（267 pass / 1 skip / 0 fail），CI 跑全层。
- HttpBackend 写链路：补 `POST /write`（body `{event}`，远端冲突原样交回调用方）、`GET /version`（`{protocol:'whale-memory/1'}`）与 Bearer token（`setToken`/credentials，读/写/version 同源头注入）；协议不符返回 `protocol_mismatch` 并把证据留在 `protocolStatus`，不抛不静默。
- Hybrid 双轨：本地 SQLite 为真源、HTTP 为副本；读走 HTTP，失败/超时（默认 800ms）回退本地并计入 `stats.sync.http_fallbacks`；写先落本地再入 `sync_outbox`（持久化），30 秒看门狗续跑、指数退避、8 次失败转 failed、重启复位 running；远端冲突把本地节点置 stale 并保留 outbox 证据。
- identity auto：`identity.mode=auto` 时取宿主 `deepseekAccount` 的 userId（5 分钟 TTL、fail-open 空串）+ 会话 cwd 派生的 workspace（规范化绝对路径，超 64 字稳定哈希压缩）；缺账号服务的老宿主回落 Config/空值；旧配置迁移强制 `fixed`，防旧库分区漂移。
- 旧配置迁移：首启把 hub 0.2.0 的环境变量一次性写进 Config（网关地址→`backend.url` 且 local→http、两级超时、role/user→`identity` fixed、remote 开关）；marker（有本地库用 `meta.migrated_from`，无库用 `$DSH_HOME/whale-memory/migration.json`）幂等；保存失败只记日志不挡启动；已建 backend 不换实现，日志提示重启后生效。
- 迁移审计：新增 `scripts/migrate-audit.mjs`——默认只读 dry-run；`--apply --apply-edges` 先 `wal_checkpoint` + `VACUUM INTO` 备份（保留 5 份）再写 `similar/manual` 边；sha256 归一化 text_hash 重映射、按状态/分区统计、双读 overlap、md/json 报告；操作手册 `docs/MIGRATION.md`。
- 发布文档：`docs/DETAIL.md`（首行 640×300 无字预览图 + 5 条能力与隐私说明）+ `docs/preview.svg`；README 重写为用户视角（安装/使用/13 组配置/数据与隐私/限制/迁移/故障），`scripts/check.mjs` E9 通过。

## 0.5.0 — 2026-11-22（观测层批次 · 未发布）

审计 backlog P1「观测闭环」落地（架构书 §9.1/§9.2/§9.3）：
- 新增 `src/core/metrics.js`：十一项指标唯一口径 + 7 日 series；纯函数只读，落表只由日报调用（`writeMetricsRows` UPSERT）。
- `GET /stats` 增 `metrics{day,values,targets}`、`series[7]`、`health.jobs.recent_failures`（既有 totals/health 键不动）。
- 召回审计补零命中：每次召回都落 `recalls` 行（含零命中与意图预算 0），`source` 由调用方传入；`hit_ids` 改记检索命中集合（注入与否由 injected/chars 表达）；`GET /recalls` 支持 `source/since/filter=zero|unused/limit`。
- 日报新增：十一项指标表（目标/达标）、命中但未注入 Top10（低分命中的代理口径）、未采纳 Top10、24h 失败 job 表，并把指标写入 `metrics` 表。
- embed 关闭时 pending 滞留按 0 计（§9.1，避免每天挂一个不可行动的 ✗）。
- 面板概览：新增零注入率/采纳率/作业成功率/库体积指标卡（带目标达标态）、7 日曲线（注入率/零命中占比）、最近失败卡片；三语各 392 键。
- 测试 197 → 215（214 pass / 1 skip）：新增 `test/metrics.test.mjs`、`test/recalls.test.mjs`，keeper 报告与 stats 契约断言扩展。

## 0.4.3 — 2026-11-22

工程质量审计后的修复批次（对照架构书 v3.5 / 计划书 v1.5）：
- 写入保护面：NOOP 按来源可信度升级（owner>self>group>web/tool>import）、MERGE 对 owner/core/procedural 改走 REVIEW（不自动改写正文）；shadow 候选恢复 level/type/tags/source/TTL 并按原决策（MERGE/SUPERSEDE/REVIEW）执行。
- 配置契约：`/config` GET 回显 13 组全字段、POST 改叶子深合并（不再整组覆盖丢字段）；补 9 个文档字段；identity 四字段 volatile；volatile Ref 在 writer/backend 解包（关写/auto/上限真生效）。
- 数据保真：schema v2（`writes.payload`，v1→v2 幂等迁移）；导入/导出保留 status/双时态/context_note/hits；>500 字按规则边界拆分（`split_from`）或报 `too_long_single_rule`；导入后 FTS 一致性闸（docsize 比对，不一致回滚）；导出按身份过滤。
- 检索/关系：FTS 命中带 `path`(L1/L2)/`matched`；扩散分乘边 conf；worker 透传 diffusion/minConf；巩固新增 topic 边与同文去重（CONSOLIDATE 审计）。
- 观测：`/stats` 增 health（fts_aligned/vectors_pending/jobs/pressure）与今日召回/注入口径；trace_id 由 host 生成并下传。
- 面板：i18n 三语（zh/en/ja 各 377 键）+ 标记块生成 + `i18n-check` 静态门；设置页 13 组/50 控件（desc/生效徽标/danger/aria）；召回可解释（rel/mult/gain/effWeight/path/matched）；shadow 审核走服务端过滤；错误码补 13 个；窄屏表格滚动。
- 内存闸门改用 `/proc/meminfo` 的 MemAvailable（非 MemFree）。

## 0.4.2 — 2026-11-22

- S4 机制二期：写入决策流水线（ADD/NOOP/MERGE/SUPERSEDE/REVIEW/REJECT + shadow 候选审核）、jobs 状态机（单飞/退避/启动补偿/水位闸门）、关系层（标签边/1 跳扩散/context_note 200 硬顶 + 演化审计）、意图注入预算（画图链路 0 注入）。
- 评测：32 例黄金集移植 + `scripts/eval.mjs`，真实库 precision@3 = 1.0000（30/30 检索用例）、identHitRate = 1.0000。
- 检索：FTS 候选按 rank 取前 50（修此前按 rowid 取导致高相关节点落选）；`context_note` 只做 +5% 检索加权、不进注入正文。
- 设置页：新增 sync.enabled / reflect.enabled / write.searchFeed / recall.intentBudget 四个开关；写入页新增 shadow 候选接受/拒绝审核。

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
