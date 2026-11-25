# 跨插件共享工具契约（P2 收口后现状与下一步）

## 1. 现状：本仓共享层 + 仍分叉的 host 工具

| 工具 | 路径 | 行数 | 导出（acorn 实测） | 消费方 |
| --- | --- | --- | --- | --- |
| 错误码单一真源 | `src/shared/error-table.mjs` | 232 | ERROR_TABLE、statusOf、localeKeyOf、isKnownError（4 个） | host/core 多处 |
| 配置取值与 volatile 合并 | `src/shared/config-values.js` | 69 | value、bool、num、isVolatileRef、mergePreservingVolatile（5 个） | `index.js` + host 7 文件 + core 7 文件（backend/hybrid/keeper/reflect/rule-plan/rule-proposal/writer） |
| 内存闸门（`/proc/meminfo` 可注入，读不到回落） | `src/shared/memory-guard.js` | 62 | FREE_FLOOR、RSS_CEIL、availableBytes、memoryPressure（4 个） | core backend/keeper/reflect + host search-feed |
| Ref 树递归解包 | `src/shared/resolve-refs.js` | 22 | resolveRefsDeep（1 个） | host routes、config-migration |
| 本地日期戳 | `src/shared/day-stamp.js` | 12 | dayStamp（1 个） | host session-wrap/report、core keeper/handlers |
| HTTP 工具集（本插件专用） | `src/host/http-kit.js` | 226 | clamp、Host/Origin 白名单、loopback、readJson/sendJson 等（10 个） | host routes、rules-routes |

- 依赖方向：`src/shared/**` 只依赖 Node 内建，不 import host/core；core 直接 import shared，不再反向 import host。
- **P2a 已清零 6 条 `core → host` 边**（backend/keeper/reflect 各两条）；`scripts/decouple-baseline.json` 现为 `allowedEdges: []`、`pathMigrations: {}`。
- 原先散在 core 的 Ref 解包副本（writer/hybrid/backend/rule-plan/rule-proposal 的 `plain()/cfgValue()`）已物理删除，统一走 `shared/config-values.js`；`routes/config-migration` 的 Ref 树解包副本合并为 `shared/resolve-refs.js`。
- 人设插件仍有自己的 `src/host/config-values.js` 与 `http-kit.js` 副本；两仓尚未共享。

## 2. 为什么本次不抽跨插件包

- tarball 传递依赖：两插件各自发布 npm 包，抽包会多出一个必须同时装进两份插件依赖树的包；任一插件的 files 白名单、版本范围或卸载都不再自洽。
- 发布顺序风险：共享包必须先发，两插件再升依赖并同步发版；一旦共享包版本回退或 yank，两个插件的回滚链同时变长。
- P6 拿到差异审计数据后再决定抽包 / 保留副本+契约测试 / 收编进各自 shared。

## 3. drift 判据（何时立 P7）

同一工具连续两次出现“同一语义变更必须在两仓/两插件各改一遍”，才立 P7 抽包。
单次改动合并进各自版本，不构成 drift；判据以改动记录（提交 + 改到哪些文件）为准，不凭印象。

## 4. check-shared-drift 现状职责

`node scripts/check-shared-drift.mjs [--check]`（缺省 --check）：

- 只读列出现状：`src/host/http-kit.js`、`src/shared/config-values.js` 的行数与导出符号（acorn 解析），随后打印 `[shared-drift] ok（未建跨插件共享包；P6 填充 API/行为差异审计）`，exit 0。
- 不写文件、不判差异、不比对另一插件；未知参数 exit 2；任一被盘点文件缺失 exit 1（不静默跳过）。
- P6 在此脚本上补 API/行为差异审计，不在当前阶段提前猜差异。

## 5. 下一步

**P3c（本仓）**：rule-proposal 按候选存储/创建/apply/reject/session 拆分，门面只 re-export；`check-deps` 白名单保持空；每步导出对拍、定向测试、`lint-size`/`check` 全绿才下一步。P3a/P3b 已收口（tag `p3a-done`/`p3b-done`）：rule-store 8 模块、rule-reconcile 4 模块，门面均纯 re-export。

**P6（跨插件）**：

1. 导出对照表：两插件各自工具文件的导出名、签名、默认值、错误语义逐项对齐。
2. 行为差异用例：同一输入（loopback 判定、Host/Origin 白名单、配置取值与易变字段合并）在两边跑出结果并记录差异。
3. 决策与交付：抽包 / 保留副本+契约测试 / 收编进 `src/shared` 三者择一，附发布顺序与回滚方案；差异清单与决策写入本文件正文，不留 TODO 占位。
