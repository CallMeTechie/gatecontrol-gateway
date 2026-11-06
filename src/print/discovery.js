'use strict';

// Drucker und Scanner im LAN finden (docs/print.md): mDNS/DNS-SD nach
// _ipp._tcp / _ipps._tcp (Drucker, AirPrint/IPP Everywhere) und
// _uscan._tcp / _uscans._tcp (Scanner, eSCL/AirScan). Ein Gerät mit Drucker
// und Scanner nennt in beiden Diensten dieselbe UUID (TXT „UUID“); daran –
// sonst an der Adresse – werden die Dienste zusammengeführt.

const crypto = require('node:crypto');
const logger = require('../logger');

const SERVICES = Object.freeze({
  '_ipp._tcp.local': { kind: 'printer', scheme: 'ipp' },
  '_ipps._tcp.local': { kind: 'printer', scheme: 'ipps' },
  '_uscan._tcp.local': { kind: 'scanner', scheme: 'http' },
  '_uscans._tcp.local': { kind: 'scanner', scheme: 'https' },
});
const PATH_RE = /^[A-Za-z0-9/_.-]{0,64}$/;
const UUID_RE = /^[0-9a-f]{32}$/;
const MAX_DEVICES = 64;

function txtOf(data) {
  const out = {};
  const list = Array.isArray(data) ? data : [data];
  for (const b of list) {
    const s = Buffer.isBuffer(b) ? b.toString('utf8') : (typeof b === 'string' ? b : '');
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).toLowerCase();
    if (k.length > 32 || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = s.slice(i + 1).slice(0, 255);
  }
  return out;
}

const { cleanText: clip } = require('./config');

/** 'F0D8…-…' → 32 Hex-Zeichen klein, sonst null */
function normUuid(v) {
  const u = String(v || '').replace(/^urn:uuid:/i, '').replace(/-/g, '').toLowerCase();
  return UUID_RE.test(u) ? u : null;
}

/** Geräte-Id (Vertrag §2): 'u:<uuid>' oder 'h:<sha1(ip)>' */
function deviceId(uuid, ip) {
  if (uuid) return 'u:' + uuid;
  return 'h:' + crypto.createHash('sha1').update(String(ip)).digest('hex').slice(0, 16);
}

/** Instanzname „HP OfficeJet 8020 [A1B2C3]._ipp._tcp.local“ → „HP OfficeJet 8020 [A1B2C3]“ */
function instanceLabel(name) {
  const s = String(name || '');
  for (const t of Object.keys(SERVICES)) if (s.endsWith('.' + t)) return s.slice(0, -(t.length + 1)).replace(/\\032/g, ' ').replace(/\\(.)/g, '$1');
  return s;
}

/**
 * mDNS-Antworten → Dienste [{ kind, scheme, ip, port, path, txt, instance }].
 * Nur Dienste mit SRV und A-Adresse; Pfad aus TXT rp (IPP) / rs (eSCL), geprüft.
 */
function mapServices(packets) {
  const all = [];
  for (const p of packets || []) {
    if (!p) continue;
    for (const r of [...(p.answers || []), ...(p.additionals || [])]) if (r && typeof r.name === 'string') all.push(r);
  }
  const a = new Map();
  const srv = new Map();
  const txt = new Map();
  for (const r of all) {
    if (r.type === 'A' && typeof r.data === 'string') a.set(r.name.toLowerCase(), r.data);
    else if (r.type === 'SRV' && r.data && Number.isInteger(r.data.port)) srv.set(r.name, r.data);
    else if (r.type === 'TXT') txt.set(r.name, txtOf(r.data));
  }
  const out = [];
  const seen = new Set();
  for (const [name, s] of srv) {
    const type = Object.keys(SERVICES).find((t) => name.endsWith('.' + t));
    if (!type || seen.has(name)) continue;
    const ip = a.get(String(s.target || '').toLowerCase());
    if (!ip || s.port < 1 || s.port > 65535) continue;
    const t = txt.get(name) || {};
    const def = SERVICES[type];
    const rawPath = def.kind === 'printer' ? (t.rp != null ? t.rp : 'ipp/print') : (t.rs != null ? t.rs : 'eSCL');
    const path = String(rawPath).replace(/^\/+/, '');
    if (!PATH_RE.test(path) || path.includes('..')) continue;
    seen.add(name);
    out.push({ kind: def.kind, scheme: def.scheme, ip, port: s.port, path, txt: t, instance: instanceLabel(name) });
  }
  return out;
}

const PRIO = { ipp: 2, ipps: 1, http: 2, https: 1 };

/**
 * Dienste → Geräte (nach UUID, sonst Adresse). Je Gerät höchstens ein
 * Drucker- und ein Scanner-Endpunkt (ipp vor ipps, http vor https – im LAN
 * ohne Zertifikatsärger). isAllowed(ip) entscheidet über jede Adresse.
 */
function mergeDevices(services, isAllowed = () => true) {
  const byKey = new Map();
  for (const s of services) {
    if (!isAllowed(s.ip)) continue;
    const uuid = normUuid(s.txt.uuid);
    const key = uuid ? 'u:' + uuid : 'ip:' + s.ip;
    let d = byKey.get(key);
    if (!d) {
      // ein Gerät ohne UUID im einen Dienst, mit UUID im anderen: über die Adresse finden
      d = [...byKey.values()].find((x) => x.ip === s.ip && (!uuid || !x.uuid)) || null;
      if (!d) {
        if (byKey.size >= MAX_DEVICES) continue;
        d = { uuid, ip: s.ip, name: '', model: '', location: '', ipp: null, escl: null, hints: {} };
      }
      byKey.set(key, d);
    }
    if (uuid && !d.uuid) d.uuid = uuid;
    const t = s.txt;
    if (!d.name) d.name = clip(s.instance, 120);
    if (!d.model) d.model = clip(t.ty || t.product || '', 120).replace(/^\((.*)\)$/, '$1');
    if (!d.location) d.location = clip(t.note || '', 120);
    const ep = { scheme: s.scheme, host: s.ip, port: s.port, path: s.path };
    if (s.kind === 'printer') {
      if (!d.ipp || PRIO[s.scheme] > PRIO[d.ipp.scheme]) d.ipp = ep;
      if (t.color) d.hints.color = /^t/i.test(t.color);
      if (t.duplex) d.hints.duplex = /^t/i.test(t.duplex);
      if (t.pdl) d.hints.formats = t.pdl.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 24);
    } else if (!d.escl || PRIO[s.scheme] > PRIO[d.escl.scheme]) d.escl = ep;
  }
  const out = [];
  for (const d of new Set(byKey.values())) out.push({ ...d, id: deviceId(d.uuid, d.ip) });
  return out;
}

const QUESTIONS = Object.keys(SERVICES).map((name) => ({ name, type: 'PTR' }));

/** Auf einer LAN-Adresse nach den vier Diensten fragen; → Antwort-Pakete (Socket-Hülle, im Smoke-Test). */
function browse({ ifaceIp, timeoutMs = 4000, factory = null }) {
  return new Promise((resolve) => {
    const packets = [];
    if (!ifaceIp) return resolve(packets);
    let mdns;
    try {
      mdns = (factory || require('multicast-dns'))({ interface: ifaceIp, multicast: true });
    } catch (err) { logger.debug({ err: err.message }, 'print: mdns init failed'); return resolve(packets); }
    const done = () => { try { mdns.destroy(); } catch (_e) { /* already */ } resolve(packets); };
    mdns.on('response', (p) => { if (packets.length < 500) packets.push(p); });
    mdns.on('error', (err) => { logger.debug({ err: err.message }, 'print: mdns error'); done(); });
    mdns.query({ questions: QUESTIONS });
    // ein zweites Mal – manche Drucker im Stromsparmodus antworten erst darauf
    const again = setTimeout(() => { try { mdns.query({ questions: QUESTIONS }); } catch (_e) { /* destroyed */ } }, Math.min(1000, timeoutMs / 2));
    setTimeout(() => { clearTimeout(again); done(); }, timeoutMs);
  });
}

module.exports = { mapServices, mergeDevices, browse, txtOf, normUuid, deviceId, instanceLabel, SERVICES, MAX_DEVICES };
