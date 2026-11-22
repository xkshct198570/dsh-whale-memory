# 从 Python 网关迁移到 whale-memory

本文是操作手册：把 Python 网关库（`~/ai-router-microservice/data/whale.db`）里的记忆与关系，
安全地对账、备份并迁移到插件本地库（`$DSH_HOME/whale-memory/memory.db`，默认 `~/.dsh/whale-memory/memory.db`）。

脚本是 `scripts/migrate-audit.mjs`，只用 Node 内置 SQLite，无第三方依赖。

> 先说明边界：本脚本负责**审计**和**边迁移**，不负责把节点正文灌进插件库。
> 节点迁移仍走原有导出/导入流程（`scripts/migrate-from-gateway.mjs` 导出 JSONL → 面板「导入」）。
> 顺序建议：先完成节点导入，再跑本文的审计与边迁移。

## 1. 什么时候用

- 第一次从 Python 网关切到插件本地库；
- 换机、换库后想复核「两边到底差多少」；
- 节点已经导入，但 Python 里的相似关系还没迁过来；
- 迁移后怀疑召回变差，想用同一批查询做双读对比。

## 2. 迁移前准备

1. **停掉会写记忆的进程**：网关、插件/宿主的自动写入都先停。只读审计不会锁库，但写边与备份应在没有并发写入时做。
2. 确认插件库已经存在，且节点导入完成：
   ```bash
   ls -l ~/.dsh/whale-memory/memory.db
   ```
3. 确认 Python 库路径。默认是 `~/ai-router-microservice/data/whale.db`；不在默认位置就显式传 `--python-db`。
4. 留出磁盘空间：备份是整库副本，通常与 `memory.db` 同量级。

## 3. 第一步：只读审计（默认）

直接跑，默认就是 dry-run：

```bash
cd ~/dsh-whale-memory
node scripts/migrate-audit.mjs
```

默认行为：

- Python 库和插件库都**只读打开**，不会写任何一张表；
- 控制台打印摘要，明确显示 `dry-run（未写库）`；
- 在 `data/backup/` 下生成两份同基名报告：
  - `migrate-audit-<时间戳>.md`（人读）
  - `migrate-audit-<时间戳>.json`（机检）

不想落文件，只看摘要：

```bash
node scripts/migrate-audit.mjs --report -
```

指定报告位置 / 指定库：

```bash
node scripts/migrate-audit.mjs \
  --python-db ~/ai-router-microservice/data/whale.db \
  --plugin-db ~/.dsh/whale-memory/memory.db \
  --report /tmp/whale-migration-report.md
```

## 4. 怎么读审计报告

报告按下面顺序回答「能不能迁、迁了会不会变差」：

| 区块 | 看什么 | 判断 |
|---|---|---|
| 摘要 | 两侧 schema、节点/边总数、FTS 是否对齐 | 先看 FTS 两列是否 ✅；❌ 先别迁边 |
| 节点与状态 | active / archived / superseded / stale | 插件节点通常少于 Python；归档不要求全部导入 |
| FTS 对齐 | `nodes` 行数 vs 两张 FTS 的 docsize | 不相等说明索引坏了，先重建再迁移 |
| 边 | Python 边总数、按 role/user 分区、原类型 | 记住哪些边因类型或分区不能迁 |
| text_hash 映射 | 直接等值、重算命中、回退、未映射 | 真实库直接等值通常为 0，这是算法不同，不是数据坏了 |
| 双读对比 | 每条查询插件命中是否也在 Python FTS 50 条里 | 平均覆盖率高、差异样例可解释，就可以继续 |
| 边迁移 | 可写 / 已存在 / 类型跳过 / 未映射 / 跨分区 / 自环 | dry-run 的「可写」就是 apply 后的新增上限 |
| 备份与回滚 | 本次是否备份、保留几份 | apply 前必须看到备份成功 |

### 关于 text_hash 为 0

Python 侧哈希是 sha1(原始文本)（40 位），插件侧是 sha256(归一化文本)（64 位），
两边直接比一定对不上。脚本会自动按插件口径重算再映射，报告里的「重算命中」才是真实映射量。
这不是失败，也不需要手工改哈希。

### 关于双读 overlap

插件按自己的检索口径取前 N 条，Python 用 trigram FTS 取最多 50 条；两边按归一化正文比较。
所以：

- Python 侧两字查询（trigram 至少 3 字）会显示 `python_trigram_requires_ge3`，这是已知口径差异；
- 插件独有命中不一定是错，可能是 Python 排序在 50 名之外；
- 重点看「可比较用例平均覆盖率」和差异样例是否能解释。

## 5. 第二步：备份 + 写边

确认 dry-run 的报告没有红旗后：

```bash
cd ~/dsh-whale-memory
node scripts/migrate-audit.mjs --apply --apply-edges
```

执行顺序是固定的：

1. 打开插件库（Python 库仍然只读）；
2. `PRAGMA wal_checkpoint(TRUNCATE)`；
3. `VACUUM INTO data/backup/whale-<时间戳>.db`；
4. 备份成功后，才在事务里写边；
5. 输出摘要 + Markdown/JSON 报告。

备份目录默认是仓库下 `data/backup/`，最多保留 **5** 份 `whale-*.db`，更旧的自动清理。
要换目录：

```bash
node scripts/migrate-audit.mjs --apply --apply-edges --backup-dir /path/to/backups
```

不推荐跳过备份；确实要跳过才用 `--no-backup`。

### 边迁移口径

写入插件 `edges` 的规则：

- `etype` 固定为 `similar`；
- `source` 固定为 `manual`；
- `conf = clamp(weight, 0, 1)`；
- `weight = weight`（原值）；
- 端点通过 text_hash 映射到插件 `nodes.id`；
- 两端必须与 Python 边落在同一个 `role_id/user_id` 分区；
- `UNIQUE(from_id, to_id, etype)` 保证幂等：重复执行新增为 0。

Python 的边类型**不复制**：

- `topic`、`similar` 一律归一成 `similar`；
- `supersede`、`mutex` 不迁（Python 侧没有可依赖的类型语义，插件侧也不伪造历史类型）；
- 需要保留的取代/互斥关系，请后续人工登记，而不是靠这次迁移猜测。

因此，第一次 apply 的「新增」通常小于 Python 边总数，差额会在报告里逐项列出：
已存在、类型跳过、端点未映射、跨分区、自环。

### 关于分区

插件里 `user_id=''` 表示共享。Python 的 `owner` 节点在导入时可能被映射成共享节点，
这时按 Python 边分区做严格比对会判为「跨分区」并跳过。报告会给出样例；
如果这些边确实需要，先确认分区语义，再人工补。

## 6. 第三步：复核

再跑一次只读审计：

```bash
node scripts/migrate-audit.mjs --report -
```

预期：

- `边迁移：可写 0`；
- 「已存在」增加，边总数不再变化；
- 双读 overlap 与迁移前不应该明显下降。

也可以直接查库确认（只读）：

```bash
sqlite3 -readonly ~/.dsh/whale-memory/memory.db \
  "SELECT etype, source, count(*) FROM edges GROUP BY etype, source;"
```

## 7. 回滚

任何一步出问题，按下面回滚：

1. 停掉插件/宿主的记忆写入（DSH 需要手动重启，不要自动拉起）；
2. 找到 apply 时的备份：报告里的「备份文件」，或 `data/backup/whale-<时间戳>.db`；
3. 用备份覆盖插件库：
   ```bash
   cp data/backup/whale-<时间戳>.db ~/.dsh/whale-memory/memory.db
   ```
4. 删除可能残留的同名 WAL/SHM：
   ```bash
   rm -f ~/.dsh/whale-memory/memory.db-wal ~/.dsh/whale-memory/memory.db-shm
   ```
5. 手动重启 DSH，再跑一次只读审计确认计数回到回滚前。

> Python 网关库全程只读，回滚只涉及插件库，不需要动 `whale.db`。

## 8. 参数速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `--python-db <path>` | `~/ai-router-microservice/data/whale.db` | 传目录则自动找 `whale.db` |
| `--plugin-db <path>` | `$DSH_HOME/whale-memory/memory.db` | 传目录则自动找 `memory.db` |
| `--dry-run` | 默认开启 | 显式只读；与 `--apply` 互斥 |
| `--apply` | 关 | 允许写插件库；默认先备份 |
| `--apply-edges` | 关 | 必须与 `--apply` 同用；写 `similar/manual` 边 |
| `--backup` / `--no-backup` | `--backup` | apply 时 checkpoint + VACUUM INTO |
| `--backup-dir <dir>` | `<repo>/data/backup` | 最多保留 5 份 `whale-*.db` |
| `--report <path>` | `<repo>/data/backup/migrate-audit-<ts>.md` | 同时写同名 `.json`；`-` 表示只打 stdout |
| `--queries <path>` | `test/fixtures/eval.json` | 双读对比用例集 |
| `--topn <1..50>` | `5` | 插件 search 取几条；Python 固定 50 |
| `--json` | 关 | 额外把完整 JSON 打到 stdout |
| `-h, --help` | — | 帮助 |

## 9. 常见问题

**Q：报告说 FTS 不对齐，能直接 apply 吗？**
先不要。先重建 FTS 或修复索引，再重新 dry-run；边迁移依赖节点映射，索引坏了会让双读结论失真。

**Q：映射率只有四五成，是不是迁移失败？**
多数情况下是 Python 里大量 archived 节点没有导入插件，而边只连 active 节点。看报告「按状态」表：
active 的映射率通常远高于总数映射率；边端点的映射率比节点映射率更关键。

**Q：为什么边只写 `similar`，不保留 `topic`？**
插件检索只对 `topic`/`reference` 做扩散，但 Python 的 `topic` 是按标签共现生成的，语义与插件侧不一致。
统一写 `similar` 更保守：只表达“有关联”，不伪造可扩散关系。需要扩散时人工登记 `topic`/`reference`。

**Q：apply 失败了一半怎么办？**
写边在单个事务里，失败会回滚，不会留半批。用报告里的备份覆盖即可恢复到 apply 前。

**Q：会碰 Python 网关库吗？**
不会。脚本永远以只读方式打开 `whale.db`，包括 `--apply` 模式；写只发生在插件库。
