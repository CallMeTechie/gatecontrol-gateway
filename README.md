# GateControl Home Gateway

Companion product for [GateControl](https://github.com/CallMeTechie/gatecontrol): an always-on Docker container in your home network that bridges a single WireGuard tunnel to multiple LAN devices via HTTP/TCP proxies.

## Features

- **HTTP reverse proxy** for L7 routes (NAS UI, Plex, Home Assistant, etc.)
- **TCP port forwarder** for L4 routes (RDP, SSH, databases)
- **Wake-on-LAN** triggered on backend-down (zero-config from GateControl UI)
- **Auto-sync** with GateControl: no manual re-config when routes change
- **Self-monitoring** with health reporting to server (sliding-window hysteresis, per-route reachability)
- **Netzwerk-Wächter, Internetqualität, Anwesenheit, USV** (vom Server pro Gateway schaltbar): Geräte im Heimnetz mit Hersteller/Namen/offenen Ports, Ping/Verlust/Ausfälle mit Ursache und Speedtest, WLAN-Anwesenheit freigegebener Handys, USV-Zustand per NUT – siehe [docs/netzwerk-internet.md](docs/netzwerk-internet.md)
- **DNS-Filter und Zwischenspeicher** (vom Server pro Gateway schaltbar): eigener DNS-Server im Heimnetz mit Profilen je Gerät, Sperrlisten, Zeiten, Pausen, sicherer Suche und DoH-Weiterleitung; Dateien/Fotos/App-Updates für Apps im Heimnetz per signierter HTTPS-Abgabe – siehe [docs/dns-cache.md](docs/dns-cache.md)
- **Edge-Container** für Plugin-Teile im Heimnetz (UDP/Multicast, mDNS, LAN-TCP/HTTP): eigener Container ohne Rechte und ohne Netz (UID 61001, `network_mode: none` – alles über einen geprüften Socket des Gateways, kein Kernel-Modul nötig), signierte Pakete, Prozess-Isolation – siehe [docs/edge.md](docs/edge.md)
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

**Step by step for beginners:** the [GateControl user guide](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/guide) (Deutsch: [Handbuch](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/handbuch)) – server set-up, gateway assistant, Synology, Raspberry Pi, Linux/Docker, edge plugins, FAQ.

See [Deployment Docs](docs/deployment/) for platform-specific instructions:

- [Linux / Pi / VM](docs/deployment/linux-docker.md) — Tier 1
- [Synology DSM 7.2+](docs/deployment/synology.md) — Tier 1
- [Proxmox VE LXC](#proxmox-ve-lxc-installer) — Tier 1, native (no Docker layer)
- [Raspberry Pi — fertiges Image](docs/deployment/raspberry-pi.md) — Tier 1, SD-Karten-Image (Pi 3 B+/4/5) mit Auto-Update und optional deCONZ für RaspBee II
- [Migration from docker-wireguard-go](docs/deployment/migration-from-dwg.md)

**Unsupported:** VM in NAT-mode (WoL broken). Bridge-mode required.

## Proxmox VE LXC Installer

For Proxmox hosts, an installer script creates an unprivileged Debian 12
LXC container, provisions Node.js + WireGuard, drops in your `gateway.env`
and starts the gateway as a systemd service. **Run on the Proxmox host
shell**, not inside any container.

```bash
# Easiest: GateControl → Gateways → "Add gateway" → Proxmox shows this
# command with a one-time pairing code (no file copying).
# By hand: copy a gateway.env to the Proxmox host (e.g. /root/gateway.env),
# then on the Proxmox shell:

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

1. **GateControl-UI** → Gateways → „Gateway hinzufügen“ → Plattform wählen (Raspberry Pi, Synology NAS, Proxmox, anderer Linux-Rechner)
2. Den Anweisungen des Assistenten folgen; für Linux: `docker-compose.yml`, `gateway.env` und `update.sh` herunterladen
3. Auf deinem Heimnetz-Host:
   ```bash
   sudo mkdir -p /opt/gatecontrol-gateway/config /opt/gatecontrol-gateway/gateway-state /opt/gatecontrol-gateway/gateway-cache
   sudo mv docker-compose.yml update.sh /opt/gatecontrol-gateway/
   sudo mv gateway.env /opt/gatecontrol-gateway/config/gateway.env
   cd /opt/gatecontrol-gateway && sudo docker compose up -d
   ```
4. Fertig — Gateway meldet sich beim Server. In der UI kannst du jetzt Routes mit `target_kind=gateway` anlegen.

## Security Hardening

- `network_mode: host` bleibt zwingend (dynamische L4-Port-Binding)
- Container läuft als non-root `gateway` User
- `cap_drop: ALL` + nur `NET_ADMIN` (wg-quick) + `NET_BIND_SERVICE` (ports <1024)
- `read_only: true` Root-FS mit tmpfs für `/tmp`, `/run`, `/etc/wireguard`
- `security_opt: no-new-privileges` bewusst NICHT gesetzt (Linux-Inkompatibilität mit non-root + cap_add NET_ADMIN; Compensating Controls: cap_drop ALL + read_only + USER gateway)
- Management-API bindet **ausschließlich** auf Tunnel-IP (Startup-Assertion)
- Edge-Container: gleiches Image, eigener Benutzer 61001, `cap_drop: ALL`, `no-new-privileges`, read-only; Container ohne Netz (`network_mode: none`), Server/LAN/MQTT nur über den Gateway-Socket, dort geprüft (nur LAN, nur genehmigte Fähigkeiten, Token bleibt im Gateway); Plugin-Prozesse mit Node-Permission-Model; startet nichts ohne bestätigte Isolation bzw. – alte Compose-Datei – aktive Netzgrenze ([docs/edge.md](docs/edge.md))

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
