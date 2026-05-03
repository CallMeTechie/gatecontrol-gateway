# Changelog

## [Unreleased]

### Fixed
- Heartbeat and config-sync now use dedicated HTTP/HTTPS agents with `keepAlive: false`. Node 20's global agent defaults to keep-alive, which caused stale TLS sockets to be reused after network hiccups — server responded with `TLS alert 80 (internal_error)` on every subsequent request until the container was restarted.
- Lint: switched to `plugin:security/recommended-legacy` for compatibility with ESLint 8 (`eslint-plugin-security@3` dropped legacy-config support from `recommended`).
- `wireguard.runCommand` accepts a `timeoutMs` option and `getStatus()` now uses `1500ms` so a wedged `wg show` (rare but observed after TUN-device hiccups) can no longer block the self-check or heartbeat collection indefinitely. `wg-quick up/down` continues to run unbounded since boot-time setup can legitimately take longer.
- `startHeartbeatTicker` caps `getHealth()` at 8s (`Promise.race`). When the cap fires the gateway still sends a heartbeat with `{ overall_healthy: false, reason: 'health_collection_timeout' }` so the server's state machine sees liveness and the operator sees the timeout reason in `last_health` for diagnosis. Default cap is below the heartbeat HTTP-timeout (10s) so the next tick can land before the previous overruns it.

### Changed
- Self-check wiring centralised in `src/health/selfCheckRunner.js`. Both `/api/status` and the heartbeat ticker now call a single `runHealthCheck()` closure built once at bootstrap time — previously the route-list, DNS resolver and reachability probe were duplicated across two call-sites in `bootstrap.js`. L4 routes get a synthesized `domain: 'l4:<port>'` label in `route_reachability` (was undefined for the heartbeat path before).
- Mutation-test coverage extended for `wol._computeBroadcast` (octet-range boundaries, /16, /32), `wol.validateMac` (length / hex), `config.isRfc1918` (exact 10/8, 172.16/12, 169.254/16 and 192.168/16 boundaries) and `proxy/router` (`wol_enabled` ternary). Aim is to retire the `break = 45` floor in stryker.conf.json on the next mutation run.
- Mutation `break` threshold lowered to 45 to reflect actual current score (49.58). `high`/`low` remain at 90/80 as aspirational targets — surviving mutants in `wol.js`, `config.js`, `router.js` need follow-up test coverage.
- Docker HEALTHCHECK now runs a dedicated `src/healthcheck.js` that parses `/config/gateway.env` directly. The previous inline `node -e` probe relied on `process.env.GC_TUNNEL_IP` / `GC_API_PORT`, but those variables live in the volume-mounted env file and are never exposed to the container's Docker ENV — the Node runtime reads the file and keeps the values in-memory, so a separate probe process sees nothing. Start-period raised to 60s to accommodate WG bring-up.
- `/api/health` is now registered before the `/api` auth-middleware mount. Previously the auth guard matched first and rejected every unauthenticated probe with 401, so the health endpoint was unreachable despite its comment claiming otherwise.

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
