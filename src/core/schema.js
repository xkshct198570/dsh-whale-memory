/**
 * schema v3（数据层唯一真源）：DDL 全量、幂等。
 *
 * 设计约束（与架构书 §4.1/§4.2 一致）：
 * - 加法演进：v1 之后只允许 ALTER TABLE ADD COLUMN / 新建表，禁改既有列语义。
 * - v3（2026-11-22，规则置顶）：nodes 只加 `pinned INTEGER NOT NULL DEFAULT 0` 一列 + 索引；
 *   不重建表、不动 FTS。规则仍是 nodes 行（level=core / memory_type=procedural /
 *   origin=rule:<key>），pinned=1 表示每会话首次注入。为什么加列而不是另开表：
 *   置顶是节点自身的属性，跨表 JOIN 会让导出/导入/面板/检索全部多一层，且规则与事实
 *   的边界已经能由既有列表达（架构书 §3.2）。
 * - v2 只做一件事：writes 增加 payload TEXT，保存影子候选的决策载荷（等级/类型/tags/来源/双时态/
 *   shadowOf/targetId）。为什么必须落库：影子模式下 nodes 一行不写，审核 accept 时若只能拿到
 *   after_text，就只能硬编码 normal/semantic/self，等于把"当时为什么这样判"丢掉了。
 * - 旧库（v1）由 ensureSchema 幂等迁移：PRAGMA table_info(writes) 无 payload 才 ALTER；高版本仍拒绝。
 * - 双时态：valid_at/invalid_at（事实时间）+ created_at/expired_at（系统时间）。
 * - 软删：只改 status（archived/superseded/stale），除配置到期归档外不物理删。
 * - 隔离：user_id/role_id/workspace，'' 表示共享。
 * - 硬顶：text 1..500（存储层），context_note ≤200（CHECK + 调用方双层）。
 *
 * 双 FTS：
 * - nodes_fts   trigram，覆盖 text/tags，≥3 字的整词/标识符命中（L1）。
 * - nodes_fts_bi unicode61，覆盖 JS 生成的 text_bigrams（空格分隔），2 字中文兜底（L2）。
 * 两个 FTS 都是外部内容表（content=nodes），由 AI/AD/AU 三个触发器保持同步；
 * 任何写路径都不得绕过触发器直接改 FTS。
 */
import { qualityOrderSql } from './node-rank.js'

export const SCHEMA_VERSION = 6

/**
 * 对既有表的加法列：[表, 列, 类型]。迁移与 DDL 必须保持一致。
 * v1→v2：writes.payload（影子候选决策载荷）。
 * v2→v3：nodes.pinned（规则置顶标记）。
 */
const ADDITIVE_COLUMNS = [
  ['writes', 'payload', 'TEXT'],
  ['nodes', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
]

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- schema_version / boot_id / last_consolidate / data_dir

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  text_hash     TEXT NOT NULL,
  text_bigrams  TEXT NOT NULL DEFAULT '',
  level         TEXT NOT NULL DEFAULT 'normal'
                CHECK (level IN ('core','important','normal')),
  memory_type   TEXT NOT NULL DEFAULT 'semantic'
                CHECK (memory_type IN ('semantic','procedural','episodic','mixed')),
  source        TEXT NOT NULL DEFAULT 'self'
                CHECK (source IN ('owner','self','group','web','tool','import')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived','superseded','stale')),
  role_id       TEXT NOT NULL DEFAULT '',
  user_id       TEXT NOT NULL DEFAULT '',
  workspace     TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',          -- JSON 数组
  context_note  TEXT NOT NULL DEFAULT ''
                CHECK (length(context_note) <= 200),  -- 演化注记硬顶
  weight        REAL NOT NULL DEFAULT 1.0,
  hits          INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,          -- v3：规则置顶（每会话首次注入）
  last_hit_at   REAL,
  vector_state  TEXT NOT NULL DEFAULT 'none'
                CHECK (vector_state IN ('none','pending','ready','failed')),
  embedding     BLOB,
  valid_at      REAL,
  invalid_at    REAL,
  expired_at    REAL,
  superseded_by TEXT,
  origin        TEXT NOT NULL DEFAULT '',            -- 证据：file:line / 命令 / 对话轮
  trace_id      TEXT NOT NULL DEFAULT '',
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_identity ON nodes(user_id, role_id, workspace, status);
CREATE INDEX IF NOT EXISTS idx_nodes_hash     ON nodes(text_hash);
CREATE INDEX IF NOT EXISTS idx_nodes_status   ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_hits     ON nodes(last_hit_at);
CREATE INDEX IF NOT EXISTS idx_nodes_origin   ON nodes(origin);

-- 字面索引一：trigram（≥3 字/标识符）
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  text, tags, content='nodes', content_rowid='rowid', tokenize='trigram'
);
-- 字面索引二：中文 bigram（2 字查询兜底；text_bigrams 由 JS 生成，空格分隔）
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts_bi USING fts5(
  text_bigrams, content='nodes', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  INSERT INTO nodes_fts_bi(rowid, text_bigrams) VALUES (new.rowid, new.text_bigrams);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO nodes_fts_bi(nodes_fts_bi, rowid, text_bigrams) VALUES ('delete', old.rowid, old.text_bigrams);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO nodes_fts_bi(nodes_fts_bi, rowid, text_bigrams) VALUES ('delete', old.rowid, old.text_bigrams);
  INSERT INTO nodes_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  INSERT INTO nodes_fts_bi(rowid, text_bigrams) VALUES (new.rowid, new.text_bigrams);
END;

CREATE TABLE IF NOT EXISTS edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  etype     TEXT NOT NULL DEFAULT 'similar'
            CHECK (etype IN ('similar','topic','supersede','mutex','reference')),
  source    TEXT NOT NULL DEFAULT 'tag',             -- tag/reflect/manual/decision
  conf      REAL NOT NULL DEFAULT 0.5 CHECK (conf BETWEEN 0 AND 1),
  weight    REAL NOT NULL DEFAULT 0.6,
  created_at REAL NOT NULL,
  UNIQUE(from_id, to_id, etype)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_conf ON edges(etype, conf);

CREATE TABLE IF NOT EXISTS recalls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL NOT NULL,
  trace_id  TEXT NOT NULL DEFAULT '',
  query     TEXT NOT NULL,
  hit_ids   TEXT NOT NULL DEFAULT '[]',
  chars     INTEGER NOT NULL DEFAULT 0,
  injected  INTEGER NOT NULL DEFAULT 0,
  used      INTEGER NOT NULL DEFAULT 0,
  elapsed_ms REAL,
  user_id   TEXT NOT NULL DEFAULT '',
  role_id   TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  source    TEXT NOT NULL DEFAULT 'hook'             -- hook/panel-test/search
);

CREATE INDEX IF NOT EXISTS idx_recalls_ts ON recalls(ts);

CREATE TABLE IF NOT EXISTS writes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL NOT NULL,
  trace_id  TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL,                           -- ADD/NOOP/MERGE/SUPERSEDE/REVIEW/REJECT/CANDIDATE/SPLIT
  node_id   TEXT,
  reason    TEXT NOT NULL DEFAULT '',
  before_text TEXT,
  after_text  TEXT,
  mode      TEXT NOT NULL DEFAULT 'shadow',           -- shadow/auto
  payload   TEXT,                                     -- v2：候选决策载荷 JSON
  user_id   TEXT NOT NULL DEFAULT '',
  role_id   TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_writes_ts ON writes(ts);
CREATE INDEX IF NOT EXISTS idx_writes_identity_ts ON writes(user_id, role_id, workspace, ts);

CREATE TABLE IF NOT EXISTS evolution (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL NOT NULL,
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  trace_id  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                          -- consolidate/reflect/ttl/vector/archive
  state       TEXT NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     REAL,
  last_error  TEXT,
  payload     TEXT,
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, next_at);

-- 双轨同步：本地写先落 outbox，后台按 text_hash 推送；拉取用 cursor 增量
CREATE TABLE IF NOT EXISTS sync_outbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  op        TEXT NOT NULL CHECK (op IN ('upsert','status')),
  node_id   TEXT NOT NULL,
  payload   TEXT NOT NULL,                 -- 节点快照 JSON
  state     TEXT NOT NULL DEFAULT 'queued'
            CHECK (state IN ('queued','running','done','failed')),
  attempts  INTEGER NOT NULL DEFAULT 0,
  next_at   REAL,
  last_error TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON sync_outbox(state, next_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,                  -- cursor / last_pull_at / last_push_at / peer_id
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  day       TEXT NOT NULL,                            -- YYYY-MM-DD
  name      TEXT NOT NULL,
  value     REAL NOT NULL,
  PRIMARY KEY (day, name)
);

-- v5：会话收尾（Session Wrap）运行台账。
-- 为什么独立成表而不复用 jobs：jobs 是调度状态机（queued/running/done/failed + 重试退避），
-- wrap_runs 是**业务结果**（候选/提案/报告/清洁/可切会话），一次 run 可能被重排成多个 job，
-- 两者生命周期不同；把业务字段塞进 jobs.payload 会让状态查询/面板/审计都要解 JSON。
-- 幂等键 (session_id, material_hash)：同一会话同一段材料只允许一条 run；新材料产生新行。
CREATE TABLE IF NOT EXISTS wrap_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  material_hash     TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','running','done','failed','skipped')),
  trigger           TEXT NOT NULL DEFAULT 'manual',
  user_id           TEXT NOT NULL DEFAULT '',
  role_id           TEXT NOT NULL DEFAULT '',
  workspace         TEXT NOT NULL DEFAULT '',
  job_id            INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  phase             TEXT NOT NULL DEFAULT 'created'
                    CHECK (phase IN ('created','distilled','written','reported','done')),
  summary           TEXT NOT NULL DEFAULT '',
  distilled_json    TEXT,                              -- {items:[{...,status,reason}],dropped:[]}；续跑断点
  candidates        INTEGER NOT NULL DEFAULT 0,
  rule_proposals    INTEGER NOT NULL DEFAULT 0,
  open_loops        INTEGER NOT NULL DEFAULT 0,
  report_path       TEXT NOT NULL DEFAULT '',
  hygiene_json      TEXT,
  switch_ready_json TEXT,
  error             TEXT NOT NULL DEFAULT '',
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrap_runs_created ON wrap_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_wrap_runs_state   ON wrap_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_wrap_runs_material ON wrap_runs(session_id, material_hash, id);

-- v6：每会话的自动收尾开关（skip_auto=1 表示不参与空闲/关闭自动触发；手动不受影响）。
CREATE TABLE IF NOT EXISTS wrap_session_prefs (
  session_id TEXT PRIMARY KEY,
  skip_auto  INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);
`

/**
 * v3 索引单独建、且在迁移补列之后：旧库（v2）没有 pinned 列，
 * 若把 idx_nodes_pinned 写进 DDL，`db.exec(DDL)` 会在 ALTER 之前先建索引而报 no such column。
 */
const PINNED_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_nodes_pinned ON nodes(pinned, status)'

/**
 * 活跃节点同身份原文唯一（v4）：并发双写不再各插一行，第二行在 DB 层被拒。
 * 必须用部分索引（WHERE status='active'）：归档/取代的旧行允许同 hash 共存，
 * 否则“重新写入一条曾归档的事实”会永远失败。
 */
const ACTIVE_HASH_UNIQUE_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_active_hash
  ON nodes(text_hash, user_id, role_id, workspace)
  WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')`
// 兜底索引必须换名：同名 `CREATE UNIQUE ... IF NOT EXISTS` 会让已有非唯一索引静默顶替，
// 之后永远建不出唯一索引，而 health 还报 true（审计 A2）。
const ACTIVE_HASH_FALLBACK_SQL = `CREATE INDEX IF NOT EXISTS idx_nodes_active_hash_nu
  ON nodes(text_hash, user_id, role_id, workspace)`

/**
 * v4 迁移：建唯一索引前先收敛存量重复活跃行（SELECT→INSERT 竞态时代的产物）。
 *
 * 口径：同 (text_hash,user_id,role_id,workspace,status='active') 组保留最早一行（created_at,rowid），
 * 其余置 status='superseded' + superseded_by=保留行，invalid_at=迁移时刻；不物理删，
 * 数据可追溯、可回滚（迁移前 db.js 已做整库快照）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} 被收敛的行数
 */
/**
 * 读取活跃同文索引的真实形态（存在与否、是否 UNIQUE）。
 * 为什么：`CREATE UNIQUE INDEX IF NOT EXISTS` 遇到同名非唯一索引不会报错也不会升级，
 * 唯一性保护可能永久失效而所有“成功”信号都是假的。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{name:string, unique:boolean}|null}
 */
export function activeHashIndex(db) {
  try {
    const row = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type='index' AND name='idx_nodes_active_hash'`).get()
    if (!row) return null
    return { name: String(row.name), unique: /UNIQUE\s+INDEX/i.test(String(row.sql || '')) }
  } catch { return null }
}

export function dedupeActiveHashes(db) {
  const groups = db.prepare(`SELECT text_hash, user_id, role_id, workspace, count(*) AS n
    FROM nodes WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')
    GROUP BY text_hash, user_id, role_id, workspace HAVING n > 1`).all()
  if (groups.length === 0) return 0
  const keep = db.prepare(`SELECT id FROM nodes
    WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')
      AND text_hash=? AND user_id=? AND role_id=? AND workspace=?
    ORDER BY ${qualityOrderSql()} LIMIT 1`)
  const retire = db.prepare(`UPDATE nodes SET status='superseded', superseded_by=?, invalid_at=?,
    updated_at=? WHERE id=?`)
  const ts = Date.now() / 1000
  let deduped = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const group of groups) {
      const canonical = keep.get(group.text_hash, group.user_id, group.role_id, group.workspace)
      if (!canonical) continue
      const rows = db.prepare(`SELECT id FROM nodes
        WHERE status='active' AND (origin IS NULL OR origin NOT LIKE 'rule:%')
          AND text_hash=? AND user_id=? AND role_id=? AND workspace=? AND id<>?
        ORDER BY ${qualityOrderSql()}`).all(
        group.text_hash, group.user_id, group.role_id, group.workspace, canonical.id)
      for (const row of rows) {
        retire.run(canonical.id, ts, ts, row.id)
        deduped += 1
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败不遮蔽原始错误 */ }
    throw err
  }
  return deduped
}

const UPSERT_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'

/**
 * 幂等迁移 v1 → v2：只做 ALTER TABLE ADD COLUMN。
 *
 * 为什么用 PRAGMA table_info 而不是只看版本号：列在不在是唯一可靠事实
 * （旧库可能手工补过列、也可能版本号被改过）；按列判断可重复执行、不会二次 ALTER 报错。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateAdditiveColumns(db) {
  for (const [table, column, type] of ADDITIVE_COLUMNS) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)))
    if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

/**
 * v6 迁移：去掉 wrap_runs 的 `UNIQUE(session_id, material_hash)`。
 *
 * 为什么必须去掉（S2 判据）：失败重试耗尽后用户再点，要“新建 run、新 runId”保留历史；
 * 表级 UNIQUE 会把第二次插入直接拒绝。幂等改由代码判（同 session+hash 取最近一行）。
 * SQLite 不支持 DROP CONSTRAINT，只能重建表：列顺序与原表一致，事务内完成，
 * 索引重建；迁移前 openDb 已按版本差做整库快照（fail-closed 由调用方决定是否阻断）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{rebuilt:boolean}}
 */
export function migrateWrapRunsV6(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wrap_runs'").get()
  const sql = String(row?.sql || '')
  // 两个判据（任一命中即重建）：旧版 UNIQUE 约束；或 phase CHECK 还没有 reconciled（S3 断点态）。
  const hasUnique = /UNIQUE\s*\(\s*session_id/i.test(sql)
  const hasPhase = /phase IN/.test(sql)
  const hasReconciled = /'reconciled'/.test(sql)
  if (!row || !(hasUnique || (hasPhase && !hasReconciled))) return { rebuilt: false }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE wrap_runs_v6 (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL,
      material_hash     TEXT NOT NULL,
      state             TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued','running','done','failed','skipped')),
      trigger           TEXT NOT NULL DEFAULT 'manual',
      user_id           TEXT NOT NULL DEFAULT '',
      role_id           TEXT NOT NULL DEFAULT '',
      workspace         TEXT NOT NULL DEFAULT '',
      job_id            INTEGER,
      attempts          INTEGER NOT NULL DEFAULT 0,
      phase             TEXT NOT NULL DEFAULT 'created'
                        CHECK (phase IN ('created','distilled','reconciled','written','reported','done')),
      summary           TEXT NOT NULL DEFAULT '',
      distilled_json    TEXT,
      candidates        INTEGER NOT NULL DEFAULT 0,
      rule_proposals    INTEGER NOT NULL DEFAULT 0,
      open_loops        INTEGER NOT NULL DEFAULT 0,
      report_path       TEXT NOT NULL DEFAULT '',
      hygiene_json      TEXT,
      switch_ready_json TEXT,
      error             TEXT NOT NULL DEFAULT '',
      created_at        REAL NOT NULL,
      updated_at        REAL NOT NULL
    )`)
    db.exec('INSERT INTO wrap_runs_v6 SELECT * FROM wrap_runs')
    db.exec('DROP TABLE wrap_runs')
    db.exec('ALTER TABLE wrap_runs_v6 RENAME TO wrap_runs')
    db.exec('CREATE INDEX IF NOT EXISTS idx_wrap_runs_created ON wrap_runs(created_at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_wrap_runs_state ON wrap_runs(state, updated_at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_wrap_runs_material ON wrap_runs(session_id, material_hash, id)')
    db.exec('COMMIT')
    return { rebuilt: true }
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* 回滚失败不遮蔽原始错误 */ }
    throw err
  }
}

/**
 * 执行完整 DDL 并写入 meta.schema_version。
 * 幂等：重复调用不报错；若库内版本高于本代码版本 → schema_incompatible（只增不减）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ version: number }}
 */
export function ensureSchema(db) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('ensureSchema: db required')
  db.exec(DDL)

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  const current = row ? Number(row.value) : 0
  if (Number.isFinite(current) && current > SCHEMA_VERSION) {
    throw new Error(`schema_incompatible: db version ${current} > code version ${SCHEMA_VERSION}`)
  }
  migrateAdditiveColumns(db)
  migrateWrapRunsV6(db)
  db.exec(PINNED_INDEX_SQL)
  // v4：先收敛重复活跃行，再建唯一索引；索引建不起来时退化为普通索引（旧脏库不阻断启动），
  // 由 backend 把 deduped/unique 挂到 health 观测。
  const deduped = dedupeActiveHashes(db)
  // 同名非唯一索引会让 CREATE UNIQUE ... IF NOT EXISTS 静默 no-op：先拆掉再建。
  let existing = activeHashIndex(db)
  if (existing && !existing.unique) {
    try { db.exec('DROP INDEX IF EXISTS idx_nodes_active_hash') } catch { /* 并发 DDL 让别人处理 */ }
  }
  try {
    db.exec(ACTIVE_HASH_UNIQUE_SQL)
  } catch {
    // 并发 DDL 可能被别人抢先建好：以 sqlite_master 实读为准，不靠“没抛错”猜。
    try { db.exec(ACTIVE_HASH_FALLBACK_SQL) } catch { /* 兜底索引失败也不阻断 */ }
  }
  existing = activeHashIndex(db)
  const uniqueIndex = Boolean(existing && existing.unique)
  db.prepare(UPSERT_META).run('schema_version', String(SCHEMA_VERSION))
  return { version: SCHEMA_VERSION, deduped, uniqueIndex }
}
