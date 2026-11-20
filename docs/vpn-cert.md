# Zertifikat der VPN-Namen auf dem Gateway

Gibt GateControl ein Wildcard-Zertifikat samt privatem Schlüssel an dieses
Gateway weiter, holt das Gateway beides selbst ab und legt es im
State-Verzeichnis ab. Dienste, die direkt auf dem Gateway-Rechner laufen,
können damit mit einem gültigen Zertifikat antworten.

Seit dem **Geräte-Bereich** gibt der Server nie das Wildcard der Zone
(`*.vpn.example.com`, Portal, Verwaltung, Routen) weiter, sondern ein eigenes
für den Geräte-Bereich, z. B. `*.geraete.vpn.example.com`. Das Gateway
antwortet damit unter seinem Namen in diesem Bereich (`host`, z. B.
`gw-home.geraete.vpn.example.com`, siehe [Statusseite](setup-page.md)). Ab
Gateway 1.43.0 (Capability `vpn-cert-devices`); ältere Gateways fragen beim
Abruf `server.<Bereich>` und scheitern daran.

Auf dem Server ist das **standardmäßig aus** und nur für Admins schaltbar:
Einstellungen › VPN & Netzwerk › Zertifikat für die Namen › „Zertifikat und
Schlüssel an Geräte weitergeben“, dieses Gateway unter „Darf abholen“ anhaken
(Server ab 1.308.0, Handbuch 2.12 „Zertifikat an Geräte weitergeben“).

> **Risiko:** Der Schlüssel gilt für jeden Namen unter dem weitergegebenen
> Wildcard (beim Geräte-Bereich: jedes Gerät darin). Wer ihn vom
> Gateway-Rechner liest, kann sich im VPN als jedes dieser Geräte ausgeben.
> Den Ordner nur an Dienste geben, denen du voll vertraust.

## Ablauf

1. **Bekanntgabe.** Nur ein erlaubtes Gateway bekommt im Config-Pull
   (`GET /api/v1/gateway/config`) das Feld
   `features.vpn_cert: { wildcard, zone, device_zone, server_host, host,
   fingerprint, not_after }` – nie den Schlüssel. `wildcard` ist das
   weitergegebene (`*.geraete.vpn.example.com`), `server_host` der Name, unter
   dem der Server den Abruf beantwortet (`server.vpn.example.com`), `host` der
   eigene Name des Gateways im Bereich (oder `null`). `fingerprint` ist
   SHA-256 über das DER des Zertifikats (hex, klein). Ein älterer Server schickt
   nur `{ wildcard, fingerprint, not_after }`.
2. **Abruf über den Tunnel.** Ist der Fingerabdruck neu oder anders als der
   des gespeicherten Zertifikats, fragt das Gateway
   `GET /api/v1/gateway/vpn-cert` mit seinem Gateway-Token
   (`GC_API_TOKEN`, wie der Config-Pull). Die Verbindung geht an die
   VPN-Adresse des Servers (`features.internal_dns.server`, sonst
   `GC_HUB_TUNNEL_IP`, Vorgabe `10.8.0.1`), Port 443, mit SNI und `Host`
   `server_host` – der Name der Verwaltung unter der Zone, den der Server mit
   seinem eigenen Wildcard ausliefert; fehlt das Feld (älterer Server),
   `server.<Zone aus wildcard>`. Ein `server_host`, der kein voller Name ist,
   macht die Bekanntgabe unbrauchbar (ignoriert). TLS wird voll geprüft (Kette und
   Name); als Quelle nimmt das Gateway seine Tunnel-Adresse
   (`GC_TUNNEL_IP`). Der Server gibt den Schlüssel nur an die VPN-Adresse des
   Gateways heraus (`403 not_from_vpn` sonst) und antwortet mit
   `Cache-Control: no-store`.
3. **Prüfung.** Verworfen wird, was nicht passt: Fingerabdruck des ersten
   Zertifikats der Kette ≠ `vpn_cert.fingerprint` (oder ≠ dem Feld
   `fingerprint` der Antwort) → `fingerprint_mismatch`; Schlüssel gehört nicht
   zum Zertifikat → `key_mismatch`; `wildcard` aus der Bekanntgabe fehlt in
   den Namen → `wrong_name`; abgelaufen → `expired`.
4. **Ablage** (atomar: temporäre Datei im selben Ordner, `fsync`, `rename`):

   | Gateway-Container | Host (Compose-Vorlage) | Inhalt | Rechte |
   |---|---|---|---|
   | `/state/vpn-cert/` | `./gateway-state/vpn-cert/` | Ordner | `0700` |
   | `…/fullchain.pem` | | Zertifikat und Zwischenzertifikate (PEM) | `0600` |
   | `…/privkey.pem` | | privater Schlüssel (PEM) | `0600` |
   | `…/vpn-cert.json` | | `{ wildcard, fingerprint, not_after, fetched_at }` | `0600` |

   Erst Schlüssel, dann Zertifikat, zuletzt `vpn-cert.json`. Ein Leser, der
   beide Dateien braucht, prüft am besten `fingerprint` in `vpn-cert.json`
   gegen das Zertifikat oder liest nach einer Änderung von `vpn-cert.json`
   neu ein.
5. **Erneuerung.** Erneuert der Server das Zertifikat (oder holt er einen neuen
   Schlüssel), ändert sich der Fingerabdruck; der Server meldet die Änderung,
   das Gateway holt beim nächsten Abgleich neu. Bis dahin bleibt das
   gespeicherte liegen.
6. **Wiederholung.** Schlägt ein Abruf fehl (Netz, 403/404, Prüfung), versucht
   das Gateway es mit wachsendem Abstand erneut: 30 s, 1, 2, 4 … Minuten,
   höchstens alle 30 Minuten; ein neuer Fingerabdruck in der Konfiguration
   setzt den Abstand zurück.
7. **Löschen.** Fehlt `vpn_cert` im Config-Pull (Weitergabe aus, Gateway nicht
   mehr angehakt, Zertifikat ausgeschaltet oder abgelaufen), löscht das
   Gateway alle drei Dateien und den Ordner. Nach einem Neustart gilt das
   gespeicherte Zertifikat, bis der erste Config-Pull etwas anderes sagt;
   scheitert der Pull, bleibt es liegen.

Der Schlüssel steht **nie** im Log, nie im Heartbeat und nie auf der
Statusseite. Das Log nennt Fingerabdruck, Ablauf und Fehlercodes.

## Status

- **Statusseite im Heimnetz** ([setup-page.md](setup-page.md)), Ansicht
  „Verbunden“: Zeilen „Zertifikat VPN-Namen“ (Name und Ablaufdatum bzw. „wird
  abgeholt“ / „Abruf fehlgeschlagen“), „Fingerabdruck“, „Zuletzt abgeholt“
  und bei einem Fehler „Abruf“ mit Grund und nächstem Versuch. Ohne
  Weitergabe erscheinen die Zeilen nicht. `/api/state` nennt dafür
  `vpnCert: { state, wildcard, fingerprint, notAfter, fetchedAgoS, error, retryInS }`
  (`state`: `fetching` | `ok` | `error`) – weder Schlüssel noch Pfad.
- **Heartbeat:** `telemetry.vpn_cert: { fingerprint, not_after }` des
  gespeicherten Zertifikats (sonst `null`) und die Capabilities `vpn-cert` und
  (ab 1.43.0) `vpn-cert-devices`. Der Server zeigt damit je Gateway „abgeholt“,
  „veraltet“, „noch nicht abgeholt“ oder „Gateway zu alt“ (ohne
  `vpn-cert-devices`).

## Nutzung

Welche TLS-Endpunkte hat das Gateway, und was davon nimmt das Zertifikat?

| Endpunkt | TLS heute | Wildcard | Warum |
|---|---|---|---|
| Statusseite/Einrichtung (Heimnetz, Port 8642, Pi-Image auch 80) | nein, HTTP | nein | spricht kein TLS; ein Name der Zone zeigt auf die Tunnel-Adresse des Gateways, und Anfragen aus dem Tunnel nimmt die Seite bewusst nicht an |
| Statusseite aus dem VPN (Tunnel-IP:8643, Standard aus) | ja | **ja** | `https://<name>.<Bereich des Wildcards>:8643`, nur lesen, Anmeldung über GateControl (Einmal-Ticket) – [setup-page.md](setup-page.md) „Aus dem VPN per HTTPS“ |
| Management-API (Tunnel-IP:9876) | nein, HTTP | nein | nur der Server spricht sie, Token im Tunnel |
| HTTP-Proxy (Tunnel-IP:8080) | nein | nein | TLS endet in Caddy auf dem Server |
| Zwischenspeicher im Heimnetz (HTTPS) | ja, selbst erzeugt | nein | Apps pinnen den Fingerabdruck (`cache.tlsSha256`); ein Wechsel alle 60–90 Tage bräche das Pinning |
| MQTT-TLS (8883, Edge) | ja, selbst erzeugt | nein | Geräte pinnen Fingerabdruck oder eigenes Zertifikat; dieselbe Folge |
| Edge-Plugins, Kameras, Drucken | nur als Client | – | prüfen fremde Zertifikate |

Außer der Statusseite aus dem VPN (eingeschaltet, mit Anmeldung über GateControl)
bietet das Gateway das Zertifikat deshalb an keinem eigenen Endpunkt an,
sondern stellt die Dateien unter dem Pfad oben bereit. Ein eigener Dienst auf
dem Gateway-Rechner bindet den Ordner **nur lesbar** ein, z. B. in einer
eigenen Compose-Datei neben dem Gateway:

```yaml
services:
  mein-dienst:
    image: example/mein-dienst:1.0
    volumes:
      - ./gateway-state/vpn-cert:/certs/vpn:ro
    # liest /certs/vpn/fullchain.pem und /certs/vpn/privkey.pem
```

Die Dateien gehören dem Benutzer des Gateway-Containers und sind nur für ihn
lesbar (`0600`, Ordner `0700`). Ein Dienst mit einer anderen UID kann sie nicht
lesen – Absicht: wer den Schlüssel bekommt, entscheidest du bewusst (gleiche
UID oder ein eigener Kopierschritt mit passenden Rechten). Der Dienst muss ein
neues Zertifikat selbst bemerken (Änderung von `vpn-cert.json`) und neu laden.

Der Name, unter dem der Dienst antwortet, muss im VPN auf seine Adresse zeigen:
Namen der Zone löst der DNS des Servers auf (Gerätenamen, Routen); im
Heimnetz beantwortet sie der DNS-Filter des Gateways über den Tunnel
([dns-cache.md](dns-cache.md) „Namen im VPN“).

## Technik

- `src/vpncert/vpnCert.js` – `VpnCertManager` (`apply(features.vpn_cert,
  { serverIp })`, `status()`, `telemetry()`), Prüfung `verifyMaterial`,
  Abruf `fetchOverTunnel`, `writeAtomic`.
- `src/bootstrap.js` – ruft `apply` bei jeder neuen Konfiguration, hängt
  `telemetry()` an den Heartbeat und `status()` an die Statusseite.
- `src/setup/controller.js` (`hooks.attachVpnCert`, `vpnCert` in
  `snapshot`), `src/setup/ui/setup.js` (Zeilen in „Verbunden“).
- Tests: `tests/vpn_cert.test.js` (Prüfung, Ablage und Rechte, Löschen,
  Backoff, Neustart, Statusseite) und `tests/integration/vpn-cert-flow.test.js`
  (nachgebauter Server mit HTTPS: SNI/Host, Token, Quelladresse,
  Erneuerung, `not_from_vpn` mit Wiederholung, Löschen).
