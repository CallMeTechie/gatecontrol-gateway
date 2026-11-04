#!/bin/bash
# Prüft ein fertiges Raspberry-Pi-Image per Loop-Mount (ohne es zu booten).
#
#   sudo rpi/verify-image.sh <image.img.xz|image.img> [erwartete-version]
#
# Gibt außerdem extract_size / extract_sha256 für die Imager-Repository-
# Datei aus (Datei <image>.extract), weil das Image dafür ohnehin entpackt wird.
set -euo pipefail

IMG_IN="${1:?Image fehlt}"
EXPECT_VERSION="${2:-}"
[ "$(id -u)" = 0 ] || { echo "Loop-Mount braucht root (sudo)" >&2; exit 1; }

WORK="$(mktemp -d)"
LOOPS=()
cleanup() {
  set +e
  mountpoint -q "$WORK/root/boot/firmware" && umount "$WORK/root/boot/firmware"
  mountpoint -q "$WORK/root" && umount "$WORK/root"
  for l in "${LOOPS[@]}"; do losetup -d "$l"; done
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ "$IMG_IN" == *.xz ]]; then
  IMG="$WORK/image.img"
  xz -dc "$IMG_IN" >"$IMG"
  printf 'extract_size=%s\nextract_sha256=%s\n' "$(stat -c %s "$IMG")" "$(sha256sum "$IMG" | cut -d' ' -f1)" \
    >"${IMG_IN%.xz}.extract"
else
  IMG="$IMG_IN"
fi

# Je Partition ein eigenes Loop-Device mit Offset — funktioniert auch in
# Containern ohne udev, wo /dev/loopNpM nicht angelegt wird.
part_loop() {  # part_loop <nr> → Loop-Device der Partition (MBR, wie pi-gen sie anlegt)
  local start size
  read -r start size < <(python3 -I -c '
import struct, sys
with open(sys.argv[1], "rb") as f:
    mbr = f.read(512)
assert mbr[510:512] == b"\x55\xaa", "kein MBR"
e = mbr[446 + 16 * (int(sys.argv[2]) - 1):][:16]
print(*struct.unpack("<II", e[8:16]))' "$IMG" "$1")
  [ "${size:-0}" -gt 0 ] || { echo "Partition $1 nicht gefunden" >&2; exit 1; }
  losetup --show -f -r -o $((start * 512)) --sizelimit $((size * 512)) "$IMG"
}
ROOT_LOOP="$(part_loop 2)"; LOOPS+=("$ROOT_LOOP")
BOOT_LOOP="$(part_loop 1)"; LOOPS+=("$BOOT_LOOP")
mkdir -p "$WORK/root"
mount -o ro "$ROOT_LOOP" "$WORK/root"
mount -o ro "$BOOT_LOOP" "$WORK/root/boot/firmware"
R="$WORK/root"
B="$R/boot/firmware"

fail=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FEHLER $*"; fail=1; }
check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi; }
enabled() {  # Unit ist in einem *.wants-Verzeichnis verlinkt
  find "$R/etc/systemd/system" -path '*.wants/*' -name "$1" | grep -q .
}
not() { ! "$@"; }
no_password_hashes() {  # Feld 2 von /etc/shadow beginnt bei echten Hashes mit "$"
  ! cut -d: -f2 "$1" | grep -q '^\$'
}

echo "== Dateien"
for f in /opt/gatecontrol-gateway/docker-compose.yml /opt/gatecontrol-gateway/update.sh \
         /usr/local/sbin/gatecontrol-start /usr/local/sbin/gatecontrol-hwdetect /usr/local/sbin/gatecontrol-settings \
         /usr/local/lib/gatecontrol/common.sh /etc/docker/daemon.json \
         /etc/rpi/swap.conf.d/80-gatecontrol.conf /etc/systemd/journald.conf.d/40-gatecontrol.conf \
         /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/52gatecontrol-unattended-upgrades \
         /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/gatecontrol/image-release; do
  check "$f" test -s "$R$f"
done
check "update.sh = deploy/update.sh" cmp "$R/opt/gatecontrol-gateway/update.sh" "$(dirname "$0")/../deploy/update.sh"
check "Skripte ausführbar" test -x "$R/usr/local/sbin/gatecontrol-start" -a -x "$R/usr/local/sbin/gatecontrol-hwdetect" \
  -a -x "$R/usr/local/sbin/gatecontrol-settings" -a -x "$R/opt/gatecontrol-gateway/update.sh"
check "config/ ist 0700" test "$(stat -c %a "$R/opt/gatecontrol-gateway/config")" = 700
check "gateway-state/ + deconz/ vorhanden" test -d "$R/opt/gatecontrol-gateway/gateway-state" -a -d "$R/opt/gatecontrol-gateway/deconz"
check "keine gateway.env im Image" test ! -e "$R/opt/gatecontrol-gateway/config/gateway.env"
check "deCONZ-Image mit Digest eingetragen" grep -qE 'image: deconzcommunity/deconz:[0-9.]+@sha256:[0-9a-f]{64}' "$R/opt/gatecontrol-gateway/docker-compose.yml"
if [ -n "$EXPECT_VERSION" ]; then
  check "image-release = $EXPECT_VERSION" grep -qx "$EXPECT_VERSION" "$R/etc/gatecontrol/image-release"
fi

echo "== Docker / Pakete"
check "dockerd installiert" test -x "$R/usr/bin/dockerd"
check "docker compose-Plugin installiert" test -x "$R/usr/libexec/docker/cli-plugins/docker-compose"
check "containerd installiert" test -x "$R/usr/bin/containerd"
check "unattended-upgrades installiert" test -x "$R/usr/bin/unattended-upgrade"
check "cloud-init installiert (Imager-Einstellungen)" test -x "$R/usr/bin/cloud-init"
# Werkzeuge von gatecontrol-settings (WLAN, Funkland, SSH)
check "NetworkManager (nmcli) installiert" test -x "$R/usr/bin/nmcli"
check "raspi-config installiert (Funkland)" test -x "$R/usr/bin/raspi-config"
check "ssh-keygen/sshd/visudo installiert" test -x "$R/usr/bin/ssh-keygen" -a -x "$R/usr/sbin/sshd" -a -x "$R/usr/sbin/visudo"
check "zoneinfo + iso3166.tab" test -s "$R/usr/share/zoneinfo/Europe/Berlin" -a -s "$R/usr/share/zoneinfo/iso3166.tab"
check "rpi-swap installiert (zram)" test -d "$R/usr/lib/systemd/zram-generator.conf.d" -o -e "$R/usr/lib/systemd/system-generators/rpi-swap-generator"
grep -E '^(docker-ce|containerd\.io|docker-compose-plugin|cloud-init|unattended-upgrades|linux-image-rpi-v8) ' \
  <(awk '/^Package: /{p=$2} /^Version: /{print p, $2}' "$R/var/lib/dpkg/status") | sed 's/^/        /'

echo "== systemd-Units aktiviert"
for u in docker.service containerd.service gatecontrol-settings.service gatecontrol-hwdetect.service gatecontrol-gateway.service \
         gatecontrol-gateway-update.path gatecontrol-gateway-update.timer apt-daily-upgrade.timer; do
  check "$u" enabled "$u"
done
check "ssh NICHT aktiviert (nur über Imager oder SSH_AUTHORIZED_KEY)" not enabled ssh.service
check "serial-getty@ttyAMA0 maskiert" test "$(readlink "$R/etc/systemd/system/serial-getty@ttyAMA0.service")" = /dev/null

echo "== Boot-Partition"
check "config.txt: enable_uart=1" grep -qx 'enable_uart=1' "$B/config.txt"
check "config.txt: dtoverlay=disable-bt" grep -qx 'dtoverlay=disable-bt' "$B/config.txt"
check "config.txt: arm_64bit=1" grep -qx 'arm_64bit=1' "$B/config.txt"
check "cmdline.txt: keine serielle Konsole" not grep -q 'console=serial0' "$B/cmdline.txt"
check "cmdline.txt: root=PARTUUID" grep -q 'root=PARTUUID=' "$B/cmdline.txt"
check "gatecontrol/settings.txt" test -s "$B/gatecontrol/settings.txt"
check "gatecontrol/LIESMICH.txt" test -s "$B/gatecontrol/LIESMICH.txt"
check "cloud-init user-data/meta-data/network-config" test -f "$B/user-data" -a -f "$B/meta-data" -a -f "$B/network-config"
check "Kernel für Pi 3/4 (kernel8.img)" test -s "$B/kernel8.img"
check "Kernel für Pi 5 (kernel_2712.img)" test -s "$B/kernel_2712.img"
check "Device Tree Pi 3 B+" test -s "$B/bcm2710-rpi-3-b-plus.dtb"
check "Device Tree Pi 4 B" test -s "$B/bcm2711-rpi-4-b.dtb"
check "Overlay disable-bt" test -s "$B/overlays/disable-bt.dtbo"

echo "== Sicherheit"
check "kein Konto mit Passwort-Hash (keine Standard-Passwörter)" no_password_hashes "$R/etc/shadow"
check "keine SSH-Hostkeys im Image" not compgen -G "$R/etc/ssh/ssh_host_*_key"
check "kein Benutzer gcadmin im Image (erst mit SSH_AUTHORIZED_KEY)" not grep -q '^gcadmin:' "$R/etc/passwd"
check "keine WLAN-Verbindung im Image" test ! -e "$R/etc/NetworkManager/system-connections/gatecontrol-wifi.nmconnection"

echo
df -h "$R" "$B" | sed 's/^/  /'
echo "  Image (entpackt): $(du -h --apparent-size "$IMG" | cut -f1)"
if [ "$fail" != 0 ]; then
  echo "Image-Prüfung FEHLGESCHLAGEN" >&2
  exit 1
fi
echo "Image-Prüfung bestanden"
