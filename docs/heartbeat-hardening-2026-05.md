# Heartbeat & Self-Check Hardening — 2026-05

Drei zusammengehörige Änderungen, die aus einem Code-Review-Verifikationslauf
gegen den GateControl-Server hervorgingen.

## Motivation

Der Heartbeat-Ticker rief `getHealth()` ohne Cap auf. `getHealth` rief
`runSelfCheck` auf, das wiederum `wireguard.getStatus()` (`wg show … dump`)
und `dns.resolve4()` aufrief — beide ohne hartes Timeout. Im pathologischen
Fall (TUN-Hiccup, DNS-Resolver-Outage) konnte ein einzelner Tick unbegrenzt
hängen, der nächste `setInterval`-Tick lief parallel, und der Server-State
flippte nach zwei verpassten Heartbeats auf `offline` → Caddy-Patch +
Maintenance-Page.

Parallel war die Self-Check-Verkabelung in `bootstrap.js` doppelt vorhanden:
einmal im `/api/status`-Router (Z. 95-110), einmal im Heartbeat (Z. 144-158).
Identische 6 Parameter, identische 5 Closures, eine Kleinigkeit Drift
(L4-`domain`-Label).

## Änderungen

### 1. `runCommand`-Timeout (`src/wireguard.js`)

Optionales `timeoutMs`-Feld. Bei Überschreitung: `child.kill('SIGKILL')` und
Reject mit `<cmd> <args> timed out after <ms>ms`.

```js
runCommand('wg', ['show', 'gatecontrol0', 'dump'], { timeoutMs: 1500 })
```

`getStatus()` nutzt `1500ms`. `wg-quick up/down` bleibt absichtlich
unbegrenzt — Boot-Setup (resolv.conf, Routing-Tabelle) darf legitim
länger dauern, und ein Timeout würde halb-konfigurierte Tunnel hinterlassen.

### 2. `getHealth()`-Cap im Heartbeat (`src/heartbeat.js`)

Neuer interner Helper `_collectHealth(getHealth, timeoutMs)` mit
`Promise.race` gegen einen 8s-Default-Cap. Bei Timeout:

```js
{ overall_healthy: false, reason: 'health_collection_timeout' }
```

Bei Throw:

```js
{ overall_healthy: false, reason: 'health_collection_error', error: '<msg>' }
```

Server-`_isHeartbeatHealthy()` prüft `tcp_listeners` — fehlt das Feld,
gilt der Heartbeat als „liveness OK". Der Gateway bleibt also `online`,
aber der Operator sieht den Timeout-Grund in `last_health` für die
Diagnose. 8s liegt bewusst unter dem 10s-HTTP-Timeout des Heartbeats,
damit der nächste Tick landen kann, bevor der vorige ihn überrennt.

### 3. SelfCheck-Factory (`src/health/selfCheckRunner.js`)

```js
const runHealthCheck = createSelfCheckRunner({ config, store, tcpMgr, wireguard });
```

Liefert eine parameterlose Async-Funktion, die `runSelfCheck` mit
Routes (HTTP + L4 mit `l4:<port>`-Domain-Label), DNS-Resolver und TCP-Probe
verkabelt. `bootstrap.js` ruft sie an beiden Call-Sites auf, statt den
Boilerplate zweimal zu inlinen.

Nebeneffekt: L4-Routen bekommen jetzt auch im Heartbeat-Pfad ein
`domain: 'l4:3389'`-Label im `route_reachability`-Eintrag (vorher
nur im `/api/status`-Pfad). Server speichert das in `last_health` —
UI-Komponenten, die das Label anzeigen, sehen es jetzt konsistent.

`bootstrap.js` schrumpft von 174 auf 152 Zeilen.

## Tests

Neue Tests in `tests/`:

- `tests/wireguard.test.js`: `_runCommand` mit `timeoutMs` (rejects, kills child, fast).
- `tests/heartbeat.test.js`: `_collectHealth` Happy / Timeout / Error.
- `tests/selfCheckRunner.test.js`: L4-Domain-Label, `overall_healthy=false` bei nicht-bound proxy/api.
- `tests/wol.test.js`: Boundary-Tests für `_computeBroadcast` (Octet-Range, /16, /32) und `validateMac`.
- `tests/config.test.js`: Exact-Boundary für `isRfc1918` (10/8, 172.16/12, 169.254/16, 192.168/16) und Malformed-Inputs.
- `tests/router.test.js`: `wol_enabled=false + wol_mac` und `wol_enabled=true + missing wol_mac` → `wolMac:null`.

Diese Tests zielen direkt auf die in der Stryker-Mutation-Run als
„surviving" markierten Stellen.

## Verworfene Vorschläge (Verifikation gegen Server)

Sieben weitere Vorschläge aus dem ersten Review-Lauf wurden nach
Verifikation gegen `gatecontrol/` verworfen:

| # | Punkt | Grund |
|---|---|---|
| 1 | Domain-Case-Lookup | Server lowercased Domains beim INSERT (`routes.js:114`); Caddy injiziert verbatim. Keine Realbedeutung. |
| 2 | TCP-Backpressure | Node `Readable.pipe()` ehrt Backpressure von Haus aus. War mein Reflex. |
| 3 | Dual-Bind-Cancel | Node `server.close()` ist idempotent. Race-Edge-Cases crashen nicht. |
| 4 | WoL-Iface-Whitelist statt Negative-List | Whitelist trifft nicht alle physischen Interface-Namen (OpenWRT, USB-WiFi). Trade-off; Status-quo in Ordnung. |
| 8 | Atomic `httpRoutes`-Mutation | Listener liest `cfg.routes` aus dem Event-Payload, nicht aus dem Store. |
| 9 | Hash-Mismatch-Strict | Würde Gateway-Pool bei Server-Library-Bug aus dem Tritt bringen. Warning ist die richtige Entscheidung. |
| 10 | Rate-Limit auf `/api/wol` | Server-Pfad ist UI-getriggert, kein Auto-Loop. Token+RFC1918+Whitelist reichen. |

## Verhaltensänderungen für Operatoren

- Wenn `wg show` hängt: Heartbeat geht durch, mit `tcp_listeners=[]` und
  `wg_handshake_age_s=null`. Der Gateway erscheint **online** in der UI
  (Server-State-Machine prüft auf `listener_failed`, nicht auf
  fehlende Felder), aber `last_health.reason` zeigt den Grund.
- L4-Routen tauchen im Server-`/api/v1/gateways`-Endpoint mit
  `domain: 'l4:<port>'` im `route_reachability` auf — vorher
  uneinheitlich.
