# Edge-Container: Plugin-Teile im Heimnetz

Manche Plugins brauchen Zugriff auf Geräte im Heimnetz, den der Server nicht
hat: UDP-Broadcasts und Multicast (CoAP, Shelly, Hue), mDNS, kurze TCP- und
HTTP-Verbindungen zu LAN-Geräten. Dafür kann ein Plugin einen **Edge-Teil**
mitbringen, der auf dem Gateway läuft – in einem eigenen, abgeschotteten
Container `edge`, nie im Gateway-Container selbst. Der Edge-Container hat
**kein Netz** (`network_mode: none`, ab Gateway 1.23.0): was er nach außen
braucht – den Kanal zum Server, Pakete, LAN-Geräte, mDNS, MQTT – erledigt der
Gateway-Container für ihn über einen Unix-Socket und prüft dabei jede Anfrage.
Eine Netzgrenze per Firewall-Regel (Kernel-Modul `xt_owner` bzw. nftables
`skuid`) ist damit nicht mehr nötig – auch nicht auf der Synology.

Der Vertrag zwischen Gateway und Server (Kanal, Nachrichten, Pakete, Grenzen)
ist im Konzept „Phase 2“ festgelegt; dieses Dokument beschreibt die
Gateway-Seite.

```
GateControl-Server ◀──WebSocket gc-edge.v1 (Token des Gateways)──┐
LAN-Geräte (UDP/TCP/HTTP/mDNS) ◀───────────────────────────────┤
Mosquitto (Dienst mqtt) ◀── Broker-Dateien, internes Konto ─────┤
                                     Gateway-Container (root, Host-Netz)
                                       └─ /run/gc-edge/gw.sock (0660, Gruppe 61001)
                                            ▲ Relay · Pakete · RPC (geprüft im Gateway)
                                            │
                                     Edge-Host (Container edge, UID 61001, network_mode: none)
                                       ├─ Plugin-Prozess A (Permission-Model)
                                       └─ Plugin-Prozess B
```

## Container und Image

| | |
|---|---|
| Image | **dasselbe Image** wie das Gateway (`ghcr.io/callmetechie/gatecontrol-gateway`), anderer Befehl: `/sbin/tini -- node src/edge/main.js` |
| Benutzer | `gcedge`, **UID/GID 61001** (fest im Image angelegt) |
| Rechte | `cap_drop: ALL`, keine `cap_add`, `no-new-privileges`, `read_only`, `/tmp` als tmpfs (16 MB), `mem_limit: 512m`, `pids_limit: 256` |
| Netz | `network_mode: none` – nur Loopback; alles nach außen über den Gateway-Socket (Abschnitt „Gateway-Socket“). Alte Compose-Dateien: `host` + Netzgrenze |
| Volumes | `edge-state` → `/state-edge` (Pakete, `gc.store`), `edge-run` → `/run/gc-edge` (nur lesen; darin `gw.sock`), `edge-status` → `/run/gc-edge-status` |

**Warum dasselbe Image:** kein zweiter Release-Pfad, multi-arch wie das
Gateway (amd64, arm64, arm/v7) ohne zusätzlichen Bau, und auf dem Host kostet
der Container keinen Speicherplatz extra (gemeinsame Schichten). Die Werkzeuge
des Gateways (wireguard-go mit File-Capability, iptables) nützen im
Edge-Container nichts: ohne Capabilities im Bounding-Set und mit
`no-new-privileges` bekommt kein Programm dort Rechte. Der Auto-Update
(`deploy/update.sh`) zieht den Edge-Container nach einem erfolgreichen
Gateway-Update mit und rollt ihn bei einem Rollback mit zurück.

### Volumes und Rechte

* `edge-run` ist ein **tmpfs-Volume** (`uid=0,gid=61001,mode=2750`), das
  Gateway- und Edge-Container teilen. Der Gateway-Container (root, aber ohne
  `CAP_CHOWN`/`CAP_DAC_OVERRIDE`) legt dort den Socket `gw.sock` an (`0660`)
  und – für alte Compose-Dateien – den Marker der Netzgrenze; das setgid-Bit
  gibt jeder Datei die Gruppe 61001. Der Edge-Container hängt das Volume nur
  lesend ein: den Socket kann er benutzen (dafür reicht das Schreibrecht der
  Gruppe auf die Socket-Datei), aber weder löschen noch durch einen eigenen
  ersetzen. Andere Benutzer kommen nicht dran. Das **API-Token** liegt dort
  nicht mehr (ältere Gateways schrieben `credentials`; die Datei wird beim
  Start gelöscht).
* `edge-status` ist ein tmpfs-Volume des Edge-Benutzers (`uid=61001`); der
  Edge-Host schreibt dort seine Zusammenfassung, der Gateway-Container liest
  sie (nur lesend eingehängt) für die Telemetrie.
* `edge-mqtt-conf` ist ein tmpfs-Volume wie `edge-run` (`uid=0,gid=61001,
  mode=2750`): der Gateway-Container schreibt die Broker-Dateien, der Dienst
  `mqtt` liest sie (nur lesend). Der Edge-Container hängt es nicht ein.
* `edge-state` und `edge-mqtt` sind normale Volumes; ein neues Volume
  übernimmt Besitzer und Rechte von `/state-edge` bzw. `/gc-mqtt` aus dem
  Image (61001, `0700`). `edge-mqtt` gehört dem Dienst `mqtt` (Kopie der
  Broker-Dateien, Mosquitto-Daten); der Gateway-Container hängt es nur lesend
  ein, damit ein neues Volume diese Rechte aus dem Image bekommt – lesen kann
  er den Ordner selbst nicht (kein `CAP_DAC_OVERRIDE`). `mqtt` startet nach
  `gateway` (`depends_on`).

Die tmpfs-Volumes werden mit `nocopy` eingehängt, damit Docker die
Rechte aus den `driver_opts` nicht durch die des Images ersetzt.

### Abschalten

Ohne Server-Unterstützung (ältere Server ohne Edge-Endpunkt) bleibt der
Edge-Host untätig: keine Plugin-Prozesse, kein Broker; er fragt alle 10
Minuten nach. Das Gateway funktioniert unverändert. Wer den Edge-Container
gar nicht will, lässt den Dienst `edge` und die Volumes `edge-*` in der
Compose-Datei weg (Raspberry-Pi-Image: `EDGE=off` in `settings.txt`) – der
Gateway-Container erkennt das am fehlenden `/run/gc-edge` und tut dann nichts.

## Kanal zum Server

* `GET ${GC_SERVER_URL}/api/v1/gateway/edge/ws`, `Authorization: Bearer
  <GC_API_TOKEN>`, Subprotokoll `gc-edge.v1`, JSON-Textframes ≤ 64 KB.
* Die Verbindung zum Server baut der **Gateway-Container** auf (mit seinem
  Token, zu den selbst aufgelösten Adressen von `serverUrl`; TLS prüft den
  Namen). Der Edge-Host verbindet sich nur mit dem Gateway-Socket
  (`ws+unix:///run/gc-edge/gw.sock:/api/v1/gateway/edge/ws`), das Gateway
  reicht die Textframes in beide Richtungen 1:1 durch (Relay). Der
  Edge-Container sieht weder `gateway.env` noch Token.
* Lehnt der Server ab (401/403/404/426/501), bekommt der Edge-Host dieselbe
  HTTP-Statuszeile; ist der Server nicht erreichbar, 502. Close-Codes des
  Servers (z. B. 4000 „replaced“, 4001 „credentials changed“) kommen durch.
  Ein neues Token (neue `gateway.env`) gilt ab der nächsten Verbindung.
* Das Gateway pingt den Server alle 20 s und schließt beide Seiten nach 60 s
  ohne Lebenszeichen.
* Ping alle 20 s, Abbruch nach 60 s ohne Lebenszeichen, Wiederverbindung mit
  Backoff 1 s … 60 s (±20 % Zufall). HTTP 404/426/501 (Server ohne Edge) →
  alle 10 min, 401/403 (Token abgelehnt) → alle 5 min.
* Nach dem Verbinden: `hello` (Gateway-Version, Edge-Host-Version,
  MQTT-Verfügbarkeit, Netzgrenze, Betriebsart `isolation: { mode, active }`,
  Hardware-Profil), der Server antwortet mit
  dem vollständigen Sollzustand `state`. Danach sendet der Edge-Host noch
  unbestätigte Ereignisse erneut.
* `status` bei jeder Änderung (gebündelt, 1 s) und alle 30 s.

## Sollzustand und Pakete

Der `state` wird vollständig geprüft, bevor etwas davon gilt (ungültig →
verworfen, nichts ändert sich). Für jedes gewollte Plugin:

1. Paket `GET …/api/v1/gateway/edge/packages/<id>/<version>` (≤ 20 MB) über
   den Gateway-Socket holen (das Gateway lädt es mit seinem Token, nur
   `id`/`version` aus dem Sollzustand), **SHA-256** gegen den `state` prüfen.
2. `.gcplugin` mit denselben Regeln wie der Server lesen (Pfade, Größen,
   Dateizahl, keine Datei/Ordner-Kollision, nichts hinter dem Ende).
3. **Signatur selbst prüfen** (`GCPLUGIN-MANIFEST-V1`, Ed25519) gegen die
   Herausgeber-Schlüssel im Image (`src/edge/trusted-keys.txt`, Kopie von
   `BUILTIN_PUBLIC_KEYS` des Servers; zusätzliche Schlüssel über
   `GC_EDGE_PUBKEYS`, JSON-Liste). `invalid` → immer abgelehnt;
   `none`/`untrusted` → nur mit `allowUnsigned: true`. Wird `allowUnsigned`
   später zurückgenommen, stoppt ein unsignierter Edge-Teil sofort.
4. `plugin.json` prüfen: `id`/`version` wie im `state`, Abschnitt `edge`
   (`entry` in einem Unterordner, `.js`/`.cjs`; `memoryMb` 16–256;
   `minGateway`; Fähigkeiten nach den Regeln unten).
5. Nur den Ordner von `edge.entry` + `plugin.json` nach
   `/state-edge/packages/<id>/<version>/` entpacken. Der Server-Teil des
   Pakets kommt nie auf das Gateway. Alte Versionen werden erst nach dem
   erfolgreichen Start der neuen gelöscht; während ein Update geladen wird,
   läuft die alte Version weiter (`update_pending`).

Abgelehnte Pakete erscheinen im `status` als `denied` mit `lastError`
`<code>: <text>` (`sha256_mismatch`, `bad_package`, `signature_invalid`,
`unsigned`, `bad_manifest`, `gateway_too_old`, `bad_caps`). Ein fehlgeschlagener
Download (`download_failed`, `not_found`) wird nach 60 s wiederholt.

Prüfen, ob die Schlüssel im Image noch zu denen des Servers passen:

```bash
node scripts/check-edge-trusted-keys.js ../gatecontrol        # lokaler Klon des Server-Repos
GH_TOKEN=… node scripts/check-edge-trusted-keys.js --github   # Branch master auf GitHub
```

## Isolation

Jeder Edge-Teil läuft als eigener Kindprozess des Edge-Hosts
(`child_process.fork` von `src/edge/child/bootstrap.js`) – Ansatz und
Sperrliste wie am Server (`docs/plugins.md` „Isolation“), nur strenger:

* Nodes Permission-Model (`--permission`, auf Node 20
  `--experimental-permission`): lesen nur die Bootstrap-Datei und den
  Code-Ordner des Plugins, **kein Schreibrecht** (gc.store schreibt der Host),
  keine Kindprozesse, Worker, Addons (`--no-addons`), kein Inspector, kein
  WASI; `--max-old-space-size=memoryMb`, `--disable-sigusr1`,
  `--no-experimental-sqlite` (soweit die Node-Version die Schalter kennt).
* Leere Umgebung (`NODE_ENV`, `GC_PLUGIN_ID`, `TZ`) – kein Token, keine
  Zugangsdatei (die liest nur der Edge-Host, und das Permission-Model
  verbietet dem Kind jeden anderen Pfad).
* Vor dem Plugin-Code sperrt der Bootstrap in JavaScript: `process.kill` an
  andere Prozesse, `_debugProcess`, `binding`, `dlopen`, `execve`, set*id,
  die Module `child_process`, `cluster`, `worker_threads`, `inspector`,
  `repl`, `wasi`, `sqlite`, `trace_events`, `v8`, `dns`, und **alle
  verbindenden Netzfunktionen** (`net`, `tls`, `dgram`, `http`, `https`,
  `http2`, `fetch`, `WebSocket`).
* Netzwerk gibt es nur über `gc.lan.*`/`gc.mqtt.*`: das Kind schickt die
  Anfrage per IPC an den Edge-Host, der sie über den Gateway-Socket weitergibt;
  **der Gateway-Container prüft und führt sie aus** (Fähigkeiten, LAN-Grenzen).
* Neustart nach Absturz mit Backoff 1 s, 2 s, 5 s, 15 s, 30 s, 60 s, 5 min
  (nach 10 min stabilem Lauf wieder von vorn); ein Prozess, der 75 s nicht auf
  Pings antwortet, wird beendet und neu gestartet.

Das Permission-Model hat auf Node 20/22 keine Netzwerk-Sperre; die
JavaScript-Sperre ist Verteidigung in der Tiefe. Die eigentliche Grenze nach
außen ist, dass der **Edge-Container gar kein Netz hat** und jede Anfrage im
Gateway-Container geprüft wird (nächster Abschnitt). Fail closed: ein
Edge-Teil startet nur, wenn der Edge-Host das selbst bestätigt hat –

* **isoliert** (`mode: isolated`): außer Loopback keine Schnittstelle mit
  Adresse, und ein UDP-Datagramm an `192.0.2.1` scheitert mangels Route
  (`ENETUNREACH`, IPv6 ebenso zu); oder
* **alte Compose-Datei** (`mode: fence`, Edge im Host-Netz): die Netzgrenze
  ist aktiv (Abschnitt „Netzgrenze“).

Die Betriebsart steht nach der ersten Prüfung fest (das Netz eines Containers
ändert sich nicht); ergäbe eine spätere Prüfung etwas anderes, stoppen alle
Edge-Teile. Ohne Bestätigung: `denied` mit `lastError`
`network_isolation_inactive: …` bzw. `network_fence_inactive: …`.

## Gateway-Socket

`/run/gc-edge/gw.sock`, HTTP/1.1 über den Unix-Socket (`src/edge/bridge.js`
im Gateway-Container, `src/edge/remote.js` im Edge-Host), höchstens 8
Verbindungen:

| Pfad | |
|---|---|
| `GET /api/v1/gateway/edge/ws` (Upgrade, `gc-edge.v1`) | Relay zum Server (oben); das Gateway liest den Sollzustand `state` mit (dieselbe Prüfung wie der Edge-Host) |
| `GET /api/v1/gateway/edge/packages/<id>/<version>` | Paket vom Server, nur für `id`/`version` aus dem Sollzustand, sonst 404 |
| `GET /edge/rpc` (Upgrade, `gc-edge-rpc.v1`, Frames ≤ 8 MB) | RPC für `gc.lan.*`, mDNS und – isoliert – `gc.mqtt.*` |

RPC, JSON-Textframes:

* Edge → Gateway: `{t:'call', id, plugin, api, args, caps}` und
  `{t:'close', plugin}` (Prozess beendet → alle Sockets, Suchen, Abos zu).
* Gateway → Edge: `{t:'result', id, ok, result | error:{code, message, data?}}`,
  `{t:'push', plugin, msg}` (UDP-Datagramm, TCP-Daten, mDNS-Fund,
  MQTT-Nachricht für den Plugin-Prozess) und `{t:'info', mqtt:{available},
  mqttStatus}` (beim Verbinden und wenn sich am Broker etwas ändert).

**Geprüft wird im Gateway**, nicht im Edge-Container – ein kompromittierter
Edge-Container kommt nicht weiter:

* das Plugin steht im mitgelesenen Sollzustand, Edge ist eingeschaltet, das
  Plugin auch, seine Fähigkeiten sind gültig – sonst `not_enabled`;
* wirksame Fähigkeiten = Angabe des Edge-Hosts (Manifest ∩ Genehmigung)
  geschnitten mit der Genehmigung des Servers: der Edge-Container kann nur
  einengen, nie erweitern;
* Ziele wie unten („Edge-API“): nur IPv4 in den privaten LAN-Subnetzen, nie
  Tunnel-Adresse oder Server, keine Hostnamen; Grenzen je Plugin wie bisher;
* je eine Relay- und RPC-Verbindung; eine neue ersetzt die alte. Bricht die
  RPC-Verbindung ab, schließt das Gateway alle Sockets und Abos; verbindet sich
  der Edge-Host neu (z. B. nach einem Neustart des Gateway-Containers),
  startet er laufende Edge-Teile neu, damit sie sich frisch einrichten.

UDP-Ports und Multicast-Beitritte der Edge-Teile öffnet damit der
Gateway-Container (Host-Netz) – für Geräte im LAN sieht das aus wie bisher.

## Netzgrenze (nur alte Compose-Dateien)

Nur nötig, wenn der Edge-Container noch im Host-Netz läuft (Compose-Datei von
vor Gateway 1.23.0, z. B. auf einem älteren Raspberry-Pi-Image). Läuft der
Edge-Host dort und lässt sich die Grenze nicht setzen (Synology DSM ohne
`xt_owner`), meldet GateControl „Compose-Datei veraltet“ – die Lösung ist die
neue Compose-Datei aus GateControl, kein Kernel-Modul. Das Gateway setzt die
Regeln trotzdem in jeder Betriebsart, wo es geht: ob der Edge-Container wirklich
ohne Netz läuft, meldet er selbst, und darauf verlässt sich das Gateway nicht.

Der Gateway-Container (root, `CAP_NET_ADMIN`, Host-Netz) setzt beim Start und
danach alle 30 s Regeln mit **Owner-Match auf UID 61001** im OUTPUT-Pfad des
Hosts. Sie gelten nur für Pakete, die Prozesse des Edge-Benutzers erzeugen
(Edge-Host, Plugin-Prozesse, Mosquitto); das Gateway selbst und alle anderen
Prozesse des Hosts bleiben unberührt. Erlaubt ist, in dieser Reihenfolge:

1. Loopback TCP 1883 in beide Richtungen (lokaler Broker),
2. die Adressen von `serverUrl` (aufgelöst vom Gateway-Container), nur TCP auf
   dessen Port,
3. **verworfen:** die eigene Tunnel-Adresse und alles über `gatecontrol0`,
4. Multicast 224.0.0.0/4 (mDNS, genehmigte Gruppen),
5. die privaten LAN-Subnetze (RFC 1918) der physischen LAN-Schnittstellen,
6. alles andere **DROP** – auch IPv6 (außer Broker über `::1` und
   IPv6-Adressen des Servers).

Kein DNS, keine anderen Loopback-Dienste (z. B. Management-API, SSH), kein
Internet. (Kanal, Pakete und `gc.lan.*` laufen auch hier über den
Gateway-Socket; Server-Adressen und LAN braucht im Host-Netz nur noch der
Broker bzw. der Edge-Host für den lokalen Broker.) Ändern sich LAN-Subnetze oder Server-Adressen, werden die Regeln
beim nächsten Takt angepasst.

**Backends:**

* **nftables** (bevorzugt): eigene Tabelle `inet gc_edge` mit Kette `output`
  (`meta skuid 61001 jump edge`), in einer Transaktion ersetzt
  (`table … ; delete table … ; table … { … }`), Regeln anderer Programme
  (Docker, Firewall) bleiben unberührt.
* **legacy-iptables** (Synology DSM: der Kernel spricht nur x_tables, `nft`
  scheitert – wie bei der Scan-Egress-Weiterleitung): eigene Kette `GC_EDGE`,
  per `iptables-restore --noflush` atomar ersetzt (letzte Regel `DROP`), Sprung
  aus `OUTPUT` mit `-m owner --uid-owner 61001`; dasselbe mit `ip6tables`.
  Fehlt `ip6tables`, ist das nur in Ordnung, wenn der Host gar kein IPv6 hat.
  Das statische `xtables-legacy-multi` im Image bringt den Owner-Match mit;
  der DSM-Kernel braucht das Modul `xt_owner`.

Automatisch: erst nftables, sonst legacy-iptables; danach bleibt das
funktionierende Backend zuerst dran. Erzwingen lässt es sich mit
`GC_FENCE_BACKEND=nft|iptables` in der Umgebung des Gateway-Containers.

Das Ergebnis schreibt der Gateway-Container nach `/run/gc-edge/fence.json`
(`active`, `backend`, `error`, `uid`, `appliedAt`, LAN-Subnetze, Server).
Der Edge-Host startet Plugin-Prozesse nur, wenn beides stimmt:

1. der Marker meldet aktive Regeln für UID 61001 und ist jünger als 3 Minuten;
2. eine **Probe** zeigt, dass die Regeln für den eigenen Prozess wirklich
   greifen: ein UDP-Datagramm an `192.0.2.1` (TEST-NET-1, nie ein privates
   LAN) muss mit `EPERM` abgewiesen werden; IPv6 muss ebenfalls zu sein.

Geprüft wird beim Start (bis die Regeln da sind alle 2 s) und dann alle 30 s.
Fällt die Grenze weg (Gateway-Container gestoppt, Regeln entfernt), stoppen
alle Edge-Teile (`denied`, `lastError: network_fence_inactive: <grund>`).
Die Regeln bleiben beim Stoppen des Gateways bestehen – sie schränken nur
UID 61001 ein. Entfernen von Hand: `nft delete table inet gc_edge` bzw.
`iptables -D OUTPUT -m owner --uid-owner 61001 -j GC_EDGE; iptables -F GC_EDGE; iptables -X GC_EDGE`.

Tests: `tests/edge_fence_rules.test.js` (Regeltext, Rückfall auf iptables,
fail closed) und `tests/live/edge-fence-live.js` gegen den echten Kernel in
einem eigenen Netz-Namespace (CI-Job `edge-fence`, beide Backends; lokal auch
im gebauten Image). Der isolierte Betrieb: `tests/edge_bridge.test.js`
(Prüfung im Gateway), `tests/edge_isolated_sockets.test.js` (der Edge-Host
öffnet keinen IP-Socket) und `tests/live/edge-isolated-live.js` (Edge-Host in
einem leeren Netz-Namespace, CI-Job `edge-isolated`).

## MQTT (lokaler Broker)

Dienst `mqtt`: `eclipse-mosquitto` (Tag + Digest gepinnt), Host-Netz, als UID
61001, `cap_drop: ALL`, `no-new-privileges`, read-only, `mem_limit 128m`. Ohne
MQTT im Sollzustand läuft dort nur ein kleiner Wächter (Shell-Schleife, ≈ 1 MB).

Schaltet der Server MQTT ein (`state.mqtt.enabled`), schreibt der
**Gateway-Container** (er liest den Sollzustand im Relay mit) die
Broker-Dateien nach `edge-mqtt-conf` (`/gc-mqtt-conf`, Dateien `0640`, Gruppe
61001). Der Edge-Container kommt an diese Dateien nicht heran – könnte er sie
schreiben, könnte er Mosquitto (Host-Netz) z. B. eine Bridge ins Internet oder
ein Plugin unterschieben. Der Wächter im `mqtt`-Container kopiert sie nach
`/gc-mqtt` (eigenes Volume `edge-mqtt`, `0600`, Besitzer 61001 – so warnt
Mosquitto nicht über fremde Besitzer); dorthin zeigen auch die Pfade in
`mosquitto.conf`. Alte Compose-Dateien: der Edge-Host schreibt direkt nach
`/gc-mqtt` (Edge im Host-Netz, hinter der Netzgrenze).

* `mosquitto.conf`: `listener 1883` **nur an den privaten LAN-Adressen** der
  physischen Schnittstellen plus `127.0.0.1` (für das interne Konto),
  `allow_anonymous false`, `password_file`, `acl_file`, Persistenz in
  `/gc-mqtt/data/`, Pakete ≤ 256 KB;
* `passwd`: die Konten aus `state.mqtt.accounts` (Hash im
  `mosquitto_passwd`-Format `$7$…`, vom Server erzeugt) plus das interne
  Konto `gc-edge` (zufälliges Passwort je Start; das Konto hält der
  Gateway-Container, bei alter Compose-Datei der Edge-Host);
* `acl`: je Konto die Themen aus dem `state`; das interne Konto darf nur die
  `pluginTopics` (plus Lesen von `$SYS/broker/clients/connected` und
  `$SYS/broker/log/N` für die Statusmeldung).

Der Wächter im `mqtt`-Container startet Mosquitto, sobald `enabled` und
`mosquitto.conf` da sind (vorher kopiert er die Dateien), startet neu, wenn sich `mosquitto.conf` ändert
(Listener lassen sich nicht per SIGHUP ändern, z. B. neue LAN-Adresse), und
schickt **SIGHUP**, wenn sich Konten oder ACL ändern (Datei `reload`).
`state.mqtt.enabled: false` → Datei `enabled` weg → Mosquitto wird beendet.

**TLS (vorbereitet):** mit `state.mqtt.tls: true` und den Dateien
`tls/server.crt` + `server.key` in der Ablage der Broker-Dateien kommt je
LAN-Adresse ein `listener 8883` dazu; fehlen sie, meldet der Status
`tls: "missing_cert"`. Zertifikate liefert der Server in v1 noch nicht (mit
der neuen Compose-Datei ist die Ablage ein tmpfs des Gateways, dort liegen
also keine).

**mDNS:** der Gateway-Container (alte Compose-Datei: der Edge-Host) kündigt den Broker als `_mqtt._tcp` (Instanz
„GateControl MQTT <hostname>“, Port 1883, A-Record der LAN-Adressen) auf der
primären LAN-Schnittstelle an (multicast-dns, verträgt sich mit Avahi auf dem
Pi). Avahi des Hosts wird nicht genutzt: aus dem Container gibt es keinen
D-Bus-Zugriff.

**Edge-Teile:** `gc.mqtt.subscribe(filter, fn)` / `gc.mqtt.publish(topic,
payload, {retain, qos})` laufen über das interne Konto (isoliert: per RPC über
den Gateway-Socket, geprüft im Gateway). Erlaubt ist nur, was
die Fähigkeit `mqtt.topics` des Plugins (Manifest ∩ Genehmigung) **und**
`state.mqtt.pluginTopics[<plugin>]` abdecken; ein Abo darf nicht breiter sein
als ein genehmigter Filter. QoS 0/1, höchstens 64 Abos je Plugin, Nutzlast ≤
256 KB. Endet ein Edge-Prozess, werden seine Abos aufgeräumt.

**Status:** `mqtt: { running, clients, tls, accounts: [{ user, connected,
lastSeen }] }` – `running` = internes Konto verbunden, `clients` ohne das
interne Konto (aus `$SYS`), `connected`/`lastSeen` aus den
Verbindungsmeldungen des Brokers (`$SYS/broker/log/N`).

## Edge-API für Plugin-Autoren

Der Edge-Teil ist ein CommonJS-Modul (`edge.entry`), das ein Objekt mit
`start(gc)`/`stop(gc)` exportiert (oder eine Funktion `(gc) => objekt`).

| Funktion | Fähigkeit | |
|---|---|---|
| `gc.handle(method, fn)` | – | Aufrufe des Servers (`gc.edge.call`) beantworten; `fn(params, gc)` → JSON (≤ 64 KB) |
| `gc.emit(name, data)` | – | Ereignis an den Server (≤ 50/s, gepuffert bis 1000 / 1 h) |
| `gc.config()`, `gc.onConfig(fn)` | – | Daten aus `gc.edge.configure` (nur im Speicher) |
| `gc.store.get/set/delete(key)` | – | JSON ≤ 1 MB je Plugin, Schlüssel `[A-Za-z0-9._:-]{1,128}` |
| `gc.log.info/warn/error(...)` | – | Logs an den Server (≤ 20/s, Zeile ≤ 2 KB); `console.*` ebenso |
| `gc.lan.udp.bind(port, {multicast}, onMessage)` | `udp.ports`, `udp.multicast` | → `{port, send(host, port, buf), close()}`; nur Absender aus dem LAN |
| `gc.lan.udp.send(host, port, buf)` | `udp` | einzelnes Datagramm (≤ 8 KB) von einem flüchtigen Port |
| `gc.lan.mdns.browse(service, onFound)` | `mdns.services` | `onFound({host, ip, port, service, txt})` → `{stop()}` |
| `gc.lan.tcp.connect(host, port)` | `tcp.lan` | Duplex-Stream |
| `gc.lan.http.request({method, url, headers, body, timeoutMs, pinSha256})` | `http.lan` | → `{status, headers, body, text(), json()}`; Antwort ≤ 5 MB, ≤ 30 s, keine Weiterleitungen; HTTPS siehe unten |
| `gc.lan.tlsFingerprint({host, port, timeoutMs})` | `http.lan` oder `tcp.lan` | nur TLS-Handshake (keine Daten) → `{sha256, subject, issuer, validTo, selfSigned}` des Leaf-Zertifikats; `port` Standard 443, `timeoutMs` Standard 10 s (1–30 s) |
| `gc.mqtt.subscribe(topic, fn)` / `gc.mqtt.publish(topic, payload, {retain, qos})` | `mqtt.topics` | lokaler Broker (siehe „MQTT“); ohne MQTT `not_enabled` |
| `gc.serial.open(name, {baudRate})` | `serial` | **noch nicht verfügbar** (`not_available`): serielle Geräte werden in v1 nicht in den Container gereicht |

Ziele von `gc.lan.*` sind nur **IPv4-Adressen** (keine Hostnamen – es gibt
keine DNS-Anfragen aus Plugin-Daten) in den privaten LAN-Subnetzen (RFC 1918) des
Gateways (dieselbe Schnittstellen-Logik wie LAN-Scan und Telemetrie: keine
WireGuard-, Docker- und VPN-Schnittstellen), nie die Tunnel-Adresse, nie der
Server, nie die Netzadresse; die Router-Adresse ist erlaubt. Multicast nur für
genehmigte Gruppen. IPv6 ist in v1 nicht vorgesehen.

**HTTPS zu LAN-Geräten** ist immer geprüft – einen Weg ohne
Zertifikatsprüfung gibt es nicht:

* Standard: volle Prüfung (Zertifikatskette und Name/IP-SAN).
* `pinSha256`: für die üblichen **selbstsignierten Geräte**. SHA-256 des
  Leaf-Zertifikats (64 Hex-Zeichen; auch mit `:`, Großbuchstaben oder
  `sha256:`-Präfix) – derselbe Mechanismus wie `backend_tls_fingerprint` der
  HTTPS-Routen (`src/proxy/tlsPin.js`). Der Pin ersetzt die Kettenprüfung;
  die Anfrage bekommt den Socket erst, wenn der Pin passt, sonst
  `tls_pin_mismatch` und kein Byte der Anfrage geht raus.

Ohne Pin scheitert ein selbstsigniertes Gerät mit `tls_error`. `insecure` gibt
es nicht (mehr): ein Aufruf mit `insecure: true` wird mit `denied` abgelehnt,
nie still ohne Prüfung ausgeführt.

**Trust on first use:** `gc.lan.tlsFingerprint({host, port})` macht nur den
TLS-Handshake (keine Anwendungsdaten, Socket danach zu) und liefert
`{sha256, subject, issuer, validTo, selfSigned}` des Leaf-Zertifikats
(`sha256` in der kanonischen Form, direkt als `pinSha256` verwendbar,
`validTo` ISO-8601). Der Edge-Teil zeigt das dem Admin (über den Server-Teil
des Plugins) und speichert den Wert nach Bestätigung, z. B. in `gc.store`.
Dieselben Ziele wie `gc.lan.http`/`gc.lan.tcp` (nur LAN-Adressen), Fähigkeit
`http.lan` oder `tcp.lan`.

**Zertifikat gewechselt:** Passt der Pin nicht mehr, trägt der Fehler
`tls_pin_mismatch` den neuen Fingerabdruck: `e.sha256` (was das Gerät jetzt
zeigt), `e.expectedSha256` (der Pin) und `e.certificate`
(`{sha256, subject, issuer, validTo, selfSigned}` oder `null`). Den neuen Wert
nie automatisch übernehmen – den Admin fragen.

```js
gc.handle('status', async () => {
  const pin = await gc.store.get('pin');
  if (!pin) return { needsTrust: await gc.lan.tlsFingerprint({ host: '192.168.1.20', port: 8443 }) };
  try {
    const r = await gc.lan.http.request({ url: 'https://192.168.1.20:8443/api/status', pinSha256: pin });
    return { status: r.json() };
  } catch (e) {
    if (e.code === 'tls_pin_mismatch') return { needsTrust: e.certificate || { sha256: e.sha256 }, pinMismatch: true };
    throw e;
  }
});
gc.handle('trust', async ({ sha256 }) => { await gc.store.set('pin', sha256); return {}; });
```

Fehler kommen als `Error` mit `code`: `denied` (Fähigkeit/Ziel), `busy`
(Grenze erreicht), `timeout`, `not_available`, `not_found`, `net_error`,
`too_large`, `bad_request`, `tls_error`, `tls_pin_mismatch`.

### Fähigkeiten (`edge.capabilities`)

Wirksam ist, was das Manifest verlangt **und** der Server im `state`
genehmigt (`caps`) – die Schnittmenge.

* `udp.ports`: 1024–65535, nie 5353 (dafür `mdns`), höchstens 16;
  `udp.multicast`: 224.0.0.0/4 ohne 224.0.0.0/24 (außer mDNS 224.0.0.251).
* `mdns.services`: `_name._tcp|_udp`, höchstens 16.
* `tcp.lan`, `http.lan`: `true`/`false`. `http` hat nur den Schlüssel `lan`;
  die frühere Fähigkeit `http.selfSigned` gibt es nicht mehr – ein Manifest
  oder `state` mit `selfSigned` wird abgelehnt (`bad_caps`, Edge-Teil
  `denied`). Selbstsignierte Geräte nur mit `pinSha256`.
* `mqtt.topics`: Filter ohne führendes `#`/`+`, ohne `$`-Themen, höchstens 16.
* `serial`: benannte Geräte (`zigbee`).

### Grenzen

Frame 64 KB · Aufruf-Timeout ≤ 30 s, höchstens 32 offene Aufrufe je Plugin ·
Ereignisse 50/s (darüber verworfen, `throttled` im Status) · Logs 20/s ·
gleichzeitige `gc.*`-Aufrufe 64 · UDP-Sockets 16, TCP-Verbindungen 32,
mDNS-Suchen 8 je Plugin · Speicher `memoryMb` (16–256, Standard 48).

## Telemetrie

Der Heartbeat des Gateways trägt `telemetry.edge`:

```json
{ "deployed": true, "error": null, "fence": { "active": false, "backend": null, "error": "…" },
  "mode": "isolated", "socket": { "listening": true, "relay": true, "rpc": true },
  "host": { "at": "…", "stale": false, "edge_host": "1.1.0", "connected": true, "edge_enabled": true,
            "host_rss_mb": 48.2,
            "plugins": [{ "id": "shelly", "version": "1.0.0", "state": "running", "rss_mb": 31.5, "restarts": 0 }],
            "mqtt": { "running": true, "clients": 3 }, "fence": { "active": true, "backend": "isolated" },
            "mode": "isolated", "isolation": { "active": true, "reason": null } } }
```

`null` = kein Edge-Dienst in der Compose-Datei. `mode` (ab Gateway 1.23.0) ist
die Betriebsart laut frischer Zusammenfassung des Edge-Hosts: `isolated` →
`fence` (die Netzgrenze des Gateways) ist ohne Bedeutung; `fence` + Grenze
nicht aktiv → der Server meldet „Compose-Datei veraltet“; `null` → keine
frische Zusammenfassung. Die Datei des Edge-Hosts gilt
als nicht vertrauenswürdig und wird begrenzt und geklemmt gelesen.

## Fehlersuche

```bash
docker compose logs -f edge                   # Edge-Host (JSON, LOG_LEVEL=debug für Plugin-Logs)
docker compose exec edge cat /run/gc-edge-status/status.json
docker compose logs edge | grep -E 'isolated|gateway socket'   # Betriebsart, Socket verbunden?
docker compose logs gateway | grep -E 'gateway socket|edge relay' # Socket offen, Relay zum Server
docker compose logs -f mqtt                   # Wächter + Mosquitto
# nur alte Compose-Datei (Edge im Host-Netz):
docker compose exec edge cat /run/gc-edge/fence.json
nft list table inet gc_edge                   # auf dem Host: Regeln (bzw. iptables -S GC_EDGE)
```

## Speicherbedarf (gemessen)

Docker-Test auf x86_64 (Node 20, Alpine), ein laufender Edge-Teil (UDP-Echo +
MQTT-Abo): Edge-Host VmRSS ≈ 55 MB, Plugin-Prozess VmRSS ≈ 46 MB (davon ein
großer Teil geteilte Seiten des Node-Binärs), Cgroup-Verbrauch des ganzen
Edge-Containers ≈ 20 MiB; Mosquitto ≈ 8 MB VmRSS / ≈ 3 MiB Cgroup; Wächter
ohne Broker ≈ 1 MB. Auf einem Pi (arm64) sind ähnliche Werte zu erwarten;
grob: Edge untätig ≈ 50 MB, je Edge-Teil ≈ 30–50 MB, Broker ≈ 5–10 MB.
