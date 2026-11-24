# 插件施工计划（R11 收口 · 已发布）

> 状态：鲸忆 `0.6.3` tag `v0.6.3`→`753b88c`；人设 `0.5.2` tag `v0.5.2`→`efde82d`。本文件只列**未完成步骤**与验收依据；完成项不保留正文（台账 §8 记一行）。
> 基线：DSH `0.2.2-rc.5`；Node `>=22.13.0`；工作树已实现 Session Wrap（schema v5），live host 待重启；测试 1010（1009/1）/145；静态门 E1–E16；i18n 924。

## 1. 未完成步骤

1. **Session Wrap live 验证**：W1–W6 已实现（架构/计划见 `docs/Session-Wrap-*`）；profile 以 link 指向本仓，host 重启前 `/wrap` 与 `wrap` 设置组不可用。重启后验三路由+保存；隔离安装见施工计划 §2。
2. **市场 PR**：`awesome-dsh-plugin/awesome-dsh-plugin#18412` 已开（两条 entry），check **success**；等维护者评审。合并后 README 由上游生成，不手改。
3. **可选：live 重启**：加载本轮 host 修复（allowRemote peer 闸、写队列、错误码、Session Wrap）与 schema v5；client 可先更新，host 不重启仍是旧代码。
4. **可选优化（有实测再合，不做不算欠账）**：面板规则健康入口；`computeMetrics` 5–10s 缓存（受 stats 即时性测试约束，需先量化面板轮询开销）；worker 按 dbPath 复用连接。

## 2. 验收依据（已实测）

- 单测/契约：鲸忆 1010（1009 pass/1 skip/0 fail）；人设 145/145。
- 静态门：`node scripts/check.mjs` E1–E16；`i18n` 三语 924 键；`manual-build --check` 一致。
- Release：tag 工作流（Node 22）跑全量测试 → 资产 `dsh-whale-memory.tgz` 543,448 B sha256 `5bfae27f…707ab`、`dsh-persona-hub.tgz` 64,809 B sha256 `de81ce32…6da97`；`latest/download` 302→200；`SHA256SUMS.txt` 随包。
- 干净装跑：临时 `DSH_HOME` + 新 profile + `--port 0`；tarball `whale/persona/both` 3/3；URL（本地镜像同一份字节）`whale/both` 2/2；已删除临时 home。
- Session Wrap 隔离验收（2026-11-24）：dir 与 tarball 两种源各跑 `whale` 用例 PASS；新增门断言 `/config` 有 wrap 组、`/wrap/status` supported、无材料 `POST /wrap` 409 `no_material`。
- schema v4→v5 真库迁移（隔离副本）：691 节点/4536 边不变，版本 5，`wrap_runs` 建表，迁移前快照 3.87 MB。
- 市场索引：仓库根 `market-index.json`（format 1，2 plugins，版本/commit 钉 tag，数据 URI 图标），官方 `parseMarketIndex` 通过。
- 白屏修复：危险区分组卡补 `titleKey/t`（`8809db6`），组件级渲染冒烟已扩到六页签 + 首启推荐卡。
- 本轮审查修复：P1/P2 清单见 CHANGELOG 0.6.3「上架前独立审查修复」。

## 3. 红线与回滚

- 不重启/杀 DSH；只对精确 PID 动手；网关只从 `~/start-gateway.sh` 起。
- 动库前 `wal_checkpoint(TRUNCATE)` → `VACUUM INTO backup/whale-<ts>.db`。
- 回滚：插件 git `git revert 753b88c`（或 check out `v0.6.3` 前一个提交）；规则仓按 `history/<key>/` 快照或 git revert 恢复单条；DB 用重启前快照覆盖（先停插件写入）。
- 铁律编号不复用；被并条只加 `merged_into`，不回收编号；Release 不覆盖旧 tag 资产。

## 4. 交接入口

- 本文件：插件侧唯一排期真源。
- 小白手册：`docs/MANUAL.zh.md`（随包离线）。
- 发布/市场/PR：`/home/hy/hy/release/PUBLISH.md`、`MARKET-PR.md`。
- 全局交接：`/mnt/i/ai-workspace/ai-router/docs/新会话启动Prompt.txt`、`会话交接摘要-一页.md`、`当前进度快照与待办清单.md`、`Router-lite_全量未完成事项清单_v4.md`、`全局技术债与解耦清单.md`。
