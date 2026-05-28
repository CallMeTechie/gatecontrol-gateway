'use strict';

const os = require('node:os');
const { resolveCategories, passivePasses } = require('./categoryFilter');
const { ipInCidr } = require('./lanInterfaces');

// The gateway's own IPv4 address inside `cidr`. Multicast (mDNS/SSDP) MUST bind
// to this interface IP, never wg0/docker (spec §4.1/§4.2). Returns null if none.
function localIpForSubnet(cidr, ifaces = os.networkInterfaces()) {
  const [network, prefixStr] = String(cidr).split('/');
  const prefix = Number(prefixStr);
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of (addrs || [])) {
      if (a.family === 'IPv4' && !a.internal && ipInCidr(a.address, network, prefix)) return a.address;
    }
  }
  return null;
}

function _add(map, ip) {
  if (!map.has(ip)) map.set(ip, { ip, hostname: null, mac: null, ports: [], sources: new Set() });
  return map.get(ip);
}
function _addPort(dev, port, source, hint) {
  if (!dev.ports.some(p => p.port === port && p.source === source)) {
    dev.ports.push({ port, source, service_hint: hint || null });
  }
  dev.sources.add(source);
}

// Orchestrate the (injectable) sources across the given subnets, merge into
// per-IP device records, filter passive hits by category, MAC-enrich, and emit
// a terminal batch. `sources` = { discoverMdns, discoverSsdp, sweep }.
// Phase 2 emits a SINGLE terminal batch (done:true); time-based intermediate
// batching (spec §4.5 "every ~2 s") is deferred — the onBatch/sendBatch plumbing
// already supports adding it later without an interface change.
async function runScan({ subnets, activeScan, categoryMode, categories, config, sources, arpReader, onBatch }) {
  const resolved = resolveCategories(categoryMode, categories);
  const byIp = new Map();

  for (const subnet of subnets) {
    // Live OS interfaces by design: the caller (ScanManager.validateSubnets)
    // only ever passes gateway-OWNED subnets, so localIpForSubnet always finds
    // our real LAN IP here — which is exactly the interface multicast must bind to.
    const ifaceIp = localIpForSubnet(subnet);
    const [mdnsHits, ssdpHits] = await Promise.all([
      sources.discoverMdns({ ifaceIp, timeoutMs: config.discoveryTimeoutMs }),
      sources.discoverSsdp({ ifaceIp, timeoutMs: config.discoveryTimeoutMs }),
    ]);
    for (const h of mdnsHits) {
      if (!passivePasses({ mdnsType: h.mdnsType }, resolved)) continue;
      const d = _add(byIp, h.ip); if (h.host) d.hostname = d.hostname || h.host;
      if (h.port) _addPort(d, h.port, 'mdns', h.mdnsType);
    }
    for (const h of ssdpHits) {
      if (!passivePasses({ ssdpServer: h.server }, resolved)) continue;
      // SSDP gives an IP (not a hostname) — only contribute the open port.
      const d = _add(byIp, h.host);
      if (h.port) _addPort(d, h.port, 'ssdp', h.st || h.server);
    }
    if (activeScan && resolved.ports.length) {
      // 400 = PER-PROBE timeout; the OVERALL scan window is enforced by ScanManager (Promise.race on discoveryTimeoutMs).
      const open = await sources.sweep({ subnetCidr: subnet, ports: resolved.ports, concurrency: config.discoveryConcurrency, timeoutMs: 400 });
      for (const o of open) _addPort(_add(byIp, o.ip), o.port, 'tcp', null);
    }
  }

  const arp = (typeof arpReader === 'function') ? arpReader() : new Map();
  const devices = [...byIp.values()].map(d => ({
    ip: d.ip, hostname: d.hostname, mac: arp.get(d.ip) || null, ports: d.ports, sources: [...d.sources],
  }));
  if (typeof onBatch === 'function') onBatch(devices, true);
  return devices;
}

module.exports = { runScan, localIpForSubnet };
