# End-to-End User Journey

This document walks through the **common scenarios** a home user or small-team admin wants to achieve with a GateControl Home Gateway. Each scenario is a sequential checklist — prerequisites, UI clicks, commands, verification — so you can go from zero to working access in 15–30 minutes.

If you are still deciding whether a Home Gateway is the right fit, read **[02 — Decision Guide](02-decision-guide.md)** first. If a step surprises you, consult **[04 — Troubleshooting](04-troubleshooting.md)**.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Scenario A — Expose a NAS via HTTPS (most common)](#scenario-a--expose-a-nas-via-https-most-common)
- [Scenario B — Remote Desktop to a home PC](#scenario-b--remote-desktop-to-a-home-pc)
- [Scenario C — Wake a sleeping desktop on demand](#scenario-c--wake-a-sleeping-desktop-on-demand)
- [Scenario D — Expose a non-HTTP service (SSH / DB / game server)](#scenario-d--expose-a-non-http-service-ssh--db--game-server)
- [Scenario E — Multiple devices behind one Home Gateway](#scenario-e--multiple-devices-behind-one-home-gateway)
- [What you just built](#what-you-just-built)

---

## Prerequisites

Before starting any scenario, make sure you have:

1. **A running GateControl Server** — deployed according to [INSTALL.md](https://github.com/CallMeTechie/gatecontrol/blob/master/INSTALL.md). You can reach the admin UI, you can log in.
2. **A registered domain** with DNS control. You will create one A-record per service you expose (e.g. `nas.example.com`, `rdp.example.com`).
3. **An always-on device in your home LAN** to host the Home Gateway container — Raspberry Pi, Mini-PC, Synology NAS, Proxmox VM, etc. Linux with Docker is required. See [deployment docs](../deployment/) for platform-specific setup.
4. **The target device must be reachable from the Home Gateway host** on its LAN IP. Test before starting: `ping` and `curl` from the Gateway host to the target should succeed.

> **Heads up for VMs:** Running the Gateway inside a VM requires **bridge networking** (not NAT). NAT breaks Wake-on-LAN and raw ARP. See [04 — Troubleshooting: "VM network mode"](04-troubleshooting.md#vm-network-mode).

---

## Scenario A — Expose a NAS via HTTPS (most common)

**Goal:** Access your Synology / TrueNAS / UnRAID web UI at `https://nas.example.com` from anywhere, with automatic TLS.

### Step 1 — Create the Gateway peer

1. Open the GateControl admin UI.
2. **Peers** → **New peer**.
3. Name it something descriptive, e.g. `home-gateway`.
4. Check **"Home Gateway"** (this is important — it marks the peer as a gateway container, not a standard client peer).
5. Save.

The peer detail page now shows a **"Download gateway config"** button. Click it. You get `gateway-<id>.env` — keep this file, it contains the peer's private key plus API tokens.

### Step 2 — Deploy the Gateway container at home

On your home LAN host, create a dedicated directory and place the `.env` file inside:

```bash
mkdir -p /opt/gatecontrol-gateway/config
cp ~/Downloads/gateway-<id>.env /opt/gatecontrol-gateway/config/gateway.env
cd /opt/gatecontrol-gateway
curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml
docker compose up -d
```

The container:

- Brings up a WireGuard tunnel to the GateControl server
- Starts the management API on the tunnel IP (default `10.8.0.x:9876`)
- Begins sending heartbeats every 30 seconds

### Step 3 — Verify the Gateway connected

Back in the admin UI:

1. **Peers** → click the `home-gateway` peer.
2. Status should turn **online** within ~30 s.
3. The peer detail shows "Last heartbeat: N seconds ago" and "Health: ok".

If the status stays offline for more than 60 s, see [04 — Troubleshooting: "Gateway stays offline"](04-troubleshooting.md#gateway-stays-offline).

### Step 4 — Create a DNS A-record

In your DNS provider:

```
nas.example.com.   IN  A   <public IP of your GateControl server>
```

Wait until propagation is complete (usually under a minute for most providers). Verify with:

```bash
dig +short nas.example.com
# must return your server's public IP
```

### Step 5 — Create the HTTP route

In the admin UI:

1. **Routes** → **New route**.
2. **Domain:** `nas.example.com`
3. **Target type:** `Home Gateway` (not `Peer`)
4. **Gateway peer:** pick `home-gateway` from the dropdown
5. **LAN target host:** the LAN IP of your NAS, e.g. `192.168.1.50`
6. **Target port:** the port the NAS serves on, e.g. `5000` for Synology HTTP or `5001` for HTTPS
7. **Backend HTTPS:** enable **only** if the target is HTTPS with a self-signed cert (typical for Synology on 5001, UnRAID, Fritzbox)
8. Save

Within a few seconds Caddy on the GateControl server acquires a Let's Encrypt certificate for `nas.example.com` and starts serving.

### Step 6 — Verify access

Open `https://nas.example.com` in a browser. You should see your NAS login page, TLS padlock green.

From CLI (quick sanity check):

```bash
curl -sI https://nas.example.com | head -3
# Expect: HTTP/2 200 or HTTP/2 302 (login redirect)
```

You are done. Any time you add another service in the LAN (e.g. `plex.example.com`), just repeat Steps 4–5. The Gateway container keeps running; routes are added via the admin UI and pushed automatically.

---

## Scenario B — Remote Desktop to a home PC

**Goal:** Connect to a Windows PC in your LAN via RDP from anywhere, without opening port 3389 on your home router.

Two ways to do this. Pick one.

### Option 1 — RDP Route with access mode "Home Gateway" (recommended)

This keeps all the RDP-specific features (credential vault, resolution profiles, clipboard policy, audio, WoL trigger) and hides the LAN IP from the client.

Requires Steps 1–3 from Scenario A (Gateway peer created + container running).

1. **Routes** → **New RDP route**.
2. **Name:** `Home Desktop`
3. **Access mode:** `Over Home Gateway`
4. **Gateway peer:** `home-gateway`
5. **LAN target:** `192.168.1.100:3389` (or whatever the Windows machine answers on)
6. **Public listen port:** pick an unused port on the GateControl server, e.g. `13389`
7. **Credentials:** optional — store username/password for one-click connect
8. Save

Under the hood GateControl auto-creates an L4 TCP route that forwards the public listen port through the Gateway to the LAN RDP port. The `.rdp` file you download uses the server's public address + listen port, never the LAN IP.

From a client machine:

- Download the `.rdp` file from the Routes page and double-click, or
- Use any RDP client with address `yourdomain.com:13389`

### Option 2 — L4 TCP route only (simpler, fewer features)

If you just want "RDP on a public port" without the RDP feature set, create a plain L4 route:

1. **Routes** → **New L4 route**.
2. **Name:** `RDP to home desktop`
3. **Protocol:** TCP
4. **Listen port:** `13389` on the GateControl server
5. **Target type:** `Home Gateway`
6. **Gateway peer:** `home-gateway`
7. **LAN target:** `192.168.1.100:3389`
8. Save

Client connects with `mstsc /v:yourdomain.com:13389` — nothing else to configure on the server side.

---

## Scenario C — Wake a sleeping desktop on demand

**Goal:** Your Windows desktop is usually asleep. When you try to connect via RDP, the Gateway should wake it, wait for the OS to respond, then tunnel through.

This combines an RDP/L4 route (from Scenario B) with Wake-on-LAN configuration. It only works if:

- **BIOS**: Wake-on-LAN is enabled in the target's BIOS/UEFI
- **OS**: Power settings allow "Wake this device" on the network adapter (Windows → Device Manager → NIC → Properties → Power Management)
- **Switch/Router between Gateway and target**: does NOT strip magic packets. Unmanaged switches are fine; some managed switches need IGMP/multicast tweaks. See [04 — Troubleshooting: "WoL never wakes device"](04-troubleshooting.md#wol-never-wakes-device).
- **Network mode**: the Gateway container uses **host networking** (required for raw broadcast packets).

### Step 1 — Find the MAC address

On the target device:

- Windows: `ipconfig /all` — "Physical Address"
- Linux: `ip link show` — `link/ether AA:BB:CC:DD:EE:FF`
- macOS: `ifconfig | grep ether`

### Step 2 — Enable WoL on the route

In the route settings (from Scenario B Option 1 or 2):

1. **Wake-on-LAN:** enable
2. **Target MAC:** `AA:BB:CC:DD:EE:FF`
3. **WoL timeout:** how long to wait for the target to respond after the magic packet (default 60 s)
4. **WoL polling interval:** how often the Gateway retries the TCP connect during the wake window (default 3 s)
5. Save

### Step 3 — Trigger the wake

Simply connect to the route from your client. The monitoring system on the GateControl server detects the target is down, instructs the Gateway to send the magic packet, waits for the target to come up, then passes the connection through. Latency on first connect: 15–45 s depending on the device.

Subsequent connections (while the device stays awake) are instant.

---

## Scenario D — Expose a non-HTTP service (SSH / DB / game server)

**Goal:** Reach any TCP or UDP service in the LAN via a public port.

This is a pure L4 route. Same recipe as Scenario B Option 2, different protocol/port:

| Service | Protocol | LAN port | Suggested public port |
|---|---|---|---|
| SSH to a home server | TCP | 22 | 2222 |
| PostgreSQL | TCP | 5432 | 15432 |
| Minecraft | TCP + UDP | 25565 | 25565 |
| Plex | TCP | 32400 | 32400 |

For UDP and multi-port services (Minecraft needs TCP+UDP on the same port), create two routes — one per protocol.

**Avoid public ports 80, 443, 22, 2019, 3000, 51820** — these are used by the GateControl server itself. The admin UI rejects them.

Connect from client:

```bash
ssh -p 2222 user@yourdomain.com                    # SSH
psql -h yourdomain.com -p 15432 -U postgres         # PostgreSQL
# Minecraft: add "yourdomain.com:25565" in the launcher
```

---

## Scenario E — Multiple devices behind one Home Gateway

**This is where the Home Gateway shines.** One container, one WireGuard tunnel, unlimited devices.

Typical homelab setup:

| Subdomain | Target | Port | Route type |
|---|---|---|---|
| `nas.example.com` | Synology DSM | `192.168.1.50:5001` | HTTP + Backend HTTPS |
| `photos.example.com` | Synology Photos | `192.168.1.50:6001` | HTTP + Backend HTTPS |
| `hass.example.com` | Home Assistant | `192.168.1.60:8123` | HTTP |
| `jellyfin.example.com` | Jellyfin | `192.168.1.60:8096` | HTTP |
| `rdp.example.com:13389` | Windows desktop | `192.168.1.100:3389` | L4 / RDP |
| `ssh.example.com:2222` | Home server | `192.168.1.10:22` | L4 |
| `router.example.com` | Fritzbox UI | `192.168.1.1:443` | HTTP + Backend HTTPS |

All of these run through the same Gateway container. No changes on any of the target devices — no WireGuard installation, no router port forwards, no dynamic-DNS clients.

---

## What you just built

A Home Gateway setup gives you:

- **Zero-touch target devices** — no agents installed, no router configuration, no VPN client on the NAS or the Windows PC
- **Central management** — all routes live in the GateControl admin UI; add/remove/toggle with a click
- **Automatic TLS** — every HTTP route gets a Let's Encrypt certificate with zero configuration
- **Per-route auth** — protect routes with email OTP, TOTP, or basic auth via route-auth settings (independent of the GateControl admin login)
- **Audit log** — every connection and configuration change is recorded in the activity log

Next steps:

- **[02 — Decision Guide](02-decision-guide.md)** — when should a device use a Gateway vs. a classic Peer?
- **[03 — Features Reference](03-features-reference.md)** — full detail on HTTP proxy, L4 proxy, WoL, monitoring, auto-sync
- **[05 — Security Model](05-security-model.md)** — what the Gateway can and cannot see, attack surface, hardening choices
