![小鲸鱼记忆中枢](preview.svg)

给 DeepSeek Harness 会话加一层可查、可审、可迁移的本地长期记忆；规则（铁律）以本地 git Markdown 仓为真源，数据库只做镜像。

## 功能

1. **对话自动召回**：每轮对话前检索本地长期记忆，按意图预算注入（闲聊 3 条 / 排障 5 条 / 回忆 4 条 / 画图 0 条）；2 秒超时即跳过，不卡回复。
2. **本地长期库**：记忆节点带层级、类型、双时态与工作区隔离，默认存本机 SQLite（`$DSH_HOME/whale-memory/memory.db`），不依赖外部服务。
3. **六页签面板**：概览、记忆库（检索/编辑/归档/导入导出）、召回、写入与关系、规则、设置；规则页含候选、历史 diff/回滚、Git 状态与 `/rules/health`。
4. **写入可控**：单条 ≤500 字；默认 shadow 复核，候选经面板接受后才入库；JSONL 导入导出，改动留审计。
5. **规则可版本化**：铁律以 `~/.dsh/rules/` 的 Markdown 文件为真源，提案 → plan/apply → 单次 commit；彻底删除写墓碑、编号永不复用；数据库只做检索镜像且不参与召回。
6. **旧库可迁移**：附 `migrate-audit` 脚本，只读对账、备份后迁移关系边，操作见 `docs/MIGRATION.md`。

## 安装

- 插件市场搜索 `dsh-whale-memory`（上架后）；
- 或 Release：`dsh plugin --profile <profile> add <dsh-whale-memory.tgz>`；
- 本机开发可用 `link:<本仓目录>`。
- 需要 DSH `>=0.2.2-rc.5 <0.3.0`、Node `>=22.13.0`。

## 使用

1. 装好即用：默认本地库、自动召回，不需要密钥或外部服务。
2. 说“以后……”起草规则 → 回复 `收录 <p...>` 或到规则页「待确认」确认；应用前可看 plan 与逐文件守卫结果。
3. 面板规则页可新建/编辑/停用/彻底删除、看历史 diff 与回滚；`/rules/health` 检查文件、manifest、墓碑、链和编号。
4. 全局规则渲染进 `AGENTS.md`；空机首次自愈会创建最小管理块，已有无标记文件不追加。

## 隐私与限制

默认数据只在本机；仅当手动把后端配成 http/hybrid 时，才向所填 url 发 stats/recent/search/recall/write/version 请求；不写遥测、不外传。召回失败 fail-open；全局规则依赖 AGENTS 摘要；`rules.llm=false` 时合并/冲突候选需面板改写。
