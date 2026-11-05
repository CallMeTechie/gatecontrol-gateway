'use strict';

// Zieladressen der Edge-Teile (Vertrag Abschnitt 5): nur IPv4-Adressen in den
// LAN-Subnetzen des Gateways (dieselbe Schnittstellen-Logik wie LAN-Scan und
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

function makeLanGuard({ getSubnets, tunnelIp = null, serverAddrs = () => [], now = Date.now } = {}) {
  const subnetsOf = getSubnets || (() => lanSubnets(defaultGatewayIp()).map((s) => s.cidr));
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

  return { check, allowed, subnets: () => subnets().map((s) => s.cidr) };
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeniedError(`invalid port ${port}`);
  return port;
}

module.exports = { makeLanGuard, checkPort, DeniedError };
