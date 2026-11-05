'use strict';

// Geräte im eigenen LAN finden – ohne Raw-Sockets: Das Gateway schickt jedem
// Host eine kleine Unicast-mDNS-Anfrage (Rückwärtsauflösung der eigenen
// Adresse, UDP 5353). Dafür muss der Kernel die MAC per ARP auflösen; ein
// schon bekannter (veralteter) Eintrag wird dabei per Unicast-ARP nachgeprüft
// (DELAY → PROBE). Danach liest das Gateway die Nachbartabelle
// (`ip -j -4 neigh`): REACHABLE = hat gerade geantwortet. Antwortet das
// Gerät zusätzlich per mDNS, kommt sein Name gleich mit.
//
// Ohne `ip` (Entwicklungsrechner) bleibt /proc/net/arp: vollständige Einträge
// zählen dann als online (gröber, Zustand „degraded“ in der Telemetrie).

const dgram = require('node:dgram');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { parseArp } = require('../discovery/tcpSweep');
const { normalizeMac } = require('../features/config');
const dnsWire = require('./dnsWire');

const MDNS_PORT = 5353;
const NB_PORT = 137;
// DELAY (5 s) + erste Unicast-Probe (1 s) + Reserve: danach ist ein lebendes
// Gerät REACHABLE, ein totes noch in PROBE oder schon FAILED.
const PROBE_WAIT_MS = 6500;
// Höchstens so viele offene ARP-Auflösungen auf einmal (Kernel gc_thresh3 = 1024).
const CHUNK = 256;

const sleepReal = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

function execText(bin, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/** `ip -j -4 neigh` → [{ ip, mac, state }] (state in Großbuchstaben, z. B. REACHABLE). */
function parseIpNeighJson(text) {
  if (String(text).trim() === '') return []; // leere Tabelle: manche iproute2-Versionen geben gar nichts aus
  let arr;
  try { arr = JSON.parse(text); } catch (_e) { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const e of arr) {
    if (!e || typeof e.dst !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(e.dst)) continue;
    const states = Array.isArray(e.state) ? e.state : (typeof e.state === 'string' ? [e.state] : []);
    out.push({ ip: e.dst, mac: normalizeMac(e.lladdr || ''), state: String(states[0] || '').toUpperCase(), dev: e.dev || null });
  }
  return out;
}

/** Name aus mDNS/NetBIOS/DNS säubern: erstes Label, druckbar, ≤ 63 Zeichen. */
function cleanHostname(name) {
  if (typeof name !== 'string') return null;
  let n = name.replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(n)) return null;
  n = n.split('.')[0];
  n = n.replace(/[^\p{L}\p{N} _'’()-]/gu, '').trim().slice(0, 63);
  return n || null;
}

function createScanner({
  exec = execText,
  readArpFile = () => fs.readFileSync('/proc/net/arp', 'utf8'),
  createSocket = () => dgram.createSocket('udp4'),
  sleep = sleepReal,
  probeWaitMs = PROBE_WAIT_MS,
  chunk = CHUNK,
} = {}) {
  let lock = Promise.resolve();
  let mode = null; // 'ip' | 'proc'

  function serial(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  async function readNeighbors() {
    try {
      const parsed = parseIpNeighJson(await exec('ip', ['-j', '-4', 'neigh', 'show']));
      if (parsed) { mode = 'ip'; return parsed; }
    } catch (_e) { /* kein iproute2 → /proc */ }
    mode = 'proc';
    try {
      return [...parseArp(readArpFile()).entries()].map(([ip, mac]) => ({ ip, mac: normalizeMac(mac), state: 'REACHABLE', dev: null }));
    } catch (_e) {
      return [];
    }
  }

  /**
   * Unicast-Anfragen an `ips` (Port `port`, Nutzlast je IP aus `payloadFor`),
   * Antworten `windowMs` lang sammeln → Map(ip → [Buffer]).
   */
  async function udpRound(ips, { port, payloadFor, windowMs, bindIp }) {
    const replies = new Map();
    const allowed = new Set(ips);
    const sock = createSocket();
    sock.on('error', () => { /* einzelne Sendefehler (EHOSTUNREACH) sind normal */ });
    sock.on('message', (msg, rinfo) => {
      if (!rinfo || rinfo.port !== port || !allowed.has(rinfo.address)) return;
      const list = replies.get(rinfo.address) || [];
      if (list.length < 4) list.push(msg);
      replies.set(rinfo.address, list);
    });
    await new Promise((resolve) => {
      sock.once('error', resolve); // z. B. Adresse weg → nicht hängen bleiben
      try { sock.bind(0, bindIp || undefined, resolve); } catch (_e) { resolve(); }
    });
    for (let i = 0; i < ips.length; i++) {
      try { sock.send(payloadFor(ips[i], i), port, ips[i]); } catch (_e) { /* weiter */ }
    }
    await sleep(windowMs);
    try { sock.close(); } catch (_e) { /* schon zu */ }
    return replies;
  }

  /**
   * Prüft `ips` gezielt. → { online: Map(ip → mac), names: Map(ip → name), responders: Set(ip) }
   */
  async function probeUnlocked(ips, { bindIp } = {}) {
    const replies = await udpRound(ips, {
      port: MDNS_PORT,
      bindIp,
      windowMs: probeWaitMs,
      payloadFor: (ip, i) => dnsWire.encodeQuery((i + 1) & 0xffff, dnsWire.reverseName(ip), dnsWire.TYPE_PTR),
    });
    const names = new Map();
    for (const [ip, msgs] of replies) {
      for (const m of msgs) {
        const r = dnsWire.decodeResponse(m);
        const ptr = r && r.records.find((x) => x.type === 'PTR' && x.name === dnsWire.reverseName(ip));
        const n = ptr && cleanHostname(ptr.data);
        if (n) { names.set(ip, n); break; }
      }
    }
    const wanted = new Set(ips);
    const online = new Map();
    for (const e of await readNeighbors()) {
      if (!wanted.has(e.ip) || !e.mac) continue;
      if (e.state === 'REACHABLE' || replies.has(e.ip)) online.set(e.ip, e.mac);
    }
    return { online, names, responders: new Set(replies.keys()) };
  }

  function probe(ips, opts) {
    return serial(() => probeUnlocked(ips, opts));
  }

  /** Ganze Host-Liste in Häppchen prüfen (siehe CHUNK). */
  function sweep(hosts, opts = {}) {
    return serial(async () => {
      const online = new Map();
      const names = new Map();
      for (let i = 0; i < hosts.length; i += chunk) {
        const r = await probeUnlocked(hosts.slice(i, i + chunk), opts);
        for (const [k, v] of r.online) online.set(k, v);
        for (const [k, v] of r.names) names.set(k, v);
      }
      return { online, names };
    });
  }

  /** NetBIOS-Namen (Windows, Samba/NAS, manche Drucker). → Map(ip → name) */
  async function netbiosNames(ips, { bindIp, windowMs = 1500 } = {}) {
    if (!ips.length) return new Map();
    const replies = await udpRound(ips, {
      port: NB_PORT, bindIp, windowMs, payloadFor: (_ip, i) => dnsWire.encodeNbstatQuery((0x4000 + i) & 0xffff),
    });
    const out = new Map();
    for (const [ip, msgs] of replies) {
      for (const m of msgs) {
        const n = cleanHostname(dnsWire.decodeNbstatName(m));
        if (n) { out.set(ip, n); break; }
      }
    }
    return out;
  }

  return { readNeighbors, probe, sweep, netbiosNames, mode: () => mode };
}

module.exports = { createScanner, parseIpNeighJson, cleanHostname, PROBE_WAIT_MS };
