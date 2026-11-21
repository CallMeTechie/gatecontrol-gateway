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
- **VPN-Gerät vorhanden** – `/dev/net/tun` lässt sich öffnen oder der Kernel
  kann WireGuard selbst. Das Gateway legt das Gerät nicht selbst an.
- **Ordner config beschreibbar** – echte Schreibprobe.

Geprüft wird nur, während jemand die Seite offen hat.

**„VPN-Gerät fehlt“:** Die Compose-Datei bindet das Gerät wie bisher mit
`devices: - /dev/net/tun:/dev/net/tun` ein. Die Meldung erscheint, wenn der
Container läuft, das Gerät aber fehlt oder nicht nutzbar ist – etwa in einem
Proxmox-LXC ohne durchgereichtes Gerät, bei einer eigenen Compose-Datei ohne
`devices` oder wenn das Modul `tun` am Rechner nicht geladen ist
(`sudo modprobe tun`).

**Synology:** Dort hilft die Seite bei diesem Punkt **nicht** – fehlt
`/dev/net/tun` am Host, startet Docker den Container gar nicht erst (Meldung
mit `/dev/net/tun` im Container Manager), und die Seite ist nicht erreichbar.
Dafür gibt es eine Aufgabe für den Aufgabenplaner (ohne SSH, Benutzer `root`,
Ereignis „Hochfahren“): Sie lädt das Modul `tun`, legt das Gerät an und startet
danach das Gateway – auch nach jedem Neustart der NAS. Skript und Erklärung:
[Synology › Aufgabe für `/dev/net/tun`](deployment/synology.md#aufgabe-für-devnettun).
Auf manchen Geräten (im Test: DS918+) ist das Gerät ohnehin da, auf anderen
(im Test: DS218+) nicht.

Läuft der Container und die Seite meldet trotzdem „VPN-Gerät fehlt“, zeigt sie
dasselbe Skript zum Kopieren.

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

## Aus dem VPN per HTTPS

Zusätzlich lässt sich die **Statusseite** (nicht die Einrichtung) aus dem VPN
öffnen, unter dem Namen des Gateways in dem Bereich, für den das
weitergegebene Wildcard-Zertifikat gilt:

```
https://<Name des Gateways>.<Bereich>:8643     z. B. https://gw-keller.geraete.vpn.example.com:8643
```

Der Bereich ist nicht fest verdrahtet. Er kommt aus dem Namen des Wildcards in
`features.vpn_cert.wildcard`: `*.geraete.vpn.example.com` ergibt
`geraete.vpn.example.com`. Weitergegeben wird das Geräte-Wildcard
(`*.<label>.<zone>`, Label in GateControl einstellbar, Standard `geraete`),
nicht das Wildcard der Zone selbst.

**Standard aus.** Eingeschaltet wird sie in GateControl beim Gateway
(„Statusseite im VPN (HTTPS)“). Das Gateway bekommt dann im Config-Pull
`features.setup_page: { status, vpn_https: true, vpn_name }`: `vpn_name` ist
der Name des Gateways unter „Namen im VPN“ (ein DNS-Label). GateControl löst
`<Name>.<Bereich>` im VPN auf die Tunnel-Adresse des Gateways auf.

Der Port ist nur offen, wenn alles zusammenkommt:

| Bedingung | sonst (`telemetry.setup_page.vpn_https.state`) |
|---|---|
| eingeschaltet | `off` |
| Name gesetzt (ein DNS-Label) | `no_name` |
| gültiges weitergegebenes Wildcard-Zertifikat liegt vor ([vpn-cert.md](vpn-cert.md): Weitergabe an dieses Gateway eingeschaltet) | `no_cert` |
| Port frei (z. B. keine TCP-Route auf 8643 an der Tunnel-Adresse) | `port_in_use`, neuer Versuch jede Minute |

Läuft sie, ist der Zustand `listening`. Ein erneuertes Zertifikat nimmt die
Seite ohne Neustart des Ports. Fehlt es oder ist es abgelaufen, wird der Port
geschlossen.

**Anmeldung nur über GateControl.** Das Gateway kennt keine eigenen Konten
oder Passwörter. In GateControl öffnet ein Admin die Seite mit „Im VPN öffnen“.
Dafür gilt die Anmeldung am Server, mit 2FA, wenn sie eingerichtet ist. Der
Server

1. erzeugt ein zufälliges Einmal-Ticket (32 Byte),
2. legt über die Management-API (Tunnel, Gateway-Token) **nur dessen SHA-256**
   ab: `POST /api/status-page/ticket { ticket_sha256, ttl_s }`, Antwort
   `{ ok, host, port, expires_in_s }` bzw. `409 { error: not_enabled |
   no_name | no_cert | port_in_use | … }`. Das Ticket gilt höchstens 120 s
   (Standard 60 s), es liegen höchstens 8 offen.
3. schickt den Browser nach `https://<host>:<port>/login?t=<ticket>`.

Das Gateway löst das Ticket genau einmal ein und setzt ein Sitzungs-Cookie
`__Host-gc_status` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`).
Die Sitzung endet nach **30 Minuten** ohne Abruf, spätestens nach **8 Stunden**,
mit „Abmelden“ oder wenn die Seite abgeschaltet wird. Die offene Seite fragt
alle 5 s nach und hält die Sitzung damit wach, bis die 8 Stunden um sind.
Sitzungen und Tickets liegen nur im Speicher, gehasht, höchstens 32 Sitzungen.
Nach einem Neustart des Gateways meldet man sich neu an. Nach einer Antwort auf
`/login` lädt die Seite per `meta refresh` neu und nicht per Redirect: Bei einer
Weiterleitung innerhalb einer Navigation von außen schickte der Browser das
`SameSite=Strict`-Cookie nicht mit.

**Schutz:**

- Port nur an der **Tunnel-Adresse** (`GC_TUNNEL_IP`). Angenommen werden nur
  Absender aus dem VPN (`WG_ADDRESS`/`WG_ALLOWED_IPS`, ohne `0.0.0.0/0`), nicht
  die eigene Tunnel-Adresse. Alles andere wird vor dem TLS-Handshake
  geschlossen.
- SNI **und** `Host` genau `<name>.<Bereich>`, sonst `421`. Proxy-Kopfzeilen →
  `403`.
- Ohne Sitzung gibt es nur einen Hinweis (`401`), auch nicht die Dateien der
  Seite. Höchstens 20 fehlgeschlagene Anmeldungen je Minute (dann `429`).
- **Nur lesen:** kein `/api/pair`, die Selbstprüfungen werden nicht
  angestoßen, `/api/state` ohne CSRF-Token und ohne Einrichtungsteil
  (`readOnly: true`, `via: "vpn"`). Ist das Gateway im Zustand A/F, sagt die
  Seite nur, dass das Einrichten im Heimnetz geht.
- Kopfzeilen wie im Heimnetz, dazu `Strict-Transport-Security:
  max-age=31536000` (ohne Subdomains).
- Ticket, Cookie und Schlüssel stehen nie im Log oder Heartbeat. Telemetrie:
  `telemetry.setup_page.vpn_https = { enabled, state, host, port, sessions }`,
  Capability `setup-page-vpn`.

Die Seite im Heimnetz (Port 8642) ändert sich nicht. Sie nimmt weiter nichts
aus dem Tunnel an. Mit `GC_SETUP_PAGE=off` gibt es auch die Seite im VPN nicht.

## Einstellungen

| Variable (Dienst `gateway`) | Standard | Bedeutung |
|---|---|---|
| `GC_SETUP_PORT` | `8642` | Port der Seite |
| `GC_SETUP_ALT_PORT` | – | zweiter Port (Raspberry-Pi-Image: `80`) |
| `GC_SETUP_VPN_PORT` | `8643` | Port der Statusseite aus dem VPN (HTTPS, nur Tunnel-Adresse), siehe oben |
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
`vpnHttps.js` (HTTPS aus dem VPN, Ticket und Sitzung), `ui/` (Seite);
`src/api/routes/statusPage.js` (Ticket über die Management-API). `src/index.js` startet die Seite vor allem anderen und wartet
ohne `gateway.env` auf den Code; `bootstrap()` meldet Tunnel, Heartbeat und
Config-Pull über `hooks` zurück. Tests: `tests/setup_*.test.js` (aus dem VPN: `tests/setup_vpn_https.test.js`).
