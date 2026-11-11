'use strict';

// Speedtest gegen den eigenen GateControl-Server (Vertrag Phase 3a,
// Abschnitt 4 + Änderung Server-Seite 5): über die öffentliche serverUrl
// (nicht durch den Tunnel), mehrere parallele Streams, ≈ 10 s je Richtung.
// Die erste Sekunde (TCP-Anlauf) zählt nicht mit. Empfangene Daten werden
// sofort verworfen (kein Puffern → wenig RAM auf dem Pi).
//
// Volumen begrenzen: `maxDownBytes` / `maxUpBytes` deckeln das Volumen je
// Richtung (alle Streams zusammen), `maxTotalBytes` beide Richtungen zusammen
// (Download höchstens die Hälfte, Upload was danach bleibt). Ist der Deckel
// erreicht, endet die Richtung vor Ablauf der Zeit – gemessen wird über die
// Zeit bis dahin. Der Server kürzt einen Download von sich aus (weniger Bytes
// als verlangt); den Upload bestimmt das Gateway, deshalb gilt der Deckel hier
// für beide Richtungen.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const DEFAULTS = Object.freeze({
  streams: 4,
  durationMs: 10_000,
  warmupMs: 1_000,
  downBytes: 25_000_000,
  upBytes: 8_000_000,
  requestTimeoutMs: 15_000,
  maxDownBytes: null, // Deckel je Richtung über alle Streams (null = nur die Zeit begrenzt)
  maxUpBytes: null,
  maxTotalBytes: null, // Deckel für beide Richtungen zusammen (Rest des Tagesbudgets)
});

const UP_CHUNK = crypto.randomBytes(64 * 1024); // nicht komprimierbar

// Fehlercodes des Servers (Vertrag: 429 busy/budget) auf feste Werte abbilden –
// nichts aus der Antwort landet ungeprüft im Puffer oder in der Telemetrie.
const KNOWN_ERRORS = Object.freeze({ busy: 'busy', budget: 'budget', unauthorized: 'unauthorized', forbidden: 'forbidden' });

function errorCode(status, body) {
  try {
    const j = JSON.parse(body);
    if (j && typeof j.error === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ERRORS, j.error)) return KNOWN_ERRORS[j.error];
  } catch (_e) { /* kein JSON */ }
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'busy';
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

/** `Retry-After: <Sekunden>` einer 429-Antwort → Sekunden (1 … 86400) oder null. */
function retryAfterSec(res) {
  const v = res.headers ? res.headers['retry-after'] : null;
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 86_400 ? n : null;
}

/** Deckel einer Richtung: positive ganze Zahl, sonst null (kein Deckel). */
function capOf(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Der kleinere zweier Deckel (null = keiner). */
function minCap(a, b) {
  if (a === null) return b;
  return b === null ? a : Math.min(a, b);
}

async function phase(direction, { base, mod, agent, apiToken, o, cap }) {
  const t0 = performance.now();
  const deadline = t0 + o.durationMs;
  const down = direction === 'down';
  const perRequest = down ? o.downBytes : o.upBytes;
  let bytes = 0;
  let planned = 0; // für laufende und fertige Anfragen vorgesehen (gegen den Deckel)
  let limited = false;
  let refused = null; // { retryAfterS } – der Server hat „budget“ gemeldet
  let warm = null; // { t, bytes }
  const errors = [];
  const active = new Set();
  const timeUp = () => performance.now() >= deadline - 5;
  const full = () => cap !== null && planned >= cap;
  const over = () => timeUp() || full();

  const warmTimer = setTimeout(() => { warm = { t: performance.now(), bytes }; }, o.warmupMs);
  const stopTimer = setTimeout(() => { for (const r of active) r.destroy(); }, o.durationMs);

  function once() {
    return new Promise((resolve) => {
      // so viel wie üblich, höchstens der Rest bis zum Deckel
      const want = cap === null ? perRequest : Math.min(perRequest, cap - planned);
      planned += want;
      if (cap !== null && planned >= cap) limited = true;
      let got = 0; // tatsächlich übertragen (der Server darf einen Download kürzen)
      const url = new URL(`${base}/api/v1/gateway/speedtest/${down ? `down?bytes=${want}` : 'up'}`);
      const headers = { Authorization: `Bearer ${apiToken}` };
      if (!down) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = String(want); }
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        active.delete(req);
        planned -= Math.max(0, want - got); // nicht Übertragenes zählt nicht gegen den Deckel
        if (err) errors.push(err);
        resolve(!err);
      };
      const req = mod.request(url, { method: down ? 'GET' : 'POST', agent, headers, timeout: o.requestTimeoutMs });
      active.add(req);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(timeUp() ? null : (e.message === 'timeout' ? 'timeout' : 'network')));
      req.on('close', () => done(timeUp() ? null : 'network'));
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { if (body.length < 512) body += c; });
          res.on('end', () => {
            const code = errorCode(res.statusCode, body);
            if (code === 'budget') refused = { retryAfterS: retryAfterSec(res) };
            done(code);
          });
          res.on('error', () => done(`http_${res.statusCode}`));
          return;
        }
        if (down) res.on('data', (c) => { bytes += c.length; got += c.length; });
        else res.resume();
        res.on('end', () => done(null));
        res.on('error', () => done(timeUp() ? null : 'network'));
        res.on('close', () => done(timeUp() ? null : 'network'));
      });
      if (down) { req.end(); return; }
      let sent = 0;
      const pump = () => {
        while (sent < want && !timeUp() && !req.destroyed) {
          const n = Math.min(UP_CHUNK.length, want - sent);
          const chunk = n === UP_CHUNK.length ? UP_CHUNK : UP_CHUNK.subarray(0, n);
          sent += n;
          const more = req.write(chunk, (err) => { if (!err) { bytes += n; got += n; } });
          if (!more) { req.once('drain', pump); return; }
        }
        if (sent >= want) req.end();
      };
      pump();
    });
  }

  async function stream() {
    while (!over()) {
      if (!(await once())) break; // Fehler (429 busy/budget, 401 …): diesen Stream beenden
    }
  }

  await Promise.all(Array.from({ length: o.streams }, stream));
  clearTimeout(warmTimer);
  clearTimeout(stopTimer);
  const tEnd = Math.min(performance.now(), deadline);
  const from = warm || { t: t0, bytes: 0 };
  const secs = (tEnd - from.t) / 1000;
  const counted = bytes - from.bytes;
  const mbps = secs > 0.5 && counted > 0 ? Math.round(((counted * 8) / secs / 1e6) * 10) / 10 : null;
  return { mbps, bytes, error: mbps === null ? (errors[0] || 'no_data') : null, limited: limited && !timeUp(), refused };
}

/**
 * → { at, downMbps, upMbps, bytes, streams, error?, limited? }
 * `limited`: eine Richtung endete am Volumen-Deckel statt nach der Zeit.
 * Nicht aufzählbar (geht nicht in Puffer und Bericht): `refused` =
 * { retryAfterS } – der Server hat einen Stream mit „budget“ abgelehnt.
 */
async function runSpeedtest({ serverUrl, apiToken, now = Date.now, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const base = String(serverUrl).replace(/\/+$/, '');
  const mod = new URL(base).protocol === 'http:' ? http : https;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: o.streams });
  const at = now();
  try {
    const total = capOf(o.maxTotalBytes);
    const down = await phase('down', { base, mod, agent, apiToken, o, cap: minCap(capOf(o.maxDownBytes), total === null ? null : Math.max(1, Math.floor(total / 2))) });
    const up = await phase('up', { base, mod, agent, apiToken, o, cap: minCap(capOf(o.maxUpBytes), total === null ? null : Math.max(1, total - down.bytes)) });
    const result = { at, downMbps: down.mbps, upMbps: up.mbps, bytes: down.bytes + up.bytes, streams: o.streams };
    const error = down.error || up.error;
    if (error) result.error = error;
    if (down.limited || up.limited) result.limited = true;
    const refused = down.refused || up.refused;
    if (refused) Object.defineProperty(result, 'refused', { value: refused, enumerable: false });
    return result;
  } finally {
    agent.destroy();
  }
}

module.exports = { runSpeedtest, DEFAULTS };
