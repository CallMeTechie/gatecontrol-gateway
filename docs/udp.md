# UDP-Routen über das Gateway

Ab dieser Fassung leitet das Gateway neben TCP auch **UDP** weiter. Eine
TCP/UDP-Route mit Protokoll UDP und einem Gateway oder Gateway-Pool als Ziel
funktioniert damit wie eine TCP-Route: GateControl (Caddy mit caddy-l4) nimmt
die Datagramme am öffentlichen Port an und schickt sie durch den Tunnel an
`<Tunnel-IP>:<Listen-Port>` des Gateways, das sie an das Gerät im Heimnetz
weitergibt – und die Antworten denselben Weg zurück.

Typische Anwendungen: ein DNS-Server im Heimnetz (Port 53), Spieleserver
(z. B. 27015), VoIP/SIP, Syslog, NTP, ein eigener WireGuard- oder
OpenVPN-Server hinter dem Gateway.

## Woran der Server erkennt, dass das Gateway UDP kann

Das Gateway nennt im Heartbeat die Capability **`udp-routes`**
(`telemetry.capabilities`). Nur einem solchen Gateway schickt der Server die
UDP-Routen – im Config-Pull als eigenes Feld `udp_routes`:

```json
"udp_routes": [
  { "id": 12, "listen_port": 5353, "target_lan_host": "192.168.1.20", "target_lan_port": 53 }
]
```

`l4_routes` enthält weiterhin nur die TCP-Routen. Ein älteres Gateway bekommt
`udp_routes` nicht und rechnet den Hash wie bisher; ein älterer Server schickt
das Feld nicht, dann bleibt alles wie zuvor.

Config-Hash: Das Schema der gemeinsamen Hash-Bibliothek kennt `udp_routes`
nicht. Wie bei `features` kommt das Feld deshalb danach dazu (Server und
Gateway rechnen gleich, `src/features/config.js`):

```
h = Bibliotheks-Hash (ohne features, ohne udp_routes)
h = 'sha256:' + sha256(h + '\n' + stableJson(features))          // wenn features da
h = 'sha256:' + sha256(h + '\nudp_routes\n' + stableJson(udp_routes)) // wenn udp_routes da
```

Nach dem Update eines Gateways meldet der nächste Heartbeat die Capability;
der Server liefert ab dann `udp_routes`, der Hash ändert sich, und das Gateway
holt die Konfiguration beim nächsten Abgleich. **Bestehende UDP-Routen über
dieses Gateway funktionieren danach ohne weiteres Zutun.**

## Wie die Weiterleitung arbeitet

UDP kennt keine Verbindung. Das Gateway führt deshalb eine **Zuordnung je
Absender** (Quell-IP und Quellport, aus Sicht des Gateways: eine Sitzung von
Caddy auf dem Server):

- Für jeden neuen Absender öffnet das Gateway einen eigenen Socket zum Ziel
  (`target_lan_host:target_lan_port`). Antworten des Ziels kommen auf diesem
  Socket an und gehen genau an diesen Absender zurück – zwei Clients bekommen
  nie die Antworten des anderen.
- Der Socket ist mit dem Ziel verbunden (`connect`): angenommen werden nur
  Datagramme von genau dieser Adresse und diesem Port. Ein anderes Gerät im
  Heimnetz kann nichts in eine Zuordnung schieben.
- Ein Zielname (z. B. `nas.fritz.box`) wird beim Öffnen der Zuordnung
  aufgelöst (IPv4); eine IPv6-Adresse als Ziel geht ebenfalls.

### Leerlauf und Obergrenze

| Einstellung | Standard | Bereich | Bedeutung |
|---|---|---|---|
| `GC_UDP_IDLE_TIMEOUT_S` | 60 | 5–3600 | Eine Zuordnung ohne Datagramm in beide Richtungen wird nach dieser Zeit geschlossen. 60 s reichen für DNS (Frage/Antwort in Millisekunden) und halten Spiele- oder VoIP-Sitzungen mit gelegentlichen Paketen offen. |
| `GC_UDP_MAX_SESSIONS` | 1024 | 16–65535 | Höchstzahl gleichzeitiger Zuordnungen **je Route**. Ist sie erreicht, gibt das Gateway die am längsten ruhende Zuordnung frei, wenn sie mindestens 2 s ruht; sonst wird das neue Datagramm verworfen (Zähler `dropped_limit`). |

Beide Werte kommen aus der Umgebung des Containers (Compose-Datei, Abschnitt
`environment` des Dienstes `gateway`); ungültige Werte fallen auf den Standard
zurück. Jede Zuordnung belegt einen Socket – die Obergrenze schützt das Gateway
(und den Kleinrechner, auf dem es läuft) vor einer Flut neuer Absender.

### Fehler

- **Ziel antwortet mit ICMP „port unreachable“** (kein Dienst auf dem Port):
  die Zuordnung wird geschlossen (Zähler `icmp_unreachable`); das nächste
  Datagramm dieses Absenders versucht es mit einer neuen.
- **Ziel nicht erreichbar, Name unbekannt, Senden abgelehnt:** ebenso
  geschlossen (Zähler `upstream_errors`). Der Client merkt es wie bei UDP
  üblich an der ausbleibenden Antwort.
- **Listen-Port belegt / keine Berechtigung:** die Route bekommt keinen
  Listener, der Grund steht im Heartbeat (`l4_listener_issues[]` mit
  `protocol: 'udp'`, `reason` wie bei TCP) und das Gateway gilt als
  „degradiert“. Mit jedem Heartbeat versucht es erneut, den Port zu binden.
  Andere Routen laufen weiter.
- **Ziel ist dieser Host auf demselben Port** und der Dienst hält den Port
  bereits (Gateway im Host-Netz): wie bei TCP kein Fehler – der Server
  erreicht den Dienst dort direkt (`l4_listeners_direct[]` mit
  `protocol: 'udp'`). Eine Probe gibt es dafür nicht, ein UDP-Dienst muss auf
  ein leeres Datagramm nicht antworten.

## Nicht unterstützt: Broadcast und Multicast

Bewusst **nicht** unterstützt sind Broadcast und Multicast:

- Eine Route zu `255.255.255.255`, `0.0.0.0`, einer Multicast-Adresse
  (`224.0.0.0/4`, `ff00::/8`) oder `::` bekommt keinen Listener; im Heartbeat
  steht `reason: 'error'`, `code: 'UNSUPPORTED_TARGET'`.
- Die Broadcast-Adresse eines Netzes (z. B. `192.168.1.255`) lehnt der Kernel
  beim Senden ab, weil das Gateway kein `SO_BROADCAST` setzt (Zähler
  `upstream_errors`).

Dienste, die auf Broadcast oder Multicast im Heimnetz angewiesen sind (mDNS,
SSDP/UPnP-Suche, Wake-on-LAN, Spiele-Suche im LAN), funktionieren über eine
UDP-Route nicht. Für Wake-on-LAN gibt es die eigene Funktion des Gateways, für
mDNS/SSDP in Plugins den Edge-Container ([edge.md](edge.md)).

## Zähler im Heartbeat

Neben den Feldern für TCP meldet das Gateway je UDP-Listener (höchstens 10
Einträge):

```json
"udp_listeners": [
  { "route_id": 12, "listen_port": 5353, "sessions": 3, "sessions_total": 41,
    "datagrams_in": 120, "datagrams_out": 118, "bytes_in": 5400, "bytes_out": 9100,
    "dropped_limit": 0, "evicted": 0, "icmp_unreachable": 1, "upstream_errors": 0, "idle_closed": 38 }
]
```

`in` = vom Server ans Ziel, `out` = Antworten des Ziels zurück. Die Zähler
beginnen beim Start des Listeners neu. UDP-Routen zählen in
`l4_routes_configured` und `l4_listeners_missing` mit; in
`route_reachability` stehen sie nicht (eine TCP-Probe sagt über einen
UDP-Dienst nichts).

## Code und Tests

- `src/proxy/udp.js` – `UdpProxyManager`, `normalizeUdpRoutes`, `udpOptionsFromEnv`
- `src/sync/configStore.js` (`udpRoutes`), `src/bootstrap.js`, `src/health/selfCheck*.js`
- `tests/proxy_udp.test.js` – echte Sockets: Echo, Zuordnung je Absender, eine
  DNS-Anfrage über den Resolver von Node, ICMP unreachable, Leerlauf,
  Obergrenze, Port belegt, Multicast-Ziel, Selbstziel
- `tests/udp_routes_config.test.js` – Hash, ConfigStore, Capability, Selbstprüfung
