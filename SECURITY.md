# Security policy

## Reporting

Please open a private security advisory on GitHub
(`Security` → `Advisories` → `Report a vulnerability`) instead of a public issue
when a report includes an exploitable path or user data. For non-sensitive hardening
suggestions, a normal issue is fine.

## Scope

- The panel/API binds to loopback by default. `panel.allowRemote` only adds
  read-only access from the configured `webServer.host`; write endpoints remain
  loopback-only.
- Tokens for optional external memory backends are read from the host credential
  service or `WHALE_MEMORY_TOKEN`; they are never written to Config, logs, or memory rows.
- The rules repository is a purely local git repository: the plugin never fetches,
  pushes, or opens the network on its behalf.
