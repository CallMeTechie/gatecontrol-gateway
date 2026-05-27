'use strict';

const os = require('node:os');

const WG_INTERFACE = 'gatecontrol0';

// Canonical physical-LAN interface filter — the ONE copy (wol.js imports this).
// Excludes loopback, WireGuard (the GateControl tunnel `gatecontrol0` AND any
// generic `wg*`), Docker/bridge, and other VPN overlays.
function isPhysicalLan(name) {
  if (name === 'lo' || name.startsWith('wg') || name.startsWith(WG_INTERFACE)) return false;
  if (name.startsWith('docker') || name.startsWith('br-')) return false;
  if (name.startsWith('veth') || name.startsWith('tailscale')) return false;
  if (name.startsWith('zt') || name.startsWith('nebula')) return false; // ZeroTier, Nebula
  return true;
}

function netmaskToPrefix(netmask) {
  return netmask.split('.').map(Number).reduce(
    (bits, o) => bits + (((o >>> 0).toString(2).match(/1/g) || []).length), 0);
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

module.exports = { lanSubnets, isPhysicalLan, netmaskToPrefix, networkAddress, ipInCidr };
