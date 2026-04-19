# Deployment: Linux / Debian / Ubuntu / Raspberry Pi

## Voraussetzungen

- Docker 24+ und docker-compose
- Host muss im gleichen L2-Segment wie die Ziel-LAN-Geräte sein (für WoL)
- Admin-Rechte für `NET_ADMIN` + `NET_BIND_SERVICE` Capabilities

## Schritte

1. **Gateway-Peer in GateControl-UI anlegen**

   UI → Peers → „Neuer Peer" → „Home Gateway"-Checkbox aktivieren → API-Port 9876 (Standard) → Speichern.

2. **`gateway.env` herunterladen**

   Auf der Peer-Detail-Seite: Button „Gateway-Config herunterladen" → die Datei landet lokal.

3. **Compose-Setup**

   ```bash
   mkdir -p /opt/gatecontrol-gateway/config
   cd /opt/gatecontrol-gateway
   cp /path/to/gateway-<id>.env config/gateway.env
   wget https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml -O docker-compose.yml
   ```

4. **Starten**

   ```bash
   docker compose up -d
   docker compose logs -f
   ```

   Erwartet: Logs zeigen WireGuard up, Config-Poll erfolgreich, HTTP-Proxy/API-Server binden auf Tunnel-IP.

5. **Verifikation**

   Im GateControl-UI sollte der Gateway als „online" erscheinen (nach ~2-5 min Hysteresis-Cooldown).

## Troubleshooting

- **„Refused to bind on 0.0.0.0"** → `GC_TUNNEL_IP` in `gateway.env` fehlt oder ist falsch
- **WoL funktioniert nicht** → Gateway ist nicht im gleichen L2-Segment wie Ziel, oder Host-Bridge statt NAT notwendig
- **Gateway zeigt als offline in UI** → Check `docker logs`, häufig sind es DNS-Auflösung oder Tunnel-Probleme
