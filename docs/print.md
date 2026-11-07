# Drucken & Scannen (Phase 3c, Schritt 1)

Eine Funktion im Gateway-Prozess, die der Server pro Gateway über
`features.print` im Config-Pull ein- und ausschaltet (Gateway › Funktionen ›
„Geräte im Heimnetz“ › „Drucken & Scannen“). Fehlt `features.print`, ist sie
aus. Kein eigener Container, keine neue Compose-Zeile: das Gateway läuft
ohnehin im Host-Netz und spricht mDNS, IPP und eSCL selbst. Für Drucker ohne
PDF wandelt es PDF um (poppler-utils im Image, siehe „Umwandeln“). Bedienung, Rechte und Ablage im Drive
macht das Plugin „Drucken & Scannen“ (`gatecontrol-print`) am Server.

| Teil | Wie | Zustand in `/state` |
|---|---|---|
| Geräte finden | mDNS `_ipp._tcp`, `_ipps._tcp` (Drucker), `_uscan._tcp`, `_uscans._tcp` (Scanner) auf jeder eigenen LAN-Adresse, alle 10 Min. und auf „Neu suchen“; `manual`-Adressen direkt (IPP 631 `/ipp/print`, eSCL 80/443 `/eSCL`) | `print-devices.json` |
| Zustand | IPP `Get-Printer-Attributes` (bereit/Standby, Gründe, Tinte `marker-*`, Formate, Farbe, beidseitig; fürs Umwandeln `pwg-raster-*`, `urf-supported`, `media-default`/`media-ready`), eSCL `ScannerCapabilities`/`ScannerStatus` alle 5 Min. | – |
| Bericht | `POST /api/v1/gateway/print/devices` (`{ scannedAt, devices, search }`) nach jeder Suche, bei Änderung, sonst alle 15 Min.; `telemetry.features.print` (mit `search`) | – |
| Drucken | Warteschlange `GET /api/v1/gateway/print/jobs` (jede Minute mit ETag, sofort nach Mgmt `POST /api/print/jobs`), Datei `GET …/jobs/<id>/file` (≤ 50 MB, sha256 geprüft), Format am Inhalt, PDF für Drucker ohne PDF umgewandelt, IPP `Print-Job` (`document-format`, `copies`, `sides`, `print-color-mode`), `Get-Job-Attributes` bis fertig (≤ 10 Min.), Zustände an `POST …/jobs/<id>` | `print-tmp/` (Dateien und Umwandlungen bis zum Senden), `print-journal.json` |
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

## Umwandeln (PDF an Drucker ohne PDF)

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
  sonst je Seite ein JPEG (je Seite ein `Print-Job`, Name „… (2/5)“).
  `application/pclm` und Herstellerformate erzeugt das Gateway nicht.
* **Einstellungen:** Auflösung 300 dpi, sonst die nächstgrößere, sonst die
  größte genannte; Farbe nur bei einem Farbauftrag und `srgb_8`/`SRGB24`,
  sonst Graustufen (`sgray_8`/`W8`, notfalls `black_1` oder grau gerendert
  als sRGB). Papier aus `media-ready`, sonst `media-default`, sonst A4.
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

Fehlercodes in den Zustandsmeldungen: `printer_offline`, `printer_busy`,
`printer_not_accepting`, `device_not_found`, `download_failed`, `cert_changed` (→ `waiting`);
`format_unsupported`, `convert_failed`, `convert_too_large`,
`printer_rejected`, `not_a_printer`, `device_not_allowed`,
`canceled_at_printer`, `aborted_at_printer` (→ `failed`); Scans: `scanner_busy`, `feeder_empty`, `no_pages`, `too_large`,
`timeout`, `canceled`, `cert_changed`, `scan_failed`.

Code: `src/print/` (`ipp.js` IPP-Kodierung und -Client, `escl.js`,
`discovery.js`, `print.js`, `convert.js` Umwandeln, `serverClient.js`), Tests
mit einem Test-Drucker (`tests/helpers/fakePrinter.js`) und echten PDF-Seiten
(`tests/print_convert.test.js`, braucht `poppler-utils`).
