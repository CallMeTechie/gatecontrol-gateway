#!/usr/bin/env bash
# Dienst umwandeln im fertigen Image (docs/transcode.md): ein erzeugtes 10-Bit-Video
# wird im Container wirklich umgewandelt – mit den Schutzoptionen der Compose-Datei
# (kein Netz, cap_drop ALL, no-new-privileges, read-only, nicht root, Zusatzgruppe
# 61002) und den Rechten des Volumes umw-ctl (root:61002, 2750), ohne Grafik-Gerät:
# der Wächter meldet device=absent und nimmt libx264, weil der Auftrag es erlaubt.
# Aufruf: tests/live/umwandeln-image.sh <image>   (braucht docker und sudo)
set -euo pipefail

IMAGE="${1:?image}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="$(mktemp -d /tmp/gc-umw-live.XXXXXX)"
NAME="gc-umw-live-$$"
SVC_UID=12345
MEDIA="$W/medien"
CTL="$W/ctl"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  sudo rm -rf "${W:?}"
}
trap cleanup EXIT
fail() { echo "FEHLER: $*" >&2; docker logs "$NAME" 2>&1 | tail -n 30 >&2 || true; sudo sh -c "ls -la '$CTL' '$CTL/state'; cat '$CTL'/state/* 2>/dev/null" >&2 || true; exit 1; }

mkdir -p "$MEDIA/Serie" "$W/in"
chmod 755 "$W"
printf '1\n00:00:00,500 --> 00:00:02,000\nHallo\n' > "$W/in/sub.srt"
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Eins\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Zwei\n' > "$W/in/meta.txt"
printf 'keine echte schrift' > "$W/in/schrift.ttf"
SRC="$MEDIA/Serie/Folge 01 [10bit].mkv"

echo "== Testvideo erzeugen (H.264 High 10, 2 Tonspuren, Untertitel, Anhang, Kapitel)"
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$W:$W" --entrypoint ffmpeg "$IMAGE" \
  -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i testsrc2=size=640x360:rate=50:duration=4 \
  -f lavfi -i sine=frequency=440:duration=4 -f lavfi -i sine=frequency=880:duration=4 \
  -i "$W/in/sub.srt" -i "$W/in/meta.txt" \
  -map 0:v -map 1:a -map 2:a -map 3:s -map_metadata 4 -map_chapters 4 \
  -c:v libx264 -preset ultrafast -profile:v high10 -pix_fmt yuv420p10le -c:a aac -b:a 64k -c:s ass \
  -attach "$W/in/schrift.ttf" -metadata:s:t mimetype=application/x-truetype-font -metadata:s:t filename=schrift.ttf \
  -f matroska "$SRC"
probe() { docker run --rm --network none --user "$(id -u):$(id -g)" -v "$W:$W:ro" --entrypoint ffprobe "$IMAGE" -v error "$@"; }
[ "$(probe -select_streams V:0 -show_entries stream=pix_fmt -of csv=p=0 "$SRC")" = yuv420p10le ] || fail "Testvideo ist nicht 10 Bit"
ORIG_SUM="$(sha256sum "$SRC" | cut -d' ' -f1)"

echo "== Volume umw-ctl wie in der Compose-Datei (root:61002, 2750) und was das Gateway hineinlegt"
sudo install -d -o 0 -g 61002 -m 2750 "$CTL"
sudo install -d -o 0 -m 0755 "$CTL/jobs"
sudo install -d -o 0 -g 61002 -m 0770 "$CTL/state"
sudo install -o 0 -m 0644 "$HERE/src/transcode/umwandeln.sh" "$CTL/umwandeln.sh"
printf 'on\n' | sudo tee "$CTL/run" >/dev/null
printf 'TRASH_DAYS=14\nRESERVE_MB=0\nMIN_FREE_GB=0\nMIN_FREE_PCT=0\nVERIFY_DECODE=1\n' | sudo tee "$CTL/conf" >/dev/null
printf 'KIND=convert\nSRC=%s\nSOFTWARE=1\nQUALITY=23\n' "$SRC" | sudo tee "$CTL/jobs/live0001.job" >/dev/null
# der eigene Benutzer des Dienstes besitzt nur den Medienordner
sudo chown -R "$SVC_UID:$SVC_UID" "$MEDIA"

echo "== Dienst starten (Einstieg des Images, Schutzoptionen der Compose-Datei)"
docker run -d --name "$NAME" --network none --cap-drop ALL --security-opt no-new-privileges:true --read-only \
  --tmpfs /tmp:size=64m --user "$SVC_UID:$SVC_UID" --group-add 61002 --pids-limit 256 --memory 2g \
  -e "GC_UMW_ROOTS=$MEDIA" -e LIBVA_DRIVER_NAME=iHD \
  -v "$CTL:/gc-umw" -v "$MEDIA:$MEDIA" "$IMAGE" >/dev/null

state() { sudo cat "$CTL/state/live0001" 2>/dev/null | cut -d' ' -f1 || true; }
for _ in $(seq 1 180); do
  case "$(state)" in done|failed) break ;; esac
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || fail "Container läuft nicht mehr"
  sleep 1
done
echo "-- Zustand: $(sudo cat "$CTL/state/live0001" 2>/dev/null || echo fehlt)"
sudo cat "$CTL/state/live0001.res" 2>/dev/null || true
echo "-- caps:"; sudo cat "$CTL/state/caps"
[ "$(state)" = "done" ] || fail "Auftrag nicht fertig"
sudo grep -qx 'mode=software' "$CTL/state/live0001.res" || fail "nicht der Software-Weg"
sudo grep -qx 'device=absent' "$CTL/state/caps" || fail "caps: device"
sudo grep -qx 'software=1' "$CTL/state/caps" || fail "caps: software"
sudo grep -qx "uid=$SVC_UID" "$CTL/state/caps" || fail "caps: uid"
sudo grep -q '^ffmpeg=8\.' "$CTL/state/caps" || fail "caps: ffmpeg"

echo "== Ergebnis prüfen"
[ "$(probe -select_streams V:0 -show_entries stream=codec_name,profile,pix_fmt -of csv=p=0 "$SRC")" = "h264,High,yuv420p" ] || fail "neue Datei ist nicht H.264 High 8 Bit"
[ "$(probe -show_entries stream=codec_type -of csv=p=0 "$SRC" | sort | uniq -c | tr -s ' ' | tr '\n' ';')" = " 1 attachment; 2 audio; 1 subtitle; 1 video;" ] || fail "Spuren weichen ab"
[ "$(probe -show_entries chapter=id -of csv=p=0 "$SRC" | grep -c .)" = 2 ] || fail "Kapitel fehlen"
TRASH="$(sudo sed -n 's/^trash=//p' "$CTL/state/live0001.res")"
case "$TRASH" in "$MEDIA/.gc-papierkorb/"*) ;; *) fail "Papierkorb-Pfad: $TRASH" ;; esac
[ "$(sudo sha256sum "$TRASH" | cut -d' ' -f1)" = "$ORIG_SUM" ] || fail "Original im Papierkorb verändert"
sudo test -f "$TRASH.gc-info" || fail ".gc-info fehlt"
[ -z "$(sudo find "$MEDIA/.gc-umwandeln" -name '*.part.mkv')" ] || fail "Zwischendatei geblieben"
[ "$(sudo stat -c %u "$SRC")" = "$SVC_UID" ] || fail "neue Datei gehört nicht dem Benutzer des Dienstes"

echo "== Der Dienst kann außerhalb der Medienordner nichts schreiben und hat kein Netz"
docker exec "$NAME" sh -c 'touch /gc-umw/x 2>/dev/null || touch /gc-umw/jobs/x 2>/dev/null || touch /usr/x 2>/dev/null' && fail "Schreiben außerhalb war möglich"
docker exec "$NAME" sh -c 'cat /proc/net/dev | grep -vc "lo:" | grep -qx 2' || fail "es gibt eine Netzschnittstelle außer lo"
docker exec "$NAME" sh -c 'grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status' || fail "der Dienst hat Capabilities"

echo "== Healthcheck der Compose-Datei, dann sauber beenden"
docker exec "$NAME" sh -c '[ ! -s /gc-umw/umwandeln.sh ] || [ $(( $(date +%s) - $(cut -d" " -f2 /gc-umw/state/umwandeln.state 2>/dev/null || echo 0) )) -lt 120 ]' || fail "Healthcheck"
docker stop -t 15 "$NAME" >/dev/null
echo "ok: umgewandelt im Container, Original im Papierkorb, keine Rechte, kein Netz"
