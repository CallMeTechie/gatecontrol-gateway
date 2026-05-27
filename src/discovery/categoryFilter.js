'use strict';

const { CATEGORIES } = require('./categories');

// Resolve a per-scan category selection into the concrete signals the engine
// needs. `mode` is 'include' (scan only selected) or 'exclude' (scan all but
// selected). An empty/garbage selection in include mode → nothing active.
function resolveCategories(mode, selectedKeys) {
  const sel = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
  const active = CATEGORIES.filter(c => (mode === 'exclude' ? !sel.has(c.key) : sel.has(c.key)));
  const ports = new Set();
  const mdnsTypes = new Set();
  const ssdpPatterns = [];
  for (const c of active) {
    for (const p of c.ports) ports.add(p);
    for (const m of c.mdns) mdnsTypes.add(m);
    for (const s of c.ssdp) ssdpPatterns.push(s);
  }
  return {
    ports: [...ports].sort((a, b) => a - b),
    mdnsTypes,
    ssdpPatterns,
    activeKeys: active.map(c => c.key),
  };
}

// A passive hit (mDNS service type and/or SSDP SERVER string) passes the filter
// if it matches at least one ACTIVE category — or if it matches NO known
// category at all (uncategorised hits are voluntarily advertised and always
// surfaced; spec §4.4).
function passivePasses(hit, resolved) {
  const mdnsType = hit && hit.mdnsType;
  const ssdpServer = hit && hit.ssdpServer;
  const matched = CATEGORIES.filter(c =>
    (mdnsType && c.mdns.includes(mdnsType)) ||
    (ssdpServer && c.ssdp.some(p => ssdpServer.includes(p))));
  if (matched.length === 0) return true;
  return matched.some(c => resolved.activeKeys.includes(c.key));
}

module.exports = { resolveCategories, passivePasses };
