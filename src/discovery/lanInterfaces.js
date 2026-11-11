'use strict';

const os = require('node:os');
const net = require('node:net');

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

// ─── IPv6 home networks ──────────────────────────────────────────────────
// A LAN without IPv4 has no RFC1918 address — the gateway then reports its
// unique local addresses (ULA, fc00::/7) next to lan_ip / lan_subnets, as
// `lan_ip6` / `lan_subnets6`. Only ULA: link-local (fe80::/10) needs a zone
// and is the same prefix in every network; global addresses change with the
// provider and must not be self-reported as "the home LAN".

/** "fd00:1::5" → 8 groups as numbers, or null (no zone, no embedded IPv4). */
function _v6Groups(ip) {
  if (typeof ip !== 'string' || !net.isIPv6(ip) || ip.includes('.') || ip.includes('%')) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Shortest form: longest run of zero groups (≥ 2) as "::", lower-case hex. */
function _v6String(groups) {
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    if (j > i) i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

/** Unique local IPv6 address (fc00::/7), e.g. fd00::1 — never link-local, loopback or global. */
function isUlaIpv6(ip) {
  const g = _v6Groups(ip);
  return !!g && (g[0] & 0xfe00) === 0xfc00;
}

/** Network of `ip` with `prefix` bits, shortest form — or null. */
function _v6Network(ip, prefix) {
  const g = _v6Groups(ip);
  if (!g || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  return _v6String(g.map((v, i) => {
    const bits = Math.min(16, Math.max(0, prefix - i * 16));
    return bits === 16 ? v : v & ((0xffff << (16 - bits)) & 0xffff);
  }));
}

function _v6Prefix(addr) {
  const m = /\/(\d{1,3})$/.exec(String(addr.cidr || ''));
  return m ? Number(m[1]) : null;
}

/** ULA entries on physical-LAN interfaces: [{ iface, address, prefix }] (interface order, then as listed). */
function _ulaEntries(ifaces) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const addr of (addrs || [])) {
      if (!addr || (addr.family !== 'IPv6' && addr.family !== 6) || addr.internal) continue;
      if (!isUlaIpv6(addr.address)) continue;
      const prefix = _v6Prefix(addr);
      if (prefix === null || prefix < 48 || prefix > 127) continue; // wider than a ULA site prefix, or a host route
      out.push({ iface: name, address: addr.address.toLowerCase(), prefix });
    }
  }
  return out;
}

/**
 * ULA subnets of the physical LAN as { iface, cidr } (e.g. "fd12:3456:789a:1::/64"),
 * deduplicated, at most 8 — reported as `lan_subnets6`. Empty without ULA.
 * `ifaces` is injectable for tests.
 */
function lanSubnets6(ifaces = os.networkInterfaces()) {
  const seen = new Set();
  const out = [];
  for (const e of _ulaEntries(ifaces)) {
    const network = _v6Network(e.address, e.prefix);
    if (!network) continue;
    const cidr = `${network}/${e.prefix}`;
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    out.push({ iface: e.iface, cidr });
    if (out.length >= 8) break;
  }
  return out;
}

/** The host's first ULA address on a physical-LAN interface — reported as `lan_ip6` — or null. */
function primaryLanIp6(ifaces = os.networkInterfaces()) {
  const e = _ulaEntries(ifaces)[0];
  return e ? _v6String(_v6Groups(e.address)) : null;
}

module.exports = {
  lanSubnets, primaryLanIp, isPhysicalLan, netmaskToPrefix, networkAddress, ipInCidr,
  isPrivateIpv4: _isPrivateIpv4,
  isUlaIpv6, lanSubnets6, primaryLanIp6,
};
