'use strict';

// HTTP zu einer Kamera im LAN (ONVIF/SOAP, Snapshot). Der Aufrufer hat die
// Adresse schon geprüft (config.hostAllowed); hier: nur `http:` zu genau
// dieser IPv4-Adresse, keine Weiterleitungen (3xx = Fehler), kein Proxy,
// Antwort-, Verbindungs- und Zeitgrenzen. Anmeldung per HTTP-Digest
// (MD5/SHA-256, qop=auth) und – nur wenn die Kamera nichts anderes anbietet –
// Basic. Zugänge landen nie im Log.

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

class CamHttpError extends Error {
  constructor(code, message, status = null) { super(message || code); this.code = code; this.status = status; }
}

/** 'Digest realm="x", nonce="y", qop="auth"' → { scheme, params } */
function parseChallenge(h) {
  const s = String(h || '').trim();
  const m = /^(\w+)\s*(.*)$/s.exec(s);
  if (!m) return null;
  const params = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let x;
  while ((x = re.exec(m[2])) !== null) params[x[1].toLowerCase()] = x[2] !== undefined ? x[2].replace(/\\(.)/g, '$1') : x[3];
  return { scheme: m[1].toLowerCase(), params };
}

/** Alle Challenges eines (oder mehrerer) WWW-Authenticate-Header. */
function challenges(header) {
  const list = Array.isArray(header) ? header : (header ? [header] : []);
  const out = [];
  for (const h of list) {
    // mehrere Challenges in einer Zeile: bei „, Digest“ / „, Basic“ trennen
    for (const part of String(h).split(/,\s*(?=(?:Digest|Basic)\s)/i)) {
      const c = parseChallenge(part);
      if (c) out.push(c);
    }
  }
  return out;
}

const HASH = { md5: 'md5', 'md5-sess': 'md5', 'sha-256': 'sha256', 'sha-256-sess': 'sha256' };

/** Authorization-Zeile für Digest (RFC 7616) oder null (Algorithmus unbekannt). */
function digestAuth(ch, { user, password, method, uri, nc = 1 }) {
  const p = ch.params;
  const algo = (p.algorithm || 'MD5').toLowerCase();
  const hname = HASH[algo];
  if (!hname || !p.nonce || p.realm === undefined) return null;
  const H = (s) => crypto.createHash(hname).update(s, 'utf8').digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncs = String(nc).padStart(8, '0');
  let ha1 = H(`${user}:${p.realm}:${password}`);
  if (algo.endsWith('-sess')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qops = String(p.qop || '').split(',').map((x) => x.trim().toLowerCase());
  const qop = qops.includes('auth') ? 'auth' : null;
  const response = qop ? H(`${ha1}:${p.nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
  const q = (v) => String(v).replace(/["\\]/g, '\\$&');
  const parts = [`username="${q(user)}"`, `realm="${q(p.realm)}"`, `nonce="${q(p.nonce)}"`, `uri="${q(uri)}"`, `response="${response}"`];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (p.opaque !== undefined) parts.push(`opaque="${q(p.opaque)}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncs}`, `cnonce="${cnonce}"`);
  return 'Digest ' + parts.join(', ');
}

function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}

/** Die Anmeldung, die zu den Challenges passt (Digest bevorzugt) – oder null. */
function authFor(header, { user, password, method, uri, allowBasic = true }) {
  if (!user) return null;
  const list = challenges(header);
  const digest = list.filter((c) => c.scheme === 'digest');
  for (const c of digest.sort((a, b) => (String(b.params.algorithm || '').toUpperCase().startsWith('SHA-256') ? 1 : 0) - (String(a.params.algorithm || '').toUpperCase().startsWith('SHA-256') ? 1 : 0))) {
    const h = digestAuth(c, { user, password, method, uri });
    if (h) return h;
  }
  if (allowBasic && !digest.length && list.some((c) => c.scheme === 'basic')) return basicAuth(user, password);
  return null;
}

function once({ host, port, path, method, headers, body, maxBytes, timeoutMs, connectMs, signal }) {
  return new Promise((resolve, reject) => {
    if (!net.isIPv4(host)) { reject(new CamHttpError('not_allowed', 'not an IPv4 address')); return; }
    let done = false;
    const timers = [];
    const finish = (fn, v) => { if (done) return; done = true; for (const t of timers) clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const req = http.request({ host, port, path, method, headers, agent: false, setHost: true }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(); finish(reject, new CamHttpError('too_large', 'answer too large', res.statusCode)); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => finish(reject, new CamHttpError('unreachable', 'connection lost')));
    });
    const onAbort = () => { req.destroy(); finish(reject, new CamHttpError('aborted', 'aborted')); };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    timers.push(setTimeout(() => { req.destroy(); finish(reject, new CamHttpError('timeout', 'the camera did not answer in time')); }, timeoutMs));
    req.on('socket', (sock) => {
      if (!sock.connecting) return;
      const t = setTimeout(() => { req.destroy(); finish(reject, new CamHttpError('unreachable', 'the camera does not answer')); }, connectMs);
      timers.push(t);
      sock.once('connect', () => clearTimeout(t));
    });
    req.on('error', (e) => finish(reject, e instanceof CamHttpError ? e : new CamHttpError('unreachable', 'the camera does not answer')));
    req.end(body || undefined);
  });
}

/**
 * Eine Anfrage, bei 401 einmal mit Anmeldung wiederholt.
 * → { status, headers, body (Buffer) }; wirft CamHttpError (unreachable, timeout, too_large, redirect, auth_failed …).
 */
async function request(opts) {
  const o = {
    method: 'GET', headers: {}, body: null, maxBytes: 256 * 1024, timeoutMs: 10_000, connectMs: 4_000, allowBasic: true, ...opts,
  };
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new CamHttpError('invalid', 'invalid port');
  if (typeof o.path !== 'string' || o.path[0] !== '/') throw new CamHttpError('invalid', 'invalid path');
  const base = { ...o.headers, Connection: 'close' };
  if (o.body && !base['Content-Length']) base['Content-Length'] = Buffer.byteLength(o.body);
  let r = await once({ ...o, headers: base });
  if (r.status === 401 && o.user) {
    const auth = authFor(r.headers['www-authenticate'], { user: o.user, password: o.password || '', method: o.method, uri: o.path, allowBasic: o.allowBasic });
    if (auth) r = await once({ ...o, headers: { ...base, Authorization: auth } });
    if (r.status === 401) throw new CamHttpError('auth_failed', 'the camera refused the user or password', 401);
  }
  if (r.status >= 300 && r.status < 400) throw new CamHttpError('redirect', 'the camera answered with a redirect', r.status);
  return r;
}

module.exports = { request, parseChallenge, challenges, digestAuth, basicAuth, authFor, CamHttpError };
