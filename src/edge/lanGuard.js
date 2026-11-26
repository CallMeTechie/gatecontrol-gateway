'use strict';

// Zieladressen der Edge-Teile (Vertrag Abschnitt 5): nur IPv4-Adressen in den
// privaten (RFC 1918) LAN-Subnetzen des Gateways (dieselbe Schnittstellen-Logik wie LAN-Scan und
// Telemetrie: src/discovery/lanInterfaces.js), nie das Tunnel-Netz, nie die
// eigene Tunnel-Adresse, nie der Server. Hostnamen werden nicht aufgelöst
// (keine DNS-Anfragen aus Plugin-Daten). Multicast nur mit Fähigkeit.

const net = require('node:net');
const { lanSubnets, ipInCidr } = require('../discovery/lanInterfaces');
const { defaultGatewayIp } = require('../health/telemetry');

class DeniedError extends Error {
  constructor(message) { super(message); this.code = 'denied'; }
}

const CACHE_MS = 10000;
const LIMITED_BROADCAST = '255.255.255.255';

/** Broadcast-Adresse eines IPv4-Netzes (Netzadresse + Präfix); null für /31 und /32 (kein Broadcast). */
function broadcastOf(network, prefix) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix >= 31) return null;
  const o = network.split('.').map(Number);
  const n = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const host = prefix === 0 ? 0xffffffff : (2 ** (32 - prefix)) - 1;
  const b = (n | host) >>> 0;
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

/** Netzadresse in RFC 1918 (10/8, 172.16/12, 192.168/16)? */
function isPrivateNet(cidr) {
  const [a, b] = cidr.split('/')[0].split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * LAN-Subnetze für Edge-Teile und Netzgrenze: die physischen LAN-Schnittstellen
 * (lanSubnets) – nur private Netze nach RFC 1918, nie öffentliche Adressen.
 */
function privateLanCidrs() {
  return lanSubnets(defaultGatewayIp()).map((s) => s.cidr).filter(isPrivateNet);
}

function makeLanGuard({ getSubnets, tunnelIp = null, serverAddrs = () => [], now = Date.now } = {}) {
  const subnetsOf = getSubnets || privateLanCidrs;
  let cache = null;
  let cachedAt = 0;
  function subnets() {
    if (!cache || now() - cachedAt > CACHE_MS) {
      cache = subnetsOf().map((c) => { const [n, p] = c.split('/'); return { network: n, prefix: Number(p), cidr: c }; });
      cachedAt = now();
    }
    return cache;
  }

  function isMulticast(ip) {
    const a = Number(ip.split('.')[0]);
    return a >= 224 && a <= 239;
  }

  /**
   * Prüft ein Ziel; wirft DeniedError. `multicast`: erlaubte Gruppen (Fähigkeit udp.multicast).
   */
  function check(host, { multicast = [] } = {}) {
    if (typeof host !== 'string' || net.isIPv4(host) === false) {
      throw new DeniedError(`target must be an IPv4 address in the LAN (got ${String(host).slice(0, 64)})`);
    }
    if (isMulticast(host)) {
      if (multicast.includes(host)) return host;
      throw new DeniedError(`multicast group ${host} not approved`);
    }
    const tip = typeof tunnelIp === 'function' ? tunnelIp() : tunnelIp;
    if (tip && host === tip) throw new DeniedError('the tunnel address is not a LAN target');
    if ((serverAddrs() || []).includes(host)) throw new DeniedError('the server is not a LAN target');
    const hit = subnets().find((s) => ipInCidr(host, s.network, s.prefix));
    if (!hit) throw new DeniedError(`${host} is not in a LAN subnet of this gateway`);
    const last = host.split('.').map(Number);
    if (last.every((o, i) => o === Number(hit.network.split('.')[i])) && hit.prefix < 31) {
      throw new DeniedError('network address is not a target');
    }
    return host;
  }

  function allowed(host, opts) {
    try { check(host, opts); return true; } catch { return false; }
  }

  /** Broadcast-Adressen der privaten LAN-Subnetze (ohne /31, /32). */
  function broadcasts() {
    return [...new Set(subnets().map((s) => broadcastOf(s.network, s.prefix)).filter(Boolean))];
  }

  /**
   * Ist `host` ein Broadcast-Ziel? 255.255.255.255 → alle Subnetz-Broadcasts (nie über Tunnel oder andere
   * Schnittstellen), eine Subnetz-Broadcast-Adresse → nur sie; sonst null (kein Broadcast).
   */
  function broadcastTargets(host) {
    if (typeof host !== 'string') return null;
    const list = broadcasts();
    if (host === LIMITED_BROADCAST) return list;
    return list.includes(host) ? [host] : null;
  }

  return { check, allowed, broadcasts, broadcastTargets, subnets: () => subnets().map((s) => s.cidr) };
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeniedError(`invalid port ${port}`);
  return port;
}

module.exports = { makeLanGuard, checkPort, DeniedError, privateLanCidrs, isPrivateNet, broadcastOf, LIMITED_BROADCAST };
