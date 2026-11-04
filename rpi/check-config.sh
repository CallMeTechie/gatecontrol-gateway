#!/bin/bash
# Schnelle statische Prüfung der Raspberry-Pi-Image-Konfiguration (für PRs,
# ohne Image-Bau): shellcheck, Python-Tests, Erststart-Tests,
# systemd-analyze verify, docker compose config, Pins in versions.env.
#
#   rpi/check-config.sh          (Erststart-Tests brauchen root → sudo)
set -euo pipefail

cd "$(dirname "$0")/.."
R=rpi/rootfs
# keine __pycache__ im Repo/Image
PYTHONPYCACHEPREFIX="$(mktemp -d)"
export PYTHONPYCACHEPREFIX PYTHONDONTWRITEBYTECODE=1
fail=0
step() { echo; echo "== $*"; }
die() { echo "FEHLER: $*" >&2; fail=1; }

step "versions.env: Pins"
# shellcheck source=versions.env
. rpi/versions.env
[[ "$PI_GEN_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "PI_GEN_COMMIT ist kein voller Commit-Hash"
[[ "$DOCKER_GPG_FINGERPRINT" =~ ^[0-9A-F]{40}$ ]] || die "DOCKER_GPG_FINGERPRINT ungültig"
[[ "$DECONZ_IMAGE" =~ ^deconzcommunity/deconz:[0-9.]+@sha256:[0-9a-f]{64}$ ]] || die "DECONZ_IMAGE nicht per Tag+Digest gepinnt"
[[ "$BUILD_CONTAINER" =~ @sha256:[0-9a-f]{64}$ ]] || die "BUILD_CONTAINER nicht per Digest gepinnt"
echo "$DOCKER_GPG_SHA256  rpi/stage-gatecontrol/00-docker/files/docker.asc" | sha256sum -c - || die "docker.asc: SHA-256 passt nicht"
GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
fpr="$(gpg --batch --show-keys --with-colons rpi/stage-gatecontrol/00-docker/files/docker.asc 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')"
rm -rf "$GNUPGHOME"; unset GNUPGHOME
[ "$fpr" = "$DOCKER_GPG_FINGERPRINT" ] || die "docker.asc: Fingerprint $fpr"

step "shellcheck"
mapfile -t sh_files < <(
  ls rpi/*.sh rpi/tests/*.sh rpi/stage-gatecontrol/*.sh rpi/stage-gatecontrol/*/*.sh
  echo "$R/usr/local/sbin/gatecontrol-start"
  echo "$R/usr/local/lib/gatecontrol/common.sh"
  echo "$R/etc/update-motd.d/60-gatecontrol"
)
shellcheck -x -S warning "${sh_files[@]}" && echo "ok (${#sh_files[@]} Dateien)" || die "shellcheck"

step "Ausführbar"
for f in rpi/stage-gatecontrol/prerun.sh rpi/stage-gatecontrol/*/*-run.sh "$R/usr/local/sbin/"* \
         "$R/etc/update-motd.d/60-gatecontrol" rpi/build-image.sh rpi/ci-build.sh rpi/verify-image.sh; do
  [ -x "$f" ] || die "$f ist nicht ausführbar (pi-gen/systemd brauchen +x)"
done
echo ok

step "Python (hwdetect, Imager-Repository)"
python3 -m py_compile "$R/usr/local/sbin/gatecontrol-hwdetect" rpi/make-imager-repo.py
python3 -m unittest discover -s rpi/tests -p 'test_*.py' || die "Python-Tests"

step "Erststart-Logik (gatecontrol-start)"
if [ "$(id -u)" = 0 ]; then
  bash rpi/tests/test-gatecontrol-start.sh || die "Erststart-Tests"
else
  echo "übersprungen (braucht root: sudo rpi/check-config.sh)"
fi

step "systemd-analyze verify"
VROOT="$(mktemp -d)"
mkdir -p "$VROOT/usr/lib/systemd"
cp -a /usr/lib/systemd/system "$VROOT/usr/lib/systemd/"
cp -a "$R/." "$VROOT/"
install -D -m 0755 deploy/update.sh "$VROOT/opt/gatecontrol-gateway/update.sh"
[ -f "$VROOT/usr/lib/systemd/system/docker.service" ] || \
  printf '[Unit]\nDescription=docker (Stub)\n[Service]\nExecStart=/bin/true\n' >"$VROOT/usr/lib/systemd/system/docker.service"
if out="$(SYSTEMD_LOG_LEVEL=notice systemd-analyze verify --man=no --root="$VROOT" "$VROOT"/etc/systemd/system/gatecontrol-* 2>&1)" && [ -z "$out" ]; then
  echo ok
else
  echo "$out"; die "systemd-analyze verify"
fi
rm -rf "$VROOT"

step "docker compose config"
CDIR="$(mktemp -d)"
sed "s|@DECONZ_IMAGE@|$DECONZ_IMAGE|" "$R/opt/gatecontrol-gateway/docker-compose.yml" >"$CDIR/docker-compose.yml"
mkdir -p "$CDIR/config"
(cd "$CDIR" && docker compose config -q && COMPOSE_PROFILES=zigbee GC_ZIGBEE_DEVICE=/dev/ttyACM0 docker compose config -q) \
  && echo "ok (mit und ohne Profil zigbee)" || die "docker compose config"
# Gleiche Sicherheits-Optionen wie docker-compose.example.yml
cp docker-compose.example.yml "$CDIR/example.yml"
pick='.services.gateway | {network_mode, cap_drop, cap_add, read_only, user, devices, tmpfs, volumes: [.volumes[] | {target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Gateway-Dienst hat dieselben Sicherheits-Optionen wie docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Sicherheits-Optionen weichen von docker-compose.example.yml ab"
fi
rm -rf "$CDIR"

echo
if [ "$fail" != 0 ]; then echo "rpi/check-config.sh: FEHLER"; exit 1; fi
echo "rpi/check-config.sh: alles ok"
