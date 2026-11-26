# Whale Memory

[**中文**](README.zh.md) | English

Local-first long-term memory for DeepSeek Harness sessions: recall relevant memories before each turn, review and edit them in a six-tab panel, and keep rules in a local git Markdown repository where the database is only a search mirror.

> Current version **0.8.0**: local SQLite memory store, automatic recall, six-tab panel, write auditing and adoption signals, optional two-way sync/outbox, metrics and daily reports, and legacy migration auditing. Rule source of truth: `~/.dsh/rules` (proposals, plan/apply, tombstone numbering, health check). Session wrap distils lessons, decisions and open loops when a session ends, producing candidates, rule proposals and a report without raw conversation; v2 adds session selection, click-to-queue (202 + progress), an auto-wrap switch with per-session skip, and an optional Reconcile pass (default off). 0.8.0 adds automatic ingestion for durable memories, five model-side `memory_*` tools, layered memories (`fact`/`lesson`/`user`) with a first-turn profile, and reflection that triggers after ≥7 tool steps in a turn or when idle (off by default; peak windows can suppress it).
> Requirements: DSH `>=0.2.2-rc.5 <0.3.0`, Node `>=22.13.0` (built-in SQLite).

## Why it is useful

- It remembers what you mentioned in passing; switch sessions and it still picks it up.
- Rules live in local git Markdown, the database is only a search mirror — a bad edit can be rolled back.
- Six-tab panel: view, edit and roll back memories, rules, recalls and writes.
- Say "wrap this session up" and it turns the round into memory and rule candidates; the panel can target a specific session, queue a click (202 + progress) and skip auto-wrap per session.
- No network, no upload, zero dependencies — Node's built-in SQLite.

## Install

- **Market**: add this project's index source (format 1) in the DSH plugin market and search `dsh-whale-memory` (once listed).
- **GitHub Release**: `dsh plugin --profile <profile> add <release-tarball.tgz>`, or choose the tarball on the Plugins page.
- **Local development**: install with `link:<repository-directory>` from the plugin manager. Run `pnpm install` first; rebuild and restart after code changes. `link:` is for development; market indexes use published packages.
- Works out of the box: local store, automatic recall, six-tab panel; no extra service and no API key.

## Use

### Automatic recall

- Before each turn, search local memories with the last user message and inject hits above the relevance threshold (`minRel=0.34` by default). No hits means no injection.
- A 2-second timeout skips recall for that turn instead of blocking the reply; results are session-scoped and expire after 120 seconds; subagents are skipped.
- Intent budgets: chat 3 / troubleshooting 5 / recall 4 / image-and-creation 0.
- Identity dimensions: `userId`, `roleId`, and `workspace` derived from the session cwd. A persona plugin only sends `roleId`; workspace always stays with the session.

### Six-tab panel

Overview / Memories / **Rules** / Recall / Writes & relations / Settings.

- Memories: search, edit, archive, import/export, node relations.
- Rules: rule files, create, edit, retire/reactivate, purge, pending proposals, history diff/rollback, git status, `/rules/health`.
- Recall and writes: injection parameters, candidates (filterable to wrap candidates), audit and adoption; Overview shows the latest wrap with a Wrap now button and report viewer; Settings groups backend, rules, wrap and panel options.

### Rules (iron rules)

- The source of truth is one Markdown file per rule under `~/.dsh/rules/`, versioned by a purely local git repository. Rows in `nodes` with `origin=rule:<key>` are a panel/audit mirror only and are excluded from recall.
- A spoken rule becomes a candidate; it never applies automatically. Confirm from the Rules tab or reply `收录 <p...>` in chat (one pending proposal per session, 30 minutes).
- Apply builds a plan (per-file guards, old hashes, plan hash), then writes in one transaction and one commit; failures roll back without half-written state.
- Purge writes a tombstone under `retired/<key>.json`; the number is never reused. `/rules/health` checks files, manifest, tombstones, chains and mirror consistency.
- Global rules render into the managed block in `AGENTS.md`. A clean install creates a minimal block (`rules.createAgentsIfMissing=true`); an existing file without markers is never appended to.
- Scoped rules (`role:` / `workspace:`) inject only in matching sessions, under `injectChars` (0 = off).

### Model-side memory tools

The model can call five tools: `memory_remember`, `memory_search`, `memory_read`, `memory_update`, `memory_forget`.

- Identity is always the current session (userId/roleId from the plugin identity rules + host login, workspace from the session cwd). Missing identity raises `IDENTITY_REQUIRED`; ids from another partition behave as `NODE_NOT_FOUND`.
- `remember` passes the same value gate as automatic ingestion (durable → active, task/one-off → `NOT_MEMORY`, ambiguous → review candidate). `update` supports CAS (`NODE_CHANGED`) and refuses protected targets; `forget` archives only.
- At most `tools.maxWritesPerTurn` (default 5) write attempts per turn; subagents are refused (`SUBAGENT_FORBIDDEN`); `tools.enabled=false` disables the toolset at call time.

### Layers and the first-turn profile

- Every memory carries a layer: `fact` (facts/decisions), `lesson` (procedural lessons), `user` (preferences). Legacy rows keep `NULL`; rules have no layer.
- On the first turn of a session the plugin renders a ≤800-character profile from the same identity's `user`/`lesson`/`fact` nodes (top 5/5/3) and injects it once via `systemPrompt.context`. It never repeats on later turns, is skipped for subagents or undetermined identity, and fails open with a log line.

### Reflection (off by default)

- When enabled, reflection runs after a turn that used distinct non-memory tools in ≥7 steps, or when the session goes idle. It writes lessons/facts with `source=self`, `origin=reflect`, under the same ingest policy as wrap.
- Automatic runs obey `reflect.maxRunsPerDay` (local calendar day) and `maintenance.suppressWindows` (`HH:MM-HH:MM`, local time, `23:00-07:00` spans midnight; unparseable entries are skipped and logged once).
- The manual `/reflect` route and the panel action bypass peak windows and the daily cap, but still require an identity. The switch is off by default; enabling it spends model tokens.

## Configuration

Rules group (9 visible in the panel, 3 config-only):

| Key | Default | Meaning |
|---|---|---|
| `rules.enabled` | `true` | Master switch for proposals, injection and self-heal |
| `rules.dir` | `''` | Rules repository; empty = `$DSH_HOME/rules` |
| `rules.requireGit` | `false` | `true` = refuse rule writes when git is unavailable |
| `rules.askMode` | `panel+chat` | Where to offer proposals; `panel`/`off` never draft automatically |
| `rules.llm` | `false` | Allow the model to reword merge/conflict candidates |
| `rules.maxProposals` | `20` | Pending proposal limit |
| `rules.guardStrict` | `true` | Strict guards |
| `rules.mirrorAuto` | `true` | Automatic DB mirror |
| `rules.askCooldownDays` | `30` | Rejection cooldown |
| `rules.renderAgents` | `true` | Re-render the AGENTS block (config-only) |
| `rules.injectChars` | `600` | Per-turn scoped-rule budget (config-only; 0 = off) |
| `rules.createAgentsIfMissing` | `true` | Create a minimal AGENTS block on a clean install (config-only) |

Session wrap group:

| Key | Default | Meaning |
|---|---|---|
| `wrap.enabled` | `true` | Master switch; uses model tokens |
| `wrap.explicit` | `true` | Enqueue after phrases like "wrap up" / "switch session" |
| `wrap.idle` | `false` | Enqueue after `wrap.idleMinutes` with no open turn (background spend; opt-in) |
| `wrap.disposed` | `false` | Enqueue when a session is closed/archived (opt-in) |
| `wrap.idleMinutes` | `10` | Idle threshold |
| `wrap.maxItems` | `8` | Maximum candidates/proposals per run |
| `wrap.ingest.mode` | `auto` | `auto`: durable rules pass the value gate and land directly; `review`: everything stays a review candidate (0.7.3 rollback) |
| `wrap.ingest.minConfidence` | `0.55` | Items without confidence count as 0.5; below this goes to review |
| `wrap.ingest.dropTaskInstructions` | `true` | Task instructions are rejected (never stored); `false` keeps them as review candidates |
| `wrap.maxRunsPerDay` | `6` | Automatic triggers per day; explicit/manual are not capped |
| `wrap.retentionDays` | `180` | Delete finished runs and unreferenced reports older than this; `0` keeps forever |
| `wrap.report` | `true` | Write a Markdown report without raw conversation |
| `wrap.model` | `''` | Override the model id; provider still comes from the default selection |

Reflection and peak windows:

| Key | Default | Meaning |
|---|---|---|
| `reflect.enabled` | `false` | Automatic reflection (turn-end ≥7 tool steps or idle); manual `/reflect` is not gated by it |
| `reflect.model` | `''` | Model override for reflection |
| `reflect.idleMinutes` | `30` | Idle minutes before an idle reflection run |
| `reflect.maxItems` | `8` | Items per run |
| `reflect.maxRunsPerDay` | `24` | Automatic runs per local calendar day (manual bypasses) |
| `maintenance.suppressWindows` | `[]` | Local-time `HH:MM-HH:MM` windows; automatic reflection is skipped inside them (`23:00-07:00` spans midnight; bad entries fail open with one log) |

Model tools:

| Key | Default | Meaning |
|---|---|---|
| `tools.enabled` | `true` | Expose the five `memory_*` tools to the model |
| `tools.maxWritesPerTurn` | `5` | Write attempts (`remember`/`update`/`forget`) per turn |

The backend defaults to `local` (`$DSH_HOME/whale-memory/memory.db`). `http`/`hybrid` can point at an external memory service; failures fall back locally or show "not connected". Session wrap requires local or hybrid storage.

## Data, privacy and security

- No outbound requests by default. Only when `backend.mode` is set to `http`/`hybrid` does the plugin send `/stats /recent /search /recall /write` to the configured URL.
- Memories and rules stay on this machine; the rules repository never pushes and never fetches. Wrap spool files hold raw material briefly (0600, default 24h TTL, excluded from backups); reports/status/logs/job payloads never contain raw conversation.
- The panel/API is loopback-only by default; write endpoints require JSON and same-origin, rejecting cross-site simple requests.
- Logs record keys, numbers, commits and traces, not rule bodies or credentials.

## Limits

- Web panel only; no separate mobile client.
- Recall fails open: a timeout or error never blocks chat, but that turn has no memory injection.
- Global rules depend on the `AGENTS.md` digest; an existing file without markers is not modified.
- With `rules.llm=false`, merge/conflict candidates need a manual rewrite in the panel. The model only rewords; it never writes directly.
- Node's built-in SQLite is still experimental; include the database and rules repository in backups.

## Development and tests

```bash
cd dsh-whale-memory
npm test                    # full layered suite（unit/contract/hook/data/worker/lifecycle/sync/client/integration）
node scripts/check.mjs      # contract gate
node scripts/i18n-check.mjs # zh/en/ja locale keys
```

Clean-install smoke (does not touch your live profile): create a temporary `DSH_HOME`, bootstrap a fresh `web` profile, install this package, then boot on `--port 0` and check `/whale-memory/api/rules` + `/rules/health`. The repository's CI runs the same static gates and full test suite on every push.

## Migration and failure handling

- Legacy migration and rollback: see `docs/MIGRATION.md` and `docs/DETAIL.en.md`.
- Broken rules repository: files remain the source of truth; move `.git` to `.git.broken-<ts>` and re-init, then rebuild the manifest from files.
- With a yellow/red git status, rule reads/writes still work; history and diff use local snapshots.

## Repository

<https://github.com/xkshct198570/dsh-whale-memory> · Issues and releases: GitHub Releases.

## License

MIT.
