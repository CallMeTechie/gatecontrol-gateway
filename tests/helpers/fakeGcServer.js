'use strict';

// Gefälschter GateControl-Server für die Phase-3a-Tests: nimmt die Berichte
// (netwatch/inetq/presence) an und stellt die Speedtest-Endpunkte bereit
// (Vertrag Phase 3a, Änderung Server-Seite 5).

const http = require('node:http');
const crypto = require('node:crypto');

async function startFakeServer({ token = 'gc_gw_' + 'a'.repeat(64), maxStreams = 8, status = {}, streamBytesPerSec = 0 } = {}) {
  const posts = [];
  const counters = { down: 0, up: 0, active: 0, maxActive: 0, authFail: 0 };
  const block = crypto.randomBytes(64 * 1024);
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      counters.authFail++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/v1/gateway/speedtest/')) {
      if (status.speedtest) {
        res.writeHead(status.speedtest, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: status.speedtest === 429 ? 'busy' : 'nope' }));
      }
      if (counters.active >= maxStreams) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end('{"error":"busy"}');
      }
      counters.active++;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      const done = () => { counters.active--; };
      if (url.pathname.endsWith('/down') && req.method === 'GET') {
        const n = Math.min(100_000_000, Math.max(1, Number(url.searchParams.get('bytes')) || 25_000_000));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': n, 'Cache-Control': 'no-store' });
        let left = n;
        const pump = () => {
          while (left > 0) {
            const c = left >= block.length ? block : block.subarray(0, left);
            left -= c.length;
            counters.down += c.length;
            const pause = streamBytesPerSec ? (c.length / streamBytesPerSec) * 1000 : 0;
            const next = () => (pause ? setTimeout(pump, pause) : pump());
            if (!res.write(c)) { res.once('drain', next); return; }
            if (pause) { next(); return; }
          }
          res.end();
        };
        res.on('close', done);
        return pump();
      }
      if (url.pathname.endsWith('/up') && req.method === 'POST') {
        let got = 0;
        const t0 = Date.now();
        req.on('data', (c) => {
          got += c.length; counters.up += c.length;
          if (streamBytesPerSec) { req.pause(); setTimeout(() => req.resume(), (c.length / streamBytesPerSec) * 1000); }
        });
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, bytes: got, ms: Date.now() - t0 })); });
        req.on('close', done);
        return undefined;
      }
      done();
      res.writeHead(404); return res.end();
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = url.pathname;
      let parsed = null;
      try { parsed = JSON.parse(body || 'null'); } catch (_e) { /* leer */ }
      posts.push({ path, body: parsed });
      const code = status[path] || 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(code === 200 ? { ok: true } : { error: 'x' }));
    });
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token, posts, counters, status,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { startFakeServer };
