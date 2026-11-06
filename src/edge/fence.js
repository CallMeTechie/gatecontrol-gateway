'use strict';

// Netzgrenze aus Sicht des Edge-Containers (fail closed): Plugin-Prozesse
// starten nur, wenn (1) der Gateway-Container eine frische Markerdatei
// geschrieben hat (Regeln gesetzt, welches Backend, für welche UID) UND
// (2) eine Probe zeigt, dass die Regeln für diesen Prozess wirklich greifen:
// ein UDP-Datagramm an eine Adresse außerhalb des LAN (192.0.2.1, TEST-NET-1)
// muss mit EPERM abgewiesen werden – genau das tut eine DROP-Regel im
// OUTPUT-Pfad für lokal erzeugte Pakete. IPv6 muss ebenfalls zu sein (EPERM
// oder gar keine Route).

//
// Zweiter Weg (ab Edge-Host 1.1.0, neue Compose-Datei): der Edge-Container
// läuft mit `network_mode: none` und hat gar kein Netz – dann braucht es
// keine Netzgrenze (kein Kernel-Modul, kein xt_owner auf der Synology).
// checkIsolation() bestätigt das selbst: außer Loopback keine Schnittstelle,
// und dieselbe Probe scheitert mangels Route (ENETUNREACH). checkBoundary()
// entscheidet: isoliert → frei; sonst muss die Netzgrenze aktiv sein.

const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TIMING, EDGE_UID } = require('./constants');

const MARKER = 'fence.json';
const PROBE_V4 = '192.0.2.1';
const PROBE_V6 = '2001:db8::1';
const PROBE_PORT = 9;

function sendProbe(type, addr) {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket(type); } catch (e) { resolve(e.code || 'EAFNOSUPPORT'); return; }
    let settled = false;
    const done = (code) => { if (settled) return; settled = true; try { sock.close(); } catch { /* zu */ } resolve(code); };
    sock.on('error', (e) => { clearTimeout(t); done(e.code || 'ERROR'); });
    const t = setTimeout(() => done('TIMEOUT'), 2000);
    try {
      sock.send(Buffer.from('gc-edge-fence-probe'), PROBE_PORT, addr, (e) => { clearTimeout(t); done(e ? (e.code || 'ERROR') : 'SENT'); });
    } catch (e) { clearTimeout(t); done(e.code || 'ERROR'); }
  });
}

/** Probe: { v4: 'EPERM'|'SENT'|…, v6: … , blocked: bool } */
async function probe({ send = sendProbe } = {}) {
  const v4 = await send('udp4', PROBE_V4);
  const v6 = await send('udp6', PROBE_V6);
  const v6Closed = ['EPERM', 'EACCES', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EHOSTUNREACH'].includes(v6);
  return { v4, v6, blocked: (v4 === 'EPERM' || v4 === 'EACCES') && v6Closed };
}

function readMarker(runDir) {
  try {
    const raw = fs.readFileSync(path.join(runDir, MARKER), 'utf8');
    if (raw.length > 64 * 1024) return null;
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{active:boolean, backend:string|null, reason:string|null}>}
 */
async function checkFence({ runDir, uid = EDGE_UID, now = Date.now, maxAgeMs = TIMING.fenceMarkerMaxAgeMs, probeFn = probe }) {
  const m = readMarker(runDir);
  if (!m) return { active: false, backend: null, reason: 'no_marker' };
  const at = Date.parse(m.appliedAt);
  if (m.active !== true) return { active: false, backend: m.backend || null, reason: m.error ? String(m.error).slice(0, 120) : 'rules_not_active' };
  if (!Number.isFinite(at) || now() - at > maxAgeMs) return { active: false, backend: m.backend || null, reason: 'marker_stale' };
  if (m.uid !== uid) return { active: false, backend: m.backend || null, reason: 'uid_mismatch' };
  const p = await probeFn();
  if (!p.blocked) return { active: false, backend: m.backend || null, reason: `probe_${String(p.v4).toLowerCase()}` };
  return { active: true, backend: m.backend || null, reason: null };
}

// Ohne Netz gibt es keine Route (ENETUNREACH); EPERM/EACCES (Regel) oder
// fehlende Adresse/Familie zählen ebenfalls als zu. Nur 'SENT' heißt offen.
const CLOSED = ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPERM', 'EACCES'];

/** Schnittstellen mit einer Adresse außer Loopback (internal). */
function externalInterfaces(ifaces = os.networkInterfaces()) {
  return Object.entries(ifaces || {})
    .filter(([, addrs]) => (addrs || []).some((a) => a && a.internal !== true))
    .map(([name]) => name).sort();
}

/**
 * Hat dieser Container gar kein Netz (Compose: network_mode: none)?
 * @returns {Promise<{isolated:boolean, reason:string|null, interfaces:string[]}>}
 */
async function checkIsolation({ interfaces = () => os.networkInterfaces(), probeFn = probe } = {}) {
  const ext = externalInterfaces(interfaces());
  if (ext.length) return { isolated: false, reason: 'network_interfaces', interfaces: ext };
  const p = await probeFn();
  if (!CLOSED.includes(p.v4)) return { isolated: false, reason: `probe_${String(p.v4).toLowerCase()}`, interfaces: [] };
  if (!CLOSED.includes(p.v6)) return { isolated: false, reason: `probe6_${String(p.v6).toLowerCase()}`, interfaces: [] };
  return { isolated: true, reason: null, interfaces: [] };
}

/**
 * Darf ein Edge-Teil starten? Isoliert (kein Netz) oder Netzgrenze aktiv.
 * `mode`: 'isolated' (keine Schnittstelle außer Loopback) | 'fence' (Host-Netz).
 * @returns {Promise<{mode:'isolated'|'fence', active:boolean, backend:string|null, reason:string|null}>}
 */
async function checkBoundary({ runDir, interfaces, probeFn = probe, fenceFn = checkFence, ...rest } = {}) {
  const iso = await checkIsolation({ interfaces, probeFn });
  if (iso.isolated) return { mode: 'isolated', active: true, backend: 'isolated', reason: null };
  if (iso.reason !== 'network_interfaces') {
    // kein Netz zu sehen, aber die Probe kam durch – nicht freigeben
    return { mode: 'isolated', active: false, backend: null, reason: iso.reason };
  }
  const f = await fenceFn({ runDir, probeFn, ...rest });
  return { mode: 'fence', active: f.active, backend: f.backend, reason: f.reason };
}

module.exports = { checkFence, checkIsolation, checkBoundary, externalInterfaces, probe, readMarker, MARKER, PROBE_V4, PROBE_V6 };
