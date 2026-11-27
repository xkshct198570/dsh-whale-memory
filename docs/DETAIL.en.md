![Whale Memory](preview.svg)

Local long-term memory for DeepSeek Harness sessions: recall before each turn, a reviewable panel, and rules whose source of truth is a local git Markdown repository. The database is only a search mirror.

## Features

1. **Automatic recall** — before each turn, search local memories and inject the relevant ones under an intent budget (chat 3 / troubleshooting 5 / recall 4 / image 0). A 2-second timeout skips the turn instead of blocking the reply.
2. **Local long-term store** — nodes carry level, type, bitemporal fields and workspace isolation; stored in local SQLite (`$DSH_HOME/whale-memory/memory.db`) by default. No external service.
3. **Six-tab panel** — overview, memories (search/edit/archive/import/export), recall, writes & relations, rules, settings. The rules tab includes proposals, history diff/rollback, git status, and `/rules/health`.
4. **Controlled writes** — one memory ≤500 characters; direct writes are shadow-reviewed by default, while wrap memories passing the value gate land automatically (task instructions/version state rejected, ambiguous ones go to review; switch `review` to keep everything shadowed); JSONL import/export; audits kept.
5. **Versioned rules** — iron rules live in `~/.dsh/rules/` Markdown files. Proposal → plan/apply → one commit; purge writes a tombstone and the number is never reused. The database mirror is for the panel only and is excluded from recall.
6. **Session wrap v2** — saying "wrap up" / "switch session", going idle (card switch), or closing a session distils lessons, decisions and open loops in one bounded pass. Pick a session, click queues with 202 + progress, and each session can skip auto-wrap. An optional Reconcile pass (default off) compares candidates with existing memories and only produces shadow ADD/UPDATE/MERGE/ARCHIVE decisions. Ambiguous/low-confidence candidates stay in shadow while durable memories land automatically; rules only become proposals, and reports contain no raw conversation.
7. **Layers and the first-turn profile** — wrap/reflection writes carry a `fact`/`lesson`/`user` layer (direct panel writes and legacy rows stay NULL; `memory_*` tool writes carry the layer); the first turn of a session renders a ≤800-character profile from that identity's `user` top5 / `lesson` top5 / `fact` top3 and injects it once. Later turns never repeat it; subagents or undetermined identity skip it, failures are logged only.
8. **Model tools and reflection** — the model can call `memory_remember/search/read/update/forget` (identity fixed to the current session, per-turn write cap, cross-partition ids behave as missing). Reflection triggers after ≥7 tool steps in a turn or when idle; off by default, capped per local day and suppressed inside `maintenance.suppressWindows` peak windows (manual runs bypass both but still need an identity).
9. **Migration** — `migrate-audit` performs read-only reconciliation and backs up before migrating relation edges; see `docs/MIGRATION.md`.

## Install

- Search `dsh-whale-memory` in the Plugins market (once listed);
- or install the release tarball: `dsh plugin --profile <profile> add <dsh-whale-memory.tgz>`;
- for local development use `link:<repository-directory>`.
- Requires DSH `>=0.2.2-rc.5 <0.3.0`, Node `>=22.13.0`.

## Use

1. Works out of the box: local store and automatic recall; no API key or external service.
2. Say “from now on …” to draft a rule → reply `收录 <p...>` or confirm in the Rules tab. A plan with per-file guards is shown before apply.
3. The Rules tab supports create/edit/retire/purge, history diff and rollback; `/rules/health` checks files, manifest, tombstones, chains and numbers.
4. Global rules render into `AGENTS.md`. On a clean install the plugin creates a minimal managed block; an existing file without markers is never appended to.

## Privacy and limits

Data stays local by default. Only when the backend is manually set to `http`/`hybrid` does it send stats/recent/search/recall/write/version requests to the configured URL; no telemetry, no outbound copy. Raw wrap material lives only in a 0600 spool (24h TTL by default, excluded from backups); reports, logs and status never contain raw conversation. Recall fails open; global rules depend on the AGENTS digest; with `rules.llm=false`, merge/conflict candidates need a panel rewrite.
