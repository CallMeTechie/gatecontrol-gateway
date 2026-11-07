'use strict';

// Vorrat und Blobs vom Server holen (Vertrag Phase 3b §2.2):
//   GET /api/v1/gateway/cache/want          → Vorrat [{ sha256, size, kind, priority }]
//   GET /api/v1/gateway/cache/blob/<sha256> → Inhalt (Range-fähig)
// Gateway-Token als Bearer wie die anderen Gateway-Endpunkte. Abgebrochene
// Downloads werden mit Range fortgesetzt; nach dem letzten Byte wird die
// sha256 über die ganze Datei geprüft.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { sha256File } = require('./store');
const { SHA_RE } = require('./signature');

const MAX_WANT_BYTES = 8 * 1024 * 1024;
const MAX_WANT_ITEMS = 20_000;
const MAX_BLOB = 64 * 1024 ** 3;
const IDLE_MS = 60_000;
const KIND_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const RETRY_DEFAULT_MS = 60_000;
const RETRY_MAX_MS = 3600_000;

class CacheFetchError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** Retry-After (Sekunden oder HTTP-Datum) → ms, 1 s … 1 h, ohne Angabe 60 s. */
function retryAfterMs(v, now = Date.now()) {
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw === undefined || raw === null || String(raw).trim() === '') return RETRY_DEFAULT_MS;
  const n = Number(raw);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(String(raw)) - now;
  if (!Number.isFinite(ms)) return RETRY_DEFAULT_MS;
  return Math.min(RETRY_MAX_MS, Math.max(1000, ms));
}

/** 429 vom Server: Lauf beenden, Retry-After abwarten (Server-Budget des Zwischenspeichers). */
function rateLimited(res) {
  res.resume();
  const e = new CacheFetchError('rate_limited', 'HTTP 429');
  e.retryAfterMs = retryAfterMs(res.headers['retry-after']);
  return e;
}

const agentFor = (u) => (u.protocol === 'https:' ? https : http);

function get(url, headers, { timeoutMs = IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = agentFor(u).get(u, { headers, timeout: timeoutMs, agent: false }, resolve);
    req.on('timeout', () => req.destroy(new CacheFetchError('timeout')));
    req.on('error', (e) => reject(e instanceof CacheFetchError ? e : new CacheFetchError('network', e.message)));
  });
}

/** Vorrat-Liste auswerten: `[…]`, `{ items: […] }` oder `{ want: […] }`. */
function parseWant(data) {
  const arr = Array.isArray(data) ? data : (data && (Array.isArray(data.items) ? data.items : Array.isArray(data.want) ? data.want : null));
  if (!arr) return null;
  const out = [];
  const seen = new Set();
  for (const x of arr.slice(0, MAX_WANT_ITEMS)) {
    if (!x || typeof x !== 'object') continue;
    const sha = typeof x.sha256 === 'string' ? x.sha256.toLowerCase() : '';
    if (!SHA_RE.test(sha) || seen.has(sha)) continue;
    if (!Number.isSafeInteger(x.size) || x.size <= 0 || x.size > MAX_BLOB) continue;
    if (typeof x.kind !== 'string' || !KIND_RE.test(x.kind)) continue;
    seen.add(sha);
    out.push({ sha256: sha, size: x.size, kind: x.kind, priority: Number.isFinite(x.priority) ? x.priority : 0 });
  }
  return out;
}

function makeCacheClient({ serverUrl, apiToken }) {
  const auth = { Authorization: `Bearer ${apiToken}` };

  async function want() {
    const res = await get(`${serverUrl}/api/v1/gateway/cache/want`, { ...auth, accept: 'application/json' });
    if (res.statusCode === 429) throw rateLimited(res);
    if (res.statusCode !== 200) { res.resume(); throw new CacheFetchError('http_status', `HTTP ${res.statusCode}`); }
    const chunks = [];
    let n = 0;
    for await (const c of res) {
      n += c.length;
      if (n > MAX_WANT_BYTES) { res.destroy(); throw new CacheFetchError('too_large'); }
      chunks.push(c);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { throw new CacheFetchError('bad_json'); }
    const items = parseWant(data);
    if (!items) throw new CacheFetchError('bad_want');
    return items;
  }

  /**
   * Blob nach `partFile` laden (fortsetzen, falls schon ein Teil da ist),
   * Größe und sha256 prüfen. → { fetched: Bytes dieses Laufs }
   */
  async function blob(sha, size, partFile, { onProgress = () => {}, signal = null } = {}) {
    if (!SHA_RE.test(sha)) throw new CacheFetchError('bad_sha');
    let have = 0;
    try {
      have = fs.statSync(partFile).size;
      if (have > size) { fs.rmSync(partFile, { force: true }); have = 0; }
    } catch (_e) { have = 0; }
    let fetched = 0;
    if (have < size) {
      const headers = { ...auth, accept: 'application/octet-stream' };
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await get(`${serverUrl}/api/v1/gateway/cache/blob/${sha}`, headers);
      let start;
      if (res.statusCode === 206 && have > 0) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(res.headers['content-range'] || ''));
        if (!m || Number(m[1]) !== have || (m[3] !== '*' && Number(m[3]) !== size)) { res.resume(); throw new CacheFetchError('bad_range'); }
        start = have;
      } else if (res.statusCode === 200) {
        start = 0;
      } else if (res.statusCode === 429) {
        throw rateLimited(res);
      } else if (res.statusCode === 416 && have > 0) {
        res.resume();
        fs.rmSync(partFile, { force: true });
        throw new CacheFetchError('range_not_satisfiable');
      } else {
        res.resume();
        throw new CacheFetchError(res.statusCode === 404 ? 'not_found' : 'http_status', `HTTP ${res.statusCode}`);
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && start + declared > size) { res.destroy(); throw new CacheFetchError('too_large'); }
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partFile, { flags: start ? 'a' : 'w', mode: 0o640 });
        let total = start;
        let failed = false;
        const fail = (e) => { if (failed) return; failed = true; res.destroy(); out.destroy(); reject(e); };
        if (signal) {
          if (signal.aborted) { fail(new CacheFetchError('aborted')); return; }
          signal.addEventListener('abort', () => fail(new CacheFetchError('aborted')), { once: true });
        }
        res.on('data', (c) => {
          total += c.length;
          fetched += c.length;
          if (total > size) { fail(new CacheFetchError('too_large')); return; }
          onProgress(total);
        });
        res.on('aborted', () => fail(new CacheFetchError('network', 'aborted')));
        res.on('error', (e) => fail(new CacheFetchError('network', e.message)));
        out.on('error', (e) => fail(new CacheFetchError('write', e.message)));
        out.on('finish', () => { if (!failed) resolve(); });
        res.pipe(out);
      });
      have = fs.statSync(partFile).size;
      if (have !== size) throw new CacheFetchError('short', `got ${have} of ${size}`);
    }
    const h = await sha256File(partFile);
    if (h !== sha) {
      fs.rmSync(partFile, { force: true });
      throw new CacheFetchError('sha256_mismatch');
    }
    return { fetched };
  }

  return { want, blob };
}

module.exports = { makeCacheClient, parseWant, retryAfterMs, CacheFetchError };
