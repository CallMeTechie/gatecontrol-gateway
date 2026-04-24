# Security Model

Dieses Dokument beschreibt was der Home Gateway sehen kann und was nicht, welche Angriffsoberflächen er exponiert und welche Hardening-Kontrollen aktiv sind. Zielgruppen:

- **Homelabber** die die Vertrauensgrenzen verstehen wollen bevor sie das NAS ins Internet freigeben
- **Admins** verantwortlich für Small-Business- / Non-Profit-Deployments die Audit-reife Antworten brauchen
- **Security-Reviewer** die vor Freigabe des Gateways in einer locked-down Umgebung eine Sanity-Check machen

---

## Inhaltsverzeichnis

- [Threat-Model](#threat-model)
- [Vertrauensgrenzen](#vertrauensgrenzen)
- [Was der Gateway sehen kann](#was-der-gateway-sehen-kann)
- [Was der Gateway nicht sehen kann](#was-der-gateway-nicht-sehen-kann)
- [Container-Hardening](#container-hardening)
- [Authentifizierung und Autorisierung](#authentifizierung-und-autorisierung)
- [Transport-Verschlüsselung](#transport-verschlüsselung)
- [Angriffsoberflächen-Analyse](#angriffsoberflächen-analyse)
- [Kill-Switch-Interaktion](#kill-switch-interaktion)
- [Audit-Trail](#audit-trail)
- [Compromise-Recovery](#compromise-recovery)

---

## Threat-Model

Wir designen gegen diese Angreifer, grob absteigend nach Aufmerksamkeit:

| Angreifer | Fähigkeit | Mitigation-Priorität |
|---|---|---|
| **Anonymer Internet-Angreifer** | Port-Scan des Public-Servers, Brute-Force exponierter Routen, Admin-UI probieren | Hoch — erste Verteidigungslinie |
| **Opportunistischer Scraper / Bot** | Ausnutzen gängiger Schwachstellen (Log4Shell-artig), bekannte böse User-Agents | Hoch — automatisiert via caddy-defender Bot-Blocker |
| **Bösartiger authentifizierter User** | Hat valide Route-Auth-Credentials, versucht den Target-Dienst auszunutzen | Mittel — Verantwortung der Target-App |
| **Kompromittiertes LAN-Gerät** | Selbes LAN wie der Gateway, versucht durch den Tunnel zum GateControl-Server zu pivotieren | Mittel — LAN-seitige Isolation |
| **Kompromittierter Gateway-Host** | Angreifer hat Root auf der Maschine die den Gateway-Container laufen lässt | Niedrig — an dem Punkt ist alles vorbei, aber wir begrenzen den Blast-Radius via Container-Hardening |
| **Kompromittierter GateControl-Server** | Angreifer hat Shell auf dem VPS | Out of Scope — der Server ist die Control-Plane |
| **Insider: GateControl-Projekt-Maintainer** | Shippt ein bösartiges Gateway-Update | Out of Scope — du vertraust dem Upstream; Image-Pinning im Zweifel |

---

## Vertrauensgrenzen

Vier distinkte Domänen. Traffic der eine Grenze kreuzt ist verschlüsselt oder zugriffskontrolliert.

```
┌──────────────────────────────────────────────────────────────────┐
│  Internet                                                         │
│   - beliebiger Traffic                                            │
│   - hier leben die Angreifer                                      │
└──────────────────┬───────────────────────────────────────────────┘
                   │ HTTPS (Let's Encrypt)
                   │ TCP/UDP (optional TLS via SNI)
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  GateControl-Server (VPS)                                         │
│   - Caddy Reverse-Proxy                                           │
│   - Node Admin-API                                                │
│   - WireGuard-Endpoint (UDP/51820)                                │
└──────────────────┬───────────────────────────────────────────────┘
                   │ WireGuard-Tunnel (ChaCha20-Poly1305, Curve25519)
                   │ UDP/51820, Ende-zu-Ende verschlüsselt
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  Home-Gateway-Container (LAN)                                     │
│   - empfängt vom Server über Tunnel                               │
│   - HTTP-Proxy + L4-Listener auf Tunnel-IP                        │
│   - Cap-dropped, read-only rootfs                                 │
└──────────────────┬───────────────────────────────────────────────┘
                   │ PLAIN LAN-Traffic (oder Backend-HTTPS)
                   │ TCP/UDP innerhalb des Heimnetzes
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│  Target-LAN-Gerät (NAS, Desktop, IoT)                             │
│   - Standard-Anwendung (DSM, RDP, SSH etc.)                       │
│   - Vertrauen: implizit (ist im Heim)                             │
└──────────────────────────────────────────────────────────────────┘
```

Die kritische Grenze ist **Internet → Server**. Alles danach ist entweder verschlüsselt (WG-Tunnel) oder in deinem lokalen Netz.

---

## Was der Gateway sehen kann

### Innerhalb des Tunnels

- **Plain-HTTP**-Requests und -Responses auf LAN-Seite — nachdem der Tunnel sie entschlüsselt. Der Gateway agiert als Reverse-Proxy, hält also temporär volle Request-Bodies und Response-Bodies im Speicher. Nichts wird auf `info`-Level geloggt; auf `debug`-Level nur die URL, nicht der Body.
- **TCP/UDP-Payloads** auf L4-Routen, ebenfalls Plain auf LAN-Seite. Der Gateway inspiziert die nicht — er ist ein bytekopierender Proxy.
- **LAN-Netz** — der Gateway ist vollwertiger LAN-Bürger (Host-Networking). Er sieht allen Broadcast-/Multicast-Traffic den der Host sieht. Er macht **kein** ARP-Poisoning, mDNS-Spam oder andere L2-Missbräuche; er hört nur passiv zu und initiiert nur Verbindungen zu Zielen die via Routen konfiguriert sind.

### Im Container

- Eigene `gateway.env` (enthält API-Tokens und WireGuard-Private-Key)
- Eigene Runtime-Config in `/etc/wireguard` (tmpfs, bei Restart weg)
- Sonst nichts — der Container ist nicht Root-auf-Host, das Image hat keine Shell-Tools die fürs Enumerieren nützlich wären, alles andere ist read-only

### Außerhalb des Containers

- Nichts. Der Container hat:
  - Keinen Zugriff auf des Hosts `/etc`, `/home`, `/var/lib` (nur die Volumes die du explizit mountst)
  - Keinen Zugriff auf den Docker-Socket (niemals `/var/run/docker.sock` mounten)
  - Keinen Zugriff auf systemd-Journal oder andere Container

---

## Was der Gateway nicht sehen kann

- **TLS-terminierter HTTPS-Payload vom Client** (bei Backend-HTTPS liefert der Tunnel HTTPS-Traffic Ende-zu-Ende von Caddy direkt zum Ziel — der Gateway sieht nur die Wire-Bytes, nicht Plaintext)
- **Traffic anderer WireGuard-Peers** — der WG-Tunnel ist Point-to-Point zwischen diesem Gateway und dem Server; du siehst nicht den Traffic des Laptop-Peers des Admins obwohl beide dieselbe GateControl-Instanz nutzen
- **Admin-UI oder Datenbank des Servers** — der Gateway hat API-Token-Zugriff auf eine schmale Menge gateway-spezifischer Endpoints (Config syncen, Heartbeat melden, WoL pushen). Er kann keine anderen Peers listen, keine Routen lesen die ihm nicht gehören, keine Backups triggern, keine Activity-Logs lesen
- **Host-Dateisystem des GateControl-Servers** — nur die API-Oberfläche ist erreichbar

---

## Container-Hardening

Das gelieferte `docker-compose.example.yml` wendet diese Kontrollen an:

### Capabilities

```yaml
cap_drop:
  - ALL
cap_add:
  - NET_ADMIN          # wg-quick braucht es um das wg0-Interface zu konfigurieren
  - NET_BIND_SERVICE   # um Ports <1024 (DNS, HTTP, SSH) auf L4-Routen zu binden
```

`NET_RAW` wird **nicht** hinzugefügt. WoL nutzt `SO_BROADCAST` (erlaubt durch NET_ADMIN), keine Raw-Sockets.

### Filesystem

```yaml
read_only: true
tmpfs:
  - /tmp
  - /run
  - /etc/wireguard     # wg-quick schreibt hier Runtime-Config
```

`read_only: true` verhindert dass ein Angreifer mit Code-Execution Änderungen persistiert. Alles Schreibbare ist in tmpfs, bei Restart weg.

### User

Das Container-Image läuft als non-root User (`gateway`, UID 1000). Kombiniert mit cap_drop heißt das: selbst eine vollständige Prozess-Übernahme kann nicht in andere Host-Namespaces ausbrechen.

### No-new-privileges?

**Bewusst NICHT gesetzt.** `no-new-privileges` konfligiert mit `cap_add: NET_ADMIN` für non-root User auf Linux — `wg-quick` ruft intern `ip`/`iptables` die Ambient-Capabilities brauchen, und die werden für UID != 0 blockiert wenn `no-new-privileges` gesetzt ist. Wir haben Kompatibilität (die gelieferten Kontrollen sind stark genug) über das Extra-Flag gewählt.

Kompensierende Kontrollen: `cap_drop: ALL`, `read_only: true`, non-root USER, Seccomp-Default (Dockers Default-Profil).

### Seccomp

Dockers Default-Seccomp-Profil ist aktiv. Kein Custom-Profil — das Default blockiert bereits die Syscalls die zählen (kexec, ptrace-other-process, mount etc.). Wenn du ein strikteres Profil brauchst, via `security_opt: seccomp=/pfad/zu/profile.json` liefern.

### Health-Check

Dockers Healthcheck pollt `GET http://127.0.0.1:9876/health` alle 60 Sekunden. Fehlende Healthchecks restarten den Container nach 3 konsekutiven Fehlern.

---

## Authentifizierung und Autorisierung

### Gateway → Server

Jedes Gateway hat ein **Paar von Tokens** in `gateway.env`:

| Token | Zweck |
|---|---|
| `api_token` | Authentifiziert server-gerichtete Requests (Heartbeat, Sync, Reachability-Report). Server-seitig SHA-256 gehashed. |
| `push_token` | Authentifiziert die Server → Gateway-Richtung (WoL-Trigger, Force-Sync). Gateway validiert. |

Beide sind 32-Byte-crypto-random Werte (256-Bit-Entropie). Sie werden einmal bei Peer-Erstellung gezeigt und am Server nur als Hashes gespeichert.

Rotieren via **Peers → Peer-Detail → Tokens rotieren**. Alte Tokens werden sofort ungültig; der Gateway bekommt einen milden Fehler beim nächsten Call und der Admin muss die neue `.env` deployen.

### Server → Gateway

API-Calls vom Server zum Gateway nutzen den `push_token`. Alle Calls laufen durch den WireGuard-Tunnel; auf keinem anderen Interface wird Authentifizierung akzeptiert.

### Route-Level-Auth

Unabhängig von Gateway-Authentifizierung. Siehe die Haupt-[GateControl-Docs](https://github.com/CallMeTechie/gatecontrol) — jede Route kann verlangen:

- Basic-Auth (Username/Passwort)
- E-Mail-OTP
- TOTP
- 2FA-Kombinationen

Diese authentifizieren den **User** der auf die Route trifft, nicht den Transport. Eine Home-Gateway-Route kann (und sollte meist) Route-Auth auf den Gateway-Transport draufpacken.

---

## Transport-Verschlüsselung

### Internet → Server

- **HTTPS-Routen**: TLS 1.2+ via Let's Encrypt. HTTP-Auto-Redirect auf HTTPS.
- **L4-Routen**: optional TLS via Caddys Layer4-Plugin. Drei Modi: `none` (rohes TCP), `passthrough` (TLS-SNI-Routing, keine Terminierung), `terminate` (Caddy handled TLS).
- **WireGuard-Endpoint**: UDP/51820, ChaCha20-Poly1305 AEAD, Curve25519 ECDH.

### Server ↔ Gateway

Aller Applikations-Traffic läuft auf dem WireGuard-Tunnel — Server-zum-Gateway und Gateway-zum-Server. Das ist **Ende-zu-Ende verschlüsselt** mit modernen WireGuard-Krypto-Primitiven. Kein Plain-TCP durchs Internet an irgendeinem Punkt.

### Gateway → LAN-Ziel

**Plain TCP/HTTP per Default.** Das ist akzeptabel weil Gateway und Ziel beide in deinem Heimnetz sind. Wenn dein LAN selbst feindlich ist (Coworking-Space, WG, Public-WiFi am Gateway-Host), solltest du:

1. Den Gateway auf sein eigenes VLAN isolieren
2. `Backend HTTPS` für HTTP-Routen aktivieren damit der Server-zu-Ziel-Hop Ende-zu-Ende verschlüsselt ist (Caddy des Servers spricht HTTPS zum Ziel; der Gateway leitet nur Bytes weiter)

---

## Angriffsoberflächen-Analyse

Sortiert von am meisten exponiert zu am wenigsten.

### 1. Öffentliches Caddy (GateControl-Server)

Jeder L4-Port und jede HTTP-Route ist dem Internet exponiert. Standard-Web-Angriffsoberfläche: TLS-Parsing, HTTP-Parsing, Plugin-Bugs. Caddy ist in Go mit TLS 1.3 und strikten Parsern geschrieben; zum Zeitpunkt dieses Schreibens keine bekannten ungepatchten CVEs (siehe `trivy`-Scan in CI).

**Deine Kontrolle:** Das Server-Image aktuell halten (`update.sh`). Automatischer Container-Scan (Trivy) läuft bei jedem Release und blockt bei HIGH/CRITICAL CVEs.

### 2. Route-Auth-Seiten

Optional, aber wenn aktiviert handhaben sie User-Input. Passwort-Hashing ist Argon2id, CSRF-Tokens sind HMAC-signiert und domain-gebunden, Rate-Limiting ist 5 Login-Versuche pro 15 Minuten pro IP.

### 3. WireGuard-Endpoint

UDP/51820. WireGuard hat einen exzellenten Security-Track-Record — keine bekannten remote-ausnutzbaren CVEs. Das Protokoll ist so designed dass es still ist gegenüber unautorisierten Peers (keine Response auf ungekeyten Traffic).

### 4. Gateway-Management-API

Nur über den WireGuard-Tunnel erreichbar. Ein Angreifer müsste erst den WireGuard-Tunnel kompromittieren (infeasible ohne Server-Private-Key) oder den Server (viel größeres Problem als der Gateway).

### 5. Gateway-LAN-Exposition

Der Gateway-Container lauscht auf `HTTP_PROXY_PORT` (Default 8080) auf der Tunnel-IP. Er lauscht auf keinem anderen Interface. LAN-seitig initiiert der Gateway nur Verbindungen zu Zielen; er exponiert keinen Service für andere LAN-Geräte.

---

## Kill-Switch-Interaktion

Der Home Gateway ist eine andere Topologie als ein Standard-VPN-Client, deshalb passt das Kill-Switch-Konzept nicht direkt:

- **Ein Standard-VPN-Client** hat einen Kill-Switch der verhindert dass Traffic außerhalb des Tunnels leakt wenn der Tunnel dropt. Nützlich für Laptops in Public-WiFi.
- **Ein Home Gateway** ist selbst ein Tunnel-Endpoint. Wenn sein Tunnel dropt, fließt kein Traffic. Es gibt nichts zu "leaken" weil der Gateway nicht aktiv LAN-Geräte-Traffic via Tunnel ins Internet NATet.

Wenn du willst dass deine LAN-Geräte den GateControl-Server als outbound Internet-Gateway nutzen (LAN-sourced Traffic über den Tunnel ins Internet), ist das ein separates Feature (Future Work — nicht Teil des aktuellen Home Gateways). Das aktuelle Design ist **inbound only**: server-initiierte Requests kommen am Gateway an und werden zu LAN-Zielen proxied. Outbound LAN-Traffic (z.B. NAS spricht mit einem Wetterdienst) nutzt die normale LAN-Default-Route, nicht den Tunnel.

---

## Audit-Trail

### Server-seitig

Jede Config-Änderung wird im GateControl-Activity-Log erfasst:

- `peer_created` / `peer_deleted` / `peer_updated`
- `route_created` / `route_deleted` / `route_updated`
- `gateway_offline` / `gateway_online` (Statemaschine-Transitionen)
- `gateway_flap_warning` (Stabilitäts-Issue)
- Optional: `login_failed`, `account_locked` (Route-Auth-Events)

Retention ist konfigurierbar (Default 30 Tage). Export nach CSV/JSON in Settings → Logs.

### Gateway-seitig

Container-Logs via Dockers Default-JSON-File-Driver. 10 MB Rotation, 3 Files aufbewahrt. Für Langzeit-Retention in Loki / Elasticsearch / Syslog via Dockers Log-Driver-Config piping.

Der Gateway loggt:

- Startup: Config-Version, Tunnel-Endpoint, Route-Count
- Route-Änderungen: added/removed/disabled
- Heartbeat-Zusammenfassung (pro Zyklus, auf `info`-Level)
- Probe-Results (Erreichbarkeit jedes Targeted-LAN-Dienstes)
- Errors: Failed Connect, Cert-Validation, Config-Apply

Auf `info`-Level sind die Logs strukturiertes JSON, jede Zeile hat `time`, `level`, `msg` und kontextuelle Felder (route_id, domain, target). Sicher einspeisbar in jedes JSON-fähige Log-Store.

---

## Compromise-Recovery

### Verdacht auf Gateway-Kompromittierung (ungewöhnlicher Prozess läuft, unerwartete Netzwerk-Calls)

1. Container stoppen: `docker compose down`
2. Gateway-Tokens rotieren: **Peers → Peer-Detail → Tokens rotieren**
3. Activity-Log nach unerwarteten Route-Änderungen der letzten 7 Tage durchsehen
4. `gateway.env` neu herunterladen und einen frischen Container aus dem sauberen Image hochziehen
5. Bestätigen dass das Container-Image-Tag von deinem vertrauten Upstream ist (`ghcr.io/callmetechie/gatecontrol-gateway:latest`)

### Verdacht auf LAN-Ziel-Kompromittierung (z.B. NAS läuft Crypto-Miner)

1. Alle Routen die auf dieses Ziel zeigen deaktivieren (Routen → Toggle off)
2. Ziel selbst fixen (Reset, Patch, Restore from Backup)
3. Routen wieder aktivieren wenn das Ziel sauber ist

### Verdacht auf WireGuard-Key-Leak

1. Peer komplett löschen (**Peers → Peer-Detail → Löschen**) — das invalidiert das WG-Keypair
2. Neuen Gateway-Peer mit neuem Keypair anlegen
3. Neue `.env` auf dem Gateway-Host deployen
4. Alte Keys sind nutzlos — der Server rejected sie

---

## Weiterführend

- **[03 — Features Reference](03-features-reference.de.md)** — Per-Feature-Details
- **[04 — Troubleshooting](04-troubleshooting.de.md)** — operative Probleme
- [GateControl-Server Security-Docs](https://github.com/CallMeTechie/gatecontrol#security) — voller Security-Kapitel im Server-README
