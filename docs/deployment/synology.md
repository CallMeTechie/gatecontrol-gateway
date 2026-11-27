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
   „Gateway anlegen und weiter“. Der Assistent zeigt die Compose-Datei (ohne
   Zugangsdaten, für alle Gateways gleich), die **Serveradresse** und einen
   **Einrichtungscode** (10 Minuten gültig, einmalig).

2. **Ordner und Projekt**

   Im Assistenten das Paket `gatecontrol-gateway-nas.zip` herunterladen
   (`docker-compose.yml`, `update.sh` und die leeren Ordner `config/`,
   `gateway-state/`, `gateway-cache/`), in der File Station unter `docker`
   einen Ordner `gatecontrol-gateway` anlegen, die ZIP hochladen und dort
   „Extrahieren“:
   ```
   /volume1/docker/gatecontrol-gateway/
     ├── docker-compose.yml
     ├── update.sh
     ├── config/            ← hier legt das Gateway seine gateway.env ab
     ├── gateway-state/     ← /state (Auto-Update-Flag, last-pull, update.log)
     └── gateway-cache/     ← /cache (Zwischenspeicher, docs/dns-cache.md)
   ```
   Dann Container Manager → Projekt → Erstellen: Projektname
   `gatecontrol-gateway`, Pfad `/volume1/docker/gatecontrol-gateway`,
   „Vorhandene docker-compose.yml verwenden“ → Weiter → Fertig.

   **Der Container Manager legt fehlende Bind-Mount-Ordner nicht an** – fehlt
   einer, bricht der Start mit `Bind mount failed: … does not exist` ab. Wer die
   Compose-Datei nur kopiert und im Container Manager einfügt, legt `config/`,
   `gateway-state/` und `gateway-cache/` vorher in der File Station an.

   Die Meldung „Your kernel does not support PIDs limit …“ ist harmlos: Der
   DSM-Kernel kann `pids_limit` (Dienste `edge`, `mqtt`) nicht setzen, Docker
   lässt die Grenze weg.

3. **Einrichtungsseite öffnen und verbinden**

   Im Browser im Heimnetz `http://<Adresse der Synology>:8642` öffnen,
   Serveradresse und Einrichtungscode eingeben, „Verbinden“. Die Seite zeigt
   jeden Schritt; nach etwa einer Minute ist das Gateway online, und der
   Assistent in GateControl geht von selbst weiter. Fehlt etwas (kein
   Internet, falsche Uhrzeit, Ordner `config` nicht beschreibbar), sagt die
   Seite, was zu tun ist. Einzelheiten: [Einrichtungsseite](../setup-page.md).

   **Startet das Projekt nicht und die Meldung nennt `/dev/net/tun`**, fehlt
   der NAS das Gerät – dann gibt es auch die Seite noch nicht. Ohne SSH:
   Systemsteuerung › Aufgabenplaner › Erstellen › Ausgelöste Aufgabe ›
   Benutzerdefiniertes Skript, Benutzer `root`, Ereignis „Hochfahren“, Befehl
   `insmod /lib/modules/tun.ko`; Aufgabe markieren, „Ausführen“, Projekt
   starten.

   **Bisheriger Weg:** Im Assistenten „Lieber die Datei gateway.env
   herunterladen“ – das Paket enthält dann zusätzlich `config/gateway.env`;
   jeder Download erzeugt einen neuen Zugangsschlüssel.

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
   Gateway im Assistenten (Schritt 4); `http://<Adresse der Synology>:8642`
   zeigt „Verbunden“.

## Ältere Projekte (`./config:/config:ro`)

Projekte, die mit einer `gateway.env` eingerichtet wurden, laufen unverändert
weiter – auch mit `:ro`. Sie zeigen die
Statusseite; **verbinden** lässt sich über die Seite dort nicht (sie sagt das
und verbraucht keinen Code). Wer „Zugang erneuern“ künftig ohne neue Datei
erledigen will, ersetzt die Compose-Datei einmal durch die aktuelle aus
GateControl (nächster Abschnitt) oder entfernt das `:ro`.

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

## Lokale KI

Schaltet man in GateControl die **lokale KI** für dieses Gateway ein
(Einstellungen › Erweiterungen › KI-Anbieter oder Gateway › Funktionen,
[docs/local-ai.md](../local-ai.md)), braucht die NAS einmal die aktuelle
Compose-Datei mit dem Dienst `ki` (Ollama). Fehlt er, zeigt GateControl bei der
Zeile „Lokale KI“ den Knopf **„docker-compose.yml herunterladen“** – dann wie oben
unter „Compose-Datei aus GateControl holen“ (Projekt stoppen, YAML ersetzen, neu
erstellen). Das Ollama-Image ist ≈ 3 GB groß, jedes Modell 1–6 GB (Volume
`ki-models`); beides kommt von Docker Hub bzw. `registry.ollama.ai`. Die
Grafikkarte nutzt der Dienst nicht – auf einer NAS ohne GPU antwortet ein
3B-Modell in einigen Sekunden bis Minuten.

## Videos umwandeln

Schaltet man in GateControl **Videos umwandeln** für dieses Gateway ein (Gateway ›
Funktionen, [docs/transcode.md](../transcode.md)), wandelt die NAS Videos, die nicht
überall laufen (z. B. H.264 mit 10 Bit), mit ihrer Intel-Grafik in H.264 8 Bit um.
Dafür braucht sie den Dienst `umwandeln` (Image ≈ 120 MB Download, nur
Intel/AMD-64-Bit-Modelle). Der Dienst hat kein Netz und darf nur in die gewählten
Medienordner schreiben. Einmalig:

1. **Eigenen Benutzer anlegen:** Systemsteuerung › Benutzer & Gruppe › „Erstellen“,
   z. B. `gc-umwandeln`, ohne Zugriff auf Anwendungen. Bei „Berechtigungen für
   gemeinsame Ordner“ **Lesen/Schreiben nur** für die Medien-Freigabe(n) wählen, alle
   anderen „Kein Zugriff“.
2. **Zahlen nachsehen** (SSH oder Aufgabenplaner):
   ```bash
   id gc-umwandeln                      # uid=1034(gc-umwandeln) gid=100(users) …
   stat -c '%g %G' /dev/dri/renderD128  # 937 videodriver
   ```
   Fehlt `/dev/dri/renderD128`, hat das Modell keine nutzbare Intel-Grafik – dann geht
   nur der langsame Weg ohne Grafik (in GateControl ausdrücklich erlauben) und die
   Zeilen `devices:` müssen aus dem Dienst entfernt werden.
3. **Compose-Datei:** Bietet GateControl bei „Videos umwandeln“ den Knopf
   **„docker-compose.yml herunterladen“** an, dort Ordner, Benutzer und Gruppe der
   Grafik eintragen und die Datei wie oben unter „Compose-Datei aus GateControl holen“
   einspielen. Von Hand (Dienst `umwandeln` und Volume `umw-ctl` aus
   `docker-compose.example.yml`, dazu die Zeile `/gc-umw` beim Dienst `gateway`) in die
   `.env` des Projekts:
   ```
   COMPOSE_PROFILES=umwandeln
   GC_UMW_UID=1034
   GC_UMW_GID=100
   GC_UMW_RENDER_GID=937
   GC_UMW_MEDIA=/volume2/mediathek
   ```
   Der Ordner wird innen unter demselben Pfad eingehängt wie außen – so passen die
   Pfade, die Jellyfin kennt. Mehrere Ordner: je Ordner eine Zeile unter `volumes:`
   des Dienstes und `GC_UMW_ROOTS=/volume2/mediathek:/volume1/filme`.

Das Gateway meldet danach die Grafik (Treiber „Intel iHD …“), die geprüften Verfahren
und den freien Platz. Meldet es `device: denied`, stimmt `GC_UMW_RENDER_GID` nicht mit
der Gruppe des Geräts überein (die richtige Zahl steht als `deviceGid` dabei). Die
Rechte von `/dev/dri/renderD128` nicht ändern (kein `chmod 666`).

Prüfen: `sudo docker compose ps umwandeln` zeigt `healthy`; in
`sudo docker compose logs umwandeln` steht nichts (der Dienst schreibt nur in sein
Volume).

Die neue Datei ersetzt das Original unter demselben Namen; das Original liegt
14 Tage (einstellbar) im Ordner `.gc-papierkorb` der Freigabe und lässt sich in
GateControl zurückholen. Zwischendateien liegen in `.gc-umwandeln`. Beide Ordner
liest Jellyfin nicht ein (`.ignore`). Bei Btrfs-Schnappschüssen wird der Platz des
Originals erst frei, wenn auch die Schnappschüsse ablaufen.

## DSM 7.0/7.1 (Legacy)

Container Manager auf älteren DSM-Versionen hat eingeschränkten docker-compose-Support. Empfohlen: Standalone Docker via SSH:

```bash
ssh admin@synology
cd /volume1/docker/gatecontrol-gateway
sudo docker compose up -d
```

Für User die lieber beim alten Setup bleiben: [`docker-wireguard-go`](https://github.com/CallMeTechie/docker-wireguard-go) ist weiterhin als einfacher WG-Client ohne Gateway-Features verfügbar.

## Kameras

Schaltet man in GateControl **Kameras** für dieses Gateway ein (Gateway ›
Funktionen › „Geräte im Heimnetz“, [docs/cameras.md](../cameras.md)), braucht die
NAS einmal die aktuelle Compose-Datei mit dem Dienst `kameras` (nur ffmpeg, ≈ 80 MB
Image). Fehlt er, zeigt GateControl bei der Zeile „Kameras“ den Knopf
**„docker-compose.yml herunterladen“** – dann wie oben unter „Compose-Datei aus
GateControl holen“. Ohne den Dienst gehen Suche, Testbild und Bewegungsmeldungen
schon, Live-Video und Clips noch nicht.

Clips liegen im Volume `cam-recordings`. Für einen sichtbaren Ordner der NAS
(z. B. `/volume1/kameras`) den Ordner in der File Station anlegen und
`GC_CAMERA_DIR=/volume1/kameras` in die `.env` des Projekts schreiben. In den
Kameras ONVIF und RTSP einschalten (Reolink: Einstellungen › Netzwerk › Erweitert ›
Server-Einstellungen; Tapo: App › Kamera › Erweitert › Kamerakonto anlegen –
dieses Konto ist dann „Benutzer der Kamera“ in GateControl).
