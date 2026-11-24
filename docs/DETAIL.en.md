![Whale Memory](preview.svg)

Local long-term memory for DeepSeek Harness sessions: recall before each turn, a reviewable panel, and rules whose source of truth is a local git Markdown repository. The database is only a search mirror.

## Features

1. **Automatic recall** — before each turn, search local memories and inject the relevant ones under an intent budget (chat 3 / troubleshooting 5 / recall 4 / image 0). A 2-second timeout skips the turn instead of blocking the reply.
2. **Local long-term store** — nodes carry level, type, bitemporal fields and workspace isolation; stored in local SQLite (`$DSH_HOME/whale-memory/memory.db`) by default. No external service.
3. **Six-tab panel** — overview, memories (search/edit/archive/import/export), recall, writes & relations, rules, settings. The rules tab includes proposals, history diff/rollback, git status, and `/rules/health`.
4. **Controlled writes** — one memory ≤500 characters; shadow review by default, so candidates enter the store only after acceptance; JSONL import/export; audits kept.
5. **Versioned rules** — iron rules live in `~/.dsh/rules/` Markdown files. Proposal → plan/apply → one commit; purge writes a tombstone and the number is never reused. The database mirror is for the panel only and is excluded from recall.
6. **Session wrap** — saying "wrap up" / "switch session", going idle, or closing a session distils lessons, decisions and open loops in one bounded pass. Candidates stay in shadow, rules only become proposals, and reports contain no raw conversation.
7. **Migration** — `migrate-audit` performs read-only reconciliation and backs up before migrating relation edges; see `docs/MIGRATION.md`.

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
