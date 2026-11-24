# 跨插件共享工具契约（P1 现状与下一步）

## 1. 现状：两份 host 工具（只盘点、不抽包）

| 工具 | 路径 | 行数 | 导出（acorn 实测） | 消费者 |
| --- | --- | --- | --- | --- |
| HTTP 工具集 | `src/host/http-kit.js` | 226 | clamp、isAllowedHostName、isAllowedOrigin、isLocalHostName、isLocalOrigin、isLoopback、isWriteMethod、readJson、sendJson、writeRequestProblem（10 个） | `src/host/routes.js`、`src/host/rules-routes.js` |
| 配置取值与易变字段合并 | `src/host/config-values.js` | 69 | bool、isVolatileRef、mergePreservingVolatile、num、value（5 个） | `index.js` + `src/host/` 7 个文件（session-wrap、routes、hook、rules-routes、search-feed、session-capture、identity）+ `src/core/` 3 个文件（reflect、keeper、backend），共 11 处 |

- `src/shared/` 目前只有 `error-table.mjs`（232 行，0 个 import），是唯一共享件；`src/shared` 不得 import `host`/`core`。
- 另一插件 `dsh-whale-widget` 0.4.2 在 `lib/index.js` 内联了自己的 `isLoopbackHostname` 一类判据，与本仓 `http-kit.js` 同语义不同名；两边没有共享包，靠人工对齐。
- 本仓存在 6 条 `core → host` 反向边（backend/keeper/reflect 各两条，指向 `memory-guard.js` 与 `config-values.js`），全部登记在 `scripts/decouple-baseline.json` 的 `allowedEdges`（clearPhase=P2a）。

## 2. 为什么本次不抽跨插件包

- tarball 传递依赖：两插件各自发布 npm 包，抽包会多出一个必须同时装进两份插件依赖树的包；任一插件的 files 白名单、版本范围或卸载都不再自洽。
- 发布顺序风险：共享包必须先发，两插件再升依赖并同步发版；一旦共享包版本回退或 yank，两个插件的回滚链同时变长。
- P1 目标只是把体积/依赖/共享漂移落成静态门；抽包是结构性决策，放到 P6 拿到差异审计数据后再定。

## 3. drift 判据（何时立 P7）

同一工具连续两次出现“同一语义变更必须在两仓/两插件各改一遍”，才立 P7 抽包。
单次改动合并进各自版本，不构成 drift；判据以改动记录（提交 + 改到哪些文件）为准，不凭印象。

## 4. check-shared-drift 现状职责

`node scripts/check-shared-drift.mjs [--check]`（缺省 --check）：

- 只读列出现状：`src/host/http-kit.js`、`src/host/config-values.js` 的行数与导出符号（acorn 解析），随后打印 `[shared-drift] ok（P1 未建跨插件共享包；P6 填充 API/行为差异审计）`，exit 0。
- 不写文件、不判差异、不比对另一插件；未知参数 exit 2；任一被盘点文件缺失 exit 1（不静默跳过）。
- P6 在此脚本上补 API/行为差异审计，不在 P1 提前猜差异。

## 5. 下一步

**P2a（本仓）**：把 `memory-guard` 的纯判据与 `config-values` 的纯函数搬进 `src/shared`，`src/core` 只 import `src/shared`，6 条 `allowedEdges` 清零；搬完后 `src/shared` 仍只依赖 node 原生模块。

**P6（跨插件）**：

1. 导出对照表：两插件各自工具文件的导出名、签名、默认值、错误语义逐项对齐。
2. 行为差异用例：同一输入（loopback 判定、Host/Origin 白名单、配置取值与易变字段合并）在两边跑出结果并记录差异。
3. 决策与交付：抽包 / 保留副本+契约测试 / 收编进 `src/shared` 三者择一，附发布顺序与回滚方案；差异清单与决策写入本文件正文，不留 TODO 占位。
