'use strict';

// Service-category catalogue for LAN discovery — the single source of truth
// shared by the gateway scan engine (Phase 2: ports/mdns/ssdp) and the server
// UI (keys+labels via telemetry). Each category bundles the signals across all
// three discovery sources. HTTP-vs-L4 is decided PER PORT in Phase 2 (spec §9.1),
// not per category — e.g. a printer's 631/IPP is HTTP while 9100/515 are L4 — so
// no per-category route class is stored here.
const CATEGORIES = [
  { key: 'web',           label: 'Web',              ports: [80, 443, 8080, 8443, 8000, 8081, 3000, 5000], mdns: ['_http._tcp', '_https._tcp'], ssdp: [] },
  { key: 'media',         label: 'Media',            ports: [32400, 8096, 8200], mdns: ['_googlecast._tcp', '_airplay._tcp'], ssdp: ['MediaServer', 'MediaRenderer'] },
  { key: 'remote_access', label: 'Remote access',    ports: [22, 3389, 5900], mdns: ['_ssh._tcp', '_rfb._tcp'], ssdp: [] },
  { key: 'file_sharing',  label: 'File sharing',     ports: [445, 139, 548, 2049, 21], mdns: ['_smb._tcp', '_afpovertcp._tcp'], ssdp: [] },
  { key: 'printers',      label: 'Printers',         ports: [9100, 631, 515], mdns: ['_ipp._tcp', '_pdl-datastream._tcp'], ssdp: ['Printer'] },
  { key: 'databases',     label: 'Databases',        ports: [5432, 3306, 6379, 27017], mdns: [], ssdp: [] },
  { key: 'iot',           label: 'IoT / Smart home', ports: [1883, 5683, 8123], mdns: ['_hap._tcp', '_matter._tcp', '_hue._tcp'], ssdp: ['Belkin', 'WeMo'] },
];

// Keys + labels only — what the server UI needs to render checkboxes, without
// leaking the full port lists into telemetry.
function catalogue() {
  return CATEGORIES.map(c => ({ key: c.key, label: c.label }));
}

module.exports = { CATEGORIES, catalogue };
