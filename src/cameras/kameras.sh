#!/bin/sh
# Wächter des Dienstes „kameras“ (docs/cameras.md §5). Das Gateway legt diese
# Datei nach /gc-cam/kameras.sh (tmpfs-Volume cam-ctl); der Einstieg des
# Dienstes führt sie aus. Je Auftrag run/<id>.env läuft ein ffmpeg:
#   Stream-Kopie (kein Umkodieren) in einen HLS-Ring (fMP4, 2-s-Segmente) unter
#   media/<id>/ und alle 5 s ein kleines Standbild (nur Schlüsselbilder dekodiert).
# Geänderte Datei → ffmpeg neu, abgestürzt → nach 10 s neu, Datei weg → beendet
# und Ring gelöscht. Ändert das Gateway diese Datei, startet sich der Wächter neu.
# Zustand: state/<id> (running|exit|wait <Unix-Sekunden>), kameras.state (alive …).
C="${GC_CAM_DIR:-/gc-cam}"
T="${GC_CAM_TMP:-/tmp}/gc-cam"
FF="${GC_FFMPEG:-ffmpeg}"
SELF="$C/kameras.sh"
mkdir -p "$T" "$C/media" "$C/state" || exit 1
me="$(cksum < "$SELF" 2>/dev/null)"

dead() { [ ! -e "/proc/$1" ] || grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }
say() { printf '%s %s\n' "$2" "$(date +%s)" > "$C/state/.$1" && mv -f "$C/state/.$1" "$C/state/$1"; }
halt() {
  p="$(cat "$T/p.$1" 2>/dev/null)"
  if [ -n "$p" ]; then kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; fi
  rm -f "$T/p.$1" "$T/s.$1"
}
halt_all() { for f in "$T"/p.*; do [ -f "$f" ] && halt "${f##*/p.}"; done; }
trap 'halt_all; exit 0' TERM INT

start() {
  id="$1"; f="$C/run/$id.env"
  url="$(sed -n 's/^URL=//p' "$f" | head -n 1)"
  case "$url" in *[[:space:]]*|"") say "$id" "wait"; return ;; esac
  # nur RTSP; file: nur für die Tests des Gateways (GC_CAM_ALLOW_FILE=1, im Dienst nie gesetzt)
  case "$url" in
    rtsp://*) set -- -rtsp_transport tcp -timeout 10000000 ;;
    file:*) [ "${GC_CAM_ALLOW_FILE:-0}" = "1" ] || { say "$id" "wait"; return; }; set -- -re -stream_loop -1 ;;
    *) say "$id" "wait"; return ;;
  esac
  audio="$(sed -n 's/^AUDIO=\([01]\)$/\1/p' "$f" | head -n 1)"
  vtag="$(sed -n 's/^VTAG=\(hvc1\)$/\1/p' "$f" | head -n 1)"
  d="$C/media/$id"
  rm -rf "${d:?}"; mkdir -p "$d"
  set -- -nostdin -hide_banner -loglevel error "$@" -skip_frame nokey -i "$url" -map 0:v:0 -c:v copy
  [ -n "$vtag" ] && set -- "$@" -tag:v "$vtag"
  if [ "$audio" = "1" ]; then set -- "$@" -map '0:a:0?' -c:a aac -b:a 64k -ac 1; else set -- "$@" -an; fi
  set -- "$@" -f hls -hls_time 2 -hls_list_size 15 -hls_delete_threshold 2 \
    -hls_flags delete_segments+independent_segments+program_date_time+temp_file \
    -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$d/s%d.m4s" "$d/index.m3u8" \
    -map 0:v:0 -an -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\,5)',scale=640:-2" -fps_mode vfr -q:v 7 -f image2 -update 1 -atomic_writing 1 "$d/snap.jpg"
  nice -n 5 "$FF" "$@" </dev/null >/dev/null 2>"$T/e.$id" &
  echo "$!" > "$T/p.$id"
  cksum < "$f" > "$T/s.$id"
  say "$id" "running"
}

while :; do
  [ "$(cksum < "$SELF" 2>/dev/null)" = "$me" ] || { halt_all; exec /bin/sh "$SELF"; }
  now="$(date +%s)"
  for f in "$C"/run/*.env; do
    [ -f "$f" ] || continue
    id="${f##*/}"; id="${id%.env}"
    case "$id" in c[0-9a-f]*) ;; *) continue ;; esac
    case "$id" in *[!0-9a-fc]*) continue ;; esac
    p="$(cat "$T/p.$id" 2>/dev/null)"
    if [ -n "$p" ] && dead "$p"; then
      wait "$p" 2>/dev/null; rm -f "$T/p.$id"; p=""; echo "$now" > "$T/b.$id"; say "$id" "exit"
    fi
    if [ -n "$p" ] && [ "$(cksum < "$f")" != "$(cat "$T/s.$id" 2>/dev/null)" ]; then halt "$id"; p=""; fi
    if [ -z "$p" ]; then
      b="$(cat "$T/b.$id" 2>/dev/null)"
      if [ -z "$b" ] || [ $((now - b)) -ge 10 ]; then rm -f "$T/b.$id"; start "$id"; fi
    fi
  done
  for f in "$T"/p.*; do
    [ -f "$f" ] || continue
    id="${f##*/p.}"
    if [ ! -f "$C/run/$id.env" ]; then halt "$id"; rm -rf "${C:?}/media/${id:?}"; rm -f "$T/b.$id" "$T/e.$id"; say "$id" "idle"; fi
  done
  printf 'alive %s\n' "$now" > "$C/.kameras.state" && mv -f "$C/.kameras.state" "$C/kameras.state"
  sleep 2 & wait $!
done
