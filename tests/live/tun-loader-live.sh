#!/usr/bin/env bash
# docker-compose.tun-loader.yml gegen einen echten Docker-Daemon (CI-Job tun-loader):
#   1. Syntax: docker compose config mit docker-compose.example.yml
#   2. Gerät ist da (auf dem Runner steht tun in /proc/misc) → Exit 0, nichts geladen
#   3. Laden mit genau den Rechten des Dienstes (cap_drop ALL + SYS_MODULE, kein Netz,
#      nur lesbar, no-new-privileges): das Skript lädt per insmod ein harmloses
#      Modul des Runners (dummy) – tun selbst ist dort fest im Kernel.
#   4. Gegenprobe: ohne SYS_MODULE scheitert dasselbe Laden.
# Image: alpine (dieselbe Basis und dasselbe busybox wie das Gateway-Image, das in
# diesem Job nicht gebaut wird).
set -euo pipefail

cd "$(dirname "$0")/../.."
WORK="$(mktemp -d)"
trap 'sudo rmmod dummy 2>/dev/null || true; rm -rf "$WORK"' EXIT
ALPINE="${GC_TUN_TEST_IMAGE:-alpine:3.22}"

cat >"$WORK/image.yml" <<YAML
services:
  tun-loader:
    image: $ALPINE
YAML
# Gegenprobe: derselbe Dienst ohne die Capability
cat >"$WORK/nocap.yml" <<YAML
services:
  tun-loader:
    cap_add: !reset []
YAML
dc() { docker compose -p gc-tun-test -f docker-compose.example.yml -f docker-compose.tun-loader.yml -f "$WORK/image.yml" "$@"; }

echo "== 1. docker compose config"
dc config -q
dc config --services | grep -qx tun-loader

echo "== 2. /dev/net/tun ist da"
grep -Eq '^[[:space:]]*[0-9]+[[:space:]]+tun$' /proc/misc || { echo "der Runner hat kein tun in /proc/misc" >&2; exit 1; }
out="$(dc run -T --rm --no-deps tun-loader 2>&1)" || { echo "$out"; echo "Exit != 0, obwohl das Gerät da ist" >&2; exit 1; }
echo "$out"
grep -q "nothing to load" <<<"$out"

echo "== 3. Modul laden mit den Rechten des Dienstes"
src="$(find "/lib/modules/$(uname -r)" -name 'dummy.ko*' | head -1)"
[ -n "$src" ] || { echo "kein Modul dummy auf dem Runner" >&2; exit 1; }
mkdir "$WORK/mod"
case "$src" in
  *.zst) zstd -q -d "$src" -o "$WORK/mod/dummy.ko" ;;
  *.xz)  xz -d -c "$src" >"$WORK/mod/dummy.ko" ;;
  *.gz)  gzip -d -c "$src" >"$WORK/mod/dummy.ko" ;;
  *)     cp "$src" "$WORK/mod/dummy.ko" ;;
esac
chmod -R a+rX "$WORK"
sudo rmmod dummy 2>/dev/null || true
if lsmod | grep -q '^dummy '; then echo "dummy ließ sich nicht entladen" >&2; exit 1; fi
load() { dc "$@" run -T --rm --no-deps -v "$WORK/mod:/mod:ro" -e GC_TUN_KO=/mod/dummy.ko -e GC_TUN_MISC=/dev/null -e GC_TUN_WAIT=1 tun-loader 2>&1; }

echo "-- Gegenprobe zuerst: ohne SYS_MODULE"
out="$(load -f "$WORK/nocap.yml")" && { echo "$out"; echo "Exit 0 ohne Gerät" >&2; exit 1; }
echo "$out"
if lsmod | grep -q '^dummy '; then echo "Modul ohne SYS_MODULE geladen?!" >&2; exit 1; fi

echo "-- mit den Rechten des Dienstes"
# für diesen Lauf ist die Geräteliste leer (/dev/null) → Exit 1 mit der Meldung; geladen sein muss das Modul trotzdem
out="$(load)" && { echo "$out"; echo "Exit 0 ohne Gerät" >&2; exit 1; }
echo "$out"
grep -q "FEHLER: " <<<"$out"
grep -q "ERROR: " <<<"$out"
lsmod | grep -q '^dummy ' || { echo "insmod aus dem Container hat das Modul nicht geladen" >&2; exit 1; }
echo "ok: Modul aus dem Container geladen (cap_drop ALL + SYS_MODULE, kein Netz, nur lesbar)"
