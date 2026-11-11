#!/bin/bash
# Schnelle statische Prüfung der Raspberry-Pi-Image-Konfiguration (für PRs,
# ohne Image-Bau): shellcheck, Python-Tests, Erststart- und settings.txt-Tests,
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
[[ "$OLLAMA_IMAGE" =~ ^ollama/ollama:[0-9.]+@sha256:[0-9a-f]{64}$ ]] || die "OLLAMA_IMAGE nicht per Tag+Digest gepinnt"
grep -qF "image: $OLLAMA_IMAGE" docker-compose.example.yml || die "OLLAMA_IMAGE weicht von docker-compose.example.yml ab"
[[ "$KAMERAS_IMAGE" =~ ^bluenviron/mediamtx:[0-9.]+-ffmpeg@sha256:[0-9a-f]{64}$ ]] || die "KAMERAS_IMAGE nicht per Tag+Digest gepinnt"
grep -qF "image: $KAMERAS_IMAGE" docker-compose.example.yml || die "KAMERAS_IMAGE weicht von docker-compose.example.yml ab"
[[ "$Z2M_IMAGE" =~ ^koenkk/zigbee2mqtt:[0-9.]+@sha256:[0-9a-f]{64}$ ]] || die "Z2M_IMAGE nicht per Tag+Digest gepinnt"
grep -qF "image: $Z2M_IMAGE" docker-compose.example.yml || die "Z2M_IMAGE weicht von docker-compose.example.yml ab"
[[ "$OTBR_IMAGE" =~ ^openthread/otbr:[a-z0-9.]+@sha256:[0-9a-f]{64}$ ]] || die "OTBR_IMAGE nicht per Digest gepinnt"
grep -qF "image: $OTBR_IMAGE" docker-compose.example.yml || die "OTBR_IMAGE weicht von docker-compose.example.yml ab"
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
  echo "$R/usr/local/sbin/gatecontrol-settings"
  echo "$R/usr/local/sbin/gatecontrol-radio"
  echo "$R/usr/local/sbin/gatecontrol-ai"
  echo "$R/usr/local/sbin/gatecontrol-cameras"
  echo "src/cameras/kameras.sh"
  echo "$R/usr/local/sbin/gatecontrol-office"
  echo "src/print/office.sh"
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

step "Erststart-Logik (gatecontrol-start) und settings.txt (gatecontrol-settings)"
if [ "$(id -u)" = 0 ]; then
  bash rpi/tests/test-gatecontrol-start.sh || die "Erststart-Tests"
  # GC_TEST_NMCLI (optional): nmcli mit --offline für den Keyfile-Parser-Test
  bash rpi/tests/test-gatecontrol-settings.sh || die "settings.txt-Tests"
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
sed -e "s|@DECONZ_IMAGE@|$DECONZ_IMAGE|" -e "s|@OLLAMA_IMAGE@|$OLLAMA_IMAGE|" -e "s|@KAMERAS_IMAGE@|$KAMERAS_IMAGE|" \
  -e "s|@Z2M_IMAGE@|$Z2M_IMAGE|" -e "s|@OTBR_IMAGE@|$OTBR_IMAGE|" "$R/opt/gatecontrol-gateway/docker-compose.yml" >"$CDIR/docker-compose.yml"
mkdir -p "$CDIR/config"
(cd "$CDIR" && docker compose config -q) && echo ok || die "docker compose config"
# Gleiche Sicherheits-Optionen wie docker-compose.example.yml
cp docker-compose.example.yml "$CDIR/example.yml"
pick='.services.gateway | {network_mode, cap_drop, cap_add, read_only, user, devices, device_cgroup_rules, tmpfs, volumes: [.volumes[] | {target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Gateway-Dienst hat dieselben Sicherheits-Optionen wie docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Sicherheits-Optionen weichen von docker-compose.example.yml ab"
fi
# Edge-Container (docs/edge.md): gleicher Dienst + gleiche Volumes wie im Beispiel,
# feste UID 61001, keine Capabilities, no-new-privileges, read-only.
edge_svcs=(edge mqtt)
for svc in "${edge_svcs[@]}"; do
  pick=".services.$svc | {image, entrypoint, network_mode, cap_drop, cap_add, read_only, user, security_opt, tmpfs, mem_limit, pids_limit, devices, volumes: [.volumes[] | {type, source, target, read_only, volume}]}"
  a="$(cd "$CDIR" && docker compose -f example.yml config --format json | jq -S "$pick")"
  b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
  if [ "$a" = "$b" ]; then echo "ok: Dienst $svc wie in docker-compose.example.yml"; else
    diff <(echo "$a") <(echo "$b") || true; die "Dienst $svc weicht von docker-compose.example.yml ab"
  fi
  echo "$b" | jq -e '.user == "61001:61001" and .cap_drop == ["ALL"] and .cap_add == null and .read_only == true
    and (.security_opt | index("no-new-privileges:true")) != null and .devices == null' >/dev/null \
    || die "Dienst $svc: Sicherheits-Optionen unvollständig (UID 61001, cap_drop ALL, read_only, no-new-privileges)"
done
# Edge ohne Netz (docs/edge.md "Gateway-Socket"): keine Netzgrenze, kein Kernel-Modul nötig
enet="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -r '.services.edge.network_mode')"
[ "$enet" = none ] || die "edge: network_mode muss none sein (ist: $enet)"
mimg="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -r '.services.mqtt.image')"
[[ "$mimg" =~ ^eclipse-mosquitto:[0-9.]+(-alpine)?@sha256:[0-9a-f]{64}$ ]] || die "mqtt: Image nicht per Tag+Digest gepinnt ($mimg)"
# deCONZ (docs/radio.md): wie im Beispiel (dort mit Profil zigbee), Wächter statt devices:, nur die drei tty-Majors
pick='.services.deconz | {image, entrypoint, network_mode, device_cgroup_rules, devices, privileged, cap_add, healthcheck, environment, volumes: [.volumes[] | {type, source, target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml --profile zigbee config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Dienst deconz wie in docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Dienst deconz weicht von docker-compose.example.yml ab"
fi
echo "$b" | jq -e '.devices == null and .privileged == null and .device_cgroup_rules == ["c 166:* rmw", "c 188:* rmw", "c 204:* rmw"]' >/dev/null \
  || die "Dienst deconz: nur die tty-Majors 166/188/204, kein devices:, nicht privileged"
prof="$(cd "$CDIR" && docker compose -f example.yml config --services | grep -cx deconz || true)"
[ "$prof" = 0 ] || die "docker-compose.example.yml: deconz muss im Profil zigbee stehen (sonst lädt jeder das Image)"
# zigbee2mqtt und Thread (docs/radio.md): wie im Beispiel (dort mit Profil zigbee2mqtt bzw. thread), Wächter statt
# eines festen Geräts, nur die tty-Majors; der Border Router braucht NET_ADMIN/NET_RAW und /dev/net/tun, nie privileged
for pair in zigbee2mqtt:zigbee2mqtt otbr:thread; do
  svc="${pair%%:*}"; prf="${pair##*:}"
  pick=".services.$svc | {image, entrypoint, working_dir, network_mode, device_cgroup_rules, devices, privileged, cap_add, cpu_shares, oom_score_adj, mem_limit, healthcheck, environment, volumes: [.volumes[] | {type, source, target, read_only}]}"
  a="$(cd "$CDIR" && docker compose -f example.yml --profile "$prf" config --format json | jq -S "$pick")"
  b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
  if [ "$a" = "$b" ]; then echo "ok: Dienst $svc wie in docker-compose.example.yml"; else
    diff <(echo "$a") <(echo "$b") || true; die "Dienst $svc weicht von docker-compose.example.yml ab"
  fi
  prof="$(cd "$CDIR" && docker compose -f example.yml config --services | grep -cx "$svc" || true)"
  [ "$prof" = 0 ] || die "docker-compose.example.yml: $svc muss im Profil $prf stehen (sonst lädt jeder das Image)"
done
echo "$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S '.services.zigbee2mqtt')" | jq -e '.devices == null and .privileged == null and .cap_add == null' >/dev/null \
  || die "Dienst zigbee2mqtt: keine Geräte, keine Capabilities, nicht privileged"
echo "$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S '.services.otbr')" | jq -e '.privileged == null and (.cap_add | sort) == ["NET_ADMIN", "NET_RAW"] and .device_cgroup_rules == ["c 166:* rmw", "c 188:* rmw"]' >/dev/null \
  || die "Dienst otbr: nur NET_ADMIN/NET_RAW, nur ttyACM/ttyUSB, nicht privileged"
# Lokale KI (docs/local-ai.md): wie im Beispiel (dort mit Profil ki), nur 127.0.0.1, Vorrang für das Gateway
pick='.services.ki | {image, entrypoint, network_mode, cpu_shares, oom_score_adj, devices, privileged, cap_add, healthcheck, environment, volumes: [.volumes[] | {type, source, target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml --profile ki config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Dienst ki wie in docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Dienst ki weicht von docker-compose.example.yml ab"
fi
echo "$b" | jq -e '.devices == null and .privileged == null and .cap_add == null and (.environment.OLLAMA_HOST | startswith("127.0.0.1:"))' >/dev/null \
  || die "Dienst ki: nur 127.0.0.1, keine Geräte, nicht privileged"
prof="$(cd "$CDIR" && docker compose -f example.yml config --services | grep -cx ki || true)"
[ "$prof" = 0 ] || die "docker-compose.example.yml: ki muss im Profil ki stehen (sonst lädt jeder das ≈ 3-GB-Image)"
# Kameras (docs/cameras.md): wie im Beispiel (dort mit Profil kameras), ohne Rechte, kein Port
pick='.services.kameras | {image, entrypoint, network_mode, user, cap_drop, cap_add, security_opt, read_only, tmpfs, cpu_shares, oom_score_adj, mem_limit, pids_limit, devices, privileged, ports, healthcheck, volumes: [.volumes[] | {type, source, target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml --profile kameras config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Dienst kameras wie in docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Dienst kameras weicht von docker-compose.example.yml ab"
fi
echo "$b" | jq -e '.cap_drop == ["ALL"] and .cap_add == null and .devices == null and .privileged == null and .ports == null and .read_only == true' >/dev/null \
  || die "Dienst kameras: keine Capabilities, keine Geräte, kein Port, read_only"
prof="$(cd "$CDIR" && docker compose -f example.yml config --services | grep -cx kameras || true)"
[ "$prof" = 0 ] || die "docker-compose.example.yml: kameras muss im Profil kameras stehen"
# Office-Dateien drucken (docs/print.md): wie im Beispiel (dort mit Profil office), ohne Netz, ohne Rechte
pick='.services.office | {image, entrypoint, network_mode, user, cap_drop, cap_add, security_opt, read_only, tmpfs, cpu_shares, oom_score_adj, mem_limit, pids_limit, devices, privileged, ports, healthcheck, volumes: [.volumes[] | {type, source, target, read_only}]}'
a="$(cd "$CDIR" && docker compose -f example.yml --profile office config --format json | jq -S "$pick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$pick")"
if [ "$a" = "$b" ]; then echo "ok: Dienst office wie in docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Dienst office weicht von docker-compose.example.yml ab"
fi
echo "$b" | jq -e '.network_mode == "none" and .cap_drop == ["ALL"] and .cap_add == null and .devices == null and .privileged == null and .ports == null and .read_only == true' >/dev/null \
  || die "Dienst office: kein Netz, keine Capabilities, keine Geräte, kein Port, read_only"
prof="$(cd "$CDIR" && docker compose -f example.yml config --services | grep -cx office || true)"
[ "$prof" = 0 ] || die "docker-compose.example.yml: office muss im Profil office stehen (sonst lädt jeder das ≈ 700-MB-Image)"
vpick='.volumes | with_entries(.value |= {driver_opts})'
# ki-models gehört nur dem Dienst ki (Profil ki im Beispiel), z2m-data/otbr-data den Funk-Diensten
a="$(cd "$CDIR" && docker compose -f example.yml --profile ki --profile kameras --profile zigbee2mqtt --profile thread --profile office config --format json | jq -S "$vpick")"
b="$(cd "$CDIR" && docker compose -f docker-compose.yml config --format json | jq -S "$vpick")"
if [ "$a" = "$b" ]; then echo "ok: Volumes wie in docker-compose.example.yml"; else
  diff <(echo "$a") <(echo "$b") || true; die "Volumes weichen von docker-compose.example.yml ab"
fi
rm -rf "$CDIR"

echo
if [ "$fail" != 0 ]; then echo "rpi/check-config.sh: FEHLER"; exit 1; fi
echo "rpi/check-config.sh: alles ok"
