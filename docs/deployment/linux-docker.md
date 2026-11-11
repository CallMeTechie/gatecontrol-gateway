# Deployment: Linux / Debian / Ubuntu / Raspberry Pi

> **Schritt-für-Schritt-Anleitung für Einsteiger:** das [GateControl-Handbuch](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/handbuch) (Kapitel 3.4 „Linux-Rechner mit Docker“, Kapitel 6 „Bestehendes Gateway aktualisieren“, FAQ) · English: [user guide](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/guide). Diese Seite ist die technische Ergänzung dazu. Für den Raspberry Pi gibt es ein [fertiges Image](raspberry-pi.md).

## Voraussetzungen

- Docker 24+ und das Compose-Plugin (`docker compose`)
- Host muss im gleichen L2-Segment wie die Ziel-LAN-Geräte sein (für WoL)
- Admin-Rechte für `NET_ADMIN` + `NET_BIND_SERVICE` Capabilities
- WireGuard-Kernelmodul (Standard ab Debian 11 / Ubuntu 22.04 / Kernel ≥ 5.6) – die Compose-Datei des Assistenten nutzt Kernel-WireGuard

## Schritte

1. **Gateway in GateControl anlegen**

   GateControl → Gateways → „Gateway hinzufügen“ → Plattform „Anderer
   Linux-Rechner“ → „Gateway anlegen und weiter“. Netzwerkmodus „Host
   (empfohlen)“ – nur damit gehen L4-Routen, Wake-on-LAN, Edge-Plugins
   ([docs/edge.md](../edge.md)) und DNS-Filter/Zwischenspeicher
   ([docs/dns-cache.md](../dns-cache.md)).

2. **Ordner und Compose-Datei**

   Die Compose-Datei aus dem Assistenten enthält keine Zugangsdaten (kopieren
   oder herunterladen):

   ```bash
   sudo mkdir -p /opt/gatecontrol-gateway && cd /opt/gatecontrol-gateway
   sudo nano docker-compose.yml        # Inhalt aus dem Assistenten einfügen
   sudo docker compose up -d
   ```

   Docker legt `config/`, `gateway-state/` und `gateway-cache/` selbst an.
   Alternativ zur Compose-Datei des Assistenten:
   [`docker-compose.example.yml`](../../docker-compose.example.yml) (zusätzlich
   mit den Capabilities für keepalived/Scan-Egress, siehe [scan-egress.md](scan-egress.md)).

3. **Einrichtungsseite öffnen und verbinden**

   Im Browser im Heimnetz `http://<Adresse des Rechners>:8642` öffnen,
   **Serveradresse** und **Einrichtungscode** aus dem Assistenten eingeben
   (der Code gilt 10 Minuten und einmal), „Verbinden“. Das Gateway holt seine
   Zugangsdaten selbst und speichert sie als `config/gateway.env` (0600).
   Einzelheiten und Fehlersuche: [Einrichtungsseite](../setup-page.md).

   Im **Bridge-Modus** den Port freigeben – die Compose-Datei des Assistenten
   enthält `ports: - "8642:8642"` bereits.

   **Bisheriger Weg:** im Assistenten „Lieber die Datei gateway.env
   herunterladen“, die Datei nach `config/gateway.env` legen
   (`chmod 600`), dann `docker compose up -d`. Ein erneuter Download erzeugt
   einen neuen Zugangsschlüssel.

4. **Prüfen**

   ```bash
   sudo docker compose logs -f gateway
   ```

   Erwartet: Logs zeigen WireGuard up, Config-Poll erfolgreich, HTTP-Proxy/API-Server binden auf Tunnel-IP. Die Einrichtungsseite zeigt „Verbunden“.

5. **Auto-Update** (einmalig): `sudo crontab -e`, Zeile aus dem Assistenten:

   ```
   * * * * * PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/opt/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/opt/gatecontrol-gateway bash /opt/gatecontrol-gateway/update.sh
   ```

   Oder die systemd-`.path`-Unit aus [Auto-Update](../auto-update.md). Das
   Auto-Update tauscht nur das Image, nie die `docker-compose.yml`.

6. **Verifikation**

   Der Assistent zeigt „Gateway hat sich gemeldet“; danach steht das Gateway in GateControl als „online“.

## Lokale KI (optional)

Der Dienst `ki` (Ollama, [docs/local-ai.md](../local-ai.md)) steht in
`docker-compose.example.yml` im Profil `ki` – ohne den Schalter lädt niemand das
≈ 3-GB-Image. Einschalten in GateControl (KI-Anbieter › Lokale KI), dann entweder
die Compose-Datei aus GateControl neu holen (enthält `ki` ohne Profil) oder
`COMPOSE_PROFILES=ki` in `.env` setzen und `docker compose up -d`. Ollama hört nur
auf `127.0.0.1:11435`; das Gateway lädt die Modelle und leitet die Fragen weiter.

## Troubleshooting

- **„Refused to bind on 0.0.0.0"** → `GC_TUNNEL_IP` in `gateway.env` fehlt oder ist falsch
- **WoL funktioniert nicht** → Gateway ist nicht im gleichen L2-Segment wie Ziel, oder Host-Bridge statt NAT notwendig
- **Gateway zeigt als offline in UI** → `sudo docker compose logs gateway`, häufig sind es DNS-Auflösung oder Tunnel-Probleme
- **„Edge-Dienst fehlt“ / Zwischenspeicher „Ordner nicht beschreibbar“** → ältere Compose-Datei ohne `edge`/`mqtt` bzw. ohne `${GC_CACHE_DIR:-./gateway-cache}:/cache`; aktuelle Datei aus dem Assistenten nehmen (Handbuch Kapitel 6)

## Kameras (optional)

Der Dienst `kameras` ([docs/cameras.md](../cameras.md)) steht in
`docker-compose.example.yml` im Profil `kameras`. Einschalten in GateControl
(Gateway › Funktionen › Kameras), dann die Compose-Datei aus GateControl neu holen
(enthält `kameras` ohne Profil) oder `COMPOSE_PROFILES=kameras` in `.env` setzen und
`docker compose up -d`. Er öffnet keinen Port und hat keine Rechte; Clips liegen im
Volume `cam-recordings` oder unter `GC_CAMERA_DIR`.
