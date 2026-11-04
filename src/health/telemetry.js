'use strict';

// Gateway telemetry — snapshot of versions, runtime resources and LAN
// context. Collected once per heartbeat and stapled onto the payload so
// the central server can show the admin what's running out on each
// Home-Gateway without a separate fetch channel.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const { execFileSync } = require('node:child_process');
const logger = require('../logger');
const { lanSubnets, primaryLanIp } = require('../discovery/lanInterfaces');
const { catalogue } = require('../discovery/categories');

// ─── Cached-at-load values ──────────────────────────────────────────────
// Nothing here changes over the container lifetime, so we read once at
// require-time and serve cheap.

const GATEWAY_VERSION = (() => {
  try { return require('../../package.json').version; }
  catch { return 'unknown'; }
})();

const NODE_VERSION = process.versions.node;

const WG_TOOLS_VERSION = (() => {
  try {
    // execFile (no shell) against a fixed argv — no injection surface.
    // `wg --version` prints e.g. "wireguard-tools v1.0.20210914 - https://…"
    const out = execFileSync('wg', ['--version'], { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const first = out.split('\n')[0].trim();
    return first.replace(/\s*-\s*https?:\/\/.*$/, '');
  } catch (err) {
    logger.debug({ err: err.message }, 'wg --version not available');
    return null;
  }
})();

// ─── Update-state helpers ────────────────────────────────────────────────

const STATE_DIR = process.env.GATEWAY_STATE_DIR || '/state';

function _readLastPull() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'last-pull'), 'utf8')); }
  catch { return null; }
}
function _stateDirWritable() {
  try { fs.accessSync(STATE_DIR, fs.constants.W_OK); return true; }
  catch { return false; }
}
function _pendingUpdate() {
  try { fs.accessSync(path.join(STATE_DIR, 'pending-update')); return true; }
  catch { return false; }
}

// ─── Per-heartbeat computed values ──────────────────────────────────────

/**
 * Parse /proc/net/route to find the default gateway IP. The kernel writes
 * IPs in little-endian hex, so we swap byte-order back into dotted-quad.
 * Returns null on any hiccup — telemetry should never fail the heartbeat.
 */
function defaultGatewayIp() {
  try {
    const content = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of content.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) continue;
      // Column 1 = Destination (hex), Column 2 = Gateway (hex). The default
      // route has Destination 00000000 (0.0.0.0).
      if (cols[1] !== '00000000') continue;
      const hex = cols[2];
      if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
      return [
        parseInt(hex.slice(6, 8), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(0, 2), 16),
      ].join('.');
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'defaultGatewayIp failed');
  }
  return null;
}

/**
 * Disk usage of the container rootfs. Node ≥ 18 ships statfs; we fall back
 * to null otherwise. The Home-Gateway image is Alpine-small, so a filling
 * rootfs usually signals logs-gone-wild.
 */
function diskUsage() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync('/');
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    return { total, free, used: total - free };
  } catch (err) {
    logger.debug({ err: err.message }, 'disk usage failed');
    return null;
  }
}

// ─── Hardware profile ────────────────────────────────────────────────────
// Lets the server later recommend features per gateway (weak hardware gets a
// hint, never a ban). Inside the container /proc/device-tree is masked, so a
// host that knows more (the Raspberry Pi image: gatecontrol-hwdetect) drops
// /state/hardware.json; everything in it is treated as untrusted input and
// clamped. Without that file the profile comes from what the container sees.

const HOST_PROFILE_MAX_BYTES = 8192;

function _str(v, max = 120) {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function _readHostProfile() {
  try {
    const file = path.join(STATE_DIR, 'hardware.json');
    if (fs.statSync(file).size > HOST_PROFILE_MAX_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** Board/product name as far as the container can see it (Pi: /proc/cpuinfo "Model"). */
function _visibleModel() {
  try {
    const m = /^Model\s*:\s*(.+)$/m.exec(fs.readFileSync('/proc/cpuinfo', 'utf8'));
    if (m) return m[1].trim();
  } catch { /* not a Pi / not Linux */ }
  for (const f of ['/sys/firmware/devicetree/base/model', '/sys/class/dmi/id/product_name']) {
    try {
      const v = fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim();
      if (v) return v;
    } catch { /* masked or absent */ }
  }
  return null;
}

function _storage(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

function hardwareProfile() {
  const host = _readHostProfile();
  const radios = Array.isArray(host?.radios)
    ? host.radios.slice(0, 8).filter(r => r && typeof r === 'object').map(r => ({
      kind: _str(r.kind, 32),
      type: _str(r.type, 32),
      device: _str(r.device, 128),
      firmware: _str(r.firmware, 32),
      detected: r.detected === true,
      enabled: r.enabled === true,
    }))
    : [];
  return {
    model: _str(host?.model) || _str(_visibleModel()),
    arch: process.arch,
    cpu_cores: os.cpus().length,
    mem_total: os.totalmem(),
    // /state is the host's gateway-state dir — its filesystem is where the
    // gateway (and future add-ons) keep data, e.g. /opt on the Pi image.
    storage: _storage(STATE_DIR),
    radios,
    platform: _str(host?.source, 32),
    image_version: _str(host?.image_version, 32),
    host_os: _str(host?.os),
  };
}

function collectTelemetry() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const _lp = _readLastPull();
  const _gwIp = defaultGatewayIp();
  return {
    // Versions
    gateway_version: GATEWAY_VERSION,
    node_version: NODE_VERSION,
    wg_tools_version: WG_TOOLS_VERSION,
    os_platform: process.platform,
    os_release: os.release(),
    arch: process.arch,

    // Resources
    cpu_cores: os.cpus().length,
    cpu_load_avg: os.loadavg(), // [1m, 5m, 15m]
    mem_total: memTotal,
    mem_free: memFree,
    mem_used: memTotal - memFree,
    disk: diskUsage(),
    hardware: hardwareProfile(),

    // LAN context
    dns_resolvers: dns.getServers(),
    default_gateway_ip: _gwIp,
    // Own primary LAN IPv4 — lets the server rewrite a co-located service's
    // loopback target (127.0.0.1) to this host's real LAN address when its
    // route has failed over to a sibling gateway. NULL on a host with no
    // private LAN address; the server then keeps lan_ip NULL and degrades
    // safely (HTTP 502 / no L4 listener instead of mis-forwarding).
    lan_ip: primaryLanIp(_gwIp),

    // LAN discovery (Phase 2: capability flag now set — /api/lan-scan exists).
    lan_discovery: true,
    lan_subnets: lanSubnets(_gwIp),
    lan_discovery_categories: catalogue(),

    // Scan-egress (Phase 1a: capability flag now set — EgressProxyManager exists).
    scan_egress: true,

    // Update state
    state_dir_writable: _stateDirWritable(),
    pending_update: _pendingUpdate(),
    image_digest: _lp && _lp.image_digest ? _lp.image_digest : null,
    last_pull_at: _lp && typeof _lp.pulled_at === 'number' ? _lp.pulled_at : null,
    last_pull_ok: _lp ? (_lp.ok === true) : null,
    last_pull_request_id: _lp && _lp.request_id ? _lp.request_id : null,
  };
}

module.exports = { collectTelemetry, defaultGatewayIp, hardwareProfile };
