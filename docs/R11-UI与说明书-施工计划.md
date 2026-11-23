# R11 施工计划：设置体验、小白说明书、铁律重编（2026-11-24 立项）

> 状态：**未开工**，本文件是下一会话的唯一施工依据。厂长已批准范围：设置默认值、设置分组重排、布局修复、小白说明书+术语表+面板入口、19 条铁律重编（含合并/歧义修饰），并授权按更优解自行裁定，不再逐项请示。
>
> 基线：鲸忆 0.6.2 `8fde425` / 人设 0.5.1 `671693a`；测试 891(890/1) / 144；DSH 0.2.2-rc.5；live 已由 HMR 加载 R10（DB schema v4，备份在 `~/.dsh/whale-memory/backup/`）。
> 证据图：`docs/R11-images/settings-tab-overview.png`、`docs/R11-images/settings-top-tabs.png`（厂长 2026-11-24 截图，蓝圈=问题区域）。

## 1. 目标与验收（一次会话可完成）

1. **开箱即用**：免外部依赖的功能开关安装后默认开；需要外部服务/模型的开关默认关，但面板明确“开它需要什么”，并给一键启用推荐配置。
2. **信息架构**：设置页按重要性重排；首屏只看得到召回/写入/身份/规则四组核心；高级项折叠。
3. **布局缺陷**：消灭空卡片、超大竖向输入框、拉伸留白；卡片高度自适应、字段一行一个、数值/URL 不再撑高。
4. **小白说明书**：新增中文手册 + 术语表（可去搜索引擎复查的名词），面板顶部显眼按钮弹出，面板内术语带 tooltip 锚点。
5. **铁律重编**：21 条按“做什么·何时·怎么判”重写；合并同义重复、消除歧义；编号不变式与墓碑规则不破；AGENTS 预算仍 ≤6000。
6. **不回归**：测试/静态门/i18n/干净安装/桌面端装跑全过；`/rules/health` 绿。

## 2. 现状与根因（已定位）

### 2.1 设置默认值（盘点）

| 组 | 字段 | 现默认 | 判断 |
|:--|:--|:--|:--|
| recall | enabled / intentBudget / showSources | true / true / true | 保持 |
| write | enabled | true | 保持 |
| write | reviewMode | `shadow` | **保持 shadow**：自动落库前先留审计，小白更安全；面板首屏解释“影子=先记账不生效” |
| write | searchFeed | false | 关：依赖搜索反哺且会增写；在卡片上给“推荐开启（有搜索时）”提示 |
| rules | enabled / mirrorAuto / renderAgents / createAgentsIfMissing | true | 保持 |
| rules | llm | false | 关：无模型不降级；给“有模型可开”提示 |
| reflect | enabled | false | **建议默认开**（有默认模型时）；至少安装首启向导里推荐开 |
| consolidate | enabled | true | 保持 |
| sync | enabled / mode / dryRun | false / off / true | **建议默认开**：本机 profile 已注入 bridgeUrl 时置 enabled=true、mode=both、dryRun=false? 需评估远端副作用；若不敢自动，首启向导推荐 + 一键开 |
| embed | enabled | false | 关（无向量服务） |
| edges | diffusion / minConf | true / 0.6 | 保持 |
| privacy | redact / retentionDays | true / 0 | 保持；保留策略另立项 |
| advanced | worker | true | 保持 |

判定原则：**本地、无外部依赖、可逆的功能 = 默认开；需要地址/密钥/模型 = 默认关 + 显式说明 + 推荐按钮**。
实现方式：`Config` schema 默认值调整 + 首启一次性“推荐配置”写入（走 configEditor，不改 schema 语义）；不得在 apply 里偷改用户已显式保存的值。

### 2.2 布局根因（不是“审美”）

- `lib/client.js` 里 `css.input = { flex: '1 1 220px' }`（≈8368 行）；`FieldCard` 内部是 `flex-direction: column`，于是 `flex-basis:220px` 作用在**高度**上，单行 input 被拉成 100–200px 高的方块（截图里的“后端标识/userId/URL”大框）。
- `groupGrid` 是 grid 默认 `align-items: stretch`，同一行卡片被拉齐到最高卡片高度，产生大片空白（截图蓝圈的空区）。
- 部分说明卡（`Note`）独占一行、内容短，仍被 grid 拉高，视觉上像“空卡”。
- 修法：input `flex:'0 0 auto'; width:'100%'`；`groupGrid` 加 `alignItems:'start'`；`settingCard` 保持 height auto；文本域仅 `ignorePatterns` 用 4 行、其余单行；卡片内部 gap 收紧；数值输入固定 `maxWidth:180px`。

### 2.3 文案错误

- `settings.defaultsNote` 仍写“保存会整体提交上述场景”（R10 已改为只提交脏叶子）→ 改为“只保存你改过的项”。
- `rulesConfigLayerNote`、`allowRemote` 等说明需与 0.6.2 实际行为对齐。

## 3. 工作包（按顺序，可独立验收）

### WP1 设置默认值与首启推荐（0.6.3）
- 改 `src/host/config.js` 默认值：`reflect.enabled` 评估默认 true（模型不可用时 reflect 会 fail-open，需确认不产生错误日志骚扰）；`sync.*` 仅在检测到 `bridgeUrl` 非空时由首启向导写入推荐值，不直接改 schema 默认。
- 新增首启标记 `advanced.firstRunDone`（或 meta）→ 面板首屏弹“推荐配置”卡：勾选 召回/写入/规则/巩固/反思/同步（同步灰显需 bridge 地址）→ 一次 POST /config（只提交差异）。
- 卡片增加“推荐开启”徽标（复用 `SETTINGS_META`），关闭时提示影响。
- 验收：空 $DSH_HOME 安装→首屏向导可见；跳过后不重复弹；已存在用户配置不被覆盖；`/config` 回显默认值正确。

### WP2 设置信息架构与布局
- 分组顺序改为：**召回 → 写入 → 身份 → 规则 → 接入 → 同步 → 反思 → 巩固 → 隐私/边界 → 高级**；embed 归“高级/未启用能力”。
- 首屏四组展开；其余组用折叠面板（默认收起，记住展开状态在 `panel.*` 或 localStorage）。
- 修复 2.2 的 CSS 根因；窄屏 390px 单列；表格/预览不横向溢出。
- 术语 tooltip：`<abbr title>`/自制 hover 卡，文案指向手册锚点。
- 验收：1280×800/390×844 Playwright 截图；无空卡；input 高度 ≤40px；页面仅一个滚动条；Tab 顺序可键盘走通。

### WP3 小白说明书 + 面板入口
- 新文件 `docs/MANUAL.zh.md`（≤250 行起步，后续可扩 en/ja），结构：
  1. 一分钟上手（装完发生什么、数据在哪、怎么关）
  2. 三件日常事（自动召回/自动写入/规则提案）各 5 行
  3. 六页签速览
  4. 最常用的 8 个设置（只讲这 8 个）
  5. 术语表（每个词给“一句话解释 + 网上搜什么”）：记忆节点、召回、注入、预算、身份分区（user/role/workspace）、影子/自动、FTS、worker、schema、规则/铁律、提案、镜像、AGENTS、Git 规则仓、同步/outbox、向量/embedding、volatile、CAS、trace。
  6. FAQ（没召回/没写入/规则不生效/AGENTS 没更新/换机/卸载留什么/怎么备份恢复/allowRemote 风险）
  7. 排障入口（`/rules/health`、日志关键词、备份路径）
- 面板入口：顶部工具栏（刷新右边）加“使用说明”按钮，显眼、带 `?` 图标；点击弹全屏/大抽屉；复用现有规则抽屉的滚动/关闭/焦点契约。
- 实现：`scripts/manual-build.mjs` 从 MD 生成 client `manual:generated` 标记块（同 locale 模式），零运行时依赖；CI 校验 MD 与生成块一致。
- 验收：按钮在六页签都可见；内容离线可读；三语未翻译时显式标“中文”；Playwright 打开/关闭/Esc。

### WP4 铁律重编（厂长授权，不再请示）
- 流程：逐条读 `~/.dsh/rules/iron-rule-*.md` → 按模板重写（做什么/何时/怎么判，≤500 字，无历史叙述）→ 先检索既有规则去重 → 合并同义/重叠 → 歧义句改写 → 通过规则仓提案/直接写入 + git commit + AGENTS 重渲染 + 镜像。
- 现状基线：21 条（20 编号 + safety；编号 20 为墓碑，next=23）；本轮新加 **21 隔离验证并备份**、**22 禁止静默失败**，并修订 **11（记忆 supersede）**、**19（修复批独立复核）**。
- 重点候选：7/8（删除与封存重复）、10/19（择优与自审/团队重叠）、9/17（文档与过程稿重复）、12/16/18（收尾文档与文档同步重叠）；合并保留最早编号，被并条目 `merged_into` + 墓碑/退役，编号不复用；`rules-local` 13 号另审。
- **defaults 同步**：`defaults/rules` 仍 18 文件，重编完成后与真源 21 条同步（含 21/22；11/19 新文本），同步更新 `defaults/README`、播种计数测试与干净安装断言。
- 验收：21 条仍可机检（编号/墓碑/nextNumber）；每条三问齐全；AGENTS 摘要预算 ≤6000 且不出现半句；规则测试全绿；`/rules/health` 无红/黄；旧规则可按 history 回滚；defaults 与真源一致。
- 回滚点：规则仓 git commit + `history/`；DB 镜像可重建。

### WP5 剩余优化（可与 WP1–3 并行）
- AGENTS 摘要可执行性：默认铁律 front matter 增加 `summary`（≤120 字），或把摘要上限调到 260；目标：global 铁律即使不注入也能看到“判据”。
- 保留策略：`privacy.retentionDays>0` 时清理 writes/recalls/已完成 jobs；默认 0 不动。
- 性能：`computeMetrics` 5–10s 缓存/搬 worker；`ruleNodeIds` 改 EXISTS；worker 内按 dbPath 复用连接；persona `readPersona` meta 缓存。
- 观测：dedupe 发生>0 时二次快照；import progress meta 完成后清理。
- 验收：有基线前/后数字（SQL 计数/耗时），不达标不合并。

## 4. 测试与发布门槛

- 单测/契约：默认值/向导/分组顺序/CSS 属性快照/手册生成一致性/规则重编（编号、墓碑、预算）。
- UI：Playwright 1280×800、390×844、六页签；说明书弹层；设置首屏；空态/错误态。
- 安装：干净 rc.5（link+tarball）与桌面端 rc.5（自带 pnpm）各一遍；引擎门、boot、播种、导入、Host 闸。
- 回归：891/144 基线只增不减；check E1–E15；i18n；`/rules/health`。
- 发布：0.6.3/0.5.2 版本号、CHANGELOG、README/DETAIL、Release 资产、市场 PR（按厂长令）。

## 5. 风险与红线

- **live HMR**：profile 软链插件，改代码会被运行中的 DSH 热加载（R10 已触发 DB v4 迁移）。R11 先在干净 home 开发验证，合并前再落 live；每次改 schema/默认值前备份 live DB。
- 设置默认值变更不得覆盖用户已保存值；必须走“首启推荐 + 差异提交”。
- 铁律合并涉及编号：严禁复用/回收；被并条目走 `merged_into`/退役，保留 history 与墓碑。
- 不许为了 UI 好看删掉“危险区/allowRemote”提示；安全文案必须保留。

## 6. 交接入口

- 本文件：R11 唯一排期真源（插件侧）。
- 面板/手册：`docs/MANUAL.zh.md`（WP3 新建）。
- 截图证据：`docs/R11-images/`。
- 全局交接：`/mnt/i/ai-workspace/ai-router/docs/新会话启动Prompt.txt`、`会话交接摘要-一页.md`、`当前进度快照与待办清单.md`、`Router-lite_全量未完成事项清单_v4.md`、`全局技术债与解耦清单.md`。
