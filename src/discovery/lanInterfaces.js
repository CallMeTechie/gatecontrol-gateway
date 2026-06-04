'use strict';

const os = require('node:os');

const WG_INTERFACE = 'gatecontrol0';

// Canonical physical-LAN interface filter — the single source of truth for what
// counts as a scannable LAN interface. Excludes loopback, WireGuard (the
// GateControl tunnel `gatecontrol0` AND any generic `wg*`), Docker/bridge, and
// other VPN overlays.
function isPhysicalLan(name) {
  if (name === 'lo' || name.startsWith('wg') || name.startsWith(WG_INTERFACE)) return false;
  if (name.startsWith('docker') || name.startsWith('br-')) return false;
  if (name.startsWith('veth') || name.startsWith('tailscale')) return false;
  if (name.startsWith('zt') || name.startsWith('nebula')) return false; // ZeroTier, Nebula
  return true;
}

function netmaskToPrefix(netmask) {
  return netmask.split('.').map(Number).reduce(
    (bits, o) => bits + ((o.toString(2).match(/1/g) || []).length), 0);
}

function _ipToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
}

function networkAddress(ip, netmask) {
  const ipP = ip.split('.').map(Number);
  const mP = netmask.split('.').map(Number);
  return ipP.map((o, i) => o & mP[i]).join('.');
}

function ipInCidr(ip, network, prefix) {
  if (prefix <= 0) return true;
  const mask = prefix >= 32 ? 0xffffffff : (~(0xffffffff >>> prefix)) >>> 0;
  return ((_ipToInt(ip) & mask) >>> 0) === ((_ipToInt(network) & mask) >>> 0);
}

/**
 * Enumerate physical-LAN IPv4 subnets as { iface, cidr, primary }.
 * `defaultGwIp` (from telemetry.defaultGatewayIp) selects the primary subnet —
 * the one whose network contains the host default route. Exactly one entry is
 * flagged primary when at least one subnet exists (deterministic fallback: the
 * first). `/32` host-routes and `/0` are skipped (not scannable LANs), so a
 * VPS-style host with only a public `/32` yields an empty list. `ifaces` is
 * injectable for tests.
 */
function lanSubnets(defaultGwIp, ifaces = os.networkInterfaces()) {
  const entries = [];
  const seen = new Set();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const addr of (addrs || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.netmask || !addr.address) continue;          // defensive: malformed entry
      const prefix = netmaskToPrefix(addr.netmask);
      if (prefix <= 0 || prefix >= 32) continue;             // /0 and /32 aren't scannable LAN subnets
      const network = networkAddress(addr.address, addr.netmask);
      const cidr = `${network}/${prefix}`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);
      entries.push({ iface: name, network, prefix, cidr });
    }
  }
  let primaryIdx = -1;
  if (defaultGwIp) {
    primaryIdx = entries.findIndex(e => ipInCidr(defaultGwIp, e.network, e.prefix));
  }
  if (primaryIdx === -1 && entries.length > 0) primaryIdx = 0; // deterministic fallback
  return entries.map((e, i) => ({ iface: e.iface, cidr: e.cidr, primary: i === primaryIdx }));
}

// RFC1918 private IPv4 only (10/8, 172.16–31/12, 192.168/16). Mirrors the
// server's isPrivateIpv4 (src/utils/validate.js) — the server rejects anything
// else from a heartbeat, so emitting only private addresses avoids leaking a
// public IP and keeps both sides in agreement.
function _isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * The host's own primary LAN IPv4 — the address a sibling gateway forwards to
 * when a co-located (127.0.0.1) service has failed over to it. Reported in the
 * heartbeat as `lan_ip`. Only physical-LAN, non-internal, RFC1918-private
 * addresses are considered. `defaultGwIp` (telemetry.defaultGatewayIp) selects
 * the primary: the candidate whose own subnet contains the host default route;
 * otherwise the first private candidate (deterministic, matching lanSubnets).
 * Returns null when no private LAN address exists (e.g. a VPS with only a
 * public /32) — the server then keeps lan_ip NULL and degrades safely.
 * `ifaces` is injectable for tests.
 */
function primaryLanIp(defaultGwIp, ifaces = os.networkInterfaces()) {
  const cands = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const addr of (addrs || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.address || !addr.netmask) continue;
      if (!_isPrivateIpv4(addr.address)) continue;            // excludes public, loopback, link-local
      cands.push({ address: addr.address, network: networkAddress(addr.address, addr.netmask),
        prefix: netmaskToPrefix(addr.netmask) });
    }
  }
  if (cands.length === 0) return null;
  if (defaultGwIp) {
    const hit = cands.find(c => ipInCidr(defaultGwIp, c.network, c.prefix));
    if (hit) return hit.address;
  }
  return cands[0].address;                                     // deterministic fallback
}

module.exports = { lanSubnets, primaryLanIp, isPhysicalLan, netmaskToPrefix, networkAddress, ipInCidr };
