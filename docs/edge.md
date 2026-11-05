# Edge-Container: Plugin-Teile im Heimnetz

Manche Plugins brauchen Zugriff auf Geräte im Heimnetz, den der Server nicht
hat: UDP-Broadcasts und Multicast (CoAP, Shelly, Hue), mDNS, kurze TCP- und
HTTP-Verbindungen zu LAN-Geräten. Dafür kann ein Plugin einen **Edge-Teil**
mitbringen, der auf dem Gateway läuft – in einem eigenen, abgeschotteten
Container `edge`, nie im Gateway-Container selbst.

Der Vertrag zwischen Gateway und Server (Kanal, Nachrichten, Pakete, Grenzen)
ist im Konzept „Phase 2“ festgelegt; dieses Dokument beschreibt die
Gateway-Seite.

```
GateControl-Server ──WebSocket gc-edge.v1──▶ Edge-Host (Container edge, UID 61001)
                                               ├─ Plugin-Prozess A (Permission-Model)
                                               └─ Plugin-Prozess B
Gateway-Container (root, NET_ADMIN) ──/run/gc-edge──▶ Zugangsdaten + Netzgrenzen-Marker
```

## Container und Image

| | |
|---|---|
| Image | **dasselbe Image** wie das Gateway (`ghcr.io/callmetechie/gatecontrol-gateway`), anderer Befehl: `/sbin/tini -- node src/edge/main.js` |
| Benutzer | `gcedge`, **UID/GID 61001** (fest im Image angelegt) |
| Rechte | `cap_drop: ALL`, keine `cap_add`, `no-new-privileges`, `read_only`, `/tmp` als tmpfs (16 MB), `mem_limit: 512m`, `pids_limit: 256` |
| Netz | `network_mode: host` (Broadcast/Multicast/mDNS brauchen die echten LAN-Schnittstellen) |
| Volumes | `edge-state` → `/state-edge` (Pakete, `gc.store`), `edge-run` → `/run/gc-edge` (nur lesen), `edge-status` → `/run/gc-edge-status` |

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
  `CAP_CHOWN`/`CAP_DAC_OVERRIDE`) schreibt dort `credentials` und den Marker
  der Netzgrenze; das setgid-Bit gibt jeder Datei die Gruppe 61001. Der
  Edge-Container hängt das Volume nur lesend ein – er kann die Dateien lesen,
  aber weder ändern noch fälschen.
* `edge-status` ist ein tmpfs-Volume des Edge-Benutzers (`uid=61001`); der
  Edge-Host schreibt dort seine Zusammenfassung, der Gateway-Container liest
  sie (nur lesend eingehängt) für die Telemetrie.
* `edge-state` ist ein normales Volume; ein neues Volume übernimmt Besitzer
  und Rechte von `/state-edge` aus dem Image (61001, `0700`).

Beide tmpfs-Volumes werden mit `nocopy` eingehängt, damit Docker die
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
* Der Edge-Container bekommt nicht die `gateway.env`, sondern vom
  Gateway-Container nur `/run/gc-edge/credentials` (JSON: `serverUrl`,
  `apiToken`, `serverAddrs`, `tunnelIp`; `0440 root:61001`). Ändert sich der
  Inhalt (neues Token, neue Server-Adresse), verbindet der Edge-Host neu.
* Der Edge-Container löst keine Namen auf. Der Gateway-Container trägt die
  Adressen von `serverUrl` in `serverAddrs` ein; der Edge-Host verbindet genau
  dorthin (TLS prüft weiterhin den Namen), und genau diese Adressen gibt die
  Netzgrenze frei.
* Ping alle 20 s, Abbruch nach 60 s ohne Lebenszeichen, Wiederverbindung mit
  Backoff 1 s … 60 s (±20 % Zufall). HTTP 404/426/501 (Server ohne Edge) →
  alle 10 min, 401/403 (Token abgelehnt) → alle 5 min.
* Nach dem Verbinden: `hello` (Gateway-Version, Edge-Host-Version,
  MQTT-Verfügbarkeit, Netzgrenze, Hardware-Profil), der Server antwortet mit
  dem vollständigen Sollzustand `state`. Danach sendet der Edge-Host noch
  unbestätigte Ereignisse erneut.
* `status` bei jeder Änderung (gebündelt, 1 s) und alle 30 s.

## Sollzustand und Pakete

Der `state` wird vollständig geprüft, bevor etwas davon gilt (ungültig →
verworfen, nichts ändert sich). Für jedes gewollte Plugin:

1. Paket `GET …/api/v1/gateway/edge/packages/<id>/<version>` (≤ 20 MB) holen,
   **SHA-256** gegen den `state` prüfen.
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
  Anfrage per IPC, **der Edge-Host führt sie aus** und prüft dabei zentral
  Fähigkeiten und LAN-Grenzen.
* Neustart nach Absturz mit Backoff 1 s, 2 s, 5 s, 15 s, 30 s, 60 s, 5 min
  (nach 10 min stabilem Lauf wieder von vorn); ein Prozess, der 75 s nicht auf
  Pings antwortet, wird beendet und neu gestartet.

Das Permission-Model hat auf Node 20/22 keine Netzwerk-Sperre; die
JavaScript-Sperre ist Verteidigung in der Tiefe. Die eigentliche Grenze nach
außen ist die **Netzgrenze** des Gateway-Containers (nächster Abschnitt) –
ohne sie startet kein Edge-Teil.

## Netzgrenze (fail closed)

Der Edge-Host startet Plugin-Prozesse nur, wenn beides stimmt:

1. `/run/gc-edge/fence.json` (vom Gateway-Container geschrieben) meldet aktive
   Regeln für UID 61001 und ist jünger als 3 Minuten;
2. eine **Probe** zeigt, dass die Regeln für den eigenen Prozess wirklich
   greifen: ein UDP-Datagramm an `192.0.2.1` (TEST-NET-1, nie LAN) muss mit
   `EPERM` abgewiesen werden; IPv6 muss ebenfalls zu sein.

Geprüft wird beim Start und alle 30 s. Fällt die Grenze weg, stoppen alle
Edge-Teile (`denied`, `lastError: network_fence_inactive: <grund>`).

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
| `gc.lan.http.request({method, url, headers, body, timeoutMs, pinSha256, insecure})` | `http.lan` | → `{status, headers, body, text(), json()}`; Antwort ≤ 5 MB, ≤ 30 s, keine Weiterleitungen; HTTPS siehe unten |
| `gc.mqtt.subscribe(topic, fn)` / `gc.mqtt.publish(topic, payload, {retain, qos})` | `mqtt.topics` | lokaler Broker (Dienst `mqtt`); ohne Broker `not_enabled` |
| `gc.serial.open(name, {baudRate})` | `serial` | **noch nicht verfügbar** (`not_available`): serielle Geräte werden in v1 nicht in den Container gereicht |

Ziele von `gc.lan.*` sind nur **IPv4-Adressen** (keine Hostnamen – es gibt
keine DNS-Anfragen aus Plugin-Daten) in den LAN-Subnetzen des Gateways
(dieselbe Schnittstellen-Logik wie LAN-Scan und Telemetrie: keine
WireGuard-, Docker- und VPN-Schnittstellen), nie die Tunnel-Adresse, nie der
Server, nie die Netzadresse; die Router-Adresse ist erlaubt. Multicast nur für
genehmigte Gruppen. IPv6 ist in v1 nicht vorgesehen.

**HTTPS zu LAN-Geräten** ist standardmäßig voll geprüft (Zertifikatskette und
Name/IP-SAN). Für die üblichen selbstsignierten Geräte gibt es zwei Wege:

* `pinSha256`: SHA-256 des Leaf-Zertifikats (64 Hex-Zeichen; auch mit `:`,
  Großbuchstaben oder `sha256:`-Präfix) – derselbe Mechanismus wie
  `backend_tls_fingerprint` der HTTPS-Routen (`src/proxy/tlsPin.js`). Dann
  ersetzt der Pin die Kettenprüfung; die Anfrage bekommt den Socket erst, wenn
  der Pin passt (sonst `tls_pin_mismatch`, kein Byte der Anfrage geht raus).
* `insecure: true`: keine Prüfung – nur, wenn das Manifest die Fähigkeit
  `http: { "lan": true, "selfSigned": true }` verlangt **und** der Admin sie
  genehmigt hat; sonst `denied`.

Ohne beides scheitert ein selbstsigniertes Gerät mit `tls_error`.

Fehler kommen als `Error` mit `code`: `denied` (Fähigkeit/Ziel), `busy`
(Grenze erreicht), `timeout`, `not_available`, `not_found`, `net_error`,
`too_large`, `bad_request`, `tls_error`, `tls_pin_mismatch`.

### Fähigkeiten (`edge.capabilities`)

Wirksam ist, was das Manifest verlangt **und** der Server im `state`
genehmigt (`caps`) – die Schnittmenge.

* `udp.ports`: 1024–65535, nie 5353 (dafür `mdns`), höchstens 16;
  `udp.multicast`: 224.0.0.0/4 ohne 224.0.0.0/24 (außer mDNS 224.0.0.251).
* `mdns.services`: `_name._tcp|_udp`, höchstens 16.
* `tcp.lan`, `http.lan`: `true`/`false`; `http.selfSigned`: `true` erlaubt
  HTTPS ohne Zertifikatsprüfung (`insecure: true`), nur mit Admin-Freigabe.
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
{ "deployed": true, "error": null,
  "host": { "at": "…", "stale": false, "edge_host": "1.0.0", "connected": true, "edge_enabled": true,
            "host_rss_mb": 48.2,
            "plugins": [{ "id": "shelly", "version": "1.0.0", "state": "running", "rss_mb": 31.5, "restarts": 0 }],
            "mqtt": { "running": true, "clients": 3 }, "fence": { "active": true, "backend": "nft" } } }
```

`null` = kein Edge-Dienst in der Compose-Datei. Die Datei des Edge-Hosts gilt
als nicht vertrauenswürdig und wird begrenzt und geklemmt gelesen.

## Fehlersuche

```bash
docker compose logs -f edge                   # Edge-Host (JSON, LOG_LEVEL=debug für Plugin-Logs)
docker compose exec edge cat /run/gc-edge-status/status.json
docker compose exec edge cat /run/gc-edge/fence.json
```
