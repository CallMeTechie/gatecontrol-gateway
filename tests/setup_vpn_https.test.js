'use strict';

// Statusseite per HTTPS aus dem VPN (src/setup/vpnHttps.js, docs/setup-page.md
// „Aus dem VPN per HTTPS“): Standard aus, nur mit Name und gültigem Wildcard,
// nur Absender aus dem VPN an die Tunnel-Adresse, SNI/Host genau
// <name>.<Bereich des Wildcards>, Einmal-Ticket → Sitzungs-Cookie, Leerlauf/Höchstdauer, nur
// lesen, Zertifikatswechsel ohne neuen Port, Management-API für das Ticket.
//
// Tunnel im Test: 127.0.0.1 ist die Tunnel-Adresse des Gateways, das VPN
// 127.0.0.0/8; der Browser fragt von 127.0.0.2 aus.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { createVpnStatusServer, isVpnPeer, cookieValue, COOKIE, SESSION_IDLE_MS, SESSION_MAX_MS } = require('../src/setup/vpnHttps');
const { createStatusPageRouter } = require('../src/api/routes/statusPage');

// Geräte-Wildcard: der Bereich kommt aus dem Zertifikat, nicht aus einer festen Zone
const ZONE = 'geraete.vpn.example.com';
const WILDCARD = `*.${ZONE}`;
const NAME = 'gw-keller';
const HOST = `${NAME}.${ZONE}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newTicket = () => crypto.randomBytes(32).toString('base64url');

function wildcard(days = 90) {
  const c = makeSelfSigned({ commonName: WILDCARD, days, altNames: [{ dns: WILDCARD }] });
  return { ...c, notAfter: new Date(Date.now() + days * 86_400_000).toISOString() };
}

function fakeVpnCert(dir) {
  const st = { cur: null };
  return {
    st,
    set(c) {
      st.cur = c;
      if (c) { fs.writeFileSync(path.join(dir, 'fullchain.pem'), c.cert); fs.writeFileSync(path.join(dir, 'privkey.pem'), c.key); }
    },
    status: () => (st.cur ? { state: 'ok', wildcard: WILDCARD, fingerprint: st.cur.sha256, notAfter: st.cur.notAfter } : null),
    files: () => (st.cur ? { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') } : null),
  };
}

/** HTTPS-Anfrage wie ein Browser im VPN. */
function req(port, { path: p = '/', method = 'GET', host = HOST, servername = HOST, from = '127.0.0.2', cookie, ca, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: '127.0.0.1', port, path: p, method, servername, localAddress: from, ca, agent: false,
      headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

function peerFingerprint(port, ca) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: HOST, localAddress: '127.0.0.2', ca }, () => {
      const fp = crypto.createHash('sha256').update(s.getPeerCertificate().raw).digest('hex');
      s.end();
      resolve(fp);
    });
    s.on('error', reject);
  });
}

describe('status page over the VPN: who may connect', () => {
  const tunnel = { tunnelIp: '10.8.0.5', tunnelCidrs: [{ base: '10.8.0.0', prefix: 24 }, { base: '0.0.0.0', prefix: 0 }] };
  it('only VPN senders to the tunnel address, never the gateway itself or the home network', () => {
    assert.equal(isVpnPeer({ remote: '10.8.0.14', local: '10.8.0.5' }, tunnel), true);
    assert.equal(isVpnPeer({ remote: '::ffff:10.8.0.14', local: '::ffff:10.8.0.5' }, tunnel), true);
    assert.equal(isVpnPeer({ remote: '10.8.0.5', local: '10.8.0.5' }, tunnel), false);
    assert.equal(isVpnPeer({ remote: '192.168.1.20', local: '10.8.0.5' }, tunnel), false); // 0.0.0.0/0 zählt nicht
    assert.equal(isVpnPeer({ remote: '10.8.0.14', local: '192.168.1.2' }, tunnel), false);
    assert.equal(isVpnPeer({ remote: '10.8.0.14', local: '10.8.0.5' }, { tunnelIp: null, tunnelCidrs: tunnel.tunnelCidrs }), false);
  });
  it('reads only its own cookie', () => {
    const v = 'a'.repeat(43);
    assert.equal(cookieValue(`x=1; ${COOKIE}=${v}; y=2`), v);
    assert.equal(cookieValue(`${COOKIE}=<script>`), null);
    assert.equal(cookieValue(undefined), null);
  });
});

describe('status page over the VPN: server', () => {
  let root;
  let vpnCert;
  let srv;
  let clock;
  let cert;
  const snapshotCalls = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-status-'));
    vpnCert = fakeVpnCert(root);
    clock = Date.now();
    cert = wildcard();
    snapshotCalls.length = 0;
    srv = createVpnStatusServer({
      snapshot: async () => { snapshotCalls.push(1); return { mode: 'connected', name: 'Keller', server: 'gate.example.com', csrf: 'secret-csrf', version: '1.0.0', vpnCert: null }; },
      vpnCert, tunnelIp: '127.0.0.1', wgAddress: '127.0.0.1/32', wgAllowedIps: '127.0.0.0/8', port: 0, now: () => clock, tickMs: 3_600_000,
    });
  });
  afterEach(async () => { await srv.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const port = () => srv.address().port;
  async function loginCookie() {
    const t = newTicket();
    const r = srv.issueTicket({ sha256: sha(t) });
    assert.equal(r.ok, true);
    const res = await req(port(), { path: `/login?t=${t}`, ca: cert.cert });
    assert.equal(res.status, 200);
    return res.headers['set-cookie'][0].split(';')[0];
  }

  it('is off by default and stays closed without name or certificate', async () => {
    await srv.apply(undefined);
    assert.deepEqual(srv.telemetry(), { enabled: false, state: 'off', host: null, port: 0, sessions: 0 });
    assert.equal(srv.address(), null);
    assert.deepEqual(srv.issueTicket({ sha256: 'a'.repeat(64) }), { ok: false, error: 'not_enabled' });
    await srv.apply({ status: true, vpn_https: true });
    assert.equal(srv.telemetry().state, 'no_name');
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    assert.equal(srv.telemetry().state, 'no_cert');
    assert.equal(srv.address(), null);
    vpnCert.set(wildcard(-1)); // abgelaufen
    await srv.refresh();
    assert.equal(srv.telemetry().state, 'no_cert');
    await srv.apply({ vpn_https: true, vpn_name: 'Bad Name!' });
    assert.equal(srv.telemetry().state, 'no_name');
  });

  it('logs in with a one-time ticket only and then shows the read-only state', async () => {
    vpnCert.set(cert);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    assert.equal(srv.telemetry().state, 'listening');
    assert.equal(srv.telemetry().host, HOST);

    // ohne Sitzung: nichts außer dem Hinweis
    let r = await req(port(), { ca: cert.cert });
    assert.equal(r.status, 401);
    assert.match(r.body, /GateControl/);
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
    r = await req(port(), { path: '/api/state', ca: cert.cert });
    assert.equal(r.status, 401);
    r = await req(port(), { path: '/setup.js', ca: cert.cert });
    assert.equal(r.status, 401);
    assert.equal(snapshotCalls.length, 0);

    // falsches Ticket
    r = await req(port(), { path: `/login?t=${newTicket()}`, ca: cert.cert });
    assert.equal(r.status, 401);
    assert.equal(r.headers['set-cookie'], undefined);

    const t = newTicket();
    assert.deepEqual(srv.issueTicket({ sha256: sha(t), ttlS: 9999 }), { ok: true, host: HOST, port: 0, expiresInS: 120 });
    r = await req(port(), { path: `/login?t=${t}`, ca: cert.cert });
    assert.equal(r.status, 200);
    assert.match(r.body, /http-equiv="refresh" content="0;url=\/"/);
    const sc = r.headers['set-cookie'][0];
    assert.match(sc, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$`));
    const cookie = sc.split(';')[0];

    // einmalig
    r = await req(port(), { path: `/login?t=${t}`, ca: cert.cert });
    assert.equal(r.status, 401);

    r = await req(port(), { path: '/api/state', ca: cert.cert, cookie });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.csrf, undefined);
    assert.equal(j.readOnly, true);
    assert.equal(j.via, 'vpn');
    assert.equal(j.mode, 'connected');
    r = await req(port(), { path: '/', ca: cert.cert, cookie });
    assert.equal(r.status, 200);
    assert.match(r.body, /setup\.js/);

    // nur lesen
    r = await req(port(), { path: '/api/pair', method: 'POST', ca: cert.cert, cookie, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 405);
    assert.equal(srv.telemetry().sessions, 1);
  });

  it('refuses another name, another SNI, proxy headers and senders outside the VPN', async () => {
    vpnCert.set(cert);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    const cookie = await loginCookie();
    let r = await req(port(), { path: '/api/state', ca: cert.cert, cookie, host: `other.${ZONE}` });
    assert.equal(r.status, 421);
    r = await req(port(), { path: '/api/state', ca: cert.cert, cookie, servername: `other.${ZONE}` });
    assert.equal(r.status, 421);
    r = await req(port(), { path: '/api/state', ca: cert.cert, cookie, host: `${HOST}:${port()}` });
    assert.equal(r.status, 421); // Port 0 im Test: nur der eingestellte Port zählt
    r = await req(port(), { path: '/api/state', ca: cert.cert, cookie, headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal(r.status, 403);
    // die Tunnel-Adresse selbst als Absender: vor dem Handshake geschlossen
    await assert.rejects(req(port(), { path: '/api/state', ca: cert.cert, cookie, from: '127.0.0.1' }));
  });

  it('ends a session after 30 minutes idle and after 8 hours at the latest', async () => {
    vpnCert.set(cert);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    let cookie = await loginCookie();
    clock += SESSION_IDLE_MS - 1000;
    assert.equal((await req(port(), { path: '/api/state', ca: cert.cert, cookie })).status, 200);
    clock += SESSION_IDLE_MS + 1000;
    assert.equal((await req(port(), { path: '/api/state', ca: cert.cert, cookie })).status, 401);

    cookie = await loginCookie();
    for (let t = 0; t < SESSION_MAX_MS; t += SESSION_IDLE_MS - 60_000) {
      clock += SESSION_IDLE_MS - 60_000;
      await req(port(), { path: '/api/state', ca: cert.cert, cookie });
    }
    assert.equal((await req(port(), { path: '/api/state', ca: cert.cert, cookie })).status, 401);
  });

  it('expires tickets, signs out and forgets everything when switched off', async () => {
    vpnCert.set(cert);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    const t = newTicket();
    srv.issueTicket({ sha256: sha(t), ttlS: 30 });
    clock += 31_000;
    assert.equal((await req(port(), { path: `/login?t=${t}`, ca: cert.cert })).status, 401);

    let cookie = await loginCookie();
    const bad = await req(port(), { path: '/api/logout', method: 'POST', ca: cert.cert, cookie, headers: { Origin: 'https://evil.example.net' } });
    assert.equal(bad.status, 403);
    const out = await req(port(), { path: '/api/logout', method: 'POST', ca: cert.cert, cookie, headers: { Origin: `https://${HOST}` } });
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await req(port(), { path: '/api/state', ca: cert.cert, cookie })).status, 401);

    cookie = await loginCookie();
    await srv.apply({ vpn_https: false });
    assert.equal(srv.address(), null);
    assert.equal(srv.telemetry().state, 'off');
    assert.equal(srv._state().sessions, 0);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    assert.equal((await req(port(), { path: '/api/state', ca: cert.cert, cookie })).status, 401);
  });

  it('takes a renewed certificate without closing the port and closes when it is gone', async () => {
    vpnCert.set(cert);
    await srv.apply({ vpn_https: true, vpn_name: NAME });
    const p = port();
    assert.equal(await peerFingerprint(p, cert.cert), cert.sha256);
    const next = wildcard();
    vpnCert.set(next);
    await srv.refresh();
    assert.equal(port(), p);
    assert.equal(await peerFingerprint(p, next.cert), next.sha256);
    vpnCert.set(null);
    await srv.refresh();
    assert.equal(srv.address(), null);
    assert.equal(srv.telemetry().state, 'no_cert');
  });
});

describe('status page over the VPN: management API', () => {
  function call(app, body) {
    return new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const data = JSON.stringify(body);
        const r = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', path: '/api/status-page/ticket',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
          let b = '';
          res.on('data', (c) => { b += c; });
          res.on('end', () => { s.close(); resolve({ status: res.statusCode, body: JSON.parse(b) }); });
        });
        r.end(data);
      });
    });
  }
  function app(vpn) {
    const a = express();
    a.use(express.json());
    a.use('/api', createStatusPageRouter({ getVpnStatus: () => vpn }));
    return a;
  }
  it('passes the ticket hash on and answers with name and port', async () => {
    const got = [];
    const vpn = { issueTicket: (o) => { got.push(o); return { ok: true, host: HOST, port: 8643, expiresInS: 60 }; } };
    const r = await call(app(vpn), { ticket_sha256: 'AB'.repeat(32), ttl_s: 60 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, host: HOST, port: 8643, expires_in_s: 60 });
    assert.deepEqual(got, [{ sha256: 'ab'.repeat(32), ttlS: 60 }]);
  });
  it('says why it cannot, and 404 without status page', async () => {
    assert.equal((await call(app({ issueTicket: () => ({ ok: false, error: 'no_cert' }) }), { ticket_sha256: 'a'.repeat(64) })).status, 409);
    assert.equal((await call(app({ issueTicket: () => ({ ok: false, error: 'bad_request' }) }), {})).status, 400);
    const r = await call(app(null), { ticket_sha256: 'a'.repeat(64) });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_available');
  });
});
