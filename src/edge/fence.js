'use strict';

// Netzgrenze aus Sicht des Edge-Containers (fail closed): Plugin-Prozesse
// starten nur, wenn (1) der Gateway-Container eine frische Markerdatei
// geschrieben hat (Regeln gesetzt, welches Backend, für welche UID) UND
// (2) eine Probe zeigt, dass die Regeln für diesen Prozess wirklich greifen:
// ein UDP-Datagramm an eine Adresse außerhalb des LAN (192.0.2.1, TEST-NET-1)
// muss mit EPERM abgewiesen werden – genau das tut eine DROP-Regel im
// OUTPUT-Pfad für lokal erzeugte Pakete. IPv6 muss ebenfalls zu sein (EPERM
// oder gar keine Route).

const dgram = require('node:dgram');
const fs = require('node:fs');
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
    sock.on('error', () => {});
    const done = (code) => { try { sock.close(); } catch { /* zu */ } resolve(code); };
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

module.exports = { checkFence, probe, readMarker, MARKER, PROBE_V4, PROBE_V6 };
