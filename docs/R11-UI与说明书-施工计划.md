# 插件施工计划（R11 收口与发布）

> 状态：R11 代码已封板——鲸忆 `0.6.3` `d31aaf0`、人设 `0.5.2` `9441bf7`。本文件只列**未完成步骤**与验收依据；完成项不再保留正文（台账 §8 记一行）。
> 基线：DSH `0.2.2-rc.5`；live 505770 仍跑 01:33 加载的 host 代码，客户端刷新即新；测试 897（896/1）/145；静态门 E1–E16；i18n 848。

## 1. 未完成步骤

1. **重启生效验证**（厂长手动重启 DSH；红线：agent 不得重启）：
   - `/rules/health` 仍 0 红 0 黄、无 pending txn；
   - `POST /whale-memory/api/rules/rebuild-mirror` 返回 `status.stale=0`（R11 修了日期当 UTC 时刻的误报）；
   - `~/.dsh/AGENTS.md` 规则摘要 19 条、`铁律19` 末尾含团队协作判据（`EXCERPT_CHARS` 500 全文，预算 6000）。
2. **发布**：`0.6.3`/`0.5.2` Release 资产、CHANGELOG（已写）、README/DETAIL（已对齐）、市场 PR（按厂长令）；URL 安装换网络复验。
3. **可选优化（有实测再合，不做不算欠账）**：面板规则健康入口；`computeMetrics` 5–10s 缓存（受 stats 即时性测试约束，需先量化面板轮询开销）；worker 按 dbPath 复用连接。

## 2. 验收依据（R11 已实测）

- 单测/契约：鲸忆 897（896 pass/1 skip/0 fail）；人设 145/145。
- 静态门：`node scripts/check.mjs` E1–E16；`i18n` 三语 848 键；`manual-build --check` 一致。
- 隔离装跑（临时 `DSH_HOME`，link 安装两包，端口 3082）：boot 成功；播种 20 文件；AGENTS 创建 19 条 4647 字；`/rules/health` 绿；镜像重建后 `stale=0`；client bundle 含 `0.6.3`/`manual:generated`/`SETTINGS_GROUP_ORDER`/`t, titleKey` 13 处；验完临时 home 已删。
- 规则仓：`ad3cebc`，21 条（20 编号 + safety；8 `merged_into` 7；20 墓碑；next=23），health 绿。
- live 备份：`~/.dsh/whale-memory/backup/whale-r11-pre-20261123-191234.db`。

## 3. 红线与回滚

- 不重启/杀 DSH；只对精确 PID 动手；网关只从 `~/start-gateway.sh` 起。
- 动库前 `wal_checkpoint(TRUNCATE)` → `VACUUM INTO backup/whale-<ts>.db`。
- 回滚：插件 git `git revert d31aaf0`/`9441bf7`；规则仓按 `history/<key>/` 快照或 git revert 恢复单条；DB 用 R11 前快照覆盖（先停插件写入）。
- 铁律编号不复用；被并条只加 `merged_into`，不回收编号。

## 4. 交接入口

- 本文件：插件侧唯一排期真源。
- 小白手册：`docs/MANUAL.zh.md`（随包离线）。
- 全局交接：`/mnt/i/ai-workspace/ai-router/docs/新会话启动Prompt.txt`、`会话交接摘要-一页.md`、`当前进度快照与待办清单.md`、`Router-lite_全量未完成事项清单_v4.md`、`全局技术债与解耦清单.md`。
