# Kameras im Heimnetz (Phase 3c, Schritt 4)

Kameras im Heimnetz (ONVIF/RTSP) in GateControl – ohne Hersteller-Cloud:
Standbilder, Live-Bild über GateControl, Clips bei Bewegung auf einem Speicher
am Gateway-Host (NAS). Der Server schaltet die Funktion pro Gateway über
`features.cameras` im Config-Pull (Gateway › Funktionen › „Geräte im
Heimnetz“ › „Kameras“). Bedienung, Rechte und Push macht das Plugin
„Tür & Kamera“ (`gatecontrol-door`) über die Host-API `gc.cameras`.
Capability `cameras`, Zustand in `telemetry.features.cameras`.

Dieser Vertrag gilt für Gateway, Server, Plugin und die Apps (die Apps nutzen
die API des Plugins, Abschnitt 8, und die Medien-Adressen des Servers,
Abschnitt 7).

## 0. Aufteilung und Wahl des Live-Wegs

| Teil | Wo | Warum |
|---|---|---|
| Suche (WS-Discovery), ONVIF (Geräteinfo, Profile, Stream-/Snapshot-Adressen, Ereignisse per PullPoint), RTSP `DESCRIBE`, Snapshot per HTTP (Digest/Basic) | Gateway-Prozess (Node) | Netzwerk-Protokolle ohne Rechenlast; das Gateway prüft jede Adresse selbst |
| Video: ein `ffmpeg` je aktiver Kamera, **nur Stream-Kopie** (kein Umkodieren) in einen HLS-Ring (fMP4, 2-s-Segmente, ≈ 30 s) + alle 5 s ein kleines Standbild (640 px, nur Schlüsselbilder dekodiert) | neuer Dienst `kameras` (eigener Container, keine Rechte) | ffmpeg liest fremde Videodaten – getrennt vom Gateway mit Tunnel/`NET_ADMIN`, eigene Grenzen (`cpu_shares`, `oom_score_adj`), das Gateway-Image bleibt klein |
| Live-Bild, Clips, Vorschaubilder | Gateway-Prozess liest den Ring aus dem gemeinsamen tmpfs und gibt ihn über die Management-API (Tunnel) heraus; Clips = Segmente aneinandergehängt (mit Vorlauf aus dem Ring) | keine zweite Verbindung zur Kamera, kein Umkodieren, kein offener Port im LAN |

**Live-Weg (Entscheidung):** HLS mit fMP4-Segmenten aus dem Ring, über den
Server (`/camera-media/<token>/index.m3u8`) zum Browser/zur App – Safari, iOS
und Android spielen HLS selbst. Für Browser ohne HLS (Firefox, ältere
Chrome-Versionen am PC) gibt es denselben Ring als fortlaufendes fMP4
(`…/live.mp4`), das jedes `<video>` abspielt. Kein WebRTC (bräuchte offene
UDP-Ports/ICE), kein MJPEG (bräuchte Umkodieren auf dem Gateway). Latenz
≈ 3–6 s. Das Live-Video gibt GateControl nur an Geräte **im VPN** (oder im
selben LAN wie der Server); ohne VPN zeigt die App alle 10 Sekunden ein neues
Standbild. H.265-Kameras: Safari/iOS spielen sie, andere Browser oft nicht →
Unterstrom (meist H.264) wählen.

Der Dienst `kameras` nutzt das Image `bluenviron/mediamtx:1.21.3-ffmpeg`
(gepinnt mit Digest; Alpine + das `ffmpeg`-Paket, amd64/arm64/armv7) **nur
für sein ffmpeg** – mediamtx selbst startet nicht. Sein Einstieg wartet auf
`/gc-cam/kameras.sh`, das das Gateway schreibt (`src/cameras/kameras.sh`),
und führt es aus: die Logik des Wächters kommt so mit jedem Gateway-Update,
die Compose-Datei bleibt gleich.

Ohne den Dienst (alte Compose-Datei) gehen Suche, Test, Standbilder per ONVIF
und Bewegungs-Ereignisse mit Vorschaubild; Live-Video, Clips und Standbilder
reiner RTSP-Kameras brauchen ihn (`service: missing` → Hinweis im Server).

## 1. Config-Pull `features.cameras`

```json
{ "enabled": true,
  "nobodyHome": false,
  "credRev": "9f2c4e1a0b3d5c7e",
  "subnets": ["192.168.20.0/24"],
  "cameras": [
    { "id": "c3f9a1b2c4d5e6f7", "name": "Einfahrt", "host": "192.168.1.73",
      "onvif": { "port": 8000, "path": "/onvif/device_service" },
      "rtsp": null,
      "profile": "MainStreamProfileToken", "stream": "main",
      "record": "motion", "events": ["person", "vehicle", "animal"],
      "retentionDays": 14, "audio": false, "codec": "h264" } ] }
```

* `enabled` – aus: alle ffmpeg-Läufe enden (Steuerdateien weg), keine Ereignisse,
  Mgmt antwortet `503 feature_disabled`; vorhandene Clips bleiben bis zur Aufbewahrungsfrist.
* `nobodyHome` – aus der Anwesenheit am Server (Familie, `gc.homeNetwork.presence`):
  `true` = alle bekannten Personen sind weg, `false` = jemand ist da, `null` = unbekannt.
  Der Server holt bei jeder Änderung den Config-Pull an.
* `credRev` – ändert sich, wenn sich irgendein Kamera-Zugang ändert → das Gateway
  holt die Zugänge neu (§ 2). Passwörter stehen **nie** im Config-Pull.
* `subnets` – höchstens 8 zusätzliche RFC-1918-Netze (CIDR, /16…/30), die das
  Gateway außer seinen eigenen LAN-Netzen ansprechen darf (z. B. ein Kamera-VLAN
  hinter dem Router). Standard leer.
* `cameras` – höchstens 16 je Gateway:
  * `id` `^c[0-9a-f]{15}$`, `name` ≤ 60 Zeichen.
  * `host` – nur RFC 1918 **und** in einem eigenen LAN-Netz des Gateways oder in `subnets`.
  * `onvif` `{ port 1…65535, path ^/[A-Za-z0-9._~/-]{0,127}$ }` oder `null`.
  * `rtsp` `{ port, path }` (Pfad mit Query, `^/[A-Za-z0-9._~/%&=?+:;,-]{0,255}$`) – fester
    RTSP-Pfad (Kamera ohne ONVIF oder vom Admin eingegeben); sonst `null` und das Gateway
    fragt ONVIF `GetStreamUri` für `profile`.
  * `profile` ONVIF-Profil-Token (`^[A-Za-z0-9._:-]{1,64}$`) oder `null` (= erstes bzw. bei
    `stream: "sub"` zweites Profil).
  * `record` – `motion` (Clips bei Bewegung) | `away` (nur wenn `nobodyHome === true`; bei
    `null` nimmt das Gateway **nicht** auf) | `never` (nur Live-Bild/Standbild).
  * `events` – Teilmenge von `person`, `vehicle`, `animal`, `motion`: welche Ereignisse einen
    Clip auslösen. `motion` = jede Bewegung (auch ohne Personen-/Fahrzeugerkennung der Kamera).
  * `retentionDays` 1…90 (UI: 7, 14, 30), `audio` (Ton im Ring und in Clips, Standard aus),
    `codec` `h264|h265|null` (aus dem Test, nur für den HLS-Tag).
* Fehlt `features.cameras` (älterer Server) → aus.

## 2. Gateway → Server

Alle mit dem Gateway-Token (`Authorization: Bearer …`), JSON.

| Route | Inhalt |
|---|---|
| `GET /api/v1/gateway/cameras/credentials` | → `{ rev, cameras: { "<id>": { "user": "admin", "password": "…" } } }` – nur Kameras dieses Gateways, `Cache-Control: no-store`. Das Gateway holt sie beim Start und wenn `credRev` wechselt; im Speicher und verschlüsselt in `/state/cameras-cred.bin` (0600, AES-256-GCM, Schlüssel per HKDF aus dem Gateway-Token), nie im Log. |
| `POST /api/v1/gateway/cameras/report` | `{ at, service, storage: { path, free, total, used, clips, problem }, cameras: [ { id, state, problem, events, kinds, codec, width, height, stream, snapshotAt, lastEventAt, info: { manufacturer, model, firmware } } ] }` – nach Änderungen (höchstens alle 30 s), sonst alle 5 Min. |
| `POST /api/v1/gateway/cameras/events` | `{ events: [ { id, cameraId, kind, kinds, phase, startedAt, endedAt, nobodyHome, clip: { ms, bytes } \| null, thumb } ] }` (≤ 32 je Aufruf) – `phase` `start` (sofort), `update` (Art wechselt, z. B. `motion` → `person`), `end` (mit Clip). Nicht angenommene Meldungen wiederholt das Gateway (≤ 200 im Speicher). |

* Kamera `state`: `ok` | `unreachable` | `auth_failed` | `not_allowed` (Adresse nicht erlaubt) |
  `no_stream` | `error`; `problem` ein Fehlercode oder `null`.
* `events`: `pullpoint` (ONVIF-Ereignisse laufen) | `unsupported` (Kamera bietet keine) |
  `off` (`record: never`) | `error`; `kinds` – was die Kamera meldet (`person`, `vehicle`, `animal`, `motion`).
* `stream`: `running` (ffmpeg läuft) | `idle` | `starting` | `error` | `service_missing`.
* `storage.problem`: `null` | `disk_low` (< 1 GB frei: keine neuen Clips) | `not_writable`.
* Ereignis `id` `^e[0-9a-f]{15}$`, `kind` die wichtigste Art (`person` > `vehicle` > `animal` > `motion`),
  Zeiten ISO, `clip.ms` Länge, `thumb` ob ein Vorschaubild da ist.

## 3. Server → Gateway (Management-API über den Tunnel, `X-Gateway-Token`)

| Route | Antwort |
|---|---|
| `POST /api/cameras/status {}` | 200 `{ cameras }` – frisch: Dienst, Speicher, Kameras (wie im Bericht), Suchergebnis |
| `POST /api/cameras/discover {}` | 200 `{ found: [ { host, port, path, manufacturer, model, name, hardware } ] }` – WS-Discovery (≈ 3 s) |
| `POST /api/cameras/probe { host, onvifPort?, onvifPath?, rtspUrl?, user, password }` | 200 `{ ok: true, source: onvif\|rtsp, info, profiles: [ { token, name, codec, width, height, rtsp: { port, path }, snapshot: bool } ], events: { supported, kinds }, codec, audio, snapshot: { data, mime } \| null }`; 400 `invalid_request`, 403 `not_allowed`, 401 `auth_failed`, 502 `unreachable` \| `not_onvif` \| `no_stream` |
| `POST /api/cameras/snapshot { id, maxBytes? }` | 200 `image/jpeg` (neuestes Bild ≤ `maxBytes`, Standard 4 MB; `X-Snapshot-At`); 404 `unknown_camera`, 409 `not_ready`, 502 `unreachable` \| `auth_failed` |
| `POST /api/cameras/live { id }` | 200 `{ ready, codec, audio }` – hält den Ring für 60 s wach (jeder Abruf unten verlängert) |
| `GET /api/cameras/<id>/live/index.m3u8` | HLS-Liste (Segment-Namen relativ: `init.mp4`, `s<n>.m4s`); 409 `not_ready` |
| `GET /api/cameras/<id>/live/<file>` | `init.mp4` \| `s<n>.m4s` (`video/mp4`, `video/iso.segment`) |
| `GET /api/cameras/<id>/live.mp4?s=<sek>` | fortlaufendes fMP4 (Zeitstempel ab 0), endet nach `s` (≤ 600, Standard 300) Sekunden |
| `GET /api/cameras/events/<eventId>/clip.mp4` | der Clip (`video/mp4`, Range) |
| `GET /api/cameras/events/<eventId>/thumb.jpg` | das Vorschaubild |
| `POST /api/cameras/events/delete { ids }` | 200 `{ deleted }` (≤ 100 Ids) |

`<id>` `^c[0-9a-f]{15}$`, `<eventId>` `^e[0-9a-f]{15}$`. Mgmt-Körper ≤ 16 KB.

## 4. Regeln auf dem Gateway

* **Nur eigene Geräte:** verbunden wird nur mit RFC-1918-Adressen in einem eigenen
  LAN-Netz oder in `subnets`. Adressen aus ONVIF-Antworten (`XAddr`, Stream-/
  Snapshot-/Ereignis-Adressen) werden **nur mit Port und Pfad** übernommen, der Host ist
  immer die Adresse der Kamera. Keine Weiterleitungen (3xx = Fehler), kein Proxy, nur
  `http:`/`rtsp:` (kein TLS-Pfad in dieser Fassung).
* **Grenzen:** SOAP-Antwort ≤ 256 KB, RTSP `DESCRIBE` ≤ 64 KB, Snapshot ≤ 4 MB,
  Verbindung 4 s, Antwort 10 s (PullMessages: Zeitlimit + 10 s), WS-Discovery-Antwort
  ≤ 64 KB, höchstens 64 Antworten.
* **WS-Discovery:** je LAN-Adresse ein UDP-Socket auf `0.0.0.0` (zufälliger Port), Ausgang
  per `setMulticastInterface(<LAN-Adresse>)`, Mitglied in `239.255.255.250` auf genau dieser
  Schnittstelle; Probe nach `239.255.255.250:3702` (`dn:NetworkVideoTransmitter`), Antworten
  kommen per Unicast an den Absender-Port (einige Kameras schicken sie per Multicast – das
  Mitglied hört sie). **Nie** an die Unicast-Adresse binden: ein so gebundener Socket bekommt
  unter Linux keine Multicast-Pakete. Antworten nur von Adressen in eigenen Netzen.
* **Anmeldung:** ONVIF per WS-UsernameToken (PasswordDigest, Uhrzeit-Abgleich über
  `GetSystemDateAndTime`), bei 401 zusätzlich HTTP-Digest (MD5/SHA-256, `qop=auth`).
  Snapshot: Digest, Basic nur wenn die Kamera nur Basic anbietet. RTSP: Digest/Basic.
* **Zugänge:** nur im Speicher und in `/state/cameras-cred.bin` (0600, verschlüsselt); an
  ffmpeg gehen sie in der RTSP-Adresse über die Steuerdatei im tmpfs (0600) – sichtbar nur
  im Container `kameras` (Prozessliste) und für root am Host. Nie im Log, nie in der Telemetrie.
* **Ereignisse:** ONVIF PullPoint (`CreatePullPointSubscription`, `PullMessages` mit 10 s,
  `Renew` jede Minute, bei Fehler neu nach 30 s … 5 Min.). Themen/Werte → Art:
  `People|Person|Human|Face` → `person`, `Vehicle|Car` → `vehicle`, `Animal|Pet|Dog|Cat` →
  `animal`, `Motion|CellMotion` → `motion` (Wert `true`/`1` = aktiv). Keine eigene
  Bildanalyse auf dem Gateway.
* **Clips:** bei einem passenden Ereignis (Art in `events`, `record` erlaubt es) ab 5 s vor
  dem Ereignis bis 10 s nach dem Ende, höchstens 120 s; Segmente des Rings aneinandergehängt
  (Zeitstempel ab 0, Dauer im `mehd`), kein Umkodieren. Ablage
  `/recordings/<cameraId>/<YYYY-MM-DD>/<eventId>.{mp4,jpg,json}`; stündlich Aufräumen nach
  `retentionDays`; unter 1 GB frei keine neuen Clips (`disk_low`). Ein Ereignis ohne Clip
  (`record: never`, Dienst fehlt) wird trotzdem gemeldet (mit Vorschaubild, wenn möglich).
* **ffmpeg läuft** für eine Kamera, solange (a) sie aufnehmen darf (`motion`, oder `away` und
  niemand zu Hause), (b) jemand live schaut (≤ 60 s nach dem letzten Abruf) oder (c) ein
  Standbild gebraucht wird und die Kamera keine ONVIF-Snapshot-Adresse hat (≤ 60 s).
* **Standbild:** frisches `snap.jpg` aus dem Ring (≤ 15 s), sonst ONVIF `GetSnapshotUri`, sonst
  den Ring starten und ≤ 10 s warten.

## 5. Der Dienst `kameras`

* tmpfs-Volume `cam-ctl` (`/gc-cam`, 256 MB, root 0700) zwischen Gateway und Dienst:
  `kameras.sh` (Wächter, vom Gateway), `run/<id>.env` (Auftrag je Kamera, 0600:
  `URL=rtsp://…`, `AUDIO=0|1`, `VTAG=hvc1|`), `media/<id>/` (Ring: `index.m3u8`,
  `init.mp4`, `s<n>.m4s`, `snap.jpg`), `state/<id>` (`running|exit|wait <Unix-Sekunden>`),
  `kameras.state` (`alive <Unix-Sekunden>`, alle 2 s).
* Der Wächter startet je `run/*.env` ein ffmpeg (geänderte Datei → neu, abgestürzt → nach
  10 s neu, Datei weg → beendet und Ring gelöscht) und startet sich selbst neu, wenn das
  Gateway `kameras.sh` ändert.
* `user: "0:0"`, `cap_drop: ALL`, `no-new-privileges`, `read_only`, `network_mode: host`
  (die Kameras sind im LAN), **kein Port**, `cpu_shares: 512`, `oom_score_adj: 500`,
  `mem_limit: 768m`, `pids_limit: 64`.
* Speicher für Clips: `${GC_CAMERA_DIR:-cam-recordings}:/recordings` am **Gateway**-Dienst
  (benanntes Volume; mit `GC_CAMERA_DIR=/volume1/kameras` in `.env` ein Ordner der NAS).
* `docker-compose.example.yml`: Dienst im Profil `kameras`; die Compose-Datei aus GateControl
  enthält ihn ohne Profil, sobald Kameras für das Gateway eingeschaltet sind.
* Raspberry-Pi-Image: `kameras` ohne Profil; `gatecontrol-start` nimmt den Dienst mit, wenn
  `gateway-state/cameras.json` `"want":true` sagt; wird die Funktion eingeschaltet, während
  der Container fehlt, legt das Gateway `gateway-state/cameras-start` an →
  `gatecontrol-cameras.path` → `docker compose up -d --no-deps kameras`.
* `service` in Telemetrie und Status: `managed` (Wächter lebt), `absent` (Volume da, Container
  fehlt/steht), `missing` (kein `/gc-cam` – alte Compose-Datei).

## 6. Telemetrie `features.cameras` (klein)

```json
{ "enabled": true, "service": "managed", "state": "running", "cameras": 2, "recording": 1,
  "live": 0, "storage": { "free": 1320000000000, "total": 3900000000000, "problem": null },
  "host": { "cores": 4, "memTotal": 16641478656, "arch": "x64" }, "error": null }
```

`state`: `off` | `service_missing` | `running` | `error`. Hinweis am Server (nie ein Verbot):
Raspberry Pi 3 B+/3/Zero → „höchstens 1 Kamera mit Bewegungserkennung“, Pi 4 → höchstens 4.

## 7. Server

* **Speicher:** Tabelle `home_cameras` (Gateway, Name, Adresse, ONVIF/RTSP, Profil,
  Einstellungen, Benutzer, Passwort **verschlüsselt** mit dem Server-Schlüssel wie die
  anderen Geheimnisse, letzter Bericht) und `home_camera_events` (Ereignisse, Clip-Daten –
  die Clips selbst bleiben auf dem Gateway). Ereignisse älter als die Aufbewahrung verlieren
  den Clip, nach 90 Tagen sind sie weg.
* **Schalter:** `gateway_features.settings.cameras { enabled, subnets }`
  (`PUT /api/v1/gateways/:id/features { cameras: { enabled, subnets } }`), Zeile „Kameras“
  in „Geräte im Heimnetz“ (≈ Speicher, „n Kameras eingebunden“, Weg ins Plugin).
* **Admin-API** (Admin-Sitzung): `GET /api/v1/gateways/:id/cameras` → `{ cameras, storage,
  service, hints }` (live vom Gateway).
* **Medien** `GET /camera-media/<token>/<datei>` (ohne Anmeldung; das Token ist die
  Berechtigung, HMAC-SHA256 mit einem Server-Schlüssel, an Plugin, Kamera/Ereignis und Art
  gebunden): `snapshot.jpg` (Token 10 Min.), `index.m3u8`, `init.mp4`, `s<n>.m4s`, `live.mp4`
  (Live-Token 10 Min., nur über VPN/LAN ausgegeben), `clip.mp4` (Range), `thumb.jpg` (Token
  1 h). `Cache-Control: no-store` (Vorschaubilder: `private, max-age=3600`), `X-Content-Type-Options:
  nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, ≤ 600 Abrufe je Minute und Adresse.
  Plugin-Frames mit `permissions.cameras` dürfen sie laden (`img-src`/`media-src
  <origin>/camera-media/`).
* **Host-API `gc.cameras`** (`permissions.cameras`, Installationsdialog „Kameras im Heimnetz“):

| Aufruf | Antwort |
|---|---|
| `available()` | `{ available, gateways: [ { id, name, online, supported, enabled, service, storage, hint } ] }` |
| `list()` | `[ { id, gatewayId, gateway, name, host, source, manufacturer, model, state, online, codec, width, height, events: { supported, kinds }, settings, snapshotAt, lastEventAt } ]` |
| `discover({ gatewayId? })` | `{ found: [ { gatewayId, gateway, host, port, path, manufacturer, model, name, cameraId } ] }` |
| `test({ gatewayId, host, onvifPort?, onvifPath?, rtspUrl?, user, password })` | wie Mgmt `probe` (ohne Zugang) |
| `add({ gatewayId, name, host, onvifPort?, onvifPath?, rtspUrl?, profile?, user, password, settings? })` | `{ camera, snapshot }` – testet zuerst, speichert nur bei Erfolg |
| `update(id, { name?, user?, password?, profile?, settings? })` | Kamera |
| `remove(id, { deleteClips? })` | `{ removed }` |
| `snapshot(id, { maxBytes? })` | `{ data, mime, at }` (Standard ≤ 300 KB – passt für `gc.notify` `image`) |
| `snapshotUrl(id)` | `{ url, expiresAt }` |
| `live(id, req)` | `{ mode: 'live', hls, mp4, snapshot, codec, audio, expiresAt }` im VPN/LAN, sonst `{ mode: 'snapshot', snapshot, every: 10, reason: 'vpn_required' }` |
| `events({ cameraId?, since?, until?, kinds?, limit? })` | `[ { id, cameraId, camera, kind, kinds, startedAt, endedAt, nobodyHome, clip, thumbUrl, clipUrl } ]` (neueste zuerst, ≤ 200) |
| `deleteEvent(id)` | `{ deleted }` (auch der Clip auf dem Gateway) |
| `on(handler)` | Hook `cameraEvent`: `{ id, cameraId, camera, gatewayId, kind, kinds, phase, at, nobodyHome, clip }` |

`settings`: `{ record: motion|away|never, events: [...], retentionDays, stream: main|sub,
audio }`. Fehler: `ERR_CAMERAS_DENIED`, `ERR_INVALID`, `ERR_NOT_FOUND`, `ERR_CAMERA_OFFLINE`
(Gateway nicht erreichbar), `ERR_CAMERA_UNSUPPORTED` (Gateway zu alt / Funktion aus),
`ERR_CAMERA_AUTH`, `ERR_CAMERA_UNREACHABLE`, `ERR_CAMERA_NOT_ALLOWED`, `ERR_CAMERA_LIMIT`
(16 je Gateway). Rechte (wer welche Kamera sieht) prüft das Plugin.

## 8. Plugin „Tür & Kamera“ und Apps

Personen-API des Plugins (Portal, Apps über `/api/v1/client/plugins/gatecontrol-door/api/…`):

| Route | Antwort |
|---|---|
| `GET cameras` | `{ available, minGatecontrol, cameras: [ { id, kind: 'home'\|'ring', name, online, snapshotUrl, live: bool } ] }` |
| `GET cameras/<id>/live` | wie `gc.cameras.live` (Heimnetz-Kameras; Ring: Standbild) |
| `GET cameras/<id>/snapshot` | `{ url, at }` |
| `GET cameras/<id>/clips?day=YYYY-MM-DD` | `{ clips: [ { id, kind, startedAt, ms, thumbUrl, clipUrl } ] }` |

Push: Thema `kamera` („Personen an der Kamera“), mit Standbild, höchstens einmal pro Kamera
alle 5 Minuten; Text „Person an der Einfahrt“, mit „Niemand ist zu Hause“, wenn niemand da ist.
Eine App öffnet `snapshotUrl`/`hls`/`mp4` auf dem eigenen Server (relative Pfade); ohne VPN
alle 10 s ein neues `snapshotUrl` (Token gilt 10 Min., `?t=<n>` gegen Zwischenspeicher).
