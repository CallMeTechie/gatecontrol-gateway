# Decision Guide: Home Gateway vs. Klassischer Peer

GateControl unterstützt zwei Peer-Topologien. Dieses Dokument erklärt die Trade-offs, damit du pro Gerät und pro Anwendungsfall die richtige wählst. Viele echte Deployments mischen beide: ein Home Gateway für Haushaltsgeräte plus ein klassischer Peer für einen Arbeitslaptop.

Wenn du ganz neu bist, lies zuerst **[01 — User Journey](01-user-journey.de.md)** für eine beispielgetriebene Anleitung.

---

## Eine-Minute-Zusammenfassung

- **Home Gateway:** ein dauerhaft laufender Docker-Container in deinem LAN fungiert als Brücke für *jedes* Gerät in diesem LAN. Ein WireGuard-Tunnel, beliebig viele Ziele. Notwendig wenn das Ziel WireGuard selbst nicht ausführen kann oder soll (Drucker, NAS, IoT, schlafender Desktop der WoL braucht).

- **Klassischer Peer:** ein Gerät mit installiertem WireGuard verbindet sich direkt. Ein Tunnel pro Gerät. Richtig für Laptops, Mobilgeräte, Per-User-VPN, Server mit statischer Konfiguration.

---

## Vergleich Seite-an-Seite

| Kriterium | Home Gateway | Klassischer Peer |
|---|---|---|
| **WireGuard auf jedem Ziel installieren?** | Nein | Ja |
| **Ein Tunnel deckt viele LAN-Geräte ab** | Ja | Nein — ein Tunnel pro Gerät |
| **Drucker / IoT / TVs erreichen** (kein WG-Client verfügbar) | Ja | Nein |
| **Wake-on-LAN von außen** | Ja (eingebaut) | Nein |
| **Per-User-Authentifizierung** (verschiedene Menschen = verschiedene Accounts) | Eingeschränkt (Route-Auth) | Ja (dedizierter Peer pro User) |
| **Bring-your-own-device** (Besuch nutzt deinen Drucker) | Ja — einfach Route | Nein — braucht eigenen Peer |
| **Always-on-Anforderung** | LAN-Host muss laufen | Jedes Gerät entscheidet selbst |
| **Setup-Komplexität** | Mittel — Container + Routen | Niedrig — eine Config + Toggle |
| **Netzwerkmodus** | Meist Host-Networking nötig | Bridge reicht |
| **LAN-seitige Verschlüsselung** | Plain (Gateway → LAN ist im Heimnetz) | Verschlüsselt (WG auf dem Gerät selbst) |
| **Skalierung mit Geräten** | Flach — Routen hinzufügen, keine Peers | Linear — Peer pro Gerät |
| **Wiederherstellung nach Ziel-Reboot** | Transparent | Transparent, aber WG muss auto-starten |
| **Gerät nutzt Server-IP für outbound?** | Nein — Ziel behält LAN-Routing | Ja — Full-Tunnel-Peer nutzt Server als Exit |
| **Kill-Switch-Semantik** | Gateway IST der Client | Gerät ist der Client |

Lies die Zeilen der Reihe nach wenn du neu bist. Die kritische Frage ist meist **"kann ich WireGuard auf dem Ziel installieren?"** — wenn die Antwort Nein ist (Drucker, IoT, NAS ohne Root, schlafender PC, alte Router-Admin-UI), willst du einen Home Gateway.

---

## Szenario-Playbook

### "Ich will mein NAS-Web-UI von überall erreichen"

→ **Home Gateway.** Synology/UnRAID/TrueNAS haben typischerweise kein First-Class-WireGuard-Support, und du willst eh keinen VPN-Client auf dem NAS selbst laufen haben.

### "Mein Laptop soll all seinen Traffic im öffentlichen WLAN durch meinen GateControl-Server tunneln"

→ **Klassischer Peer** mit Full-Tunnel (`AllowedIPs = 0.0.0.0/0`). WireGuard einmal auf dem Laptop installieren, Tunnel aktivieren wenn nötig.

### "Ich habe einen schlafenden Gaming-PC zu Hause, den ich aus der Ferne aufwecken und per RDP bedienen will"

→ **Home Gateway** (der einzige mit WoL-Support). Der schlafende PC kann auf nichts antworten; der Gateway sendet das Magic-Packet, wartet, tunnelt dann RDP durch.

### "Ich will einem Kollegen Zugriff auf genau einen Dienst in meinem Büro geben, sonst nichts"

→ **Home Gateway** plus **Route-Auth** auf dieser einen Route (E-Mail-OTP oder TOTP). Der Kollege braucht keinen WireGuard-Client, kein Gerät-Setup auf seiner Seite — nur einen Browser.

### "Ich will einen 24/7-Heim-Server der mein Büro-Netz erreicht"

→ **Klassischer Peer** auf diesem Server. Full-Tunnel oder Split-Tunnel je nach dem was routbar sein soll.

### "Ich habe einen Mix — Heim-Server + Drucker + NAS + iPad vom Kind"

→ **Home Gateway** für die Drucker, NAS, IoT (kein WG dort) **plus** klassische Peers für den Heim-Server und das iPad (Mobile-User). Beide Topologien koexistieren auf demselben GateControl-Server.

### "Ich betreibe ein Homelab mit 20+ Diensten auf verschiedenen LAN-Geräten"

→ **Home Gateway.** Ein Container, 20 Routen im Admin-UI. Einen Dienst hinzufügen ist eine neue Route, kein neuer Peer.

### "Ich manage 10 Kunden-Sites und will eine VPN für alle"

→ **Ein Home Gateway pro Site.** Jeder Site-Gateway hat seinen eigenen Peer in GateControl; du siehst alle Sites als separate Peers im Dashboard. Bessere Isolation (jeder Site-LAN-Traffic bleibt auf diesem Site-Gateway), klareres Monitoring, unabhängige Reboot/Update-Zyklen.

---

## Wann KEIN Home Gateway

- **Das Ziel führt WireGuard bereits perfekt aus.** Ein Linux-Server mit `wg-quick` braucht keinen Gateway — du würdest nur einen Proxy-Hop hinzufügen. Klassischer Peer ist einfacher und schneller.
- **Du hast einen User auf einem Gerät.** Ein Laptop → klassischer Peer. Ein Gateway ist Overkill.
- **Das Ziel ist mobil.** Ein Gateway setzt einen stabilen LAN-Host voraus. Ein Handy oder Laptop der Netzwerke wechselt ist ein klassischer Peer.
- **Jedes Gerät muss seine eigene Identität haben** (Per-User-Audit, unterschiedliche ACLs pro Gerät). Home Gateway gibt eine Identität (den Gateway) und setzt dann auf Route-Auth für Per-User-Trennung; wenn du Device-Level-Attribution brauchst, nimm klassische Peers.

---

## Kann ich beide laufen lassen?

Ja. Die meisten echten Deployments tun es. Gemischte Topologie ist First-Class in GateControl — Peers und Gateway-Peers leben in derselben Liste, demselben Dashboard, demselben Monitoring.

Typische Aufteilung:

- **Gateway** für alles Stationäre im Heim/Büro (NAS, Drucker, IoT, Workstations auf die User per RDP einloggen)
- **Peers** für alles Mobile (Laptops, Handys, Admin-Geräte)

---

## Weiter

- **[01 — User Journey](01-user-journey.de.md)** — End-to-End-Walkthroughs der Top-Five-Szenarien
- **[03 — Features Reference](03-features-reference.de.md)** — vollständige Liste dessen was der Gateway kann
- **[04 — Troubleshooting](04-troubleshooting.de.md)** — Netzwerkmodus-Fallstricke, WoL weckt nicht, etc.
