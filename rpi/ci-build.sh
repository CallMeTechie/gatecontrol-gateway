#!/bin/bash
# CI-Einstieg: läuft IM Build-Container (BUILD_CONTAINER aus versions.env,
# privileged, nativ arm64), installiert die pi-gen-Abhängigkeiten und baut.
#
#   docker run --rm --privileged -v "$PWD:/src" -v "$OUT:/out" "$BUILD_CONTAINER" \
#     bash /src/rpi/ci-build.sh <version> /out
set -euo pipefail

VERSION="${1:?Version fehlt}"
OUT="${2:-/out}"

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
# Liste aus der pi-gen-README (Tag in versions.env) + udev für Loop-Partitionen
apt-get -qq install -y --no-install-recommends \
  coreutils quilt parted qemu-user-binfmt debootstrap zerofree zip \
  dosfstools e2fsprogs libarchive-tools libcap2-bin grep rsync xz-utils file git curl bc \
  gpg pigz xxd arch-test bmap-tools kmod ca-certificates fdisk udev debian-archive-keyring \
  >/dev/null

git config --global --add safe.directory '*'
exec /src/rpi/build-image.sh "$VERSION" "$OUT"
