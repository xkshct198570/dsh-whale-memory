# dsh-whale-memory · 小鲸鱼记忆中枢

[**English**](README.md) | 中文

给 DeepSeek Harness 会话加一层**可查、可审、可迁移的本地长期记忆**：对话前自动召回相关记忆并注入上下文，平时在面板里查看、编辑、导入导出。

> 当前版本 **0.8.2**：本地 SQLite 记忆库、对话自动召回、六页签面板、写入审计与采纳信号、双轨同步与 outbox、观测指标与日报、旧库迁移审计；规则真源在 `~/.dsh/rules`（提案制、plan/apply、墓碑编号、健康检查）；收尾时一次有界提炼，产出候选/规则提案/无原文报告；v2 增加会话选择、点击即排队（202+进度）、自动收尾开关与逐会话跳过，以及默认关闭的整合（Reconcile）复核。0.8.0 增加普通记忆自动入库、模型侧五个 `memory_*` 工具、记忆分层（`fact`/`lesson`/`user`）与首轮画像，以及「回合工具步 ≥7 或空闲」的自动反思（默认关，可用峰时窗口抑制）。0.8.1 让 jobs 终态不再保留正文、自动反思日限跨重启仍生效、手动反思缺身份时给出可行动文案，并给 `memory_*` 写入补上分层。0.8.2 把判重候选扩为「最近 300 ∪ 全文检索 12 条」（上限 312；相似度 ≥0.35 且共享检索词 ≥2 时只产 `paraphrase_suspect` 候选，不再静默新增），新增 keeper 单实例租约与单 handler 硬超时，并把语义召回（embed）在代码层封存、数据面保留。
> 运行要求：DSH `>=0.2.2-rc.5 <0.3.0`、Node `>=22.13.0`（内置 SQLite）。

## 亮点

- 它记住你随口说过的事，换个会话再提，它还能接上。
- 规则就存在本地 git 的 Markdown 里，数据库只当搜索镜像，改错能回滚。
- 六页签面板：记忆、规则、召回、写入都能看、能改、能回滚。
- 收尾时说一句「记一下」，这一轮就整理成记忆和规则候选。
- 不联网、不上传，零依赖，用 Node 自带的 SQLite。

## 安装

- **插件市场**：在 DSH 的插件市场里添加本项目的索引地址（format 1 索引），搜索 `dsh-whale-memory` 安装。
- **本机开发（link）**：在 DSH 插件管理里用 `link:<本仓绝对目录>` 安装（源码/开发版 DSH 提供；先 `pnpm install` 并构建，改代码后需重建并重启）。`config` 留空即可，默认值由 schema 兜底；`link:` 只用于开发，市场索引要求 npm 发布版本。
- 装好即用：默认本地库、自动召回、面板六页签；不需要另装服务，也不需要填密钥。

## 用

### 对话自动召回

- 每轮对话前，取最后一条用户消息检索本地记忆，把过相关度门槛（默认 `minRel=0.34`）的命中注入到上下文；没命中就不注入，不硬凑。
- 2 秒内没返回就跳过本轮（不阻断对话）；结果只作用于当前会话，120 秒后失效；子会话不注入。
- 按意图分配预算：闲聊 3 条 / 排障 5 条 / 回忆 4 条 / 画图、创作链路 0 条。
- 回复发出后会做一次「引用判定」：回复里出现注入内容才记为「已采纳」，只用于概览的采纳率指标，不改你的记忆。

### 面板六页签

| 页签 | 能做什么 |
|---|---|
| 概览 | 节点数 / 活跃数 / 今日召回 / 关系边；零注入率、采纳率、作业成功率、库体积与 7 日曲线；最近失败的作业；最近收尾与「立即收尾」 |
| 记忆库 | 关键词检索、新增记忆、查看详情、编辑/归档、导入 JSONL |
| 规则 | 规则库、待确认候选、历史 diff/回滚、Git 状态与 `/rules/health`；新建/编辑/停用/彻底删除 |
| 召回 | 最近的召回记录（命中了什么、注入了多少字、是否采纳）；纯检索测试（不调模型、不写库） |
| 写入与关系 | 写入审计流水、shadow 候选接受/拒绝（可只看收尾候选）、关系边统计、最近演化 |
| 设置 | 按场景分组的开关（见下表；其中数据目录只读）；导出记忆（JSONL） |

> 当前版本没有「清空库 / 重置配置」这类破坏性操作；清理数据请走导出备份后手动处理。

### 规则（铁律）提案与版本化

规则的真源不在数据库，而在 `~/.dsh/rules/` 的本地 git 仓库：一规则一 Markdown（YAML front matter 头 + 指令正文），可用任何文本编辑器直接改。
- 对话里说「以后都/必须/禁止/记成铁律」时，插件会起草一条规则候选并在回复末尾问你要不要收录；也可以在面板「规则 → 待确认」里审阅。
- 收录前会做冲突检测与守卫校验（旧规则的例外/禁止不能被悄悄删掉）；冲突/合并要你确认后才写入。
- 每次写入自动 `git commit`，面板可看历史、逐行 diff、回滚；没装 git 也能用，历史改用本地快照（每规则保留 20 份）。
- 全局铁律自动渲染进 `~/.dsh/AGENTS.md` 摘要块；空机首次自愈会创建最小管理块（已有文件无标记时不追加）；作用域规则（workspace/role）按会话注入，不串场。
- `/rules/health` 检查文件↔manifest↔墓碑↔编号↔链；彻底删除写墓碑、编号永不复用。
- 空机安装不需要 git/网络；设置页会显示 Git 三态（已安装/未安装/损坏）与按平台的安装指引。
- **首次安装自带默认铁律**：插件自带上架默认规则（通用 19 条带号 + 1 条安全铁律；不含空号 6；本机专用铁律 13 不参与默认播种）。它们在首启写入 `~/.dsh/rules/` 并成为可编辑的规则文件：小白可在「规则」页直接**新建、修改、停用/删除**，编号保留、历史可回滚；停用后用同编号可随时重新启用。

### 模型侧记忆工具

模型可以直接调用五个工具：`memory_remember`、`memory_search`、`memory_read`、`memory_update`、`memory_forget`。

- 身份固定为当前会话（userId/roleId 按插件身份规则与宿主登录态推导，workspace 由会话工作目录派生）；缺身份报 `IDENTITY_REQUIRED`，跨分区 id 一律按 `NODE_NOT_FOUND` 处理。
- `remember` 与自动入库同一道价值闸（长期规则入库、任务/一次性状态报 `NOT_MEMORY`、歧义转待审）；`update` 支持 CAS（`NODE_CHANGED`）并拒改受保护目标；`forget` 只归档。
- 每回合写尝试上限 `tools.maxWritesPerTurn`（默认 5）；子代理调用被拒（`SUBAGENT_FORBIDDEN`）；`tools.enabled=false` 时调用即被拒。

### 记忆分层与首轮画像

- 收尾与反思写入带分层：`fact`（事实/决策）、`lesson`（可复用的教训）、`user`（偏好）；`memory_remember` 按 `memory_type` 派生、`memory_update` 在改写正文时重算；面板直接写入与旧行保持 `NULL`；规则没有分层。
- 会话首轮会把同身份的 `user` top5 / `lesson` top5 / `fact` top3 渲染成 ≤800 字符的「长期画像」，经 `systemPrompt.context` 注入一次；第二轮不再出现，子代理或身份不可判定时跳过，失败只记日志不阻断对话。

### 自动反思（默认关）

- 开启后，回合一里 distinct 非记忆工具步数 ≥7 或会话空闲到点时自动跑；产出教训/事实，落库 `source=self`、`origin=reflect`，走与收尾同一套入库判据。
- 自动运行受 `reflect.maxRunsPerDay`（按进程内计数、本地自然日边界与重启清零）与 `maintenance.suppressWindows`（本地时区 `HH:MM-HH:MM`，`23:00-07:00` 表示跨午夜；无法解析的项跳过并记一次日志）约束。
- 手动 `/reflect` 与面板「立即反思」绕过峰时与日限，但仍要求身份；开关默认关，打开会花模型 token。

## 配置

空配置就是默认行为。设置页每组都有场景说明；大多数开关保存后即时生效，少数（接入方式、数据目录等）在插件重新加载后生效。

| 组 | 管什么 | 用户要知道的字段（默认值） |
|---|---|---|
| 数据目录 | 库放哪 | `dataDir=''` = `$DSH_HOME/whale-memory` |
| 接入 | 记忆存在哪 | `backend.mode='local'`（本地库）；`backend.url=''`、`timeoutMs=3000` |
| 身份 | 记忆按谁分区 | `identity.mode='auto'`（DSH 登录 userId + 会话工作目录）；固定分区用 `fixed` + `userId/roleId/workspace` |
| 注入 | 召回与注入 | `enabled=true`、`maxHits=5`、`charBudget=1500`（**0 = 关闭注入**）、`intentBudget=true`、`minRel=0.34`、`timeoutMs=2000` |
| 写入 | 记不记、怎么审 | `enabled=true`、`reviewMode='shadow'`（候选需在面板接受才入库；`auto` 直接落库）、`maxChars=500`、`dailyCap=200`、`judge='rules'`、`searchFeed=false`、`searchTtlHours=24` |
| 反思 | 后台提炼 + 峰时 | `enabled=false`、`idleMinutes=30`、`maxItems=8`、`maxRunsPerDay=24`、`model=''`、`maintenance.suppressWindows=[]`（本地时区 `HH:MM-HH:MM`，跨午夜，坏值 fail-open 跳过；只抑制自动反思；日限按进程内计数，重启清零） |
| 模型工具 | 对话里直接读写记忆 | `tools.enabled=true`、`tools.maxWritesPerTurn=5`（remember/update/forget 每回合尝试上限） |
| 收尾 | 会话结束沉淀 | `enabled=true`、`explicit=true`、`idle=false`、`disposed=false`（后台两路默认关）、`idleMinutes=10`、`maxItems=8`、`ingest.mode=auto`（durable 自动入库 / review 全部先审）、`ingest.minConfidence=0.55`、`ingest.dropTaskInstructions=true`、`maxRunsPerDay=6`（只限自动）、`retentionDays=180`、`report=true`、`model=''`、`maxMaterialChars=12000` |
| 巩固 | 定期合并 | `enabled=true`、`intervalHours=6` |
| 向量 | 语义检索 | `enabled=false`、`endpoint=''`、`model=''`、`batch=16`（当前版本未接外部嵌入服务） |
| 隐私 | 脱敏与保留 | `redact=true`、`retentionDays=0`（0 = 不自动清理） |
| 关系 | 1 跳扩散 | `diffusion=true`、`minConf=0.6` |
| 同步 | 与外部网关双轨 | `enabled=false`、`mode='off'`、`intervalMin=15`、`httpTimeoutMs=800`、`batch=100`、`dryRun=true`；`bridgeUrl=''` 由 profile 注入，不在面板编辑 |
| 面板 | 回环与刷新 | `allowRemote=false`（默认只接受本机回环请求）、`pollMs=60000`、`tab='overview'` |
| 高级 | 排障 | `traceId=''`、`logLevel='warn'`、`worker=true` |

## 数据与隐私

- **只存本机**：默认库文件 `$DSH_HOME/whale-memory/memory.db`（`$DSH_HOME` 缺省为 `~/.dsh`），同目录有 WAL/SHM、`reports/` 日报与收尾报告、`spool/` 临时材料（600 权限、默认 24h 自删、不进灾备）；开关改动保存在 DSH 的插件配置里，记忆本身只进这个库。
- **会发的外部请求**：只有把 `backend.mode` 配成 `http` 或 `hybrid` 且 `backend.url` 非空时，才会向**你填的那个 url** 发：
  `GET /stats`、`GET /recent`、`POST /search`、`POST /recall`、`POST /write`、`GET /version`。
  若在 DSH 凭据里配了 `WHALE_MEMORY_TOKEN`（也接受同名环境变量），请求会带 `Authorization: Bearer …`；没配就不带。
- **默认零外部请求**：`backend.mode=local`（默认）时插件不发起任何网络请求；遥测不存在。
- **模型调用**：反思默认关闭；开启后会调用 DSH 当前模型提炼记忆（会产生模型 token 成本）。会话收尾默认开：每次至多一次模型调用，自动触发每日上限 6 次；在设置「收尾沉淀」可关或调低。`embed` 目前只定义开关，未接外部嵌入服务，不会发请求。
- **关掉 / 卸载影响**：插件停止召回，**数据不会自动删除**，仍留在 `$DSH_HOME/whale-memory`；重装后继续可读。要彻底删除：先导出备份，停掉 DSH，再删除该目录。
- 面板 API 默认只接受回环请求；`panel.allowRemote` 打开后只额外放行 `webServer.host` 这个绑定地址的**只读**请求（检索/列表/详情；不含整库导出与任何写操作，身份覆盖参数对非回环请求无效），风险自负。

## 限制

- 单条正文 ≤ **500 字**（`write.maxChars` 可调 20–500）；超长按规则边界拆成多条，拆不开则拒绝并写明原因。
- 注入侧单条最多 **300 字**，超长只截注入文本、不改库；每轮总预算见上（`charBudget` 与意图档取较小值，**设为 0 就是完全不注入**）。
- 检索每路最多取 50 条候选、单次最多 150 条；不做参数化记忆，也不在线用 LLM 逐条判矛盾。
- 后台同时只跑 1 个作业，内存紧张时自动延后；反思/收尾默认单轮 ≤8 条，收尾材料 ≤12000 码点；邻居注记 `context_note` ≤200 字。

## 迁移

已有旧版记忆库、或要复核两边数据：见 [docs/MIGRATION.md](docs/MIGRATION.md)。脚本默认只读对账（dry-run），确认后再 `--apply --apply-edges`：先备份、再写关系边；节点仍走 JSONL 导入。

## 故障

- **后端不兼容**：如果远端不是 `whale-memory/1` 协议，`/version` 探测会返回 `protocol_mismatch` 并在日志留 `backend protocol mismatch`；读接口失败时 hybrid 回退本地、http 模式显示后端未连接/部分页签不可用。hybrid 下 `GET /whale-memory/api/stats` 的 `health.sync` 带 `protocol` / `protocol_expected` / `protocol_mismatch`（探测过才有值）；确认不兼容就把 `backend.mode` 切回 `local`，本地数据不受影响。
- **outbox 积压**（hybrid）：写入先落本地、再排队推送，所以本地不会丢。看同一份 `stats` 的 `outbox`：`queued`/`running` 持续大于 0、`oldestAgeSec` 增长，说明远端没跟上；看门狗每 30 秒重试，退避最长 5 分钟，同一行 8 次失败转 `failed`。检查 `backend.url`、网络与 token；远端恢复后自动续跑，冲突时本地节点标为待复核（stale）。
- **不注入**：确认 `recall.enabled=true`、`charBudget>0`、`minRel` 没有调得过高、意图预算档位合适；再看概览「零注入率」和召回页——库为空、查询太短（<2 字）或命中都在门槛下，也会不注入。
- **写入没进库**：`reviewMode=shadow` 时先去「写入与关系」页接受候选；再查 `write.enabled`、`dailyCap`、`ignorePatterns`、单条字数。
- **索引/健康异常**：概览健康状态里 `fts_aligned=false` 表示全文索引与节点表不一致；先停写入、导出备份，再导入重建，不要手改库文件。

## 仓库

<https://github.com/xkshct198570/dsh-whale-memory> · 问题与发布：Releases。

## License

MIT.
