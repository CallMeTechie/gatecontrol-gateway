'use strict';

// HTTP zu Ollama (Dienst ki, 127.0.0.1:11435) oder zum eingestellten KI-Server
// im LAN (docs/local-ai.md §3). Nur die eine Basis (Host + Port fest), eigene
// Pfade, keine Weiterleitungen (3xx = Fehler), Größen- und Zeitgrenzen. Alles
// asynchron und gestreamt – nichts blockiert die Ereignisschleife.
// Fehler tragen `code`: unreachable | not_private | timeout | redirect | too_large | bad_response | http_<n> | aborted.
//
// base: { protocol, host, port } – dazu optional `lookup` (Namen nur an private
// Adressen, resolve.js) und `auth()` (API-Schlüssel des LAN-Servers → Bearer;
// nie geloggt, nie in einer Fehlermeldung).

const http = require('node:http');
const https = require('node:https');

const MAX_LINE = 1024 * 1024;

function err(code, message, extra) { return Object.assign(new Error(message || code), { code }, extra || {}); }

const CONNECT_MS = 10_000;

/** Ein Host, der nicht antwortet (abgeschaltet, falsche Adresse), fällt nach 10 s auf – nicht erst nach Minuten. */
function connectGuard(req, onFail) {
  req.on('socket', (sock) => {
    if (!sock.connecting) return;
    const t = setTimeout(() => { req.destroy(); onFail(err('unreachable', 'connect timeout')); }, CONNECT_MS);
    sock.once('connect', () => clearTimeout(t));
    sock.once('close', () => clearTimeout(t));
  });
}

function transport(base) { return base.protocol === 'https:' ? https : http; }

function opts(base, method, path, data, extraHeaders) {
  const key = typeof base.auth === 'function' ? base.auth() : null;
  return {
    host: base.host, port: base.port, method, path,
    ...(typeof base.lookup === 'function' ? { lookup: base.lookup } : {}),
    // kein Agent mit Keep-Alive: jede Anfrage eine eigene Verbindung, nichts bleibt hängen
    agent: false,
    headers: {
      Accept: 'application/json', 'User-Agent': 'GateControl-Gateway',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(extraHeaders || {}),
    },
  };
}

// Fehler der Verbindung: `not_private` (resolve.js) bleibt, alles andere heißt unreachable
const netErr = (e) => (e && e.code === 'not_private' ? e : err('unreachable', e && e.message));

/**
 * Eine JSON-Anfrage → { status, json }. 3xx wirft `redirect`, mehr als
 * maxBytes `too_large`; ein nicht-JSON-Body ergibt json === undefined.
 */
function requestJson({ base, method = 'GET', path, body, timeoutMs = 10_000, maxBytes = 1024 * 1024, signal }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); } };
    const req = transport(base).request(opts(base, method, path, data), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); req.destroy(); finish(reject, err('redirect', 'redirects are not followed')); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); finish(reject, err('too_large', 'response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = undefined; }
        finish(resolve, { status: res.statusCode, json });
      });
      res.on('error', (e) => finish(reject, err('unreachable', e.message)));
    });
    const timer = setTimeout(() => { req.destroy(); finish(reject, err('timeout', 'no answer in time')); }, timeoutMs);
    const onAbort = () => { req.destroy(); finish(reject, err('aborted', 'aborted')); };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    connectGuard(req, (e) => finish(reject, e));
    req.on('error', (e) => finish(reject, netErr(e)));
    req.end(data || undefined);
  });
}

/**
 * Eine gestreamte Anfrage: NDJSON (Ollama) oder Server-Sent Events (OpenAI-
 * kompatibel). onLine(obj) je JSON-Zeile; „data: [DONE]“ endet still.
 * Zeitgrenzen: gesamt (timeoutMs) und ohne neue Zeile (idleMs).
 * Antwortet der Server nicht mit 2xx, wirft es http_<n> mit dem (gekürzten) Text als `detail`.
 */
function streamLines({ base, method = 'POST', path, body, timeoutMs, idleMs = 120_000, maxBytes = 8 * 1024 * 1024, signal, onLine, sse = false }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let done = false;
    let idle = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(total); clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => { req.destroy(); finish(reject, err('timeout', 'no progress in time')); }, idleMs); };
    const req = transport(base).request(opts(base, method, path, data, sse ? { Accept: 'text/event-stream' } : null), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); req.destroy(); finish(reject, err('redirect', 'redirects are not followed')); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        let n = 0;
        res.on('data', (c) => { if (n < 4096) { chunks.push(c); n += c.length; } });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 4096);
          let detail = text;
          try { const j = JSON.parse(text); detail = typeof j.error === 'string' ? j.error : (j.error && j.error.message) || text; } catch { /* Text */ }
          finish(reject, err('http_' + res.statusCode, String(detail).slice(0, 200), { status: res.statusCode, detail: String(detail).slice(0, 200) }));
        });
        res.on('error', (e) => finish(reject, err('unreachable', e.message)));
        return;
      }
      let size = 0;
      let buf = '';
      res.setEncoding('utf8');
      kick();
      const line = (raw) => {
        let s = raw.trim();
        if (!s) return;
        if (sse) {
          if (!s.startsWith('data:')) return;
          s = s.slice(5).trim();
          if (s === '[DONE]') return;
        }
        let obj;
        try { obj = JSON.parse(s); } catch { throw err('bad_response', 'no JSON line'); }
        onLine(obj);
      };
      res.on('data', (c) => {
        if (done) return;
        size += Buffer.byteLength(c);
        if (size > maxBytes) { req.destroy(); finish(reject, err('too_large', 'response too large')); return; }
        kick();
        buf += c;
        if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) { req.destroy(); finish(reject, err('bad_response', 'line too long')); return; }
        let i;
        try {
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i);
            buf = buf.slice(i + 1);
            line(l);
          }
        } catch (e) { req.destroy(); finish(reject, e.code ? e : err('bad_response', e.message)); }
      });
      res.on('end', () => {
        if (done) return;
        try { line(buf); } catch (e) { finish(reject, e.code ? e : err('bad_response', e.message)); return; }
        finish(resolve);
      });
      res.on('error', (e) => finish(reject, err('unreachable', e.message)));
    });
    const total = setTimeout(() => { req.destroy(); finish(reject, err('timeout', 'no answer in time')); }, timeoutMs);
    const onAbort = () => { req.destroy(); finish(reject, err('aborted', 'aborted')); };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    connectGuard(req, (e) => finish(reject, e));
    req.on('error', (e) => finish(reject, netErr(e)));
    req.end(data || undefined);
  });
}

module.exports = { requestJson, streamLines, err };
