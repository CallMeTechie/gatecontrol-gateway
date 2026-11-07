#!/bin/sh
# Wächter des Dienstes „office“ (docs/print.md „Office-Dateien“). Das Gateway
# legt diese Datei nach /gc-office/office.sh (Volume office-ctl); der Einstieg
# des Dienstes führt sie aus. Solange /gc-office/run da ist, wandelt er jede
# Datei in/<id>.<ext> mit dem Auftrag in/<id>.go (Inhalt: die Endung) mit
# LibreOffice (ohne Netz, ohne Makros) in ein PDF: out/<id>.pdf + out/<id>.done,
# sonst out/<id>.err (Grund). Ein Auftrag nach dem anderen, höchstens 180 s.
# Ändert das Gateway diese Datei, startet sich der Wächter neu.
# Zustand: office.state (running|idle <Unix-Sekunden>).
C="${GC_OFFICE_DIR:-/gc-office}"
T="${GC_OFFICE_TMP:-/tmp}/gc-office"
SO="${GC_SOFFICE:-soffice}"
LIMIT="${GC_OFFICE_LIMIT:-180}"
SELF="$C/office.sh"
mkdir -p "$T" "$C/in" "$C/out" || exit 1
me="$(cksum < "$SELF" 2>/dev/null)"

say() { printf '%s %s\n' "$1" "$(date +%s)" > "$C/.office.state" && mv -f "$C/.office.state" "$C/office.state"; }
trap 'say idle; exit 0' TERM INT

convert() {
  id="$1"; ext="$2"
  src="$C/in/$id.$ext"
  w="$T/w.$id"
  rm -rf "$w"; mkdir -p "$w"
  # eigenes Profil je Lauf (tmpfs): kein Zustand zwischen zwei Dateien
  if [ -f "$src" ] && timeout -s KILL "$LIMIT" nice -n 10 "$SO" --headless --norestore --nologo --nolockcheck --nodefault \
      "-env:UserInstallation=file://$w/profile" --convert-to pdf --outdir "$w" "$src" </dev/null >"$T/log" 2>&1 \
      && [ -s "$w/$id.pdf" ]; then
    mv -f "$w/$id.pdf" "$C/out/.$id.pdf" && mv -f "$C/out/.$id.pdf" "$C/out/$id.pdf" && : > "$C/out/$id.done"
  else
    rc=$?
    reason="failed"
    [ "$rc" = 137 ] && reason="timeout"
    [ -f "$src" ] || reason="missing"
    printf '%s\n' "$reason" > "$C/out/.$id.err" && mv -f "$C/out/.$id.err" "$C/out/$id.err"
  fi
  rm -rf "$w"
  rm -f "$src" "$C/in/$id.go"
}

while :; do
  [ "$(cksum < "$SELF" 2>/dev/null)" = "$me" ] || exec /bin/sh "$SELF"
  if [ -f "$C/run" ]; then
    say running
    for go in "$C"/in/*.go; do
      [ -f "$go" ] || continue
      id="${go##*/}"; id="${id%.go}"
      case "$id" in ''|*[!A-Za-z0-9_-]*) rm -f "$go"; continue ;; esac
      ext="$(head -c 8 "$go" | tr -cd 'a-z')"
      case "$ext" in
        docx|xlsx|pptx|odt|ods|odp|rtf|doc|xls|ppt) convert "$id" "$ext"; say running ;;
        *) printf 'type\n' > "$C/out/$id.err"; rm -f "$go" ;;
      esac
    done
  else
    say idle
  fi
  sleep 1 & wait $!
done
