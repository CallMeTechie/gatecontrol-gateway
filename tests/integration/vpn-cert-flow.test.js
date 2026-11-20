'use strict';

// Ende-zu-Ende gegen einen nachgebauten GateControl-Server (HTTPS, eigenes
// Zertifikat für server.vpn.example.com): echter Abruf über TLS mit SNI/Host
// server.<zone>, Gateway-Token, Quelladresse; Prüfung, Ablage, Erneuerung,
// Ablehnung „nicht über den Tunnel“ mit Wiederholung und Löschen.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { makeSelfSigned } = require('../../src/cache/selfsigned');
const { VpnCertManager, KEY_FILE, CERT_FILE } = require('../../src/vpncert/vpnCert');

const ZONE = 'vpn.example.com';
const WILDCARD = `*.${ZONE}`;
const TOKEN = 'gc_gw_' + 'b'.repeat(64);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  throw new Error('timeout waiting for condition');
}

function wildcardCert() {
  const c = makeSelfSigned({ commonName: WILDCARD, days: 90, altNames: [{ dns: WILDCARD }] });
  return { ...c, notAfter: new Date(Date.now() + 90 * 86_400_000).toISOString() };
}

describe('integration: vpn cert against a fake server', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpncert-flow-'));
  const dir = path.join(root, 'state', 'vpn-cert');
  const serverTls = makeSelfSigned({ commonName: `server.${ZONE}`, altNames: [{ dns: `server.${ZONE}` }] });
  const seen = [];
  const srv = { current: wildcardCert(), allowedIp: '127.0.0.2', shared: true };
  let server;
  let port;

  before(async () => {
    server = https.createServer({ cert: serverTls.cert, key: serverTls.key }, (req, res) => {
      seen.push({ url: req.url, host: req.headers.host, sni: req.socket.servername, auth: req.headers.authorization, from: req.socket.remoteAddress });
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.url !== '/api/v1/gateway/vpn-cert' || req.method !== 'GET') return send(404, { error: 'not_found' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      if (!srv.shared) return send(404, { ok: false, error: 'not_shared' });
      if (req.socket.remoteAddress.replace(/^::ffff:/, '') !== srv.allowedIp) return send(403, { ok: false, error: 'not_from_vpn' });
      const c = srv.current;
      return send(200, { ok: true, wildcard: WILDCARD, zone: ZONE, cert_pem: c.cert, key_pem: c.key, not_after: c.notAfter, fingerprint: c.sha256 });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const summary = () => ({ wildcard: WILDCARD, fingerprint: srv.current.sha256, not_after: srv.current.notAfter });

  it('without trusting the server certificate nothing is fetched', async () => {
    const mgr = new VpnCertManager({ dir, apiToken: TOKEN, tunnelIp: '127.0.0.1', port, retryMinMs: 60_000 });
    mgr.apply(summary(), { serverIp: '127.0.0.1' });
    await until(() => mgr.state === 'error');
    assert.match(mgr.error, /CERT|SELF_SIGNED/);
    assert.equal(fs.existsSync(path.join(dir, KEY_FILE)), false);
    mgr.stop();
  });

  it('fetch, renewal, refusal from outside the tunnel with retry, removal', async () => {
    const logs = [];
    const logger = { info: (...a) => logs.push(JSON.stringify(a)), warn: (...a) => logs.push(JSON.stringify(a)), error() {}, debug() {} };
    const mgr = new VpnCertManager({ dir, apiToken: TOKEN, tunnelIp: '127.0.0.1', port, ca: serverTls.cert, logger, retryMinMs: 30, retryMaxMs: 60 });

    // 1. Request from the wrong address (not the VPN address of the peer): 403, retry with backoff
    mgr.apply(summary(), { serverIp: '127.0.0.1' });
    await until(() => mgr.state === 'error' && mgr.error === 'not_from_vpn');
    assert.equal(fs.existsSync(path.join(dir, KEY_FILE)), false);
    const last = seen[seen.length - 1];
    assert.equal(last.host, `server.${ZONE}`);
    assert.equal(last.sni, `server.${ZONE}`);
    assert.equal(last.auth, `Bearer ${TOKEN}`);
    assert.equal(last.from.replace(/^::ffff:/, ''), '127.0.0.1');

    // 2. The server now sees the right address: the retry gets certificate and key
    srv.allowedIp = '127.0.0.1';
    await until(() => mgr.state === 'ok');
    const first = srv.current;
    assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), first.key);
    assert.equal(fs.readFileSync(path.join(dir, CERT_FILE), 'utf8'), first.cert);
    assert.equal(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(mgr.telemetry(), { fingerprint: first.sha256, not_after: mgr.telemetry().not_after });

    // 3. Same config again (e.g. another route changed): no new fetch
    const n = seen.length;
    mgr.apply(summary(), { serverIp: '127.0.0.1' });
    await wait(50);
    assert.equal(seen.length, n);

    // 4. Renewal: new fingerprint in the config → new certificate and key
    srv.current = wildcardCert();
    mgr.apply(summary(), { serverIp: '127.0.0.1' });
    await until(() => mgr.telemetry()?.fingerprint === srv.current.sha256);
    assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), srv.current.key);

    // 5. Config names a fingerprint the server does not deliver: discarded, the stored one stays
    const stale = { ...summary(), fingerprint: 'ef'.repeat(32) };
    mgr.apply(stale, { serverIp: '127.0.0.1' });
    await until(() => mgr.state === 'error' && mgr.error === 'fingerprint_mismatch');
    assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), srv.current.key);
    mgr.apply(summary(), { serverIp: '127.0.0.1' });
    assert.equal(mgr.state, 'ok');

    // 6. Passing on switched off: vpn_cert disappears from the config → files gone
    srv.shared = false;
    mgr.apply(undefined, { serverIp: '127.0.0.1' });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(mgr.telemetry(), null);
    mgr.stop();

    assert.ok(!logs.join('\n').includes('PRIVATE KEY'), 'the key never reaches the log');
  });
});
