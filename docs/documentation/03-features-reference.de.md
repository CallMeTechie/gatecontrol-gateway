# Features Reference

Umfassende Referenz jeder Fähigkeit, die der GateControl Home Gateway bereitstellt. Nutze dies als Nachschlagewerk — jeder Abschnitt beantwortet "was macht es, wie schalte ich es ein, was sind die Edge-Cases".

Task-orientierte Schritt-für-Schritt-Anleitungen siehe **[01 — User Journey](01-user-journey.de.md)**. Architektur-Überblick siehe Top-Level [README](../../README.md).

---

## Inhaltsverzeichnis

- [HTTP Reverse Proxy (Layer 7)](#http-reverse-proxy-layer-7)
- [TCP/UDP Proxy (Layer 4)](#tcpudp-proxy-layer-4)
- [Wake-on-LAN](#wake-on-lan)
- [RDP via Home Gateway](#rdp-via-home-gateway)
- [Auto-Sync mit Server](#auto-sync-mit-server)
- [Heartbeat und Health](#heartbeat-und-health)
- [Management-API](#management-api)
- [Logging](#logging)

---

## HTTP Reverse Proxy (Layer 7)

### Was es tut

Der Gateway stellt einen HTTP-Proxy bereit, der den server-initiierten Request (ankommend via WireGuard auf der Tunnel-IP des Gateways) terminiert und an das konfigurierte LAN-Ziel weiterleitet. Response läuft denselben Weg zurück.

Aus Sicht des externen Aufrufers wird `https://nas.example.com` von Caddy auf dem GateControl-Server ausgeliefert. Caddy proxied an die Gateway-Tunnel-IP auf Port 8080; der Gateway schlägt die Route per Domain nach und leitet an die LAN-IP:Port weiter.

### Pro-Route Einstellungen

| Einstellung | Zweck |
|---|---|
| **Domain** | Der öffentliche Hostname. Caddy holt sich dafür das TLS-Cert. |
| **Ziel-Typ: `Home Gateway`** | Sagt Caddy: zur Gateway-Tunnel-IP proxien, nicht zu direktem Peer. |
| **Gateway-Peer** | Welche Gateway-Instanz behandelt diese Route (du kannst mehrere haben). |
| **LAN-Ziel-Host** | IP oder Hostname, auflösbar im LAN des Gateways. |
| **LAN-Ziel-Port** | Port auf dem der Dienst hört. |
| **Backend HTTPS** | Aktivieren wenn das LAN-Ziel HTTPS serviert (Synology 5001, Fritzbox, UnRAID). Siehe unten. |

### Backend HTTPS

Seit Server v1.41.11. Wenn aktiviert, spricht der Gateway auf dem LAN-Hop HTTPS zum Ziel (Server → Caddy → Gateway in HTTP, Gateway → LAN-Ziel in HTTPS). Ohne das lehnen Dienste, die nur HTTPS antworten (Synology DSM auf 5001, moderne Fritzbox, UnRAID, TrueNAS), den Plain-Request ab.

Zertifikats-Validierung auf dem LAN-Hop ist bewusst deaktiviert — die meisten Self-Hosted-Appliances nutzen Self-Signed-Certs und der LAN-Hop ist in deinem Heimnetz. Wenn du strikte Validierung brauchst, pack ein CA-signiertes Cert aufs Ziel und öffne ein Issue für einen "Backend-Cert validieren"-Toggle.

### Host-Header-Rewrite

Der Gateway schreibt den `Host`-Header vor dem Weiterleiten auf den LAN-Ziel-Wert um (z.B. `192.168.1.50`). Die meisten Web-Apps hinter einem Reverse-Proxy (NAS-UIs, Home Assistant etc.) erwarten das. Apps, die den öffentlichen Hostname im `Host`-Header brauchen (sehr selten), werden aktuell nicht unterstützt — Issue öffnen falls du darauf triffst.

### Websocket-Support

Websockets funktionieren transparent. Home Assistants Realtime-Updates, Jellyfins Player und IDE-im-Browser-Tools funktionieren alle über den Gateway-Proxy.

---

## TCP/UDP Proxy (Layer 4)

### Was es tut

Leitet rohen TCP- oder UDP-Traffic von einem öffentlichen Port am GateControl-Server durch den Gateway zu einem LAN-Ziel. Keine Protokoll-Kenntnis — funktioniert für alles: RDP, SSH, Datenbanken, Gameserver, MQTT, Modbus, proprietäre Industrie-Protokolle.

### Pro-Route Einstellungen

| Einstellung | Zweck |
|---|---|
| **Protokoll** | TCP oder UDP |
| **Öffentlicher Listen-Port** | Port am GateControl-Server auf dem der Client verbindet |
| **Ziel-Typ: `Home Gateway`** | Durch den Gateway-Container routen |
| **Gateway-Peer** | Welcher Gateway das bearbeitet |
| **LAN-Ziel-Host + Port** | Der tatsächliche Dienst im LAN |

### Typische Mappings

| Dienst | Protokoll | LAN-Port | Empfohlener öffentlicher |
|---|---|---|---|
| RDP (Windows) | TCP | 3389 | 13389 |
| SSH | TCP | 22 | 2222 |
| PostgreSQL | TCP | 5432 | 15432 |
| Minecraft (Java) | TCP + UDP | 25565 | 25565 |
| Plex Media Server | TCP | 32400 | 32400 |
| MQTT | TCP | 1883 | 1883 |

Für Protokolle die TCP und UDP am selben Port brauchen (Minecraft, manche VoIP) zwei Routen anlegen — eine pro Protokoll.

### Reservierte Ports

Der GateControl-Server blockiert das Binden dieser öffentlichen Ports weil sie vom Server selbst genutzt werden:

`80, 443, 22, 2019, 3000, 51820`

Zusätzlich lehnt das Admin-UI den Listen-Port ab wenn eine andere L4-Route ihn bereits nutzt. Fehlermeldungen enthalten die konfliktierende Route.

### Port-Ranges

Eine einzelne L4-Route kann einen Range exponieren (z.B. `5000-5010`) für Multi-Port-Dienste. Syntax: `5000-5010` im Listen-Port-Feld. Max-Range ist per `GC_L4_MAX_PORT_RANGE` konfigurierbar (Default 100).

### TLS-Modi

L4-Routen unterstützen drei TLS-Modi für HTTPS-über-TCP-Dienste:

- **None** — rohes TCP-Forward, kein TLS-Wissen
- **Passthrough** — TLS-SNI-Routing; mehrere TLS-Dienste können Port 443 teilen, unterschieden per SNI
- **Terminate** — Caddy terminiert TLS und leitet Plain-TCP weiter (selten nötig bei Gateway-Routen)

Details zu den TLS-Modi in den Haupt-[GateControl-Docs](https://github.com/CallMeTechie/gatecontrol) — die Gateway-seitige Verhaltensweise ist transparent.

---

## Wake-on-LAN

### Was es tut

Wenn ein konfiguriertes Ziel unerreichbar ist und die Route WoL aktiviert hat, sendet der Gateway ein Magic-Packet an die MAC-Adresse des Ziels. Nach dem Senden pollt der Gateway den Ziel-Port in konfigurierbarem Intervall bis das Ziel antwortet oder der Timeout abläuft.

### Voraussetzungen

WoL ist über den ganzen Stack hinweg fragil. Jede dieser Bedingungen muss zutreffen:

- **BIOS/UEFI am Ziel**: "Wake on LAN" aktiviert
- **OS-Power-Settings**: Netzwerk-Adapter darf Gerät aufwecken
- **Switch zwischen Gateway und Ziel**: darf Broadcast und rohe Frames nicht droppen. Unmanaged-Switches sind OK; manche Managed-Switches brauchen IGMP-/Multicast-Tweaks.
- **Gateway-Container**: läuft mit `network_mode: host` (Voraussetzung für rohen Broadcast)
- **Ziel und Gateway** auf demselben L2-Segment (selbes VLAN, selbe Switch-Domain). Magic-Packets routen nicht über L3.

Siehe **[04 — Troubleshooting: "WoL weckt Gerät nicht"](04-troubleshooting.de.md#wol-weckt-gerät-nicht)** für die Diagnose-Checkliste.

### Pro-Route Einstellungen

| Einstellung | Zweck |
|---|---|
| **WoL aktiviert** | Toggle |
| **Ziel-MAC** | Physische Adresse der Ziel-NIC (Format `AA:BB:CC:DD:EE:FF`) |
| **WoL-Timeout** | Wie lange auf Response gewartet wird (Default 60 s) |
| **WoL-Poll-Intervall** | Wie oft in der Wake-Phase TCP-Retry (Default 3 s) |

### Auto-Trigger

WoL triggert automatisch wenn der Uptime-Monitor des GateControl-Servers erkennt, dass die Route von `up` → `down` wechselt, und die Route WoL konfiguriert hat. Der User muss keinen manuellen Endpoint aufrufen — ein eingehender RDP/HTTP-Request auf eine Down-Route startet den Wake-Zyklus.

---

## RDP via Home Gateway

Dedizierter RDP-Route-Typ mit vollständiger Feature-Integration: Credential-Vault, Auflösungsprofile, Clipboard/Audio/Drucker-Policy, Session-Monitoring, WoL-Trigger, Wartungsfenster.

Wähle eine von zwei Topologien:

### Option A — RDP-Route mit Zugriffsmodus "Home Gateway"

Seit Server v1.43. RDP-Route konfigurieren (Routen → Neue RDP-Route) und **Zugriffsmodus: Über Home-Gateway** wählen. Im Hintergrund legt GateControl automatisch eine L4-TCP-Route an die öffentlicher Listen-Port → Gateway → LAN-RDP-Port forwardet. Alle RDP-Komfort-Features bleiben; die downloadbare `.rdp`-Datei nutzt öffentliche Adresse + Listen-Port, nie die LAN-IP.

Empfohlen für jeden, der die RDP-spezifischen Features nutzt.

### Option B — Reine L4-TCP-Route

Eine normale L4-Route auf Port 3389 (oder anderem öffentlichen Port) mit Ziel-Typ "Home Gateway". Funktioniert mit jedem RDP-kompatiblen Client (mstsc, FreeRDP, Remmina). Keine Credential-Verwaltung in GateControl — der User tippt User und Passwort im Client.

Empfohlen wenn du rohes RDP ohne Featureset willst, oder mit Nicht-Microsoft-Clients.

### RD-Gateway (TSGateway) Hinweis

Das RDP-Route-Formular hatte historisch Felder "Gateway-Host" / "Gateway-Port" für das Microsoft **RD-Gateway** (TSGateway) — ein unverbundenes Microsoft-Produkt das RDP über HTTPS tunnelt. Diese Felder sind für RD-Gateway, nicht für den GateControl-Home-Gateway. Beide können kombiniert werden (GateControl-Home-Gateway zum LAN-Edge, dann drinnen ein RD-Gateway für weiteres Routing), aber selten nötig im Homelab.

---

## Auto-Sync mit Server

### Was es tut

Der Gateway pollt den Server alle 10 Sekunden (konfigurierbar) nach seiner Route-Liste. Wenn der Config-Hash sich ändert, liest der Gateway die volle Route-Liste neu, gleicht lokale Listener ab (startet neue L4-Listener, stoppt entfernte) und berichtet Erfolg zurück.

Du musst den Gateway-Container nie neu starten nach Route-Änderungen im UI — der Sync erledigt das.

### Config-Hash

Server und Gateway teilen sich ein gemeinsames `config-hash`-Modul (`@callmetechie/gatecontrol-config-hash` NPM-Paket) das einen deterministischen Hash über die Route-Liste produziert. Der Gateway vergleicht seinen zuletzt-applizierten Hash mit dem, den der Server annonciert; Mismatch triggert Re-Sync.

Wenn du einen persistenten Hash-Mismatch in den Logs siehst, laufen beide Seiten inkompatible Config-Hash-Versionen (sehr selten; nur wenn eine Seite upgedatet wurde ohne die andere). Der Server versucht weiter, bis die Versionen passen.

### Config-Rollback

Wenn Anwenden einer neuen Route-Liste fehlschlägt (z.B. weil ein Listen-Port belegt ist), kehrt der Gateway zum letzten Known-Good-Config zurück und meldet den Fehler. Das UI zeigt welche Route den Fehler verursacht hat.

---

## Heartbeat und Health

### Heartbeat

Alle 30 Sekunden POSTed der Gateway einen Heartbeat an den Server mit:

- Seiner bekannten Tunnel-IP und WireGuard-Handshake-Zeit
- Pro-Route-Erreichbarkeitsstatus (für jedes konfigurierte L4/HTTP-Ziel: hat der Probe im letzten Zyklus geklappt?)
- Self-Check: Container-Uptime, Memory, CPU
- Aktueller Config-Hash

Der Server speichert `last_seen_at` und füttert die Health-Statemaschine.

### Health-Statemaschine

Server-seitig, eine **Sliding-Window-Hysterese** pro Gateway-Peer:

- Fenstergröße: 5 Probes
- Offline-Schwelle: 3 Fehler im Fenster
- Online-Schwelle: 4 Erfolge im Fenster
- Cooldown: 5 Minuten zwischen Transitionen (verhindert Flapping)

Die Zustandsübergänge `unknown → online ↔ offline` treiben den UI-Status-Indikator und Caddys Verhalten (offline → Caddy serviert eine Wartungsseite für Routen die auf den offline Gateway zeigen).

### Server-seitiger TCP-Probe

Seit Server v1.54. Wenn der letzte Heartbeat eines Gateways älter als 60 Sekunden ist, probt der Server den Gateway-API-Port direkt (TCP-Connect auf 127.0.0.1:9876 innerhalb des WireGuard-Tunnels). Das fängt silently-dead Gateways die ohne Abschieds-Heartbeat gecrasht sind, und stellt Gateways wieder als online dar bevor der nächste reguläre Heartbeat eintrifft (bis zu 30 s schnellere Rückkehr-zu-Online im UI).

Siehe [src/services/gatewayProbe.js](https://github.com/CallMeTechie/gatecontrol/blob/master/src/services/gatewayProbe.js) im Server-Repo.

### Flap-Detection

Wenn die Statemaschine mehr als 4 mal pro Stunde transitioniert, loggt der Server ein `gateway_flap_warning` Activity-Event. Typische Ursachen: instabiles Upstream-Internet, überlasteter Gateway-Host, fehlkonfigurierter Health-Check.

---

## Management-API

Der Gateway-Container exponiert eine kleine HTTP-API auf seiner Tunnel-IP, Port 9876 (Default). Vom Server genutzt um Commands zu pushen (WoL-Trigger, Config-Re-Sync, Status-Snapshot).

Diese API ist **nur über den WireGuard-Tunnel erreichbar** — der Gateway exponiert sie auf keinem anderen Interface. Authentifizierung via `api_token` aus `gateway.env`.

Endpoints (server-konsumiert, selten nützlich für Menschen):

- `GET /api/v1/status` — Self-Check
- `POST /api/v1/sync` — Config-Re-Sync erzwingen
- `POST /api/v1/wol` — Magic-Packet on-demand
- `GET /api/v1/probes` — aktuelle Erreichbarkeit der konfigurierten L4/HTTP-Ziele

---

## Logging

### Wo Logs hingehen

Container stdout/stderr, gefangen von Docker. Zugriff via:

```bash
docker logs gatecontrol-gateway --since 1h       # letzte Einträge
docker logs gatecontrol-gateway --follow         # live tail
```

### Log-Format

JSON-Lines (pino). Jede Zeile hat `level`, `time`, `msg`, plus kontextuelle Felder. Typische Zeile:

```json
{"level":30,"time":1777040000000,"msg":"HTTP route added","route_id":42,"domain":"nas.example.com"}
```

### Log-Level

Gesetzt via `LOG_LEVEL` env:

- `debug` — verbose Per-Request-Details (nur Development)
- `info` — Startup, Route-Änderungen, Heartbeat-Zusammenfassung (Default)
- `warn` — wiederherstellbare Probleme (unerreichbare Ziele, stale Sync)
- `error` — Fehler

Default ist `info`. Auf `debug` wechseln beim Troubleshooting; danach zurückdrehen.

### Log-Rotation

Dockers Default-Log-Driver rotiert bei 10 MB mit 3 aufbewahrten Files (30 MB Max pro Container). Für Langzeit-Produktion in `docker-compose.yml` anpassen:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

---

## Konfigurations-Referenz

Alle Runtime-Konfiguration kommt aus `gateway.env` (heruntergeladen vom Server's Peers → Peer-Detail → "Gateway-Config herunterladen") und einem kleinen Set von Umgebungsvariablen:

| Variable | Default | Zweck |
|---|---|---|
| `GATEWAY_ENV_PATH` | `/config/gateway.env` | Pfad zur Downloaded-Config (als `/config`-Volume mounten) |
| `LOG_LEVEL` | `info` | Log-Verbosity |
| `HTTP_PROXY_PORT` | `8080` | Wo der Gateway für HTTP vom Server lauscht |
| `MANAGEMENT_PORT` | `9876` | Management-API-Port (nur Tunnel-IP) |
| `SYNC_INTERVAL_MS` | `10000` | Wie oft der Server nach Config-Änderungen gepollt wird |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat-Kadenz |

Siehe `docker-compose.example.yml` im Repo-Root für den empfohlenen Startpunkt.

---

## Weiter

- **[04 — Troubleshooting](04-troubleshooting.de.md)** — wenn Features sich fehlverhalten
- **[05 — Security Model](05-security-model.de.md)** — was der Gateway sehen kann, Hardening-Entscheidungen
