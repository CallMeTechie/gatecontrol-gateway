'use strict';

// Gateway telemetry — snapshot of versions, runtime resources and LAN
// context. Collected once per heartbeat and stapled onto the payload so
// the central server can show the admin what's running out on each
// Home-Gateway without a separate fetch channel.

const os = require('node:os');
const fs = require('node:fs');
const dns = require('node:dns');
const { execFileSync } = require('node:child_process');
const logger = require('../logger');

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

function collectTelemetry() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
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

    // LAN context
    dns_resolvers: dns.getServers(),
    default_gateway_ip: defaultGatewayIp(),
  };
}

module.exports = { collectTelemetry };
