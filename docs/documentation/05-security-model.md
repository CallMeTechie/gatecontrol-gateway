# Security Model

This document describes what the Home Gateway can and cannot see, what attack surfaces it exposes, and which hardening controls are in place. Target audiences:

- **Homelabbers** who want to understand the trust boundaries before exposing the NAS to the internet
- **Admins** responsible for small-business / non-profit deployments who need audit-ready answers
- **Security reviewers** doing a sanity check before approving the Gateway in a locked-down environment

---

## Table of Contents

- [Threat Model](#threat-model)
- [Trust Boundaries](#trust-boundaries)
- [What the Gateway Can See](#what-the-gateway-can-see)
- [What the Gateway Cannot See](#what-the-gateway-cannot-see)
- [Container Hardening](#container-hardening)
- [Authentication and Authorization](#authentication-and-authorization)
- [Transport Encryption](#transport-encryption)
- [Attack Surface Analysis](#attack-surface-analysis)
- [Kill-Switch Interaction](#kill-switch-interaction)
- [Audit Trail](#audit-trail)
- [Compromise Recovery](#compromise-recovery)

---

## Threat Model

We design against these attackers, in rough decreasing order of attention:

| Attacker | Capability | Mitigation priority |
|---|---|---|
| **Anonymous internet attacker** | Port-scan the public server, brute-force exposed routes, probe the admin UI | High — first line of defense |
| **Opportunistic scraper / bot** | Exploit common vulnerabilities (Log4Shell-style), known-bad user agents | High — automated via caddy-defender bot-blocker |
| **Malicious authenticated user** | Has valid route-auth credentials, tries to exploit the target service | Medium — responsibility of the target application |
| **Compromised LAN device** | Same LAN as the Gateway, tries to pivot through the tunnel to the GateControl server | Medium — LAN-side isolation |
| **Compromised Gateway host** | Attacker has root on the machine running the Gateway container | Low — at that point everything is game over, but we limit blast radius via container hardening |
| **Compromised GateControl server** | Attacker has shell on the VPS | Out of scope — the server is the control plane |
| **Insider: GateControl project maintainer** | Ships a malicious Gateway update | Out of scope — you trust the upstream; use image pinning if in doubt |

---

## Trust Boundaries

Four distinct domains. Traffic crossing a boundary is encrypted or access-controlled.

```
┌──────────────────────────────────────────────────────────────────┐
│  Internet                                                         │
│   - arbitrary traffic                                             │
│   - attackers live here                                           │
└──────────────────┬───────────────────────────────────────────────┘
                   │ HTTPS (Let's Encrypt)
                   │ TCP/UDP (optional TLS via SNI)
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  GateControl Server (VPS)                                         │
│   - Caddy reverse proxy                                           │
│   - Node admin API                                                │
│   - WireGuard endpoint (UDP/51820)                                │
└──────────────────┬───────────────────────────────────────────────┘
                   │ WireGuard tunnel (ChaCha20-Poly1305, Curve25519)
                   │ UDP/51820, encrypted E2E
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  Home Gateway container (LAN)                                     │
│   - Receives from server over tunnel                              │
│   - HTTP proxy + L4 listeners on tunnel IP                        │
│   - Cap-dropped, read-only rootfs                                 │
└──────────────────┬───────────────────────────────────────────────┘
                   │ PLAIN LAN traffic (or Backend HTTPS)
                   │ TCP/UDP within the home network
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  Target LAN device (NAS, desktop, IoT)                            │
│   - Standard application (DSM, RDP, SSH, etc.)                    │
│   - Trust: implicit (it's in your home)                           │
└──────────────────────────────────────────────────────────────────┘
```

The critical boundary is **Internet → Server**. Everything past that is either encrypted (WG tunnel) or on your local network.

---

## What the Gateway Can See

### Inside the tunnel

- **Plaintext HTTP** requests and responses on the LAN side — after the tunnel decrypts them. The Gateway acts as a reverse proxy, so it temporarily holds full request bodies and response bodies in memory. Nothing is logged at `info` level; at `debug` level only the URL, not the body.
- **TCP/UDP payloads** on L4 routes, also plaintext on the LAN side. The Gateway does not inspect these — it is a byte-copying proxy.
- **LAN network** — the Gateway is a full LAN citizen (host networking). It can see all broadcast / multicast traffic the host can see. It does **not** do ARP poisoning, mDNS spam, or any other L2 abuse; it only listens passively and only initiates connections to targets configured via routes.

### Inside the container

- Its own `gateway.env` (contains API tokens and WireGuard private key)
- Its own runtime config in `/etc/wireguard` (tmpfs, lost on restart)
- Nothing else — the container is not root-on-host, the image has no shell tools useful for enumeration, everything else is read-only

### Outside the container

- Nothing. The container has:
  - No access to the host's `/etc`, `/home`, `/var/lib` (only the volumes you explicitly mount)
  - No access to Docker socket (never mount `/var/run/docker.sock`)
  - No access to systemd journal or other containers

---

## What the Gateway Cannot See

- **TLS-terminated HTTPS payload from the client** (when using Backend HTTPS, the tunnel delivers HTTPS traffic end-to-end from the server's Caddy directly to the target — the Gateway only sees the wire bytes, not plaintext)
- **Other WireGuard peers' traffic** — the WG tunnel is point-to-point between this Gateway and the server; you don't see the traffic of the admin's laptop-peer even though both use the same GateControl instance
- **The server's admin UI or database** — the Gateway has API-token access to a narrow set of gateway-specific endpoints (sync config, report heartbeat, push WoL). It cannot list other peers, cannot read routes it doesn't own, cannot trigger backups, cannot read activity logs
- **The GateControl server's host filesystem** — only the API surface is reachable

---

## Container Hardening

The shipped `docker-compose.example.yml` applies these controls:

### Capabilities

```yaml
cap_drop:
  - ALL
cap_add:
  - NET_ADMIN          # wg-quick needs to configure the wg0 interface
  - NET_BIND_SERVICE   # to bind ports <1024 (DNS, HTTP, SSH) on L4 routes
```

`NET_RAW` is **not** added. WoL uses `SO_BROADCAST` (allowed by NET_ADMIN), not raw sockets.

### Filesystem

```yaml
read_only: true
tmpfs:
  - /tmp
  - /run
  - /etc/wireguard     # wg-quick writes runtime config here
```

`read_only: true` prevents an attacker who gains code-execution from persisting changes. Everything writable is in tmpfs, gone on restart.

### User

The container image runs as a non-root user (`gateway`, UID 1000). Combined with cap_drop, this means even a full process-compromise cannot escape into other host namespaces.

### No-new-privileges?

**Intentionally NOT set.** `no-new-privileges` conflicts with `cap_add: NET_ADMIN` for non-root users on Linux — `wg-quick` internally calls `ip`/`iptables` which need ambient capabilities, and those are blocked for UID != 0 when `no-new-privileges` is set. We chose compatibility (the shipped controls are strong enough) over the extra flag.

Compensating controls: `cap_drop: ALL`, `read_only: true`, non-root USER, seccomp-default (Docker's default profile).

### Seccomp

Docker's default seccomp profile is active. No custom profile — the default already blocks the syscalls that matter (kexec, ptrace-other-process, mount, etc.). If you need a stricter profile, supply one via `security_opt: seccomp=/path/to/profile.json`.

### Health check

Docker's healthcheck polls `GET http://127.0.0.1:9876/health` every 60 seconds. Failing healthchecks restart the container after 3 consecutive failures.

---

## Authentication and Authorization

### Gateway → Server

Each Gateway has a **pair of tokens** in `gateway.env`:

| Token | Purpose |
|---|---|
| `api_token` | Authenticates server-bound requests (heartbeat, sync, reachability report). SHA-256 hashed server-side. |
| `push_token` | Authenticates the server → Gateway direction (WoL trigger, force-sync). Gateway validates. |

Both are 32-byte crypto-random values (256-bit entropy). They are shown once at peer creation and stored on the server only as hashes.

Rotate via **Peers → peer detail → Rotate tokens**. Old tokens invalidate immediately; the Gateway gets a gentle error on the next call and the admin must deploy the new `.env`.

### Server → Gateway

API calls from server to Gateway use the `push_token`. All calls go through the WireGuard tunnel; no authentication is accepted on any other interface.

### Route-level auth

Independent of Gateway authentication. See the main [GateControl docs](https://github.com/CallMeTechie/gatecontrol) — each route can require:

- Basic auth (username/password)
- Email OTP
- TOTP
- 2FA combinations

These authenticate the **user** hitting the route, not the transport. A Home Gateway route can (and usually should) layer route-auth on top of the Gateway transport.

---

## Transport Encryption

### Internet → Server

- **HTTPS routes**: TLS 1.2+ via Let's Encrypt. HTTP auto-redirects to HTTPS.
- **L4 routes**: optional TLS via Caddy's layer4 plugin. Three modes: `none` (raw TCP), `passthrough` (TLS-SNI routing, no termination), `terminate` (Caddy handles TLS).
- **WireGuard endpoint**: UDP/51820, ChaCha20-Poly1305 AEAD, Curve25519 ECDH.

### Server ↔ Gateway

All application traffic rides the WireGuard tunnel — server-to-Gateway and Gateway-to-server. This is **end-to-end encrypted** with the modern WireGuard cryptographic primitives. No plain TCP across the internet at any point.

### Gateway → LAN target

**Plain TCP/HTTP by default.** This is acceptable because the Gateway and target are both inside your home network. If your LAN is itself hostile (coworking space, shared flat, public WiFi on the Gateway host), you should:

1. Isolate the Gateway on its own VLAN
2. Enable `Backend HTTPS` for HTTP routes so the server-to-target hop is encrypted end-to-end (server's Caddy speaks HTTPS to the target; the Gateway only forwards bytes)

---

## Attack Surface Analysis

Ranked from most exposed to least.

### 1. Public Caddy (GateControl server)

Every L4 port and HTTP route is exposed to the internet. Standard web attack surface: TLS parsing, HTTP parsing, plugin bugs. Caddy is written in Go with TLS 1.3 and strict parsing; no known unpatched CVEs at time of writing (see `trivy` scan in CI).

**Your control:** keep the server image updated (`update.sh`). Automatic container scanning (Trivy) runs on every release and blocks on HIGH/CRITICAL CVEs.

### 2. Route-auth pages

Optional, but if enabled, they handle user input. Password hashing is Argon2id, CSRF tokens are HMAC-signed and domain-bound, rate limiting is 5 login attempts per 15 minutes per IP.

### 3. WireGuard endpoint

UDP/51820. WireGuard has an excellent security track record — no known remote-exploitable CVEs. The protocol is designed to be silent to unauthorized peers (no response to unkeyed traffic).

### 4. Gateway Management API

Only reachable via the WireGuard tunnel. An attacker would need to first compromise the WireGuard tunnel (which is infeasible without the server's private key) or the server (much bigger problem than the Gateway).

### 5. Gateway LAN exposure

The Gateway container listens on `HTTP_PROXY_PORT` (default 8080) on the tunnel IP. It does not listen on any other interface. LAN-side, the Gateway only *initiates* connections to targets; it does not expose any service to other LAN devices.

---

## Kill-Switch Interaction

The Home Gateway is a different topology from a standard VPN client, so the kill-switch concept does not apply directly:

- **A standard VPN client** has a kill-switch to prevent traffic leaking outside the tunnel when the tunnel drops. Useful for laptops on public WiFi.
- **A Home Gateway** is itself a tunnel endpoint. If its tunnel drops, no traffic flows. There is nothing to "leak" because the Gateway does not actively NAT LAN-device traffic to the internet through the tunnel.

If you want your LAN devices to use the GateControl server as an outbound internet gateway (route LAN-sourced traffic to the internet via the tunnel), that is a separate feature (future work — not part of the current Home Gateway). The current design is **inbound only**: server-initiated requests arrive at the Gateway and get proxied to LAN targets. Outbound LAN traffic (e.g. your NAS talking to a weather service) uses the normal LAN default route, not the tunnel.

---

## Audit Trail

### Server-side

Every configuration change is recorded in the GateControl activity log:

- `peer_created` / `peer_deleted` / `peer_updated`
- `route_created` / `route_deleted` / `route_updated`
- `gateway_offline` / `gateway_online` (state machine transitions)
- `gateway_flap_warning` (stability issue)
- Optionally: `login_failed`, `account_locked` (route-auth events)

Retention is configurable (default 30 days). Export to CSV/JSON in Settings → Logs.

### Gateway-side

Container logs via Docker's default JSON-file driver. 10 MB rotation, 3 files kept. For long-term retention, pipe to Loki / Elasticsearch / Syslog via Docker's log driver config.

The Gateway logs:

- Startup: config version, tunnel endpoint, route count
- Route changes: added/removed/disabled
- Heartbeat summary (per cycle, at `info` level)
- Probe results (each targeted LAN service's reachability)
- Errors: failed connect, cert validation, config apply

At `info` level the logs are structured JSON, every line includes `time`, `level`, `msg`, and contextual fields (route_id, domain, target). Safe to ingest into any JSON-aware log store.

---

## Compromise Recovery

### Suspected Gateway compromise (unusual process running, unexpected network calls)

1. Stop the container: `docker compose down`
2. Rotate the gateway tokens: **Peers → peer detail → Rotate tokens**
3. Review the activity log for unexpected route changes in the last 7 days
4. Re-download the `gateway.env` and bring a fresh container up from the clean image
5. Confirm the container image tag is from your trusted upstream (`ghcr.io/callmetechie/gatecontrol-gateway:latest`)

### Suspected LAN target compromise (e.g. NAS running crypto miner)

1. Disable all routes pointing to that target (Routes → toggle off)
2. Fix the target on its own (reset, patch, restore from backup)
3. Re-enable routes once the target is clean

### Suspected WireGuard key leak

1. Delete the peer entirely (**Peers → peer detail → Delete**) — this invalidates the WG keypair
2. Create a new Gateway peer with a new keypair
3. Deploy the new `.env` to the Gateway host
4. Old keys are useless — the server rejects them

---

## Further reading

- **[03 — Features Reference](03-features-reference.md)** — per-feature detail
- **[04 — Troubleshooting](04-troubleshooting.md)** — operational issues
- [GateControl Server security docs](https://github.com/CallMeTechie/gatecontrol#security) — full security chapter in the server README
