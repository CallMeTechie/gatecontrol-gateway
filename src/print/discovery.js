'use strict';

// Drucker und Scanner im LAN finden (docs/print.md): mDNS/DNS-SD nach
// _ipp._tcp / _ipps._tcp (Drucker, AirPrint/IPP Everywhere) und
// _uscan._tcp / _uscans._tcp (Scanner, eSCL/AirScan). Ein Gerät mit Drucker
// und Scanner nennt in beiden Diensten dieselbe UUID (TXT „UUID“); daran –
// sonst an der Adresse – werden die Dienste zusammengeführt.
//
// Viele Geräte (HP OfficeJet, Brother, Canon) antworten auf die PTR-Frage nur
// mit dem PTR – oder schicken SRV, TXT und A in getrennten Paketen, mit Namen
// in anderer Schreibweise. Die Einträge werden daher über alle Antworten
// hinweg ohne Rücksicht auf Groß-/Kleinschreibung gesammelt, und was fehlt
// (SRV/TXT des Dienstes, A des Rechners), wird gezielt nachgefragt.

const crypto = require('node:crypto');
const net = require('node:net');
const logger = require('../logger');
const { cleanText: clip, isRfc1918 } = require('./config');

const SERVICES = Object.freeze({
  '_ipp._tcp.local': { kind: 'printer', scheme: 'ipp' },
  '_ipps._tcp.local': { kind: 'printer', scheme: 'ipps' },
  '_uscan._tcp.local': { kind: 'scanner', scheme: 'http' },
  '_uscans._tcp.local': { kind: 'scanner', scheme: 'https' },
});
const TYPES = Object.keys(SERVICES);
const PATH_RE = /^[A-Za-z0-9/_.-]{0,64}$/;
const UUID_RE = /^[0-9a-f]{32}$/;
const MAX_DEVICES = 64;
const MAX_PACKETS = 500;      // Antworten je Suche und Adresse
const MAX_INSTANCES = 256;    // angekündigte Dienste
const MAX_HOSTS = 1024;       // A-Einträge (das Gateway hört allen mDNS-Verkehr im LAN)
const MAX_ADDRS = 8;          // Adressen je Rechnername
const MAX_FOLLOW = 48;        // Nachfragen je Runde
const PER_QUERY = 12;         // Fragen je Paket
const GROUP = '224.0.0.251';
const DROP_REASONS = Object.freeze(['incomplete', 'no_ipv4', 'other_subnet', 'not_private', 'bad_path', 'too_many']);

const lc = (s) => String(s || '').toLowerCase().replace(/\.$/, '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** Dienst-Typ eines Instanz-Namens (ohne Rücksicht auf die Schreibweise) oder null */
function typeOf(name) {
  const n = lc(name);
  return TYPES.find((t) => n.endsWith('.' + t)) || null;
}

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
  const s = String(name || '').replace(/\.$/, '');
  const t = typeOf(s);
  if (!t) return s;
  return s.slice(0, -(t.length + 1)).replace(/\\032/g, ' ').replace(/\\(.)/g, '$1');
}

// ─── Einträge sammeln ─────────────────────────────────────────────────

function newRecords() {
  return { ptr: new Map(), srv: new Map(), txt: new Map(), a: new Map(), aaaa: new Set() };
}

/** Ein Antwort-Paket in die Sammlung (Schlüssel klein geschrieben; Abschiede mit TTL 0 zählen nicht). */
function addPacket(r, p) {
  if (!p || typeof p !== 'object') return;
  for (const rec of [...arr(p.answers), ...arr(p.additionals), ...arr(p.authorities)]) {
    if (!rec || typeof rec.name !== 'string' || rec.ttl === 0) continue;
    const key = lc(rec.name);
    if (rec.type === 'PTR') {
      if (typeof rec.data !== 'string' || !TYPES.includes(key)) continue;
      const inst = rec.data.replace(/\.$/, '');
      if (typeOf(inst) !== key) continue;
      if (!r.ptr.has(lc(inst)) && r.ptr.size < MAX_INSTANCES) r.ptr.set(lc(inst), inst);
    } else if (rec.type === 'SRV') {
      const d = rec.data;
      if (!d || !Number.isInteger(d.port) || typeof d.target !== 'string' || !typeOf(key)) continue;
      if (!r.srv.has(key) && r.srv.size >= MAX_INSTANCES) continue;
      r.srv.set(key, { name: rec.name.replace(/\.$/, ''), port: d.port, target: lc(d.target), targetName: d.target.replace(/\.$/, '') });
    } else if (rec.type === 'TXT') {
      if (!typeOf(key) || (!r.txt.has(key) && r.txt.size >= MAX_INSTANCES)) continue;
      r.txt.set(key, txtOf(rec.data));
    } else if (rec.type === 'A') {
      if (typeof rec.data !== 'string' || !net.isIPv4(rec.data)) continue;
      let list = r.a.get(key);
      if (!list) {
        if (r.a.size >= MAX_HOSTS) continue;
        list = [];
        r.a.set(key, list);
      }
      if (!list.includes(rec.data) && list.length < MAX_ADDRS) list.push(rec.data);
    } else if (rec.type === 'AAAA') {
      if (r.aaaa.size < MAX_HOSTS) r.aaaa.add(key);
    }
  }
}

function collect(packets) {
  const r = newRecords();
  for (const p of packets || []) addPacket(r, p);
  return r;
}

/**
 * Was noch fehlt → Fragen: SRV und TXT jedes angekündigten Dienstes ohne
 * sie, A jedes Rechners ohne IPv4-Adresse (ein Rechner nur mit AAAA wird
 * nach A gefragt; IPv6 allein wird nicht benutzt).
 */
function followUps(r) {
  const out = [];
  const seen = new Set();
  const want = (name, type) => {
    const k = type + ' ' + lc(name);
    if (seen.has(k) || out.length >= MAX_FOLLOW) return;
    seen.add(k);
    out.push({ name, type });
  };
  for (const [k, name] of r.ptr) {
    if (!r.srv.has(k)) want(name, 'SRV');
    if (!r.txt.has(k)) want(name, 'TXT');
  }
  for (const s of r.srv.values()) if (!r.a.has(s.target)) want(s.targetName, 'A');
  return out;
}

// ─── Diagnose ──────────────────────────────────────────────────────────

function newStats() {
  return { responses: 0, services: 0, resolved: 0, devices: 0, pending: new Map(), kept: new Set() };
}

/** Ein Dienst fällt weg – gezählt wird je Gerät (Instanzname), und erst am Ende, wenn kein anderer Dienst es gerettet hat. */
function pend(stats, label, reason, ip = null) {
  if (!stats || stats.pending.has(label)) return;
  stats.pending.set(label, { reason, ip });
}

function finishStats(stats) {
  const dropped = {};
  const hosts = [];
  for (const [label, d] of stats.pending) {
    if (stats.kept.has(label)) continue;
    dropped[d.reason] = (dropped[d.reason] || 0) + 1;
    if (d.ip && hosts.length < 8 && !hosts.some((h) => h.ip === d.ip)) hosts.push({ ip: d.ip, reason: d.reason, name: clip(label, 120) });
  }
  return { responses: stats.responses, services: stats.services, resolved: stats.resolved, devices: stats.devices, dropped, hosts };
}

// ─── Dienste und Geräte ────────────────────────────────────────────────

/** Die bevorzugte Adresse eines Rechners: die erste private (RFC 1918), sonst die erste. */
function preferred(ips) { return ips.find(isRfc1918) || ips[0]; }

/**
 * mDNS-Antworten → Dienste [{ kind, scheme, ip, ips, port, path, txt, instance }].
 * Nur Dienste mit SRV und IPv4-Adresse; Pfad aus TXT rp (IPP) / rs (eSCL), geprüft.
 */
function mapServices(packets, stats = null) {
  const r = collect(packets);
  const names = new Map(r.ptr);
  for (const [k, s] of r.srv) if (!names.has(k)) names.set(k, s.name);
  const out = [];
  for (const [key, name] of names) {
    const type = typeOf(key);
    const label = instanceLabel(name);
    const s = r.srv.get(key);
    if (!s || s.port < 1 || s.port > 65535) { pend(stats, label, 'incomplete'); continue; }
    const ips = r.a.get(s.target) || [];
    if (!ips.length) { pend(stats, label, r.aaaa.has(s.target) ? 'no_ipv4' : 'incomplete'); continue; }
    const t = r.txt.get(key) || {};
    const def = SERVICES[type];
    const rawPath = def.kind === 'printer' ? (t.rp != null ? t.rp : 'ipp/print') : (t.rs != null ? t.rs : 'eSCL');
    const path = String(rawPath).replace(/^\/+/, '');
    if (!PATH_RE.test(path) || path.includes('..')) { pend(stats, label, 'bad_path'); continue; }
    out.push({ kind: def.kind, scheme: def.scheme, ip: preferred(ips), ips: ips.slice(), port: s.port, path, txt: t, instance: label });
  }
  if (stats) { stats.services = names.size; stats.resolved = out.length; }
  return out;
}

const PRIO = { ipp: 2, ipps: 1, http: 2, https: 1 };

/**
 * Dienste → Geräte (nach UUID, sonst Adresse). Je Gerät höchstens ein
 * Drucker- und ein Scanner-Endpunkt (ipp vor ipps, http vor https – im LAN
 * ohne Zertifikatsärger). isAllowed(ip) entscheidet über jede Adresse; von
 * mehreren Adressen eines Geräts (LAN und Wi-Fi Direct) gilt die erste erlaubte.
 */
function mergeDevices(services, isAllowed = () => true, stats = null) {
  const byKey = new Map();
  for (const s of services) {
    const ips = Array.isArray(s.ips) && s.ips.length ? s.ips : [s.ip];
    const ip = ips.find((x) => isAllowed(x));
    if (!ip) {
      const priv = ips.find(isRfc1918);
      pend(stats, s.instance, priv ? 'other_subnet' : 'not_private', priv || ips[0]);
      continue;
    }
    const uuid = normUuid(s.txt.uuid);
    const key = uuid ? 'u:' + uuid : 'ip:' + ip;
    let d = byKey.get(key);
    if (!d) {
      // ein Gerät ohne UUID im einen Dienst, mit UUID im anderen: über die Adresse finden
      d = [...byKey.values()].find((x) => x.ip === ip && (!uuid || !x.uuid)) || null;
      if (!d) {
        if (new Set(byKey.values()).size >= MAX_DEVICES) { pend(stats, s.instance, 'too_many'); continue; }
        d = { uuid, ip, name: '', model: '', location: '', ipp: null, escl: null, hints: {} };
      }
      byKey.set(key, d);
    }
    if (stats) stats.kept.add(s.instance);
    if (uuid && !d.uuid) d.uuid = uuid;
    const t = s.txt;
    if (!d.name) d.name = clip(s.instance, 120);
    if (!d.model) d.model = clip(t.ty || t.product || '', 120).replace(/^\((.*)\)$/, '$1');
    if (!d.location) d.location = clip(t.note || '', 120);
    const ep = { scheme: s.scheme, host: ip, port: s.port, path: s.path };
    if (s.kind === 'printer') {
      if (!d.ipp || PRIO[s.scheme] > PRIO[d.ipp.scheme]) d.ipp = ep;
      if (t.color) d.hints.color = /^t/i.test(t.color);
      if (t.duplex) d.hints.duplex = /^t/i.test(t.duplex);
      if (t.pdl) d.hints.formats = t.pdl.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 24);
    } else if (!d.escl || PRIO[s.scheme] > PRIO[d.escl.scheme]) d.escl = ep;
  }
  const out = [];
  for (const d of new Set(byKey.values())) out.push({ ...d, id: deviceId(d.uuid, d.ip) });
  if (stats) stats.devices = out.length;
  return out;
}

/** Antworten → { devices, stats } (stats: Antworten, Dienste, Geräte, Verworfenes mit Grund). */
function analyze(packets, isAllowed = () => true) {
  const stats = newStats();
  stats.responses = (packets || []).length;
  const devices = mergeDevices(mapServices(packets, stats), isAllowed, stats);
  return { devices, stats: finishStats(stats) };
}

// ─── Sockets ───────────────────────────────────────────────────────────

const QUESTIONS = TYPES.map((name) => ({ name, type: 'PTR' }));

/**
 * Auf einer LAN-Adresse nach den vier Diensten fragen; → Antwort-Pakete.
 *
 * Zwei Wege, damit es neben dem mDNS-Dienst des Hosts (avahi/Bonjour auf
 * Synology, QNAP, Raspberry Pi OS) klappt:
 *  1. ein Socket auf Port 5353 (SO_REUSEADDR, geteilt mit avahi), gebunden an
 *     0.0.0.0 – nicht an die LAN-Adresse: unter Linux bekommt ein an eine
 *     Unicast-Adresse gebundener Socket keine Multicast-Antworten. Die
 *     LAN-Adresse wählt nur die Gruppe und die ausgehende Schnittstelle.
 *  2. eine „Legacy Unicast“-Frage von einem freien Port (RFC 6762 §6.7): die
 *     Geräte antworten direkt an diesen Port – unabhängig davon, wer Port
 *     5353 sonst noch belegt.
 * Nach 1 s wird gefragt wie zu Beginn (Drucker im Stromsparmodus), danach
 * zweimal gezielt nach dem, was noch fehlt (followUps).
 * `diag` (optional): { errors: [], responders: Set } – wird ergänzt.
 */
function browse({ ifaceIp, timeoutMs = 4000, factory = null, port = 5353, diag = null }) {
  return new Promise((resolve) => {
    const packets = [];
    if (!ifaceIp) { resolve(packets); return; }
    const make = factory || require('multicast-dns');
    const records = newRecords();
    const sockets = new Set();
    const timers = [];
    let finished = false;
    const note = (code) => { if (diag && Array.isArray(diag.errors) && diag.errors.length < 8 && !diag.errors.includes(code)) diag.errors.push(code); };
    const close = (m) => { sockets.delete(m); try { m.destroy(); } catch (_e) { /* schon zu */ } };
    const done = () => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      for (const m of [...sockets]) close(m);
      resolve(packets);
    };
    const open = (opts, label) => {
      let m;
      try { m = make(opts); } catch (err) {
        logger.debug({ err: err.message, way: label }, 'print: mdns init failed');
        note(label + '_failed');
        return;
      }
      sockets.add(m);
      m.on('response', (p, rinfo) => {
        if (finished || packets.length >= MAX_PACKETS) return;
        packets.push(p);
        addPacket(records, p);
        if (diag && diag.responders instanceof Set && rinfo && typeof rinfo.address === 'string' && diag.responders.size < 256) diag.responders.add(rinfo.address);
      });
      m.on('warning', (err) => logger.debug({ err: err && err.message, way: label }, 'print: mdns warning'));
      m.on('error', (err) => {
        logger.debug({ err: err && err.message, way: label }, 'print: mdns error');
        note(label + (err && err.code === 'EADDRINUSE' ? '_port_busy' : '_failed'));
        close(m);
        if (!sockets.size) done();
      });
    };
    open({ interface: ifaceIp, bind: '0.0.0.0', port, multicast: true, reuseAddr: true }, 'mdns');
    open({ interface: ifaceIp, port: 0, multicast: true }, 'legacy');
    if (!sockets.size) { done(); return; }
    const ask = (questions) => {
      if (finished || !questions.length) return;
      for (const m of sockets) {
        for (let i = 0; i < questions.length; i += PER_QUERY) {
          try { m.query({ questions: questions.slice(i, i + PER_QUERY) }, { port, address: GROUP }); } catch (_e) { /* zu */ }
        }
      }
    };
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    ask(QUESTIONS);
    // ein zweites Mal – manche Drucker im Stromsparmodus antworten erst darauf
    at(Math.min(1000, timeoutMs / 4), () => ask(QUESTIONS));
    at(timeoutMs * 0.4, () => ask(followUps(records)));
    at(timeoutMs * 0.7, () => ask(followUps(records)));
    at(timeoutMs, done);
  });
}

module.exports = {
  mapServices, mergeDevices, analyze, collect, followUps, browse, txtOf, normUuid, deviceId, instanceLabel, typeOf,
  SERVICES, MAX_DEVICES, DROP_REASONS,
};
