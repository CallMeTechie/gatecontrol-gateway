# Funk: Zigbee, Bluetooth, Thread (Phase 3c, Schritt 2)

Der Server schaltet pro Gateway über `features.radio` im Config-Pull – in
GateControl unter Gateway › Funk:

```json
{ "zigbee": true | false | null, "stack": "deconz" | "zigbee2mqtt", "ble": true | false,
  "thread": true | false, "bleKeys": "<Stand der Sensor-Schlüssel>" | null }
```

`zigbee: null` (Standard) heißt automatisch: an, sobald ein deCONZ-Funkmodul
erkannt ist (wie bisher im Raspberry-Pi-Image) – „automatisch“ gilt nur für
deCONZ; mit `stack: "zigbee2mqtt"` läuft zigbee2mqtt, außer `zigbee` ist
`false`. Fehlt `features.radio` (älterer Server) oder ein Feld, gilt deCONZ
automatisch, Bluetooth und Thread aus. Capability `radio`, Zustand in
`telemetry.features.radio` (`stack`, `sticks[].use`, `zigbee`, `zigbee2mqtt`,
`ble`, `thread`).

**Ein Stick bedient genau einen Funk.** Zuerst bekommt Zigbee (der gewählte
Dienst) einen Stick, dann Thread einen anderen. zigbee2mqtt nimmt zuerst Sticks,
die deCONZ nicht spricht (reine Zigbee-Sticks vor Multi-Sticks), ConBee/RaspBee
erst zuletzt. Passt nur ein Stick, meldet Thread `stick_busy`. Welcher Stick
welchem Dienst dient, steht in `sticks[].use` (`deconz` | `zigbee2mqtt` |
`thread` | `null`). Welcher Dienst zu einem Stick passt, sagt die Erkennung
(`sticks[].deconz`, `sticks[].z2m` = Adapter `ember`/`zstack`/`deconz`,
`sticks[].thread` = kann mit RCP-Firmware Thread). Ob die Firmware des Sticks
zum Dienst passt (Zigbee-NCP oder OpenThread-RCP), sieht das Gateway nicht am
USB – GateControl zeigt dazu einen Hinweis.

| Teil | Wie | Zustand in `/state` |
|---|---|---|
| Erkennung | alle 30 s aus sysfs (im Container lesbar, keine Compose-Änderung nötig): `/sys/class/tty/tty{ACM,USB}*` → USB-Gerät (idVendor, idProduct, manufacturer, product), `/sys/class/bluetooth/hci*`; RaspBee auf der GPIO-Leiste aus `hardware.json` (Pi-Image, `gatecontrol-hwdetect`) | – |
| Zigbee an/aus | Steuerdatei `/gc-radio/zigbee.env` (`DEVICE=ttyACM0`, `DEV=166:0`, `BAUD=115200`) im tmpfs-Volume `radio-ctl`; der Wächter im Dienst `deconz` startet/beendet deCONZ und meldet sich in `/gc-radio/deconz.state` | `radio.json` (Wunsch für den nächsten Start des Pi), `radio-start` (Pi: Host soll den Container anlegen) |
| deCONZ | REST `http://127.0.0.1:8090`: eigener Schlüssel (`POST /api`, zuerst mit der Werkseinstellung `delight`/`delight`, sonst nur wenn entsperrt), Status alle 60 s (Kanal, Firmware, Geräte je MAC), Anlernen `PUT /config {permitjoin}`, Entsperren `PUT /config {unlock: 60}` | `radio-deconz.json` (0600) |
| zigbee2mqtt | Steuerdatei `/gc-radio/z2m.env` (`DEVICE`, `DEV`, `ADAPTER`, `BAUD`, `MQTT_USER`, `MQTT_PASS`; 0600) – nur wenn der MQTT-Broker des Gateways läuft; Wächter im Dienst `zigbee2mqtt` → `/gc-radio/z2m.state`. Eigenes Konto `gc-zigbee2mqtt` am Broker (nur `zigbee2mqtt/#`), das Gateway liest `zigbee2mqtt/bridge/*` und die Gerätezustände | `radio-z2m.json` (Passwort + Hash, 0600) |
| Thread | Steuerdatei `/gc-radio/thread.env` (`DEVICE`, `DEV`, `BAUD`, `INFRA` = LAN-Schnittstelle); Wächter im Dienst `otbr` → `/gc-radio/otbr.state`; REST des Border Routers `http://127.0.0.1:8081` | – |
| Bluetooth | `gc-blescan` (statisches C-Programm im Image): HCI-Raw-Socket, **passiver** Scan, nur Werbepakete mit 16-bit-Service-Daten; Formate BTHome v2 (auch verschlüsselt), ATC1441, pvvx, MiBeacon (Klartext; v4/v5 verschlüsselt mit Bindkey). Bericht `POST /api/v1/gateway/radio/ble` (≤ 64 Sensoren, je Sensor `keyState`) bei Änderung höchstens alle 30 s, sonst alle 5 Min. | `radio-ble-keys.bin` (Schlüssel, verschlüsselt, 0600) |

Management-API (über den Tunnel, `X-Gateway-Token`):

| Route | Antwort |
|---|---|
| `POST /api/radio/status {}` | 200 `{ radio }` – frisch, mit bis zu 24 Bluetooth-Sensoren |
| `POST /api/radio/zigbee/pair { seconds? }` | 202; 400 (`seconds` 60…254); 409 `not_running` \| `key_needed`; 503 |
| `POST /api/radio/zigbee/unlock {}` | 202 – deCONZ nimmt 60 s lang neue Schlüssel an (Smart-Home-Plugin) |
| `POST /api/radio/zigbee/retry {}` | 202 – Schlüssel neu holen |
| `POST /api/radio/zigbee/remove { ieee }` | zigbee2mqtt: 202; 400; 404 `not_found`; 409 `not_running` – Gerät abmelden (`bridge/request/device/remove`) |
| `POST /api/radio/zigbee/set { ieee, set }` | zigbee2mqtt: 202; 400 (`invalid_request`: Gerät kann das nicht); 404; 409 – `set` `{ on, bri 0…100, ct, xy, hue 0…65535, sat 0…254, cover, pos }` → `zigbee2mqtt/<Name>/set` |
| `POST /api/radio/thread/form { name? }` | 202; 409 `not_running` \| `has_network` – neues Thread-Netz (Rest zufällig) |
| `POST /api/radio/thread/join { dataset }` | 202; 400; 409 – aktiver Datensatz eines anderen Border Routers (TLV-Hex), nie im Log |
| `POST /api/radio/thread/dataset {}` | 200 `{ dataset }` (TLV-Hex, `Cache-Control: no-store`); 409 `not_running` \| `no_network` – für Matter-Controller, nie in der Telemetrie |

Mit `stack: "zigbee2mqtt"` antwortet `pair` über `zigbee2mqtt/bridge/request/permit_join`
(`{ time }`), `unlock` mit 409 (es gibt keinen deCONZ-Schlüssel).

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

## zigbee2mqtt

Für Sticks, die deCONZ nicht spricht: Sonoff ZBDongle-E (EFR32, Adapter
`ember`), ZBDongle-P und andere CC2652 (`zstack`), Home Assistant
SkyConnect/ZBT-1/ZBT-2 und SMLIGHT SLZB-07 (`ember`); ConBee/RaspBee gehen
auch (`deconz`). Dienst `zigbee2mqtt` (`koenkk/zigbee2mqtt`, gepinnt) mit
Wächter wie bei deCONZ: Er legt genau den einen Geräteknoten an, schreibt beim
ersten Start eine kleine `configuration.yaml` (ohne Weboberfläche, ohne Home
Assistant, Netzschlüssel `GENERATE`) ins Volume `z2m-data` und übergibt Gerät,
Adapter und MQTT-Zugang über Umgebungsvariablen (`ZIGBEE2MQTT_CONFIG_*`).

* **MQTT:** zigbee2mqtt spricht nur mit dem Broker des Gateways (127.0.0.1:1883).
  Der läuft, wenn in GateControl Edge und MQTT an sind; sonst meldet das Gateway
  `mqtt_off` (bzw. `mqtt_missing` ohne das Volume `edge-mqtt-conf`) und schreibt
  keine `z2m.env`. Das Konto `gc-zigbee2mqtt` legt das Gateway selbst an (ein
  gleichnamiges Konto vom Server wird übergangen); sein internes Konto liest
  `zigbee2mqtt/#`. `max_packet_size` des Brokers ist 4 MB (die Geräteliste
  `bridge/devices` ist mit vielen Geräten einige 100 KB), Edge-Teile senden weiter
  höchstens 256 KB.
* **Geräte:** aus `zigbee2mqtt/bridge/devices` (≤ 128, ohne Koordinator), Art
  (`light`, `plug`, `cover`, `sensor`, `remote`, `other`) und Fähigkeiten
  (`bri`, `ct`, `color: xy|hs`, `position`, `power`, `battery`) aus
  `definition.exposes`, nur der erste Kanal; Zustände aus `zigbee2mqtt/<Name>`
  mit denselben Wertnamen wie die Bluetooth-Sensoren (`temperature`, `humidity`,
  `opening` = `!contact`, `motion`, `moisture_wet` …) plus `on`, `bri` (0–100),
  `ct`, `pos`. Neu angelernte Geräte aus `bridge/event` (`device_joined`,
  `device_interview`) als `recent`.
* **Bericht** `POST /api/v1/gateway/radio/zigbee { stack, reportedAt, devices }`
  bei Änderung höchstens alle 5 s, sonst alle 5 Min. Das Smart-Home-Plugin
  schaltet über den Server (`/api/radio/zigbee/set`).
* **Nicht dabei:** die Weboberfläche von zigbee2mqtt, OTA-Updates, Gruppen,
  Bindungen, mehrkanalige Geräte über den ersten Kanal hinaus, Thermostate.

## Thread (OpenThread Border Router)

Für einen Stick mit **RCP-Firmware** (OpenThread): SkyConnect/ZBT-1, ZBT-2,
ZBDongle-E, nRF52840. Dienst `otbr` (`openthread/otbr`, nur `latest`
veröffentlicht, darum per Digest gepinnt) mit Wächter: legt den Geräteknoten an
und startet den Border Router mit `--radio-url spinel+hdlc+uart:///dev/<tty>?uart-baudrate=<BAUD>`
und `-B <INFRA>` (die LAN-Schnittstelle des Gateways); REST nur an
`127.0.0.1:8081`, Weboberfläche nur an `127.0.0.1:8089`, mDNS (`_meshcop._udp`)
im LAN. Braucht `NET_ADMIN`/`NET_RAW` und `/dev/net/tun`, kein `privileged`.

* **Zustand** `telemetry.features.radio.thread`: `state` (`off`, `no_stick`,
  `stick_busy`, `no_lan`, `service_missing`, `starting`, `no_network`,
  `detached`, `running`, `error`), `role` (`leader`/`router`/`child`/…),
  `network` `{ name, channel, panId, extPanId }` (nie Netzschlüssel oder PSKc),
  `routers`, `forwarding` (IPv6-Weiterleitung am Host aus
  `/proc/sys/net/ipv6/conf/all/forwarding`).
* **Netz anlegen** (`thread/form`): `disable` → `PUT /node/dataset/active
  { networkName }` (Rest zufällig) → `enable`. **Beitreten** (`thread/join`):
  derselbe Weg mit dem TLV-Datensatz eines anderen Border Routers.
* **Matter über Thread:** Das Gateway stellt den Border Router; was fehlt, ist
  ein Matter-Controller (Apple Home, Google Home, Home Assistant mit
  Matter-Server …), der Geräte aufnimmt. Er braucht den Datensatz
  (`thread/dataset`) – GateControl zeigt ihn auf Wunsch. Ohne IPv6-Weiterleitung
  am Host erreichen Controller im LAN die Thread-Geräte nicht (Hinweis in
  GateControl). Eigene Matter-Aufnahme gibt es in GateControl noch nicht.

## Verschlüsselte Bluetooth-Sensoren

* **BTHome v2** (Geräteinfo-Bit 0): AES-128-CCM, Schlüssel 16 Byte (32 Hex),
  4 Byte MIC; Nonce = MAC ‖ `D2 FC` ‖ Geräteinfo ‖ Zähler (4).
* **MiBeacon v4/v5** (Rahmen-Bit 3): AES-128-CCM mit dem Bindkey, AAD `0x11`;
  Nonce = MAC rückwärts ‖ Produkt-ID ‖ Zähler ‖ erweiterter Zähler. Ältere
  Verschlüsselung (v2/v3) → `keyState: unsupported`.
* Den Schlüssel gibt der Admin je Sensor in GateControl ein. Der Server
  speichert ihn verschlüsselt und nennt im Config-Pull nur den Stand
  (`features.radio.bleKeys`); bei geändertem Stand holt das Gateway
  `GET /api/v1/gateway/radio/ble/keys` → `{ rev, keys: { MAC: hex } }` (≤ 64),
  hält sie im Speicher und verschlüsselt in `/state/radio-ble-keys.bin` (0600,
  AES-256-GCM, Schlüssel per HKDF aus dem Gateway-Token – wie die Kamera-Zugänge).
  Nie im Log. Ohne Bluetooth (`ble: false`) werden die Schlüssel verworfen.
* Je Sensor `keyState`: `ok` (entschlüsselt), `no_key`, `wrong_key` (MIC passt
  nicht), `unsupported`. Geprüft mit den veröffentlichten Testvektoren von
  bthome-ble und xiaomi-ble (`tests/radio_stacks.test.js`).

## Raspberry-Pi-Image

`gateway-state/radio.json` enthält zusätzlich `stack`, `z2m`, `thread`;
`gatecontrol-start` nimmt `zigbee2mqtt` bzw. `otbr` mit, wenn `z2m`/`thread`
`true` sind, und entfernt sie sonst. Fehlt ein Container, während er laufen
soll, schreibt das Gateway `gateway-state/radio-start` mit
`{"services": ["zigbee2mqtt", "otbr"]}` (ohne `services`: deCONZ wie bisher);
`gatecontrol-radio` legt nur diese bekannten Dienste an.

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
  werden erkannt und mit deCONZ als „nicht unterstützt“ gemeldet, nie von deCONZ
  angesteuert – für sie gibt es zigbee2mqtt.
* Ein Stick, ein Dienst (siehe oben). Hinweise statt Sperren: Auf einem Pi 3 /
  Zero 2 W (≤ 1 GB) laufen zigbee2mqtt (≈ 120 MB) und der Border Router
  (≈ 60 MB) neben dem Gateway, GateControl weist auf den knappen Speicher hin.
* Der deCONZ-Schlüssel des Gateways bleibt in `/state` (0600); der Server sieht
  ihn nie. Das Smart-Home-Plugin holt seinen eigenen Schlüssel, nachdem der
  Server über `/api/radio/zigbee/unlock` entsperrt hat.
* Bluetooth-Sensoren sind Funk von irgendwem: nur bekannte Formate, Längen
  geprüft, Namen gekürzt, höchstens 64 Sensoren, nach 30 Min. ohne Paket vergessen.
  Welche Sensoren ins Smart Home dürfen, entscheidet der Admin am Server („Übernehmen“).
