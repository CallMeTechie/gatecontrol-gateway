# Features Reference

Comprehensive reference of every capability the GateControl Home Gateway exposes. Use this as a lookup — each section answers "what does it do, how do I turn it on, what are the edge cases."

For task-oriented step-by-step guides see **[01 — User Journey](01-user-journey.md)**. For an overview of the architecture see the top-level [README](../../README.md).

---

## Table of Contents

- [HTTP Reverse Proxy (Layer 7)](#http-reverse-proxy-layer-7)
- [TCP/UDP Proxy (Layer 4)](#tcpudp-proxy-layer-4)
- [Wake-on-LAN](#wake-on-lan)
- [RDP via Home Gateway](#rdp-via-home-gateway)
- [Auto-Sync with Server](#auto-sync-with-server)
- [Heartbeat and Health](#heartbeat-and-health)
- [Management API](#management-api)
- [Logging](#logging)

---

## HTTP Reverse Proxy (Layer 7)

### What it does

The Gateway exposes an HTTP proxy that terminates the server-initiated request (arriving via WireGuard on the Gateway's tunnel IP) and forwards it to the configured LAN target. Response goes back the same path.

From the outside caller's view, `https://nas.example.com` is served by Caddy on the GateControl server. Caddy proxies to the Gateway tunnel IP on port 8080; the Gateway looks up the route by domain and forwards to the LAN IP:port.

### Per-route settings

| Setting | Purpose |
|---|---|
| **Domain** | The public hostname. Caddy gets the TLS cert for this. |
| **Target type: `Home Gateway`** | Tells Caddy to forward to the Gateway tunnel IP instead of a direct peer. |
| **Gateway peer** | Which Gateway instance handles this route (you can have many). |
| **LAN target host** | IP or hostname resolvable inside the Gateway's LAN. |
| **LAN target port** | Port the service listens on. |
| **Backend HTTPS** | Enable when the LAN target serves HTTPS (Synology on 5001, Fritzbox, UnRAID). See below. |

### Backend HTTPS

Since server v1.41.11. When enabled, the Gateway speaks HTTPS on the LAN-hop to the target (server → Caddy → Gateway in HTTP, Gateway → LAN target in HTTPS). Without this, services that only answer HTTPS (Synology DSM on :5001, modern Fritzbox, UnRAID, TrueNAS) reject the plain request.

Certificate validation on the LAN-hop is disabled intentionally — most self-hosted appliances use self-signed certs and the LAN hop is inside your home network. If you need strict validation, put a CA-signed cert on the target and open an issue to add a "validate backend cert" toggle.

### Host header rewrite

The Gateway rewrites the `Host` header to match the LAN target (e.g. `192.168.1.50`) before forwarding. Most web apps behind a reverse proxy (NAS UIs, Home Assistant, etc.) expect this. Apps that require the public hostname in the `Host` header (very rare) are not currently supported — open an issue if you hit this.

### Websocket support

Websockets work transparently. Home Assistant's realtime updates, Jellyfin's player, and IDE-over-browser tools all function via the Gateway proxy.

---

## TCP/UDP Proxy (Layer 4)

### What it does

Forwards raw TCP or UDP traffic from a public port on the GateControl server through the Gateway to a LAN target. No protocol awareness — works for anything: RDP, SSH, databases, game servers, MQTT, Modbus, proprietary industrial protocols.

### Per-route settings

| Setting | Purpose |
|---|---|
| **Protocol** | TCP or UDP |
| **Public listen port** | Port on the GateControl server where the client connects |
| **Target type: `Home Gateway`** | Route through the Gateway container |
| **Gateway peer** | Which Gateway handles this |
| **LAN target host + port** | The actual service inside the LAN |

### Typical mappings

| Service | Protocol | LAN port | Suggested public |
|---|---|---|---|
| RDP (Windows) | TCP | 3389 | 13389 |
| SSH | TCP | 22 | 2222 |
| PostgreSQL | TCP | 5432 | 15432 |
| Minecraft (Java) | TCP + UDP | 25565 | 25565 |
| Plex Media Server | TCP | 32400 | 32400 |
| MQTT | TCP | 1883 | 1883 |

For protocols that need both TCP and UDP on the same port (Minecraft, some VoIP), create two routes — one per protocol.

### Reserved ports

The GateControl server blocks binding these public ports because they are used by the server itself:

`80, 443, 22, 2019, 3000, 51820`

Additionally, the admin UI refuses your listen port if another L4 route already uses it. Error messages include the conflicting route.

### Port ranges

A single L4 route can expose a range (e.g. `5000-5010`) for multi-port services. Syntax: `5000-5010` in the listen-port field. Max range is configurable via `GC_L4_MAX_PORT_RANGE` (default 100).

### TLS modes

L4 routes support three TLS modes for HTTPS-on-TCP services:

- **None** — raw TCP forward, no TLS knowledge
- **Passthrough** — TLS-SNI routing; multiple TLS services can share port 443 differentiated by SNI
- **Terminate** — Caddy terminates TLS and forwards plain TCP (not commonly needed for Gateway routes)

See the main [GateControl docs](https://github.com/CallMeTechie/gatecontrol) for TLS mode details — the Gateway-side behavior is transparent.

---

## Wake-on-LAN

### What it does

When a configured target is unreachable and the route has WoL enabled, the Gateway sends a magic packet to the target's MAC address. After sending, the Gateway polls the target port at a configurable interval until the target responds or the timeout expires.

### Requirements

WoL is fragile across the whole stack. Every one of these must be true:

- **BIOS/UEFI on target**: "Wake on LAN" enabled
- **OS power settings**: network adapter allowed to wake the device
- **Switch between Gateway and target**: must not drop broadcast or raw frames. Unmanaged switches are fine; some managed switches need IGMP or multicast tweaks.
- **Gateway container**: runs with `network_mode: host` (required for raw broadcast)
- **Target and Gateway** on the same L2 segment (same VLAN, same switch domain). Magic packets don't route through L3.

See **[04 — Troubleshooting: "WoL never wakes device"](04-troubleshooting.md#wol-never-wakes-device)** for the diagnostic checklist.

### Per-route settings

| Setting | Purpose |
|---|---|
| **WoL enabled** | Toggle |
| **Target MAC** | Physical address of the target NIC (format `AA:BB:CC:DD:EE:FF`) |
| **WoL timeout** | How long to wait for the target to respond (default 60 s) |
| **WoL polling interval** | How often to retry the TCP connect during the wake window (default 3 s) |

### Auto-trigger

WoL triggers automatically when the GateControl server's uptime monitor detects the route went from `up` → `down` and the route has WoL configured. The user does not need to call a manual endpoint — an incoming RDP/HTTP request on a down route starts the wake cycle.

---

## RDP via Home Gateway

Dedicated RDP route type with full feature integration: credential vault, resolution profiles, clipboard/audio/printer policy, session monitoring, WoL trigger, maintenance windows.

Pick one of two topologies:

### Option A — RDP Route with access mode "Home Gateway"

Since server v1.43. Configure an RDP route (Routes → New RDP route) and choose **Access mode: Over Home Gateway**. Under the hood, GateControl auto-creates an L4 TCP route that forwards public listen port → Gateway → LAN RDP port. All RDP-feature niceties preserved; the downloadable `.rdp` file uses the public address + listen port, never the LAN IP.

Recommended for anyone using the RDP-specific features.

### Option B — Plain L4 TCP route

A regular L4 route on port 3389 (or any other public port) with target type "Home Gateway". Works with any RDP-compatible client (mstsc, FreeRDP, Remmina). No credential management in GateControl — the user types username and password into the client.

Recommended when you want raw RDP without the feature set, or when using non-Microsoft clients.

### RD Gateway (TSGateway) note

The RDP route form historically had fields "Gateway host" / "Gateway port" for the Microsoft **RD Gateway** (TSGateway) — an unrelated Microsoft product that tunnels RDP over HTTPS. Those fields are for RD Gateway, not the GateControl Home Gateway. Both can be combined (GateControl Home Gateway to the LAN edge, then RD Gateway inside the LAN for additional routing), but this is rarely needed in homelab.

---

## Auto-Sync with Server

### What it does

The Gateway polls the server every 10 seconds (configurable) for its list of routes. When the config hash changes, the Gateway re-reads the full route list, reconciles local listeners (starts new L4 listeners, stops removed ones), and reports success back.

You never have to restart the Gateway container after changing routes in the UI — the sync handles it.

### Config hash

Server and Gateway share a common `config-hash` module (`@callmetechie/gatecontrol-config-hash` NPM package) that produces a deterministic hash over the route list. The Gateway compares its last-applied hash with the one the server advertises; mismatch triggers a re-sync.

If you see a persistent hash mismatch in the logs, the two sides are running incompatible config-hash versions (very rare; only happens when one side is updated without the other). The server keeps trying until versions align.

### Config rollback

If applying a new route list fails (e.g. a listen port is taken), the Gateway reverts to the last known-good config and reports the failure. The UI shows which route caused the failure.

---

## Heartbeat and Health

### Heartbeat

Every 30 seconds the Gateway POSTs a heartbeat to the server with:

- Its known tunnel IP and WireGuard handshake time
- Per-route reachability status (for every configured L4/HTTP target, did the probe in the last cycle succeed?)
- Self-check: container uptime, memory, CPU
- Current config-hash

The server records `last_seen_at` and feeds the health state machine.

### Health state machine

Server-side, a **sliding-window hysteresis** state machine per gateway peer:

- Window size: 5 probes
- Offline threshold: 3 failures in window
- Online threshold: 4 successes in window
- Cooldown: 5 minutes between transitions (prevents flapping)

The state transitions `unknown → online ↔ offline` drive the UI status indicator and Caddy's behavior (offline → Caddy serves a maintenance page for routes targeting the offline Gateway).

### Server-side TCP probe

Since server v1.54. When a Gateway's last heartbeat is older than 60 seconds, the server probes the Gateway's API port directly (TCP-connect to 127.0.0.1:9876 within the WireGuard tunnel). This catches silently-dead gateways that crashed without a farewell heartbeat, and recovers gateways before the next scheduled heartbeat lands (up to 30 s faster return-to-online on the UI).

See [src/services/gatewayProbe.js](https://github.com/CallMeTechie/gatecontrol/blob/master/src/services/gatewayProbe.js) in the server repo.

### Flap detection

If the state machine transitions more than 4 times per hour, the server logs a `gateway_flap_warning` activity event. Typical causes: unstable upstream internet, overloaded Gateway host, misconfigured health check.

---

## Management API

The Gateway container exposes a small HTTP API on its tunnel IP, port 9876 (default). Used by the server to push commands (WoL trigger, config re-sync, status snapshot).

This API is **only reachable via the WireGuard tunnel** — the Gateway does not expose it on any other interface. Authentication uses the `api_token` from `gateway.env`.

Endpoints (server-consumed, typically not useful for humans):

- `GET /api/v1/status` — self-check
- `POST /api/v1/sync` — force a config re-sync
- `POST /api/v1/wol` — send a magic packet on demand
- `GET /api/v1/probes` — current reachability of configured L4/HTTP targets

---

## Logging

### Where logs go

Container stdout/stderr, captured by Docker. Access via:

```bash
docker logs gatecontrol-gateway --since 1h       # recent entries
docker logs gatecontrol-gateway --follow         # live tail
```

### Log format

JSON lines (pino). Every line has `level`, `time`, `msg`, plus contextual fields. The typical line:

```json
{"level":30,"time":1777040000000,"msg":"HTTP route added","route_id":42,"domain":"nas.example.com"}
```

### Log levels

Set with `LOG_LEVEL` env:

- `debug` — verbose per-request details (development only)
- `info` — startup, route changes, heartbeat summary (default)
- `warn` — recoverable issues (unreachable targets, stale sync)
- `error` — failures

Default is `info`. Switch to `debug` when troubleshooting; revert after.

### Log rotation

Docker's default log driver rotates at 10 MB with 3 files kept (30 MB max per container). For long-running production use, adjust in `docker-compose.yml`:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

---

## Configuration reference

All runtime configuration comes from `gateway.env` (downloaded from the server's Peers → peer detail → "Download gateway config") and a small set of environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_ENV_PATH` | `/config/gateway.env` | Path to the downloaded config (mount as `/config` volume) |
| `LOG_LEVEL` | `info` | Log verbosity |
| `HTTP_PROXY_PORT` | `8080` | Where the Gateway listens for HTTP from the server |
| `MANAGEMENT_PORT` | `9876` | Management API port (tunnel-IP only) |
| `SYNC_INTERVAL_MS` | `10000` | How often to poll the server for config changes |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat cadence |

See `docker-compose.example.yml` in the repo root for the recommended starting point.

---

## Next

- **[04 — Troubleshooting](04-troubleshooting.md)** — when features misbehave
- **[05 — Security Model](05-security-model.md)** — what the Gateway can see, hardening choices
