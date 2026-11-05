'use strict';

// LAN-Abgabe des Zwischenspeichers (Vertrag Phase 3b §2.2):
//   GET|HEAD https://<LAN-IP>:8443/blob/<sha256>?exp=<unix>&sig=<hmac>
// Nur auf privaten LAN-Adressen (IPv4 RFC 1918, IPv6 ULA), nie Tunnel.
// Ohne gültige Signatur 403, fehlender Blob 404, Range (eine Spanne) → 206.

const https = require('node:https');
const fs = require('node:fs');
const { verify } = require('./signature');

const PATH_RE = /^\/blob\/([0-9a-f]{64})$/;
const MAX_CONN = 64;

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" → { start, end } | 'invalid' | null (kein Range) */
function parseRange(header, size) {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Request-Handler. ctx: { secret(), store, now(), counters }
 * counters: { hits, misses, bytesServed, denied }
 */
function makeHandler(ctx) {
  return function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    let url;
    try { url = new URL(req.url, 'https://gateway.invalid'); } catch (_e) { return sendJson(res, 400, { error: 'bad_request' }); }
    const m = PATH_RE.exec(url.pathname);
    if (!m) return sendJson(res, 404, { error: 'not_found' });
    const sha = m[1];
    const v = verify(ctx.secret(), sha, url.searchParams.get('exp'), url.searchParams.get('sig'), ctx.now());
    if (v !== 'ok') {
      ctx.counters.denied++;
      return sendJson(res, 403, { error: v === 'bad_request' ? 'bad_signature' : v });
    }
    if (!ctx.store.has(sha)) {
      ctx.counters.misses++;
      return sendJson(res, 404, { error: 'not_cached' });
    }
    let fd;
    try {
      fd = fs.openSync(ctx.store.filePath(sha), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (_e) {
      ctx.counters.misses++;
      return sendJson(res, 404, { error: 'not_cached' });
    }
    let size;
    try { size = fs.fstatSync(fd).size; } catch (_e) { fs.closeSync(fd); return sendJson(res, 500, { error: 'io' }); }
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      fs.closeSync(fd);
      return sendJson(res, 416, { error: 'range_not_satisfiable' }, { 'Content-Range': `bytes */${size}` });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size === 0 ? 0 : end - start + 1,
      'Accept-Ranges': 'bytes',
      ETag: `"${sha}"`,
      'Cache-Control': 'private, no-transform',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    ctx.counters.hits++;
    ctx.store.touch(sha);
    if (req.method === 'HEAD' || size === 0) { fs.closeSync(fd); res.end(); return undefined; }
    const rs = fs.createReadStream(null, { fd, start, end, autoClose: true, highWaterMark: 256 * 1024 });
    rs.on('data', (c) => { ctx.counters.bytesServed += c.length; });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return undefined;
  };
}

/** HTTPS-Server je Adresse; Port-Konflikt → 'port_busy'. */
class LanBlobServer {
  constructor({ handler, tls, port, addresses }) {
    Object.assign(this, { handler, tls, port, addresses });
    this.servers = new Map();
    this.busy = new Set();
    this.failed = new Map();
  }

  _listen(address) {
    return new Promise((resolve, reject) => {
      const srv = https.createServer({ key: this.tls.key, cert: this.tls.cert, minVersion: 'TLSv1.2' }, this.handler);
      srv.maxConnections = MAX_CONN;
      srv.headersTimeout = 10_000;
      srv.requestTimeout = 15_000;
      srv.keepAliveTimeout = 5_000;
      srv.setTimeout(60_000, (s) => s.destroy());
      srv.once('error', reject);
      srv.listen({ host: address, port: this.port, exclusive: true }, () => {
        srv.removeListener('error', reject);
        srv.on('error', () => {});
        resolve(srv);
      });
    });
  }

  async reconcile() {
    const want = new Set(this.addresses().map((a) => a.address));
    for (const [addr, srv] of this.servers) {
      if (!want.has(addr)) { srv.close(); srv.closeAllConnections?.(); this.servers.delete(addr); }
    }
    this.busy.clear();
    this.failed.clear();
    for (const addr of want) {
      if (this.servers.has(addr)) continue;
      try {
        this.servers.set(addr, await this._listen(addr));
      } catch (err) {
        if (err.code === 'EADDRINUSE') this.busy.add(addr); else this.failed.set(addr, err.code || 'error');
      }
    }
    return this.status();
  }

  status() {
    const listen = [...this.servers.keys()];
    let state = 'running';
    if (this.busy.size) state = 'port_busy';
    else if (!listen.length) state = this.failed.size ? 'error' : 'no_address';
    return { state, listen, busy: [...this.busy], port: this.port };
  }

  close() {
    for (const srv of this.servers.values()) { srv.close(); srv.closeAllConnections?.(); }
    this.servers.clear();
    this.busy.clear();
    this.failed.clear();
  }
}

module.exports = { makeHandler, LanBlobServer, parseRange };
