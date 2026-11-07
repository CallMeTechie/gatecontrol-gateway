# DNS-Filter und Zwischenspeicher im Heimnetz (Phase 3b)

Zwei Funktionen im Gateway-Prozess, die der Server pro Gateway über
`features` im Config-Pull ein- und ausschaltet (Reiter „DNS-Filter“ und
„Zwischenspeicher“). Fehlt `features.dns` bzw. `features.cache`, ist die
Funktion aus. Keine neuen Abhängigkeiten, kein eigener Container, keine neuen
Capabilities (Port 53 deckt das vorhandene `NET_BIND_SERVICE` ab).

| Funktion | Port (nur LAN-Adressen, nie Tunnel) | Bericht an den Server | Zustand in `/state` |
|---|---|---|---|
| DNS-Filter | 53 UDP + TCP | `POST /api/v1/gateway/dns` alle 5 Min. | `dns-lists/` (Listen + `meta.json`), `features-boot.json` |
| Zwischenspeicher | 8443 TCP (HTTPS) | `POST /api/v1/gateway/cache` alle 5 Min. und nach Downloads | `cache-tls/` (Zertifikat); Blobs unter `/cache` |
| Datenträger | – | Heartbeat `telemetry.storage` | – |
| Zeitzone | – | Heartbeat `telemetry.timezone` | `features-boot.json` |

## DNS-Filter

### Ablauf einer Anfrage

1. **Client → Profil:** MAC aus der Nachbartabelle des Kernels
   (`ip -j neigh`, IPv4 und IPv6; neu gelesen bei unbekannter IP höchstens alle
   5 s, sonst jede Minute). MAC in `profiles[].macs` → dieses Profil, sonst
   `defaultProfile`. Ohne Profile wird nichts gefiltert (Pausen gelten trotzdem).
2. **Entscheidung** (`src/dns/policy.js`), in dieser Reihenfolge:
   1. lokale Namen → direkt an den Router, nie gefiltert: Namen ohne Punkt,
      `local`, `lan`, `home`, `home.arpa`, `internal`, `localdomain`,
      `fritz.box`, `speedport.ip`, die Suchdomänen aus `/etc/resolv.conf` und
      die Rückwärtszonen privater Netze (`10.in-addr.arpa`, `168.192.…`,
      `fd/fc/fe8…fea.ip6.arpa`)
   2. `alwaysAllow` (+ Host der `serverUrl`) → erlaubt
   3. Profil-`allow` → erlaubt (auch in Pause und Zeiten)
   4. Pause der MAC → gesperrt (`reason: 'paused'`)
   5. Profil-`deny` → gesperrt
   6. aktive Zeit-Regel (außer Verlängerung der MAC): `allowAlways` der Regel
      erlaubt, `block: 'all'` sperrt alles, `block: 'categories'` die Domains
      der genannten Kategorien
   7. Listen des Profils (Adblock-Ausnahmen `@@||…^` heben die Sperre derselben Liste auf)
   8. sonst erlaubt; mit `safeSearch` Umschreibung der Suchmaschinen
3. **Antwort:** gesperrt → `A 0.0.0.0` / `AAAA ::` (TTL 60), andere Typen
   leer (NOERROR); mit EDNS zusätzlich Extended DNS Error 15 „Blocked“.
   Intern umschaltbar auf NXDOMAIN (`blockResponse: 'nxdomain'`).
   `use-application-dns.net` bekommt immer NXDOMAIN (Firefox schaltet dann sein
   eigenes DoH ab und fragt den Filter).
4. **Weiterleitung** erlaubter Anfragen: DNS über HTTPS (RFC 8484, HTTP/2,
   eine Verbindung, `POST application/dns-message`). Bekannte Anbieter über
   feste Adressen, TLS-Prüfung gegen den Hostnamen – so braucht die
   Weiterleitung selbst kein DNS, auch wenn der Gateway-Host auf den Filter
   zeigt:

   | `provider` | URL | Adressen |
   |---|---|---|
   | `quad9` (Standard) | `https://dns.quad9.net/dns-query` | 9.9.9.9, 149.112.112.112 |
   | `cloudflare` | `https://cloudflare-dns.com/dns-query` | 1.1.1.1, 1.0.0.1 |
   | `dns0` | `https://dns0.eu/dns-query` | 193.110.81.0, 185.253.5.0 (Dienst eingestellt, antwortet 403 → Rückfall) |
   | `custom` | `upstream.url` (nur `https://`) | Hostname über den Router aufgelöst |

   Scheitert DoH und ist `fallbackRouter` an, fragt das Gateway den Router
   (Default-Gateway) über UDP 53, bei abgeschnittener Antwort über TCP. Nach
   drei DoH-Fehlern in Folge gehen Anfragen 60 s lang gleich an den Router,
   dann wird DoH wieder versucht. Ohne Rückfall → SERVFAIL. Anfragen, die vom
   Router selbst kommen, gehen nie an ihn zurück (Schleifenschutz).
5. **Zwischenspeicher der Antworten:** bis 10 000 Einträge / 8 MB, TTL aus der
   Antwort (höchstens 1 Tag; NXDOMAIN/leer nach SOA, höchstens 1 h); gleiche
   gleichzeitige Anfragen werden gebündelt. Gesperrte Antworten werden nie
   gespeichert (sie hängen von Client und Uhrzeit ab). Frage in Original-
   Schreibweise und TTL-Alter werden je Client angepasst.

UDP-Antworten über 512 Bytes (bzw. der EDNS-Größe des Clients) gehen mit
TC-Bit zurück; TCP (auch mehrere Anfragen je Verbindung) liefert alles.

### Sichere Suche (`safeSearch`)

CNAME auf den Dienst-Namen des Anbieters plus dessen Adressen; andere Typen
(z. B. HTTPS/SVCB) für diese Namen bleiben leer, damit Browser nicht über
Hinweis-Adressen ausweichen.

| Namen | Ziel |
|---|---|
| `google.<tld>`, `www.google.<tld>` (alle Länderdomains) | `forcesafesearch.google.com` |
| `www.youtube.com`, `youtube.com`, `m.youtube.com`, `youtubei.googleapis.com`, `youtube.googleapis.com`, `www.youtube-nocookie.com` | `restrict.youtube.com` (strenger Modus) |
| `www.bing.com`, `bing.com` | `strict.bing.com` |
| `duckduckgo.com`, `www.duckduckgo.com`, `start.duckduckgo.com` | `safe.duckduckgo.com` |

### Listen

`lists` ist der Katalog des Servers; geladen werden nur Listen, die ein Profil
nutzt. Das Gateway lädt selbst:

- nur `https://` (auch Weiterleitungen, höchstens 3), höchstens 64 MB,
  Zeitlimit 120 s, `If-None-Match`/`If-Modified-Since` (304 → nichts zu tun),
  optional `sha256`-Pin aus dem Katalog;
- täglich (+ bis 1 h Zufall), nach Fehlern nach 1 h; Fehler (`http_status`,
  `not_https`, `too_large`, `empty`, `sha256_mismatch`, `too_many_entries`, …)
  stehen in `telemetry.dns.lists.<id>.error`, die letzte gute Fassung bleibt;
- Datei `/state/dns-lists/<id>.txt` (nur Listen-IDs `[A-Za-z0-9_-]`), beim
  Neustart sofort wieder geladen, ohne Netz.

Formate: `domains` (eine Domain je Zeile, `*.` erlaubt; sperrt samt
Subdomains), `hosts` (`0.0.0.0 name …`; sperrt genau diesen Namen),
`adblock` (`||domain^` samt Subdomains, `@@||domain^` Ausnahme; Regeln mit
anderen Optionen als `$important`, Pfaden, Platzhaltern oder Kosmetik werden
übersprungen). Zeilen > 1024 Zeichen, IP-Adressen, einzelne Labels und
`localhost`-Einträge werden übersprungen, IDN in Punycode umgewandelt.
Grenzen: 1,5 Mio. Einträge je Liste, 3 Mio. insgesamt.

**Speicher:** Einträge liegen nicht als Zeichenketten vor, sondern als
sortierte 53-Bit-Hashes (8 Bytes je Eintrag, Binärsuche; Fehltreffer-
Wahrscheinlichkeit bei 1 Mio. Einträgen ≈ 1e-10 je Anfrage). Gelesen wird
direkt auf den Bytes, ohne Zeichenkette je Zeile. Gemessen (Node 20, Alpine,
x86_64; ein Pi 3 B+ mit arm64 sollte ähnlich liegen):

| Szenario | RSS über Grundlast |
|---|---|
| OISD small + HaGeZi light (138 000 Einträge) geladen | +3 … 9 MB (Listen selbst 1,1 MB) |
| OISD big + HaGeZi pro (472 000 Einträge) geladen | +8 … 10 MB (Listen 3,6 MB) |
| dazu 200 Anfragen/s, 3 000 verschiedene Namen, voller Antwort-Cache | +9 … 20 MB |
| Lastspitze 3 800 Anfragen/s, 15 000 Namen | kurzzeitig bis +60 … 90 MB, danach ≈ +42 MB |

Einlesen: 0,6 s (138 000) bzw. 1,9 s (472 000 Einträge).

### Zeiten, Pausen, Verlängerungen

`schedules[].days` 1 = Montag … 7 = Sonntag; `from`/`to` `HH:MM` Ortszeit
(`features.timezone`, sonst `TZ`). Über Mitternacht (`21:00`–`07:00`) zählt
der Starttag: Mo–Fr 21–07 sperrt auch Samstag früh bis 07:00. `from == to` =
ganzer Tag, `to` darf `24:00` sein. `pauses[]`/`extensions[]`: `until` ISO-8601
(oder Epoch-ms); abgelaufene Einträge wirken nicht mehr.

### Lauschen, `port_busy`

Gebunden wird je Adresse (nie `0.0.0.0`): private IPv4 (RFC 1918), IPv6 ULA
(`fd00::/8`, `fc00::/8`) und link-local (mit Schnittstelle) der physischen
LAN-Schnittstellen – nie `gatecontrol0`, Docker-Brücken oder VPN. Abgleich
jede Minute (neue Adressen per DHCP). Belegt ein anderer Dienst Port 53
(DSM-Paket „DNS Server“, Pi-hole, dnsmasq, systemd-resolved auf der
LAN-Adresse), wird nichts erzwungen: `telemetry.dns.state = 'port_busy'`,
`busy: [Adresse]`, nächster Versuch nach einer Minute.

### Neustart

Die letzte DNS-Einstellung und die Zeitzone stehen in
`/state/features-boot.json`; der Filter startet damit **vor** dem ersten
Config-Pull. Grund: Trägt der Router das Gateway als DNS-Server für alle
Geräte ein, fragt auch der Gateway-Host selbst den Filter – ohne ihn käme der
erste Config-Pull nicht durch.

### Bericht, Telemetrie, Datenschutz

`POST /api/v1/gateway/dns` alle 5 Min.:

```js
{ period: { from, to },            // Epoch-ms
  queries, blocked, cached, avgMs,  // avgMs = Bearbeitungszeit inkl. Upstream
  topBlocked: [{ domain, count, profileId }],   // ≤ 20
  byProfile: { <id>: { queries, blocked } },
  clientsSeen: ['aa:bb:…'] }        // MACs, die gefragt haben (≤ 1024), ohne Domains
```

Scheitert ein Bericht, wird der Zeitraum mit dem nächsten zusammengelegt.
Einzelne Anfragen (`logQueries`) bleiben nur im Speicher des Gateways (die
letzten 2 000) und werden beim Ausschalten sofort gelöscht.

`telemetry.dns` (null wenn aus):
`{ state: 'starting'|'running'|'port_busy'|'no_address'|'error', port, listen: [ip], busy: [ip], upstream: { provider, fallbackRouter, lastOkAt, lastError: { at, code }|null, lastFallbackAt, fallbacks, dohDown }, lists: { <id>: { loaded, entries, updatedAt, checkedAt, error } }, listsBytes, cacheEntries, totals: { queries, blocked, cached, since }, logQueries, lastReportAt, reportError }`,
dazu `telemetry.features.dns` (an/aus, Lauf/Erfolg/Fehler der Listen, `state`, `listen`, `busy`, `lists`) – daraus liest der Server.

### Management-API (über den Tunnel, `X-Gateway-Token`)

- `GET /api/dns/log?limit=1…2000&mac=aa:bb:…` → `{ entries: [{ at, mac, ip, name, type, action, reason, profileId, list, category, cached, via, ms }] }`, neueste zuerst; 403 `{ error: 'log_disabled' }` ohne `logQueries`, 503 `feature_disabled` wenn aus.
- `POST /api/dns/test { domain, mac? }` → `{ domain, profileId, action: 'allow'|'block', reason, list?, category?, safeSearch? }`; 400 `invalid_domain`/`invalid_mac`.

`reason` ∈ `local`, `always_allow`, `profile_allow`, `paused`, `no_profile`,
`profile_deny`, `schedule`, `schedule_category`, `list`, `canary`, `default`.

### Grenzen der Eingaben

32 Listen, 16 Kategorien à 20 000 Domains, 32 Profile, je 2 000 allow/deny-
Muster, 16 Zeit-Regeln, 256 MACs je Profil (2 048 insgesamt), 512 Pausen bzw.
Verlängerungen. Ungültige Einträge werden still verworfen.

## Zwischenspeicher

### Ablage

`features.cache.path` muss unter dem Volume `/cache` liegen (sonst
`state: 'path_not_allowed'`; Wurzel änderbar mit `GATEWAY_CACHE_ROOT`). Ist der
Ordner nicht beschreibbar (kein Volume, schreibgeschützt) →
`path_unwritable`. Dateiname = sha256 (64 Kleinbuchstaben-Hex), sonst nichts;
Index mit Größe, Art und letzter Abgabe in `.gc-index.json`. Fremde Dateien im
Ordner bleiben unberührt. Nach einem Absturz werden Blobs ohne Index-Eintrag
nachgeprüft (sha256) und übernommen oder gelöscht; `.part`-Dateien älter als
7 Tage fliegen raus.

Belegt wird höchstens `maxBytes` (256 MB … 64 TB, Standard 20 GB) und nie
mehr, als der Datenträger hergibt: 512 MB bleiben dort immer frei.

- Compose (Docker/Synology): `${GC_CACHE_DIR:-./gateway-cache}:/cache`
- Pi-Image: `/opt/gatecontrol-gateway/gateway-cache`, oder `CACHE_DIR=` in
  `settings.txt` (Ordner auf einer per `/etc/fstab` eingehängten USB-Platte;
  wird nur übernommen, wenn er beim Start existiert) – das spart die SD-Karte.

### Vorrat und Laden

Alle 15 Min. (und auf `POST /api/cache/sync`) `GET /api/v1/gateway/cache/want`
(Bearer-Token). Erwartet `{ items: [{ sha256, size, kind, priority }] }`
(auch `{ want: […] }` oder ein bloßes Array; ≤ 20 000 Einträge, ≤ 8 MB).
Nur Arten mit `kinds.<kind> = true` (Standard: `drive`, `photos`, `updates`
an, `vault` aus). Höhere `priority` zuerst. Fehlt ein Blob: Platz schaffen –
zuerst Blobs, die nicht (mehr) im Vorrat stehen, dann solche mit niedrigerer
Priorität, jeweils die am längsten nicht abgegebenen; geht das nicht, wird der
Blob übersprungen. Die Reihenfolge wird einmal je Abgleich festgelegt (der
Stand am Anfang des Laufs); der Abgleich gibt alle 10 ms die Ereignisschleife
frei, damit Heartbeat, Proxy und Probe auch bei 20 000 Einträgen antworten.
Dann `GET /api/v1/gateway/cache/blob/<sha256>` in
`<sha256>.part`, eine Datei zur Zeit; abgebrochene Downloads werden mit
`Range: bytes=<n>-` fortgesetzt (206 mit passendem `Content-Range`, sonst von
vorn), mehr als `size` Bytes → Abbruch, danach sha256 über die ganze Datei.
Nach drei Fehlern bricht ein Lauf ab.

### Abgabe im LAN

`https://<LAN-IP>:8443/blob/<sha256>?exp=<unix>&sig=<hex>` (GET/HEAD), nur auf
privaten IPv4- und ULA-Adressen. Zertifikat EC P-256, selbstsigniert, 10 Jahre,
einmal erzeugt und behalten (`/state/cache-tls/`, 0600); Clients pinnen
`telemetry.cache.tlsSha256` (sha256 über das DER-Zertifikat, Kleinbuchstaben-Hex)
und prüfen keinen Namen.

- `sig = hex(HMAC-SHA256(key = UTF-8-Bytes von features.cache.secret, sha256 + '\n' + exp))`;
  Vergleich in konstanter Zeit; `exp` ≥ jetzt und ≤ jetzt + 600 s (+ 60 s
  Uhrenabweichung) – sonst **403** `{ error: 'expired'|'too_far'|'bad_signature' }`.
- Blob fehlt → **404** `{ error: 'not_cached' }` (erst nach gültiger Signatur);
  jeder andere Pfad → 404; andere Methoden → 405.
- `Range: bytes=a-b | a- | -n` (eine Spanne) → **206**, ungültig → **416**.
- Datei wird mit `O_NOFOLLOW` geöffnet (keine Symlinks), Pfad nur aus der
  geprüften sha256.
- 64 Verbindungen, Header-Zeitlimit 10 s.

Port belegt → `state: 'port_busy'`.

### Bericht

`POST /api/v1/gateway/cache` alle 5 Min. und nach neuen Downloads:

```js
{ full: bool,               // true: erster Bericht nach Start, nach Fehlern, alle 6 h
  have: [sha256],           // full: alles; sonst neu seit dem letzten bestätigten Bericht (≤ 5 000 je Bericht,
                            //   Rest folgt sofort als Delta; Zähler nur im ersten Teil)
  gone: [sha256],           // nur Delta: entfernt seit dem letzten bestätigten Bericht
  usedBytes, maxBytes, effectiveMaxBytes, items,
  hits, misses, bytesServed, bytesFetched,   // im Zeitraum
  period: { from, to } }
```

### Telemetrie

`telemetry.cache` (null wenn weder an noch angefordert):
`{ state: 'running'|'port_busy'|'no_address'|'path_unwritable'|'path_not_allowed'|'no_secret'|'error', port, listen: [ip], urls: ['https://192.168.1.23:8443'], tlsSha256, path, usedBytes, maxBytes, effectiveMaxBytes, freeBytes, items, want, downloading: { sha256, size, bytes, kind }|null, lastSyncAt, lastReportAt, error }`.

`telemetry.features.cache` enthält zusätzlich `state`, `port`, `tlsSha256`,
`url` (IPv4 zuerst; daraus baut der Server `lan.url`), `usedBytes`, `error`.

### Management-API

- `POST /api/cache/sync {}` → 202, 409 `sync_running`, 503 `feature_disabled`
- `POST /api/cache/clear {}` → 202 (alle Blobs gelöscht, nächster Bericht `full`), 503 wenn aus

## Datenträger (`telemetry.storage`)

`[{ mount, fs, sizeBytes, freeBytes, removable, origin }]`: Einhängungen, die
der Container sieht (echte Dateisysteme auf `/dev/…`, ohne `/proc`, `/etc`,
`/boot` …; `removable` = Wechseldatenträger-Flag oder USB-Pfad in sysfs, SD-
Karte nie), `origin: 'container'`. Auf dem Pi-Image ergänzt
`gatecontrol-hwdetect` beim Start alle eingehängten Datenträger des Hosts
(`hardware.json` → `disks`, `origin: 'host'`), damit der Server eine
angesteckte USB-Platte vorschlagen kann.

## Zeitzone

`features.timezone` (IANA, z. B. `Europe/Berlin`) setzt die Ortszeit des
Gateway-Prozesses sofort (Portscan-Fenster, Speedtest-Plan, DNS-Zeiten werden
neu geplant). Ungültig oder fehlend → `TZ` aus der Umgebung, sonst UTC.
Damit entfällt die `TZ`-Zeile auf der Synology.
