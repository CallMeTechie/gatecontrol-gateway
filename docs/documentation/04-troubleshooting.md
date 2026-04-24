# Troubleshooting

Diagnostic catalogue for the most common Home Gateway failure modes. Each entry lists the symptom, the likely root causes (in decreasing order of frequency), and the verification command.

For first-time setup, see **[01 — User Journey](01-user-journey.md)**. For what each feature is supposed to do, see **[03 — Features Reference](03-features-reference.md)**.

---

## Table of Contents

- [Gateway stays offline](#gateway-stays-offline)
- [Tunnel up but routes return 502](#tunnel-up-but-routes-return-502)
- [Backend HTTPS target unreachable](#backend-https-target-unreachable)
- [WoL never wakes device](#wol-never-wakes-device)
- [VM network mode (bridge vs NAT)](#vm-network-mode-bridge-vs-nat)
- [Ports conflict / listen port rejected](#ports-conflict--listen-port-rejected)
- [Config sync stuck / hash mismatch](#config-sync-stuck--hash-mismatch)
- [Gateway flaps online/offline](#gateway-flaps-onlineoffline)
- [RDP: credentials rejected after Gateway switch](#rdp-credentials-rejected-after-gateway-switch)
- [Logs show "container read-only filesystem" errors](#logs-show-container-read-only-filesystem-errors)
- [How to get useful logs for a bug report](#how-to-get-useful-logs-for-a-bug-report)

---

## Gateway stays offline

**Symptom:** Created a new gateway peer, container started, but the server UI still shows "offline" after 60 seconds.

### Check 1 — Is the container actually running?

```bash
docker ps --filter name=gatecontrol-gateway
# Expect: Up N minutes (healthy)
```

If the container is not running, check `docker logs gatecontrol-gateway --tail 50`. Common startup failures:

- `gateway.env not found` — volume mount path mismatch. The container looks at `/config/gateway.env` (or wherever `GATEWAY_ENV_PATH` points). Check `docker-compose.yml` has `./config:/config:ro` and `./config/gateway.env` exists on the host.
- `Invalid token format` — the `.env` file was truncated or corrupted during download. Re-download from the server UI.

### Check 2 — Is the WireGuard handshake completing?

From the Gateway host:

```bash
docker exec gatecontrol-gateway wg show
# Expect:
#   peer: ...
#   endpoint: <server public IP>:51820
#   latest handshake: X seconds ago    <-- must be under 3 minutes
```

No handshake ever → the server isn't reachable on UDP/51820 from the Gateway. Check:

- Home router firewall / outbound rules (unusual, but some ISP routers block arbitrary UDP out)
- Corporate / public WiFi blocking non-443 traffic — try from a different network
- Server-side: is port 51820/UDP actually open? `ss -lnup | grep 51820` on the server.

Handshake completes but times out immediately → token mismatch between `.env` and server record. Regenerate the gateway-env in the UI (Peer detail → "Rotate tokens"), re-download, restart Gateway.

### Check 3 — Can the Gateway reach the server's API?

```bash
docker exec gatecontrol-gateway curl -sSI https://<your-gc-server>/health
# Expect: HTTP 200 body {"ok":true}
```

401 or 403 → the API token in `gateway.env` is stale (server was reset, peer re-created, tokens rotated). Re-download the env.

Connection refused / timeout → the Gateway cannot reach the server's admin hostname. Probably DNS issue inside the container. Check that your Docker's embedded DNS can resolve `<your-gc-server>`. Fallback: set `GC_SERVER_IP` in env, Gateway will use it.

---

## Tunnel up but routes return 502

**Symptom:** Gateway shows online in UI, but `curl https://nas.example.com` returns 502 Bad Gateway.

### Check 1 — Is the LAN target actually reachable from the Gateway host?

```bash
# From the Gateway host (not inside the container — host-network shares the namespace):
curl -k https://192.168.1.50:5001/
```

If this fails, the Gateway can't reach the target either. Fix the LAN first (firewall on target, wrong IP, target service down).

### Check 2 — Is the Gateway proxying?

```bash
docker logs gatecontrol-gateway --since 5m | grep -i "502\|error\|proxy"
```

Look for entries like `HTTP route not found` (route config didn't sync yet), `ECONNREFUSED target 192.168.1.50:5001` (LAN target down), `certificate verify failed` (Backend-HTTPS toggle missing).

### Check 3 — Backend HTTPS toggle

If the target serves only HTTPS (Synology on 5001, Fritzbox, UnRAID), enable **Backend HTTPS** in the route. Without this, the Gateway sends a plain HTTP request to an HTTPS-only target and gets 400 / 502 / reset.

### Check 4 — MTU

If requests sometimes succeed (small responses) but fail on large payloads (file listing, image downloads), the WireGuard tunnel's MTU is clipping TCP segments. The server sets MTU=1420 by default with MSS clamping (see `entrypoint.sh` in the server repo). If you overrode this with a custom `GC_WG_MTU`, try reverting to 1420.

---

## Backend HTTPS target unreachable

**Symptom:** Backend HTTPS enabled, but the Gateway still can't reach the target.

### Check 1 — Does the target actually serve HTTPS?

```bash
openssl s_client -connect 192.168.1.50:5001 -servername 192.168.1.50 </dev/null 2>&1 | head -5
# Expect: CONNECTED(00000003) + cert details
```

Some services (old routers, early Fritzbox firmware) present a broken TLS stack. Upgrade firmware if possible.

### Check 2 — Is the cert self-signed or from a private CA?

The Gateway disables certificate validation on the LAN-hop intentionally (most homelabs use self-signed). If your target has a public CA cert and you're still failing, the issue is elsewhere (port wrong, service down).

### Check 3 — HTTP/2 without ALPN

A handful of services only accept HTTP/2 and do not advertise via ALPN. This is a rare misconfiguration on the target side. Test with:

```bash
curl -k --http1.1 https://192.168.1.50:5001/
```

If `--http1.1` works, the target's HTTP/2 setup is broken. Fix on target side or use a different port.

---

## WoL never wakes device

**Symptom:** Target device is asleep. You try to connect to the route. The Gateway logs say it sent the magic packet. The device never comes up.

WoL is fragile. Check these in order:

### Check 1 — Is WoL enabled on the target device?

| OS | Check |
|---|---|
| Windows | Device Manager → Network Adapter → Power Management: "Allow this device to wake the computer" AND "Only allow a magic packet to wake the computer" |
| Windows | Power Options → "Choose what the power button does" → uncheck "Turn on fast startup" (fast startup breaks WoL on many machines) |
| Windows | BIOS/UEFI: "Wake on LAN" / "Power on by PCI-E" enabled |
| Linux | `ethtool eth0 | grep Wake-on` — should show `Wake-on: g` (or contain `g`). Set with `ethtool -s eth0 wol g` |
| macOS | System Settings → Battery → Options → "Wake for network access" |

### Check 2 — Is the MAC address correct?

```bash
# On target while awake:
# Windows:
ipconfig /all   # look for "Physical Address"

# Linux:
ip link show eth0 | grep ether
```

The MAC in the route must match EXACTLY. A common mistake: your target has multiple NICs (Ethernet + WiFi) and you configured the wrong one. WoL over WiFi is rare and usually unsupported — use the wired NIC's MAC.

### Check 3 — Is the Gateway container using host networking?

```bash
docker inspect gatecontrol-gateway --format '{{.HostConfig.NetworkMode}}'
# Expect: host
```

Bridge mode blocks raw broadcast frames. The Gateway's WoL uses SO_BROADCAST which requires host-networking.

### Check 4 — Are Gateway and target on the same L2 segment?

Magic packets don't route through L3. Gateway and target must be on the same VLAN / same switch domain / same subnet. If you have a router between them (e.g. one VLAN for IoT, another for servers), WoL won't cross the router boundary. Move the Gateway to the target's VLAN or set up a WoL relay on the router (some OpenWrt builds, some enterprise routers).

### Check 5 — Does your switch strip broadcast?

Unmanaged consumer switches pass broadcast transparently. Some managed switches with "storm control" or aggressive IGMP snooping drop magic packets. Disable storm control on the target's port or whitelist the Gateway's MAC.

### Verify with an external WoL tool

To confirm WoL itself works independent of GateControl:

```bash
# On any Linux host in the same L2:
apt install wakeonlan
wakeonlan AA:BB:CC:DD:EE:FF
```

If this also doesn't wake the target, the issue is the target / switch / BIOS, not GateControl.

---

## VM network mode (bridge vs NAT)

**Symptom:** Gateway runs in a VM. Tunnel up, routes work, but WoL fails and/or some LAN devices are unreachable.

### Root cause

VMs in **NAT mode** (VMware / VirtualBox / Hyper-V / QEMU defaults) appear to the LAN as the hypervisor. They can send unicast traffic out, but:

- **Incoming broadcast** (including WoL replies, mDNS) is dropped by the hypervisor
- **ARP for LAN IPs** is intercepted — the VM thinks the hypervisor is the target
- **Outgoing broadcast** (WoL magic packet) often dropped or limited to the virtual network

### Fix

Switch the VM's NIC to **bridge mode**. The VM then appears on the LAN with its own MAC and IP, exactly like a physical host.

- **Proxmox:** Hardware → Network Device → Bridge mode (default)
- **ESXi / vSphere:** Port group, not NAT
- **VirtualBox / VMware Workstation:** NIC attachment → Bridged Adapter
- **Hyper-V:** External Virtual Switch (not Internal)

**Synology VMM** forces NAT by default. Use a Synology-hosted Docker directly (see [deployment/synology.md](../deployment/synology.md)) rather than a VM inside VMM.

---

## Ports conflict / listen port rejected

**Symptom:** Creating an L4 route, the UI says "Port X is already in use" or "Port X is reserved".

### Reserved ports

The GateControl server rejects binding these public ports: `80, 443, 22, 2019, 3000, 51820`. They are used by Caddy, SSH, the admin API, Node app, and WireGuard. Pick a different port.

### In-use by another L4 route

Check the Routes list. You probably have an L4 route already on that port (possibly disabled). Error message on create/save includes the conflicting route ID.

### In-use on the host outside GateControl

Less common but possible: something else on the host is listening on the port. Check with:

```bash
ss -lntu | grep ':<port> '
```

---

## Config sync stuck / hash mismatch

**Symptom:** Gateway logs show `config hash mismatch, refetching...` in a tight loop.

### Root cause

The server and Gateway use different versions of `@callmetechie/gatecontrol-config-hash`. This is rare (the package is pinned via peer dependencies), but can happen when one side is rolled back without the other.

### Fix

Update both sides to the same server release. Easiest: pull the latest Gateway image and the latest server image, restart both.

```bash
# On Gateway host:
cd /opt/gatecontrol-gateway
docker compose pull
docker compose up -d

# On GateControl server (usually done separately via update.sh):
cd /opt/gatecontrol
./update.sh
```

If the issue persists, open a GitHub issue with the log line showing both hashes.

---

## Gateway flaps online/offline

**Symptom:** The UI shows the Gateway repeatedly transitioning between online and offline, multiple times per hour.

### Check 1 — Internet stability at the Gateway site

The most common cause. A flaky home ISP or a Gateway host on WiFi can drop heartbeats intermittently.

```bash
# On the Gateway host, ping the server for 5 minutes:
ping -c 300 <your-gc-server>
# Acceptable: <1% loss, avg RTT stable
# Problematic: periodic 100% loss for 3+ seconds at a time
```

If the underlying connection is the issue, reduce heartbeat sensitivity (server-side config) or stabilize the network (move Gateway from WiFi to Ethernet, replace flaky router).

### Check 2 — Gateway host overloaded

Heartbeats can miss their window if the host is CPU-starved.

```bash
docker stats gatecontrol-gateway
# Watch for CPU % > 100 or memory near limit
```

Gateway uses <50 MB RAM and <1% CPU typically. If it's much higher, something else on the host is starving it (a too-ambitious Plex transcode, a memory leak in another container, etc.).

### Check 3 — Flap warnings in server logs

The server logs a `gateway_flap_warning` activity event when it sees >4 transitions in an hour. Check Settings → Activity Log → filter by event type `gateway_flap_warning` for diagnostic detail.

---

## RDP: credentials rejected after Gateway switch

**Symptom:** RDP used to work (direct peer connection), now you routed it via the Gateway, Windows rejects the password with "The logon attempt failed."

### Root cause

This is almost always a **SPN (Service Principal Name) mismatch with NLA**. Details:

- NLA (Network Level Authentication) uses CredSSP to authenticate before the RDP channel opens
- CredSSP verifies the target's certificate CN matches what the client dialed
- When you dial `yourdomain.com:13389` but the Windows machine's cert CN is `DESKTOP-XXXXXX`, the verify fails silently and Windows reports "logon failed"

### Fix

GateControl's **Internal DNS feature** solves this. When enabled, the Gateway registers each peer under its hostname in an internal DNS. RDP Client dialing can then use the FQDN (`desktop.gc.internal`) that matches the cert. The `.rdp` file produced by the UI uses this pattern automatically.

Check server settings → DNS → is internal DNS enabled? (Feature flag `internal_dns`.)

Manual workaround (not recommended for production): disable NLA on the target (`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp\UserAuthentication = 0`). Weaker security but functional.

---

## Logs show "container read-only filesystem" errors

**Symptom:** Gateway container exits during start with errors like `EROFS: read-only file system` when writing to `/tmp` or `/etc/wireguard`.

### Root cause

The default `docker-compose.example.yml` runs the container with `read_only: true` and a specific list of `tmpfs` mounts. If the volume list is incomplete (e.g. someone edited the compose and removed `/etc/wireguard` tmpfs), WireGuard's `wg-quick` can't write its runtime config.

### Fix

Restore the default `docker-compose.example.yml` tmpfs section:

```yaml
tmpfs:
  - /tmp
  - /run
  - /etc/wireguard     # REQUIRED: wireguard-go writes here
```

Security note: `/etc/wireguard` MUST be in tmpfs for writability. The `read_only: true` and `cap_drop: ALL` are compensating controls; do not disable them to "fix" this.

---

## How to get useful logs for a bug report

If you open a GitHub issue, include:

```bash
# Version info
docker exec gatecontrol-gateway cat /app/package.json | grep version
# Expect: "version": "1.3.0"   (or whatever is installed)

# Recent logs, at info level
docker logs gatecontrol-gateway --since 30m > gateway-logs.txt

# WireGuard handshake state
docker exec gatecontrol-gateway wg show

# Config state (redact api_token before posting!)
docker exec gatecontrol-gateway env | grep -E "^GATEWAY_|^LOG_|^HTTP_|^MANAGEMENT_"
```

Then temporarily switch to debug logging and reproduce:

```bash
docker compose down
LOG_LEVEL=debug docker compose up -d
# reproduce the issue
docker logs gatecontrol-gateway --since 5m > gateway-debug.txt
```

Redact IP addresses and tokens before posting. The GateControl maintainers never need your `api_token`.
