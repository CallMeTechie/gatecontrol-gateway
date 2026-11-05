'use strict';

// Speedtest gegen den eigenen GateControl-Server (Vertrag Phase 3a,
// Abschnitt 4 + Änderung Server-Seite 5): über die öffentliche serverUrl
// (nicht durch den Tunnel), mehrere parallele Streams, ≈ 10 s je Richtung.
// Die erste Sekunde (TCP-Anlauf) zählt nicht mit. Empfangene Daten werden
// sofort verworfen (kein Puffern → wenig RAM auf dem Pi).

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

async function phase(direction, { base, mod, agent, apiToken, o }) {
  const t0 = performance.now();
  const deadline = t0 + o.durationMs;
  let bytes = 0;
  let warm = null; // { t, bytes }
  const errors = [];
  const active = new Set();
  const over = () => performance.now() >= deadline - 5;

  const warmTimer = setTimeout(() => { warm = { t: performance.now(), bytes }; }, o.warmupMs);
  const stopTimer = setTimeout(() => { for (const r of active) r.destroy(); }, o.durationMs);

  function once() {
    return new Promise((resolve) => {
      const down = direction === 'down';
      const url = new URL(`${base}/api/v1/gateway/speedtest/${down ? `down?bytes=${o.downBytes}` : 'up'}`);
      const headers = { Authorization: `Bearer ${apiToken}` };
      if (!down) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = String(o.upBytes); }
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        active.delete(req);
        if (err) errors.push(err);
        resolve(!err);
      };
      const req = mod.request(url, { method: down ? 'GET' : 'POST', agent, headers, timeout: o.requestTimeoutMs });
      active.add(req);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(over() ? null : (e.message === 'timeout' ? 'timeout' : 'network')));
      req.on('close', () => done(over() ? null : 'network'));
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { if (body.length < 512) body += c; });
          res.on('end', () => done(errorCode(res.statusCode, body)));
          res.on('error', () => done(`http_${res.statusCode}`));
          return;
        }
        if (down) res.on('data', (c) => { bytes += c.length; });
        else res.resume();
        res.on('end', () => done(null));
        res.on('error', () => done(over() ? null : 'network'));
        res.on('close', () => done(over() ? null : 'network'));
      });
      if (down) { req.end(); return; }
      let sent = 0;
      const pump = () => {
        while (sent < o.upBytes && !over() && !req.destroyed) {
          const n = Math.min(UP_CHUNK.length, o.upBytes - sent);
          const chunk = n === UP_CHUNK.length ? UP_CHUNK : UP_CHUNK.subarray(0, n);
          sent += n;
          const more = req.write(chunk, (err) => { if (!err) bytes += n; });
          if (!more) { req.once('drain', pump); return; }
        }
        if (sent >= o.upBytes) req.end();
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
  return { mbps, bytes, error: mbps === null ? (errors[0] || 'no_data') : null };
}

/**
 * → { at, downMbps, upMbps, bytes, streams, error? }
 */
async function runSpeedtest({ serverUrl, apiToken, now = Date.now, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const base = String(serverUrl).replace(/\/+$/, '');
  const mod = new URL(base).protocol === 'http:' ? http : https;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: o.streams });
  const at = now();
  try {
    const down = await phase('down', { base, mod, agent, apiToken, o });
    const up = await phase('up', { base, mod, agent, apiToken, o });
    const result = { at, downMbps: down.mbps, upMbps: up.mbps, bytes: down.bytes + up.bytes, streams: o.streams };
    const error = down.error || up.error;
    if (error) result.error = error;
    return result;
  } finally {
    agent.destroy();
  }
}

module.exports = { runSpeedtest, DEFAULTS };
