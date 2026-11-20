'use strict';

// Statusseite zusätzlich per HTTPS aus dem VPN (docs/setup-page.md „Aus dem
// VPN per HTTPS“). Standard aus; GateControl schaltet sie je Gateway ein
// (`features.setup_page.vpn_https: true`, dazu `vpn_name`: der Name des
// Gateways im VPN). Adresse `<vpn_name>.<Bereich>`; der Bereich kommt aus dem
// weitergegebenen Wildcard (`vpn_cert.wildcard`, z. B. `*.geraete.<zone>`) und
// ist nicht fest verdrahtet. Die Seite im Heimnetz (server.js) bleibt, wie sie ist.
//
// Nur, wenn alles zusammenkommt:
//   - eingeschaltet und ein Name bekannt,
//   - ein gültiges Wildcard-Zertifikat der VPN-Zone liegt vor (vpnCert),
//   - Port (8643) nur an der Tunnel-Adresse; Verbindungen nur von Absendern
//     aus dem VPN (WG_ADDRESS/WG_ALLOWED_IPS, nicht die eigene Adresse) –
//     alles andere wird vor dem TLS-Handshake geschlossen,
//   - SNI und Host genau `<name>.<Bereich>`, keine Proxy-Kopfzeilen,
//   - Anmeldung: GateControl legt über die Management-API (Tunnel,
//     Gateway-Token) ein Einmal-Ticket ab (nur dessen SHA-256, höchstens
//     120 s). Der Browser kommt mit `/login?t=<ticket>` und bekommt ein
//     Sitzungs-Cookie (`__Host-`, HttpOnly, Secure, SameSite=Strict;
//     Leerlauf 30 min, höchstens 8 h). Ohne Sitzung gibt es nichts außer
//     einem Hinweis.
//   - nur lesen: kein /api/pair, kein Anstoßen der Selbstprüfungen.
//
// Neues Zertifikat (Erneuerung) → neuer TLS-Kontext ohne Neustart des Ports.
// Zertifikat weg oder abgelaufen, Schalter aus → Port zu, Tickets und
// Sitzungen verworfen.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { normalizeAddress, parseCidrs } = require('./net');
const { assets: loadAssets, CSP } = require('./server');

const DEFAULT_PORT = 8643;
const TICKET_MAX_TTL_S = 120;
const TICKET_DEFAULT_TTL_S = 60;
const MAX_TICKETS = 8;
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const LOGIN_FAIL_MAX = 20;
const LOGIN_FAIL_WINDOW_MS = 60 * 1000;
const TICK_MS = 60 * 1000;
const COOKIE = '__Host-gc_status';
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'via'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function inV4(ip, base, prefix) {
  const toInt = (a) => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/** Kommt diese Verbindung aus dem VPN an die Tunnel-Adresse? */
function isVpnPeer({ remote, local }, { tunnelIp, tunnelCidrs }) {
  const r = normalizeAddress(remote);
  const l = normalizeAddress(local);
  if (!tunnelIp || l !== tunnelIp || r === tunnelIp) return false;
  // 0.0.0.0/0 (alles durch den Tunnel) sagt nichts über den Absender
  return (tunnelCidrs || []).some((c) => c.prefix >= 8 && inV4(r, c.base, c.prefix));
}

function cookieValue(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return TOKEN_RE.test(v) ? v : null;
    }
  }
  return null;
}

const PAGE_HEAD = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">';
const LOGIN_OK = `${PAGE_HEAD}<meta http-equiv="refresh" content="0;url=/"><title>GateControl Home Gateway</title></head>`
  + '<body><p><a href="/">Weiter / Continue</a></p></body></html>\n';
const LOGIN_NEEDED = `${PAGE_HEAD}<title>GateControl Home Gateway</title></head><body>`
  + '<p>Diese Seite öffnest du aus GateControl: Gateway › Statusseite › „Im VPN öffnen“.</p>'
  + '<p>Open this page from GateControl: gateway › status page › “Open in the VPN”.</p></body></html>\n';

/**
 * @param {object} o
 * @param {Function} o.snapshot       (opts) → Zustand der Statusseite (controller.snapshot)
 * @param {object} o.vpnCert          VpnCertManager (files(), status())
 * @param {string} o.tunnelIp         eigene Tunnel-Adresse (einzige Bindung)
 * @param {string} [o.wgAddress]      WG_ADDRESS (CIDR des VPN)
 * @param {string} [o.wgAllowedIps]   WG_ALLOWED_IPS
 * @param {number} [o.port]           8643
 */
function createVpnStatusServer({ snapshot, vpnCert, tunnelIp, wgAddress = '', wgAllowedIps = '', port = DEFAULT_PORT, logger, now = Date.now,
  readFile = (f) => fs.readFileSync(f, 'utf8'), tickMs = TICK_MS } = {}) {
  const pageAssets = loadAssets();
  const tunnel = { tunnelIp, tunnelCidrs: [...parseCidrs(wgAddress), ...parseCidrs(wgAllowedIps)] };
  const tickets = new Map();  // sha256(ticket) → Ablauf (ms)
  const sessions = new Map(); // sha256(sitzung) → { createdAt, lastSeen }
  const fails = [];
  const want = { enabled: false, name: null };
  let srv = null;             // { server, sockets, fingerprint, host }
  let state = 'off';          // off | no_name | no_cert | starting | listening | port_in_use | error
  let host = null;
  let chain = Promise.resolve();
  let stopped = false;
  const timer = setInterval(() => { prune(); refresh(); }, tickMs);
  timer.unref?.();

  function log(level, obj, msg) { try { logger?.[level]?.(obj, msg); } catch { /* Logger */ } }

  function prune() {
    const t = now();
    for (const [k, exp] of tickets) if (exp <= t) tickets.delete(k);
    for (const [k, s] of sessions) if (t - s.lastSeen > SESSION_IDLE_MS || t - s.createdAt > SESSION_MAX_MS) sessions.delete(k);
    while (fails.length && t - fails[0] >= LOGIN_FAIL_WINDOW_MS) fails.shift();
  }

  /** Was gerade gelten soll: { host, cert, key, fingerprint } oder { state } mit Grund. */
  function desired() {
    if (!want.enabled) return { state: 'off' };
    if (!want.name) return { state: 'no_name' };
    const st = (() => { try { return vpnCert && vpnCert.status(); } catch { return null; } })();
    const files = (() => { try { return vpnCert && vpnCert.files(); } catch { return null; } })();
    if (!st || !files || !st.fingerprint || !st.wildcard || !st.notAfter || !(Date.parse(st.notAfter) > now())) return { state: 'no_cert' };
    // Bereich aus dem Wildcard selbst: *.geraete.<zone> → <name>.geraete.<zone>
    const wc = String(st.wildcard).toLowerCase();
    const area = wc.slice(2);
    if (!wc.startsWith('*.') || !area.includes('.') || !area.split('.').every((l) => LABEL_RE.test(l))) return { state: 'no_cert' };
    return { host: `${want.name}.${area}`, fingerprint: st.fingerprint, files };
  }

  function forget() { tickets.clear(); sessions.clear(); }

  /** Port öffnen, Zertifikat tauschen oder schließen – je nach Lage. */
  function refresh() {
    chain = chain.then(async () => {
      if (stopped) return;
      const d = desired();
      if (!d.host) {
        if (srv) { await close(); log('info', { reason: d.state }, 'Status page over the VPN closed'); }
        if (state !== d.state) forget();
        state = d.state;
        host = null;
        return;
      }
      let cert;
      let key;
      try { cert = readFile(d.files.cert); key = readFile(d.files.key); } catch (err) {
        log('warn', { code: err.code }, 'Status page over the VPN: certificate not readable');
        if (srv) await close();
        state = 'no_cert';
        return;
      }
      if (srv && srv.host !== d.host) { await close(); forget(); }
      host = d.host;
      if (srv) {
        if (srv.fingerprint !== d.fingerprint) {
          srv.server.setSecureContext({ cert, key, minVersion: 'TLSv1.2' });
          srv.fingerprint = d.fingerprint;
          log('info', { fingerprint: d.fingerprint }, 'Status page over the VPN: new certificate in use');
        }
        state = 'listening';
        return;
      }
      state = 'starting';
      state = await open({ cert, key, fingerprint: d.fingerprint, host: d.host });
    }).catch((err) => { state = 'error'; log('warn', { err: err.message }, 'Status page over the VPN: refresh failed'); });
    return chain;
  }

  function open({ cert, key, fingerprint, host: h }) {
    return new Promise((resolve) => {
      const sockets = new Set();
      const server = https.createServer({ cert, key, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => {
        handle(req, res).catch((err) => {
          log('warn', { err: err.message }, 'Status page over the VPN: request failed');
          if (!res.headersSent) text(res, 500, 'Error\n'); else res.destroy();
        });
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 20_000;
      server.keepAliveTimeout = 5_000;
      server.maxConnections = 32;
      // vor dem TLS-Handshake: nur aus dem VPN an die Tunnel-Adresse
      server.on('connection', (socket) => {
        if (!isVpnPeer({ remote: socket.remoteAddress, local: socket.localAddress }, tunnel)) { socket.destroy(); return; }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.on('tlsClientError', () => { /* falscher Name, alter Client: nichts zu tun */ });
      server.once('error', (err) => {
        log('warn', { port, code: err.code }, 'Status page over the VPN: port not available');
        resolve(err.code === 'EADDRINUSE' ? 'port_in_use' : 'error');
      });
      server.listen({ port, host: tunnelIp }, () => {
        server.removeAllListeners('error');
        server.on('error', (err) => log('warn', { code: err.code }, 'Status page over the VPN: server error'));
        srv = { server, sockets, fingerprint, host: h };
        log('info', { bind: `${tunnelIp}:${server.address().port}`, host: h }, 'Status page listening over the VPN (HTTPS, login via GateControl)');
        resolve('listening');
      });
    });
  }

  function close() {
    const e = srv;
    srv = null;
    if (!e) return Promise.resolve();
    for (const s of e.sockets) s.destroy();
    return new Promise((resolve) => e.server.close(() => resolve()));
  }

  function head(res, status, type, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      ...extra,
    });
  }
  function text(res, status, msg) { head(res, status, 'text/plain; charset=utf-8'); res.end(msg); }
  function html(res, status, body, extra) { head(res, status, 'text/html; charset=utf-8', extra); res.end(body); }
  function json(res, status, obj) { head(res, status, 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); }

  function hostOk(req) {
    const want2 = srv && srv.host;
    if (!want2) return false;
    const h = String(req.headers.host || '').trim().toLowerCase().replace(/\.$/, '');
    const sni = String(req.socket.servername || '').toLowerCase();
    return (h === want2 || h === `${want2}:${port}`) && sni === want2;
  }

  /** Sitzung prüfen und verlängern → Schlüssel oder null. */
  function session(req) {
    const v = cookieValue(req.headers.cookie);
    if (!v) return null;
    const k = sha256(v);
    const s = sessions.get(k);
    const t = now();
    if (!s) return null;
    if (t - s.lastSeen > SESSION_IDLE_MS || t - s.createdAt > SESSION_MAX_MS) { sessions.delete(k); return null; }
    s.lastSeen = t;
    return k;
  }

  function login(req, res, url) {
    prune();
    if (fails.length >= LOGIN_FAIL_MAX) return text(res, 429, 'Too many attempts\n');
    const t = url.searchParams.get('t');
    const k = typeof t === 'string' && TOKEN_RE.test(t) ? sha256(t) : null;
    const exp = k ? tickets.get(k) : undefined;
    if (!k || !exp || exp <= now()) {
      fails.push(now());
      log('warn', {}, 'Status page over the VPN: login with an unknown or expired ticket');
      return html(res, 401, LOGIN_NEEDED);
    }
    tickets.delete(k); // nur einmal
    const sid = crypto.randomBytes(32).toString('base64url');
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(sha256(sid), { createdAt: now(), lastSeen: now() });
    log('info', { sessions: sessions.size }, 'Status page over the VPN: login via GateControl');
    // Kein Redirect: Eine Weiterleitung innerhalb einer Navigation von außen gilt als
    // seitenübergreifend, SameSite=Strict schickte das Cookie dann nicht mit.
    return html(res, 200, LOGIN_OK, {
      'Set-Cookie': `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`,
    });
  }

  async function handle(req, res) {
    if (!hostOk(req)) return text(res, 421, 'Misdirected request\n');
    if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return text(res, 403, 'Forbidden\n');
    const url = new URL(req.url, 'https://x');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/login') return login(req, res, url);
    if (req.method === 'GET' && route === '/healthz') return text(res, 200, 'ok\n');
    const sid = session(req);
    if (req.method === 'POST' && route === '/api/logout') {
      req.resume();
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      let same = !site || site === 'same-origin';
      if (origin) { try { same = same && new URL(origin).host === req.headers.host; } catch { same = false; } }
      if (!same) return json(res, 403, { ok: false, error: 'forbidden' });
      if (sid) sessions.delete(sid);
      head(res, 200, 'application/json; charset=utf-8', { 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume();
      res.setHeader('Allow', 'GET, HEAD');
      return text(res, 405, 'Method not allowed\n');
    }
    if (!sid) return route.startsWith('/api/') ? json(res, 401, { ok: false, error: 'login_required' }) : html(res, 401, LOGIN_NEEDED);
    if (pageAssets[route]) {
      head(res, 200, pageAssets[route].type);
      return res.end(req.method === 'HEAD' ? undefined : pageAssets[route].body);
    }
    if (route === '/api/state') return json(res, 200, view(await snapshot({ recheck: false })));
    return text(res, 404, 'Not found\n');
  }

  /** Zustand für die Seite aus dem VPN: ohne CSRF-Token und ohne Einrichtungsteil – hier wird nichts verbunden. */
  function view(s) {
    const out = { ...(s || {}) };
    delete out.csrf;
    delete out.checks;
    delete out.attemptsLeft;
    delete out.retryAfterS;
    delete out.busy;
    out.ready = false;
    out.readOnly = true;
    out.via = 'vpn';
    return out;
  }

  return {
    /** Config-Pull: `features.setup_page` ({ vpn_https, vpn_name }). */
    apply(f) {
      const on = !!(f && typeof f === 'object' && f.vpn_https === true);
      const name = on && typeof f.vpn_name === 'string' && LABEL_RE.test(f.vpn_name.trim().toLowerCase()) ? f.vpn_name.trim().toLowerCase() : null;
      if (on !== want.enabled || name !== want.name) {
        want.enabled = on;
        want.name = name;
        log('info', { enabled: on, name }, 'Status page over the VPN switched by the server');
      }
      return refresh();
    },
    refresh,
    /**
     * Management-API: Einmal-Ticket ablegen (nur der SHA-256).
     * → { ok: true, host, port, expiresInS } | { ok: false, error }
     */
    issueTicket({ sha256: hash, ttlS } = {}) {
      if (typeof hash !== 'string' || !HEX64.test(hash)) return { ok: false, error: 'bad_request' };
      if (state !== 'listening' || !srv) return { ok: false, error: state === 'off' ? 'not_enabled' : state };
      prune();
      const ttl = Number.isInteger(ttlS) && ttlS >= 1 ? Math.min(ttlS, TICKET_MAX_TTL_S) : TICKET_DEFAULT_TTL_S;
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
      tickets.set(hash, now() + ttl * 1000);
      return { ok: true, host: srv.host, port, expiresInS: ttl };
    },
    /** Heartbeat: an/aus, Zustand, Name, Port, offene Sitzungen – nie Ticket oder Cookie. */
    telemetry() {
      prune();
      return { enabled: want.enabled, state, host, port, sessions: sessions.size };
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await chain;
      await close();
      forget();
    },
    address: () => (srv ? srv.server.address() : null),
    _state: () => ({ state, tickets: tickets.size, sessions: sessions.size }),
  };
}

module.exports = { createVpnStatusServer, isVpnPeer, cookieValue, DEFAULT_PORT, COOKIE, SESSION_IDLE_MS, SESSION_MAX_MS, TICKET_MAX_TTL_S };
