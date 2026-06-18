# Scan-Egress (Near-Side) — Gateway Deployment & Verification

Scan-Egress lets a WireGuard-less LAN device (e.g. an HP OfficeJet printer/scanner)
reach a remote network share through a GateControl gateway: the device writes to
`\\<VIP>\share` (SMB :445), an **iptables REDIRECT** sends `<VIP>:445 → high-port`
(bypassing the Synology host `smbd`), the egress engine forwards it into the tunnel,
and the **VIP floats via keepalived** to the live printer-LAN gateway.

This document covers the **near-side (Phase 1b)** image requirements and the
reproducible hardware-verification procedure. The server side (Phase 2) that
pushes `egress_routes` with `vip_ip`/`near_peers` is a separate component; until
it lands, the near layer is **dormant** (no routes carry a `vip_ip`, so keepalived
is not started — `NearManager.plan([])` yields zero instances).

## Image requirements

The gateway image (`ghcr.io/callmetechie/gatecontrol-gateway:latest`, v1.16.0+) ships:

- **Static legacy iptables** (`iptables v1.8.10 (legacy)`, symlinked from
  `xtables-legacy-multi`). The DSM kernel is **x_tables / legacy** — the nft
  backend fails with `Could not fetch rule set generation id`. Built via a
  multi-stage `ipt-legacy` stage (`./configure --enable-static --disable-shared
  --disable-nftables`, `make LDFLAGS="-static"`). Source is fetched as
  **`.tar.xz`** (netfilter.org dropped `.tar.bz2` → 404).
- **keepalived** (`v2.3.1`) for the floating VIP (VRRP unicast, tunnel-health
  gated, `weight -60` + `nopreempt`).

## Capabilities & runtime

- `NET_ADMIN` — already present (wg-quick + `ip`/`iptables`).
- **`NET_RAW`** — required for keepalived VRRP (raw socket proto-112 + GARP via
  `AF_PACKET`); `NET_ADMIN` does **not** cover it. Add to the production compose
  `cap_add` and recreate the container (see *Production rollout*).
- keepalived state lives under the existing `/run` tmpfs
  (`/run/keepalived`, created at runtime) — nothing is written to the read-only
  root FS.
- Container runs as root (UID 0), which keepalived requires.

## LAN interface is host-specific

The near gateway must bind the VIP and REDIRECT on its **real LAN interface**,
which differs per host — `NearManager` derives it from `lanSubnets()` and must
**not** hardcode `eth0`:

| Host  | DSM kernel  | LAN interface |
|-------|-------------|---------------|
| nas3 (DS218+)  | 4.4.302+ (x_tables) | `eth0`     |
| DS918+         | 4.4.302+ (x_tables) | `ovs_eth0` (Open vSwitch) |

## Verification procedure (reproducible)

All checks run in a throwaway `--rm` container from the deployed image with
`--network host` and the egress caps — they do **not** touch the running gateway
container. Use a free test VIP outside the DHCP range (here `192.168.2.250`) and
the host's LAN interface (`<IFACE>` = `eth0` on nas3, `ovs_eth0` on DS918).

### 1. legacy-iptables REDIRECT against the real kernel

```sh
sudo docker run --rm --network host --cap-add=NET_ADMIN \
  --entrypoint /bin/sh ghcr.io/callmetechie/gatecontrol-gateway:latest -c '
  iptables --version
  ip addr add 192.168.2.250/24 dev <IFACE>
  iptables -t nat -A PREROUTING -d 192.168.2.250 -p tcp --dport 445 -j REDIRECT --to-ports 14450 && echo RULE_OK
  iptables -t nat -C PREROUTING -d 192.168.2.250 -p tcp --dport 445 -j REDIRECT --to-ports 14450 && echo RULE_VERIFIED
  iptables -t nat -D PREROUTING -d 192.168.2.250 -p tcp --dport 445 -j REDIRECT --to-ports 14450
  ip addr del 192.168.2.250/24 dev <IFACE>'
```
Expect `iptables v1.8.10 (legacy)`, `RULE_OK`, `RULE_VERIFIED` — **no**
`Could not fetch rule set generation id` (that signature means the nft backend
leaked in instead of the legacy binary).

### 2. keepalived single-node smoke (NET_RAW + VIP + notify REDIRECT)

Write a minimal `keepalived.conf` (state MASTER, an unused VRID, the test VIP,
a `notify_master` that applies the REDIRECT) under `/run/keepalived`, start
keepalived **daemonized** (no `-n`/foreground — a foreground keepalived never
exits and an exec timeout would kill it into a restart loop), wait ~8 s, then
assert keepalived is running, the VIP is bound, and the REDIRECT was applied by
the notify script. Tear down with `pkill keepalived` + remove the rule/alias.

### Verified results — 2026-06-18 (image v1.16.0)

- **nas3** (`eth0`): `iptables v1.8.10 (legacy)`, `RULE_OK`/`RULE_VERIFIED`;
  keepalived `KA_RUNNING` → `VIP_BOUND` (master) → `REDIRECT_PRESENT`
  (notify_master fired); clean teardown, no leak.
- **DS918+** (`ovs_eth0`): `iptables v1.8.10 (legacy)`, `RULE_OK`/`RULE_VERIFIED`;
  clean teardown, no leak.
- Multi-arch GHCR build (amd64/arm64/arm-v7) of the static legacy-iptables stage
  succeeded.

## Production rollout (pending Phase 2 server)

The full two-node, server-driven failover is exercised only once the Phase 2
server pushes `egress_routes` with `vip_ip`/`vip_prefix`/`lan_listen_port`/
`near_peers`. Rollout steps at that point:

1. Add `NET_RAW` to the production `docker-compose` `cap_add` and **recreate**
   the gateway container (a recreate briefly drops SSH that is tunneled through
   the gateway — use the detached/auto-rollback deploy path).
2. Confirm `scan_egress_near` appears in the gateway's heartbeat telemetry.
3. Push a test egress route (`vip_ip`, `lan_listen_port`, target = an
   internal-only L4 NAS route), then from a third LAN host `nc <VIP> 445` and
   confirm pass-through to the tunnel target.
4. Failover: stop the master gateway → keepalived on the peer becomes master,
   GARP, takes the VIP + sets the REDIRECT → `nc <VIP> 445` keeps working.
   Detection latency ≈ `fall 2 × interval 5 s` ≈ 10 s (tune `fall 1`/`interval 2`
   for ~2 s if the SLA requires it).

## Troubleshooting

- `Could not fetch rule set generation id` → the nft iptables ran instead of
  the legacy binary; ensure `/usr/local/bin/iptables` resolves to
  `xtables-legacy-multi` and precedes `/usr/sbin` in `PATH`.
- iptables source fetch 404 → netfilter.org serves `.tar.xz` only; the build
  uses `wget … .tar.xz` + `tar -xJf`.
- keepalived refuses to run notify scripts → `global_defs` must set
  `enable_script_security` + `script_user root`.
