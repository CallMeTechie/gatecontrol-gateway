'use strict';

const logger = require('../logger');

// Pure: fold a multicast-dns response packet into service records.
// Correlates SRV (port + target host) with A (target → IP) and derives the
// service type from the SRV record name (e.g. `nas._http._tcp.local` → `_http._tcp`).
function mapMdnsResponse(packet) {
  const recs = packet && Array.isArray(packet.answers) ? packet.answers.slice() : [];
  const extra = packet && Array.isArray(packet.additionals) ? packet.additionals : [];
  const all = recs.concat(extra);
  const aByName = new Map();
  for (const r of all) if (r.type === 'A' && typeof r.data === 'string' && typeof r.name === 'string') aByName.set(r.name.toLowerCase(), r.data);
  const out = [];
  for (const r of all) {
    if (r.type !== 'SRV' || !r.data) continue;
    const ip = aByName.get(String(r.data.target || '').toLowerCase());
    if (!ip) continue;
    const m = r.name.match(/(_[^.]+\._(?:tcp|udp))\.local$/);
    out.push({ ip, host: r.data.target, port: r.data.port, mdnsType: m ? m[1] : null });
  }
  return out;
}

// Thin socket wrapper on the LAN interface — covered by smoke, not unit.
// Bound to 0.0.0.0:5353 (shared with the host's avahi/Bonjour via SO_REUSEADDR),
// never to the interface address: on Linux a socket bound to a unicast address
// receives no multicast, i.e. none of the (multicast) answers. The interface
// address only selects the group membership and the outgoing interface.
function discoverMdns({ ifaceIp, timeoutMs = 4000 }) {
  return new Promise(resolve => {
    let mdns;
    const out = [];
    if (!ifaceIp) return resolve(out); // never bind multicast to a null/all interface (spec §4.2)
    try {
      mdns = require('multicast-dns')({ interface: ifaceIp, bind: '0.0.0.0', multicast: true });
    } catch (err) { logger.debug({ err: err.message }, 'mdns init failed'); return resolve(out); }
    mdns.on('response', (packet) => { for (const r of mapMdnsResponse(packet)) out.push(r); });
    mdns.on('error', (err) => {
      logger.debug({ err: err.message }, 'mdns error');
      try { mdns.destroy(); } catch (_e) { /* already destroyed */ }
      resolve(out);
    });
    mdns.query({ questions: [{ name: '_services._dns-sd._udp.local', type: 'PTR' }] });
    setTimeout(() => { try { mdns.destroy(); } catch (_e) { /* already destroyed */ } resolve(out); }, timeoutMs);
  });
}

module.exports = { mapMdnsResponse, discoverMdns };
