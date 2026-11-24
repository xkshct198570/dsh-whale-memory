# 插件施工计划（R11 收口与发布）

> 状态：R11 代码已封板——鲸忆 `0.6.3` `d31aaf0`、人设 `0.5.2` `9441bf7`。本文件只列**未完成步骤**与验收依据；完成项不再保留正文（台账 §8 记一行）。
> 基线：DSH `0.2.2-rc.5`；live 505770 仍跑 01:33 加载的 host 代码，客户端刷新即新；测试 897（896/1）/145；静态门 E1–E16；i18n 848。

## 1. 未完成步骤

1. **发布**（厂长令：等下一会话无问题后再做）：`0.6.3`/`0.5.2` Release 资产、市场 PR；URL 安装换网络复验。
2. **下一会话审查批**：独立挑刺＋全量测试；在 `H:\DeepSeek Harness` 做一次真机干净环境安装/运行测试（不得影响 live 3080；测完删除临时安装与 profile）。
3. **可选优化（有实测再合，不做不算欠账）**：面板规则健康入口；`computeMetrics` 5–10s 缓存（受 stats 即时性测试约束，需先量化面板轮询开销）；worker 按 dbPath 复用连接。

## 2. 验收依据（R11 已实测）

- 单测/契约：鲸忆 898（897 pass/1 skip/0 fail）；人设 145/145。
- 静态门：`node scripts/check.mjs` E1–E16；`i18n` 三语 848 键；`manual-build --check` 一致。
- 隔离装跑（临时 `DSH_HOME`，link 安装两包，端口 3082）：boot 成功；播种 20 文件；AGENTS 创建 19 条 4647 字；`/rules/health` 绿；镜像重建后 `stale=0`；client bundle 含 `0.6.3`/`manual:generated`/`SETTINGS_GROUP_ORDER`/`t, titleKey` 13 处；验完临时 home 已删。
- 规则仓：`ad3cebc`，21 条（20 编号 + safety；8 `merged_into` 7；20 墓碑；next=23），health 绿。
- live 重启验证（2026-11-24 12:29）：`/rules/health` 绿、无 pending txn；`rebuild-mirror` `stale=0`；AGENTS 19 条 4769 字、0 条省略号。
- 白屏修复：危险区分组卡补 `titleKey/t`（`8809db6`），新增组件级渲染冒烟（`test/client/render-smoke.test.mjs`）；铁律 4 v3 增 UI 渲染冒烟判据。
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
