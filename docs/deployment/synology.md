# Deployment: Synology DSM 7.2+

> **Schritt-für-Schritt-Anleitung für Einsteiger:** das [GateControl-Handbuch](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/handbuch) (Kapitel 3 „Gateway einrichten“, Kapitel 6 „Bestehendes Gateway aktualisieren“, FAQ) · English: [user guide](https://github.com/CallMeTechie/gatecontrol/tree/master/docs/guide). Diese Seite ist die technische Ergänzung dazu.

## Voraussetzungen

- DSM 7.2 oder neuer mit Container Manager (DSM 7.0/7.1 siehe "Legacy" unten)
- NAS im gleichen LAN wie Ziel-Geräte
- Administrator-Rechte
- Zugang zu `ghcr.io` (Gateway-Image) und Docker Hub (`eclipse-mosquitto` für den Dienst `mqtt`) – der Container Manager lädt die Images beim Erstellen des Projekts selbst, ein manueller Import ist nicht nötig.

## Schritte

1. **Gateway in GateControl anlegen**

   GateControl → Gateways → „Gateway hinzufügen“ → Plattform „Synology NAS“ →
   „Gateway anlegen und weiter“ → `gatecontrol-gateway-nas.zip` herunterladen.
   Das Paket enthält `docker-compose.yml` (Host-Netz, wireguard-go, Dienste
   `gateway`, `edge`, `mqtt`), `config/gateway.env`, `update.sh` und die leeren
   Ordner `gateway-state/` und `gateway-cache/`. Jeder Download erzeugt einen
   neuen Zugangsschlüssel.

2. **Ordnerstruktur**

   File Station → `docker` → Ordner `gatecontrol-gateway` anlegen, ZIP hochladen
   und dort „Extrahieren“:
   ```
   /volume1/docker/gatecontrol-gateway/
     ├── docker-compose.yml
     ├── update.sh
     ├── config/
     │   └── gateway.env
     ├── gateway-state/     ← /state (Auto-Update-Flag, last-pull, update.log)
     └── gateway-cache/     ← /cache (Zwischenspeicher, docs/dns-cache.md)
   ```

   **Der Container Manager legt fehlende Bind-Mount-Ordner nicht an** – fehlt
   einer, bricht der Start mit `Bind mount failed: … does not exist` ab. Wer die
   Compose-Datei selbst schreibt (z. B. aus `docker-compose.example.yml`), legt
   `config/`, `gateway-state/` und `gateway-cache/` vorher in der File Station an.

3. **Projekt erstellen**

   Container Manager → Projekt → Erstellen:
   - Projektname `gatecontrol-gateway`, Pfad: `/volume1/docker/gatecontrol-gateway`
   - „Vorhandene docker-compose.yml verwenden“ → Weiter → Fertig.

   Die Meldung „Your kernel does not support PIDs limit …“ ist harmlos: Der
   DSM-Kernel kann `pids_limit` (Dienste `edge`, `mqtt`) nicht setzen, Docker
   lässt die Grenze weg.

4. **Auto-Update**

   Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe →
   Benutzerdefiniertes Skript, Benutzer `root`, jede Minute, Befehl wie im
   Assistenten:
   ```
   PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/volume1/docker/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/volume1/docker/gatecontrol-gateway bash /volume1/docker/gatecontrol-gateway/update.sh
   ```
   Details: [Auto-Update](../auto-update.md).

5. **Prüfen**

   Container → `…-gateway-1`, `…-edge-1`, `…-mqtt-1` laufen; Protokoll unter
   Container Manager → Container → Protokoll. In GateControl meldet sich das
   Gateway im Assistenten (Schritt 4).

Das Auto-Update tauscht nur das Image, nie die `docker-compose.yml`. Ältere
Projekte ersetzen die Datei einmal durch die aktuelle aus GateControl
(nächster Abschnitt).

## Edge-Dienst (Plugins im Heimnetz)

Plugins können einen **Edge-Teil** direkt auf dem Gateway laufen lassen – zum
Beispiel „Smart Home“ für Shelly- und Tasmota-Geräte. Dafür hat die
Compose-Datei zwei weitere Dienste, `edge` (abgeschotteter Container für die
Edge-Teile, dasselbe Image wie das Gateway) und `mqtt` (lokaler Broker), dazu
einige Volumes und Einträge im Dienst `gateway`. Hintergrund:
[docs/edge.md](../edge.md).

**Auf der Synology ist nichts per SSH nötig.** Seit Gateway 1.23.0 läuft der
Edge-Container **ohne Netz** (`network_mode: none`): GateControl, die Geräte im
Heimnetz und den Broker erreicht er nur über einen Socket des
Gateway-Containers, der jede Anfrage prüft (nur Heimnetz, nur genehmigte
Fähigkeiten). Eine Netzgrenze per Firewall-Regel – und damit das Kernel-Modul
`xt_owner`, das DSM oft nicht lädt – braucht es dafür nicht mehr.

### Compose-Datei aus GateControl holen

Fehlen `edge`/`mqtt` oder stammt die Datei von vor Gateway 1.23.0 (Edge im
Host-Netz), zeigt GateControl unter **Gateways › Gateway › Edge-Plugins**
„Edge-Dienst fehlt“ bzw. „Compose-Datei veraltet“ mit dem Knopf **„Nur
docker-compose.yml herunterladen“**. Dann:

1. In GateControl **„Nur docker-compose.yml herunterladen“** → Gerät „Synology
   NAS“, Netzwerk „Host“ → herunterladen. `gateway.env` und Schlüssel bleiben,
   wie sie sind; das Gateway bleibt verbunden.
2. **File Station** → `docker/gatecontrol-gateway`: die Ordner `gateway-cache`
   und – falls er fehlt – `gateway-state` anlegen (Synology legt fehlende
   Ordner nicht selbst an).
3. **Container Manager** → **Projekt** → `gatecontrol-gateway` → **Stoppen**.
4. Im Projekt den Reiter **YAML-Konfiguration** öffnen, den ganzen Inhalt
   durch die heruntergeladene Datei ersetzen und speichern.
5. Das Projekt **neu erstellen** und starten. Danach laufen `gateway`, `edge`
   und `mqtt`.

Eigene Änderungen an der alten Datei (z. B. ein anderer `config`-Ordner)
übernimmst du von Hand. Die Datei entspricht
[`docker-compose.example.yml`](../../docker-compose.example.yml) (ohne die
`TZ`-Zeile – die Zeitzone kommt von GateControl).

Die Images lädt Docker beim Start selbst: `edge` nutzt dasselbe Image wie
`gateway` (`ghcr.io/callmetechie/gatecontrol-gateway`, kein zusätzlicher
Speicherplatz), `mqtt` das auf einen festen Digest gepinnte
`eclipse-mosquitto:2.1.2-alpine` von Docker Hub – die NAS braucht dafür
Zugang zu Docker Hub.

`edge` und `mqtt` bleiben untätig (≈ 50 MB RAM, Broker ≈ 1 MB), bis du Edge in
GateControl für dieses Gateway einschaltest. Der Auto-Update
(`deploy/update.sh`) zieht `edge` nach jedem Gateway-Update mit.

### Prüfen

- **GateControl** → Gateways → Gateway → **Edge-Plugins**: Chips „Verbunden seit …“
  und „Edge ohne Netzwerk (isoliert)“. Steht dort stattdessen ein Grund
  („Edge-Dienst fehlt“, „Edge-Container läuft nicht“, „Compose-Datei veraltet“,
  „Edge erreicht GateControl nicht“), sagt der Hinweis darunter, was zu tun ist.
- **Container Manager** → Container: `…-edge-1` und `…-mqtt-1` laufen; `edge`
  ist nach etwa einer Minute „gesund“.
- **Protokoll des Containers `edge`**: `edge: container without network
  (isolated)` und `edge: connected to the gateway socket`.

### Alte Compose-Datei (Edge im Host-Netz)

Eine Datei von vor Gateway 1.23.0 startet den Edge-Container im Host-Netz.
Dann gilt der alte Weg: Edge-Teile laufen nur hinter einer Netzgrenze, die der
Gateway-Container per legacy-iptables mit dem Owner-Match setzt – und dafür
braucht der DSM-Kernel das Modul `xt_owner`. Lässt sie sich nicht setzen,
startet kein Edge-Teil (fail closed), und GateControl zeigt „Compose-Datei
veraltet“. Statt das Modul von Hand zu laden: die Compose-Datei wie oben aus
GateControl holen.

## DSM 7.0/7.1 (Legacy)

Container Manager auf älteren DSM-Versionen hat eingeschränkten docker-compose-Support. Empfohlen: Standalone Docker via SSH:

```bash
ssh admin@synology
cd /volume1/docker/gatecontrol-gateway
sudo docker compose up -d
```

Für User die lieber beim alten Setup bleiben: [`docker-wireguard-go`](https://github.com/CallMeTechie/docker-wireguard-go) ist weiterhin als einfacher WG-Client ohne Gateway-Features verfügbar.
