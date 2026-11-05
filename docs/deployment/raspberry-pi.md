# Deployment: Raspberry Pi (fertiges Image)

Für den Raspberry Pi gibt es ein fertiges SD-Karten-Image: **Raspberry Pi OS
Lite (64 bit, Debian 13 „trixie“)** mit Docker, dem GateControl Home Gateway,
Auto-Update und – optional, automatisch erkannt – **deCONZ/Phoscon für das
Zigbee-Modul RaspBee II** (oder einen ConBee-USB-Stick).

Ablauf in Kurzform:

1. Image mit dem Raspberry Pi Imager auf eine microSD-Karte schreiben.
2. `gatecontrol-setup.zip` aus GateControl auf die SD-Karte entpacken (Laufwerk `bootfs`) –
   oder nur die `gateway.env` in den Ordner `bootfs/gatecontrol/` kopieren.
3. Pi starten – nach einigen Minuten ist das Gateway in GateControl „online“.

WLAN, Zeitzone und SSH-Zugang lassen sich ohne Imager-Einstellungen über
[`settings.txt`](#settingstxt-wlan-zeitzone-ssh) festlegen.

Manuelle Installation auf einem vorhandenen Raspberry Pi OS: siehe
[Linux / Docker](linux-docker.md) und die [Tipps am Ende dieser Seite](#tipps-für-eigene-installationen).

---

## Hardware

| | Empfehlung |
|---|---|
| Modell | Raspberry Pi 3 B+, 4, 5, Zero 2 W (64-bit-fähig). Pi 1/2/Zero (32 bit) werden nicht unterstützt. |
| Speicher | gute **A1/A2-microSD-Karte** („Application Performance Class“, 16 GB oder mehr). Alternativ USB-SSD (siehe unten). |
| Netzwerk | LAN-Kabel empfohlen; WLAN geht (`settings.txt` oder Imager). Das Gateway muss im selben L2-Netz wie die Zielgeräte hängen (Wake-on-LAN). |
| Zigbee | RaspBee II auf der GPIO-Leiste oder ConBee II/III am USB – optional. |

### Raspberry Pi 3 B+ (1 GB RAM)

Der 3 B+ reicht für Gateway + deCONZ, hat aber Grenzen:

- **RAM:** Gateway (Node.js) ≈ 60–90 MB, deCONZ ≈ 80–150 MB, Docker + System
  ≈ 150–200 MB, Edge-Container (untätig) ≈ 50 MB – zusammen rund 400–500 MB
  von 1 GB. Jeder laufende Edge-Teil eines Plugins kommt mit ≈ 30–50 MB dazu
  (Obergrenze je Teil: `memoryMb` aus dem Manifest, Standard 48 MB; der ganze
  Edge-Container ist auf 512 MB begrenzt). Wer Edge nicht nutzt, spart die
  ≈ 50 MB mit `EDGE=off` in `settings.txt`. Das Image nutzt **zram**
  (komprimierter RAM-Swap) statt einer Swap-Datei auf der SD-Karte.
- **Ethernet** hängt beim 3 B+ am **USB-2-Bus**: realistisch **200–300 Mbit/s**
  Durchsatz. Für Fernzugriff auf Weboberflächen, RDP und Smart Home reicht das;
  große Dateiübertragungen sind langsamer als mit einem Pi 4/5 oder NAS.
- **USB-Boot:** Der 3 B+ startet ab Werk auch von USB-Massenspeichern. Das Image
  lässt sich genauso auf einen **USB-SSD-Stick** schreiben – dann ohne SD-Karte
  booten. Das schont die SD-Karte und ist deutlich schneller.
- Spätere Zusatzfunktionen des Gateways laufen grundsätzlich auch hier; bei
  schwacher Hardware gibt es einen Hinweis, aber kein Verbot.

---

## 1. Image schreiben

Jedes Gateway-Release enthält unter
[Releases](https://github.com/CallMeTechie/gatecontrol-gateway/releases/latest):

| Datei | Inhalt |
|---|---|
| `gatecontrol-gateway-<version>-rpi-arm64.img.xz` | das Image (komprimiert) |
| `gatecontrol-gateway-<version>-rpi-arm64.img.xz.sha256` | Prüfsumme |
| `gatecontrol-gateway-<version>-rpi-arm64.img.xz.info` | Paketliste |
| `gatecontrol-rpi-imager.json` | Eintrag für den Raspberry Pi Imager (Variante A) |

> Das Image wird nach dem Docker-Release gebaut (rund eine Stunde). Fehlt es beim
> allerneuesten Release noch, das vorherige nehmen – das Gateway aktualisiert sich
> danach ohnehin selbst.

### Variante A (empfohlen): Imager mit GateControl-Liste – mit Benutzer, WLAN und SSH

Nur so lassen sich im Raspberry Pi Imager **Benutzer, Passwort, WLAN, SSH,
Zeitzone und Hostname** einstellen. Für eine einfach ausgewählte Image-Datei
(Variante B) bietet der Imager diese Einstellungen nicht an.

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) 2.x starten.
2. **App-Optionen** (Zahnrad) → **Content Repository** → **Use custom URL**:
   ```
   https://github.com/CallMeTechie/gatecontrol-gateway/releases/latest/download/gatecontrol-rpi-imager.json
   ```
   → **Apply & Restart**.
3. Gerät wählen (z. B. Raspberry Pi 3), Betriebssystem **GateControl Gateway <version>**,
   Speicherkarte wählen.
4. In den Einstellungen mindestens einen **Benutzer mit Passwort** anlegen. Für
   Fernwartung **SSH aktivieren** (am besten mit öffentlichem Schlüssel), bei Bedarf
   WLAN eintragen.
5. Schreiben. Danach im Imager wieder das Standard-Repository einstellen, wenn du
   normale Raspberry-Pi-Images brauchst.

### Variante B: „Eigenes Image“

Imager → Betriebssystem → **Eigenes Image** → die `.img.xz` auswählen (oder ein
anderes Schreibprogramm). Dann gibt es **keine** Imager-Einstellungen:

- Das Gateway läuft trotzdem – per LAN-Kabel, oder per WLAN über `WIFI_SSID`/`WIFI_PSK`
  in [`settings.txt`](#settingstxt-wlan-zeitzone-ssh).
- **SSH ist aus**, es gibt **kein Standard-Passwort**. SSH-Zugang mit Schlüssel:
  `SSH_AUTHORIZED_KEY` in `settings.txt` (Benutzer `gcadmin`). Ein Benutzer mit Passwort
  wird sonst beim ersten Start am angeschlossenen Bildschirm mit Tastatur angelegt.
- Ohne Bildschirm: vor dem ersten Start auf der Boot-Partition die Datei
  `user-data` (cloud-init) anpassen – Beispiele stehen in der Datei.

---

## 2. Einrichtungsdateien auf die SD-Karte

1. Die SD-Karte nach dem Schreiben am PC (neu) einstecken. Es erscheint das Laufwerk
   **`bootfs`** mit dem Ordner **`gatecontrol`**.
2. **Mit dem Einrichtungsassistenten** in GateControl: `gatecontrol-setup.zip` herunterladen
   und den Inhalt **direkt auf `bootfs`** entpacken (vorhandene Dateien ersetzen). Die ZIP
   enthält `gatecontrol/gateway.env` und `gatecontrol/settings.txt` (WLAN, Zeitzone, SSH …).
   WLAN-Passwort und SSH-Schlüssel erzeugt der Browser in die ZIP – sie gehen nicht an
   den Server.
3. **Von Hand:** das Gateway anlegen (Peers → „Neuer Peer“ → „Home Gateway“), im
   Einrichtungsdialog die Konfiguration herunterladen (`gateway-<id>.env`) und in den Ordner
   **`bootfs/gatecontrol/`** kopieren. Der Name darf `gateway-<id>.env` bleiben oder
   `gateway.env` heißen. (Direkt nach `bootfs/` geht auch.) Optional
   `bootfs/gatecontrol/settings.txt` anpassen (siehe nächster Abschnitt).
4. Karte auswerfen, in den Pi stecken, LAN-Kabel (oder WLAN eingetragen), Strom.

`gateway.env`, WLAN-Passwort und SSH-Schlüssel werden beim Start übernommen und sofort
von der SD-Karte gelöscht; bis dahin die Karte nicht herumliegen lassen.

---

## settings.txt (WLAN, Zeitzone, SSH)

`bootfs/gatecontrol/settings.txt` – eine Zeile je Einstellung, `NAME=WERT` **ohne
Anführungszeichen**, `#` = Kommentar. UTF-8; Windows-Zeilenenden (CRLF) und BOM sind in
Ordnung. Gelesen bei jedem Start.

| Schlüssel | Werte | Wirkung |
|---|---|---|
| `HOSTNAME` | Buchstaben, Ziffern, `-` (max. 63) | Gerätename im Netz (siehe [Erster Start](#3-erster-start)) |
| `ZIGBEE` | `auto` \| `on` \| `off` | deCONZ-Erkennung (siehe [RaspBee II](#5-raspbee-ii-zigbee)) |
| `EDGE` | `on` \| `off`, Standard `on` | Edge-Container für Plugin-Teile im Heimnetz ([docs/edge.md](../edge.md)); untätig, bis GateControl Edge einschaltet |
| `TIMEZONE` | IANA-Name, z. B. `Europe/Berlin` | Zeitzone des Pi (und von deCONZ). Ohne Eintrag: `Europe/Berlin` bzw. Imager |
| `WIFI_SSID` | WLAN-Name, beliebige Zeichen (UTF-8, max. 32 Byte) | WLAN einrichten |
| `WIFI_PSK` | 8–63 Zeichen (ASCII) oder 64 Hex-Zeichen; leer = offenes Netz | WLAN-Passwort (WPA2-PSK; WPA2/WPA3-Mischbetrieb geht) |
| `WIFI_COUNTRY` | ISO-3166-Ländercode, Standard `DE` | Funk-Regulierung (Kanäle, Sendeleistung) |
| `WIFI_HIDDEN` | `0` \| `1` | `1` = verstecktes Netz (SSID wird nicht ausgestrahlt) |
| `SSH_AUTHORIZED_KEY` | eine Zeile aus `~/.ssh/id_ed25519.pub` (ed25519, ecdsa, RSA ≥ 3072 Bit) | SSH nur mit diesem Schlüssel, Benutzer `gcadmin` |

Ungültige Werte (z. B. zu kurzes Passwort, unbekannte Zeitzone, falscher Schlüsseltyp)
werden in **`bootfs/gatecontrol/STATUS.txt`** und im Journal benannt (Status
„EINSTELLUNGEN MIT FEHLERN“); alles andere wird trotzdem übernommen, das Gateway startet.
Werte werden nie als Shell-Code ausgewertet.

**Geheimnisse:** `WIFI_PSK` und `SSH_AUTHORIZED_KEY` werden nach dem Übernehmen aus
`settings.txt` auf der SD-Karte entfernt (die Zeile wird durch einen Hinweis-Kommentar
ersetzt, alles andere bleibt, damit `HOSTNAME`, `ZIGBEE` usw. weiter gelten). Auf dem Pi
liegt das WLAN-Passwort nur in der NetworkManager-Verbindung (`0600`, root).

### WLAN

- `gatecontrol-settings` legt die NetworkManager-Verbindung **`gatecontrol-wifi`** an
  (`/etc/NetworkManager/system-connections/gatecontrol-wifi.nmconnection`, `0600` root) und
  setzt das Funkland (`raspi-config nonint do_wifi_country`, entsperrt WLAN per rfkill).
- Das passiert **früh im Boot, vor NetworkManager** (`gatecontrol-settings.service`, vor
  `network-pre.target`). NetworkManager verbindet sich deshalb schon beim allerersten Start
  mit dem WLAN, und `gatecontrol-gateway` (wartet auf `network-online.target`, höchstens
  ca. 60 s) startet über WLAN – auch ohne Kabel.
- **LAN hat Vorrang:** Die WLAN-Verbindung hat Routen-Metrik 600, Ethernet 100. Steckt ein
  Kabel, läuft der Verkehr darüber; WLAN bleibt als Ersatz verbunden.
- **Neu einrichten:** eine neue `settings.txt` mit `WIFI_SSID` + `WIFI_PSK` ersetzt die
  Verbindung beim nächsten Start. Ohne `WIFI_PSK` (bei späteren Starts, nachdem es entfernt
  wurde) bleibt eine vorhandene Verbindung für dieselbe SSID unverändert; eine *neue* SSID
  ohne `WIFI_PSK`-Zeile gilt als offenes Netz.
- **WLAN entfernen:** `WIFI_SSID` aus `settings.txt` löschen und
  `sudo nmcli connection delete gatecontrol-wifi` (sonst bleibt die Verbindung bestehen).
- Reine WPA3-Netze (nur SAE, ohne WPA2-Mischbetrieb) und WPA-Enterprise werden über
  `settings.txt` nicht unterstützt – dafür den Imager (Variante A) oder `nmcli` nehmen.
- Im Imager eingetragenes WLAN funktioniert weiterhin; beide Verbindungen können
  nebeneinander bestehen.

### SSH

Mit `SSH_AUTHORIZED_KEY` (und nur dann) richtet `gatecontrol-settings` ein:

- Benutzer **`gcadmin`** (Gruppe `sudo`, `sudo` ohne Passwort über
  `/etc/sudoers.d/010_gatecontrol-gcadmin`), **ohne Passwort** (Passwort-Feld `*`, eine
  Passwort-Anmeldung ist unmöglich).
- `~gcadmin/.ssh/authorized_keys` = genau dieser Schlüssel (eine neue `settings.txt`
  ersetzt ihn).
- `sshd` nur mit Schlüssel: `/etc/ssh/sshd_config.d/01-gatecontrol.conf` mit
  `PubkeyAuthentication yes`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin no`, `AuthenticationMethods publickey`. Die Datei wird vor
  `50-cloud-init.conf` gelesen und gilt damit auch gegenüber Imager-Einstellungen – ein im
  Imager gesetztes **Passwort-Login per SSH ist danach aus**.
- `ssh.service` wird aktiviert und gestartet (Hostschlüssel werden bei Bedarf erzeugt).

Geprüft wird der Schlüssel streng: genau eine Zeile, Typ `ssh-ed25519`,
`ecdsa-sha2-nistp256/384/521` oder `ssh-rsa` mit mindestens 3072 Bit, keine Optionen
davor (`command=`, `from=` …), Typ und Schlüsseldaten müssen zusammenpassen
(`ssh-keygen -l`). In `STATUS.txt` steht danach nur der Fingerprint.

Anmelden: `ssh gcadmin@<hostname>.local` (bzw. die IP). Ohne `SSH_AUTHORIZED_KEY` bleibt
SSH aus wie bisher (oder wie im Imager eingestellt).

Von Hand wiederholen (z. B. nach dem Kopieren einer neuen `settings.txt` per SSH):
`sudo gatecontrol-settings`.

---

## 3. Erster Start

Beim Start laufen drei Dienste:

| Dienst | Aufgabe |
|---|---|
| `gatecontrol-settings` | früh, vor NetworkManager: `settings.txt` – Zeitzone, WLAN, SSH; Passwort/Schlüssel von der Karte entfernen |
| `gatecontrol-hwdetect` | vor Docker: Funkmodule erkennen (RaspBee II/ConBee), Hardware-Profil schreiben |
| `gatecontrol-gateway` | `gateway.env` übernehmen, Hostname setzen, Docker-Images laden, Stack starten |

Ablauf (bei jedem weiteren Start genauso, nur ohne Download):

1. Raspberry Pi OS richtet sich ein (Partition vergrößern, Imager-Einstellungen;
   1–2 automatische Neustarts sind normal).
2. Die `gateway.env` wird geprüft, nach `/opt/gatecontrol-gateway/config/gateway.env`
   übernommen (Rechte `0600`, root) und **von der FAT-Partition gelöscht** – ältere
   Kopien ebenso.
3. Hostname: `HOSTNAME` aus `settings.txt` → `GC_HOSTNAME` aus der env → ein im
   Imager gesetzter Name bleibt → sonst `gc-<Name des Gateways>` (z. B. `gc-keller-pi`).
4. `ghcr.io/callmetechie/gatecontrol-gateway:latest` wird geladen und gestartet (auf
   einem 3 B+ dauert der erste Download einige Minuten). Ohne Netz versucht der
   Dienst es alle 30 s erneut.
5. Mit erkanntem RaspBee II/ConBee startet zusätzlich deCONZ (siehe unten).

Nach ca. 2–5 Minuten erscheint das Gateway in GateControl als „online“.

**Ohne `gateway.env`** startet nichts. Der Hinweis steht dann im Journal, auf der
Konsole/am Login-Prompt, beim SSH-Login und in **`bootfs/gatecontrol/STATUS.txt`**
(am PC lesbar). Ist die Datei ungültig (z. B. falsche Datei erwischt), wird sie nicht
verwendet, als `config/gateway.env.rejected` abgelegt, und der Status lautet „FEHLER“.

**Neu einrichten / anderes Gateway:** wieder eine `gateway.env` nach
`bootfs/gatecontrol/` kopieren und den Pi starten – die neue Datei ersetzt die alte,
der Gateway-Container wird neu erstellt. Per SSH geht es auch ohne Neustart:

```bash
sudo cp gateway-42.env /boot/firmware/gatecontrol/
sudo gatecontrol-start
```

---

## 4. Updates

| Was | Wie |
|---|---|
| **Gateway** | wie auf dem NAS: in GateControl beim Gateway **Update** klicken. Der Container schreibt das Flag `gateway-state/pending-update`; `gatecontrol-gateway-update.path` (sofort) bzw. `gatecontrol-gateway-update.timer` (alle 5 min als Sicherheitsnetz) starten `/opt/gatecontrol-gateway/update.sh` – Pull, Health-Check, bei Fehler Rollback auf das vorige Image. Details: [Auto-Update](../auto-update.md). Die Einrichtung aus der GateControl-Karte „Auto-Update einrichten“ ist im Image schon erledigt. |
| **Sicherheitsupdates OS** | `unattended-upgrades` spielt täglich die Debian-Sicherheitsupdates und neue Docker-Engine-Versionen ein. Docker läuft mit `live-restore`, die Container laufen dabei weiter. Kein automatischer Neustart. |
| **Kernel/Firmware** (Raspberry-Pi-Archiv) | nicht automatisch: gelegentlich `sudo apt update && sudo apt full-upgrade && sudo reboot`. Automatisch: in `/etc/apt/apt.conf.d/52gatecontrol-unattended-upgrades` die Zeile `"origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";` ergänzen. |
| **deCONZ** | Version steht fest im Image (Tag + Digest in `docker-compose.yml`). Neuere Versionen kommen mit neueren Images; von Hand: die `image:`-Zeile des Dienstes `deconz` ändern, dann `sudo gatecontrol-start`. |
| **neues Image** | nicht nötig – ein laufender Pi bleibt über die Wege oben aktuell. |

---

## 5. RaspBee II (Zigbee)

Das Image ist für den RaspBee II vorbereitet:

- `config.txt`: `enable_uart=1`, `dtoverlay=disable-bt` (Pi 3/4/Zero 2 W: Bluetooth
  wird vom PL011-UART gelöst, damit `/dev/ttyAMA0` an GPIO 14/15 frei ist), auf dem
  Pi 5 zusätzlich `dtparam=uart0=on`.
- Keine serielle Login-Konsole (aus `cmdline.txt` entfernt, `serial-getty@ttyAMA0` maskiert).

**Erkennung:** Bei jedem Start spricht `gatecontrol-hwdetect` – bevor Docker startet –
das deCONZ-Protokoll (Anfrage `VERSION`) auf `/dev/ttyAMA0` und auf ConBee-Sticks
unter `/dev/serial/by-id`. Antwortet ein Modul, startet das Compose-Profil `zigbee`
mit dem Container `deconzcommunity/deconz` (Version gepinnt). Ohne Modul läuft kein
deCONZ. Wird das Modul später abgezogen, wird der deCONZ-Container beim nächsten Start
entfernt (die Daten bleiben erhalten).

| Einstellung in `bootfs/gatecontrol/settings.txt` | Wirkung |
|---|---|
| `ZIGBEE=auto` (Standard) | deCONZ nur, wenn ein Modul antwortet |
| `ZIGBEE=on` | deCONZ immer starten (falls die Erkennung versagt, z. B. Firmware-Problem) |
| `ZIGBEE=off` | deCONZ nie starten |
| `ZIGBEE_DEVICE=/dev/ttyAMA0` | Gerät erzwingen |

**Ports** (deCONZ läuft wie das Gateway im Host-Netz):

| Port | Dienst |
|---|---|
| **8090** | deCONZ REST-API + Phoscon-Weboberfläche: `http://<ip-des-pi>:8090` bzw. `http://gc-<name>.local:8090` |
| **8091** | deCONZ WebSocket (Ereignisse) |
| 8080 / 9876 | Gateway (Companion-Proxy / Management-API, nur auf der Tunnel-IP) |

8090/8091 nicht als Listen-Port für L4-Routen *dieses* Gateways verwenden (der
Listener würde mit `EADDRINUSE` übersprungen).

**Wichtig nach dem ersten Start:** Phoscon unter `http://<ip-des-pi>:8090` öffnen und
sofort das **Phoscon-Passwort** setzen – bis dahin kann jeder im LAN das Zigbee-Gateway
übernehmen.

Daten (Zigbee-Netz, Geräte, Backups) liegen in `/opt/gatecontrol-gateway/deconz/`.
Umzug von einem anderen deCONZ: dort in Phoscon ein Backup erstellen und hier einspielen.

**Bluetooth** ist durch `disable-bt` aus. Wer Bluetooth braucht (und keinen RaspBee
nutzt), ersetzt in `config.txt` `dtoverlay=disable-bt` durch `dtoverlay=miniuart-bt`
(Pi 3 zusätzlich `core_freq=250`).

---

## 6. deCONZ im Smart-Home-Plugin einbinden

Das Smart-Home-Plugin spricht deCONZ per HTTP über eine GateControl-Route an. Da deCONZ
auf demselben Pi läuft wie das Gateway, zeigt die Route auf das Gateway selbst:

1. **Route anlegen** (Routen → Neu): HTTP-Route, am besten nur intern erreichbar,
   Ziel-Typ **Home Gateway (LAN)**, Gateway = dieser Pi, **LAN-Host `127.0.0.1`**,
   **LAN-Port `8090`**.
   `127.0.0.1` ist hier richtig: Übernimmt in einem Gateway-Pool ein anderes Gateway die
   Route, schreibt GateControl das Ziel automatisch auf die LAN-IP dieses Pi um
   (GateControl-Doku „Gateway Loopback Failover“, `docs/gateway-loopback-failover.md`).
2. **Zugriffsziel zuweisen:** Einstellungen → Plugins → Smart Home → Einstellungen →
   **Zugriffsziele** → „Phoscon/deCONZ-Gateway“ = die Route aus Schritt 1.
3. **Gateway verbinden:** in Phoscon (`http://<ip-des-pi>:8090`) → Einstellungen →
   Gateway → Erweitert → **App authentifizieren**, dann innerhalb von 60 s im Plugin
   **„Phoscon-Gateway verbinden“** (API-Key leer lassen – GateControl holt ihn).

---

## 7. Fehlersuche

| Problem | Prüfen |
|---|---|
| Gateway erscheint nicht | `bootfs/gatecontrol/STATUS.txt` am PC lesen, oder per SSH `journalctl -u gatecontrol-gateway -b` |
| „EINSTELLUNGEN MIT FEHLERN“ | in `STATUS.txt` steht, welcher Wert in `settings.txt` ungültig war; korrigieren (Passwort/Schlüssel neu eintragen) und neu starten. `journalctl -u gatecontrol-settings -b` |
| WLAN verbindet nicht | SSID/Passwort richtig? Land (`WIFI_COUNTRY`) passend? 5-GHz-Netz mit DFS-Kanal → 2,4 GHz testen. `nmcli device status`, `nmcli connection show gatecontrol-wifi`, `journalctl -u NetworkManager -b` |
| SSH-Login abgelehnt | Benutzer ist `gcadmin`, nur mit dem Schlüssel aus `settings.txt`; `STATUS.txt` zeigt dessen Fingerprint (`ssh-keygen -lf ~/.ssh/id_ed25519.pub` zum Vergleich) |
| „WARTET AUF EINRICHTUNG“ | keine `gateway.env` gefunden – Datei nach `bootfs/gatecontrol/` kopieren, Pi neu starten |
| „FEHLER: … ungültig“ | falsche Datei (z. B. `docker-compose.yml`) oder beschädigt – in GateControl neu herunterladen |
| Container-Status | `sudo docker compose --project-directory /opt/gatecontrol-gateway ps` bzw. `… logs -f gateway` |
| Image-Download hängt | Netz/DNS prüfen (`ping -c3 ghcr.io`); der Dienst wiederholt alle 30 s |
| Uhrzeit falsch (TLS-Fehler) | `timedatectl` – der Pi hat keine Echtzeituhr, NTP muss erreichbar sein |
| RaspBee wird nicht erkannt | `journalctl -u gatecontrol-hwdetect -b`; Modul richtig auf Pin 1–12 gesteckt? Testweise `ZIGBEE=on` setzen und in Phoscon nachsehen (ggf. Firmware-Update) |
| deCONZ läuft, Phoscon leer | `sudo docker compose --project-directory /opt/gatecontrol-gateway logs deconz` |
| Update-Knopf ohne Wirkung | `systemctl status gatecontrol-gateway-update.path`, `cat /opt/gatecontrol-gateway/gateway-state/update.log` |
| Speicher knapp | `free -h`, `zramctl`, `docker stats --no-stream` |

Erkanntes Hardware-Profil (wird auch an GateControl gemeldet):
`cat /opt/gatecontrol-gateway/gateway-state/hardware.json`

Das Journal liegt im RAM (`Storage=volatile`, max. 32 MB) und ist nach einem Neustart
weg – das schont die SD-Karte. Für dauerhafte Logs in
`/etc/systemd/journald.conf.d/40-gatecontrol.conf` `Storage=persistent` setzen.

---

## Aufbau des Images

| Pfad | Inhalt |
|---|---|
| `/opt/gatecontrol-gateway/docker-compose.yml` | Gateway (gleiche Sicherheits-Optionen wie `docker-compose.example.yml`) + Profil `zigbee` (deCONZ) |
| `/opt/gatecontrol-gateway/config/` | `gateway.env` (0600) |
| `/opt/gatecontrol-gateway/gateway-state/` | Auto-Update-Flag, `last-pull`, `update.log`, `hardware.json` |
| `/opt/gatecontrol-gateway/deconz/` | deCONZ-Daten |
| `/opt/gatecontrol-gateway/update.sh` | = `deploy/update.sh` |
| `/usr/local/sbin/gatecontrol-start`, `gatecontrol-hwdetect`, `gatecontrol-settings` | Start/Einrichtung, Funkmodul-Erkennung, `settings.txt` (WLAN, Zeitzone, SSH) |
| `/var/lib/gatecontrol/` | Stand von `gatecontrol-settings` (WLAN-SSID als Hash, SSH-Fingerprint – keine Geheimnisse) |
| `/boot/firmware/gatecontrol/` | `LIESMICH.txt`, `settings.txt`, `STATUS.txt`; hierher kommt die `gateway.env` |

System: Docker Engine + Compose-Plugin aus dem offiziellen Docker-Repository
(Signaturschlüssel per Fingerprint gepinnt), Log-Rotation für alle Container
(`json-file`, 3 × 10 MB), zram-Swap, Journal im RAM, `unattended-upgrades`, cloud-init
für die Imager-Einstellungen. Kein Standard-Passwort; SSH nur über den Imager oder
`SSH_AUTHORIZED_KEY` (dann nur mit Schlüssel).

Gebaut wird mit dem offiziellen [pi-gen](https://github.com/RPi-Distro/pi-gen)
(Commit gepinnt in `rpi/versions.env`) auf einem nativen arm64-Runner – siehe `rpi/`
und `.github/workflows/rpi-image.yml`. Selbst bauen auf einem arm64-Debian:
`sudo rpi/build-image.sh 0.0.0-test`.

---

## Tipps für eigene Installationen

Für ein selbst installiertes Raspberry Pi OS mit Docker (das Image erledigt das schon):

- **Log-Rotation:** `logging: json-file, max-size 10m, max-file 3` (steht in
  `docker-compose.example.yml`).
- **NTP:** Ein Pi ohne RTC muss bei jedem Boot synchronisieren – `timedatectl status`
  sollte „System clock synchronized: yes“ zeigen.
- **Docker-Daten auf SSD** statt SD-Karte:

  ```bash
  sudo systemctl stop docker
  sudo mv /var/lib/docker /mnt/ssd/docker
  sudo ln -s /mnt/ssd/docker /var/lib/docker
  sudo systemctl start docker
  ```
