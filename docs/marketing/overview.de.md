# GateControl Home Gateway — Produktüberblick

Marketing-taugliche Textbausteine für den GateControl Home Gateway. Fertig zum Einsetzen in eine Website, ein README-Intro, einen Product-Hunt-Launch oder eine Verkaufsunterhaltung. Mehrere Längen enthalten, damit du je nach Medium die passende wählst.

---

## Taglines (eine wählen)

- **"Dein Heimnetz. Von überall. In deiner Hand."**
- **"Ein Container zu Hause. Alle deine Geräte, remote."**
- **"Remote-Zugriff aufs Heimnetz — ohne Kompromisse."**

---

## 50-Wort-Elevator-Pitch

Ein einziger Docker-Container auf einem Raspberry Pi, einem Synology NAS oder einer beliebigen Linux-Maschine zu Hause. Jedes Gerät in deinem LAN — NAS, Heim-PC, Smart-Home-Hub, Drucker, Gaming-Desktop — wird von überall unter deiner eigenen Domain erreichbar, mit automatischem HTTPS und eingebautem Wake-on-LAN. Keine Router-Konfiguration. Keine Third-Party-Cloud.

---

## 200-Wort-Hero-Copy (Landing Page)

### Endlich: Remote-Zugriff aufs Heimnetz, den du wirklich besitzt.

Der GateControl Home Gateway ist ein kleiner Docker-Container, der auf einem beliebigen dauerhaft laufenden Gerät in deinem Heimnetz läuft — einem Raspberry Pi, einem Mini-PC, deinem Synology NAS, einer VM auf Proxmox. Sobald er läuft, ist jeder Dienst in deinem Heimnetz von überall im Internet erreichbar: NAS, Home Assistant, Plex, Jellyfin, Router-Admin, schlafender Gaming-Desktop. Alles über saubere HTTPS-URLs auf deiner eigenen Domain (`nas.example.com`, `hass.example.com`, `rdp.example.com`), mit Let's-Encrypt-Zertifikaten die automatisch ausgestellt werden.

Es gibt **keine Portweiterleitungen an deinem Heimrouter**, weil Traffic durch einen WireGuard-Tunnel ankommt, den du kontrollierst. Es gibt **keine VPN-Clients auf irgendeinem deiner Geräte**, weil der Gateway das stellvertretend übernimmt. Und es gibt **keine Third-Party-Cloud zwischen dir und deinen Daten**, weil der öffentliche Endpunkt ein Server ist, den du besitzt — typischerweise ein VPS für 5 €/Monat.

Wenn dein Gaming-PC schläft, weckt der Gateway ihn auf Abruf. Wenn ein Dienst ausfällt, siehst du es im Dashboard. Wenn jemand nach Schwachstellen sucht, bleibt dein Heimnetz hinter einem Tunnel, den es selbst initiiert hat, unsichtbar.

**Self-Hosted. Open Source. Dein Eigentum.**

---

## Fünf Gründe, warum Leute das wirklich mögen

### 1. Keine Port-Weiterleitung, kein DynDNS, keine Router-Operation
Dein Heim-Router sieht nie eine eingehende Verbindung. Der Gateway öffnet einen ausgehenden WireGuard-Tunnel; alles läuft darauf. Die Angriffsoberfläche die dein ISP-Router dem Internet exponiert, bleibt auf null.

### 2. Ein Container deckt jedes Gerät in deinem LAN ab
Kein WireGuard auf dem NAS. Nichts auf dem Drucker. Keinen Agenten auf dem Smart-TV. Der Gateway ist der Agent für sie alle. Route im Web-UI hinzufügen; das Zielgerät muss nichts davon wissen.

### 3. Echtes HTTPS auf echten Domains
Dein NAS erscheint als `https://nas.yourdomain.com` mit grünem Schloss und einem Let's-Encrypt-Zertifikat, dem jeder Browser und jede Mobile-App vertraut. Kein `https://192.168.1.50:5001` mit Self-Signed-Warnung. Kein `https://yourname.somecloud.net`. Deine Marke, deine Domain.

### 4. Wake-on-LAN, das tatsächlich funktioniert
Der Gaming-Desktop ist 23 Stunden am Tag aus. Du willst genau dann per RDP drauf, wenn du ihn brauchst. Der Gateway sieht den Verbindungsversuch, sendet das Magic-Packet, wartet aufs OS und tunnelt deine Session durch. Erster Connect braucht 20–40 Sekunden; danach ist es instant bis du die Verbindung beendest.

### 5. Deine Daten, dein Server, dein Audit-Log
Der öffentliche Endpunkt ist dein VPS. Die Tunnel-Keys liegen auf deiner Hardware. Das Activity-Log ist eine SQLite-Datei auf diesem VPS — lesbar, exportierbar, deins zum Aufbewahren oder Löschen. Keine Telemetrie zu Dritten. Keine "Wir haben unsere Datenschutzerklärung aktualisiert"-Mail in sechs Monaten.

---

## Für wen ist das

### Der Homelabber
Du hast ein Synology NAS, eine Home-Assistant-Box, einen Plex-Server, vielleicht ein Pi-hole. Du hast DynDNS + Portforwards probiert; war flaky. Du hast Tailscale probiert; dir gefällt nicht, dass dein Traffic durch deren Control-Plane läuft. Du willst eine Domain, die vom Handy, vom Gäste-WLAN der Schwiegereltern, vom Café funktioniert — und du willst, dass die Pipeline eine ist, die du End-to-End kontrollierst.

### Der Small-Office-Admin
Vier Leute in einem geteilten Büro. Zwei davon arbeiten manchmal von zu Hause. Du musst ihnen Zugriff auf das gemeinsame NAS geben, auf den Lizenzserver, vielleicht auf eine RDP-Session zum gemeinsamen Windows-Rechner. Du willst keinen VPN-Client auf jedem privaten Gerät installieren. Du willst nicht, dass jemand seinen Laptop mit Kill-Switch-losem Tunnel im Café vergisst. Du willst Per-Route-Authentifizierung, sodass Alice das NAS sehen kann, aber nicht den Lizenzserver.

### Die Prosumer-Familie
Du hostest Fotos zu Hause. Die Schwiegereltern wollen die Kinderbilder anschauen. Ein Freund ist zu Besuch und will den Film streamen, von dem du geschwärmt hast. Keiner davon soll einen VPN-Client installieren; keiner davon muss wissen, was eine IP-Adresse ist. Du teilst eine URL, sie loggen sich mit ihrer E-Mail ein, sie sehen nur das, was du freigegeben hast.

### Der Ein-Mann-Berater
Du betreibst ein Home-Office mit einer Mischung aus Arbeits- und Privatgeräten. Der Arbeits-Desktop ist stark; der Reise-Laptop ist dünn. Du willst vom Laptop beim Kunden per RDP auf den Desktop. Du willst keine VPN-Infrastruktur warten. Du willst etwas, das du an einem Nachmittag aufsetzt und vergisst.

---

## Vergleich

| | **GateControl Home Gateway** | Tailscale / ZeroTier | Cloudflare Tunnel | Klassisches Port-Forward + DynDNS | Per-Device WireGuard |
|---|---|---|---|---|---|
| **Infrastruktur End-to-End in deiner Hand** | Ja — dein VPS | Teilweise — deren Control-Plane | Nein — deren Edge | Ja | Ja, pro Gerät |
| **Funktioniert für Geräte ohne VPN-Client** (NAS, Drucker, IoT, TV) | Ja — ein Container für alle | Nein — Agent pro Gerät | Ja | Ja, aber offener Port pro Dienst | Nein |
| **Automatisches Let's Encrypt auf deiner Domain** | Ja, ohne Config | Nein — braucht extra Tooling | Ja | Nein — manuell | Nein |
| **Wake-on-LAN von außen** | Eingebaut | Nein | Nein | Nein | Nein |
| **Keys und Logs bleiben auf deinem Server** | Ja | Nein — Control-Plane ist ihre | Nein — Daten fließen durch sie | Ja | Ja |
| **Setup-Komplexität für N Geräte** | Ein Container, N Routen | Ein Agent pro Gerät | Ein Tunnel pro Dienst | N Router-Regeln + N Cert-Workflows | N WireGuard-Configs |
| **Per-Route-User-Auth** | Ja (E-Mail-OTP, TOTP) | Nein | Ja (mit Extra-Config) | Nein | Nein |
| **Open Source, self-hostable** | Ja | Teilweise (Control-Plane ist SaaS) | Nein | Ja (aber kein echtes UI) | Ja (aber gar kein UI) |
| **Voraussetzung: Always-on-LAN-Host** | Ja | Nein | Nein | Nein | Nein |
| **Voraussetzung: Eigene Domain** | Ja | Nein | Ja | Ja | Nein |

---

## Unter der Haube

**Moderne Kryptografie.** Aller Tunnel-Traffic nutzt die Standard-WireGuard-Primitive — Curve25519 für Key-Exchange, ChaCha20-Poly1305 für Authenticated-Encryption, BLAKE2s für Hashing. Post-Quanten-Resistenz via Preshared-Keys ist per Default aktiv. Route-Auth-Passwörter werden mit Argon2id gehashed.

**Security-gehärteter Container.** Der Gateway läuft als non-root User in einem read-only Filesystem mit gedroppten Linux-Capabilities außer den zwei für WireGuard und Low-Port-Binding benötigten (`NET_ADMIN`, `NET_BIND_SERVICE`). Dockers Default-Seccomp-Profil ist aktiv. Schreibbare Pfade sind nur tmpfs; nichts persistiert im Container über Restarts.

**Let's Encrypt automatisch.** Jede HTTP-Route bekommt ein ACME-ausgestelltes Zertifikat ohne manuelle Konfiguration. Caddy handelt Erneuerung, Rollover und gelegentliche Rate-Limits still im Hintergrund.

**Keine Telemetrie.** Der Gateway spricht nur mit deinem eigenen Server. Es gibt kein Phone-Home, keinen anonymen Statistik-Beacon, keinen Lizenz-Check. Du kannst alles außer deinem VPS an der Firewall blackholen, und es funktioniert trotzdem.

**Open Source.** Der Quellcode liegt auf GitHub, auditierbar, forkbar, patchbar. Container-Images werden auf GitHub Container Registry publiziert, mit reproduzierbaren Builds und CVE-Scans bei jedem Release.

---

## Häufige Fragen

### Ersetzt das meinen VPN?

Kommt darauf an, wofür du den VPN nutzt. Wenn du VPN nutzt, um aus der Ferne auf Heim-Ressourcen zuzugreifen — ja, der Home Gateway ersetzt diesen Use-Case mit saubererer Semantik (Per-Service-URLs, Per-Route-Auth, automatisches TLS). Wenn du VPN für Privatsphäre in Public-WiFi nutzt — Laptop-Traffic über einen Exit-Node — ist das ein anderer Use-Case, und GateControls klassischer WireGuard-Peer-Modus handhabt das.

### Brauche ich eine öffentliche statische IP zu Hause?

Nein. Der Gateway baut eine ausgehende Verbindung zu deinem VPS auf; der VPS braucht die statische IP (oder DNS-Eintrag). Dein Heim-Internet kann eine dynamische IP und NAT haben, wie Millionen Haushalte.

### Was kostet der Betrieb?

Die Software ist kostenlos. Du brauchst einen Linux-VPS für den GateControl-Server — ein beliebiger Anbieter für 3–5 €/Monat reicht (Hetzner Cloud, Scaleway, OVH, DigitalOcean). Der Gateway-Container läuft auf Hardware, die du bereits hast. Ein Raspberry Pi 4 ist üppig; ein Mini-PC oder das Synology, das du schon besitzt, passt.

### Was passiert, wenn mein VPS down ist?

Deine Dienste sind von außen unerreichbar bis der VPS wieder oben ist. Aus dem Heim-LAN sind sie wie immer erreichbar. Da der VPS eine Standard-Linux-Maschine ist, kannst du ihn in Minuten mit automatischen Backups ersetzen oder neu bauen; VPS-Provider geben SLAs im "99,9 %"-Bereich, in der Praxis ist das selten.

### Wie sicher ist das, wenn das LAN-Ziel eine Schwachstelle hat?

GateControl patcht deine internen Anwendungen nicht. Wenn dein Synology eine Schwachstelle hat, erreicht eine Freigabe über den Gateway denselben Code wie eine Freigabe über einen Port-Forward. Der Gateway erlaubt dir, **zusätzliche Authentifizierung** (Route-Auth mit E-Mail-OTP oder TOTP) auf jedem Dienst zu schichten, was viele Heim-User für alte Admin-Oberflächen wertvoll finden.

### Kann ich mehrere Gateways betreiben?

Ja, oft empfohlen. Einer pro Standort (Zuhause, Büro, Ferienhaus) oder einer pro Security-Domain (IoT-VLAN vs. Work-VLAN). Jeder Gateway ist ein separater Peer auf dem GateControl-Server; du siehst sie alle nebeneinander im Dashboard.

### Was passiert, wenn der Gateway-Container crasht?

Dockers Health-Check startet ihn binnen Sekunden neu. Die server-seitige Health-Statemaschine toleriert kurze Ausfälle; anhaltende Fehler zeigen sich als "offline"-Badge im Dashboard und (seit v1.54) triggern einen TCP-Probe, um Recovery zu erkennen ohne auf den nächsten Heartbeat zu warten.

### Ist das sicher genug für meine Buchhaltungs-Software / Kundendateien / echte Geschäftsdaten?

Der Transport ist so sicher, wie WireGuard plus TLS 1.3 sein können. Die Access-Controls (Argon2id-Passwörter, Per-Route-Auth, Audit-Log) sind production-grade. Die **Gesamtsicherheit** deines Deployments hängt aber auch davon ab, was an beiden Endpunkten ist: sind dein VPS und dein Gateway-Host gepatcht, ist die Ziel-Anwendung selbst sicher, nutzen deine User starke Passwörter. GateControl stellt die Pipeline bereit; Application-Security bleibt Sache der Application.

---

## Fertige Textblöcke zum Einsetzen

### Tweet / Mastodon (280 Zeichen)

> Self-hosted Remote-Zugriff aufs Heimnetz. Ein Container auf dem Pi, jedes LAN-Gerät via `https://deinedomain.com` mit Let's-Encrypt. Keine Port-Forwards, kein VPN-Client pro Gerät, keine Third-Party-Cloud. GateControl Home Gateway.

### README-Intro (für Projekte die es integrieren)

> **GateControl Home Gateway** ist ein dauerhaft laufender Container, der einen einzelnen WireGuard-Tunnel zu jedem Gerät in deinem LAN überbrückt. HTTP- und TCP-Proxies, Wake-on-LAN, Auto-Sync mit einem GateControl-Server — sodass jeder Heim-Dienst über saubere HTTPS-URLs auf deiner eigenen Domain erreichbar ist, ohne Router-Konfiguration oder Per-Device-VPN-Clients.

### Product Hunt / Hacker News Zusammenfassung (3–4 Sätze)

> Open-Source-Begleiter zu [GateControl](https://github.com/CallMeTechie/gatecontrol) für Homelabber und Prosumer, die Remote-Zugriff aufs Heimnetz wollen, ohne Tailscale-artige Third-Party-Control-Planes. Läuft als einzelner Docker-Container auf einem Pi oder NAS. Exponiert LAN-Geräte unter deiner eigenen Domain mit automatischem Let's Encrypt, Wake-on-LAN und Per-Route-User-Authentifizierung. Nichts Proprietäres, nichts Phone-Home; du besitzt den VPS, den Tunnel, die Domain und die Keys.

### E-Mail- / Forums-Signatur

> Gebaut mit GateControl Home Gateway — Self-Hosted-Remote-Zugriff aufs Heimnetz. github.com/CallMeTechie/gatecontrol-gateway

---

## Nächste Schritte für den Leser

Nach dem Lesen der Marketing-Copy wollen interessierte User typischerweise:

- **"Wie sieht das konkret aus?"** → [User-Journey-Walkthroughs](../documentation/01-user-journey.de.md)
- **"Ist das für mein Setup richtig?"** → [Decision Guide](../documentation/02-decision-guide.de.md)
- **"Ist das so sicher wie ihr sagt?"** → [Security Model](../documentation/05-security-model.de.md)
- **"Wie installiere ich das?"** → [Deployment Docs](../deployment/)
