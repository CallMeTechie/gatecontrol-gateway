# Funk: Zigbee, Bluetooth, Thread (Phase 3c, Schritt 2)

Der Server schaltet pro Gateway über `features.radio` im Config-Pull
(`{ zigbee: true | false | null, ble: true | false }`) – in GateControl unter
Gateway › Funk. `zigbee: null` (Standard) heißt automatisch: an, sobald ein
deCONZ-Funkmodul erkannt ist (wie bisher im Raspberry-Pi-Image). Fehlt
`features.radio` (älterer Server), ist Zigbee automatisch und Bluetooth aus.
Capability `radio`, Zustand in `telemetry.features.radio`.

| Teil | Wie | Zustand in `/state` |
|---|---|---|
| Erkennung | alle 30 s aus sysfs (im Container lesbar, keine Compose-Änderung nötig): `/sys/class/tty/tty{ACM,USB}*` → USB-Gerät (idVendor, idProduct, manufacturer, product), `/sys/class/bluetooth/hci*`; RaspBee auf der GPIO-Leiste aus `hardware.json` (Pi-Image, `gatecontrol-hwdetect`) | – |
| Zigbee an/aus | Steuerdatei `/gc-radio/zigbee.env` (`DEVICE=ttyACM0`, `DEV=166:0`, `BAUD=115200`) im tmpfs-Volume `radio-ctl`; der Wächter im Dienst `deconz` startet/beendet deCONZ und meldet sich in `/gc-radio/deconz.state` | `radio.json` (Wunsch für den nächsten Start des Pi), `radio-start` (Pi: Host soll den Container anlegen) |
| deCONZ | REST `http://127.0.0.1:8090`: eigener Schlüssel (`POST /api`, zuerst mit der Werkseinstellung `delight`/`delight`, sonst nur wenn entsperrt), Status alle 60 s (Kanal, Firmware, Geräte je MAC), Anlernen `PUT /config {permitjoin}`, Entsperren `PUT /config {unlock: 60}` | `radio-deconz.json` (0600) |
| Bluetooth | `gc-blescan` (statisches C-Programm im Image): HCI-Raw-Socket, **passiver** Scan, nur Werbepakete mit 16-bit-Service-Daten; Formate BTHome v2 (unverschlüsselt), ATC1441, pvvx; MiBeacon und verschlüsseltes BTHome nur erkannt. Bericht `POST /api/v1/gateway/radio/ble` (≤ 64 Sensoren) bei Änderung höchstens alle 30 s, sonst alle 5 Min. | – |
| Thread | nur Erkennung (ZBT-1/SkyConnect, ZBT-2, Sonoff ZBDongle-E, nRF52840 mit OpenThread); ein OpenThread-Border-Router folgt später | – |

Management-API (über den Tunnel, `X-Gateway-Token`):

| Route | Antwort |
|---|---|
| `POST /api/radio/status {}` | 200 `{ radio }` – frisch, mit bis zu 24 Bluetooth-Sensoren |
| `POST /api/radio/zigbee/pair { seconds? }` | 202; 400 (`seconds` 60…254); 409 `not_running` \| `key_needed`; 503 |
| `POST /api/radio/zigbee/unlock {}` | 202 – deCONZ nimmt 60 s lang neue Schlüssel an (Smart-Home-Plugin) |
| `POST /api/radio/zigbee/retry {}` | 202 – Schlüssel neu holen |

## Der deCONZ-Dienst

Ein Container kann keine anderen Container starten (kein Docker-Socket). Darum
läuft im Dienst `deconz` (`deconzcommunity/deconz`, gepinnt) statt deCONZ zuerst
ein kleiner Wächter – wie beim MQTT-Broker:

* Liegt `zigbee.env` vor, prüft er die Werte streng (`tty{ACM,USB,AMA}N`, Major
  166/188/204), legt mit `mknod` **genau diesen einen** Geräteknoten im eigenen
  `/dev` an und startet `/start.sh` des Images (exec deCONZ). Geänderte Datei →
  deCONZ neu, Datei weg → deCONZ aus, abgestürzt → nach 10 s neu.
* `device_cgroup_rules` erlaubt nur ttyACM (ConBee II), ttyUSB (ConBee III /
  ConBee) und ttyAMA (RaspBee). Kein `devices:` (das scheitert ohne Stick) und
  kein `/dev`-Bind – ein später eingesteckter Stick geht ohne neuen Container.
* Ohne `zigbee.env` läuft nur der Wächter (≈ 1 MB). Healthcheck prüft deCONZ nur,
  während es laufen soll.

| Plattform | Ohne SSH |
|---|---|
| Raspberry-Pi-Image (ab dieser Version) | `gatecontrol-start` nimmt `deconz` mit, wenn beim Start ein Modul antwortet oder `radio.json` Zigbee will. Wird Zigbee eingeschaltet, während der Container fehlt, legt das Gateway `radio-start` an → `gatecontrol-radio.path` → `docker compose up -d deconz`. `settings.txt` `ZIGBEE=` zählt nur noch bei „automatisch“. |
| ältere Pi-Images | deCONZ startet wie bisher vom Image (Profil `zigbee`); Anlernen, Status und Erkennung gehen, der Schalter nicht (Telemetrie `service: image`). |
| Synology, Linux | Den Dienst bringt die Compose-Datei aus GateControl mit, sobald das Gateway einen deCONZ-Stick meldet (einmal herunterladen, Projekt neu erstellen). In `docker-compose.example.yml` steht er im Profil `zigbee` (`docker compose --profile zigbee up -d`), damit ohne Stick niemand das ≈ 350-MB-Image lädt. USB-Sticks auf der Synology: kein Treiber nötig für ConBee II (cdc_acm); Bluetooth fehlt der NAS meist. |

## Bluetooth auf dem Raspberry Pi

Das Image legt Bluetooth auf den Mini-UART (`dtoverlay=miniuart-bt,krnbt=on`,
fester Kerntakt `core_freq = core_freq_min` je Modell), damit der RaspBee den
PL011-UART (`/dev/ttyAMA0`) behält **und** Bluetooth läuft. Ältere Images haben
`disable-bt` – dort hilft ein USB-Bluetooth-Stick (geht sofort) oder ein neues
Image. Der Scan braucht `NET_RAW`/`NET_ADMIN` und das Host-Netz – beides hat der
Gateway-Dienst schon; er verbindet sich mit keinem Gerät und sendet keine
Scan-Anfragen. Läuft am Host `bluetoothd` mit eigenem Scan, hört `gc-blescan` mit
(`mode: shared`).

## Regeln

* Nur Funkmodule von dresden elektronik spricht deCONZ. Andere Zigbee-Sticks
  werden erkannt und als „nicht unterstützt“ gemeldet, nie angesteuert.
* Der deCONZ-Schlüssel des Gateways bleibt in `/state` (0600); der Server sieht
  ihn nie. Das Smart-Home-Plugin holt seinen eigenen Schlüssel, nachdem der
  Server über `/api/radio/zigbee/unlock` entsperrt hat.
* Bluetooth-Sensoren sind Funk von irgendwem: nur bekannte Formate, Längen
  geprüft, Namen gekürzt, höchstens 64 Sensoren, nach 30 Min. ohne Paket vergessen.
  Welche Sensoren ins Smart Home dürfen, entscheidet der Admin am Server („Übernehmen“).
