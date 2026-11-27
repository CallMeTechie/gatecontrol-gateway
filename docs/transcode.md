# Videos umwandeln (Dienst `umwandeln`)

Videos, die nicht auf jedem Gerät laufen – vor allem H.264 mit 10 Bit –, wandelt
der Gateway-Host (NAS) per Grafik-Hardware in **H.264 High, 8 Bit** um. Ton,
Untertitel, Kapitel und Anhänge (Schriften) werden unverändert kopiert, der
Container bleibt MKV. Die neue Datei ersetzt das Original unter demselben
Namen; das Original liegt bis zum Ablauf der Frist im Ordner `.gc-papierkorb`
derselben Freigabe und lässt sich zurückholen.

Der Server schaltet die Funktion pro Gateway über `features.transcode` im
Config-Pull. Welche Dateien umgewandelt werden, wann (Zeitfenster) und in
welcher Reihenfolge, entscheidet das Medien-Plugin auf dem Server; das Gateway
führt aus, prüft und meldet. Capability `transcode` (Heartbeat und `hello`),
Zustand in `telemetry.features.transcode`.

Dieser Vertrag gilt für Gateway, Server und Plugin.

## 0. Aufteilung

| Teil | Wo | Warum |
|---|---|---|
| Auftrag annehmen, Schreibweise des Pfads prüfen, Warteschlange (übersteht Neustart), Fortschritt und Befund melden | Gateway-Prozess (Node, `src/transcode/`) | Er hat den Tunnel zum Server. Er sieht die Medien **nicht** (kein Mount) und startet kein ffmpeg. |
| ffprobe, ffmpeg, Prüfung der neuen Datei, Tausch, Papierkorb | neuer Dienst `umwandeln` (eigener Container) | ffmpeg liest fremde Videodateien. Der Dienst hat kein Netz, keine Capabilities, läuft nicht als root und kann nur in die eingehängten Medienordner schreiben. |
| Welche Dateien, Reihenfolge, Zeitfenster (nachts), „anhalten, solange jemand schaut“, Jellyfin neu einlesen | Server / Medien-Plugin | Nur dort sind Jellyfin, die Geräte und die Einstellungen des Admins bekannt. |

Zwischen Gateway und Dienst gibt es **keinen Socket und keinen Port**: Aufträge
sind kleine Dateien im gemeinsamen tmpfs-Volume `umw-ctl` – dasselbe Muster wie
bei `kameras` und `office`. Die Logik des Dienstes (`src/transcode/umwandeln.sh`)
legt das Gateway in dieses Volume; sie kommt so mit jedem Gateway-Update, das
Image enthält nur ffmpeg.

## 1. Config-Pull `features.transcode`

```json
{ "enabled": true,
  "roots": ["/volume2/mediathek"],
  "software": false,
  "trashDays": 14,
  "quality": 23,
  "verifyDecode": true,
  "minFreeGb": 20,
  "minFreePct": 5 }
```

| Feld | Bedeutung | Standard |
|---|---|---|
| `enabled` | Funktion an | `false` (fehlt `features.transcode`: aus) |
| `roots` | Medienordner, in denen umgewandelt werden darf: absolute Pfade, **dieselben** wie im Dienst eingehängt (innen = außen), höchstens 8, keiner in einem anderen, kein `:` im Pfad | `[]` |
| `software` | Umwandeln ohne Grafik (libx264) erlaubt. Ohne diese Erlaubnis endet ein Auftrag ohne Hardware mit `no_device` / `no_encoder`. | `false` |
| `trashDays` | Frist des Papierkorbs in Tagen (1…365) | `14` |
| `quality` | Qualitätsziel (ICQ/QVBR `global_quality`, Software: `crf`), 16…32, kleiner = besser/größer | `23` |
| `verifyDecode` | neue Datei vor dem Tausch einmal ganz dekodieren | `true` |
| `minFreeGb`, `minFreePct` | so viel bleibt nach dem Umwandeln auf dem Volume frei | `20`, `5` |

Ungültige Werte werden durch den Standard ersetzt, ungültige Wurzeln fallen weg.

## 2. Gateway → Server

`POST /api/v1/gateway/transcode/report` (Gateway-Token als Bearer, wie die anderen
Berichte) – bei jeder Zustandsänderung eines Auftrags, während des Umwandelns
höchstens alle 10 s (Fortschritt), nach Fehlern frühestens nach 60 s (bei `404`
eines älteren Servers nach 10 Min.). Der Inhalt ist derselbe wie die Antwort von
`/api/transcode/status` (§ 3); `trash` ist nur dabei, wenn sich der Papierkorb
seit dem letzten angenommenen Bericht geändert hat.

## 3. Server → Gateway (Management-API über den Tunnel, `X-Gateway-Token`)

Alles `POST`, JSON, höchstens 600 Aufrufe je Minute (`429 rate_limited`).
Fehler: `{ "error": "<code>" }` (§ 7).

| Aufruf | Body | Antwort |
|---|---|---|
| `/api/transcode/status` | `{}` | `200` Zustand (unten) |
| `/api/transcode/probe` | `{ path }` | `200 { path, source: {…}, freeKb }` – ffprobe-Befund einer Datei (für die Liste; auch MP4, AVI …), wartet bis 30 s |
| `/api/transcode/submit` | `{ id, path, software?, quality? }` | `202 { job }` – Auftrag in die Warteschlange. `id`: vom Server vergeben, `[A-Za-z0-9_-]{8,64}`. Dieselbe `id` mit demselben Pfad noch einmal ist kein Fehler. `software: false` verbietet den Software-Weg für diesen Auftrag (erlauben kann ihn nur `features.transcode.software`). |
| `/api/transcode/cancel` | `{ id }` | `200 { job }` – wartend: sofort `cancelled`; laufend: ffmpeg wird beendet, die Zwischendatei gelöscht. War der Tausch schon geschehen, bleibt der Auftrag `done`. |
| `/api/transcode/pause` | `{ id }` oder `{ ttlSec? }` | `200 { pause }` – mit `id`: dieser Auftrag, bis `resume`. Ohne `id`: **alles** für `ttlSec` Sekunden (10…86400, Standard 900) – für „jemand schaut gerade“; der Server erneuert den Aufruf, solange das gilt. Bleibt er aus, läuft es von selbst weiter. |
| `/api/transcode/resume` | `{ id }` oder `{}` | `200 { pause }` |
| `/api/transcode/ack` | `{ ids: [] }` | `200 { removed }` – erledigte Aufträge vergessen (sonst nach 7 Tagen, höchstens 200) |
| `/api/transcode/restore` | `{ id }` | `200 { id, restored }` – Original des Auftrags `id` aus dem Papierkorb zurück an seinen Ort; die neue Datei wird dabei ersetzt |
| `/api/transcode/purge` | `{ id }` oder `{ all: true }` | `200 { purged: true }` – Original(e) endgültig löschen |

Zustand (`status`, Bericht):

```json
{ "at": "2026-11-27T02:14:08.000Z", "enabled": true, "service": "managed", "state": "running",
  "caps": { "at": "2026-11-26T19:02:11.000Z", "ffmpeg": "8.1.3-Jellyfin", "uid": 1034, "groups": [100, 61002, 937],
    "device": "ok", "devicePath": "/dev/dri/renderD128", "deviceGid": 937, "deviceMode": "660",
    "driver": "Intel iHD driver for Intel(R) Gen Graphics - 26.3.5 (1b5e662)", "vaH264Enc": true,
    "encoders": ["vaapi_icq", "vaapi_qvbr"], "software": true },
  "roots": [ { "path": "/volume2/mediathek", "state": "ok", "free": 1932735283200, "total": 3900000000000 } ],
  "settings": { "software": false, "trashDays": 14, "quality": 23, "verifyDecode": true, "minFreeGb": 20, "minFreePct": 5 },
  "pause": { "all": false, "until": null },
  "jobs": [
    { "id": "k3J9x2Qw8LmN", "path": "/volume2/mediathek/Serie A/Staffel 1/Folge 01.mkv",
      "state": "running", "error": null, "percent": 41, "fps": 78.3, "speed": 3.14, "paused": false, "software": false,
      "submittedAt": "2026-11-27T01:00:02.000Z", "startedAt": "2026-11-27T02:11:40.000Z", "finishedAt": null, "result": null } ],
  "trash": [
    { "id": "Zp40aa71Bc2d", "at": "2026-11-26T02:31:10.000Z", "size": 812000000,
      "expiresAt": "2026-12-10T02:31:10.000Z", "path": "/volume2/mediathek/Serie A/Staffel 1/Folge 00.mkv" } ] }
```

* `service`: `managed` (Wächter lebt) | `absent` (Volume da, Container fehlt/steht) | `missing` (kein `/gc-umw` – alte Compose-Datei, Pi-Image, Installation ohne Docker).
* `state`: `off` | `service_missing` | `no_roots` | `no_device` | `device_denied` | `no_encoder` | `paused` | `running` | `ready`.
* `caps` (vom Wächter beim Start geprüft; `null`, solange er nichts gemeldet hat):
  `device` `ok` | `denied` (Gerät da, aber die Gruppe `deviceGid` fehlt dem Dienst → `GC_UMW_RENDER_GID`) | `absent`;
  `encoders`: was ein Probelauf mit dem Treiber wirklich angenommen hat, in der Reihenfolge der Wahl;
  `software`: libx264 ist im Image vorhanden (ob es benutzt werden darf, steht in `settings.software`).
* `roots[].state`: `ok` | `readonly` | `missing` | `not_mounted` (steht in `features.transcode.roots`, ist im Dienst aber nicht eingehängt).
* `jobs[].state`: `queued` → `running` ⇄ `paused` → `verifying` → `done` | `failed` (`error` = Code aus § 7) | `cancelled`.
* `jobs[].result` (nach `done`/`failed`):

```json
{ "source": { "codec": "h264", "profile": "High 10", "pixFmt": "yuv420p10le", "bits": 10, "width": 1920, "height": 1080,
              "level": 42, "fps": 50, "fieldOrder": "progressive", "container": "matroska,webm", "duration": 1361.003,
              "video": 1, "audio": 2, "subtitles": 1, "attachments": 2, "pictures": 0, "other": 0, "chapters": 7, "size": 812000000 },
  "output": { "codec": "h264", "profile": "High", "pixFmt": "yuv420p", "bits": 8, "…": "wie source", "size": 357000000 },
  "mode": "vaapi_icq", "seconds": 384, "trashPath": "/volume2/mediathek/.gc-papierkorb/2026-11-27/Serie A/Staffel 1/Folge 01.mkv",
  "restored": null, "resumed": false, "freeKb": null, "needKb": null, "log": [] }
```

  `mode`: `vaapi_icq` | `vaapi_qvbr` | `software`. `pictures`: Titelbilder (zählen nicht als Videospur).
  `log`: nach einem Fehler die letzten Zeilen von ffmpeg (höchstens 20). `resumed`: der Tausch war
  schon geschehen, als der Auftrag (nach einem Neustart) wieder ankam.

## 4. Regeln auf dem Gateway

* **Pfad, zweimal geprüft.** Das Gateway prüft die Schreibweise: absolut, normalisiert (kein `..`,
  `.`, `//`), keine Steuerzeichen, unter einer Wurzel aus `features.transcode.roots`, nicht in
  `.gc-papierkorb`/`.gc-umwandeln`, Endung `.mkv` (für `probe` eine feste Liste von Video-Endungen).
  Der Wächter prüft im Dienst gegen **seine** Wurzeln (`GC_UMW_ROOTS` aus der Compose-Datei – das
  Gateway kann sie nicht ändern): `realpath` muss den Pfad unverändert ergeben (kein symbolischer
  Link an irgendeiner Stelle, auch die Wurzel nicht), es muss eine gewöhnliche Datei sein.
* **Eine Datei zur Zeit**, gerätweit; bis zu 32 wartende Aufträge, in der Reihenfolge des Eingangs.
* **Verfahren:** `h264_vaapi` mit ICQ (`-rc_mode ICQ -global_quality 23`); lehnt der Treiber ICQ im
  Probelauf ab, QVBR (`-rc_mode QVBR -global_quality 23 -b:v 8M -maxrate 14M`). Ohne Hardware nur mit
  `features.transcode.software` (libx264 `veryfast`, `crf`). Kein festes VBR: bei Quellen mit wenig
  Bitrate würde die neue Datei größer als das Original (Messung auf der DS918+).
* **Aufruf** (VAAPI/ICQ; gedrosselt mit `nice 19`, `ionice` idle, 3 Threads):

  ```
  ffmpeg -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -threads 3 -i <Quelle>
    -map 0:V:0 -map 0:a? -map 0:s? -map 0:t? -map_chapters 0 -map_metadata 0 -c copy
    -c:v:0 h264_vaapi -vf format=nv12,hwupload -profile:v high -level 4.2 -bf 2 -g <2 s>
    -rc_mode ICQ -global_quality 23 -max_muxing_queue_size 4096 -f matroska <Wurzel>/.gc-umwandeln/<id>.part.mkv
  ```

  `-level 4.2` nur bis 1920×1088, darüber wählt der Encoder.
* **Platz** vor dem Start: Größe der Quelle × 1,2 + 2 GB, danach noch `minFreeGb` und `minFreePct`
  frei – sonst `no_space`.
* **Prüfung vor dem Tausch:** ffprobe Original gegen Neu – Video H.264 mit 8 Bit, genau eine
  Videospur, gleiche Auflösung, gleich viele Ton-, Untertitel- und Anhang-Spuren, gleich viele
  Kapitel, Dauer höchstens 0,6 s anders, nicht kleiner als 2 % des Originals; dann einmal ganz
  dekodieren (`-xerror`, mit VAAPI). Schlägt etwas fehl, wird die neue Datei verworfen.
* **Tausch – am Zielort liegt immer eine ganze Datei:** Die neue Datei entsteht in
  `<Wurzel>/.gc-umwandeln/` (gleiches Dateisystem). Das Original bekommt einen harten Link nach
  `<Wurzel>/.gc-papierkorb/<JJJJ-MM-TT>/<Pfad unter der Wurzel>`, dann ersetzt `rename(2)` den alten
  Namen durch die neue Datei – ein Schritt, kein Augenblick ohne Datei (Jellyfin verliert das Video
  nicht aus dem Blick). Auf Dateisystemen ohne harte Links: zwei Umbenennungen. Daneben liegt
  `<Datei>.gc-info` (`id`, `state=pending|done`, `at`, `src`, `size`); nach Stromausfall oder Neustart
  bringt der Wächter damit einen angefangenen Tausch zu Ende oder nimmt ihn zurück und löscht
  liegengebliebene Zwischendateien. Ändert sich die Quelle während des Umwandelns (Größe, Zeit),
  wird nicht getauscht (`source_changed`). Beide Ordner bekommen eine Datei `.ignore` (Jellyfin
  liest sie nicht ein).
* **Papierkorb:** Originale mit `state=done` löscht der Wächter `trashDays` Tage nach dem Tausch
  (Prüfung stündlich und beim Start; ohne lesbare Einstellung wird nichts gelöscht). Dateien ohne
  `.gc-info` fasst er nie an.
* **Neustart:** Die Warteschlange liegt in `/state/transcode.json`. Ein unterbrochener Auftrag
  beginnt von vorn; war der Tausch schon geschehen, gilt er als fertig (`resumed`).
* **Anhalten** hält ffmpeg mit `SIGSTOP` an (`SIGCONT` zum Fortsetzen); angehalten beginnt kein
  neuer Auftrag. Fortschritt steht 15 Min. still → `stalled`.
* Die neue Datei gehört dem Benutzer des Dienstes; die Zugriffsrechte (Modus) werden vom Original
  übernommen, Synology-ACLs erbt sie vom Ordner.

## 5. Der Dienst `umwandeln`

* Image `ghcr.io/callmetechie/gatecontrol-gateway:umwandeln` (Stage `umwandeln` im Dockerfile, nur
  amd64). Woher ffmpeg kommt, steht an **einer** Stelle: `ARG UMW_FFMPEG` oben im Dockerfile.
  * `jellyfin` (Standard): Debian 12 slim + das unveränderte Paket **jellyfin-ffmpeg8** (Fassung und
    SHA-256 im Dockerfile gepinnt) – dieselbe ffmpeg-/Treiber-Kombination (iHD, i965, libva, libvpl),
    mit der Jellyfin auf Intel-Grafik umwandelt und die auf der DS918+ gemessen wurde. Image
    ≈ 130 MB. GPL-3.0-or-later; das Paket enthält auch `libfdk-aac`
    (der Dienst kodiert keinen Ton, er kopiert ihn). Hinweis: `deploy/umwandeln-NOTICE.txt`.
  * `debian`: Debian 13 slim + `ffmpeg`, `intel-media-va-driver-non-free` und `vainfo` aus Debian –
    ohne `libfdk-aac`, GPL-2.0-or-later, Sicherheitskorrekturen mit jedem Bau. Image
    ≈ 215 MB. Kein i965-Treiber mit Shadern. Hinweis: `deploy/umwandeln-debian-NOTICE.txt`.

  Beide baut und prüft der Test-Workflow (Software-Weg). Ein anderes Image (z. B. auf der NAS selbst
  gebaut: `docker build --target umwandeln --build-arg UMW_FFMPEG=… -t gc-umwandeln .`) setzt
  `GC_UMW_IMAGE` in der `.env`. Der Wächter braucht nur `ffmpeg`, `ffprobe` und `vainfo` im `PATH`
  (oder `GC_FFMPEG`, `GC_FFPROBE`, `GC_VAINFO`) und den Einstieg des Images. Lizenzhinweis im Image:
  `/usr/share/doc/gatecontrol-umwandeln/NOTICE.txt`.
* `network_mode: none`, `cap_drop: ALL`, `no-new-privileges`, `read_only`, `/tmp` als tmpfs (64 MB),
  `user: "${GC_UMW_UID}:${GC_UMW_GID}"` (nie root), `cpu_shares: 128`, `oom_score_adj: 800`,
  `mem_limit: 2g`, `pids_limit: 256`. Kein Port.
* Grafik: nur `/dev/dri/renderD128` (nicht `card0`), dazu `group_add` mit der Gruppe des Geräts
  (`GC_UMW_RENDER_GID`, `stat -c %g /dev/dri/renderD128`; Synology DSM 7: Gruppe `videodriver`).
  Der Wächter meldet die Zahl als `caps.deviceGid` und `device: denied`, wenn sie fehlt. Nie `chmod 666`.
* Medienordner: innen derselbe Pfad wie außen (`/volume2/mediathek:/volume2/mediathek`), nur die
  gewählten Ordner. `GC_UMW_ROOTS` nennt sie dem Wächter (mit `:` getrennt).
* tmpfs-Volume `umw-ctl` (`/gc-umw`, 4 MB, `uid=0,gid=61002,mode=2750`): hinein kommen nur das Gateway
  (root) und die Zusatzgruppe `61002` des Dienstes (`group_add`). Das Gateway schreibt
  `umwandeln.sh`, `run`, `conf`, `pause`, `jobs/<id>.job`, `jobs/<id>.pause`; der Dienst kann dort
  nur lesen und schreibt allein in `state/`: `umwandeln.state` (`alive <Unix-Sekunden>`), `caps`,
  `roots`, `trash`, `<id>` (`<Zustand> <Zeit> <Code|-> <Prozent> <B/s> <Tempo>`), `<id>.res` (Befund).
  Auftragsdatei weg = abbrechen. Was das Gateway aus `state/` liest, behandelt es als fremde Eingabe
  (feste Formate, Größengrenzen, keine Links).
* Der Wächter wechselt auf eine neue Fassung von `umwandeln.sh`, sobald nichts läuft.
* `docker-compose.example.yml`: Dienst im Profil `umwandeln`; die Compose-Datei aus GateControl
  enthält ihn ohne Profil, sobald die Funktion für das Gateway an ist (mit Ordnern, UID/GID und
  Gruppe der Grafik). `deploy/update.sh` erneuert das Image nach einem Gateway-Update, wenn der
  Container auf dem Host angelegt ist; ein Auftrag mitten im Umwandeln beginnt danach von vorn.
* Raspberry-Pi-Image: kein Dienst `umwandeln` (nur amd64) – `service: missing`.

Einrichten auf der Synology: [deployment/synology.md](deployment/synology.md) „Videos umwandeln“.

## 6. Telemetrie `features.transcode` (klein)

```json
{ "enabled": true, "service": "managed", "state": "ready", "device": "ok", "deviceGid": 937,
  "driver": "Intel iHD driver for Intel(R) Gen Graphics - 26.3.5 (1b5e662)",
  "encoders": ["vaapi_icq", "vaapi_qvbr"], "software": false, "ffmpeg": "8.1.3-Jellyfin",
  "roots": [ { "path": "/volume2/mediathek", "state": "ok", "free": 1932735283200, "total": 3900000000000 } ],
  "jobs": { "queued": 5, "done": 3, "failed": 0 },
  "current": { "id": "k3J9x2Qw8LmN", "state": "running", "percent": 41 },
  "trash": { "count": 3, "bytes": 2436000000 }, "arch": "x64", "error": null }
```

Aus: `{ "enabled": false, "service": "…" }`. `software`: erlaubt **und** vorhanden.

## 7. Fehlercodes

Antworten der Management-API:

| Code | HTTP | Bedeutung |
|---|---|---|
| `feature_disabled` | 503 | Funktion für dieses Gateway aus |
| `service_missing` / `service_absent` | 409 | kein Volume `umw-ctl` (alte Compose-Datei) / Container fehlt oder steht |
| `invalid_request` | 400 | `id`, `quality`, `ttlSec`, `ids` ungültig |
| `bad_path`, `outside_roots`, `unsupported_container`, `unsupported_type` | 400 | Pfad schon an der Schreibweise abgelehnt (§ 4) |
| `duplicate_id`, `already_queued`, `not_active` | 409 | `id` mit anderem Pfad bekannt / Pfad wartet oder läuft schon / Auftrag ist schon erledigt |
| `not_found` | 404 | Auftrag unbekannt |
| `queue_full`, `busy`, `rate_limited` | 429 | 32 Aufträge warten / zu viele kurze Aufrufe zugleich / zu viele Aufrufe |
| Code des Wächters (unten) | 422 | bei `probe`, `restore`, `purge` |
| `timeout` | 504 | der Wächter hat in 30 s nicht geantwortet |

Codes des Wächters (`jobs[].error`, bzw. `422`):

| Code | Bedeutung |
|---|---|
| `bad_path`, `outside_roots`, `root_missing`, `symlink`, `not_found`, `not_a_file`, `unsupported_container`, `unsupported_type` | Pfadprüfung im Dienst |
| `probe_failed`, `no_video` | ffprobe kann die Datei nicht lesen / keine Videospur |
| `not_writable`, `cross_device`, `no_space` | Arbeitsordner nicht anlegbar / anderes Dateisystem / zu wenig Platz (`result.freeKb`, `needKb`) |
| `no_device`, `device_denied`, `no_encoder` | kein `/dev/dri/renderD128` / Gruppe fehlt / Treiber nimmt weder ICQ noch QVBR – und Software nicht erlaubt |
| `encode_failed`, `stalled` | ffmpeg scheitert (`result.log`) / kein Fortschritt seit 15 Min. |
| `verify_probe`, `verify_codec`, `verify_bits`, `verify_streams`, `verify_chapters`, `verify_size`, `verify_duration`, `verify_small`, `verify_decode` | Prüfung der neuen Datei |
| `source_changed`, `trash_failed`, `swap_failed` | Quelle während des Umwandelns geändert / Papierkorb nicht beschreibbar / Tausch gescheitert (das Original liegt wieder am Ort) |
| `not_in_trash`, `restore_failed`, `bad_request`, `busy` | `restore`/`purge`: kein Original zu dieser `id` / Zurücklegen gescheitert / unlesbarer Auftrag / der Auftrag läuft gerade |

In jedem dieser Fälle bleibt das Original unverändert an seinem Ort.

## 8. Tests

* `tests/transcode_config.test.js` – Schalter, Wurzeln, Pfadprüfung des Gateways.
* `tests/transcode_watcher.test.js` – das echte `umwandeln.sh` mit Attrappen für ffmpeg, ffprobe und
  vainfo: Aufrufe, Verfahren, Pfadprüfung mit Links, Prüfregeln, Abbruch, Anhalten, harter Abbruch
  und Wiederanlauf mitten im Tausch, Fristen des Papierkorbs, Wiederherstellen.
* `tests/transcode_service.test.js` – Auftragslogik des Gateways gegen den echten Wächter,
  Management-API, Telemetrie, fremde Eingabe aus `state/`.
* `tests/transcode_real_ffmpeg.test.js` – mit dem ffmpeg des Rechners (Software-Weg), wenn vorhanden.
* Workflow `umwandeln-image`: baut das Image und wandelt im Container mit den Schutzoptionen der
  Compose-Datei ein erzeugtes 10-Bit-Video um (`tests/live/umwandeln-image.sh`, Software-Weg).

VAAPI selbst (ICQ/QVBR, Treiber, Gruppe des Geräts) prüft nur echte Hardware.
