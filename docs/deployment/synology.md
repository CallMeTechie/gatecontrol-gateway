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
Projekte ohne `edge`/`mqtt` oder ohne `gateway-cache` ergänzen die Blöcke unten
bzw. ersetzen die Datei durch die aktuelle aus dem Handbuch (Kapitel 6).

## Edge-Dienst (Plugins im Heimnetz)

Seit Gateway 1.19.0 können Plugins einen **Edge-Teil** direkt auf dem Gateway
laufen lassen – zum Beispiel „Smart Home“ für Shelly- und Tasmota-Geräte. Dafür
braucht die Compose-Datei zwei weitere Dienste, `edge` (abgeschotteter
Container für die Edge-Teile, dasselbe Image wie das Gateway) und `mqtt`
(lokaler Broker), dazu vier Volumes und zwei Einträge im Dienst `gateway`.
Hintergrund: [docs/edge.md](../edge.md).

Wer das Projekt mit einer älteren `docker-compose.yml` angelegt hat, hat diese
Teile nicht. Das Gateway selbst läuft unverändert weiter (Heartbeat online),
aber der Edge-Teil eines Plugins startet nicht: GateControl zeigt unter
**Gateways › Gateway › Edge-Plugins** „Edge-Dienst fehlt“ – ältere
GateControl-Versionen nur „Gateway nicht verbunden“. Das Gateway meldet dann im
Heartbeat `telemetry.edge: null`.

Die Blöcke unten stammen 1:1 aus
[`docker-compose.example.yml`](../../docker-compose.example.yml); bei
Abweichungen gilt diese Datei.

### 1. Einträge im Dienst `gateway`

Unter `services:` → `gateway:` → `volumes:` (nach `./config:/config:ro`,
`./gateway-state:/state` und `${GC_CACHE_DIR:-./gateway-cache}:/cache` – für
den Zwischenspeicher, Ordner `gateway-cache` vorher in der File Station anlegen)
ergänzen – darüber reicht der Gateway-Container dem
Edge-Container die Zugangsdaten und den Marker der Netzgrenze und liest dessen
Zusammenfassung für die Telemetrie:

```yaml
      # Edge-Container (docs/edge.md): Zugangsdaten + Netzgrenzen-Marker hin,
      # Zusammenfassung für die Telemetrie zurück. Ohne Edge-Dienst weglassen.
      - type: volume
        source: edge-run
        target: /run/gc-edge
        volume: { nocopy: true }
      - type: volume
        source: edge-status
        target: /run/gc-edge-status
        read_only: true
        volume: { nocopy: true }
```

Fehlt `edge-run`, meldet das Gateway „kein Edge-Dienst“, auch wenn der Dienst
`edge` läuft; fehlt `edge-status`, sieht GateControl den laufenden
Edge-Container nicht („Edge-Container läuft nicht“).

### 2. Dienste `edge` und `mqtt`

Unter `services:` nach dem Dienst `gateway` einfügen (zwei Leerzeichen
Einrückung wie `gateway:`). Die doppelten `$$` im Startskript von `mqtt` sind
Absicht (Compose-Schreibweise für ein `$`) und bleiben so:

```yaml
  # Edge-Container für Plugin-Teile im Heimnetz (docs/edge.md). Dasselbe Image
  # wie das Gateway, anderer Befehl; läuft ohne Rechte als Benutzer 61001 und
  # bleibt untätig, bis der Server Edge für dieses Gateway einschaltet.
  # Wer Edge nicht nutzen will, kann den Dienst (und die Volumes) weglassen.
  edge:
    image: ghcr.io/callmetechie/gatecontrol-gateway:latest
    entrypoint: ["/sbin/tini", "--", "node", "src/edge/main.js"]
    restart: unless-stopped
    network_mode: host        # LAN-Geräte (UDP/Multicast/mDNS) wie das Gateway
    user: "61001:61001"       # feste UID: die Netzgrenze (Owner-Match) hängt daran
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=16m
    mem_limit: 512m
    pids_limit: 256
    volumes:
      - type: volume
        source: edge-run
        target: /run/gc-edge
        read_only: true
        volume: { nocopy: true }
      - type: volume
        source: edge-status
        target: /run/gc-edge-status
        volume: { nocopy: true }
      - edge-state:/state-edge
      - edge-mqtt:/gc-mqtt   # Broker-Dateien (übernimmt Besitzer 61001 aus dem Image)
    environment:
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "node", "src/edge/healthcheck.js"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # Lokaler MQTT-Broker (docs/edge.md "MQTT"). Läuft untätig (nur ein kleiner
  # Wächter), bis der Server MQTT einschaltet; der Edge-Host schreibt dann
  # mosquitto.conf/passwd/acl nach /gc-mqtt. Port 1883 nur an LAN-Adressen,
  # ohne anonyme Anmeldung. Der Wächter startet Mosquitto bei geänderter
  # Konfiguration neu und schickt bei geänderten Konten SIGHUP.
  mqtt:
    image: eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f
    entrypoint:
      - /bin/sh
      - -c
      - |
        C=/gc-mqtt; p=""; s=""; r=""
        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }
        trap 'halt; exit 0' TERM INT
        while :; do
          if [ -f "$$C/enabled" ] && [ -f "$$C/mosquitto.conf" ]; then
            n="$$(cksum < "$$C/mosquitto.conf")"
            if [ -n "$$p" ] && ! kill -0 "$$p" 2>/dev/null; then p=""; fi
            if [ -z "$$p" ] || [ "$$n" != "$$s" ]; then
              halt; mosquitto -c "$$C/mosquitto.conf" & p=$$!
              s="$$n"; r="$$(cat "$$C/reload" 2>/dev/null)"
            elif [ "$$(cat "$$C/reload" 2>/dev/null)" != "$$r" ]; then
              r="$$(cat "$$C/reload" 2>/dev/null)"; kill -HUP "$$p"
            fi
          else
            halt; s=""
          fi
          sleep 2 & wait $$!
        done
    restart: unless-stopped
    network_mode: host
    user: "61001:61001"       # wie der Edge-Host: liest dessen Dateien (0600)
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    mem_limit: 128m
    pids_limit: 32
    depends_on:
      - edge                  # legt das Volume mit Besitzer 61001 an
    volumes:
      - type: volume
        source: edge-mqtt
        target: /gc-mqtt
        volume: { nocopy: true }
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 3. Volumes

Ganz unten in der Datei, auf oberster Ebene (ohne Einrückung, nicht unter
`services:`):

```yaml
volumes:
  # tmpfs, geteilt: der Gateway-Container (root) schreibt, das setgid-Bit gibt
  # jeder Datei die Gruppe 61001 → der Edge-Container kann lesen, nicht ändern.
  edge-run:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=0,gid=61001,mode=2750"
  # tmpfs, geteilt: der Edge-Host schreibt seine Zusammenfassung, das Gateway liest.
  edge-status:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=61001,gid=61001,mode=0755"
  # Pakete der Edge-Teile + gc.store (übernimmt Besitzer 61001 aus dem Image)
  edge-state:
  # Broker-Dateien vom Edge-Host + Mosquitto-Daten (data/)
  edge-mqtt:
```

`edge-run` und `edge-status` sind tmpfs-Volumes mit festen Rechten (Gruppe
bzw. Benutzer 61001); deshalb hängen die Dienste sie mit `nocopy` ein.

### 4. Übernehmen

Container Manager → **Projekt** → `gatecontrol-gateway` → Projekt stoppen, im
Reiter **YAML-Konfiguration** die Blöcke ergänzen, speichern und das Projekt
neu erstellen und starten. Per SSH geht dasselbe mit:

```bash
cd /volume1/docker/gatecontrol-gateway
sudo mkdir -p gateway-state gateway-cache
sudo docker compose up -d
```

Die Images lädt Docker beim Start selbst: `edge` nutzt dasselbe Image wie
`gateway` (`ghcr.io/callmetechie/gatecontrol-gateway`, kein zusätzlicher
Speicherplatz), `mqtt` das auf einen festen Digest gepinnte
`eclipse-mosquitto:2.1.2-alpine` von Docker Hub – die NAS braucht dafür
Zugang zu Docker Hub.

`edge` und `mqtt` bleiben untätig (≈ 50 MB RAM, Broker ≈ 1 MB), bis du Edge in
GateControl für dieses Gateway einschaltest. Der Auto-Update
(`deploy/update.sh`) zieht `edge` nach jedem Gateway-Update mit.

### 5. Prüfen

- **GateControl** → Gateways → Gateway → **Edge-Plugins**: Chips „Verbunden seit …“
  und „Netzgrenze aktiv (iptables)“. Steht dort stattdessen ein Grund
  („Edge-Dienst fehlt“, „Edge-Container läuft nicht“, „Netzgrenze fehlt“,
  „Edge erreicht GateControl nicht“), sagt der Hinweis darunter, was zu tun ist.
- **Container Manager** → Container: `…-edge-1` und `…-mqtt-1` laufen; `edge`
  ist nach etwa einer Minute „gesund“.
- **Protokoll des Containers `gateway`**: `edge fence: rules active` mit
  `backend: iptables` (siehe nächster Abschnitt).

### Netzgrenze auf der Synology (xt_owner)

Edge-Teile laufen nur hinter einer Netzgrenze: Der Gateway-Container setzt alle
30 s Firewall-Regeln, die nur für den Edge-Benutzer (UID 61001) gelten – er
erreicht dann nur das Heimnetz, den lokalen Broker und GateControl, nicht das
Internet und nicht den Tunnel ([docs/edge.md](../edge.md#netzgrenze-fail-closed)).
Der DSM-Kernel spricht nur das alte x_tables; das Gateway nimmt deshalb
automatisch legacy-iptables mit dem **Owner-Match** (`-m owner --uid-owner
61001`). Dafür braucht der Kernel das Modul **`xt_owner`**.

Die Grenze ist **fail closed**: Lassen sich die Regeln nicht setzen, startet
kein Edge-Teil (Status „vom Gateway abgelehnt“, `network_fence_inactive`), und
GateControl zeigt „Netzgrenze fehlt“ mit der Meldung des Gateways. Das Gateway
selbst (Routen, Tunnel) arbeitet normal weiter.

**Prüfen** – Container Manager → Container → `…-gateway-1` → **Protokoll**,
nach `edge fence` suchen:

- `edge fence: rules active` (`backend: iptables`) – alles in Ordnung.
- `edge fence: could not set rules — edge parts stay stopped` – im Feld `err`
  steht der Grund (dieselbe Meldung zeigt GateControl bei „Netzgrenze fehlt“).
  Enthält er `iptables owner match:` (meist mit „Couldn't load match … owner“),
  fehlt dem Kernel `xt_owner`.

Per SSH auf der NAS:

```bash
cd /volume1/docker/gatecontrol-gateway
sudo docker compose exec edge cat /run/gc-edge/fence.json   # "active": true, "backend": "iptables"?
lsmod | grep xt_owner                                        # Modul geladen?
ls /lib/modules/xt_owner.ko                                  # bringt DSM es mit?
```

Ist das Modul vorhanden, aber nicht geladen, lädt es
`sudo insmod /lib/modules/xt_owner.ko`; damit das einen Neustart übersteht,
im **Aufgabenplaner** eine ausgelöste Aufgabe (Ereignis „Hochfahren“, Benutzer
`root`) mit diesem Befehl anlegen. Spätestens 30 s danach setzt der
Gateway-Container die Regeln, und die Edge-Teile starten. Bringt DSM das Modul
nicht mit, können auf dieser NAS keine Edge-Teile laufen – Edge in
GateControl für dieses Gateway dann ausgeschaltet lassen (oder `edge` und
`mqtt` wieder aus der Compose-Datei nehmen).

## DSM 7.0/7.1 (Legacy)

Container Manager auf älteren DSM-Versionen hat eingeschränkten docker-compose-Support. Empfohlen: Standalone Docker via SSH:

```bash
ssh admin@synology
cd /volume1/docker/gatecontrol-gateway
sudo docker compose up -d
```

Für User die lieber beim alten Setup bleiben: [`docker-wireguard-go`](https://github.com/CallMeTechie/docker-wireguard-go) ist weiterhin als einfacher WG-Client ohne Gateway-Features verfügbar.
