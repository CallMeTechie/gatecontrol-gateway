'use strict';

// LAN-Adressen, auf denen der DNS-Filter des Gateways lauscht (Vertrag
// Phase 3b §1.1 `listen: 'lan'`): private IPv4 (RFC 1918), IPv6 ULA
// (fc00::/7) und link-local – nie Tunnel, nie 0.0.0.0. Der Listener selbst
// liegt in der Engine (src/dnsfilter-core/listener.js).

const os = require('node:os');
const { isPhysicalLan, isPrivateIpv4 } = require('../discovery/lanInterfaces');
const core = require('../dnsfilter-core');

function isUla(ip) { return /^f[cd][0-9a-f]{2}:/i.test(ip); }
function isLinkLocal6(ip) { return /^fe[89ab][0-9a-f]:/i.test(ip); }

/** Eigene LAN-Adressen zum Lauschen → [{ address, family: 4|6 }]. */
function lanListenAddresses({ ifaces = os.networkInterfaces(), exclude = [], linkLocal = true } = {}) {
  const out = [];
  const seen = new Set(exclude.filter(Boolean));
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const a of addrs || []) {
      if (a.internal || !a.address) continue;
      let address = null;
      if (a.family === 'IPv4' || a.family === 4) {
        if (isPrivateIpv4(a.address)) address = a.address;
      } else if (isUla(a.address)) {
        address = a.address;
      } else if (linkLocal && isLinkLocal6(a.address)) {
        address = `${a.address}%${name}`;
      }
      if (!address || seen.has(address)) continue;
      seen.add(address);
      out.push({ address, family: address.includes(':') ? 6 : 4 });
    }
  }
  return out;
}

/** Listener der Engine, ohne Angabe auf den LAN-Adressen. */
class DnsListener extends core.DnsListener {
  constructor({ handle, port = 53, addresses = () => lanListenAddresses() }) {
    super({ handle, port, addresses });
  }
}

module.exports = { DnsListener, lanListenAddresses, isUla, isLinkLocal6 };
