# Changelog

## 0.6.1 — 2026-11-23（未发布 · R9 稳定性修复）

真机链路与写不变式（架构书 v3.9 / 计划 v1.9 的 R9-01/02/03）。
- hook：提案检测调度改宿主无关 `setImmediate`，不再读取 `ctx.setTimeout`（cordis `timer` accessor，未 inject 即抛 → 真机聊天提案 0 次成功）；日志拆 `pre-step fail-open` 与独立 `rules proposal fail-open`。
- rule-store：编号占用真源 = `iron-rule-<n>.md` 文件名编号 ∪ 解析成功 front 编号 ∪ 墓碑（非法 front 文件也占号，create 不再复用编号/覆盖原文件；>999 文件名不锁死分配）；manifest / `/rules/health` / 列表 nextNumber / plan / 提案同口径。
- rule-store：写失败四处回滚（文件 / manifest / history / git index）；正文与 history 快照 durable 写（fsync）；非降级 commit 失败返回 `commit_failed` 并回滚，不再 `ok:true` 丢提交；history ENOENT 视为已回滚。
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
