'use strict';

// Gefälschter GateControl-Server für den Zwischenspeicher: Vorrat (want),
// Blobs mit Range und Bericht (POST /cache).

const http = require('node:http');
const crypto = require('node:crypto');

async function startCacheServer({ token = 'gc_gw_' + 'b'.repeat(64) } = {}) {
  const blobs = new Map(); // sha → Buffer
  const state = { want: [], posts: [], blobGets: [], cutAfter: null, corrupt: new Set(), wantStatus: 200 };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/v1/gateway/cache/want') {
      res.writeHead(state.wantStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: state.want }));
    }
    const m = /^\/api\/v1\/gateway\/cache\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      let data = blobs.get(m[1]);
      state.blobGets.push({ sha: m[1], range: req.headers.range || null });
      if (!data) { res.writeHead(404); return res.end(); }
      if (state.corrupt.has(m[1])) { data = Buffer.from(data); data[0] ^= 0xff; }
      const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (r) {
        const start = Number(r[1]);
        if (start >= data.length) { res.writeHead(416); return res.end(); }
        res.writeHead(206, { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}`, 'content-length': data.length - start });
        return res.end(data.subarray(start));
      }
      if (state.cutAfter !== null) {
        // Verbindung mitten im Blob abbrechen (Fortsetzen testen)
        const cut = state.cutAfter;
        state.cutAfter = null;
        res.writeHead(200, { 'content-length': data.length });
        res.write(data.subarray(0, cut), () => setTimeout(() => res.socket.destroy(), 20));
        return undefined;
      }
      res.writeHead(200, { 'content-length': data.length });
      return res.end(data);
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/gateway/cache') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        state.posts.push(JSON.parse(b));
        const code = state.postStatus || 200;
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(code === 200 ? '{"ok":true}' : '{"error":"x"}');
      });
      return undefined;
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const add = (size, kind = 'updates', priority = 0) => {
    const data = crypto.randomBytes(size);
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    blobs.set(sha, data);
    return { sha256: sha, size, kind, priority, data };
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`, token, state, blobs, add,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { startCacheServer };
