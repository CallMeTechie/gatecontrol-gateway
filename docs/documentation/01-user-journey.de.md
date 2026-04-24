# End-to-End User Journey

Dieses Dokument führt durch die **häufigsten Szenarien**, die ein Home-User oder Small-Team-Admin mit einem GateControl Home Gateway umsetzen will. Jedes Szenario ist eine sequenzielle Checkliste — Voraussetzungen, UI-Klicks, Befehle, Verifikation — damit du in 15–30 Minuten von null auf funktionierenden Zugriff kommst.

Wenn du noch überlegst, ob ein Home Gateway überhaupt das Richtige ist, lies zuerst **[02 — Decision Guide](02-decision-guide.de.md)**. Wenn ein Schritt dich verwirrt, schau in **[04 — Troubleshooting](04-troubleshooting.de.md)**.

---

## Inhaltsverzeichnis

- [Voraussetzungen](#voraussetzungen)
- [Szenario A — NAS per HTTPS freigeben (häufigster Fall)](#szenario-a--nas-per-https-freigeben-häufigster-fall)
- [Szenario B — Remote Desktop auf einen Heim-PC](#szenario-b--remote-desktop-auf-einen-heim-pc)
- [Szenario C — Schlafenden Desktop on-demand aufwecken](#szenario-c--schlafenden-desktop-on-demand-aufwecken)
- [Szenario D — Nicht-HTTP-Dienst freigeben (SSH / DB / Gameserver)](#szenario-d--nicht-http-dienst-freigeben-ssh--db--gameserver)
- [Szenario E — Mehrere Geräte hinter einem Home Gateway](#szenario-e--mehrere-geräte-hinter-einem-home-gateway)
- [Was du gerade gebaut hast](#was-du-gerade-gebaut-hast)

---

## Voraussetzungen

Bevor du ein Szenario startest, stelle sicher:

1. **Ein laufender GateControl-Server** — deployed laut [INSTALL.de.md](https://github.com/CallMeTechie/gatecontrol/blob/master/INSTALL.de.md). Du erreichst das Admin-UI, du kannst dich einloggen.
2. **Eine registrierte Domain** mit DNS-Kontrolle. Pro exponiertem Dienst brauchst du einen A-Record (z.B. `nas.example.com`, `rdp.example.com`).
3. **Ein dauerhaft laufendes Gerät im Heim-LAN** als Host für den Gateway-Container — Raspberry Pi, Mini-PC, Synology NAS, Proxmox-VM etc. Linux mit Docker ist erforderlich. Plattform-spezifische Setup-Anleitungen siehe [deployment docs](../deployment/).
4. **Zielgerät muss vom Gateway-Host aus erreichbar sein** unter seiner LAN-IP. Teste das vor Start: `ping` und `curl` vom Gateway-Host zum Zielgerät müssen erfolgreich sein.

> **Achtung bei VMs:** Ein Gateway-Container in einer VM braucht **Bridge-Networking** (nicht NAT). NAT bricht Wake-on-LAN und rohe ARP. Siehe [04 — Troubleshooting: "VM-Netzwerkmodus"](04-troubleshooting.de.md#vm-netzwerkmodus-bridge-vs-nat).

---

## Szenario A — NAS per HTTPS freigeben (häufigster Fall)

**Ziel:** Zugriff auf dein Synology- / TrueNAS- / UnRAID-Web-UI über `https://nas.example.com` von überall, mit automatischem TLS.

### Schritt 1 — Gateway-Peer anlegen

1. GateControl Admin-UI öffnen.
2. **Peers** → **Neuer Peer**.
3. Aussagekräftigen Namen geben, z.B. `home-gateway`.
4. **"Home Gateway"** anhaken (wichtig — markiert den Peer als Gateway-Container, nicht als Standard-Client).
5. Speichern.

Auf der Peer-Detail-Seite erscheint ein **"Gateway-Config herunterladen"**-Button. Klicken. Du bekommst `gateway-<id>.env` — die Datei aufheben, sie enthält den Private-Key des Peers plus API-Tokens.

### Schritt 2 — Gateway-Container zu Hause deployen

Auf deinem Heim-LAN-Host ein dediziertes Verzeichnis anlegen und die `.env` dort ablegen:

```bash
mkdir -p /opt/gatecontrol-gateway/config
cp ~/Downloads/gateway-<id>.env /opt/gatecontrol-gateway/config/gateway.env
cd /opt/gatecontrol-gateway
curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml
mv docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Der Container:

- Baut einen WireGuard-Tunnel zum GateControl-Server auf
- Startet die Management-API auf der Tunnel-IP (Default `10.8.0.x:9876`)
- Sendet alle 30 Sekunden einen Heartbeat

### Schritt 3 — Gateway-Verbindung prüfen

Zurück im Admin-UI:

1. **Peers** → auf `home-gateway` klicken.
2. Status sollte binnen ~30 s auf **online** wechseln.
3. Peer-Detail zeigt "Letzter Heartbeat: vor N Sekunden" und "Health: ok".

Bleibt der Status länger als 60 s offline, siehe [04 — Troubleshooting: "Gateway bleibt offline"](04-troubleshooting.de.md#gateway-bleibt-offline).

### Schritt 4 — DNS-A-Record anlegen

In deinem DNS-Provider:

```
nas.example.com.   IN  A   <öffentliche IP deines GateControl-Servers>
```

Propagation abwarten (meist unter einer Minute). Verifikation:

```bash
dig +short nas.example.com
# muss die öffentliche IP deines Servers liefern
```

### Schritt 5 — HTTP-Route erstellen

Im Admin-UI:

1. **Routen** → **Neue Route**.
2. **Domain:** `nas.example.com`
3. **Ziel-Typ:** `Home Gateway` (nicht `Peer`)
4. **Gateway-Peer:** `home-gateway` aus Dropdown
5. **LAN-Ziel-Host:** LAN-IP deines NAS, z.B. `192.168.1.50`
6. **Ziel-Port:** Port, auf dem das NAS antwortet, z.B. `5000` für Synology HTTP oder `5001` für HTTPS
7. **Backend HTTPS:** **nur** aktivieren wenn das Ziel HTTPS mit selbstsigniertem Cert serviert (typisch für Synology auf 5001, UnRAID, Fritzbox)
8. Speichern

Binnen Sekunden holt sich Caddy auf dem GateControl-Server ein Let's-Encrypt-Zertifikat für `nas.example.com` und beginnt zu servieren.

### Schritt 6 — Zugriff verifizieren

`https://nas.example.com` im Browser öffnen. Du siehst die NAS-Login-Seite, TLS-Schloss grün.

Per CLI (schneller Sanity-Check):

```bash
curl -sI https://nas.example.com | head -3
# Erwartet: HTTP/2 200 oder HTTP/2 302 (Login-Redirect)
```

Fertig. Jedes Mal wenn du einen weiteren Dienst im LAN freigeben willst (z.B. `plex.example.com`), wiederhole Schritte 4–5. Der Gateway-Container läuft durch; Routen werden im Admin-UI hinzugefügt und automatisch gepusht.

---

## Szenario B — Remote Desktop auf einen Heim-PC

**Ziel:** Per RDP auf einen Windows-PC im LAN zugreifen, von überall, ohne Port 3389 am Heim-Router zu öffnen.

Zwei Wege. Einen wählen.

### Option 1 — RDP-Route mit Zugriffsmodus "Home Gateway" (empfohlen)

Erhält alle RDP-spezifischen Features (Credential-Vault, Auflösungsprofile, Clipboard-Policy, Audio, WoL-Trigger) und versteckt die LAN-IP vor dem Client.

Benötigt Schritte 1–3 aus Szenario A (Gateway-Peer erstellt + Container läuft).

1. **Routen** → **Neue RDP-Route**.
2. **Name:** `Home Desktop`
3. **Zugriffsmodus:** `Über Home-Gateway`
4. **Gateway-Peer:** `home-gateway`
5. **LAN-Ziel:** `192.168.1.100:3389` (oder worauf die Windows-Maschine antwortet)
6. **Öffentlicher Listen-Port:** ungenutzten Port am GateControl-Server, z.B. `13389`
7. **Credentials:** optional — Username/Passwort für One-Click-Connect speichern
8. Speichern

GateControl legt automatisch eine L4-TCP-Route an die den öffentlichen Listen-Port durch den Gateway zum LAN-RDP-Port weiterleitet. Die `.rdp`-Datei, die du auf der Routes-Seite herunterladen kannst, nutzt die öffentliche Adresse + Listen-Port, nie die LAN-IP.

Vom Client-Rechner:

- `.rdp`-Datei von der Routes-Seite laden und doppelklicken, oder
- Beliebigen RDP-Client mit Adresse `yourdomain.com:13389` nutzen

### Option 2 — Reine L4-TCP-Route (simpler, weniger Features)

Wenn du einfach "RDP auf einem öffentlichen Port" ohne den RDP-Featureset willst, leg eine schlichte L4-Route an:

1. **Routen** → **Neue L4-Route**.
2. **Name:** `RDP zu Heim-Desktop`
3. **Protokoll:** TCP
4. **Listen-Port:** `13389` am GateControl-Server
5. **Ziel-Typ:** `Home Gateway`
6. **Gateway-Peer:** `home-gateway`
7. **LAN-Ziel:** `192.168.1.100:3389`
8. Speichern

Client verbindet mit `mstsc /v:yourdomain.com:13389` — keine weitere Server-Konfiguration nötig.

---

## Szenario C — Schlafenden Desktop on-demand aufwecken

**Ziel:** Dein Windows-Desktop schläft meist. Wenn du per RDP verbinden willst, soll der Gateway ihn aufwecken, auf das OS warten und dann durchtunneln.

Kombiniert eine RDP/L4-Route (aus Szenario B) mit WoL-Konfiguration. Funktioniert nur wenn:

- **BIOS**: Wake-on-LAN im BIOS/UEFI des Zielgeräts aktiviert
- **OS**: Power-Settings erlauben "Dieses Gerät aufwecken" am Netzwerkadapter (Windows → Gerätemanager → NIC → Eigenschaften → Energieverwaltung)
- **Switch/Router zwischen Gateway und Ziel**: Magic-Packets dürfen nicht gestrippt werden. Unmanaged-Switches sind OK; manche Managed-Switches brauchen IGMP-/Multicast-Tweaks. Siehe [04 — Troubleshooting: "WoL weckt Gerät nicht"](04-troubleshooting.de.md#wol-weckt-gerät-nicht).
- **Netzwerkmodus**: Gateway-Container nutzt **host-networking** (Voraussetzung für rohe Broadcast-Pakete).

### Schritt 1 — MAC-Adresse ermitteln

Am Zielgerät:

- Windows: `ipconfig /all` — "Physikalische Adresse"
- Linux: `ip link show` — `link/ether AA:BB:CC:DD:EE:FF`
- macOS: `ifconfig | grep ether`

### Schritt 2 — WoL an der Route aktivieren

In den Route-Settings (aus Szenario B Option 1 oder 2):

1. **Wake-on-LAN:** aktivieren
2. **Ziel-MAC:** `AA:BB:CC:DD:EE:FF`
3. **WoL-Timeout:** wie lange der Gateway auf die Response wartet (Default 60 s)
4. **WoL-Poll-Intervall:** wie oft der Gateway in der Wake-Phase TCP-Retry macht (Default 3 s)
5. Speichern

### Schritt 3 — Wake triggern

Einfach vom Client aus zur Route verbinden. Das Monitoring-System am GateControl-Server erkennt, dass das Ziel down ist, weist den Gateway an das Magic-Packet zu senden, wartet auf das Hochfahren und lässt dann die Verbindung durch. Latenz beim ersten Connect: 15–45 s je nach Gerät.

Folgeverbindungen (solange das Gerät wach bleibt) sind instant.

---

## Szenario D — Nicht-HTTP-Dienst freigeben (SSH / DB / Gameserver)

**Ziel:** Beliebigen TCP- oder UDP-Dienst im LAN über einen öffentlichen Port erreichen.

Das ist eine reine L4-Route. Gleiche Rezeptur wie Szenario B Option 2, anderes Protokoll/Port:

| Dienst | Protokoll | LAN-Port | Vorgeschlagener öffentlicher Port |
|---|---|---|---|
| SSH zu Heim-Server | TCP | 22 | 2222 |
| PostgreSQL | TCP | 5432 | 15432 |
| Minecraft | TCP + UDP | 25565 | 25565 |
| Plex | TCP | 32400 | 32400 |

Für UDP und Multi-Port-Dienste (Minecraft braucht TCP+UDP am selben Port) zwei Routen anlegen — eine pro Protokoll.

**Öffentliche Ports 80, 443, 22, 2019, 3000, 51820 meiden** — die werden vom GateControl-Server selbst genutzt. Das Admin-UI lehnt sie ab.

Verbindung vom Client:

```bash
ssh -p 2222 user@yourdomain.com                    # SSH
psql -h yourdomain.com -p 15432 -U postgres         # PostgreSQL
# Minecraft: "yourdomain.com:25565" im Launcher hinzufügen
```

---

## Szenario E — Mehrere Geräte hinter einem Home Gateway

**Das ist der Punkt, an dem der Home Gateway glänzt.** Ein Container, ein WireGuard-Tunnel, unbegrenzt viele Geräte.

Typisches Homelab-Setup:

| Subdomain | Ziel | Port | Route-Typ |
|---|---|---|---|
| `nas.example.com` | Synology DSM | `192.168.1.50:5001` | HTTP + Backend HTTPS |
| `photos.example.com` | Synology Photos | `192.168.1.50:6001` | HTTP + Backend HTTPS |
| `hass.example.com` | Home Assistant | `192.168.1.60:8123` | HTTP |
| `jellyfin.example.com` | Jellyfin | `192.168.1.60:8096` | HTTP |
| `rdp.example.com:13389` | Windows-Desktop | `192.168.1.100:3389` | L4 / RDP |
| `ssh.example.com:2222` | Heim-Server | `192.168.1.10:22` | L4 |
| `router.example.com` | Fritzbox-UI | `192.168.1.1:443` | HTTP + Backend HTTPS |

Alle laufen durch denselben Gateway-Container. Keine Änderungen an den Zielgeräten — keine WireGuard-Installation, keine Router-Portforwards, keine Dynamic-DNS-Clients.

---

## Was du gerade gebaut hast

Ein Home-Gateway-Setup gibt dir:

- **Zero-Touch Zielgeräte** — keine Agents installiert, keine Router-Konfiguration, kein VPN-Client auf dem NAS oder Windows-PC
- **Zentrales Management** — alle Routen leben im GateControl-Admin-UI; Hinzufügen/Entfernen/Toggle per Klick
- **Automatisches TLS** — jede HTTP-Route bekommt ein Let's-Encrypt-Zertifikat ohne Konfiguration
- **Route-Level-Auth** — Routen schützen mit E-Mail-OTP, TOTP oder Basic-Auth via Route-Auth-Settings (unabhängig vom GateControl-Admin-Login)
- **Audit-Log** — jede Verbindung und jede Config-Änderung wird im Activity-Log erfasst

Nächste Schritte:

- **[02 — Decision Guide](02-decision-guide.de.md)** — wann Gateway, wann klassischer Peer?
- **[03 — Features Reference](03-features-reference.de.md)** — volle Details zu HTTP-Proxy, L4-Proxy, WoL, Monitoring, Auto-Sync
- **[05 — Security Model](05-security-model.de.md)** — was der Gateway sehen kann, Angriffsoberfläche, Hardening-Entscheidungen
