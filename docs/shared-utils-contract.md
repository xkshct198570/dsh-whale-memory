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
- P4 收口后 `rules-routes` 8 模块仍只 import `src/shared/**` 与 `src/host/http-kit.js`；新增的 `rules-routes/shared.js` 是域内底座（前缀/错误映射/写闸/view），**不是跨插件共享层**，本契约的 API/行为与抽包判据不变。


## 2. 为什么本次不抽跨插件包

- tarball 传递依赖：两插件各自发布 npm 包，抽包会多出一个必须同时装进两份插件依赖树的包；任一插件的 files 白名单、版本范围或卸载都不再自洽。
- 发布顺序风险：共享包必须先发，两插件再升依赖并同步发版；一旦共享包版本回退或 yank，两个插件的回滚链同时变长。
- P6 拿到差异审计数据后再决定抽包 / 保留副本+契约测试 / 收编进各自 shared。

## 3. drift 判据（何时立 P7）

同一工具连续两次出现“同一语义变更必须在两仓/两插件各改一遍”，才立 P7 抽包。
单次改动合并进各自版本，不构成 drift；判据以改动记录（提交 + 改到哪些文件）为准，不凭印象。

## 4. 差异审计（P6b 已实现）

```bash
node scripts/check-shared-drift.mjs --peer ~/dsh-persona-hub-refactor
```

- 判据：工具副本的**行数、导出名集合、公共导出参数个数**；实现体差异不计 drift（两插件各有裁剪）。
- 输出：每个工具一行「本仓 ↔ 对侧」，再列差异（对侧缺/多导出、公共导出参数个数不同）。
- fail-closed：给了 `--peer` 但目录/文件读不到 → exit 1；没给 `--peer` → 打印 `跨仓差异：skipped（未提供 --peer）` 并 exit 0（pretest 走这个模式，不静默跳过）。
- 本闸只审计不判红：判红按 §3「连续两次必须两仓同改」才立 P7。

当前差异（2026-11-25 实测，`--peer ~/dsh-persona-hub-refactor`）：

| 工具 | 本仓 | 对侧（人设） | 差异 |
| --- | --- | --- | --- |
| config-values | `src/shared/config-values.js` 69 行 / 5 导出 | `src/host/config-values.js` 66 行 / 5 导出 | 本仓多 `num`，对侧多 `isEnabled` |
| http-kit | `src/host/http-kit.js` 226 行 / 10 导出 | `src/host/http-kit.js` 135 行 / 9 导出 | 对侧缺 `clamp/isAllowedHostName/isLocalHostName/isWriteMethod/writeRequestProblem`，多 `checkWriteGate/isAllowedHost/isJsonContentType/isLocalHostHeader`；公共导出 `readJson` 参数个数 3 vs 2 |

结论：两仓是「同语义不同裁剪」，不是同一份代码的分叉；人设侧 P5 未动这两个副本（已核对），暂不构成 §3 的 drift。

## 5. 下一步（P6 剩余）

1. 行为差异用例：同一输入（loopback 判定、Host/Origin 白名单、配置取值与易变字段合并）在两边跑出结果并记录差异（当前只有静态签名审计）。
2. 决策与交付：抽包 / 保留副本+契约测试 / 收编进 `src/shared` 三者择一，附发布顺序与回滚方案；结论写回本文件正文。
3. 判据仍按 §3：同一工具连续两次「必须两仓同改」才立 P7；单次改动不构成 drift。
