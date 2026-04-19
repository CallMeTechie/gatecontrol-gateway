# Migration von docker-wireguard-go

Wer bereits `docker-wireguard-go` im Einsatz hat und jetzt Home-Gateway-Features (HTTP/TCP-Proxy, WoL) nutzen möchte:

## Schritt 1: Alte Instanz stoppen

```bash
cd /volume1/docker/wireguard-go  # (oder wo dwg läuft)
docker compose down
```

## Schritt 2: Neuen Gateway-Peer in GateControl anlegen

Alter Peer (dwg) bleibt bestehen — der neue Gateway nutzt eigene WG-Keys. UI → Peers → „Home Gateway"-Checkbox → neue `gateway.env` herunterladen.

## Schritt 3: Neues Setup

Siehe [`linux-docker.md`](linux-docker.md) oder [`synology.md`](synology.md).

## Schritt 4: Alten dwg-Peer deaktivieren

Erst NACHDEM neuer Gateway läuft und alle Routen funktionieren: alten Peer in GateControl deaktivieren oder löschen.

## Wichtige Unterschiede

| Feature | docker-wireguard-go | gatecontrol-gateway |
|---|---|---|
| WireGuard Tunnel | yes | yes |
| HTTP/TCP Proxy | no | yes |
| Wake-on-LAN | no | yes |
| Server-Sync | no (manuelle Config) | yes (auto) |
| Management-API | no | yes |
