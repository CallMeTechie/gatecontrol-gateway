'use strict';

// HTTP-Server der Einrichtungsseite (docs/setup-page.md). Bewusst ohne
// Express und ohne fremde Dateien: drei feste Dateien, zwei JSON-Endpunkte.
//
// Schutz: nur Verbindungen aus dem Heimnetz (alles andere wird ohne Antwort
// geschlossen), Host-Kopfzeile nur lokale Namen/Adressen (DNS-Rebinding),
// keine weitergereichten Anfragen (Proxy-Kopfzeilen), Schreibzugriffe nur mit
// dem Token der Seite und gleicher Herkunft (CSRF), strenge CSP.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { isLanPeer, isAllowedHost } = require('./net');

const UI_DIR = path.join(__dirname, 'ui');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/setup.css': ['setup.css', 'text/css; charset=utf-8'],
  '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 2048;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'via'];

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createSetupServer({ controller, logger, port, altPort = null, allowedHosts = [], bind = null }) {
  const assets = {};
  for (const [url, [file, type]] of Object.entries(FILES)) assets[url] = { body: fs.readFileSync(path.join(UI_DIR, file)), type };

  function head(res, status, type, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      ...extra,
    });
  }
  function json(res, status, obj, extra) {
    head(res, status, 'application/json; charset=utf-8', extra);
    res.end(JSON.stringify(obj));
  }
  function text(res, status, msg) {
    head(res, status, 'text/plain; charset=utf-8');
    res.end(msg);
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { chunks.length = 0; resolve(null); return; } // Rest wird verworfen
        chunks.push(c);
      });
      req.on('end', () => {
        try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : null); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  /** Schreibzugriff nur von der Seite selbst: Token, JSON, gleiche Herkunft. */
  function writeAllowed(req) {
    if (!sameToken(req.headers['x-gc-setup'], controller.csrf)) return false;
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
    }
    return true;
  }

  async function handle(req, res) {
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      return text(res, 421, 'Open this page with the IP address of the device, e.g. http://192.168.1.20:' + port + '\n');
    }
    if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return text(res, 403, 'This page is only available directly in the home network.\n');
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (route === '/healthz') return text(res, 200, 'ok\n');
      if (assets[route]) {
        head(res, 200, assets[route].type);
        return res.end(req.method === 'HEAD' ? undefined : assets[route].body);
      }
      if (route === '/api/state') {
        return json(res, 200, await controller.snapshot({ recheck: url.searchParams.get('recheck') === '1' }));
      }
      return text(res, 404, 'Not found\n');
    }
    if (req.method === 'POST' && route === '/api/pair') {
      if (!writeAllowed(req)) { req.resume(); return json(res, 403, { ok: false, error: 'forbidden' }); }
      const body = await readJson(req);
      if (!body) return json(res, 400, { ok: false, error: 'bad_request' });
      const r = await controller.pair({ server: body.server, code: body.code });
      const { status = 200, ...out } = r;
      return json(res, r.ok ? 200 : status, out, r.retryAfterS ? { 'Retry-After': String(r.retryAfterS) } : undefined);
    }
    res.setHeader('Allow', 'GET, HEAD, POST');
    return text(res, 405, 'Method not allowed\n');
  }

  const servers = new Map(); // port → { server, sockets }

  function open(p) {
    return new Promise((resolve) => {
      const sockets = new Set();
      const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
        handle(req, res).catch((err) => {
          logger.warn({ err: err.message }, 'setup page: request failed');
          if (!res.headersSent) text(res, 500, 'Error\n'); else res.destroy();
        });
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 20_000;
      server.keepAliveTimeout = 5_000;
      server.maxConnections = 64;
      server.on('connection', (socket) => {
        // Nicht aus dem Heimnetz (öffentliche Adresse, Tunnel): ohne Antwort schließen.
        if (!isLanPeer({ remote: socket.remoteAddress, local: socket.localAddress }, controller.tunnel())) { socket.destroy(); return; }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      const done = (ok) => { if (ok) servers.set(p, { server, sockets }); resolve(ok); };
      const listen = (host, fallback) => {
        server.once('error', (err) => {
          if (fallback && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL')) return listen(fallback, null);
          logger.warn({ port: p, code: err.code }, 'setup page: port not available');
          done(false);
        });
        server.listen({ port: p, host, ipv6Only: false }, () => {
          server.removeAllListeners('error');
          server.on('error', (err) => logger.warn({ port: p, code: err.code }, 'setup page: server error'));
          logger.info({ port: server.address().port, mode: controller.mode() }, 'Setup page listening (home network only)');
          done(true);
        });
      };
      // Alle Adressen des Geräts: die Seite muss unter der Heimnetz-Adresse
      // erreichbar sein, bevor es einen Tunnel gibt. Wer anfragen darf,
      // entscheidet die Prüfung oben, nicht die Bindung.
      if (bind) listen(bind, null); else listen('::', '0.0.0.0');
    });
  }

  function close(p) {
    const e = servers.get(p);
    if (!e) return Promise.resolve();
    servers.delete(p);
    for (const sock of e.sockets) sock.destroy();
    return new Promise((resolve) => e.server.close(() => resolve()));
  }

  let chain = Promise.resolve();
  /** Port(s) öffnen oder schließen, je nachdem ob die Seite gerade sichtbar sein soll. */
  function sync() {
    chain = chain.then(async () => {
      const want = controller.visible();
      for (const p of [port, altPort]) {
        if (p === null || p === undefined) continue;
        if (want && !servers.has(p)) await open(p);
        else if (!want && servers.has(p)) { await close(p); logger.info({ port: p }, 'Setup page closed (status page switched off)'); }
      }
    }).catch((err) => logger.warn({ err: err.message }, 'setup page: sync failed'));
    return chain;
  }

  const off = controller.onChange(() => { sync(); });

  async function stop() {
    off();
    await chain;
    for (const p of [...servers.keys()]) await close(p);
  }

  return {
    start: sync,
    stop,
    /** tatsächlicher Port (Tests mit Port 0) */
    address: (p = port) => { const e = servers.get(p); return e ? e.server.address() : null; },
  };
}

module.exports = { createSetupServer, CSP };
