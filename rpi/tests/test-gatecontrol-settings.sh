#!/bin/bash
# Tests für rpi/rootfs/usr/local/sbin/gatecontrol-settings (settings.txt:
# Zeitzone, WLAN, SSH). systemctl, raspi-config, nmcli, rfkill, iw, modprobe,
# useradd/usermod/getent, hostname und agetty sind Stubs; alle Pfade liegen
# in einem Temp-Verzeichnis. Echt benutzt werden ssh-keygen (Schlüssel werden
# zur Laufzeit erzeugt – keine schlüsselähnlichen Dateien im Repo) und, falls
# vorhanden, visudo.
#
# Ist ein nmcli mit "--offline" verfügbar (PATH oder GC_TEST_NMCLI), wird
# die erzeugte WLAN-Verbindung zusätzlich von NetworkManagers eigenem
# Keyfile-Parser gelesen und mit einer von nmcli selbst erzeugten Verbindung
# verglichen (SSID-Bytes und PSK müssen übereinstimmen).
#
# Braucht root (install -o / chown), in CI daher mit sudo aufrufen.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOTFS="$HERE/../rootfs"
SETTINGS="$ROOTFS/usr/local/sbin/gatecontrol-settings"

pass=0
failed=0
ok()   { echo "  ok    $*"; pass=$((pass + 1)); }
bad()  { echo "  FEHLER $*"; failed=$((failed + 1)); }
expect() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
not() { ! "$@"; }
has()  { grep -qF -- "$2" "$1"; }   # has DATEI TEXT (wörtlich)
hasx() { grep -qxF -- "$2" "$1"; }  # ganze Zeile

command -v ssh-keygen >/dev/null || { echo "ssh-keygen fehlt (openssh-client)" >&2; exit 1; }

NMCLI="${GC_TEST_NMCLI:-}"
if [ -n "$NMCLI" ]; then   # ausdrücklich vorgegeben (CI): muss funktionieren
  "$NMCLI" --offline connection add type wifi con-name t ssid t >/dev/null \
    || { echo "GC_TEST_NMCLI=$NMCLI kann kein --offline" >&2; exit 1; }
elif command -v nmcli >/dev/null && nmcli --offline connection add type wifi con-name t ssid t >/dev/null 2>&1; then
  NMCLI=nmcli
fi

setup() {
  T="$(mktemp -d)"
  mkdir -p "$T/bin" "$T/boot/gatecontrol" "$T/run" "$T/etc" "$T/issue" "$T/home" \
    "$T/var/lib/NetworkManager" "$T/var/lib/systemd/rfkill" "$T/zoneinfo/Europe" "$T/zoneinfo/Etc"
  : >"$T/calls.log"
  : >"$T/passwd"
  echo "console=tty1 root=PARTUUID=x" >"$T/proc-cmdline"
  printf '[main]\nWirelessEnabled=false\n' >"$T/var/lib/NetworkManager/NetworkManager.state"
  echo 1 >"$T/var/lib/systemd/rfkill/platform-fe300000.mmcnr:wlan"
  for z in Europe/Berlin Europe/Vienna Etc/UTC; do printf 'TZif2-Dummy' >"$T/zoneinfo/$z"; done
  printf 'AT\tAustria\nCH\tSwitzerland\nDE\tGermany\nUS\tUnited States\n' >"$T/zoneinfo/iso3166.tab"
  echo gc-test >"$T/hostname"
  # Stubs: protokollieren nur
  for c in raspi-config nmcli rfkill iw modprobe usermod timedatectl agetty; do
    printf '#!/bin/sh\necho "%s $*" >>"%s/calls.log"\n' "$c" "$T" >"$T/bin/$c"
  done
  cat >"$T/bin/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >>"$T/calls.log"
case "\$1" in is-active) exit 3 ;; esac
exit 0
EOF
  cat >"$T/bin/useradd" <<EOF
#!/bin/sh
echo "useradd \$*" >>"$T/calls.log"
for last; do :; done
echo "\$last:x:1001:1001:GateControl Admin:$T/home/\$last:/bin/bash" >>"$T/passwd"
mkdir -p "$T/home/\$last"
EOF
  cat >"$T/bin/getent" <<EOF
#!/bin/sh
[ "\$1" = passwd ] || exit 0
grep "^\$2:" "$T/passwd"
EOF
  cat >"$T/bin/hostname" <<EOF
#!/bin/sh
cat "$T/hostname"
EOF
  chmod +x "$T/bin/"*
}

run_settings() {
  PATH="$T/bin:$PATH" GC_LIB="$ROOTFS/usr/local/lib/gatecontrol" GC_BOOT="$T/boot" GC_RUN="$T/run" \
    GC_ETC="$T/etc" GC_ISSUE_DIR="$T/issue" GC_VARLIB="$T/var/lib" GC_ZONEINFO="$T/zoneinfo" \
    GC_PROC_CMDLINE="$T/proc-cmdline" bash "$SETTINGS" >"$T/out.log" 2>&1
}

S() { echo "$T/boot/gatecontrol/settings.txt"; }
NMC() { echo "$T/etc/NetworkManager/system-connections/gatecontrol-wifi.nmconnection"; }
AK() { echo "$T/home/gcadmin/.ssh/authorized_keys"; }
newkey() {  # newkey TYP [BITS] → Public-Key-Zeile
  local f="$T/key-$RANDOM"
  ssh-keygen -q -t "$1" ${2:+-b "$2"} -N '' -C "admin@pc" -f "$f"
  cat "$f.pub"
}
# Kein Geheimnis in Ausgaben, Status oder auf der Boot-Partition
no_leak() { ! grep -rqF -- "$1" "$T/out.log" "$T/run" "$T/issue" "$T/boot"; }

# NetworkManager selbst liest die Datei: SSID-Bytes und PSK müssen der
# Verbindung entsprechen, die nmcli aus denselben Rohwerten erzeugt.
nm_roundtrip() {  # nm_roundtrip SSID PSK
  local ours ref
  ours="$("$NMCLI" --offline connection modify connection.autoconnect yes <"$(NMC)" | grep -E '^(ssid|psk)=')" || return 1
  ref="$("$NMCLI" --offline connection add type wifi con-name x ssid "$1" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$2" | grep -E '^(ssid|psk)=')" || return 1
  [ "$ours" = "$ref" ] || { printf 'NM liest:\n%s\nerwartet:\n%s\n' "$ours" "$ref"; return 1; }
}

SSID='Café;Netz 1'
SSID_BYTES='67;97;102;195;169;59;78;101;116;122;32;49;'
# shellcheck disable=SC2016  # $(x) ist Teil des Testpassworts
PSK=' pa\ss;w"o'"'"'rd#1 $(x) '   # Leerzeichen vorn/hinten, \ ; " ' # $( )
# shellcheck disable=SC2016
PSK_FILE='\spa\\ss;w"o'"'"'rd#1\s$(x)\s'

echo "== ohne settings.txt"
setup
expect "Exit 0" run_settings
expect "keine WLAN-Verbindung" test ! -e "$(NMC)"
expect "kein Aufruf von raspi-config/useradd" not grep -qE 'raspi-config|useradd' "$T/calls.log"
rm -rf "$T"

echo "== Erststart: alles gesetzt (BOM, CRLF, Sonderzeichen)"
setup
KEY="$(newkey ed25519)"
{
  printf '\xEF\xBB\xBFTIMEZONE=Europe/Vienna\r\n'
  printf '# Kommentar\r\nZIGBEE=off\r\nHOSTNAME=mein-gw\r\n'
  printf 'WIFI_SSID=%s\r\n' "$SSID"
  printf 'WIFI_PSK=%s\r\n' "$PSK"
  printf 'WIFI_COUNTRY=at\r\nWIFI_HIDDEN=1\r\n'
  printf 'SSH_AUTHORIZED_KEY=%s\r\n' "$KEY"
} >"$(S)"
expect "Exit 0" run_settings
expect "Zeitzone (BOM in Zeile 1 ignoriert)" test "$(readlink "$T/etc/localtime")" = "$T/zoneinfo/Europe/Vienna"
expect "/etc/timezone" hasx "$T/etc/timezone" "Europe/Vienna"
expect "WLAN-Datei 0600" test "$(stat -c %a "$(NMC)")" = 600
expect "WLAN-Datei root" test "$(stat -c %U "$(NMC)")" = root
expect "id=gatecontrol-wifi" hasx "$(NMC)" "id=gatecontrol-wifi"
expect "SSID als Byte-Liste (; Leerzeichen Umlaut)" hasx "$(NMC)" "ssid=$SSID_BYTES"
expect "verstecktes Netz" hasx "$(NMC)" "hidden=true"
expect "wpa-psk" hasx "$(NMC)" "key-mgmt=wpa-psk"
expect "PSK escaped (\\\\ und \\s, ; bleibt)" hasx "$(NMC)" "psk=$PSK_FILE"
expect "LAN hat Vorrang (Metrik 600)" test "$(grep -c '^route-metric=600$' "$(NMC)")" = 2
if [ -n "$NMCLI" ]; then
  expect "NetworkManager liest SSID und PSK exakt" nm_roundtrip "$SSID" "$PSK"
else
  echo "  (übersprungen: kein nmcli mit --offline – NetworkManager-Parser-Test)"
fi
expect "Funkland per raspi-config" hasx "$T/calls.log" "raspi-config nonint do_wifi_country AT"
expect "cfg80211 geladen (iw reg set greift sofort)" has "$T/calls.log" "modprobe cfg80211"
expect "rfkill entsperrt" hasx "$T/calls.log" "rfkill unblock wifi"
expect "NetworkManager.state: WLAN an" hasx "$T/var/lib/NetworkManager/NetworkManager.state" "WirelessEnabled=true"
expect "systemd-rfkill-Stand entsperrt" hasx "$T/var/lib/systemd/rfkill/platform-fe300000.mmcnr:wlan" 0
expect "PSK aus settings.txt entfernt" not grep -q 'WIFI_PSK=' "$(S)"
expect "SSH-Schlüssel aus settings.txt entfernt" not grep -q 'SSH_AUTHORIZED_KEY=' "$(S)"
expect "Hinweis statt PSK" has "$(S)" "# WIFI_PSK wurde übernommen"
expect "Rest bleibt (SSID, ZIGBEE, HOSTNAME, Kommentar)" \
  test "$(grep -cE '^(WIFI_SSID|ZIGBEE|HOSTNAME|WIFI_COUNTRY|WIFI_HIDDEN)=|^# Kommentar' "$(S)")" = 6
expect "BOM und CRLF bleiben erhalten" test "$(head -c3 "$(S)" | od -An -tx1 | tr -d ' ')" = efbbbf
expect "alle Zeilen weiter mit CRLF" test "$(grep -c $'\r$' "$(S)")" = "$(wc -l <"$(S)")"
expect "keine temporären Dateien auf der Boot-Partition" test -z "$(find "$T/boot" -name '.*' -type f)"
expect "PSK nirgends ausgegeben" no_leak "pa\\ss;w"
expect "SSH-Schlüssel nirgends ausgegeben" no_leak "$(echo "$KEY" | cut -d' ' -f2)"
expect "Benutzer gcadmin mit sudo-Gruppe" has "$T/calls.log" "useradd --create-home --shell /bin/bash --comment GateControl Admin --groups sudo gcadmin"
expect "kein Passwort (*)" hasx "$T/calls.log" "usermod --password * gcadmin"
expect "authorized_keys = Schlüssel" hasx "$(AK)" "$KEY"
expect "authorized_keys 0600, gcadmin" test "$(stat -c '%a %u' "$(AK)")" = "600 1001"
expect ".ssh 0700, gcadmin" test "$(stat -c '%a %u' "$T/home/gcadmin/.ssh")" = "700 1001"
expect "sudoers 0440 NOPASSWD" test "$(stat -c %a "$T/etc/sudoers.d/010_gatecontrol-gcadmin")" = 440 -a \
  -n "$(grep -x 'gcadmin ALL=(ALL:ALL) NOPASSWD: ALL' "$T/etc/sudoers.d/010_gatecontrol-gcadmin")"
D="$T/etc/ssh/sshd_config.d/01-gatecontrol.conf"
expect "sshd: PasswordAuthentication no" hasx "$D" "PasswordAuthentication no"
expect "sshd: PubkeyAuthentication yes" hasx "$D" "PubkeyAuthentication yes"
expect "sshd: PermitRootLogin no" hasx "$D" "PermitRootLogin no"
expect "sshd: AuthenticationMethods publickey" hasx "$D" "AuthenticationMethods publickey"
expect "SSH-Hostschlüssel erzeugt" test -s "$T/etc/ssh/ssh_host_ed25519_key"
expect "ssh.service aktiviert" hasx "$T/calls.log" "systemctl enable --no-reload ssh.service"
expect "ssh.service gestartet (ohne zu blockieren)" hasx "$T/calls.log" "systemctl start --no-block ssh.service"
expect "STATUS.txt: Zeitzone" has "$T/boot/gatecontrol/STATUS.txt" "Zeitzone: Europe/Vienna"
expect "STATUS.txt: WLAN mit SSID" has "$T/boot/gatecontrol/STATUS.txt" "WLAN: \"${SSID}\" (Land AT"
expect "STATUS.txt: SSH mit Fingerprint" grep -q 'SSH: Benutzer gcadmin, nur mit Schlüssel (ED25519 SHA256:' "$T/boot/gatecontrol/STATUS.txt"
expect "Status STARTET (keine Fehler)" grep -q '^STARTET' "$T/run/status"
UUID1="$(grep '^uuid=' "$(NMC)")"

echo "== zweiter Start: Passwort/Schlüssel sind schon entfernt"
echo "console=tty1 cfg80211.ieee80211_regdom=AT" >"$T/proc-cmdline"
: >"$T/calls.log"
expect "Exit 0" run_settings
expect "WLAN-Verbindung bleibt (gleiche UUID, PSK)" test "$(grep '^uuid=' "$(NMC)")" = "$UUID1" -a -n "$(grep -xF "psk=$PSK_FILE" "$(NMC)")"
expect "Funkland nicht erneut gesetzt" not grep -q raspi-config "$T/calls.log"
expect "kein useradd/ssh-Neustart" not grep -qE 'useradd|ssh.service' "$T/calls.log"
expect "Status nennt WLAN weiter mit Passwort" grep -q 'WLAN: .* mit Passwort (WPA2-PSK), verstecktes Netz' "$T/run/settings.status"
expect "Status nennt SSH weiter" grep -q '^SSH: Benutzer gcadmin' "$T/run/settings.status"

echo "== WIFI_HIDDEN geändert (ohne Passwort)"
sed -i 's/^WIFI_HIDDEN=1/WIFI_HIDDEN=0/' "$(S)"
expect "Exit 0" run_settings
expect "hidden entfernt" not grep -q '^hidden=' "$(NMC)"
expect "PSK unverändert" hasx "$(NMC)" "psk=$PSK_FILE"

echo "== Verbindung auf dem Pi gelöscht → nicht als offenes Netz neu anlegen"
cp "$(NMC)" "$T/nm.bak"
rm -f "$(NMC)"
expect "Exit 0" run_settings
expect "keine Verbindung neu angelegt" test ! -e "$(NMC)"
expect "Hinweis im Status" grep -q 'gelöscht' "$T/run/settings.status"

echo "== neue settings.txt: anderes Netz, 64-Hex-PSK; dann offenes Netz"
HEX="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf 'WIFI_SSID=Gast\nWIFI_PSK=%s\n' "$HEX" >"$(S)"
expect "Exit 0" run_settings
expect "neue SSID" hasx "$(NMC)" "ssid=71;97;115;116;"
expect "Hex-PSK unverändert" hasx "$(NMC)" "psk=$HEX"
expect "Land Standard DE" hasx "$T/calls.log" "raspi-config nonint do_wifi_country DE"
printf 'WIFI_SSID=Offen\nWIFI_PSK=\n' >"$(S)"
expect "Exit 0" run_settings
expect "offenes Netz: keine wifi-security" not grep -q '^\[wifi-security\]' "$(NMC)"
expect "Status: offenes Netz" grep -q 'offenes Netz' "$T/run/settings.status"
expect "leere WIFI_PSK-Zeile ebenfalls entfernt" not grep -q '^WIFI_PSK' "$(S)"
rm -rf "$T"

echo "== ungültige Werte: benennen, Rest weiter verarbeiten"
setup
{
  echo "TIMEZONE=../../../etc/passwd"
  echo "WIFI_SSID=Netz"
  echo "WIFI_PSK=kurz"
  echo "WIFI_COUNTRY=XX"
  echo "WIFI_HIDDEN=ja"
  echo "SSH_AUTHORIZED_KEY=command=\"/bin/sh\" $(newkey ed25519)"
  echo "ZIGBEE=auto"
} >"$(S)"
expect "Exit 0" run_settings
expect "Zeitzone nicht geändert" test ! -e "$T/etc/localtime"
expect "kein WLAN bei zu kurzem PSK" test ! -e "$(NMC)"
expect "kein SSH bei Optionen vor dem Schlüssel" test ! -e "$(AK)" -a ! -e "$T/etc/ssh/sshd_config.d/01-gatecontrol.conf"
expect "ssh nicht aktiviert" not grep -q 'ssh.service' "$T/calls.log"
for k in TIMEZONE WIFI_PSK WIFI_COUNTRY WIFI_HIDDEN SSH_AUTHORIZED_KEY; do
  expect "FEHLER für $k in STATUS.txt" grep -q "FEHLER: $k" "$T/boot/gatecontrol/STATUS.txt"
done
expect "Status EINSTELLUNGEN MIT FEHLERN" grep -q '^EINSTELLUNGEN MIT FEHLERN' "$T/run/status"
expect "auch ungültiges PSK von der Karte entfernt" not grep -q 'WIFI_PSK=' "$(S)"
expect "ZIGBEE bleibt" hasx "$(S)" "ZIGBEE=auto"
expect "ungültiges PSK nicht ausgegeben" no_leak "kurz"
rm -rf "$T"

echo "== weitere ungültige Werte"
check_invalid() {  # check_invalid BESCHREIBUNG ZEILE... (eine settings.txt)
  local desc="$1"; shift
  setup
  printf '%s\n' "$@" >"$(S)"
  if run_settings && grep -q '^FEHLER' "$T/run/settings.status" && [ ! -e "$(NMC)" ] && [ ! -e "$T/etc/localtime" ] \
     && [ ! -e "$(AK)" ]; then ok "$desc"; else bad "$desc"; cat "$T/out.log"; fi
  rm -rf "$T"
}
check_invalid "unbekannte Zeitzone" "TIMEZONE=Mars/Olympus"
check_invalid "Zeitzone mit Leerzeichen" "TIMEZONE=Europe/Berlin x"
check_invalid "SSID länger als 32 Byte" "WIFI_SSID=$(printf 'ä%.0s' {1..17})" "WIFI_PSK=12345678"
check_invalid "SSID mit Tabulator" "WIFI_SSID=$(printf 'a\tb')" "WIFI_PSK=12345678"
check_invalid "SSID kein UTF-8" "WIFI_SSID=$(printf 'a\xffb')" "WIFI_PSK=12345678"
check_invalid "PSK mit Umlaut" "WIFI_SSID=x" "WIFI_PSK=passwört123"
check_invalid "PSK mit 64 Zeichen, nicht Hex" "WIFI_SSID=x" "WIFI_PSK=$(printf 'z%.0s' {1..64})"
check_invalid "PSK länger als 64" "WIFI_SSID=x" "WIFI_PSK=$(printf 'a%.0s' {1..65})"

echo "== SSH-Schlüssel prüfen"
check_key() {  # check_key BESCHREIBUNG erwartet(ok|abgelehnt) ZEILE
  local desc="$1" want="$2" line="$3" got
  setup
  printf 'SSH_AUTHORIZED_KEY=%s\n' "$line" >"$(S)"
  run_settings || true
  if [ -s "$(AK)" ] && grep -q 'enable --no-reload ssh.service' "$T/calls.log"; then got=ok; else got=abgelehnt; fi
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc (erwartet $want, war $got)"; cat "$T/out.log"; fi
  rm -rf "$T"
}
T="$(mktemp -d)"
ED="$(newkey ed25519)"
EC="$(newkey ecdsa 384)"
RSA2K="$(newkey rsa 2048)"
RSA3K="$(newkey rsa 3072)"
rm -rf "$T"
check_key "ed25519 mit Kommentar" ok "$ED"
check_key "ecdsa-sha2-nistp384" ok "$EC"
check_key "RSA 3072" ok "$RSA3K"
check_key "RSA 2048 zu kurz" abgelehnt "$RSA2K"
check_key "Optionen davor (from=)" abgelehnt "from=\"10.0.0.1\" $ED"
check_key "Typ passt nicht zu den Daten" abgelehnt "ssh-rsa $(echo "$ED" | cut -d' ' -f2)"
check_key "Daten beschädigt" abgelehnt "ssh-ed25519 $(echo "$ED" | cut -d' ' -f2 | cut -c1-40)"
check_key "kein Base64" abgelehnt "ssh-ed25519 AAAA\$(touch /tmp/x)"
check_key "DSA nicht erlaubt" abgelehnt "ssh-dss AAAAB3NzaC1kc3MAAACBAP"
check_key "Steuerzeichen" abgelehnt "$(printf '%s\tx' "$ED")"

echo "== keine Shell-Auswertung von Werten"
setup
printf '#!/bin/sh\ntouch "%s/pwned"\n' "$T" >"$T/bin/pwn"
chmod +x "$T/bin/pwn"
# shellcheck disable=SC2016  # absichtlich unausgewertet
printf '%s\n' 'WIFI_SSID=$(pwn)' 'WIFI_PSK=`pwn`;$(pwn)' 'TIMEZONE=$(pwn)' 'WIFI_COUNTRY=$(pwn)' >"$(S)"
expect "Exit 0" run_settings
expect "nichts ausgeführt" test ! -e "$T/pwned"
expect "SSID wörtlich übernommen" hasx "$(NMC)" "ssid=36;40;112;119;110;41;"
# shellcheck disable=SC2016
expect "PSK wörtlich übernommen" hasx "$(NMC)" 'psk=`pwn`;$(pwn)'
rm -rf "$T"

echo
echo "$pass ok, $failed Fehler"
[ "$failed" = 0 ]
