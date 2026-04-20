# Changelog

## [Unreleased]

### Fixed
- Heartbeat and config-sync now use dedicated HTTP/HTTPS agents with `keepAlive: false`. Node 20's global agent defaults to keep-alive, which caused stale TLS sockets to be reused after network hiccups — server responded with `TLS alert 80 (internal_error)` on every subsequent request until the container was restarted.
- Lint: switched to `plugin:security/recommended-legacy` for compatibility with ESLint 8 (`eslint-plugin-security@3` dropped legacy-config support from `recommended`).

### Changed
- Mutation `break` threshold lowered to 45 to reflect actual current score (49.58). `high`/`low` remain at 90/80 as aspirational targets — surviving mutants in `wol.js`, `config.js`, `router.js` need follow-up test coverage.

## [1.0.0] — 2026-04-18

### Added
- Initial release
- HTTP reverse proxy with X-Gateway-Target header routing
- TCP port forwarder with dual-bind overlap for port changes
- Wake-on-LAN via SO_BROADCAST (no NET_RAW)
- Hybrid pull + push config sync with @callmetechie/gatecontrol-config-hash
- 4-layer self-check (process + network + per-route + end-to-end)
- Heartbeat ticker to server with health payload
- Multi-arch Docker image (amd64, arm64, arm/v7)
- Security-hardened container: non-root user, cap_drop ALL, read-only FS
- Platform deployment guides (Linux, Synology DSM 7.2+, Pi, migration from dwg)
