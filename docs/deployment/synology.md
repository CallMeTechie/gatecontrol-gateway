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
   starten. Wahlweise übernimmt das ein kleiner Hilfsdienst in der
   Compose-Datei – siehe [VPN-Gerät automatisch bereitstellen](#vpn-gerät-automatisch-bereitstellen-test).

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

## VPN-Gerät automatisch bereitstellen (Test)

Wählbar, Standard aus. Statt der Aufgabe im Aufgabenplaner lädt ein
Einmal-Dienst `tun-loader` in der Compose-Datei das Kernel-Modul, bevor das
Gateway startet. Der Dienst `gateway` bleibt dabei unverändert (`devices:
/dev/net/tun`, keine zusätzlichen Rechte); er wartet nur per `depends_on` auf
den Hilfsdienst.

**Einschalten:** in GateControl unter Gateways › „Gateway hinzufügen“ ›
Synology NAS den Schalter **„VPN-Gerät automatisch bereitstellen (Test)“**
setzen – Compose-Datei und Paket enthalten dann den Dienst. Von Hand: den
Dienst `tun-loader` und die Zeilen `depends_on` aus
[`docker-compose.tun-loader.yml`](../../docker-compose.tun-loader.yml) in die
eigene `docker-compose.yml` übernehmen (auf einem Linux-Rechner genügt
`COMPOSE_FILE=docker-compose.yml:docker-compose.tun-loader.yml`).

**Was der Dienst tut:**

1. Gibt es `/dev/net/tun` schon, meldet er „ist da“ und beendet sich – nichts
   wird geladen.
2. Sonst `insmod /lib/modules/tun.ko` (so liegt das Modul auf der Synology;
   `modprobe` findet es dort meist nicht). Gibt es die Datei nicht (übliches
   Linux), `modprobe tun`.
3. Er wartet bis zu 10 Sekunden auf das Gerät. Ist es da: Ende mit Erfolg, das
   Gateway startet. Sonst steht im Protokoll des Containers `…-tun-loader-1`
   eine Meldung (Deutsch/Englisch) mit dem Weg über den Aufgabenplaner, und
   das Gateway startet nicht – wie ohne den Dienst.

Im Container Manager steht `…-tun-loader-1` danach als **beendet** (Exit-Code
0) – das ist richtig so, er läuft nur Sekunden. Das Projekt zeigt deshalb
unter Umständen einen gelben Status, obwohl alles läuft.

**Rechte:** Der Dienst darf Kernel-Module laden (`cap_add: SYS_MODULE`) – das
ist ein weitreichendes Recht, deshalb ist alles andere zu: `cap_drop: ALL`,
kein `privileged`, kein Netz (`network_mode: none`), Dateisystem nur lesbar,
`no-new-privileges`, `/lib/modules` und `/dev` der NAS nur lesend eingebunden
(`/dev` nur, um zu sehen, ob das Gerät da ist). Er nutzt das Gateway-Image
(kein fremdes Image) mit einem festen Befehl, der in der Compose-Datei steht.

**Nach einem Neustart der NAS:** Docker startet die Container dann selbst –
ohne Compose und damit ohne `tun-loader`. Das Modul ist nach dem Neustart
nicht mehr geladen, das Gateway bleibt mit einem Startfehler liegen. Die
Aufgabe für das [Auto-Update](../auto-update.md) (`update.sh`, jede Minute)
erkennt genau diesen Fall und startet das Gateway neu – erst `tun-loader`,
dann das Gateway; nach ein bis zwei Minuten ist es wieder da
(`gateway-state/update.log`: `tun: gateway started`). Ohne diese Aufgabe das
Projekt nach einem Neustart im Container Manager von Hand starten – oder beim
Aufgabenplaner bleiben.

**Zurück:** in GateControl die Compose-Datei ohne den Schalter holen (oder
den Dienst `tun-loader` und `depends_on` aus der Datei löschen), Projekt
stoppen, YAML ersetzen, neu erstellen – und die Aufgabe im Aufgabenplaner
anlegen (Schritt 3 oben). Das geladene Modul bleibt bis zum nächsten Neustart.

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
