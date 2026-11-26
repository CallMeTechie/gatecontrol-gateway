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
    // broadcast (Fähigkeit udp.broadcast): gc.lan.udp.send an 255.255.255.255 bzw. die Broadcast-Adresse
    // eines LAN-Subnetzes – nur an die eigenen udp.ports (netProxy.udpSend)
    if (u.broadcast !== undefined && typeof u.broadcast !== 'boolean') throw new ManifestError('bad_caps', `${where}.udp.broadcast must be true or false`);
    out.udp = { ports: uniq(ports), multicast: uniq(groups), ...(u.broadcast === true ? { broadcast: true } : {}) };
  }
  if (caps.mdns !== undefined) {
    const m = caps.mdns;
    if (!isObj(m) || !Array.isArray(m.services) || m.services.length > 16) throw new ManifestError('bad_caps', `${where}.mdns.services: list of at most 16 services`);
    for (const s of m.services) {
      if (typeof s !== 'string' || !MDNS_SERVICE_RE.test(s)) throw new ManifestError('bad_caps', `${where}.mdns.services: ${s}`);
    }
    out.mdns = { services: uniq(m.services) };
  }
  if (caps.tcp !== undefined) {
    if (!isObj(caps.tcp) || typeof caps.tcp.lan !== 'boolean' || Object.keys(caps.tcp).some((x) => x !== 'lan')) {
      throw new ManifestError('bad_caps', `${where}.tcp must be { "lan": true|false }`);
    }
    out.tcp = { lan: caps.tcp.lan };
  }
  if (caps.http !== undefined) {
    const h = caps.http;
    // HTTPS ohne Zertifikatsprüfung gibt es nicht: selbstsignierte Geräte nur mit pinSha256
    if (isObj(h) && h.selfSigned !== undefined) {
      throw new ManifestError('bad_caps', `${where}.http.selfSigned is no longer supported — pin self-signed certificates with pinSha256 (gc.lan.tlsFingerprint)`);
    }
    if (!isObj(h) || typeof h.lan !== 'boolean' || Object.keys(h).some((x) => x !== 'lan')) {
      throw new ManifestError('bad_caps', `${where}.http must be { "lan": true|false }`);
    }
    out.http = { lan: h.lan };
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

// Was optional sein kann: MQTT-Topics (Merkmal edge-optional-caps) sowie LAN-Zugriff per TCP, UDP-Ports
// und UDP-Broadcast (Merkmal edge-optional-lan). Unbekannte optionale Schlüssel (eines neueren Servers)
// werden übergangen statt das ganze Paket abzulehnen – genehmigt wird ohnehin nur, was hier bekannt ist.

/**
 * Optionale Fähigkeiten (`edge.optionalCapabilities`): `mqtt.topics`, `tcp.lan`, `udp.ports` und
 * `udp.broadcast`. Nichts davon steht zugleich in `capabilities`; Topics und UDP-Ports je höchstens 16
 * zusammen mit `capabilities` – dieselben Regeln wie beim Server. Fehlt der Schlüssel → {}.
 */
function validateOptionalCaps(opt, required, where = 'edge.optionalCapabilities') {
  if (opt === undefined || opt === null) return {};
  if (!isObj(opt)) throw new ManifestError('bad_caps', `${where} must be an object`);
  const req = required || {};
  const out = {};
  if (opt.mqtt !== undefined) {
    const m = opt.mqtt;
    if (!isObj(m) || Object.keys(m).some((x) => x !== 'topics')) throw new ManifestError('bad_caps', `${where}.mqtt: only "topics" can be optional`);
    const mq = validateCaps({ mqtt: m }, where).mqtt;
    const own = (req.mqtt && req.mqtt.topics) || [];
    const both = mq.topics.find((t) => own.includes(t));
    if (both !== undefined) throw new ManifestError('bad_caps', `${where}.mqtt.topics: ${both} is already in edge.capabilities`);
    if (own.length + mq.topics.length > 16) throw new ManifestError('bad_caps', `${where}.mqtt.topics: at most 16 topics together with edge.capabilities`);
    out.mqtt = mq;
  }
  if (opt.tcp !== undefined) {
    const t = validateCaps({ tcp: opt.tcp }, where).tcp;
    if (t.lan !== true) throw new ManifestError('bad_caps', `${where}.tcp: only { "lan": true } can be optional`);
    if (req.tcp && req.tcp.lan === true) throw new ManifestError('bad_caps', `${where}.tcp.lan is already in edge.capabilities`);
    out.tcp = { lan: true };
  }
  if (opt.udp !== undefined) {
    const u = opt.udp;
    if (!isObj(u) || Object.keys(u).some((x) => x !== 'ports' && x !== 'broadcast')) {
      throw new ManifestError('bad_caps', `${where}.udp: only "ports" and "broadcast" can be optional`);
    }
    const ud = validateCaps({ udp: u }, where).udp;
    const own = req.udp || { ports: [], multicast: [] };
    const both = ud.ports.find((p) => own.ports.includes(p));
    if (both !== undefined) throw new ManifestError('bad_caps', `${where}.udp.ports: ${both} is already in edge.capabilities`);
    if (own.ports.length + ud.ports.length > 16) throw new ManifestError('bad_caps', `${where}.udp.ports: at most 16 ports together with edge.capabilities`);
    if (ud.broadcast && own.broadcast) throw new ManifestError('bad_caps', `${where}.udp.broadcast is already in edge.capabilities`);
    if (ud.broadcast && !own.ports.length && !ud.ports.length) throw new ManifestError('bad_caps', `${where}.udp.broadcast needs udp.ports`);
    if (ud.ports.length || ud.broadcast) out.udp = { ports: ud.ports, ...(ud.broadcast ? { broadcast: true } : {}) };
  }
  return out;
}

/** Obergrenze aus Pflicht- und optionalen Fähigkeiten (MQTT-Topics, tcp.lan, UDP-Ports und -Broadcast). */
function withOptional(caps, opt) {
  const o = opt || {};
  let out = caps;
  const extra = (o.mqtt && o.mqtt.topics) || [];
  if (extra.length) {
    const own = (caps.mqtt && caps.mqtt.topics) || [];
    out = { ...out, mqtt: { topics: uniq(own.concat(extra)) } };
  }
  if (o.tcp && o.tcp.lan === true) out = { ...out, tcp: { lan: true } };
  if (o.udp && ((o.udp.ports && o.udp.ports.length) || o.udp.broadcast === true)) {
    const own = caps.udp || { ports: [], multicast: [] };
    out = { ...out, udp: { ports: uniq(own.ports.concat(o.udp.ports || [])), multicast: own.multicast.slice(),
      ...(own.broadcast === true || o.udp.broadcast === true ? { broadcast: true } : {}) } };
  }
  return out;
}

/**
 * Wirksame Fähigkeiten = was das Manifest verlangt (Pflicht ∪ optional) UND
 * der Server genehmigt hat. Was nur der `state` nennt, gilt nicht (das Paket
 * hat es nie verlangt). Optionale Topics kommen nur mit, solange der Server
 * sie im `state` schickt (Bestätigung durch den Admin) – entzogen fallen sie
 * mit dem nächsten `state` heraus.
 */
function intersectCaps(manifestCaps, approved, optionalCaps) {
  const m = withOptional(manifestCaps || {}, optionalCaps);
  const a = approved || {};
  const out = {};
  if (m.udp && a.udp) {
    const ports = m.udp.ports.filter((p) => a.udp.ports.includes(p));
    const multicast = m.udp.multicast.filter((g) => a.udp.multicast.includes(g));
    out.udp = { ports, multicast, ...(m.udp.broadcast === true && a.udp.broadcast === true ? { broadcast: true } : {}) };
  }
  if (m.mdns && a.mdns) out.mdns = { services: m.mdns.services.filter((s) => a.mdns.services.includes(s)) };
  if (m.tcp && a.tcp) out.tcp = { lan: m.tcp.lan === true && a.tcp.lan === true };
  if (m.http && a.http) out.http = { lan: m.http.lan === true && a.http.lan === true };
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
 * { id, version, entry, entryDir, minGateway, memoryMb, capabilities, optionalCapabilities }.
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
  const optionalCapabilities = validateOptionalCaps(e.optionalCapabilities, capabilities);
  return { id: manifest.id, version: manifest.version, entry, entryDir, minGateway, memoryMb, capabilities, optionalCapabilities };
}

module.exports = {
  ManifestError, validateCaps, validateOptionalCaps, withOptional, intersectCaps, validateEdgeManifest, compareVersions, parseSemver, multicastAllowed,
  MDNS_GROUP, SERIAL_NAMES,
};
