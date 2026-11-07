# Drucken & Scannen (Phase 3c, Schritt 1)

Eine Funktion im Gateway-Prozess, die der Server pro Gateway über
`features.print` im Config-Pull ein- und ausschaltet (Gateway › Funktionen ›
„Geräte im Heimnetz“ › „Drucken & Scannen“). Fehlt `features.print`, ist sie
aus. Das Gateway läuft ohnehin im Host-Netz und spricht mDNS, IPP und eSCL
selbst. Für Drucker ohne PDF wandelt es PDF um (poppler-utils im Image, siehe
„Umwandeln“), Scans macht es auf Wunsch durchsuchbar (tesseract im Image,
„Texterkennung“). Nur „Office-Dateien drucken“ braucht einen eigenen, großen
Dienst (`office` mit LibreOffice, „Office-Dateien“) – geladen nur, wenn das für
das Gateway eingeschaltet ist. Bedienung, Rechte und Ablage im Drive macht das
Plugin „Drucken & Scannen“ (`gatecontrol-print`) am Server.

| Teil | Wie | Zustand in `/state` |
|---|---|---|
| Geräte finden | mDNS `_ipp._tcp`, `_ipps._tcp` (Drucker), `_uscan._tcp`, `_uscans._tcp` (Scanner) auf jeder eigenen LAN-Adresse, alle 10 Min. und auf „Neu suchen“; `manual`-Adressen direkt (IPP 631 `/ipp/print`, eSCL 80/443 `/eSCL`) | `print-devices.json` |
| Zustand | IPP `Get-Printer-Attributes` (bereit/Standby, Gründe, Tinte `marker-*`, Formate, Farbe, beidseitig; fürs Umwandeln `pwg-raster-*`, `urf-supported`, `pclm-*`, `media-default`/`media-ready`; Papier und Fächer `media-supported`, `media-source-supported`, `media-col-default`/`media-col-ready`), eSCL `ScannerCapabilities`/`ScannerStatus` alle 5 Min. | – |
| Bericht | `POST /api/v1/gateway/print/devices` (`{ scannedAt, devices, search }`) nach jeder Suche, bei Änderung, sonst alle 15 Min.; `telemetry.features.print` (mit `search`) | – |
| Drucken | Warteschlange `GET /api/v1/gateway/print/jobs` (jede Minute mit ETag, sofort nach Mgmt `POST /api/print/jobs`), Datei `GET …/jobs/<id>/file` (≤ 50 MB, sha256 geprüft), Format am Inhalt, Office-Dateien zu PDF (Dienst `office`), PDF für Drucker ohne PDF umgewandelt, IPP `Print-Job` (`document-format`, `copies`, `sides`, `print-color-mode`, `media`/`media-col`), `Get-Job-Attributes` bis fertig (≤ 10 Min., Halt-Gründe gemeldet), Zustände an `POST …/jobs/<id>` | `print-tmp/` (Dateien und Umwandlungen bis zum Senden), `print-journal.json` |
| Texterkennung | Mgmt `POST /api/print/ocr { ocrId, pages, dpi }` → Seiten `GET /api/v1/gateway/print/ocr/<id>/pages/<n>`, tesseract je Seite, Ergebnis `PUT …/ocr/<id>/document` (PDF) und `…/text`, Zustand an `POST …/ocr/<id>` | `print-tmp/ocr-<id>/` (bis zum Hochladen) |
| Scannen | Mgmt `POST /api/print/scan` → eSCL `POST ScanJobs`, `GET …/NextDocument` bis 404, je Seite `PUT /api/v1/gateway/print/scans/<id>/pages/<n>` (≤ 50 MB, ≤ 100 Seiten), Zustand an `POST …/scans/<id>` | `print-tmp/` (je Seite bis zum Hochladen) |

## Suche im LAN

* **Sockets:** je LAN-Adresse ein Socket auf Port 5353, gebunden an
  `0.0.0.0` (SO_REUSEADDR – geteilt mit avahi/Bonjour des Hosts, z. B. auf
  Synology DSM) und der Gruppe nur auf dieser Schnittstelle beigetreten;
  dazu eine „Legacy Unicast“-Frage von einem freien Port (RFC 6762 §6.7),
  die Geräte direkt beantworten. Nie an die LAN-Adresse selbst binden:
  unter Linux kommen an so einem Socket keine Multicast-Antworten an.
* **Nachfragen:** viele Drucker (HP OfficeJet, Brother, Canon) antworten
  auf die PTR-Frage nur mit dem PTR oder schicken SRV, TXT und A in
  getrennten Paketen, mit anderer Schreibweise. Die Einträge werden über
  alle Antworten ohne Rücksicht auf Groß-/Kleinschreibung gesammelt; was
  fehlt (SRV/TXT des Dienstes, A des Rechners), wird zweimal gezielt
  nachgefragt. Nur AAAA genügt nicht (IPv4 im LAN). Hat ein Gerät mehrere
  Adressen (LAN und Wi-Fi Direct), gilt die erste erlaubte.
* **Diagnose (`search`):** `{ at, interfaces, responses, responders,
  services, devices, dropped: { <Grund>: n }, hosts: [{ ip, reason, name }]
  (≤ 8), manual: [{ ip, found, via?: 'mdns'|'manual', error?:
  'unreachable'|'no_service' }], errors }`. Gründe: `incomplete` (kein SRV
  oder keine Adresse), `no_ipv4`, `other_subnet` (privat, aber nicht im
  eigenen LAN – per `manual` erlauben), `not_private`, `bad_path`,
  `too_many`; `errors`: `no_lan`, `mdns_port_busy`, `mdns_failed`,
  `legacy_failed`. Die Gateway-Seite am Server zeigt das unter „Drucken &
  Scannen“.
* **`manual`:** jede Adresse wird gleichzeitig gefragt: IPP
  `Get-Printer-Attributes` auf 631 (`/ipp/print`, `/ipp`, `/` – weitere
  Pfade nur, wenn 631 überhaupt antwortet), sonst IPPS auf 443 (Zertifikat
  beim ersten Kontakt gelernt); eSCL `ScannerCapabilities` auf 80, sonst
  443 (gleicher Pin). Name aus `printer-info`, sonst
  `printer-make-and-model`. Findet mDNS das Gerät unter dieser Adresse,
  gilt der mDNS-Fund – auch in einem anderen privaten Subnetz.

## Regeln

* **Nur eigene Geräte:** verbunden wird nur mit Adressen, die das Gateway
  selbst per mDNS gefunden hat und die in einem eigenen privaten LAN-Subnetz
  liegen, oder mit den `manual`-Adressen (nur RFC 1918, höchstens 16). Server
  und Plugins nennen nur Geräte-Ids (`u:<uuid>` bzw. `h:<sha1(ip)>`), nie
  Adressen oder URLs. Der Pfad (`rp`/`rs`) stammt aus der Ankündigung des
  Geräts und wird geprüft; der Ort eines Scan-Auftrags (`Location`) wird nur
  als Pfad auf demselben Gerät benutzt. Keine Weiterleitungen, Antworten
  begrenzt (IPP 1 MB, eSCL-XML 256 KB, Seite 50 MB).
* **TLS nie ohne Prüfung:** bevorzugt wird `ipp`/`http` im LAN. Bietet ein
  Gerät nur `ipps`/`https` an, lernt das Gateway beim ersten Kontakt den
  SHA-256 des Leaf-Zertifikats (nur TLS-Handshake, `src/proxy/tlsPin.js`) und
  verbindet sich danach nur mit genau diesem Zertifikat (Pin in
  `print-devices.json`). Ein anderes Zertifikat → das Gerät meldet
  `problem: 'cert_changed'` (+ `seenSha256`), Aufträge warten
  (`cert_changed`); erst Mgmt `POST /api/print/discover { retrust: <id> }`
  verwirft den alten Pin und lernt neu.
* **Drucker aus:** nicht erreichbar, beschäftigt oder „nimmt nichts an“ →
  Zustand `waiting`, neuer Versuch alle 2 Min. Aufgeben (24 h) entscheidet der
  Server – der Auftrag verschwindet dann aus der Liste.
* **Kein Doppeldruck:** was an den Drucker ging, steht bis zur Rückmeldung im
  Journal; nach einem Neustart wird so ein Auftrag als fertig (`unconfirmed`)
  gemeldet statt neu gedruckt.
* **Formate:** das Format zählt am Inhalt (`%PDF-` in den ersten 1024 Bytes,
  JPEG, PNG, PWG, URF …), nicht am Etikett des Servers. Nennt der Drucker es
  in `document-format-supported` (oder nennt er gar keine Formate), geht die
  Datei unverändert raus. Ein PDF für einen Drucker ohne `application/pdf`
  wandelt das Gateway um (siehe unten); geht das nicht und nennt der Drucker
  `application/octet-stream`, geht es wie bisher unverändert raus, sonst
  `failed/format_unsupported` ohne Versuch, mit dem Grund in `message`:
  `convert_off` (abgeschaltet), `no_converter` (Image ohne poppler),
  `no_raster_format` (kein PWG/URF/JPEG), `printer_formats` (kein PDF und
  der Drucker nimmt das Format nicht). Bilder macht der Server zu JPEG oder
  zu einer PDF-Seite.

## Umwandeln (PDF an Drucker ohne PDF, ab 1.30.0)

Viele Tintenstrahler – z. B. HP OfficeJet Pro 8720 – nennen per IPP nur
`image/pwg-raster`, `image/urf`, `image/jpeg`, `application/pclm` und
Herstellerformate. Für sie rendert das Gateway PDF selbst
(`src/print/convert.js`):

* **Schalter:** `features.print.convert` (Standard an; nur `false` schaltet
  aus). Der Gerätebericht nennt je Drucker ohne PDF `printer.convert`: das
  Zielformat (`image/pwg-raster`, `image/urf`, `image/jpeg`) oder `null`
  (aus, kein Werkzeug, kein passendes Format) – danach nimmt der Server PDF
  für diesen Drucker an. `telemetry.features.print.convert` = `{ enabled,
  available }`, Capability `print-convert`.
* **Ziel:** PWG-Raster (wenn `pwg-raster-document-resolution-supported`
  genannt ist), sonst URF (`urf-supported` mit `RS…` und `W8`/`SRGB24`),
  sonst **PCLm** (`application/PCLm`, ab 1.33.0, siehe unten), sonst je Seite
  ein JPEG (je Seite ein `Print-Job`, Name „… (2/5)“). Herstellerformate
  (PCL, PostScript, HP-eigene) erzeugt das Gateway nicht.
* **PCLm** (Wi-Fi Alliance, z. B. HP-Drucker, die außer JPEG nur das nennen):
  ein PDF, dessen Seiten aus waagerechten Bildstreifen bestehen. Das Gateway
  schreibt es selbst (kein weiteres Werkzeug): Kopf `%PDF-1.7` / `%PCLm 1.0`,
  je Seite ein Inhalt, der die Streifen von oben nach unten setzt, je Streifen
  ein Bild (`/DeviceRGB` oder `/DeviceGray`, 8 Bit). Streifenhöhe aus
  `pclm-strip-height-preferred` (sonst 16), Auflösung aus
  `pclm-source-resolution-supported` (300 dpi bevorzugt, sonst 300),
  Kompression Flate (zlib), Run-Length nur, wenn der Drucker kein `flate`
  nennt (JPEG-Streifen schreibt das Gateway nicht), Rückseite nach
  `pclm-raster-back-side`. Gesendet wird `document-format application/PCLm`.
* **Einstellungen:** Auflösung 300 dpi, sonst die nächstgrößere, sonst die
  größte genannte; Farbe nur bei einem Farbauftrag und `srgb_8`/`SRGB24`,
  sonst Graustufen (`sgray_8`/`W8`, notfalls `black_1` oder grau gerendert
  als sRGB). Papier: das gewählte (`media` des Auftrags), sonst aus
  `media-ready`, sonst `media-default`, sonst A4.
  Querformat wird auf hochkant gedreht (oben → links), zu große Seiten
  verkleinert, kleinere mittig in Originalgröße. Beidseitig (lange Kante)
  wird jede zweite Seite so gelegt, wie der Drucker es nennt
  (`pwg-raster-document-sheet-back` bzw. URF `DM1…4`: `rotated` → 180°,
  `flipped` → gespiegelt).
* **Werkzeuge:** `pdfinfo` (Seitengrößen, Drehung) und `pdftoppm` (eine Seite
  je Aufruf als PGM/PPM über stdout) aus `poppler-utils`; `font-liberation`
  ersetzt nicht eingebettete Standardschriften. Prozesse mit niedriger
  Priorität (nice 10), höchstens 3 Min. je Seite, eine Umwandlung zur Zeit;
  Ergebnis in `print-tmp/<id>.conv`, höchstens 1 GB, danach gelöscht.
* **Schwache Geräte:** auf einem Raspberry Pi 3/Zero dauert das Umwandeln
  spürbar länger als auf einem PC (Fotos mehr als Text); der Speicher bleibt
  bei einer Seite (A4 300 dpi Farbe ≈ 26 MB). Ein Hinweis, kein Verbot –
  abschalten geht je Gateway.
* **Fehler:** kaputtes oder verschlüsseltes PDF → `failed/convert_failed`
  (Grund in `message`), mehr als 1 GB Rasterdaten → `convert_too_large`.
  Während der Umwandlung meldet das Gateway `sending` mit `message:
  'converting'`. Nennt ein Drucker PDF und antwortet doch mit
  `client-error-document-format-not-supported` (0x040a), wird der Auftrag
  einmal umgewandelt gedruckt.
* **Ein Auftrag je Gerät:** Druck und Scan laufen je Gerät nacheinander; ein
  zweiter Scan während eines Scans → 409 `scanner_busy`.

## Papier und Fach (ab 1.33.0)

* **Bericht:** `printer.media = { sizes, default, sources, sourceDefault,
  ready }`. `sizes`: nur die Formate, die GateControl anbietet (PWG-Namen:
  `iso_a4_210x297mm`, `iso_a5_148x210mm`, `iso_a6_105x148mm`,
  `na_letter_8.5x11in`, `na_legal_8.5x14in`, Foto `na_index-4x6_4x6in`
  (10 × 15), `na_5x7_5x7in` (13 × 18), `oe_photo-l_3.5x5in` (9 × 13); `…_borderless`
  zählt als das Format) aus `media-supported`, `media-ready` und
  `media-col-ready`; `sources`: `media-source-supported` (Schlüsselwörter wie
  `main`, `photo`, `manual`, `by-pass-tray`, `tray-1`; ≤ 8); `ready`: was laut
  `media-col-ready` in welchem Fach liegt (≤ 8).
* **Auftrag:** `media` und `source` der Warteschlange (null = Standard des
  Druckers). Mit Fach geht `media-col` (`media-size` in 1/100 mm +
  `media-source`), nur Papier als `media`. Was der Drucker nicht nennt, geht
  nicht hin – dann druckt er auf seinem Standardpapier. Beim Umwandeln wird für
  das gewählte Papier gerendert.

## Zustände beim Drucken (ab 1.33.0)

Während `Get-Job-Attributes` fragt das Gateway bei einem angehaltenen Auftrag
(`processing-stopped`, `printer-stopped`) den Drucker nach dem Grund und meldet
ihn als `printing` mit `message`: `media-empty`, `media-needed`, `media-jam`,
`door-open`, `cover-open`, `toner-empty`, `marker-supply-empty`,
`input-tray-missing`, `output-area-full`, `paused`, `stopped`, bei einem
zurückgehaltenen Auftrag `held`. Läuft er weiter, kommt `printing` ohne
`message`. Die Apps zeigen das als „Papier fehlt“, „Klappe offen“ usw.
Nach einer Office-Datei trägt `printing` die Seitenzahl des PDFs (`pages`).

## Office-Dateien (ab 1.33.0)

Schalter `features.print.office` (Standard aus; Capability `print-office`).
Word (`docx`), Excel (`xlsx`), PowerPoint (`pptx`), OpenDocument (`odt`, `ods`,
`odp`) und RTF wandelt der Dienst **`office`** vor dem Drucken in PDF; danach
geht es weiter wie bei jedem PDF (auch umgewandelt für Drucker ohne PDF).
Reiner Text (`.txt`) braucht kein LibreOffice: den macht der Server selbst zu
PDF.

* **Dienst:** Image `ghcr.io/callmetechie/gatecontrol-gateway:office`
  (Release-Workflow, Stage `office` im `Dockerfile`: Debian 12 slim,
  `libreoffice-writer-nogui`, `-calc-nogui`, `-impress-nogui`, Schriften
  Liberation, Carlito/Caladea (passen zu Calibri/Cambria), DejaVu). ≈ 200 MB
  Download, ≈ 700 MB auf dem Datenträger, beim Umwandeln bis ≈ 500 MB RAM
  (`mem_limit: 1g`). Empfohlen ab 2 GB RAM; auf kleineren Geräten (Raspberry Pi
  3/Zero) geht es, nur langsam – ein Hinweis, kein Verbot.
* **Abschottung:** `network_mode: none` (kein Netz), `user 0:0` ohne jede
  Capability, `no-new-privileges`, read-only, `/tmp` als tmpfs (256 MB, je
  Datei ein frisches LibreOffice-Profil), `cpu_shares: 256`, `oom_score_adj: 800`
  (wird der Speicher knapp, trifft es LibreOffice, nie das Gateway). Makros laufen
  nicht (Kommandozeilen-Umwandlung ohne Makrofreigabe).
* **Steuerung wie bei den Kameras:** das Gateway legt `office.sh` und – solange
  eingeschaltet – `run` ins tmpfs-Volume `office-ctl` (`/gc-office`, 160 MB). Der
  Einstieg des Dienstes wartet auf `office.sh` und führt es aus (die Logik kommt
  so mit jedem Gateway-Update). Auftrag: `in/<id>.<ext>` + `in/<id>.go` (Inhalt:
  die Endung) → `out/<id>.pdf` + `out/<id>.done`, sonst `out/<id>.err`
  (`failed`, `timeout`, `missing`, `type`). Ein Auftrag nach dem anderen,
  höchstens 180 s (`timeout -s KILL`), `nice 10`. Lebenszeichen
  `office.state` (`running|idle <Unix-Sekunden>`); älter als 60 s → der Dienst
  fehlt.
* **Compose:** `docker-compose.example.yml` hat den Dienst im Profil `office`
  (lädt niemand ohne den Schalter); die Datei aus GateControl („docker-compose.yml
  herunterladen“) enthält ihn ohne Profil, sobald der Schalter an ist. Pi-Image:
  `office` ohne Profil, gestartet von `gatecontrol-start`, wenn
  `gateway-state/office.json` `{"want":true}` sagt; schaltet man es im Betrieb
  ein, legt das Gateway `gateway-state/office-start` an und
  `gatecontrol-office.path` startet den Dienst (`hardware.json` mit
  `office_start`).
* **Bericht/Telemetrie:** je Drucker `printer.office: true`, wenn der Schalter
  an ist, der Dienst arbeitet und PDF für diesen Drucker geht (direkt oder
  umgewandelt) – danach nimmt der Server Office-Dateien an.
  `telemetry.features.print.office = { enabled, service: managed|absent|missing }`.
* **Ablauf:** `sending` mit `message: 'converting_office'`, dann wie ein PDF.
  Schalter aus → `failed/format_unsupported` (`message: office_off`), Dienst
  noch nicht da → `waiting` (`office_starting`, neuer Versuch alle 2 Min.),
  LibreOffice scheitert → `failed/office_failed`, länger als 180 s →
  `failed/office_timeout`.
* **Aktualisieren:** das Image `:office` wird beim ersten Einschalten geladen;
  ein Gateway-Update (`deploy/update.sh`) zieht nur Gateway und Edge nach.

## Texterkennung (ab 1.33.0)

Schalter `features.print.ocr` (Standard aus; Capability `print-ocr`). Aus den
Seiten eines Scans wird ein **durchsuchbares PDF** (das Bild bleibt, der Text
liegt unsichtbar darüber) und der erkannte Text für die Suche im Drive.

* **Werkzeug:** `tesseract-ocr` mit Deutsch und Englisch (`deu+eng`) im Image
  (≈ 45 MB), `pdfunite` (poppler) fügt die Seiten zusammen. Je Seite ein
  Prozess (`nice 15`, `OMP_THREAD_LIMIT=1`), mit `--dpi` der Scan-Auflösung.
* **Ablauf:** der Server ruft `POST /api/print/ocr { ocrId, pages, dpi }` (202;
  400 `invalid_request`; 409 `ocr_busy` – eine läuft, höchstens drei warten;
  503 `ocr_unavailable` – tesseract oder Sprachen fehlen; 503
  `feature_disabled`). Das Gateway holt die Seiten (`GET
  /api/v1/gateway/print/ocr/<id>/pages/<n>`, JPEG/PNG ≤ 50 MB), erkennt sie
  nacheinander und meldet `running` mit `page`/`pages` nach jeder Seite und
  sonst alle 60 s (der Server gibt nach 3 Min. Stille auf). Ergebnis: `PUT
  …/ocr/<id>/document` (`application/pdf`) und `PUT …/ocr/<id>/text`
  (`text/plain`, ≤ 1 MB), dann `done`. Mgmt `POST /api/print/ocr/cancel {
  ocrId }` bricht ab.
* **Grenzen:** höchstens 4 Min. je Seite, 30 Min. je Auftrag, 100 Seiten; eine
  Texterkennung zur Zeit (schont schwache Geräte). Auf einem Raspberry Pi 3/Zero
  dauert eine A4-Seite (300 dpi) etwa 30–90 s, auf einem PC 1–3 s – ein Hinweis,
  kein Verbot.
* **Fehler** (`failed` mit `error`): `ocr_unavailable`, `ocr_timeout`,
  `ocr_failed`, `download_failed`, `upload_failed`, `canceled`, `ocr_off`,
  `disabled`. Das Plugin legt dann das normale PDF ab.
* **Telemetrie:** `telemetry.features.print.ocr = { enabled, available, langs,
  running, queued }`.

Fehlercodes in den Zustandsmeldungen: `printer_offline`, `printer_busy`,
`printer_not_accepting`, `device_not_found`, `download_failed`, `cert_changed`,
`office_starting` (→ `waiting`); `format_unsupported`, `convert_failed`,
`convert_too_large`, `office_failed`, `office_timeout`, `printer_rejected`,
`not_a_printer`, `device_not_allowed`, `canceled_at_printer`,
`aborted_at_printer` (→ `failed`); Scans: `scanner_busy`, `feeder_empty`,
`no_pages`, `too_large`, `timeout`, `canceled`, `cert_changed`, `scan_failed`.

Code: `src/print/` (`ipp.js` IPP-Kodierung und -Client, `escl.js`,
`discovery.js`, `print.js`, `convert.js` Umwandeln und PCLm, `ocr.js`
Texterkennung, `office.js` + `office.sh` Office-Dateien, `serverClient.js`),
Tests mit einem Test-Drucker (`tests/helpers/fakePrinter.js`), echten PDF-Seiten
(`tests/print_convert.test.js`, braucht `poppler-utils`) und Beispieldokumenten
(`tests/fixtures/print/`, `tests/print_ocr_office.test.js`, braucht
`tesseract-ocr` mit `deu`/`eng` und LibreOffice `-nogui`; die CI installiert
beides). Nicht automatisch prüfbar: echte Drucker (PCLm, Fächer, Halt-Gründe) und
echte Scanner.
