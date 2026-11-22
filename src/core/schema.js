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

export const SCHEMA_VERSION = 3

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
`

/**
 * v3 索引单独建、且在迁移补列之后：旧库（v2）没有 pinned 列，
 * 若把 idx_nodes_pinned 写进 DDL，`db.exec(DDL)` 会在 ALTER 之前先建索引而报 no such column。
 */
const PINNED_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_nodes_pinned ON nodes(pinned, status)'

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
  db.exec(PINNED_INDEX_SQL)
  db.prepare(UPSERT_META).run('schema_version', String(SCHEMA_VERSION))
  return { version: SCHEMA_VERSION }
}
