#!/bin/sh
# Wächter des Dienstes „umwandeln“ (docs/transcode.md §5). Das Gateway legt diese
# Datei nach /gc-umw/umwandeln.sh (tmpfs-Volume umw-ctl); der Einstieg des
# Dienstes führt sie aus. Der Dienst hat kein Netz und keine Rechte; schreiben
# kann er nur in die Medienordner aus GC_UMW_ROOTS (Compose-Datei, mit „:“
# getrennt) – jeden Pfad prüft der Wächter selbst noch einmal dagegen.
#
# Vom Gateway (nur lesen):  run            Funktion an
#                           conf           TRASH_DAYS, RESERVE_MB, MIN_FREE_GB, MIN_FREE_PCT, VERIFY_DECODE
#                           pause          alles anhalten („jemand schaut“)
#                           jobs/<id>.job  Auftrag (KIND=convert|probe|restore|purge, SRC, REF, ALL, SOFTWARE, QUALITY)
#                           jobs/<id>.pause  diesen Auftrag anhalten
# Vom Wächter:              state/umwandeln.state  alive <Unix-Sekunden>
#                           state/caps, state/roots, state/trash
#                           state/<id>      <Zustand> <Unix-Sekunden> <Code|-> <Prozent> <B/s> <Tempo>
#                           state/<id>.res  Befund (Schlüssel=Wert je Zeile)
# Auftragsdatei weg → Auftrag abgebrochen (ffmpeg beendet, Zwischendatei gelöscht),
# Zustand entfernt. Ein convert-Auftrag zur Zeit; probe/restore/purge sofort.
#
# Umwandeln: nach <Wurzel>/.gc-umwandeln/<id>.part.mkv (gleiches Dateisystem),
# prüfen (ffprobe + einmal dekodieren), dann tauschen: Original als harter Link
# nach <Wurzel>/.gc-papierkorb/<Tag>/<Pfad>, neue Datei per rename(2) auf den
# alten Namen – am Zielort liegt immer eine ganze Datei. Neben dem Original im
# Papierkorb liegt <Datei>.gc-info (id, state=pending|done, at, src, size); damit
# setzt der Wächter nach Abbruch oder Neustart sauber fort.
C="${GC_UMW_DIR:-/gc-umw}"
T="${GC_UMW_TMP:-/tmp}/gc-umw"
FF="${GC_FFMPEG:-ffmpeg}"
FP="${GC_FFPROBE:-ffprobe}"
VI="${GC_VAINFO:-vainfo}"
DEV="${GC_UMW_RENDER:-/dev/dri/renderD128}"
ROOTS="${GC_UMW_ROOTS:-}"
POLL="${GC_UMW_POLL:-2}"
STALL="${GC_UMW_STALL:-900}"
SELF="$C/umwandeln.sh"
S="$C/state"
TRASH=".gc-papierkorb"
WORK=".gc-umwandeln"
umask 022
mkdir -p "$T" "$S" || exit 1
me="$(cksum < "$SELF" 2>/dev/null)"

cur=""; cpid=""; cphase=""; cpaused=0; cstart=0; cprog=0; cprogsize=""
csrc=""; croot=""; cpart=""; cmode=""; cdur=0
ENC=""; SW=0; DEVSTATE="absent"
NICE="nice -n 19"
if ionice -c 3 true 2>/dev/null; then NICE="nice -n 19 ionice -c 3"; fi

now() { date +%s; }
dead() { [ ! -e "/proc/$1" ] || grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }
put() { cat > "$S/.$1.tmp" && mv -f "$S/.$1.tmp" "$S/$1"; }
# say <id> <Zustand> [Code] [Prozent] [B/s] [Tempo]
say() { printf '%s %s %s %s %s %s\n' "$2" "$(now)" "${3:--}" "${4:-0}" "${5:-0}" "${6:-0}" | put "$1"; }
field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
num() { case "$1" in ''|*[!0-9]*) printf '%s\n' "$2" ;; *) printf '%s\n' "$1" ;; esac; }
clean() { tr -d '\000-\010\013-\037\177' | cut -c1-300; }
drop() { for _f in "$@"; do [ -n "$_f" ] && rm -f -- "${_f:?}"; done; }

conf() { # conf <Name> <Standard> <min> <max>
  v="$(num "$(field "$C/conf" "$1")" "$2")"
  [ "$v" -lt "$3" ] && v="$3"
  [ "$v" -gt "$4" ] && v="$4"
  printf '%s\n' "$v"
}

# ─── Pfade ──────────────────────────────────────────────────────────────
root_of() { # die Wurzel aus GC_UMW_ROOTS, unter der $1 liegt
  _p="$1"; _old="$IFS"; IFS=:; set -f
  for _r in $ROOTS; do
    case "$_r" in /*) ;; *) continue ;; esac
    case "$_p" in "$_r"/*) IFS="$_old"; set +f; printf '%s\n' "$_r"; return 0 ;; esac
  done
  IFS="$_old"; set +f; return 1
}
each_root() { printf '%s\n' "$ROOTS" | tr ':' '\n' | grep '^/'; }
root_ok() { [ -d "$1" ] && [ "$(realpath -e -- "$1" 2>/dev/null)" = "$1" ]; }

# check_path <Pfad> <video|mkv>: setzt ROOT oder ERR. Kein Ausbruch aus den Wurzeln,
# kein symbolischer Link an irgendeiner Stelle, nur eine gewöhnliche Datei.
check_path() {
  ERR=""; ROOT=""
  case "$1" in /*) ;; *) ERR=bad_path; return 1 ;; esac
  case "$1" in *[[:cntrl:]]*|*//*|*/./*|*/../*|*/.|*/..) ERR=bad_path; return 1 ;; esac
  case "$1" in */"$TRASH"/*|*/"$WORK"/*) ERR=bad_path; return 1 ;; esac
  ROOT="$(root_of "$1")" || { ERR=outside_roots; return 1; }
  root_ok "$ROOT" || { ERR=root_missing; return 1; }
  if [ -L "$1" ]; then ERR=symlink; return 1; fi
  [ -e "$1" ] || { ERR=not_found; return 1; }
  [ -f "$1" ] || { ERR=not_a_file; return 1; }
  [ "$(realpath -e -- "$1" 2>/dev/null)" = "$1" ] || { ERR=symlink; return 1; }
  _e="$(printf '%s' "${1##*.}" | tr 'A-Z' 'a-z')"
  case "${1##*/}" in *.*) ;; *) _e="" ;; esac
  if [ "$2" = mkv ]; then
    [ "$_e" = mkv ] || { ERR=unsupported_container; return 1; }
  else
    case "$_e" in mkv|mp4|m4v|mov|avi|ts|m2ts|mts|wmv|asf|flv|webm|mpg|mpeg|vob|ogm|divx|3gp) ;; *) ERR=unsupported_type; return 1 ;; esac
  fi
  return 0
}

# ─── ffprobe ────────────────────────────────────────────────────────────
# probe <Datei> <Präfix>: Schlüssel=Wert je Zeile; 1, wenn ffprobe nichts Brauchbares liefert
probe() {
  "$FP" -v error -show_entries 'stream=index,codec_type,codec_name,profile,pix_fmt,width,height,level,r_frame_rate,field_order:stream_disposition=attached_pic:format=duration,format_name:chapter=id' \
    -of default=nw=0 "file:$1" 2>/dev/null | awk -v p="$2" '
    function san(s) { gsub(/[^A-Za-z0-9 ._,\/:+-]/, "", s); return substr(s, 1, 64) }
    function flush() {
      if (t == "video" && pic != "1") { nv++; if (nv == 1) { vc = cn; vp = pr; vx = px; vw = w; vh = h; vl = lv; vf = fo; vr = rf } }
      else if (t == "video") np++
      else if (t == "audio") na++
      else if (t == "subtitle") ns++
      else if (t == "attachment") nt++
      else if (t != "") nd++
    }
    /^\[STREAM\]/ { ins = 1; t = ""; cn = ""; pr = ""; px = ""; w = ""; h = ""; lv = ""; fo = ""; rf = ""; pic = ""; next }
    /^\[\/STREAM\]/ { flush(); ins = 0; next }
    /^\[CHAPTER\]/ { nc++; next }
    /^\[FORMAT\]/ { inf = 1; next }
    /^\[\/FORMAT\]/ { inf = 0; next }
    { i = index($0, "="); if (!i) next; k = substr($0, 1, i - 1); v = substr($0, i + 1) }
    ins && k == "codec_type" { t = v }
    ins && k == "codec_name" { cn = v }
    ins && k == "profile" { pr = v }
    ins && k == "pix_fmt" { px = v }
    ins && k == "width" { w = v }
    ins && k == "height" { h = v }
    ins && k == "level" { lv = v }
    ins && k == "field_order" { fo = v }
    ins && k == "r_frame_rate" { rf = v }
    ins && k == "DISPOSITION:attached_pic" { pic = v }
    inf && k == "duration" { dur = v }
    inf && k == "format_name" { fmt = v }
    END {
      if (dur !~ /^[0-9]+(\.[0-9]+)?$/) exit 1
      bits = 8
      if (match(vx, /p(9|10|12|14|16)(le|be)$/)) { bits = substr(vx, RSTART + 1, RLENGTH - 3) + 0 }
      else if (match(vx, /^p0(10|12|16)/)) { bits = substr(vx, 3, 2) + 0 }
      fps = 0
      n = split(vr, a, "/")
      if (n == 2 && a[2] + 0 > 0) fps = a[1] / a[2]; else if (n == 1) fps = vr + 0
      printf "%scodec=%s\n%sprofile=%s\n%spix_fmt=%s\n%sbits=%d\n", p, san(vc), p, san(vp), p, san(vx), p, bits
      printf "%swidth=%d\n%sheight=%d\n%slevel=%d\n%sfps=%.3f\n%sfield_order=%s\n", p, vw, p, vh, p, vl, p, fps, p, san(vf)
      printf "%svideo=%d\n%saudio=%d\n%ssubtitles=%d\n%sattachments=%d\n%spictures=%d\n%sother=%d\n%schapters=%d\n", p, nv, p, na, p, ns, p, nt, p, np, p, nd, p, nc
      printf "%sduration=%.3f\n%scontainer=%s\n", p, dur, p, san(fmt)
    }'
}

# ─── Fähigkeiten ────────────────────────────────────────────────────────
# Ein kurzer Probelauf je Verfahren: nur was der Treiber wirklich annimmt, steht in enc.
enc_try() {
  timeout 40 "$FF" -hide_banner -nostdin -loglevel error -init_hw_device "vaapi=va:$DEV" -filter_hw_device va \
    -f lavfi -i testsrc2=size=320x240:rate=25:duration=1 -vf format=nv12,hwupload -c:v h264_vaapi -profile:v high "$@" -f null - >/dev/null 2>"$T/enc.err"
}
detect_caps() {
  ENC=""; SW=0; DEVSTATE="absent"
  _gid=""; _mode=""; _drv=""; _vaenc=0
  if [ -e "$DEV" ]; then
    _gid="$(stat -c %g "$DEV" 2>/dev/null)"; _mode="$(stat -c %a "$DEV" 2>/dev/null)"
    if [ -r "$DEV" ] && [ -w "$DEV" ]; then DEVSTATE="ok"; else DEVSTATE="denied"; fi
  fi
  if [ "$DEVSTATE" = ok ]; then
    timeout 30 "$VI" --display drm --device "$DEV" >"$T/vainfo" 2>&1
    _drv="$(sed -n 's/.*Driver version: *//p' "$T/vainfo" | head -n 1 | clean | cut -c1-80)"
    grep -q 'VAProfileH264High.*VAEntrypointEncSlice' "$T/vainfo" && _vaenc=1
    enc_try -rc_mode ICQ -global_quality 23 && ENC="vaapi_icq"
    enc_try -rc_mode QVBR -global_quality 23 -b:v 8M -maxrate 14M -bufsize 16M && ENC="${ENC:+$ENC,}vaapi_qvbr"
  fi
  "$FF" -hide_banner -encoders 2>/dev/null | grep -q 'libx264' && SW=1
  {
    printf 'v=1\nat=%s\n' "$(now)"
    printf 'ffmpeg=%s\n' "$("$FF" -hide_banner -version 2>/dev/null | head -n 1 | awk '{ print $3 }' | clean | cut -c1-40)"
    printf 'uid=%s\ngroups=%s\n' "$(id -u)" "$(id -G)"
    printf 'device=%s\ndevice_path=%s\ndevice_gid=%s\ndevice_mode=%s\n' "$DEVSTATE" "$DEV" "$_gid" "$_mode"
    printf 'driver=%s\nva_h264_enc=%s\nenc=%s\nsoftware=%s\n' "$_drv" "$_vaenc" "$ENC" "$SW"
  } | put caps
}

write_roots() {
  each_root | while IFS= read -r r; do
    st=ok; free=0; total=0
    if ! root_ok "$r"; then st=missing
    else
      [ -w "$r" ] || st='readonly'
      # shellcheck disable=SC2046
      set -- $(df -Pk "$r" 2>/dev/null | awk 'NR == 2 { print $4, $2 }')
      free="$(num "$1" 0)"; total="$(num "$2" 0)"
    fi
    printf '%s\t%s\t%s\t%s\n' "$st" "$free" "$total" "$r"
  done | put roots
}

# ─── Papierkorb ─────────────────────────────────────────────────────────
infos() { # alle .gc-info einer Wurzel
  [ -d "$1/$TRASH" ] && find "$1/$TRASH" -type f -name '*.gc-info' 2>/dev/null
}
find_info() { # find_info <id>: erste .gc-info mit dieser id (über alle Wurzeln)
  each_root | while IFS= read -r r; do
    root_ok "$r" || continue
    infos "$r" | while IFS= read -r i; do
      [ "$(field "$i" id)" = "$1" ] && { printf '%s\n' "$i"; break; }
    done
  done | head -n 1
}
write_info() { # write_info <Datei> <id> <Zustand> <at> <src> <Größe>
  printf 'v=1\nid=%s\nstate=%s\nat=%s\nsrc=%s\nsize=%s\n' "$2" "$3" "$4" "$5" "$6" > "$1.tmp" && mv -f "$1.tmp" "$1"
}
prune_dirs() { [ -d "$1/$TRASH" ] && find "$1/$TRASH" -mindepth 1 -depth -type d -empty -exec rmdir {} \; 2>/dev/null; }

# Angefangenen Tausch zu Ende bringen oder zurücknehmen – nie etwas löschen, das das einzige Exemplar ist.
recover_info() { # recover_info <.gc-info>
  [ "$(field "$1" state)" = pending ] || return 0
  i="$1"; t="${i%.gc-info}"; p="$(field "$i" src)"; id="$(field "$i" id)"
  r="$(root_of "$i")" || return 0
  case "$p" in "$r"/*) ;; *) return 0 ;; esac
  case "$p" in */../*|*/..) return 0 ;; esac
  case "$id" in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  part="$r/$WORK/$id.part.mkv"
  if [ ! -f "$t" ] || [ -L "$t" ]; then drop "$i"; return 0; fi
  if [ -f "$p" ] && [ ! -L "$p" ]; then
    if [ "$p" -ef "$t" ]; then drop "$t" "$i"       # nur der Link war angelegt: Original steht noch am Ort
    else write_info "$i" "$id" 'done' "$(num "$(field "$i" at)" "$(now)")" "$p" "$(field "$i" size)"   # Tausch war fertig
    fi
  elif [ ! -e "$p" ] && [ ! -L "$p" ]; then
    if [ -f "$part" ] && mv -T -- "$part" "$p" 2>/dev/null; then
      write_info "$i" "$id" 'done' "$(num "$(field "$i" at)" "$(now)")" "$p" "$(field "$i" size)"
    else
      mkdir -p "$(dirname "$p")" 2>/dev/null
      mv -T -- "$t" "$p" 2>/dev/null && drop "$i"   # Original zurück an seinen Ort
    fi
  fi
}
recover_all() {
  each_root | while IFS= read -r r; do
    root_ok "$r" || continue
    infos "$r" | while IFS= read -r i; do recover_info "$i"; done
    # liegengebliebene Zwischendateien (nichts läuft gerade)
    [ -d "$r/$WORK" ] && find "$r/$WORK" -maxdepth 1 -type f -name '*.part.mkv' -delete 2>/dev/null
    prune_dirs "$r"
  done
}
write_trash() {
  days="$(conf TRASH_DAYS 14 1 365)"
  each_root | while IFS= read -r r; do
    root_ok "$r" || continue
    infos "$r" | while IFS= read -r i; do
      id="$(field "$i" id)"; at="$(num "$(field "$i" at)" 0)"; p="$(field "$i" src)"
      case "$id" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
      [ -f "${i%.gc-info}" ] || continue
      sz="$(stat -c %s "${i%.gc-info}" 2>/dev/null)"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$(field "$i" state | tr -cd 'a-z')" "$at" "$(num "$sz" 0)" "$((at + days * 86400))" "$p"
    done
  done | head -n 2000 | put trash
}
# Abgelaufene Originale löschen – nur mit lesbarer conf (sonst ist die Frist unbekannt)
sweep() {
  [ -s "$C/conf" ] || return 0
  days="$(conf TRASH_DAYS 14 1 365)"; n="$(now)"
  each_root | while IFS= read -r r; do
    root_ok "$r" || continue
    infos "$r" | while IFS= read -r i; do
      [ "$(field "$i" state)" = 'done' ] || continue
      at="$(num "$(field "$i" at)" "$n")"
      [ $((at + days * 86400)) -le "$n" ] && drop "${i%.gc-info}" "$i"
    done
    prune_dirs "$r"
  done
  write_trash
}

# ─── kurze Aufträge ─────────────────────────────────────────────────────
job_probe() { # job_probe <id> <Auftragsdatei>
  src="$(field "$2" SRC)"
  check_path "$src" video || { say "$1" failed "$ERR"; return; }
  if probe "$src" "src_" > "$T/q.res"; then
    {
      cat "$T/q.res"
      printf 'src_size=%s\n' "$(stat -c %s "$src" 2>/dev/null)"
      printf 'free_kb=%s\n' "$(df -Pk "$ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    } | put "$1.res"
    say "$1" 'done'
  else say "$1" failed probe_failed
  fi
}
job_restore() { # Original aus dem Papierkorb zurück an seinen Ort (die neue Datei wird ersetzt)
  ref="$(field "$2" REF)"
  case "$ref" in ''|*[!A-Za-z0-9_-]*) say "$1" failed bad_request; return ;; esac
  [ "$ref" = "$cur" ] && { say "$1" failed busy; return; }
  i="$(find_info "$ref")"
  [ -n "$i" ] || { say "$1" failed not_in_trash; return; }
  recover_info "$i"
  [ -f "$i" ] || { say "$1" failed not_in_trash; return; }
  t="${i%.gc-info}"; p="$(field "$i" src)"
  r="$(root_of "$i")" || { say "$1" failed outside_roots; return; }
  case "$p" in "$r"/*) ;; *) say "$1" failed outside_roots; return ;; esac
  case "$p" in *[[:cntrl:]]*|*//*|*/./*|*/../*|*/.|*/..|*/"$TRASH"/*|*/"$WORK"/*) say "$1" failed bad_path; return ;; esac
  if [ ! -f "$t" ] || [ -L "$t" ]; then say "$1" failed not_in_trash; return; fi
  d="$(dirname "$p")"
  mkdir -p "$d" 2>/dev/null
  [ "$(realpath -e -- "$d" 2>/dev/null)" = "$d" ] || { say "$1" failed symlink; return; }
  if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then say "$1" failed not_a_file; return; fi
  if mv -T -f -- "$t" "$p" 2>/dev/null; then
    drop "$i"; prune_dirs "$r"
    printf 'restored=%s\n' "$p" | put "$1.res"
    write_trash; write_roots
    say "$1" 'done'
  else say "$1" failed restore_failed
  fi
}
job_purge() { # ein Original (REF) oder alle (ALL=1) endgültig löschen
  ref="$(field "$2" REF)"; all="$(field "$2" ALL)"
  if [ "$all" = 1 ]; then
    each_root | while IFS= read -r r; do
      root_ok "$r" || continue
      infos "$r" | while IFS= read -r i; do
        [ "$(field "$i" state)" = 'done' ] && drop "${i%.gc-info}" "$i"
      done
      prune_dirs "$r"
    done
  else
    case "$ref" in ''|*[!A-Za-z0-9_-]*) say "$1" failed bad_request; return ;; esac
    i="$(find_info "$ref")"
    [ -n "$i" ] || { say "$1" failed not_in_trash; return; }
    recover_info "$i"
    [ "$(field "$i" state)" = 'done' ] || { say "$1" failed not_in_trash; return; }
    r="$(root_of "$i")"
    drop "${i%.gc-info}" "$i"
    [ -n "$r" ] && prune_dirs "$r"
  fi
  write_trash; write_roots
  say "$1" 'done'
}

# ─── Umwandeln ──────────────────────────────────────────────────────────
res_val() { field "$T/c.res" "$1"; }
fail() { # fail <Code>: Zwischendatei weg, Protokoll-Ende in den Befund
  drop "$cpart"
  {
    cat "$T/c.res" 2>/dev/null
    printf 'mode=%s\n' "$cmode"
    tail -n 20 "$T/err" 2>/dev/null | clean | sed 's/^/log=/'
  } | put "$cur.res"
  say "$cur" failed "$1"
  cur=""; cpid=""; cphase=""; cpaused=0; cpart=""
}
finish() { # finish <Papierkorb-Pfad>
  {
    cat "$T/c.res"
    printf 'mode=%s\nseconds=%s\ntrash=%s\n' "$cmode" "$(($(now) - cstart))" "$1"
  } | put "$cur.res"
  write_trash; write_roots
  say "$cur" 'done' - 100
  cur=""; cpid=""; cphase=""; cpaused=0; cpart=""
}

begin() { # begin <id> <Auftragsdatei>
  cur="$1"; cpid=""; cphase=""; cpaused=0; cstart="$(now)"; cmode=""; cpart=""
  : > "$T/c.res"; : > "$T/err"
  csrc="$(field "$2" SRC)"
  # schon getauscht (Neustart nach dem Tausch)? Dann ist der Auftrag fertig.
  i="$(find_info "$cur")"
  if [ -n "$i" ]; then
    recover_info "$i"
    if [ "$(field "$i" state)" = 'done' ]; then printf 'resumed=1\n' > "$T/c.res"; finish "${i%.gc-info}"; return; fi
  fi
  check_path "$csrc" mkv || { fail "$ERR"; return; }
  croot="$ROOT"
  probe "$csrc" "src_" > "$T/c.res" || { : > "$T/c.res"; fail probe_failed; return; }
  ssize="$(stat -c %s "$csrc" 2>/dev/null)"; smtime="$(stat -c %Y "$csrc" 2>/dev/null)"
  printf 'src_size=%s\nsrc_mtime=%s\n' "$ssize" "$smtime" >> "$T/c.res"
  [ "$(res_val src_video)" -ge 1 ] 2>/dev/null || { fail no_video; return; }
  w="$croot/$WORK"
  mkdir -p "$w" 2>/dev/null && { [ -f "$w/.ignore" ] || : > "$w/.ignore"; } 2>/dev/null
  if [ ! -d "$w" ] || [ ! -w "$w" ] || [ -L "$w" ]; then fail not_writable; return; fi
  [ "$(stat -c %d "$w")" = "$(stat -c %d "$(dirname "$csrc")")" ] || { fail cross_device; return; }
  # Platz: Quelle × 1,2 + RESERVE_MB (2 GB), danach noch MIN_FREE_GB und MIN_FREE_PCT frei
  # shellcheck disable=SC2046
  set -- "$2" $(df -Pk "$w" 2>/dev/null | awk 'NR == 2 { print $4, $2 }')
  free="$(num "$2" 0)"; total="$(num "$3" 0)"
  need=$((ssize / 1024 * 12 / 10 + $(conf RESERVE_MB 2048 0 1000000) * 1024))
  mingb="$(conf MIN_FREE_GB 20 0 100000)"; minpct="$(conf MIN_FREE_PCT 5 0 90)"
  if [ "$free" -lt $((need + mingb * 1048576)) ] || [ $((free - need)) -lt $((total / 100 * minpct)) ]; then
    printf 'free_kb=%s\nneed_kb=%s\n' "$free" "$need" >> "$T/c.res"; fail no_space; return
  fi
  q="$(num "$(field "$1" QUALITY)" 23)"; [ "$q" -lt 16 ] && q=16; [ "$q" -gt 32 ] && q=32
  case "$ENC" in
    vaapi_icq*) cmode=vaapi_icq ;;
    vaapi_qvbr*) cmode=vaapi_qvbr ;;
    *) if [ "$(field "$1" SOFTWARE)" = 1 ] && [ "$SW" = 1 ]; then cmode=software
       elif [ "$DEVSTATE" = absent ]; then fail no_device; return
       elif [ "$DEVSTATE" = denied ]; then fail device_denied; return
       else fail no_encoder; return
       fi ;;
  esac
  cdur="$(res_val src_duration)"
  gop="$(awk -v f="$(res_val src_fps)" 'BEGIN { g = int(f * 2 + 0.5); if (g < 10 || g > 600) g = 100; print g }')"
  level=""
  [ "$(res_val src_width)" -le 1920 ] && [ "$(res_val src_height)" -le 1088 ] && level="4.2"
  cpart="$w/$cur.part.mkv"
  drop "$cpart"
  set -- -hide_banner -nostdin -nostats -loglevel error -progress "$T/prog" -stats_period 5
  [ "$cmode" = software ] || set -- "$@" -init_hw_device "vaapi=va:$DEV" -filter_hw_device va
  set -- "$@" -threads 3 -i "file:$csrc" -map 0:V:0 -map '0:a?' -map '0:s?' -map '0:t?' -map_chapters 0 -map_metadata 0 -c copy
  case "$cmode" in
    software) set -- "$@" -c:v:0 libx264 -preset veryfast -crf "$q" -pix_fmt yuv420p ;;
    *) set -- "$@" -c:v:0 h264_vaapi -vf format=nv12,hwupload ;;
  esac
  set -- "$@" -profile:v high
  [ -n "$level" ] && set -- "$@" -level "$level"
  set -- "$@" -bf 2 -g "$gop"
  case "$cmode" in
    vaapi_icq) set -- "$@" -rc_mode ICQ -global_quality "$q" ;;
    vaapi_qvbr) set -- "$@" -rc_mode QVBR -global_quality "$q" -b:v 8M -maxrate 14M -bufsize 16M ;;
  esac
  set -- "$@" -max_muxing_queue_size 4096 -f matroska "file:$cpart"
  : > "$T/prog"
  # shellcheck disable=SC2086
  $NICE "$FF" "$@" </dev/null >/dev/null 2>"$T/err" &
  cpid="$!"; cphase=encode; cprog="$(now)"; cprogsize=""
  say "$cur" running - 0
}

verify() { # ffprobe-Vergleich Original/Neu, dann einmal ganz dekodieren (im Hintergrund)
  probe "$cpart" "new_" > "$T/n.res" || { fail verify_probe; return; }
  nsize="$(stat -c %s "$cpart" 2>/dev/null)"
  { cat "$T/n.res"; printf 'new_size=%s\n' "$nsize"; } >> "$T/c.res"
  [ "$(res_val new_codec)" = h264 ] || { fail verify_codec; return; }
  [ "$(res_val new_bits)" = 8 ] || { fail verify_bits; return; }
  [ "$(res_val new_video)" = 1 ] || { fail verify_streams; return; }
  for k in audio subtitles attachments; do
    [ "$(res_val "new_$k")" = "$(res_val "src_$k")" ] || { fail verify_streams; return; }
  done
  [ "$(res_val new_chapters)" = "$(res_val src_chapters)" ] || { fail verify_chapters; return; }
  if [ "$(res_val new_width)" != "$(res_val src_width)" ] || [ "$(res_val new_height)" != "$(res_val src_height)" ]; then fail verify_size; return; fi
  awk -v a="$(res_val new_duration)" -v b="$(res_val src_duration)" 'BEGIN { x = a - b; if (x < 0) x = -x; exit !(x <= 0.6) }' || { fail verify_duration; return; }
  # nicht leer und nicht absurd klein (unter 2 % des Originals)
  [ "$(num "$nsize" 0)" -gt $(($(num "$(res_val src_size)" 0) / 50)) ] || { fail verify_small; return; }
  if [ "$(conf VERIFY_DECODE 1 0 1)" = 0 ]; then swap; return; fi
  set -- -hide_banner -nostdin -nostats -loglevel error -xerror
  [ "$cmode" = software ] || set -- "$@" -hwaccel vaapi -hwaccel_device "$DEV" -hwaccel_output_format vaapi
  set -- "$@" -i "file:$cpart" -map 0:v:0 -f null -
  # shellcheck disable=SC2086
  $NICE "$FF" "$@" </dev/null >/dev/null 2>"$T/err" &
  cpid="$!"; cphase=verify; cprog="$(now)"
  say "$cur" verifying - 99
}

swap() {
  # Die Quelle darf sich während des Umwandelns nicht geändert haben.
  check_path "$csrc" mkv || { fail "$ERR"; return; }
  if [ "$(stat -c %s "$csrc")" != "$(res_val src_size)" ] || [ "$(stat -c %Y "$csrc")" != "$(res_val src_mtime)" ]; then fail source_changed; return; fi
  base="$croot/$TRASH"
  mkdir -p "$base" 2>/dev/null && { [ -f "$base/.ignore" ] || : > "$base/.ignore"; } 2>/dev/null
  if [ ! -d "$base" ] || [ -L "$base" ]; then fail not_writable; return; fi
  [ "$(stat -c %d "$base")" = "$(stat -c %d "$croot/$WORK")" ] || { fail cross_device; return; }
  rel="${csrc#"$croot"/}"; day="$(date +%Y-%m-%d)"
  tp="$base/$day/$rel"; tn=2
  while [ -e "$tp" ] || [ -e "$tp.gc-info" ]; do
    tp="$base/${day}_$tn/$rel"; tn=$((tn + 1))
    [ "$tn" -gt 99 ] && { fail trash_failed; return; }
  done
  mkdir -p "$(dirname "$tp")" 2>/dev/null || { fail trash_failed; return; }
  chmod --reference="$csrc" "$cpart" 2>/dev/null
  sync -d "$cpart" 2>/dev/null
  at="$(now)"
  write_info "$tp.gc-info" "$cur" pending "$at" "$csrc" "$(res_val src_size)" || { fail trash_failed; return; }
  if ln -- "$csrc" "$tp" 2>/dev/null; then
    # der alte Name zeigt bis zum rename(2) auf das Original, danach auf die neue Datei
    mv -T -f -- "$cpart" "$csrc" 2>/dev/null || { drop "$tp" "$tp.gc-info"; fail swap_failed; return; }
  else
    # Dateisystem ohne harte Links: zwei Umbenennungen; die .gc-info (pending) trägt den Wiederanlauf
    mv -T -- "$csrc" "$tp" 2>/dev/null || { drop "$tp.gc-info"; fail trash_failed; return; }
    if ! mv -T -- "$cpart" "$csrc" 2>/dev/null; then
      mv -T -- "$tp" "$csrc" 2>/dev/null && drop "$tp.gc-info"
      fail swap_failed; return
    fi
  fi
  write_info "$tp.gc-info" "$cur" 'done' "$at" "$csrc" "$(res_val src_size)"
  sync -f "$csrc" 2>/dev/null
  finish "$tp"
}

stop_current() { # ffmpeg beenden (10 s Zeit), Zwischendatei weg
  if [ -n "$cpid" ]; then
    kill -CONT "$cpid" 2>/dev/null; kill -TERM "$cpid" 2>/dev/null
    k=0
    while ! dead "$cpid" && [ "$k" -lt 100 ]; do sleep 0.1; k=$((k + 1)); done
    dead "$cpid" || kill -KILL "$cpid" 2>/dev/null
    wait "$cpid" 2>/dev/null
  fi
  drop "$cpart"
  cpid=""; cphase=""; cpaused=0; cpart=""
}

progress() {
  us="$(sed -n 's/^out_time_us=\([0-9][0-9]*\)$/\1/p' "$T/prog" 2>/dev/null | tail -n 1)"
  fps="$(sed -n 's/^fps=\([0-9.][0-9.]*\)$/\1/p' "$T/prog" 2>/dev/null | tail -n 1)"
  sp="$(sed -n 's/^speed= *\([0-9.][0-9.]*\)x$/\1/p' "$T/prog" 2>/dev/null | tail -n 1)"
  pct="$(awk -v u="$(num "$us" 0)" -v d="$cdur" 'BEGIN { p = d > 0 ? int(u / 10000 / d) : 0; if (p > 98) p = 98; if (p < 0) p = 0; print p }')"
  sz="$(stat -c %s "$T/prog" 2>/dev/null)"
  if [ "$sz" != "$cprogsize" ]; then cprogsize="$sz"; cprog="$(now)"; fi
  say "$cur" running - "$pct" "${fps:-0}" "${sp:-0}"
}

manage() { # der laufende convert-Auftrag
  if [ ! -f "$C/jobs/$cur.job" ] || [ ! -f "$C/run" ]; then
    stop_current; drop "$S/$cur" "$S/$cur.res"; cur=""; return
  fi
  [ -n "$cpid" ] || return
  if [ -f "$C/pause" ] || [ -f "$C/jobs/$cur.pause" ]; then
    if [ "$cpaused" = 0 ]; then kill -STOP "$cpid" 2>/dev/null; cpaused=1; fi
    dead "$cpid" || { say "$cur" paused; cprog="$(now)"; return; }
  elif [ "$cpaused" = 1 ]; then kill -CONT "$cpid" 2>/dev/null; cpaused=0; cprog="$(now)"
  fi
  if dead "$cpid"; then
    wait "$cpid" 2>/dev/null; rc=$?
    cpid=""
    if [ "$cphase" = encode ]; then
      if [ "$rc" = 0 ] && [ -s "$cpart" ]; then verify; else fail encode_failed; fi
    elif [ "$rc" = 0 ]; then swap
    else fail verify_decode
    fi
    return
  fi
  if [ "$cphase" = encode ]; then progress; else say "$cur" verifying - 99; fi
  if [ "$cphase" = encode ] && [ $(($(now) - cprog)) -gt "$STALL" ]; then stop_current; fail stalled; fi
}

trap 'stop_current; exit 0' TERM INT

printf 'alive %s\n' "$(now)" | put umwandeln.state
recover_all
detect_caps
write_roots
sweep
last_roots="$(now)"; last_sweep="$(now)"

while :; do
  # neue Fassung vom Gateway: erst wechseln, wenn nichts läuft
  if [ -z "$cur" ] && [ -s "$SELF" ] && [ "$(cksum < "$SELF" 2>/dev/null)" != "$me" ]; then exec /bin/sh "$SELF"; fi
  n="$(now)"
  [ -n "$cur" ] && manage
  if [ -f "$C/run" ]; then
    for f in "$C"/jobs/*.job; do
      [ -f "$f" ] || continue
      id="${f##*/}"; id="${id%.job}"
      case "$id" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
      [ "$id" = "$cur" ] && continue
      st="$(cut -d' ' -f1 "$S/$id" 2>/dev/null)"
      case "$st" in done|failed) continue ;; esac
      case "$(field "$f" KIND)" in
        probe) job_probe "$id" "$f" ;;
        restore) job_restore "$id" "$f" ;;
        purge) job_purge "$id" "$f" ;;
        convert)
          if [ -n "$cur" ]; then [ "$st" = queued ] || say "$id" queued
          elif [ -f "$C/pause" ] || [ -f "$C/jobs/$id.pause" ]; then say "$id" paused
          else begin "$id" "$f"
          fi ;;
        *) say "$id" failed bad_request ;;
      esac
    done
  fi
  # Zustände ohne Auftragsdatei aufräumen
  for f in "$S"/*; do
    [ -f "$f" ] || continue
    id="${f##*/}"; id="${id%.res}"
    case "$id" in umwandeln.state|caps|roots|trash) continue ;; esac
    [ "$id" = "$cur" ] && continue
    [ -f "$C/jobs/$id.job" ] || drop "$f"
  done
  if [ $((n - last_roots)) -ge 30 ]; then write_roots; last_roots="$n"; fi
  if [ $((n - last_sweep)) -ge 3600 ]; then sweep; last_sweep="$n"; fi
  printf 'alive %s\n' "$n" | put umwandeln.state
  sleep "$POLL" & wait $!
done
