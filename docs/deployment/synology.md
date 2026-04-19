# Deployment: Synology DSM 7.2+

## Voraussetzungen

- DSM 7.2 oder neuer mit Container Manager (DSM 7.0/7.1 siehe "Legacy" unten)
- NAS im gleichen LAN wie Ziel-Geräte
- Administrator-Rechte

## Schritte

1. **Image importieren**

   Container Manager kann keine Images selbst bauen. Download:

   ```
   docker pull ghcr.io/callmetechie/gatecontrol-gateway:latest
   docker save -o gatecontrol-gateway.tar ghcr.io/callmetechie/gatecontrol-gateway:latest
   ```

   Dann per File Station nach `/volume1/docker/` hochladen und im Container Manager → „Importieren" auswählen.

2. **Ordnerstruktur**

   Via File Station:
   ```
   /volume1/docker/gatecontrol-gateway/
     └── config/
         └── gateway.env    ← aus GateControl-UI heruntergeladen
   ```

3. **Projekt erstellen**

   Container Manager → Projekt → Erstellen:
   - Pfad: `/volume1/docker/gatecontrol-gateway`
   - docker-compose.yml: Copy-Paste aus `docker-compose.example.yml` (siehe Haupt-Repo)

4. **Starten**

   Projekt → Start. Logs via Container Manager → Projekt → Logs.

## DSM 7.0/7.1 (Legacy)

Container Manager auf älteren DSM-Versionen hat eingeschränkten docker-compose-Support. Empfohlen: Standalone Docker via SSH:

```bash
ssh admin@synology
cd /volume1/docker/gatecontrol-gateway
sudo docker compose up -d
```

Für User die lieber beim alten Setup bleiben: [`docker-wireguard-go`](https://github.com/CallMeTechie/docker-wireguard-go) ist weiterhin als einfacher WG-Client ohne Gateway-Features verfügbar.
