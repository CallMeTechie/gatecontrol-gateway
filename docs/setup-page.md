# Einrichtungsseite im Heimnetz

Der Gateway-Container startet ohne Zugangsdatei. Solange er nicht verbunden
ist, zeigt er unter seiner Adresse im Heimnetz eine eigene Seite:

```
http://<Adresse des Geräts>:8642
```

Dort gibst du **Serveradresse** (z. B. `gate.example.de`) und
**Einrichtungscode** (`XXXX-XXXX-XXXX-XXXX`) aus GateControl ein
(Gateways › Gateway hinzufügen). Das Gateway holt sich damit seine
Zugangsdaten selbst, speichert sie als `gateway.env` im Ordner `config` und
fährt ohne Neustart des Containers hoch. Die bisherigen Wege bleiben:
`gateway.env` von Hand in den Ordner `config`, der Proxmox-Einzeiler
(`--token CODE@host`) und beim Raspberry-Pi-Image die Datei auf der SD-Karte.

## Zustände

| | Zustand | Was die Seite zeigt |
|---|---|---|
| A | Einrichten | Felder „Serveradresse“ und „Einrichtungscode“, darunter die Selbstprüfungen |
| B | Voraussetzung fehlt | was fehlt und wie man es behebt; „Verbinden“ ist gesperrt, die Seite prüft alle 10 s neu |
| C | Verbindung wird aufgebaut | Code angenommen → Zugangsdaten gespeichert → VPN-Tunnel → GateControl meldet online |
| D | Code abgelehnt | Fehler am Feld mit dem, was hilft („Prüfe die Serveradresse“, „Erzeuge einen neuen Code“, „Zu viele Versuche“) |
| E | Verbunden | reine Statusanzeige: Server, letzter Kontakt, Name, Tunnel, Version, Adresse – keine Eingaben |
| F | Zugang ungültig | Code-Eingabe mit **fester** Serveradresse |

Die Seite ist Deutsch oder Englisch (nach Browser, unten umschaltbar) und hell
oder dunkel nach System. Sie lädt nichts von außen.

### Selbstprüfungen (A/B)

- **Internet erreichbar** – eine HTTPS-Anfrage an `1.1.1.1`, sonst `9.9.9.9`
  (dieselben Ziele wie die Internetqualität).
- **Uhrzeit stimmt** – aus derselben Anfrage: Abweichung zur `Date`-Zeile
  höchstens 10 Minuten; ein „noch nicht gültiges“ oder „abgelaufenes“
  Zertifikat zählt als falsche Uhr. Ohne Internet bleibt sie „noch nicht
  geprüft“ und sperrt nicht.
- **VPN-Gerät vorhanden** – `/dev/net/tun` lässt sich öffnen (fehlt nur der
  Geräteknoten im Container, legt das Gateway ihn an) oder der Kernel kann
  WireGuard selbst.
- **Ordner config beschreibbar** – echte Schreibprobe.

Geprüft wird nur, während jemand die Seite offen hat.

**Synology, „VPN-Gerät fehlt“:** DSM stellt `/dev/net/tun` erst bereit, wenn
das Modul `tun` geladen ist. Ohne SSH: Systemsteuerung › Aufgabenplaner ›
Erstellen › Ausgelöste Aufgabe › Benutzerdefiniertes Skript, Benutzer `root`,
Ereignis „Hochfahren“, Befehl `insmod /lib/modules/tun.ko`; Aufgabe markieren
und „Ausführen“. Die Seite zeigt diese Schritte nur auf einer Synology. Damit
der Container in diesem Zustand überhaupt startet, erlaubt die Compose-Datei
das Gerät per Regel (`device_cgroup_rules: 'c 10:200 rwm'`, dazu `MKNOD`)
statt mit `devices: /dev/net/tun` – mit `devices` verweigert Docker den Start,
solange das Gerät am Host fehlt. Ältere Compose-Dateien mit `devices` laufen
unverändert weiter.

**„Ordner config nicht beschreibbar“:** In älteren Compose-Dateien steht
`./config:/config:ro`. Für die Einrichtungsseite das `:ro` entfernen und das
Projekt neu erstellen. Bestehende Gateways mit `:ro` **und** vorhandener
`gateway.env` müssen nichts ändern: Sie laufen wie bisher und zeigen die
Statusseite; nur das Verbinden über die Seite (auch Zustand F) geht dort
nicht – die Seite sagt das und verbraucht dann keinen Code.

### Zustand F: Zugang ungültig

Lehnt der Server den Zugang ab (GateControl › Gateway › „Zugang erneuern“),
öffnet sich die Code-Eingabe wieder. Das passiert nur, wenn der Server es
ausdrücklich sagt (HTTP 401/403 mit `error: invalid_token` auf den Heartbeat),
und zwar mindestens viermal hintereinander über mindestens 90 Sekunden –
nicht bei Netzfehlern, Timeouts, TLS-Fehlern oder Fehlerseiten eines Proxys,
und nicht, wenn das Gateway in GateControl nur deaktiviert ist
(`gateway_disabled`). Nimmt der Server das Gateway doch wieder an, schließt
sich die Eingabe von selbst.

Die Serveradresse ist dabei die bisherige und lässt sich nicht ändern: Aus dem
Heimnetz heraus kann niemand ein verbundenes Gateway an einen anderen Server
hängen. Nach dem Einlösen schreibt das Gateway die neue `gateway.env` und
startet seinen Prozess neu (`restart: unless-stopped` bzw. systemd), Routen
und Einstellungen bleiben. Sonst öffnet sich die Eingabe nur, wenn die
`gateway.env` gelöscht und der Container neu gestartet wird.

## Sicherheit

- **Nur Heimnetz.** Verbindungen von Adressen, die nicht privat (RFC 1918,
  `fc00::/7`), Link-lokal oder der Rechner selbst sind, werden ohne Antwort
  geschlossen – ebenso alles, was über den Tunnel kommt (Tunnel-Adresse des
  Gateways als Ziel oder Absender aus `WG_ADDRESS`/`WG_ALLOWED_IPS`).
- **Nicht weitergereicht.** Anfragen mit `Forwarded`, `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Real-IP` oder `Via` werden abgelehnt: Die Seite
  gehört nicht hinter einen Reverse Proxy.
- **DNS-Rebinding.** Die `Host`-Zeile muss eine Adresse des Heimnetzes oder
  ein lokaler Name sein (`gatecontrol.local`, `nas`, `*.lan`, `*.home.arpa`,
  `*.internal`); weitere Namen über `GC_SETUP_ALLOWED_HOSTS`. Sonst `421`.
- **CSRF.** „Verbinden“ braucht das Token der Seite (`X-GC-Setup`), JSON und
  gleiche Herkunft (`Origin`, `Sec-Fetch-Site`).
- **Versuche.** Höchstens 5 je 5 Minuten, für alle Absender zusammen.
- **Server.** Nur `https`, Zertifikat wird normal geprüft, Weiterleitungen
  werden nicht verfolgt, die Antwort ist auf 64 KB begrenzt und wird als
  `gateway.env` geprüft. Von der Antwort des Servers erreicht die Seite nichts
  außer festen Fehlerkennungen und dem bereinigten Namen des Gateways.
- **Keine Geheimnisse.** Die Seite zeigt nie Schlüssel oder Token; der Code
  wird nicht protokolliert. Der Code geht im Heimnetz unverschlüsselt (HTTP)
  ans Gateway, ist aber einmalig und 10 Minuten gültig.
- **Kopfzeilen.** `Content-Security-Policy: default-src 'none'; script-src
  'self'; style-src 'self'; …; frame-ancestors 'none'`, `X-Frame-Options:
  DENY`, `nosniff`, `no-store`.
- `gateway.env` wird atomar geschrieben (temporäre Datei, `fsync`,
  Umbenennen), Rechte `0600`.

Wer im Heimnetz ist, kann ein **noch nicht verbundenes** Gateway mit einem
Code verbinden – auch mit dem eines fremden GateControl. Deshalb: Gateway
starten und gleich einrichten, oder mit `GC_SETUP_PAGE=off` beim Weg über die
Datei bleiben.

## Einstellungen

| Variable (Dienst `gateway`) | Standard | Bedeutung |
|---|---|---|
| `GC_SETUP_PORT` | `8642` | Port der Seite |
| `GC_SETUP_ALT_PORT` | – | zweiter Port (Raspberry-Pi-Image: `80`) |
| `GC_SETUP_ALLOWED_HOSTS` | – | weitere erlaubte Namen in der `Host`-Zeile, mit Komma getrennt (z. B. `nas.fritz.box`) |
| `GC_SETUP_PAGE` | an | `off`: keine Seite; ohne `gateway.env` beendet sich der Container wie früher |

**Statusseite pro Gateway abschalten:** GateControl › Gateway › „Statusseite im
Heimnetz“ (Standard an). Das Gateway bekommt es im Config-Pull
(`features.setup_page.status: false`), schließt den Port und merkt es sich in
`/state/setup-page.json`. Einrichtung (keine `gateway.env`) und Zustand F
öffnen ihn trotzdem. Capability in der Telemetrie: `setup-page` (nur wenn die
Seite läuft, also nicht mit `GC_SETUP_PAGE=off`);
`telemetry.setup_page = { status, mode }`.

## Plattformen

- **Docker (Synology, Linux), Host-Netz:** nichts weiter – Port 8642 auf der
  Adresse des Geräts. `./config:/config` muss beschreibbar sein.
- **Docker, Bridge-Netz:** Port freigeben: `ports: - "8642:8642"`. Docker
  reicht Anfragen aus dem Heimnetz mit ihrer Absenderadresse durch; steht ein
  Proxy davor, lehnt die Seite ab (siehe oben).
- **Raspberry-Pi-Image:** zusätzlich Port 80. Ohne `gateway.env` startet nur
  der Dienst `gateway`; der Pi heißt dann `gatecontrol`, die Seite steht unter
  `http://gatecontrol.local` (ein im Imager oder in `settings.txt` gesetzter
  Name gilt stattdessen). Nach dem Verbinden startet
  `gatecontrol-setup.path` die übrigen Dienste; beim nächsten Start bekommt
  der Pi seinen Namen `gc-<Name des Gateways>`.
- **Proxmox-LXC:** Der Einzeiler richtet wie bisher alles ein; die Seite
  zeigt danach den Zustand (E) und fragt bei „Zugang erneuern“ nach dem Code
  (F). `gateway.env` liegt in `/etc/gatecontrol-gateway/`.

Health-Check des Containers: ohne `gateway.env` gilt er als gesund, wenn die
Seite antwortet (`/healthz`).

## Für Entwickler

`src/setup/`: `net.js` (wer darf, Eingaben), `checks.js` (Selbstprüfungen),
`pairing.js` (Einlösen, Schreiben), `controller.js` (Zustände A–F,
Versuchszähler, Erkennung „Zugang ungültig“), `server.js` (HTTP),
`ui/` (Seite). `src/index.js` startet die Seite vor allem anderen und wartet
ohne `gateway.env` auf den Code; `bootstrap()` meldet Tunnel, Heartbeat und
Config-Pull über `hooks` zurück. Tests: `tests/setup_*.test.js`.
