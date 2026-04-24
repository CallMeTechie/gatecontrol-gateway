# Troubleshooting

Diagnose-Katalog für die häufigsten Home-Gateway-Fehlerbilder. Jeder Eintrag listet das Symptom, die wahrscheinlichen Ursachen (absteigend sortiert nach Häufigkeit) und den Verifikations-Befehl.

Für das erstmalige Setup siehe **[01 — User Journey](01-user-journey.de.md)**. Was jedes Feature leisten soll, siehe **[03 — Features Reference](03-features-reference.de.md)**.

---

## Inhaltsverzeichnis

- [Gateway bleibt offline](#gateway-bleibt-offline)
- [Tunnel steht, Routen liefern 502](#tunnel-steht-routen-liefern-502)
- [Backend-HTTPS-Ziel unerreichbar](#backend-https-ziel-unerreichbar)
- [WoL weckt Gerät nicht](#wol-weckt-gerät-nicht)
- [VM-Netzwerkmodus (Bridge vs NAT)](#vm-netzwerkmodus-bridge-vs-nat)
- [Port-Konflikt / Listen-Port abgelehnt](#port-konflikt--listen-port-abgelehnt)
- [Config-Sync hängt / Hash-Mismatch](#config-sync-hängt--hash-mismatch)
- [Gateway flapt online/offline](#gateway-flapt-onlineoffline)
- [RDP: Credentials abgelehnt nach Gateway-Wechsel](#rdp-credentials-abgelehnt-nach-gateway-wechsel)
- [Logs zeigen "container read-only filesystem" Fehler](#logs-zeigen-container-read-only-filesystem-fehler)
- [Wie man brauchbare Logs für einen Bug-Report bekommt](#wie-man-brauchbare-logs-für-einen-bug-report-bekommt)

---

## Gateway bleibt offline

**Symptom:** Neuen Gateway-Peer angelegt, Container gestartet, aber Server-UI zeigt nach 60 Sekunden immer noch "offline".

### Check 1 — Läuft der Container überhaupt?

```bash
docker ps --filter name=gatecontrol-gateway
# Erwartet: Up N minutes (healthy)
```

Wenn der Container nicht läuft, `docker logs gatecontrol-gateway --tail 50` prüfen. Häufige Startfehler:

- `gateway.env not found` — Volume-Mount-Pfad passt nicht. Der Container sucht unter `/config/gateway.env` (bzw. wo `GATEWAY_ENV_PATH` hinzeigt). Prüfen dass `docker-compose.yml` `./config:/config:ro` hat und `./config/gateway.env` auf dem Host existiert.
- `Invalid token format` — Die `.env` wurde beim Download abgeschnitten oder korrumpiert. Aus dem Server-UI neu herunterladen.

### Check 2 — Kommt der WireGuard-Handshake zustande?

Vom Gateway-Host:

```bash
docker exec gatecontrol-gateway wg show
# Erwartet:
#   peer: ...
#   endpoint: <Server-Public-IP>:51820
#   latest handshake: X seconds ago    <-- muss unter 3 Minuten sein
```

Kein Handshake überhaupt → der Server ist für den Gateway auf UDP/51820 nicht erreichbar. Prüfen:

- Heim-Router-Firewall / Outbound-Regeln (ungewöhnlich, aber manche ISP-Router blocken beliebigen UDP-Out)
- Firmen- oder Public-WiFi das Non-443-Traffic blockiert — aus anderem Netz probieren
- Server-seitig: ist Port 51820/UDP tatsächlich offen? `ss -lnup | grep 51820` auf dem Server.

Handshake kommt, aber läuft gleich in Timeout → Token-Mismatch zwischen `.env` und Server-Record. Gateway-Env im UI regenerieren (Peer-Detail → "Tokens rotieren"), neu herunterladen, Gateway neu starten.

### Check 3 — Kann der Gateway die Server-API erreichen?

```bash
docker exec gatecontrol-gateway curl -sSI https://<dein-gc-server>/health
# Erwartet: HTTP 200 body {"ok":true}
```

401 oder 403 → der API-Token in `gateway.env` ist veraltet (Server wurde resettet, Peer neu erstellt, Tokens rotiert). Env neu herunterladen.

Connection refused / Timeout → der Gateway kann den Admin-Hostname des Servers nicht auflösen. Wahrscheinlich DNS-Problem im Container. Prüfen dass das interne Docker-DNS `<dein-gc-server>` auflösen kann. Notlösung: `GC_SERVER_IP` in env setzen, Gateway nutzt die direkt.

---

## Tunnel steht, Routen liefern 502

**Symptom:** Gateway zeigt online im UI, aber `curl https://nas.example.com` liefert 502 Bad Gateway.

### Check 1 — Ist das LAN-Ziel vom Gateway-Host aus überhaupt erreichbar?

```bash
# Vom Gateway-Host (nicht aus dem Container — Host-Network teilt den Namespace):
curl -k https://192.168.1.50:5001/
```

Wenn das nicht klappt, kann der Gateway das Ziel auch nicht erreichen. LAN zuerst fixen (Firewall am Ziel, falsche IP, Dienst tot).

### Check 2 — Proxied der Gateway?

```bash
docker logs gatecontrol-gateway --since 5m | grep -i "502\|error\|proxy"
```

Nach Einträgen wie `HTTP route not found` (Route-Config noch nicht synced), `ECONNREFUSED target 192.168.1.50:5001` (LAN-Ziel tot), `certificate verify failed` (Backend-HTTPS-Toggle fehlt) Ausschau halten.

### Check 3 — Backend-HTTPS-Toggle

Wenn das Ziel nur HTTPS anbietet (Synology 5001, Fritzbox, UnRAID), **Backend HTTPS** in der Route aktivieren. Ohne das schickt der Gateway einen Plain-HTTP-Request an ein HTTPS-Only-Ziel und bekommt 400 / 502 / Reset.

### Check 4 — MTU

Wenn Requests manchmal klappen (kleine Responses) aber bei großen Payloads scheitern (File-Listing, Image-Downloads), klippt der WireGuard-Tunnel-MTU TCP-Segmente. Der Server setzt MTU=1420 mit MSS-Clamping (siehe `entrypoint.sh` im Server-Repo). Wenn du das mit eigenem `GC_WG_MTU` übersteuert hast, auf 1420 zurücksetzen.

---

## Backend-HTTPS-Ziel unerreichbar

**Symptom:** Backend-HTTPS aktiviert, aber der Gateway kann das Ziel trotzdem nicht erreichen.

### Check 1 — Serviert das Ziel tatsächlich HTTPS?

```bash
openssl s_client -connect 192.168.1.50:5001 -servername 192.168.1.50 </dev/null 2>&1 | head -5
# Erwartet: CONNECTED(00000003) + Cert-Details
```

Manche Dienste (alte Router, frühe Fritzbox-Firmware) zeigen einen kaputten TLS-Stack. Firmware updaten wenn möglich.

### Check 2 — Ist das Cert self-signed oder von einer privaten CA?

Der Gateway deaktiviert Zertifikatsvalidierung auf dem LAN-Hop bewusst (die meisten Homelabs nutzen Self-Signed). Wenn dein Ziel ein Public-CA-Cert hat und trotzdem fehlschlägt, liegt das Problem woanders (Port falsch, Dienst down).

### Check 3 — HTTP/2 ohne ALPN

Ein paar Dienste akzeptieren nur HTTP/2 und annoncieren das nicht via ALPN. Seltene Fehlkonfiguration auf Ziel-Seite. Testen mit:

```bash
curl -k --http1.1 https://192.168.1.50:5001/
```

Wenn `--http1.1` geht, ist das HTTP/2-Setup am Ziel kaputt. Am Ziel fixen oder anderen Port nutzen.

---

## WoL weckt Gerät nicht

**Symptom:** Zielgerät schläft. Du versuchst zur Route zu verbinden. Gateway-Logs sagen das Magic-Packet wurde gesendet. Das Gerät kommt nie hoch.

WoL ist fragil. In dieser Reihenfolge prüfen:

### Check 1 — Ist WoL am Zielgerät aktiviert?

| OS | Prüfen |
|---|---|
| Windows | Gerätemanager → Netzwerkadapter → Energieverwaltung: "Gerät kann den Computer aus dem Ruhezustand aktivieren" UND "Nur Magic Packet kann Computer aktivieren" |
| Windows | Energieoptionen → "Auswählen, was beim Drücken der Netztaste geschehen soll" → "Schnellstart aktivieren" ausschalten (Schnellstart bricht WoL auf vielen Geräten) |
| Windows | BIOS/UEFI: "Wake on LAN" / "Power on by PCI-E" aktiviert |
| Linux | `ethtool eth0 \| grep Wake-on` — muss `Wake-on: g` zeigen (oder `g` enthalten). Setzen mit `ethtool -s eth0 wol g` |
| macOS | Systemeinstellungen → Batterie → Optionen → "Aktivieren für Netzwerkzugriff" |

### Check 2 — Ist die MAC-Adresse richtig?

```bash
# Am Ziel während es wach ist:
# Windows:
ipconfig /all   # "Physikalische Adresse" suchen

# Linux:
ip link show eth0 | grep ether
```

Die MAC in der Route muss GENAU passen. Häufiger Fehler: dein Ziel hat mehrere NICs (Ethernet + WiFi) und du hast die falsche konfiguriert. WoL über WiFi ist selten und meist nicht unterstützt — nimm die MAC der Kabel-NIC.

### Check 3 — Nutzt der Gateway-Container Host-Networking?

```bash
docker inspect gatecontrol-gateway --format '{{.HostConfig.NetworkMode}}'
# Erwartet: host
```

Bridge-Modus blockiert rohe Broadcast-Frames. Das WoL des Gateways nutzt SO_BROADCAST was Host-Networking voraussetzt.

### Check 4 — Sind Gateway und Ziel auf demselben L2-Segment?

Magic-Packets routen nicht über L3. Gateway und Ziel müssen auf demselben VLAN / derselben Switch-Domain / demselben Subnetz sein. Wenn ein Router dazwischen ist (z.B. ein VLAN für IoT, ein anderes für Server), kreuzt WoL die Router-Grenze nicht. Gateway ins VLAN des Ziels verlegen oder einen WoL-Relay am Router einrichten (manche OpenWrt-Builds, manche Enterprise-Router).

### Check 5 — Strippt dein Switch Broadcast?

Unmanaged Consumer-Switches leiten Broadcast transparent weiter. Manche Managed-Switches mit "Storm-Control" oder aggressivem IGMP-Snooping droppen Magic-Packets. Storm-Control am Ziel-Port deaktivieren oder Gateway-MAC whitelisten.

### Mit externem WoL-Tool verifizieren

Um WoL unabhängig von GateControl zu prüfen:

```bash
# Auf beliebigem Linux-Host im selben L2:
apt install wakeonlan
wakeonlan AA:BB:CC:DD:EE:FF
```

Wenn das auch nicht weckt, liegt das Problem am Ziel / Switch / BIOS, nicht an GateControl.

---

## VM-Netzwerkmodus (Bridge vs NAT)

**Symptom:** Gateway läuft in einer VM. Tunnel steht, Routen gehen, aber WoL scheitert und/oder manche LAN-Geräte unerreichbar.

### Ursache

VMs in **NAT-Modus** (VMware / VirtualBox / Hyper-V / QEMU Defaults) erscheinen im LAN als der Hypervisor. Sie können Unicast-Traffic raussenden, aber:

- **Eingehender Broadcast** (inkl. WoL-Replies, mDNS) wird vom Hypervisor gedroppt
- **ARP für LAN-IPs** wird abgefangen — die VM denkt der Hypervisor ist das Ziel
- **Ausgehender Broadcast** (WoL-Magic-Packet) oft gedroppt oder aufs virtuelle Netz begrenzt

### Fix

NIC der VM auf **Bridge-Modus** umstellen. Die VM erscheint dann im LAN mit eigener MAC und IP, genau wie ein physischer Host.

- **Proxmox:** Hardware → Network Device → Bridge-Modus (Default)
- **ESXi / vSphere:** Port-Group, nicht NAT
- **VirtualBox / VMware Workstation:** NIC-Attachment → Bridged Adapter
- **Hyper-V:** External Virtual Switch (nicht Internal)

**Synology VMM** erzwingt NAT per Default. Stattdessen Synology-gehostetes Docker direkt nutzen (siehe [deployment/synology.md](../deployment/synology.md)) statt VM im VMM.

---

## Port-Konflikt / Listen-Port abgelehnt

**Symptom:** Beim Anlegen einer L4-Route sagt das UI "Port X ist bereits in Nutzung" oder "Port X ist reserviert".

### Reservierte Ports

Der GateControl-Server lehnt das Binden dieser öffentlichen Ports ab: `80, 443, 22, 2019, 3000, 51820`. Werden von Caddy, SSH, Admin-API, Node-App und WireGuard genutzt. Anderen Port wählen.

### In-use von anderer L4-Route

Routen-Liste prüfen. Wahrscheinlich hast du schon eine L4-Route auf diesem Port (evtl. deaktiviert). Fehlermeldung beim Create/Save enthält die konfliktierende Route-ID.

### In-use am Host außerhalb GateControl

Seltener möglich: etwas anderes am Host lauscht auf dem Port. Prüfen mit:

```bash
ss -lntu | grep ':<port> '
```

---

## Config-Sync hängt / Hash-Mismatch

**Symptom:** Gateway-Logs zeigen `config hash mismatch, refetching...` in einer Schleife.

### Ursache

Server und Gateway nutzen verschiedene Versionen von `@callmetechie/gatecontrol-config-hash`. Selten (das Paket ist via Peer-Dependencies gepinnt), kann aber passieren wenn eine Seite zurückgerollt wird ohne die andere.

### Fix

Beide Seiten auf dasselbe Server-Release updaten. Einfachst: das neueste Gateway-Image und das neueste Server-Image ziehen, beide neu starten.

```bash
# Am Gateway-Host:
cd /opt/gatecontrol-gateway
docker compose pull
docker compose up -d

# Am GateControl-Server (meist separat via update.sh):
cd /opt/gatecontrol
./update.sh
```

Wenn das Problem bleibt, GitHub-Issue öffnen mit der Log-Zeile die beide Hashes zeigt.

---

## Gateway flapt online/offline

**Symptom:** UI zeigt den Gateway wiederholt zwischen online und offline wechselnd, mehrmals pro Stunde.

### Check 1 — Internet-Stabilität am Gateway-Standort

Häufigste Ursache. Ein flaky Heim-ISP oder ein Gateway-Host am WiFi kann Heartbeats intermittierend droppen.

```bash
# Am Gateway-Host, 5 Minuten zum Server pingen:
ping -c 300 <dein-gc-server>
# Akzeptabel: <1% Loss, stabile RTT
# Problematisch: periodische 100% Loss für 3+ Sekunden am Stück
```

Ist das Underlying-Connection-Problem, Heartbeat-Sensitivität senken (Server-Config) oder Netzwerk stabilisieren (Gateway von WiFi auf Ethernet, flakigen Router tauschen).

### Check 2 — Gateway-Host überlastet

Heartbeats können ihr Fenster verpassen wenn der Host CPU-starved ist.

```bash
docker stats gatecontrol-gateway
# Nach CPU % > 100 oder Speicher am Limit Ausschau halten
```

Gateway nutzt typisch <50 MB RAM und <1% CPU. Wenn deutlich höher, hungert etwas anderes am Host ihn aus (zu ambitionierter Plex-Transcode, Memory-Leak in anderem Container etc.).

### Check 3 — Flap-Warnings in Server-Logs

Der Server loggt ein `gateway_flap_warning` Activity-Event wenn er >4 Transitionen pro Stunde sieht. In Settings → Activity-Log → nach Event-Type `gateway_flap_warning` filtern für Diagnose-Details.

---

## RDP: Credentials abgelehnt nach Gateway-Wechsel

**Symptom:** RDP hat früher geklappt (direkter Peer-Connect), jetzt routest du es über den Gateway, Windows lehnt das Passwort mit "Anmeldeversuch fehlgeschlagen" ab.

### Ursache

Das ist fast immer ein **SPN-Mismatch (Service Principal Name) mit NLA**. Details:

- NLA (Network Level Authentication) nutzt CredSSP um vor Öffnung des RDP-Channels zu authentifizieren
- CredSSP verifiziert dass der CN des Ziel-Zertifikats zum gewählten Dial matcht
- Wenn du `yourdomain.com:13389` dialst, der Windows-Maschine's Cert-CN aber `DESKTOP-XXXXXX` ist, schlägt der Verify still fehl und Windows meldet "Anmeldung fehlgeschlagen"

### Fix

GateControls **Internal-DNS-Feature** löst das. Wenn aktiviert, registriert der Gateway jeden Peer unter seinem Hostname in einem internen DNS. Der RDP-Client kann dann den FQDN (`desktop.gc.internal`) dialen der zum Cert passt. Die vom UI erzeugte `.rdp`-Datei nutzt dieses Pattern automatisch.

Server-Settings → DNS → ist Internal-DNS aktiviert? (Feature-Flag `internal_dns`.)

Manueller Workaround (nicht produktionsempfohlen): NLA am Ziel deaktivieren (`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp\UserAuthentication = 0`). Schwächere Sicherheit aber funktional.

---

## Logs zeigen "container read-only filesystem" Fehler

**Symptom:** Gateway-Container beendet sich beim Start mit Fehlern wie `EROFS: read-only file system` beim Schreiben nach `/tmp` oder `/etc/wireguard`.

### Ursache

Das Default-`docker-compose.example.yml` läuft den Container mit `read_only: true` und einer spezifischen Liste von `tmpfs`-Mounts. Wenn die Volume-Liste unvollständig ist (z.B. jemand hat das Compose editiert und `/etc/wireguard` tmpfs entfernt), kann WireGuards `wg-quick` seine Runtime-Config nicht schreiben.

### Fix

Den Default-`tmpfs`-Abschnitt aus `docker-compose.example.yml` wiederherstellen:

```yaml
tmpfs:
  - /tmp
  - /run
  - /etc/wireguard     # REQUIRED: wireguard-go schreibt hier
```

Security-Hinweis: `/etc/wireguard` MUSS in tmpfs liegen für Schreibbarkeit. `read_only: true` und `cap_drop: ALL` sind kompensierende Kontrollen; nicht deaktivieren um das zu "fixen".

---

## Wie man brauchbare Logs für einen Bug-Report bekommt

Wenn du ein GitHub-Issue öffnest, beilegen:

```bash
# Version-Info
docker exec gatecontrol-gateway cat /app/package.json | grep version
# Erwartet: "version": "1.3.0"   (oder was installiert ist)

# Letzte Logs auf info-Level
docker logs gatecontrol-gateway --since 30m > gateway-logs.txt

# WireGuard-Handshake-Status
docker exec gatecontrol-gateway wg show

# Config-State (api_token VOR dem Posten redigieren!)
docker exec gatecontrol-gateway env | grep -E "^GATEWAY_|^LOG_|^HTTP_|^MANAGEMENT_"
```

Dann temporär auf Debug-Logging wechseln und reproduzieren:

```bash
docker compose down
LOG_LEVEL=debug docker compose up -d
# Issue reproduzieren
docker logs gatecontrol-gateway --since 5m > gateway-debug.txt
```

IP-Adressen und Tokens vor dem Posten redigieren. Die GateControl-Maintainer brauchen nie deinen `api_token`.
