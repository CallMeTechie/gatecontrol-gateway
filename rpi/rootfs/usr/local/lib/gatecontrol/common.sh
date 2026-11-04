# shellcheck shell=bash
# GateControl Gateway (Raspberry-Pi-Image) — gemeinsame Helfer.
# Wird von /usr/local/sbin/gatecontrol-* eingebunden.

GC_DIR="${GC_DIR:-/opt/gatecontrol-gateway}"
GC_RUN="${GC_RUN:-/run/gatecontrol}"
if [ -z "${GC_BOOT:-}" ]; then
  if [ -f /boot/firmware/config.txt ]; then GC_BOOT=/boot/firmware; else GC_BOOT=/boot; fi
fi
GC_BOOT_DIR="${GC_BOOT_DIR:-$GC_BOOT/gatecontrol}"
GC_SETTINGS="${GC_SETTINGS:-$GC_BOOT_DIR/settings.txt}"
# Überschreibbar nur für die Tests (rpi/tests/)
GC_ETC="${GC_ETC:-/etc}"
GC_ISSUE_DIR="${GC_ISSUE_DIR:-/run/issue.d}"

gc_log() { printf 'GateControl: %s\n' "$*"; }

# gc_setting KEY [DEFAULT] — Wert aus settings.txt (KEY=VALUE, # = Kommentar,
# Windows-Zeilenenden, UTF-8-BOM und Anführungszeichen werden toleriert).
gc_setting() {
  local key="$1" def="${2:-}" val=""
  if [ -r "$GC_SETTINGS" ]; then
    val="$(tr -d '\r' <"$GC_SETTINGS" | sed -e '1s/^\xEF\xBB\xBF//' \
      | sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" | tail -n1 \
      | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  fi
  printf '%s' "${val:-$def}"
}

# gc_setting_raw KEY — Wert genau so, wie er hinter "KEY=" steht (letzte
# Fundstelle; nur Zeilenende-CR und BOM werden entfernt, sonst nichts – für
# WLAN-Name/-Passwort, die Leerzeichen und Anführungszeichen enthalten dürfen).
# Rückgabe 1, wenn der Schlüssel fehlt (unterscheidet "fehlt" von "leer").
gc_setting_raw() {
  local key="$1" line val="" rc=1
  [ -r "$GC_SETTINGS" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#$'\xEF\xBB\xBF'}"
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == "$key="* ]]; then
      val="${line#"$key="}"
      rc=0
    fi
  done <"$GC_SETTINGS"
  printf '%s' "$val"
  return "$rc"
}

# gc_env_value FILE KEY — Wert einer KEY=VALUE-Zeile (erste Fundstelle).
gc_env_value() {
  sed -n "s/^${2}=//p" "$1" 2>/dev/null | head -n1 | tr -d '\r'
}

# gc_status STATE TEXT — Status für Konsole, Login-Hinweis, MOTD und die
# Boot-Partition (STATUS.txt, nur bei Änderung geschrieben, ohne Geheimnisse).
gc_status() {
  local state="$1"; shift
  local text="$*"
  gc_log "$text"
  install -d -m 0755 "$GC_RUN" "$GC_ISSUE_DIR" 2>/dev/null || true
  printf '%s\n%s\n' "$state" "$text" >"$GC_RUN/status"
  printf '\n  GateControl Gateway: %s\n  %s\n\n' "$state" "$text" >"$GC_ISSUE_DIR/50-gatecontrol.issue" 2>/dev/null || true
  command -v agetty >/dev/null 2>&1 && agetty --reload >/dev/null 2>&1 || true
  if [ -d "$GC_BOOT_DIR" ]; then
    local new settings=""
    # Ergebnis von gatecontrol-settings (WLAN, Zeitzone, SSH; ohne Geheimnisse)
    if [ -s "$GC_RUN/settings.status" ]; then
      settings="
Einstellungen (settings.txt):
$(sed 's/^/  - /' "$GC_RUN/settings.status")"
    fi
    new="GateControl Gateway — Status: ${state}
${text}${settings}
Hostname: $(hostname)
Ausführliches Protokoll: journalctl -u gatecontrol-gateway -u gatecontrol-settings -b"
    if [ "$(cat "$GC_BOOT_DIR/STATUS.txt" 2>/dev/null)" != "$new" ]; then
      printf '%s\n' "$new" >"$GC_BOOT_DIR/STATUS.txt" 2>/dev/null && sync -f "$GC_BOOT_DIR/STATUS.txt" 2>/dev/null || true
    fi
  fi
}
