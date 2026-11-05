'use strict';

// Prüfung des Manifest-Abschnitts `edge` (Vertrag Abschnitt 4). Der Server
// prüft dasselbe beim Hochladen; das Gateway prüft erneut, weil es dem Paket
// nur nach eigener Prüfung traut. Dieselben Regeln gelten für die vom Server
// genehmigten Fähigkeiten im `state` (`caps`).

const path = require('node:path');
const { LIMITS } = require('./constants');
const { checkPath } = require('./gcplugin');
const { validPluginFilter } = require('./topics');

class ManifestError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const SERIAL_NAMES = new Set(['zigbee']);
const MDNS_SERVICE_RE = /^_[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\._(?:tcp|udp)$/;
const CAP_KEYS = new Set(['udp', 'mdns', 'tcp', 'http', 'mqtt', 'serial']);
const MDNS_GROUP = '224.0.0.251';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function ipv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.some((x) => x > 255) ? null : o;
}

/** Multicast-Gruppe erlaubt? 224.0.0.0/4 ohne 224.0.0.0/24 (lokale Steuergruppen) – außer mDNS. */
function multicastAllowed(g) {
  const o = ipv4(g);
  if (!o || o[0] < 224 || o[0] > 239) return false;
  if (o[0] === 224 && o[1] === 0 && o[2] === 0) return g === MDNS_GROUP;
  return true;
}

function uniq(list) { return [...new Set(list)]; }

/**
 * Fähigkeiten prüfen und normalisieren. Unbekannte Schlüssel → Fehler (lieber
 * ablehnen als stillschweigend etwas anderes genehmigen).
 */
function validateCaps(caps, where = 'capabilities') {
  if (caps === undefined || caps === null) return {};
  if (!isObj(caps)) throw new ManifestError('bad_caps', `${where} must be an object`);
  const out = {};
  for (const k of Object.keys(caps)) {
    if (!CAP_KEYS.has(k)) throw new ManifestError('bad_caps', `${where}: unknown capability "${k}"`);
  }
  if (caps.udp !== undefined) {
    const u = caps.udp;
    if (!isObj(u)) throw new ManifestError('bad_caps', `${where}.udp must be an object`);
    const ports = u.ports === undefined ? [] : u.ports;
    const groups = u.multicast === undefined ? [] : u.multicast;
    if (!Array.isArray(ports) || ports.length > 16) throw new ManifestError('bad_caps', `${where}.udp.ports: list of at most 16 ports`);
    for (const p of ports) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new ManifestError('bad_caps', `${where}.udp.ports: ${p} (1024–65535)`);
      if (p === 5353) throw new ManifestError('bad_caps', `${where}.udp.ports: 5353 only through "mdns"`);
    }
    if (!Array.isArray(groups) || groups.length > 16) throw new ManifestError('bad_caps', `${where}.udp.multicast: list of at most 16 groups`);
    for (const g of groups) {
      if (typeof g !== 'string' || !multicastAllowed(g)) throw new ManifestError('bad_caps', `${where}.udp.multicast: ${g} not allowed`);
    }
    out.udp = { ports: uniq(ports), multicast: uniq(groups) };
  }
  if (caps.mdns !== undefined) {
    const m = caps.mdns;
    if (!isObj(m) || !Array.isArray(m.services) || m.services.length > 16) throw new ManifestError('bad_caps', `${where}.mdns.services: list of at most 16 services`);
    for (const s of m.services) {
      if (typeof s !== 'string' || !MDNS_SERVICE_RE.test(s)) throw new ManifestError('bad_caps', `${where}.mdns.services: ${s}`);
    }
    out.mdns = { services: uniq(m.services) };
  }
  for (const k of ['tcp', 'http']) {
    if (caps[k] === undefined) continue;
    if (!isObj(caps[k]) || typeof caps[k].lan !== 'boolean' || Object.keys(caps[k]).some((x) => x !== 'lan')) {
      throw new ManifestError('bad_caps', `${where}.${k} must be { "lan": true|false }`);
    }
    out[k] = { lan: caps[k].lan };
  }
  if (caps.mqtt !== undefined) {
    const m = caps.mqtt;
    if (!isObj(m) || !Array.isArray(m.topics) || m.topics.length > 16) throw new ManifestError('bad_caps', `${where}.mqtt.topics: list of at most 16 topics`);
    for (const t of m.topics) {
      if (!validPluginFilter(t)) throw new ManifestError('bad_caps', `${where}.mqtt.topics: ${t}`);
    }
    out.mqtt = { topics: uniq(m.topics) };
  }
  if (caps.serial !== undefined) {
    if (!Array.isArray(caps.serial) || caps.serial.length > 4) throw new ManifestError('bad_caps', `${where}.serial: list of device names`);
    for (const s of caps.serial) {
      if (!SERIAL_NAMES.has(s)) throw new ManifestError('bad_caps', `${where}.serial: unknown device "${s}"`);
    }
    out.serial = uniq(caps.serial);
  }
  return out;
}

/**
 * Wirksame Fähigkeiten = was das Manifest verlangt UND der Server genehmigt
 * hat. Was nur der `state` nennt, gilt nicht (das Paket hat es nie verlangt).
 */
function intersectCaps(manifestCaps, approved) {
  const m = manifestCaps || {};
  const a = approved || {};
  const out = {};
  if (m.udp && a.udp) {
    const ports = m.udp.ports.filter((p) => a.udp.ports.includes(p));
    const multicast = m.udp.multicast.filter((g) => a.udp.multicast.includes(g));
    out.udp = { ports, multicast };
  }
  if (m.mdns && a.mdns) out.mdns = { services: m.mdns.services.filter((s) => a.mdns.services.includes(s)) };
  for (const k of ['tcp', 'http']) if (m[k] && a[k]) out[k] = { lan: m[k].lan === true && a[k].lan === true };
  if (m.mqtt && a.mqtt) out.mqtt = { topics: m.mqtt.topics.filter((t) => a.mqtt.topics.includes(t)) };
  if (m.serial && a.serial) out.serial = m.serial.filter((s) => a.serial.includes(s));
  return out;
}

// ─── Versionen ───────────────────────────────────────────────────────────

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

/** -1 / 0 / 1; Vorabversionen sind kleiner als die Version selbst. */
function compareVersions(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error('invalid version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Manifest (plugin.json) prüfen und den Edge-Teil liefern:
 * { id, version, entry, entryDir, minGateway, memoryMb, capabilities }.
 */
function validateEdgeManifest(manifest, { gatewayVersion } = {}) {
  if (!isObj(manifest)) throw new ManifestError('bad_manifest', 'plugin.json is not an object');
  const e = manifest.edge;
  if (!isObj(e)) throw new ManifestError('no_edge', 'plugin has no "edge" part');
  if (typeof e.entry !== 'string') throw new ManifestError('bad_manifest', 'edge.entry missing');
  let entry;
  try { entry = checkPath(e.entry); } catch { throw new ManifestError('bad_manifest', 'edge.entry: invalid path'); }
  if (!/\.(?:c?js)$/.test(entry)) throw new ManifestError('bad_manifest', 'edge.entry must be a .js/.cjs file');
  const entryDir = path.posix.dirname(entry);
  // Nur der Ordner des Edge-Teils wird entpackt – ein Eintrag im Wurzelordner
  // würde das ganze Paket (auch den Server-Teil) auf das Gateway bringen.
  if (entryDir === '.') throw new ManifestError('bad_manifest', 'edge.entry must be inside a folder (e.g. edge/index.js)');
  let memoryMb = LIMITS.memoryMbDefault;
  if (e.memoryMb !== undefined) {
    if (!Number.isInteger(e.memoryMb) || e.memoryMb < LIMITS.memoryMbMin || e.memoryMb > LIMITS.memoryMbMax) {
      throw new ManifestError('bad_manifest', `edge.memoryMb must be ${LIMITS.memoryMbMin}–${LIMITS.memoryMbMax}`);
    }
    memoryMb = e.memoryMb;
  }
  let minGateway = null;
  if (e.minGateway !== undefined) {
    if (!parseSemver(e.minGateway)) throw new ManifestError('bad_manifest', 'edge.minGateway is not a version');
    minGateway = e.minGateway;
    if (gatewayVersion && parseSemver(gatewayVersion) && compareVersions(gatewayVersion, minGateway) < 0) {
      throw new ManifestError('gateway_too_old', `needs gateway ${minGateway} (this one: ${gatewayVersion})`);
    }
  }
  const capabilities = validateCaps(e.capabilities, 'edge.capabilities');
  return { id: manifest.id, version: manifest.version, entry, entryDir, minGateway, memoryMb, capabilities };
}

module.exports = {
  ManifestError, validateCaps, intersectCaps, validateEdgeManifest, compareVersions, parseSemver, multicastAllowed,
  MDNS_GROUP, SERIAL_NAMES,
};
