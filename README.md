# Whale Memory · 小鲸鱼记忆中枢

[English](README.md) | **中文**

给 DeepSeek Harness 会话加一层**可查、可审、可迁移的本地长期记忆**：对话前自动召回相关记忆并注入上下文，平时在面板里查看、编辑、导入导出；规则（铁律）以本地 git Markdown 仓为真源，数据库只做镜像。

> 当前版本 **0.6.0**（未发布）：本地 SQLite 记忆库、对话自动召回、六页签面板、写入审计与采纳信号、双轨同步与 outbox、观测指标与日报、旧库迁移审计；规则真源在 `~/.dsh/rules`（提案制、plan/apply、墓碑编号、健康检查）。
> 运行要求：DSH `>=0.2.2-rc.5 <0.3.0`、Node `>=22.5`（内置 SQLite）。

## 安装

- **插件市场**：在 DSH 的插件市场里添加本项目的索引地址（format 1 索引），搜索 `dsh-whale-memory` 安装（上架后）。
- **GitHub Release**：`dsh plugin --profile <profile> add <release-tarball.tgz>`，或插件页 Add plugin 选 tarball。
- **本机开发（link）**：在 DSH 插件管理里用 `link:<本仓绝对目录>` 安装（源码/开发版 DSH 提供；先 `pnpm install` 并构建，改代码后需重建并重启）。`link:` 只用于开发，市场索引要求发布版本。
- 装好即用：默认本地库、自动召回、面板六页签；不需要另装服务，也不需要填密钥。

## 用

### 对话自动召回

- 每轮对话前，取最后一条用户消息检索本地记忆，把过相关度门槛（默认 `minRel=0.34`）的命中注入到上下文；没命中就不注入，不硬凑。
- 2 秒内没返回就跳过本轮（不阻断对话）；结果只作用于当前会话，120 秒后失效；子会话不注入。
- 按意图分配预算：闲聊 3 条 / 排障 5 条 / 回忆 4 条 / 画图、创作链路 0 条。
- 身份维度：`userId` / `roleId` / 会话 cwd 派生的 `workspace`；人设插件切换角色时只发 `roleId` 提示，workspace 始终由会话决定。

### 面板六页签

概览 / 记忆库 / **规则** / 召回 / 写入与关系 / 设置：

- 记忆库：搜索、编辑、归档、导入导出、节点关系；
- 规则：规则文件列表、新建、编辑、停用/启用、彻底删除、待确认候选、历史 diff/回滚、git 三态、`/rules/health`；
- 召回：命中与注入参数；写入与关系：候选/审计/采纳；设置：后端、规则、面板等分组配置。

### 规则（铁律）提案与版本化

- 规则真源是 `~/.dsh/rules/` 的一规则一 Markdown，git 纯本地；`nodes` 表里 `origin=rule:<key>` 只是面板检索/审计镜像，**不参与召回**。
- 一条口语规则先成为候选，不会自动生效；确认方式：面板「待确认」按钮，或聊天里回复 `收录 <p...>`（每会话一条、30 分钟）。
- 应用前会生成 plan（逐文件守卫/oldHash/planHash），确认后单次事务落盘 + 单次 commit；失败回滚，不产生半写状态。
- 彻底删除会把编号写入 `retired/<key>.json` 墓碑，编号永不复用；`/rules/health` 检查文件/manifest/墓碑/链/镜像一致性。
- 全局规则渲染进 `AGENTS.md` 管理块；空机首次自愈会创建最小管理块（`rules.createAgentsIfMissing=true`），已有无标记文件不追加。
- 作用域规则只在对的 `role:`/`workspace:` 会话注入，预算 `injectChars`（0=关闭）。

## 配置

规则组（面板可见 9 项，另 3 项在配置层）：

| 键 | 默认 | 说明 |
|---|---|---|
| `rules.enabled` | `true` | 提案/注入/自愈总开关 |
| `rules.dir` | `''` | 规则仓目录；空=`$DSH_HOME/rules` |
| `rules.requireGit` | `false` | true=git 非绿时写规则硬拦 |
| `rules.askMode` | `panel+chat` | 主动问渠道；`panel`/`off` 不自动起草 |
| `rules.llm` | `false` | 合并/冲突时允许模型改措辞 |
| `rules.maxProposals` | `20` | 待确认上限 |
| `rules.guardStrict` | `true` | 严格守卫 |
| `rules.mirrorAuto` | `true` | 自动镜像 |
| `rules.askCooldownDays` | `30` | 拒绝冷却 |
| `rules.renderAgents` | `true` | 重渲染 AGENTS（配置层） |
| `rules.injectChars` | `600` | 作用域规则每轮预算（配置层；0=关闭） |
| `rules.createAgentsIfMissing` | `true` | 空机创建最小 AGENTS 管理块（配置层） |

后端默认 `local`（`$DSH_HOME/whale-memory/memory.db`）；可选 `http`/`hybrid` 指向外部记忆服务，失败会回退本地或显示未连接。

## 数据、隐私与安全

- 默认**不发任何外部请求**；只有把 `backend.mode` 切到 `http`/`hybrid` 时才向配置的 URL 发 `/stats /recent /search /recall /write`。
- 记忆库与规则都在本机；规则 git 不 push、不联网。
- 面板/接口默认只允许回环访问；写接口强制 JSON + 同源校验，拒绝跨站简单请求。
- 日志只记 key/编号/commit/trace，不记规则正文或凭据。

## 限制

- 只提供 DSH Web 客户端面板；没有独立移动端。
- 召回超时/失败 fail-open，不会阻塞对话，但该轮没有记忆注入。
- 全局规则依赖 `AGENTS.md` 摘要；已有文件但没有管理块时不会追加（避免改用户资产）。
- `rules.llm=false` 时，合并/冲突候选需要面板改写；模型只改措辞，不直接落盘。
- Node 内置 SQLite 仍是实验特性；数据库与规则仓都建议纳入灾备。

## 开发与测试

```bash
cd dsh-whale-memory
npm test                    # 799 tests (798 pass / 1 skip)
node scripts/check.mjs      # contract gate
node scripts/i18n-check.mjs # zh/en/ja locale keys
```

干净 DSH 安装验收：`node ~/ops/dsh-plugin-clean-install-test.mjs`（临时 `DSH_HOME`，whale/persona/both）。

## 迁移与故障

- 旧库迁移、回滚：见 `docs/MIGRATION.md` 与 `docs/DETAIL.md`。
- 规则仓损坏：文件仍是真源；`.git` 只 `mv` 到 `.git.broken-<ts>` 后重 init，规则/manifest 由文件重建。
- 面板显示 git 黄/红时，规则读写仍可用；历史/diff 走本地快照。

## License

MIT.
