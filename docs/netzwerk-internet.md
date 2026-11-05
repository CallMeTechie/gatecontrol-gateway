# Netzwerk-Wächter, Internetqualität, Anwesenheit, USV (Phase 3a)

Vier Funktionen im Gateway-Prozess, die der Server pro Gateway ein- und
ausschaltet (Karte „Funktionen“, Reiter „Netzwerk“ und „Internet“). Keine
neuen Abhängigkeiten, kein eigener Container, keine Raw-Sockets aus Node.

| Funktion | Takt | Bericht an den Server | Zustand in `/state` |
|---|---|---|---|
| Netzwerk-Wächter | Sweep alle 5 Min., Portscan neue Geräte sofort + nachts 02–05 Uhr | `POST /api/v1/gateway/netwatch` | `netwatch.json` |
| Anwesenheit | alle 60 s | `POST /api/v1/gateway/presence` (nur Übergänge) | – (nur im Speicher) |
| Internetqualität | Messung alle 60 s (bei Verdacht auf Ausfall alle 10 s), 5-Min.-Werte, Speedtest nach Plan | `POST /api/v1/gateway/inetq` | `inetq-buffer.json` |
| USV (NUT) | alle 30 s | Heartbeat `telemetry.ups` | – |

Alle Berichte mit dem Gateway-Token (`Authorization: Bearer gc_gw_…`), Zeiten
als Epoch-Millisekunden. Vertrag: Phase 3a (Gateway ↔ Server), Felder und
Grenzen siehe dort.

## Funktionsschalter

Der Server schickt im Config-Pull `/api/v1/gateway/config` ein Objekt
`features` (fließt in den Config-Hash, dadurch holt das Gateway die neue
Konfiguration sofort beim nächsten Hash-Vergleich):

```js
features: {
  netwatch: { enabled, portscan },
  inetq:    { enabled, speedtest: 'off' | '4x' | 'hourly', targets?: ['1.1.1.1', …] },
  presence: { enabled, macs: ['aa:bb:…'], awayAfterSec?: 600 },
  ups:      { enabled, host, port: 3493, name: null | 'ups' },
}
```

**Fehlt `features` (älterer Server), ist alles aus** – das Gateway verhält sich
wie bisher. Alle Werte werden geprüft und begrenzt (`src/features/config.js`):
MACs normalisiert, höchstens 256; höchstens 4 Messziele (keine Loopback-,
Null- oder Multicast-Adressen); `awayAfterSec` 60–3600; USV-Name nur
`[A-Za-z0-9_.-]`.

Hash: ohne `features` der Bibliotheks-Hash wie bisher, mit `features`
`'sha256:' + sha256(libHash + '\n' + stableJson(features))` (Objektschlüssel
rekursiv sortiert). Das Gateway rechnet nur zur Kontrolle nach (Warnung im
Log bei Abweichung) und speichert den Hash des Servers.

## Netzwerk-Wächter (`src/netwatch/`)

**Sweep** über die eigenen privaten LAN-Subnetze (dieselbe Schnittstellen-Logik
wie LAN-Erkennung und Telemetrie, `lanSubnets`). Subnetze größer als
`GC_DISCOVERY_MAX_PREFIX` (Standard /22) werden nur im /24 um die eigene Adresse
abgesucht.

So findet das Gateway Geräte ohne Raw-Sockets: Es schickt jedem Host eine
kleine Unicast-mDNS-Anfrage (Rückwärtsauflösung der Adresse, UDP 5353). Dafür
muss der Kernel die MAC per ARP auflösen; ein schon bekannter, veralteter
Eintrag wird per Unicast-ARP nachgeprüft. Nach 6,5 s liest das Gateway die
Nachbartabelle (`ip -j -4 neigh`, iproute2 im Image): **REACHABLE = online**.
Antwortet ein Gerät zusätzlich per mDNS, kommt sein Name gleich mit. Höchstens
256 offene Auflösungen gleichzeitig (Kernel-Grenze `gc_thresh3`). Ohne `ip`
(Entwicklungsrechner) bleibt `/proc/net/arp` – gröber, Telemetrie
`degraded: 'no_neighbor_states'`.

**Namen**, in dieser Reihenfolge: mDNS (Antwort auf die Rückwärtsanfrage,
z. B. `Marcs-iPhone`), NetBIOS-Knotenstatus (UDP 137: Windows, Samba/NAS,
Drucker), Rückwärts-DNS über den Resolver des Hosts (Heimrouter wie die
FRITZ!Box tragen dort die DHCP-Namen ein). Erneut gesucht wird höchstens alle
6 Std. je Gerät. Einen echten DHCP-Mitschnitt gibt es nicht (das Gateway ist
nicht der DHCP-Server).

**Hersteller** aus `src/netwatch/oui.txt` (offline im Image). Quelle: die
öffentliche IEEE-Liste der MA-L-Zuteilungen
(`https://standards-oui.ieee.org/oui/oui.csv`, IEEE Registration Authority;
öffentlich und kostenlos bereitgestellt, ohne Lizenzbedingungen in der Datei –
dieselbe Liste verteilen u. a. Wireshark, nmap und `hwdata` mit). Gekürzt auf
`AABBCC<TAB>Name` (Rechtsformen entfernt, ≤ 48 Zeichen), ≈ 40 000 Einträge,
≈ 1 MB. Zur Laufzeit bleibt die Datei ein Buffer (außerhalb des JS-Heaps),
gesucht wird binär. MA-M/MA-S-Unterblöcke (28/36 Bit) sind nicht enthalten.
Aktualisieren:

```sh
curl -fsSLo /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
node scripts/update-oui.js /tmp/oui.csv   # schreibt src/netwatch/oui.txt
```

**`randomMac`** = Locally-administered-Bit gesetzt (private WLAN-Adresse von
Handys).

**Portscan** (wenn `portscan`): feste Liste von 39 Ports (`src/netwatch/ports.js`),
TCP-Connect mit 700 ms Zeitlimit, höchstens 16 Verbindungen gleichzeitig,
**nur RFC-1918-Ziele, nie die Tunnel-Adresse, nie eigene Adressen**. Neu
gesehene (bzw. noch nie gescannte) Geräte sofort, alle Online-Geräte einmal
täglich zu einer zufälligen Minute zwischen 02:00 und 04:59 Ortszeit; „Jetzt
scannen“ mit `{ ports: true }` scannt zusätzlich alle Online-Geräte.

**Bericht**: vollständig beim ersten Bericht nach dem Start, nach einem
fehlgeschlagenen Bericht und spätestens alle 30 Min., sonst nur geänderte
Geräte (`lastSeen` allein ist keine Änderung). Geräte, die 30 Tage nicht
gesehen wurden, vergisst das Gateway; höchstens 1024.

**Mgmt-API**: `POST /api/netwatch/scan` (über den Tunnel, `X-Gateway-Token`)
→ 202 `{ accepted: true }`, 409 `{ error: 'scan_in_progress' }`, 503
`{ error: 'feature_disabled' }`.

## Anwesenheit (`src/presence/`)

Nur die MACs, die der Server in `features.presence.macs` schickt (Personen, die
zugestimmt haben). Jede Minute:

1. Eintrag mit dieser MAC in der Nachbartabelle **REACHABLE** → da.
2. Sonst die bekannten Adressen (Nachbartabelle, letzter Fund, Netzwerk-Wächter)
   gezielt prüfen: Unicast-mDNS-Anfrage → Kernel prüft per Unicast-ARP nach.
   Schlafende iPhones antworten auf Ping meist nicht, auf ARP schon.
3. Gar keine Adresse bekannt: Sweep, höchstens alle 10 Min. – nur wenn der
   Netzwerk-Wächter aus ist (sonst sucht der ohnehin alle 5 Min.).

„online“ wird sofort gemeldet, „offline“ erst nach `awayAfterSec` (Standard
600 s) ohne Lebenszeichen. Ereignis `{ mac, online, at, lastSeen }`; nicht
zustellbare Ereignisse werden (bis 256) beim nächsten Lauf erneut gesendet. Nach
einem Neustart ist der Zustand unbekannt und wird neu gemeldet. Gerät mit
täglich wechselnder privater WLAN-Adresse wird nicht wiedererkannt (Hinweis in
der Server-Oberfläche).

## Internetqualität (`src/inetq/`)

**Messung** jede Minute (bei Verdacht auf Ausfall alle 10 s), parallel:
Router (Default-Gateway, 3 × ICMP), öffentliche Ziele (Standard `1.1.1.1` und
`9.9.9.9`, je 5 × ICMP im Abstand 0,2 s), Server (TCP-Verbindungsaufbau zu
Host/Port der `serverUrl`). ICMP über das `ping` aus iputils (der Container
hat `NET_RAW` ohnehin für keepalived); fehlt es oder darf es nicht, dauerhaft
TCP-Connect (Port 53/443/80, eine Ablehnung zählt als Antwort).

**5-Min.-Werte** (an der Uhr ausgerichtet) `{ t, rttRouterMs, rttInetMs,
lossInetPct, rttServerMs, n }`, fehlende Werte `null`.

**Ausfall** = alle öffentlichen Ziele ≥ 60 s ohne Antwort; Ursache `router`,
wenn währenddessen auch der Router nicht antwortete, sonst `isp`. Ende = erste
erfolgreiche Messung (war das Gateway selbst länger als 10 Min. aus, endet der
Ausfall bei der letzten „weg“-Messung). Laufende Ausfälle gehen mit
`end: null` mit und werden mit `end` erneut gemeldet.

**Puffer**: Alles Ungesendete liegt in `/state/inetq-buffer.json` (bis 7 Tage
= 2016 Werte, 200 Ausfälle, 50 Speedtests) und übersteht Ausfall und Neustart.
Bericht alle 5 Min., sofort nach einem Speedtest und nach Ende eines Ausfalls,
je Bericht ≤ 600 Werte; bestätigte Einträge fliegen aus dem Puffer.

**Speedtest** gegen den eigenen Server über die öffentliche `serverUrl` (nicht
durch den Tunnel): 4 parallele Streams, je Richtung 10 s
(`GET /api/v1/gateway/speedtest/down?bytes=25000000` wiederholt,
`POST /api/v1/gateway/speedtest/up` mit 8 MB je Anfrage), die erste Sekunde
zählt nicht. Ergebnis `{ at, downMbps, upMbps, bytes, streams, error? }`.
Plan `4x` = 00/06/12/18 Uhr Ortszeit + Zufallsminute, `hourly` = jede Stunde +
Zufallsminute, nicht während eines Ausfalls; während des Tests wird nicht
gemessen. „Jetzt messen“: `POST /api/inetq/speedtest` → 202 / 409
`speedtest_running` / 503 `feature_disabled`. Volumen: ≈ 10 s × Rate × 2
(300 Mbit/s ≈ 750 MB); der Server begrenzt auf 3 GB je 24 h (`error: 'budget'`).
Pi 3 B+: Ethernet hängt am USB 2.0, höchstens ca. 300 Mbit/s.

## USV (`src/ups/nut.js`)

NUT-Client ohne Anmeldung: `LIST UPS` (wenn kein Name gesetzt: die erste),
`LIST VAR <name>`, `LOGOUT`. Ziel nur RFC 1918 (auch ein Hostname muss auf eine
private Adresse auflösen). Ergebnis im Heartbeat:

```js
telemetry.ups = { name, status: 'OL' | 'OB LB' | …, charge, runtimeSec, model, mfr, at }
             | { error: 'not_private'|'connect'|'timeout'|'no_ups'|'nut_error:<Code>'|'protocol', at }
             | null   // aus
```

Synology: Systemsteuerung → Hardware & Energie → USV → „Netzwerk-USV-Server
aktivieren“ und die LAN-Adresse des Gateways bei den zugelassenen Geräten
eintragen.

## Telemetrie

Im Heartbeat zusätzlich:

- `capabilities: ['netwatch', 'inetq', 'presence', 'ups']`
- `features.{netwatch,inetq,presence,ups}`: `{ enabled, running, lastRunAt,
  lastOkAt, lastError: { at, message } | null, … }` mit Extras (Geräte/online,
  nächster Portscan; aktuelle Messung, laufender Ausfall, Puffer, nächster und
  letzter Speedtest, Messart icmp/tcp; Anzahl verfolgter und anwesender Geräte;
  USV-Ziel)
- `ups` (s. o.)
- `process_mem: { rss, heapUsed }` des Gateway-Prozesses

## Ortszeit

Portscan-Fenster und Speedtest-Plan richten sich nach der Umgebungsvariable
`TZ` des Gateway-Containers (Node bringt die Zeitzonendaten selbst mit). Das
Pi-Image reicht die eingestellte Zeitzone (`TIMEZONE` in `settings.txt`) über
`.env` durch; bei Docker/Synology `TZ=Europe/Berlin` in der Compose-Datei setzen,
sonst gilt UTC.

## Rechte und Ressourcen

- Keine neuen Capabilities: ARP/Nachbartabelle ohne Raw-Socket (UDP-Anstoß +
  `ip neigh`), ICMP über `ping` mit dem schon vorhandenen `NET_RAW`.
- Gemessen (Node 20, Alpine, alle vier Funktionen an, gefälschter Server):
  dauerhaft ≈ +2 MB (JS-Heap + Buffer, davon ≈ 1,2 MB Herstellerliste), RSS
  innerhalb der Messschwankung unverändert; Sweep kurzzeitig ≈ +10 MB RSS.
  **Speedtest kurzzeitig ≈ +30 MB RSS** bei 330 Mbit/s (Empfangspuffer, bis
  zur nächsten Speicherbereinigung), danach wieder auf dem Ausgangswert.
- Netzlast: Sweep eines /24 = 254 kleine UDP-Pakete alle 5 Min.; Portscan
  nachts ≈ 39 Verbindungsversuche je Gerät.
