#!/usr/bin/env bash
#
# GateControl Gateway — Proxmox VE LXC Installer
#
# Run on the Proxmox host shell:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/scripts/install-pve.sh)"
#
# Subcommands:
#   install (default)        Create + provision a new LXC
#   update <ctid>            Pull latest release into existing LXC + restart
#   remove <ctid>            Stop and destroy the LXC
#
# Layout inside the container:
#   /opt/gatecontrol-gateway/         Source tree (npm-installed)
#   /opt/gatecontrol-gateway.previous Backup of last version (created by update)
#   /etc/gatecontrol-gateway/gateway.env  Env file from dashboard download
#   /etc/systemd/system/gatecontrol-gateway.service  systemd unit
#

set -euo pipefail

readonly REPO="CallMeTechie/gatecontrol-gateway"
readonly DEFAULT_HOSTNAME="gatecontrol-gateway"
readonly DEFAULT_RAM=512
readonly DEFAULT_CORES=1
readonly DEFAULT_DISK=4
readonly DEFAULT_BRIDGE="vmbr0"

# ── Output helpers ────────────────────────────────────────────────────
_c_reset='\033[0m'
_c_blue='\033[1;34m'
_c_green='\033[1;32m'
_c_yellow='\033[1;33m'
_c_red='\033[1;31m'

# All status helpers write to stderr so functions that legitimately
# echo their result on stdout (e.g. redeem_pairing_token returning a
# tmp-file path captured via "$(...)") don't leak the [INFO]/[OK] lines
# into the caller's variable. Reported in the wild: ENV_FILE captured
# the entire "[INFO] Redeeming…\n[OK] materialised at …\n/tmp/…"
# multi-line string and the next [ -f "$ENV_FILE" ] failed.
msg_info() { printf '%b[INFO]%b %s\n' "$_c_blue"   "$_c_reset" "$*" >&2; }
msg_ok()   { printf '%b[OK]%b   %s\n' "$_c_green"  "$_c_reset" "$*" >&2; }
msg_warn() { printf '%b[WARN]%b %s\n' "$_c_yellow" "$_c_reset" "$*" >&2; }
msg_err()  { printf '%b[ERR]%b  %s\n' "$_c_red"    "$_c_reset" "$*" >&2; }
die()      { msg_err "$*"; exit 1; }

# ── Pre-flight checks (PVE-only) ──────────────────────────────────────

# Install Debian packages on the host if any are missing. Used for the
# small handful of helpers (jq, whiptail) that PVE doesn't always ship
# with — auto-install is friendlier than aborting with a manual
# 'apt install' instruction.
ensure_host_pkgs() {
  local missing=()
  local entry pkg cmd
  for entry in "$@"; do
    pkg="${entry%%:*}"
    cmd="${entry#*:}"
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$pkg")
  done
  [ ${#missing[@]} -eq 0 ] && return 0

  # Detect a held APT lock up front so users don't sit on a frozen
  # install — a Proxmox host can have unattended-upgrades or its own
  # apt sweep running in the background.
  if command -v fuser >/dev/null 2>&1 \
     && fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    msg_warn "APT lock is held by another process — likely unattended-upgrades or pve-daily-update."
    msg_warn "Wait for it to finish, or run:  ps aux | grep -E 'apt|dpkg'"
    die "Cannot install ${missing[*]} while APT is locked"
  fi

  msg_info "Installing missing host packages: ${missing[*]}"
  msg_info "(running 'apt-get update + install' — output below)"
  # Don't silence apt: a network-stalled enterprise repo or a 401 against
  # pve-enterprise looks identical to a hang from the user's side. Show
  # everything; a 30 s update is normal, 5 min means something's wrong
  # and the user should see why.
  if ! DEBIAN_FRONTEND=noninteractive apt-get update; then
    die "apt-get update failed — fix sources (e.g. disable pve-enterprise repo without subscription) and retry"
  fi
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"; then
    die "apt-get install failed for: ${missing[*]}"
  fi
  msg_ok "Host packages installed"
}

preflight() {
  [ "$EUID" -eq 0 ] || die "Must run as root on the Proxmox host"
  command -v pveversion >/dev/null 2>&1 || die "pveversion missing — not a Proxmox host?"
  command -v pct        >/dev/null 2>&1 || die "pct command missing — Proxmox required"
  # Auto-install jq / whiptail on bare PVE installs that don't include them.
  ensure_host_pkgs whiptail:whiptail jq:jq
}

# ── Storage / template / network detection ────────────────────────────

# Pick the first active storage that supports rootdir (LXC root volumes)
detect_storage() {
  local sto
  sto=$(pvesm status -content rootdir 2>/dev/null \
        | awk 'NR>1 && $3=="active" {print $1; exit}')
  [ -n "$sto" ] || die "No active rootdir storage found — configure one in Datacenter → Storage"
  echo "$sto"
}

# Find or download the Debian 12 standard template
ensure_template() {
  local tpl
  tpl=$(pveam list local 2>/dev/null \
        | awk -F'/' '/debian-12-standard/ {print $NF}' \
        | awk '{print $1}' \
        | head -1)
  if [ -z "$tpl" ]; then
    msg_info "Debian 12 template not present — refreshing pveam index..."
    pveam update >/dev/null
    tpl=$(pveam available --section system 2>/dev/null \
          | awk '/debian-12-standard/ {print $2}' \
          | head -1)
    [ -n "$tpl" ] || die "No debian-12-standard template available in pveam"
    msg_info "Downloading template: $tpl"
    pveam download local "$tpl" >/dev/null || die "Template download failed"
  fi
  msg_ok "Template ready: $tpl"
  TEMPLATE_VOLID="local:vztmpl/$tpl"
}

# ── Env-file handling ─────────────────────────────────────────────────

# Trade a pairing token (XXXX-XXXX-XXXX-XXXX@host) for the gateway.env
# content via the server's POST /api/v1/gateway/pair endpoint. Writes to
# a tmp file and echoes the path. Caller validates as usual.
redeem_pairing_token() {
  local token="$1"
  local code="${token%@*}"
  local host="${token##*@}"
  if [ -z "$code" ] || [ -z "$host" ] || [ "$code" = "$token" ]; then
    die "Invalid pairing token format — expected XXXX-XXXX-XXXX-XXXX@hostname"
  fi
  if ! [[ "$code" =~ ^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$ ]]; then
    die "Invalid pairing code segment — expected 4 groups of 4 hex chars"
  fi

  local tmp
  tmp=$(mktemp /tmp/gateway.env.XXXXXX)
  chmod 600 "$tmp"

  msg_info "Redeeming pairing token at https://${host}/api/v1/gateway/pair ..."
  local body_file
  body_file=$(mktemp)
  local http_code
  http_code=$(curl -fsS --max-time 30 \
    -o "$body_file" -w "%{http_code}" \
    -X POST "https://${host}/api/v1/gateway/pair" \
    -H "Content-Type: application/json" \
    -d "{\"code\":\"${code^^}\"}" 2>/dev/null) || http_code=000

  if [ "$http_code" != "200" ]; then
    local err
    err=$(jq -r '.error // "unknown"' <"$body_file" 2>/dev/null || echo "unknown")
    rm -f "$body_file" "$tmp"
    case "$http_code" in
      400) die "Pairing failed: ${err} (token already used, expired, or never existed). Generate a new one in the dashboard." ;;
      429) die "Pairing rate-limited: too many attempts from this IP — wait a few minutes and retry." ;;
      000) die "Pairing failed: could not reach https://${host} (DNS / connectivity / TLS — verify the hostname)." ;;
      *)   die "Pairing failed with HTTP $http_code: $err" ;;
    esac
  fi

  # Server returns { "ok": true, "envContent": "GC_SERVER_URL=...\n..." }.
  jq -r '.envContent' <"$body_file" >"$tmp"
  rm -f "$body_file"

  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "Pairing succeeded but envContent was empty — server bug, please report"
  fi
  msg_ok "Pairing token redeemed; gateway.env materialised at $tmp"
  echo "$tmp"
}

prompt_env_file() {
  local default_path="/root/gateway.env"

  # Plain-text explanation BEFORE any whiptail call — some terminals
  # (especially bash -c "$(curl ...)" invocations under SSH) render the
  # first msgbox invisibly and the user has to press ESC blind to
  # advance. Plain text always shows.
  cat >&2 <<'EOF'

Two ways to provision this gateway:

  Option A (one-shot, recommended): paste the bash command from the
    GateControl Dashboard's Gateway-Peer modal — it includes the
    pairing token via --token and skips all prompts.

  Option B: download gateway.env from the dashboard, copy it to this
    host (e.g. via scp), and provide its path below.

EOF

  local path
  path=$(whiptail --title "Path to gateway.env" --inputbox \
    "Absolute path to gateway.env on this host:" 10 70 "$default_path" 3>&1 1>&2 2>&3) \
    || die "Cancelled by user"
  echo "$path"
}

validate_env_file() {
  local f="$1"
  local missing=()
  for key in GC_SERVER_URL GC_API_TOKEN GC_GATEWAY_TOKEN GC_TUNNEL_IP \
             WG_PRIVATE_KEY WG_PUBLIC_KEY WG_ENDPOINT WG_SERVER_PUBLIC_KEY WG_ADDRESS; do
    grep -qE "^${key}=" "$f" || missing+=("$key")
  done
  [ ${#missing[@]} -eq 0 ] || die "gateway.env is missing required keys: ${missing[*]}"
}

# ── LXC creation ──────────────────────────────────────────────────────

create_lxc() {
  local ctid="$1" hostname="$2" storage="$3" bridge="$4" ram="$5" cores="$6" disk="$7"

  msg_info "Creating LXC $ctid (hostname=$hostname)..."
  pct create "$ctid" "$TEMPLATE_VOLID" \
    --hostname "$hostname" \
    --memory "$ram" \
    --cores "$cores" \
    --rootfs "$storage:$disk" \
    --net0 "name=eth0,bridge=$bridge,ip=dhcp,firewall=0" \
    --features "nesting=1,keyctl=1" \
    --unprivileged 1 \
    --onboot 1 \
    --start 0 \
    --description "GateControl Home Gateway — managed by install-pve.sh" \
    >/dev/null
  msg_ok "LXC $ctid created"
}

# Append TUN device passthrough to /etc/pve/lxc/<id>.conf so wireguard-tools
# can open /dev/net/tun. Without this an unprivileged LXC has no access.
patch_lxc_conf_for_wg() {
  local ctid="$1"
  local conf="/etc/pve/lxc/${ctid}.conf"
  [ -f "$conf" ] || die "LXC config file missing: $conf"

  if ! grep -q '/dev/net/tun' "$conf"; then
    cat >>"$conf" <<'EOF'

# WireGuard TUN device passthrough (added by gatecontrol-gateway installer)
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
    msg_ok "Patched $conf for WireGuard TUN passthrough"
  else
    msg_info "TUN passthrough already configured in $conf"
  fi
}

wait_for_network() {
  local ctid="$1"
  msg_info "Waiting for container network..."
  local attempt=0
  while [ "$attempt" -lt 30 ]; do
    if pct exec "$ctid" -- sh -c 'getent hosts github.com >/dev/null 2>&1'; then
      msg_ok "Network ready"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  die "Container network did not come up within 30s"
}

# ── In-container provisioning ─────────────────────────────────────────

# Generate the bootstrap script that runs INSIDE the new LXC. Kept as a
# heredoc into a temp file so we can `pct push` it and execute — pct exec
# with multi-line stdin via -- bash -c '<huge string>' is fragile.
build_setup_script() {
  local out="$1"
  cat >"$out" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

# Suppress the inherited locale that pct exec brings from the PVE host
# (typically en_US.UTF-8) but isn't generated in the fresh LXC. Setup
# tools (apt, perl, locale, …) don't need anything beyond the C locale,
# which is always available, and forcing it shuts up the cascade of
# "Cannot set LC_*: No such file or directory" warnings.
export LC_ALL=C LANG=C
unset LC_CTYPE LC_MESSAGES LANGUAGE
export DEBIAN_FRONTEND=noninteractive

REPO="CallMeTechie/gatecontrol-gateway"
LATEST_TAG="${LATEST_TAG:-}"

step() { printf '\n\033[1;34m[setup %s]\033[0m %s\n' "$1" "$2"; }

step '1/4' 'apt update + base packages (~30 s)'
# Use -q (one q): suppresses progress bars but still prints package
# names and counts so the user can see the install is alive.
# openresolv supplies /usr/sbin/resolvconf which wg-quick invokes when
# WG_DNS is set. Without it wg-quick aborts with "resolvconf: command
# not found" (exit 127) before the WG link is up. Debian 12 standard
# LXC template doesn't ship it.
apt-get update -q
apt-get install -y -q \
  curl ca-certificates gnupg jq tar \
  wireguard-tools iproute2 iptables \
  openresolv

step '2/4' 'installing Node.js 20 (~60 s)'
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -q nodejs

if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
               | jq -r .tag_name)
fi
[ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "null" ] || {
  echo "[setup] FAILED to resolve latest release tag" >&2
  exit 1
}

step '3/4' "downloading gateway bundle ${LATEST_TAG} (~30 MB)"
# Download the pre-built bundle (source + production node_modules). The
# bundle is built by the release workflow with NODE_AUTH_TOKEN so it can
# pull the private @callmetechie/gatecontrol-config-hash package — the
# LXC has no such token, so npm ci on a bare source tarball would fail
# at the auth step.
mkdir -p /opt/gatecontrol-gateway
BUNDLE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/gateway-bundle.tar.gz"
if ! curl -fSL --progress-bar "$BUNDLE_URL" -o /tmp/gateway-bundle.tar.gz; then
  echo "[setup] FAILED to download gateway-bundle.tar.gz from $BUNDLE_URL" >&2
  echo "[setup] If this is a brand-new release, the bundle may not yet be uploaded — wait 2 min for the release workflow to finish and re-run." >&2
  exit 1
fi
tar xzf /tmp/gateway-bundle.tar.gz -C /opt/gatecontrol-gateway
rm -f /tmp/gateway-bundle.tar.gz
echo "$LATEST_TAG" > /opt/gatecontrol-gateway/.installed_version

step '4/4' 'configuring systemd service'

# Place env file (was pushed to /tmp/gateway.env by the host script)
mkdir -p /etc/gatecontrol-gateway
mv /tmp/gateway.env /etc/gatecontrol-gateway/gateway.env
chmod 600 /etc/gatecontrol-gateway/gateway.env
chown root:root /etc/gatecontrol-gateway/gateway.env

# systemd unit
cat >/etc/systemd/system/gatecontrol-gateway.service <<'UNIT'
[Unit]
Description=GateControl Home Gateway
Documentation=https://github.com/CallMeTechie/gatecontrol-gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=GATEWAY_ENV_PATH=/etc/gatecontrol-gateway/gateway.env
WorkingDirectory=/opt/gatecontrol-gateway
ExecStart=/usr/bin/node /opt/gatecontrol-gateway/src/index.js
Restart=on-failure
RestartSec=5
User=root
# WG needs CAP_NET_ADMIN (always present for root); systemd doesn't strip it
# unless we ask. No further sandboxing here — gateway needs raw access to
# manage the wg interface and bind low ports for L4 routes.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable gatecontrol-gateway.service >/dev/null 2>&1
systemctl restart gatecontrol-gateway.service

echo
echo "[setup] done — service started, awaiting WG handshake."
SCRIPT
}

install_inside_lxc() {
  local ctid="$1" env_file="$2"

  # Push gateway.env (will be moved into /etc by the setup script)
  pct push "$ctid" "$env_file" /tmp/gateway.env --perms 0600

  # Build + push setup script. Avoid `trap '… "$setup_tmp"' RETURN` —
  # the local goes out of scope before the trap fires, which under set -u
  # surfaces as "setup_tmp: unbound variable" after a successful install.
  local setup_tmp
  setup_tmp=$(mktemp)
  build_setup_script "$setup_tmp"
  pct push "$ctid" "$setup_tmp" /root/gatecontrol-setup.sh --perms 0755
  rm -f "$setup_tmp"

  msg_info "Provisioning inside container (this can take 1–2 min)..."
  pct exec "$ctid" -- bash /root/gatecontrol-setup.sh
  pct exec "$ctid" -- rm -f /root/gatecontrol-setup.sh
}

# Wait for the gateway service to report active. The proxy/api ports bind
# only to the WG-tunnel IP (config.tunnelIp), so we don't probe ports —
# we trust systemd's Active state plus a journal sanity check.
service_health_check() {
  local ctid="$1"
  msg_info "Waiting for gatecontrol-gateway service to come up..."
  local state
  local attempt=0
  while [ "$attempt" -lt 30 ]; do
    state=$(pct exec "$ctid" -- systemctl is-active gatecontrol-gateway.service 2>/dev/null || echo unknown)
    if [ "$state" = "active" ]; then
      msg_ok "Service active"
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  msg_warn "Service did not reach 'active' within 60s — check 'journalctl -u gatecontrol-gateway' inside the container"
  return 1
}

# ── Summary ───────────────────────────────────────────────────────────

print_summary() {
  local ctid="$1"
  local ip
  ip=$(pct exec "$ctid" -- ip -4 -o addr show dev eth0 2>/dev/null \
       | awk '{print $4}' | cut -d/ -f1 | head -1)
  local version
  version=$(pct exec "$ctid" -- cat /opt/gatecontrol-gateway/.installed_version 2>/dev/null || echo unknown)

  # When the script ran via bash -c "$(curl …)" the positional $0 is
  # 'bash' (or empty) and realpath/basename throw "missing operand" if
  # we hand them the raw value. Print the canonical curl-pipe-bash
  # invocation back to the user so they can copy-paste it directly.
  local self_invocation="bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install-pve.sh)\""

  cat <<EOF

──────────────────────────────────────────────────────────
  GateControl Gateway installed in LXC $ctid
──────────────────────────────────────────────────────────
  Version:       $version
  Container IP:  ${ip:-<dhcp pending>}
  Hostname:      $(pct exec "$ctid" -- hostname 2>/dev/null || echo "?")

  Next steps:
    1. Open the GateControl Dashboard → Peers → your Gateway
       and confirm it shows 'online' within ~30s.
    2. Logs:    pct exec $ctid -- journalctl -u gatecontrol-gateway -f
    3. Update:  $self_invocation -- update $ctid
    4. Remove:  $self_invocation -- remove $ctid
──────────────────────────────────────────────────────────
EOF
}

# ── Subcommands ───────────────────────────────────────────────────────

cmd_install() {
  preflight

  # Argument parsing
  local CTID="" HOSTNAME_="$DEFAULT_HOSTNAME" ENV_FILE="" PAIRING_TOKEN=""
  local BRIDGE="$DEFAULT_BRIDGE" STORAGE="" RAM="$DEFAULT_RAM"
  local CORES="$DEFAULT_CORES" DISK="$DEFAULT_DISK"
  local ASSUME_YES=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ctid)     CTID="$2"; shift 2 ;;
      --hostname) HOSTNAME_="$2"; shift 2 ;;
      --env-file) ENV_FILE="$2"; shift 2 ;;
      --token)    PAIRING_TOKEN="$2"; shift 2 ;;
      --bridge)   BRIDGE="$2"; shift 2 ;;
      --storage)  STORAGE="$2"; shift 2 ;;
      --ram)      RAM="$2"; shift 2 ;;
      --cores)    CORES="$2"; shift 2 ;;
      --disk)     DISK="$2"; shift 2 ;;
      -y|--yes)   ASSUME_YES=1; shift ;;
      *) die "Unknown option: $1 (use --help for usage)" ;;
    esac
  done

  [ -n "$CTID" ]    || CTID=$(pvesh get /cluster/nextid)
  [ -n "$STORAGE" ] || STORAGE=$(detect_storage)

  # --token wins over --env-file; --env-file wins over the prompt.
  if [ -n "$PAIRING_TOKEN" ] && [ -n "$ENV_FILE" ]; then
    die "Use either --token or --env-file, not both"
  fi
  if [ -n "$PAIRING_TOKEN" ]; then
    ENV_FILE=$(redeem_pairing_token "$PAIRING_TOKEN")
  elif [ -z "$ENV_FILE" ]; then
    ENV_FILE=$(prompt_env_file)
  fi
  [ -f "$ENV_FILE" ] || die "gateway.env not found at: $ENV_FILE"
  validate_env_file "$ENV_FILE"

  # Refuse to clobber an existing CTID
  if pct status "$CTID" >/dev/null 2>&1; then
    die "LXC $CTID already exists — pick another --ctid or 'remove' the existing one first"
  fi

  # Confirm — print plain summary first so it's always visible, then yesno
  cat >&2 <<EOF

──── About to create LXC $CTID ────
  Hostname:  $HOSTNAME_
  Storage:   $STORAGE
  Bridge:    $BRIDGE
  Resources: ${RAM} MB RAM / ${CORES} core(s) / ${DISK} GB disk
  Env file:  $ENV_FILE
─────────────────────────────────

EOF
  if [ "$ASSUME_YES" -eq 0 ]; then
    whiptail --title "Confirm" --yesno "Proceed with these settings?" 8 60 \
      || die "Aborted by user"
  fi

  ensure_template
  create_lxc "$CTID" "$HOSTNAME_" "$STORAGE" "$BRIDGE" "$RAM" "$CORES" "$DISK"
  patch_lxc_conf_for_wg "$CTID"
  msg_info "Starting LXC $CTID..."
  pct start "$CTID"
  wait_for_network "$CTID"
  install_inside_lxc "$CTID" "$ENV_FILE"
  service_health_check "$CTID" || true
  print_summary "$CTID"
}

cmd_update() {
  preflight
  local CTID="${1:-}"
  [ -n "$CTID" ] || die "Usage: $(basename "$0") update <ctid>"
  pct status "$CTID" >/dev/null 2>&1 || die "LXC $CTID not found"

  local current latest
  current=$(pct exec "$CTID" -- cat /opt/gatecontrol-gateway/.installed_version 2>/dev/null || echo "unknown")
  latest=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | jq -r .tag_name)
  if [ -z "$latest" ] || [ "$latest" = "null" ]; then
    die "Could not resolve latest release tag"
  fi

  msg_info "Current: $current   Latest: $latest"
  if [ "$current" = "$latest" ]; then
    msg_ok "Already at latest"
    return 0
  fi

  whiptail --title "Confirm update" --yesno \
"Update LXC $CTID from $current to $latest?

The current install will be moved to /opt/gatecontrol-gateway.previous
so you can roll back manually if needed." 12 65 \
    || die "Aborted by user"

  msg_info "Backing up current install..."
  pct exec "$CTID" -- bash -c '
    set -e
    rm -rf /opt/gatecontrol-gateway.previous
    mv /opt/gatecontrol-gateway /opt/gatecontrol-gateway.previous
  '

  msg_info "Installing $latest..."
  pct exec "$CTID" -- bash -c "
    set -e
    mkdir -p /opt/gatecontrol-gateway
    curl -fsSL 'https://github.com/${REPO}/releases/download/${latest}/gateway-bundle.tar.gz' \
      | tar xz -C /opt/gatecontrol-gateway
    echo '${latest}' > /opt/gatecontrol-gateway/.installed_version
    systemctl restart gatecontrol-gateway.service
  "

  service_health_check "$CTID" || msg_warn "Service did not become active — consider rolling back: pct exec $CTID -- bash -c 'rm -rf /opt/gatecontrol-gateway && mv /opt/gatecontrol-gateway.previous /opt/gatecontrol-gateway && systemctl restart gatecontrol-gateway'"
  msg_ok "Updated to $latest. Previous version preserved at /opt/gatecontrol-gateway.previous"
}

cmd_remove() {
  preflight
  local CTID="${1:-}"
  [ -n "$CTID" ] || die "Usage: $(basename "$0") remove <ctid>"
  pct status "$CTID" >/dev/null 2>&1 || die "LXC $CTID not found"

  whiptail --title "Confirm removal" --yesno \
"Stop and DESTROY LXC $CTID?

This permanently deletes the container and its filesystem.
The gateway.env on the Proxmox host (if any) is NOT touched." 12 65 \
    || die "Aborted by user"

  msg_info "Stopping LXC $CTID..."
  pct stop "$CTID" 2>/dev/null || true
  msg_info "Destroying LXC $CTID..."
  pct destroy "$CTID" --force 1
  msg_ok "Container $CTID removed"
}

usage() {
  cat <<EOF
GateControl Gateway — Proxmox VE LXC Installer

Usage:
  $(basename "$0")                                   Install (interactive)
  $(basename "$0") install [options]                 Install (non-interactive)
  $(basename "$0") update <ctid>                     Update to latest release
  $(basename "$0") remove <ctid>                     Stop and destroy LXC
  $(basename "$0") --help                            Show this help

Install options:
  --ctid <id>        LXC container ID (default: next free)
  --hostname <h>     Container hostname (default: $DEFAULT_HOSTNAME)
  --token <t>        Pairing token (XXXX-XXXX-XXXX-XXXX@host) — fetched
                     from the dashboard's Gateway-Peer modal (LXC tab)
  --env-file <p>     Path to gateway.env on this host (alternative to --token)
  --bridge <b>       Network bridge (default: $DEFAULT_BRIDGE)
  --storage <s>      Storage for rootfs (default: first active rootdir storage)
  --ram <mb>         Memory in MB (default: $DEFAULT_RAM)
  --cores <n>        CPU cores (default: $DEFAULT_CORES)
  --disk <gb>        Rootfs size in GB (default: $DEFAULT_DISK)
  -y, --yes          Skip the final confirmation prompt

Recommended provisioning (one-shot via dashboard):
  1. In the GateControl Dashboard, create or open a Gateway-Peer.
  2. The modal that pops up has an 'LXC' tab — copy the bash command.
  3. Paste it on the Proxmox host shell. Done.

Alternative provisioning (manual env-file transfer):
  1. In the dashboard, switch to the 'Docker' tab and download gateway.env.
  2. scp gateway.env to this Proxmox host (e.g. /root/gateway.env).
  3. Run: $(basename "$0") install --env-file /root/gateway.env

The container is unprivileged with TUN passthrough, so WireGuard kernel
module on the host is reused without granting host-root capabilities.
EOF
}

# ── Dispatcher ────────────────────────────────────────────────────────

main() {
  local cmd="${1:-install}"
  case "$cmd" in
    install)         shift || true; cmd_install "$@" ;;
    update)          shift || true; cmd_update  "$@" ;;
    remove|destroy)  shift || true; cmd_remove  "$@" ;;
    -h|--help|help)  usage; exit 0 ;;
    # When the first arg is a flag (--token, --yes, --env-file, …) the
    # caller skipped the subcommand. That's the shape the dashboard
    # generates ("bash -c "$(curl …)" -- --token X --yes") so default
    # to the install subcommand and pass every flag through.
    -*)              cmd_install "$@" ;;
    *) die "Unknown subcommand: $cmd (try --help)" ;;
  esac
}

main "$@"
