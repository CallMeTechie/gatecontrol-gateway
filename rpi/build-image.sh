#!/bin/bash
# Baut das Raspberry-Pi-Image des GateControl Gateways mit pi-gen.
#
#   sudo rpi/build-image.sh <version> [ausgabe-verzeichnis]
#
# Läuft nativ auf arm64 (GitHub-Runner ubuntu-24.04-arm) — pi-gen
# unterstützt offiziell nur native Builds. Ergebnis im Ausgabeverzeichnis:
#   gatecontrol-gateway-<version>-rpi-arm64.img.xz (+ .sha256)
#   gatecontrol-gateway-<version>-rpi-arm64.img.xz.info (Paketliste von pi-gen)
set -euo pipefail

VERSION="${1:?Version fehlt (z. B. 1.17.0)}"
OUT_DIR="$(realpath -m "${2:-deploy-rpi}")"
REPO_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
WORK="${PI_GEN_WORKDIR:-/tmp/gc-pi-gen}"
NAME="gatecontrol-gateway-${VERSION}-rpi-arm64"

[[ "$VERSION" =~ ^[0-9A-Za-z.+-]{1,40}$ ]] || { echo "ungültige Version: $VERSION" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "pi-gen braucht root (sudo)" >&2; exit 1; }

# shellcheck source-path=SCRIPTDIR source=versions.env
. "$REPO_DIR/rpi/versions.env"

echo "::group::pi-gen ${PI_GEN_TAG} (${PI_GEN_COMMIT}) holen"
rm -rf "$WORK"
mkdir -p "$WORK"
git -C "$WORK" init -q
git -C "$WORK" fetch -q --depth 1 "$PI_GEN_REPO" "$PI_GEN_COMMIT"
git -C "$WORK" -c advice.detachedHead=false checkout -q FETCH_HEAD
actual="$(git -C "$WORK" rev-parse HEAD)"
[ "$actual" = "$PI_GEN_COMMIT" ] || { echo "pi-gen-Commit $actual != $PI_GEN_COMMIT" >&2; exit 1; }
echo "::endgroup::"

# Nur die Lite-Stufen + unsere Stufe; stage2 nicht separat exportieren.
touch "$WORK/stage2/SKIP_IMAGES"
rm -rf "$WORK/stage-gatecontrol"
cp -a "$REPO_DIR/rpi/stage-gatecontrol" "$WORK/stage-gatecontrol"

cat >"$WORK/config" <<EOF
IMG_NAME=gatecontrol-gateway
PI_GEN_RELEASE="GateControl Gateway ${VERSION} (Raspberry Pi OS Lite, ${PI_GEN_TAG})"
RELEASE=trixie
STAGE_LIST="stage0 stage1 stage2 stage-gatecontrol"
DEPLOY_COMPRESSION=xz
COMPRESSION_LEVEL=6
DEPLOY_DIR="${WORK}/deploy"
LOCALE_DEFAULT=de_DE.UTF-8
KEYBOARD_KEYMAP=de
KEYBOARD_LAYOUT="German"
TIMEZONE_DEFAULT=Europe/Berlin
# Kein Standard-Passwort: Benutzer, SSH und WLAN kommen aus dem Raspberry Pi
# Imager (cloud-init) bzw. dem Einrichtungsdialog beim ersten Start.
FIRST_USER_NAME=pi
ENABLE_SSH=0
ENABLE_CLOUD_INIT=1
export GC_REPO_DIR="${REPO_DIR}"
export GC_IMAGE_VERSION="${VERSION}"
EOF

echo "::group::pi-gen build"
(cd "$WORK" && ./build.sh)
echo "::endgroup::"

mkdir -p "$OUT_DIR"
img="$(find "$WORK/deploy" -maxdepth 1 -name '*-gatecontrol.img.xz' | head -n1)"
[ -n "$img" ] || { echo "kein Image in $WORK/deploy" >&2; ls -la "$WORK/deploy" >&2 || true; exit 1; }
mv -f "$img" "$OUT_DIR/$NAME.img.xz"
info="$(find "$WORK/deploy" -maxdepth 1 -name '*-gatecontrol.info' | head -n1)"
if [ -n "$info" ]; then cp -f "$info" "$OUT_DIR/$NAME.img.xz.info"; fi
(cd "$OUT_DIR" && sha256sum "$NAME.img.xz" >"$NAME.img.xz.sha256")
ls -la "$OUT_DIR"
