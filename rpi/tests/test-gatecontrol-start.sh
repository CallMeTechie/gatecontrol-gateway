#!/bin/bash
# Tests für rpi/rootfs/usr/local/sbin/gatecontrol-start (Erststart-Logik).
# docker, hostnamectl, hostname, systemctl und agetty werden durch Stubs
# ersetzt; alle Pfade liegen in einem Temp-Verzeichnis. Braucht root
# (install -o root / chown), in CI daher mit sudo aufrufen.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOTFS="$HERE/../rootfs"
START="$ROOTFS/usr/local/sbin/gatecontrol-start"

pass=0
failed=0
ok()   { echo "  ok    $*"; pass=$((pass + 1)); }
bad()  { echo "  FEHLER $*"; failed=$((failed + 1)); }
expect() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
not() { ! "$@"; }

TOKEN_API="gc_gw_$(printf 'a%.0s' {1..64})"
TOKEN_GW="$(printf 'b%.0s' {1..64})"
# Schlüssel zur Laufzeit erzeugen (keine schlüsselähnlichen Literale im Repo)
WG_DUMMY_PRIV="$(head -c 32 /dev/urandom | base64)"
WG_DUMMY_PUB="$(head -c 32 /dev/urandom | base64)"
valid_env() {
  cat <<EOF
# GateControl Home Gateway — Pairing Config
# Generated: 2026-11-04T10:00:00.000Z
# Peer: Keller Pi 3 (ID: 42)

GC_SERVER_URL=https://gc.example.com
GC_API_TOKEN=$TOKEN_API
GC_GATEWAY_TOKEN=$TOKEN_GW
GC_TUNNEL_IP=10.8.0.42
GC_PROXY_PORT=8080
GC_API_PORT=9876
WG_PRIVATE_KEY=$WG_DUMMY_PRIV
WG_PUBLIC_KEY=$WG_DUMMY_PUB
WG_ENDPOINT=gc.example.com:51820
WG_SERVER_PUBLIC_KEY=$WG_DUMMY_PUB
WG_ADDRESS=10.8.0.42/32
EOF
}

setup() {
  T="$(mktemp -d)"
  mkdir -p "$T/bin" "$T/opt" "$T/boot/gatecontrol" "$T/run" "$T/etc/cloud/cloud.cfg.d" "$T/issue"
  cp "$ROOTFS/opt/gatecontrol-gateway/docker-compose.yml" "$T/opt/docker-compose.yml"
  cp "$ROOTFS/boot/firmware/gatecontrol/settings.txt" "$T/boot/gatecontrol/settings.txt"
  printf '127.0.0.1\tlocalhost\n127.0.1.1\traspberrypi\n' >"$T/etc/hosts"
  echo raspberrypi >"$T/hostname"
  cat >"$T/bin/docker" <<EOF
#!/bin/bash
echo "docker \$*" >>"$T/docker.log"
EOF
  cat >"$T/bin/hostname" <<EOF
#!/bin/bash
if [ \$# -gt 0 ]; then echo "\$1" >"$T/hostname"; fi
cat "$T/hostname"
EOF
  cat >"$T/bin/hostnamectl" <<EOF
#!/bin/bash
[ "\$1" = set-hostname ] && echo "\$2" >"$T/hostname"
EOF
  printf '#!/bin/sh\nexit 0\n' >"$T/bin/systemctl"
  printf '#!/bin/sh\nexit 0\n' >"$T/bin/agetty"
  printf '#!/bin/sh\necho Europe/Berlin\n' >"$T/bin/timedatectl"
  chmod +x "$T/bin/"*
  : >"$T/docker.log"
}

run_start() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_DIR="$T/opt" GC_BOOT="$T/boot" \
    GC_RUN="$T/run" GC_ETC="$T/etc" GC_ISSUE_DIR="$T/issue" bash "$START" >"$T/out.log" 2>&1
}

echo "== ohne gateway.env"
setup
expect "Exit 0" run_start
expect "Status WARTET" grep -q '^WARTET AUF EINRICHTUNG' "$T/run/status"
expect "kein docker-Aufruf" test ! -s "$T/docker.log"
expect "STATUS.txt auf der Boot-Partition" grep -q 'WARTET' "$T/boot/gatecontrol/STATUS.txt"
expect "Login-Hinweis (issue.d)" grep -q 'gateway.env' "$T/issue/50-gatecontrol.issue"
rm -rf "$T"

echo "== Erststart mit gateway-42.env (Windows-Zeilenenden, BOM)"
setup
{ printf '\xEF\xBB\xBF'; valid_env | sed 's/$/\r/'; } >"$T/boot/gatecontrol/gateway-42.env"
expect "Exit 0" run_start
expect "env übernommen" grep -q '^GC_TUNNEL_IP=10.8.0.42$' "$T/opt/config/gateway.env"
expect "env ohne CR" not grep -q $'\r' "$T/opt/config/gateway.env"
expect "env ohne BOM" test "$(head -c1 "$T/opt/config/gateway.env")" = "#"
expect "env 0600" test "$(stat -c %a "$T/opt/config/gateway.env")" = 600
expect "config/ 0700" test "$(stat -c %a "$T/opt/config")" = 700
expect "env von der Boot-Partition gelöscht" test ! -e "$T/boot/gatecontrol/gateway-42.env"
expect "Hostname gc-keller-pi-3" grep -qx 'gc-keller-pi-3' "$T/hostname"
expect "/etc/hosts angepasst" grep -q $'^127.0.1.1\tgc-keller-pi-3$' "$T/etc/hosts"
expect "cloud-init preserve_hostname" grep -q 'preserve_hostname: true' "$T/etc/cloud/cloud.cfg.d/99-gatecontrol-hostname.cfg"
expect "Gateway + Edge + MQTT gestartet (ohne deCONZ)" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt$' "$T/docker.log"
expect "deCONZ entfernt" grep -q 'compose -f docker-compose.yml rm -s -f deconz' "$T/docker.log"
expect "Gateway nach neuer env neu erstellt" grep -q 'up -d --force-recreate gateway' "$T/docker.log"
expect ".env ohne Zigbee-Profil" not grep -q COMPOSE_PROFILES "$T/opt/.env"
expect "Status OK" grep -q '^OK' "$T/run/status"

echo "== Neustart ohne neue env (keine Neuerstellung)"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "kein force-recreate" not grep -q force-recreate "$T/docker.log"

echo "== Neu-Einrichtung: neue env in den Boot-Ordner + ältere Kopie im Wurzelverzeichnis"
valid_env | sed 's/10.8.0.42/10.8.0.43/' >"$T/boot/gatecontrol/gateway.env"
valid_env >"$T/boot/gateway-7.env"
touch -d '2020-01-01' "$T/boot/gateway-7.env"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "neueste env gewinnt" grep -q '^GC_TUNNEL_IP=10.8.0.43$' "$T/opt/config/gateway.env"
expect "alle Kopien gelöscht" test ! -e "$T/boot/gatecontrol/gateway.env" -a ! -e "$T/boot/gateway-7.env"
expect "Hostname bleibt (bereits gesetzt)" grep -qx 'gc-keller-pi-3' "$T/hostname"
expect "force-recreate" grep -q 'up -d --force-recreate gateway' "$T/docker.log"

echo "== ungültige env bei laufendem Gateway"
echo "GC_SERVER_URL=kaputt" >"$T/boot/gatecontrol/gateway.env"
expect "Exit 0" run_start
expect "alte env bleibt" grep -q '^GC_TUNNEL_IP=10.8.0.43$' "$T/opt/config/gateway.env"
expect "abgelegt als .rejected (0600)" test "$(stat -c %a "$T/opt/config/gateway.env.rejected")" = 600
expect "von der Boot-Partition gelöscht" test ! -e "$T/boot/gatecontrol/gateway.env"
expect "Status mit Warnung" grep -q 'ungültig' "$T/run/status"
rm -rf "$T"

echo "== ungültige env beim Erststart"
setup
echo "irgendwas" >"$T/boot/gateway.env"
expect "Exit 0" run_start
expect "Status FEHLER" grep -q '^FEHLER' "$T/run/status"
expect "kein docker-Aufruf" test ! -s "$T/docker.log"
rm -rf "$T"

echo "== RaspBee erkannt + Hostname aus settings.txt"
setup
valid_env >"$T/boot/gatecontrol/gateway.env"
printf 'GC_ZIGBEE_DEVICE=/dev/ttyAMA0\nGC_ZIGBEE_TYPE=raspbee2-conbee2\n' >"$T/run/zigbee.env"
printf 'ZIGBEE=auto\r\nHOSTNAME="Mein-GW"\r\n' >"$T/boot/gatecontrol/settings.txt"
expect "Exit 0" run_start
expect ".env: kein Profil, kein Gerät (bestimmt das Gateway über radio-ctl)" not grep -q 'COMPOSE_PROFILES\|GC_ZIGBEE_DEVICE' "$T/opt/.env"
expect ".env: Zeitzone des Pi für deCONZ" grep -qx 'TZ=Europe/Berlin' "$T/opt/.env"
expect "kompletter Stack gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz$' "$T/docker.log"
expect "Hostname aus settings.txt" grep -qx 'mein-gw' "$T/hostname"
expect "Status nennt Port 8090" grep -q '8090' "$T/run/status"

echo "== Zigbee in GateControl aus (radio.json), obwohl ein RaspBee steckt"
mkdir -p "$T/opt/gateway-state"
printf '{"zigbee":false,"want":false}\n' >"$T/opt/gateway-state/radio.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "ohne deCONZ gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt$' "$T/docker.log"
expect "deCONZ entfernt" grep -q 'compose -f docker-compose.yml rm -s -f deconz' "$T/docker.log"

echo "== Zigbee in GateControl an (radio.json), ohne Funkmodul beim Start"
printf '{"zigbee":true,"want":true}\n' >"$T/opt/gateway-state/radio.json"
: >"$T/run/zigbee.env"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "deCONZ-Dienst trotzdem gestartet (wartet auf das Modul)" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz$' "$T/docker.log"
printf 'GC_ZIGBEE_DEVICE=/dev/ttyAMA0\nGC_ZIGBEE_TYPE=raspbee2-conbee2\n' >"$T/run/zigbee.env"
rm -f "$T/opt/gateway-state/radio.json"

echo "== Lokale KI in GateControl an (ai.json)"
printf '{"want":true}\n' >"$T/opt/gateway-state/ai.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "ki gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz ki$' "$T/docker.log"
printf '{"want":false}\n' >"$T/opt/gateway-state/ai.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "ohne ki gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz$' "$T/docker.log"
expect "ki entfernt" grep -q 'compose -f docker-compose.yml rm -s -f ki' "$T/docker.log"
rm -f "$T/opt/gateway-state/ai.json"

echo "== Kameras in GateControl an (cameras.json)"
printf '{"want":true}\n' >"$T/opt/gateway-state/cameras.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "kameras gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz kameras$' "$T/docker.log"
printf '{"want":false}\n' >"$T/opt/gateway-state/cameras.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "kameras entfernt" grep -q 'compose -f docker-compose.yml rm -s -f kameras' "$T/docker.log"
rm -f "$T/opt/gateway-state/cameras.json"

echo "== Office-Dateien drucken in GateControl an (office.json)"
printf '{"want":true}\n' >"$T/opt/gateway-state/office.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "office gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway edge mqtt deconz office$' "$T/docker.log"
printf '{"want":false}\n' >"$T/opt/gateway-state/office.json"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "office entfernt" grep -q 'compose -f docker-compose.yml rm -s -f office' "$T/docker.log"
rm -f "$T/opt/gateway-state/office.json"

echo "== settings.txt mit BOM in Zeile 1 + Ergebnis von gatecontrol-settings in STATUS.txt"
printf '\xEF\xBB\xBFHOSTNAME=bom-gw\r\nZIGBEE=auto\r\n' >"$T/boot/gatecontrol/settings.txt"
printf 'WLAN: "Netz" (Land DE, offenes Netz; LAN-Kabel hat Vorrang)\n' >"$T/run/settings.status"
expect "Exit 0" run_start
expect "Hostname trotz BOM" grep -qx 'bom-gw' "$T/hostname"
expect "STATUS.txt: Abschnitt Einstellungen" grep -q '^Einstellungen (settings.txt):' "$T/boot/gatecontrol/STATUS.txt"
expect "STATUS.txt: WLAN-Zeile" grep -q '^  - WLAN: "Netz"' "$T/boot/gatecontrol/STATUS.txt"
rm -f "$T/run/settings.status"

echo "== EDGE=off in settings.txt"
printf 'EDGE=Off\r\n' >"$T/boot/gatecontrol/settings.txt"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "Edge + MQTT entfernt" grep -q 'compose -f docker-compose.yml rm -s -f edge mqtt$' "$T/docker.log"
expect "ohne Edge gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway deconz$' "$T/docker.log"

echo "== CACHE_DIR in settings.txt"
mkdir -p "$T/usb disk" "$T/usb"
printf 'CACHE_DIR=%s\n' "$T/usb" >"$T/boot/gatecontrol/settings.txt"
expect "Exit 0" run_start
expect ".env: GC_CACHE_DIR" grep -qx "GC_CACHE_DIR=$T/usb" "$T/opt/.env"
expect "gateway-cache angelegt" test -d "$T/opt/gateway-cache"
for bad in "$T/fehlt" "$T/usb disk" "relativ/pfad" "$T/usb/../etc"; do
  printf 'CACHE_DIR=%s\n' "$bad" >"$T/boot/gatecontrol/settings.txt"
  expect "Exit 0 ($bad)" run_start
  expect "ungültiges CACHE_DIR verworfen ($bad)" not grep -q GC_CACHE_DIR "$T/opt/.env"
done
rm -f "$T/boot/gatecontrol/settings.txt"

echo "== Rollback-Override von update.sh bleibt aktiv"
echo 'services: {gateway: {image: x@sha256:00}}' >"$T/opt/docker-compose.rollback.yml"
printf 'GC_ZIGBEE_DEVICE=/dev/evil;rm -rf /\n' >"$T/run/zigbee.env"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "Override mitgegeben" grep -q -- '-f docker-compose.yml -f docker-compose.rollback.yml up' "$T/docker.log"
expect "ungültiger Gerätepfad verworfen" not grep -q evil "$T/opt/.env"
rm -rf "$T"

echo "== gatecontrol-radio: deCONZ-Dienst auf Wunsch des Gateways"
RADIO="$ROOTFS/usr/local/sbin/gatecontrol-radio"
run_radio() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_DIR="$T/opt" GC_BOOT="$T/boot" GC_RUN="$T/run" \
    bash "$RADIO" >"$T/out.log" 2>&1
}
setup
expect "ohne Flag: nichts" run_radio
expect "ohne Flag: kein docker-Aufruf" test ! -s "$T/docker.log"
mkdir -p "$T/opt/gateway-state" "$T/opt/config"
echo '{"zigbee":true}' >"$T/opt/gateway-state/radio-start"
expect "ohne gateway.env: Exit 0" run_radio
expect "ohne gateway.env: Flag verbraucht, kein docker-Aufruf" test ! -e "$T/opt/gateway-state/radio-start" -a ! -s "$T/docker.log"
valid_env >"$T/opt/config/gateway.env"
echo '{"zigbee":true}' >"$T/opt/gateway-state/radio-start"
expect "Exit 0" run_radio
expect "Flag verbraucht" test ! -e "$T/opt/gateway-state/radio-start"
expect "deCONZ angelegt" grep -q 'compose -f docker-compose.yml up -d --no-deps deconz$' "$T/docker.log"
expect "deconz/ angelegt" test -d "$T/opt/deconz"
rm -rf "$T"

echo "== gatecontrol-ai: Dienst ki auf Wunsch des Gateways"
AI="$ROOTFS/usr/local/sbin/gatecontrol-ai"
run_ai() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_DIR="$T/opt" GC_BOOT="$T/boot" GC_RUN="$T/run" \
    bash "$AI" >"$T/out.log" 2>&1
}
setup
expect "ohne Flag: nichts" run_ai
expect "ohne Flag: kein docker-Aufruf" test ! -s "$T/docker.log"
mkdir -p "$T/opt/gateway-state" "$T/opt/config"
echo '{"ai":true}' >"$T/opt/gateway-state/ai-start"
expect "ohne gateway.env: Exit 0" run_ai
expect "ohne gateway.env: Flag verbraucht, kein docker-Aufruf" test ! -e "$T/opt/gateway-state/ai-start" -a ! -s "$T/docker.log"
valid_env >"$T/opt/config/gateway.env"
echo '{"ai":true}' >"$T/opt/gateway-state/ai-start"
expect "Exit 0" run_ai
expect "Flag verbraucht" test ! -e "$T/opt/gateway-state/ai-start"
expect "ki angelegt" grep -q 'compose -f docker-compose.yml up -d --no-deps ki$' "$T/docker.log"
rm -rf "$T"

echo "== gatecontrol-cameras: Dienst kameras auf Wunsch des Gateways"
CAMS="$ROOTFS/usr/local/sbin/gatecontrol-cameras"
run_cams() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_DIR="$T/opt" GC_BOOT="$T/boot" GC_RUN="$T/run" \
    bash "$CAMS" >"$T/out.log" 2>&1
}
setup
expect "ohne Flag: nichts" run_cams
expect "ohne Flag: kein docker-Aufruf" test ! -s "$T/docker.log"
mkdir -p "$T/opt/gateway-state" "$T/opt/config"
echo '{"cameras":true}' >"$T/opt/gateway-state/cameras-start"
expect "ohne gateway.env: Exit 0" run_cams
expect "ohne gateway.env: Flag verbraucht, kein docker-Aufruf" test ! -e "$T/opt/gateway-state/cameras-start" -a ! -s "$T/docker.log"
valid_env >"$T/opt/config/gateway.env"
echo '{"cameras":true}' >"$T/opt/gateway-state/cameras-start"
expect "Exit 0" run_cams
expect "Flag verbraucht" test ! -e "$T/opt/gateway-state/cameras-start"
expect "kameras angelegt" grep -q 'compose -f docker-compose.yml up -d --no-deps kameras$' "$T/docker.log"
rm -rf "$T"

echo "== gatecontrol-office: Dienst office auf Wunsch des Gateways"
OFFICE="$ROOTFS/usr/local/sbin/gatecontrol-office"
run_office() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_DIR="$T/opt" GC_BOOT="$T/boot" GC_RUN="$T/run" \
    bash "$OFFICE" >"$T/out.log" 2>&1
}
setup
expect "ohne Flag: nichts" run_office
expect "ohne Flag: kein docker-Aufruf" test ! -s "$T/docker.log"
mkdir -p "$T/opt/gateway-state" "$T/opt/config"
echo '{"office":true}' >"$T/opt/gateway-state/office-start"
expect "ohne gateway.env: Exit 0" run_office
expect "ohne gateway.env: Flag verbraucht, kein docker-Aufruf" test ! -e "$T/opt/gateway-state/office-start" -a ! -s "$T/docker.log"
valid_env >"$T/opt/config/gateway.env"
echo '{"office":true}' >"$T/opt/gateway-state/office-start"
expect "Exit 0" run_office
expect "Flag verbraucht" test ! -e "$T/opt/gateway-state/office-start"
expect "office angelegt" grep -q 'compose -f docker-compose.yml up -d --no-deps office$' "$T/docker.log"
rm -rf "$T"

echo
echo "$pass ok, $failed Fehler"
[ "$failed" = 0 ]
