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
expect "nur Gateway gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans gateway$' "$T/docker.log"
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
expect ".env: Profil zigbee" grep -qx 'COMPOSE_PROFILES=zigbee' "$T/opt/.env"
expect ".env: Gerät" grep -qx 'GC_ZIGBEE_DEVICE=/dev/ttyAMA0' "$T/opt/.env"
expect ".env: Zeitzone des Pi für deCONZ" grep -qx 'TZ=Europe/Berlin' "$T/opt/.env"
expect "kompletter Stack gestartet" grep -q 'compose -f docker-compose.yml up -d --remove-orphans$' "$T/docker.log"
expect "Hostname aus settings.txt" grep -qx 'mein-gw' "$T/hostname"
expect "Status nennt Port 8090" grep -q '8090' "$T/run/status"

echo "== Rollback-Override von update.sh bleibt aktiv"
echo 'services: {gateway: {image: x@sha256:00}}' >"$T/opt/docker-compose.rollback.yml"
printf 'GC_ZIGBEE_DEVICE=/dev/evil;rm -rf /\n' >"$T/run/zigbee.env"
: >"$T/docker.log"
expect "Exit 0" run_start
expect "Override mitgegeben" grep -q -- '-f docker-compose.yml -f docker-compose.rollback.yml up' "$T/docker.log"
expect "ungültiger Gerätepfad verworfen" not grep -q evil "$T/opt/.env"
rm -rf "$T"

echo
echo "$pass ok, $failed Fehler"
[ "$failed" = 0 ]
