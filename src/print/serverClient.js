'use strict';

// Die Server-Seite von „Drucken & Scannen“ (Vertrag Phase 3c §2), Gateway-
// Token als Bearer wie die anderen Gateway-Endpunkte:
//   GET /api/v1/gateway/print/jobs               Warteschlange (ETag)
//   GET /api/v1/gateway/print/jobs/<id>/file     Datei eines Auftrags
//   PUT /api/v1/gateway/print/scans/<id>/pages/<n>  eine gescannte Seite
//   GET /api/v1/gateway/print/ocr/<id>/pages/<n>    eine Seite für die Texterkennung
//   PUT /api/v1/gateway/print/ocr/<id>/document|text  ihr Ergebnis (PDF, Text)
// Berichte (Geräte, Zustände) gehen über den Reporter (JSON).

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { cleanText } = require('./config');

const MAX_LIST = 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const IDLE_MS = 60_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DEVICE_RE = /^[uh]:[0-9a-f]{16,32}$/;
const { TYPES: OFFICE_TYPES } = require('./office');

const FORMATS = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/urf', 'image/pwg-raster', ...Object.keys(OFFICE_TYPES)]);
const MEDIA_RE = /^[a-z0-9]+_[a-z0-9.-]+_[0-9.]+x[0-9.]+(mm|in)$/;
const SOURCE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_OCR_RESULT = 100 * 1024 * 1024;

class PrintClientError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const libFor = (u) => (u.protocol === 'https:' ? https : http);

function call(url, { method = 'GET', headers = {}, body = null, timeoutMs = IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = libFor(u).request(u, { method, headers, timeout: timeoutMs, agent: false }, resolve);
    req.on('timeout', () => req.destroy(new PrintClientError('timeout')));
    req.on('error', (e) => reject(e instanceof PrintClientError ? e : new PrintClientError('network', e.message)));
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body || undefined);
  });
}

async function readJson(res, max) {
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    n += c.length;
    if (n > max) { res.destroy(); throw new PrintClientError('too_large'); }
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { throw new PrintClientError('bad_json'); }
}

/** Auftragsliste prüfen (alles Server-Eingabe). */
function parseJobs(data) {
  const arr = data && Array.isArray(data.jobs) ? data.jobs : null;
  if (!arr) return null;
  const out = [];
  for (const j of arr.slice(0, 50)) {
    if (!j || typeof j !== 'object') continue;
    if (typeof j.id !== 'string' || !ID_RE.test(j.id)) continue;
    if (typeof j.deviceId !== 'string' || !DEVICE_RE.test(j.deviceId)) continue;
    if (!FORMATS.has(j.format)) continue;
    if (!Number.isSafeInteger(j.size) || j.size <= 0 || j.size > MAX_FILE) continue;
    if (typeof j.sha256 !== 'string' || !SHA_RE.test(j.sha256)) continue;
    out.push({
      id: j.id, deviceId: j.deviceId, format: j.format, size: j.size, sha256: j.sha256,
      copies: Number.isInteger(j.copies) ? Math.max(1, Math.min(99, j.copies)) : 1,
      color: j.color === true, duplex: j.duplex === true,
      name: cleanText(j.name, 120) || 'GateControl',
      user: cleanText(j.user, 60) || 'GateControl',
      expiresAt: Number.isSafeInteger(j.expiresAt) ? j.expiresAt : null,
      // Papier (PWG-Name) und Fach, wie die Person sie gewählt hat (null: Standard des Druckers)
      media: typeof j.media === 'string' && j.media.length <= 64 && MEDIA_RE.test(j.media) ? j.media : null,
      source: typeof j.source === 'string' && SOURCE_RE.test(j.source) ? j.source : null,
    });
  }
  return out;
}

function makePrintClient({ serverUrl, apiToken }) {
  const auth = { Authorization: `Bearer ${apiToken}` };

  /** → { changed: false } bei 304, sonst { changed: true, jobs, etag } */
  async function jobs(etag = null) {
    const headers = { ...auth, accept: 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    const res = await call(`${serverUrl}/api/v1/gateway/print/jobs`, { headers });
    if (res.statusCode === 304) { res.resume(); return { changed: false }; }
    if (res.statusCode !== 200) { res.resume(); throw new PrintClientError(res.statusCode === 404 ? 'not_supported' : 'http_status', `HTTP ${res.statusCode}`); }
    const list = parseJobs(await readJson(res, MAX_LIST));
    if (!list) throw new PrintClientError('bad_jobs');
    return { changed: true, jobs: list, etag: typeof res.headers.etag === 'string' ? res.headers.etag : null };
  }

  /** Datei eines Auftrags nach `dest` laden, Größe und sha256 prüfen. */
  async function file(id, sha256, size, dest) {
    if (!ID_RE.test(id)) throw new PrintClientError('bad_id');
    const res = await call(`${serverUrl}/api/v1/gateway/print/jobs/${id}/file`, { headers: { ...auth, accept: 'application/octet-stream' } });
    if (res.statusCode !== 200) { res.resume(); throw new PrintClientError(res.statusCode === 404 ? 'not_found' : 'http_status', `HTTP ${res.statusCode}`); }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared !== size) { res.destroy(); throw new PrintClientError('size_mismatch'); }
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      let n = 0;
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; res.destroy(); out.destroy(); reject(e); };
      res.on('data', (c) => { n += c.length; if (n > size) fail(new PrintClientError('too_large')); else hash.update(c); });
      res.on('aborted', () => fail(new PrintClientError('network', 'aborted')));
      res.on('error', (e) => fail(new PrintClientError('network', e.message)));
      out.on('error', (e) => fail(new PrintClientError('write', e.message)));
      out.on('finish', () => { if (failed) return; if (n !== size) reject(new PrintClientError('short')); else resolve(); });
      res.pipe(out);
    });
    if (hash.digest('hex') !== sha256) { fs.rmSync(dest, { force: true }); throw new PrintClientError('sha256_mismatch'); }
  }

  /** Eine gescannte Seite hochladen (gestreamt). */
  async function page(scanId, n, filePath, mime, bytes) {
    if (!ID_RE.test(scanId) || !Number.isInteger(n) || n < 1 || n > 100) throw new PrintClientError('bad_id');
    const res = await call(`${serverUrl}/api/v1/gateway/print/scans/${scanId}/pages/${n}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': mime, 'content-length': String(bytes) },
      body: fs.createReadStream(filePath),
      timeoutMs: 120_000,
    });
    res.resume();
    if (res.statusCode !== 200) throw new PrintClientError(res.statusCode === 413 ? 'too_large' : 'http_status', `HTTP ${res.statusCode}`);
  }

  /** Eine Seite für die Texterkennung nach `dest` laden (≤ 50 MB, JPEG/PNG). */
  async function ocrPage(id, n, dest) {
    if (!ID_RE.test(id) || !Number.isInteger(n) || n < 1 || n > 100) throw new PrintClientError('bad_id');
    const res = await call(`${serverUrl}/api/v1/gateway/print/ocr/${id}/pages/${n}`, { headers: { ...auth, accept: 'image/jpeg, image/png' } });
    if (res.statusCode !== 200) { res.resume(); throw new PrintClientError(res.statusCode === 404 ? 'not_found' : 'http_status', `HTTP ${res.statusCode}`); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'image/jpeg' && type !== 'image/png') { res.resume(); throw new PrintClientError('bad_type'); }
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      let n2 = 0;
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; res.destroy(); out.destroy(); reject(e); };
      res.on('data', (c) => { n2 += c.length; if (n2 > MAX_FILE) fail(new PrintClientError('too_large')); });
      res.on('aborted', () => fail(new PrintClientError('network', 'aborted')));
      res.on('error', (e) => fail(new PrintClientError('network', e.message)));
      out.on('error', (e) => fail(new PrintClientError('write', e.message)));
      out.on('finish', () => { if (!failed) resolve(); });
      res.pipe(out);
    });
  }

  /** Das Ergebnis der Texterkennung hochladen: kind 'document' (PDF) oder 'text'. */
  async function ocrResult(id, kind, filePath, mime) {
    if (!ID_RE.test(id) || (kind !== 'document' && kind !== 'text')) throw new PrintClientError('bad_id');
    const bytes = fs.statSync(filePath).size;
    if (bytes > MAX_OCR_RESULT) throw new PrintClientError('too_large');
    const res = await call(`${serverUrl}/api/v1/gateway/print/ocr/${id}/${kind}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': mime, 'content-length': String(bytes) },
      body: fs.createReadStream(filePath),
      timeoutMs: 120_000,
    });
    res.resume();
    if (res.statusCode !== 200) throw new PrintClientError(res.statusCode === 404 ? 'not_found' : (res.statusCode === 413 ? 'too_large' : 'http_status'), `HTTP ${res.statusCode}`);
  }

  return { jobs, file, page, ocrPage, ocrResult };
}

module.exports = { makePrintClient, parseJobs, PrintClientError, ID_RE, DEVICE_RE, MAX_FILE };
