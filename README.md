# GateControl Home Gateway

Companion product for [GateControl](https://github.com/CallMeTechie/gatecontrol): an always-on Docker container in your home network that bridges a single WireGuard tunnel to multiple LAN devices via HTTP/TCP proxies.

## Features

- **HTTP reverse proxy** for L7 routes (NAS UI, Plex, Home Assistant, etc.)
- **TCP port forwarder** for L4 routes (RDP, SSH, databases)
- **Wake-on-LAN** triggered on backend-down (zero-config from GateControl UI)
- **Auto-sync** with GateControl: no manual re-config when routes change
- **Self-monitoring** with health reporting to server (sliding-window hysteresis, per-route reachability)
- **Security-hardened**: non-root container, `cap_drop: ALL` + minimal adds, read-only filesystem

## Architecture

```
Internet -> GateControl (VPS) -WireGuard-> Home Gateway -LAN-> NAS / Desktop / IoT
                                               |
                                               +- HTTP Proxy (Tunnel-IP:8080)
                                               +- TCP Listeners (dynamic L4 ports)
                                               +- WoL Endpoint
                                               +- Management API (Tunnel-IP:9876)
```

## Platform Support

See [Deployment Docs](docs/deployment/) for platform-specific instructions:

- [Linux / Pi / VM](docs/deployment/linux-docker.md) — Tier 1
- [Synology DSM 7.2+](docs/deployment/synology.md) — Tier 1
- [Proxmox VE LXC](#proxmox-ve-lxc-installer) — Tier 1, native (no Docker layer)
- [Raspberry Pi tips](docs/deployment/raspberry-pi.md) — SSD, NTP, log-rotation
- [Migration from docker-wireguard-go](docs/deployment/migration-from-dwg.md)

**Unsupported:** VM in NAT-mode (WoL broken). Bridge-mode required.

## Proxmox VE LXC Installer

For Proxmox hosts, an installer script creates an unprivileged Debian 12
LXC container, provisions Node.js + WireGuard, drops in your `gateway.env`
and starts the gateway as a systemd service. **Run on the Proxmox host
shell**, not inside any container.

```bash
# 1. In the GateControl Dashboard: Peers → your Gateway-Peer → Download
#    Config. Saves `gateway.env`.
# 2. scp gateway.env to your Proxmox host (e.g. /root/gateway.env)
# 3. On the Proxmox shell:

bash -c "$(curl -fsSL https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/scripts/install-pve.sh)"
```

The installer is interactive (whiptail) by default and asks for CT-ID,
hostname, storage, network bridge, and the path to `gateway.env`. All
prompts have sensible defaults.

**Subcommands** (run with the same `bash -c "$(curl ...)"` form, or save
the script and call it locally):

```bash
install-pve.sh update <ctid>     # pull latest release tag, restart
install-pve.sh remove <ctid>     # stop + destroy the LXC
install-pve.sh --help            # full option reference
```

The container is created **unprivileged with TUN passthrough** so the
host's WireGuard kernel module is used directly without giving the LXC
host-root capabilities. See [`scripts/install-pve.sh`](scripts/install-pve.sh)
for the exact `lxc.conf` patches applied.

## Quick Start

1. **GateControl-UI** → Peers → „Neuer Peer" → Checkbox „Home Gateway" → Speichern
2. Auf Peer-Detail: „Gateway-Config herunterladen" → ergibt `gateway-<id>.env`
3. Auf deinem Heimnetz-Host:
   ```bash
   mkdir -p /opt/gatecontrol-gateway/config
   cp gateway-*.env /opt/gatecontrol-gateway/config/gateway.env
   curl -L https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml -o /opt/gatecontrol-gateway/docker-compose.yml
   cd /opt/gatecontrol-gateway && docker compose up -d
   ```
4. Fertig — Gateway meldet sich beim Server. In der UI kannst du jetzt Routes mit `target_kind=gateway` anlegen.

## Security Hardening

- `network_mode: host` bleibt zwingend (dynamische L4-Port-Binding)
- Container läuft als non-root `gateway` User
- `cap_drop: ALL` + nur `NET_ADMIN` (wg-quick) + `NET_BIND_SERVICE` (ports <1024)
- `read_only: true` Root-FS mit tmpfs für `/tmp`, `/run`, `/etc/wireguard`
- `security_opt: no-new-privileges` bewusst NICHT gesetzt (Linux-Inkompatibilität mit non-root + cap_add NET_ADMIN; Compensating Controls: cap_drop ALL + read_only + USER gateway)
- Management-API bindet **ausschließlich** auf Tunnel-IP (Startup-Assertion)

## Development

```bash
# Clone + install (requires GH_PACKAGES_TOKEN with packages:read)
git clone git@github.com:CallMeTechie/gatecontrol-gateway.git
cd gatecontrol-gateway
GH_PACKAGES_TOKEN=<your-token> npm install

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Mutation testing
npm run test:mutation

# Lint
npm run lint
```

## License

UNLICENSED / private. See main GateControl repo for context.
