'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redeem, writeEnvAtomic, peerNameFromEnv, PairError } = require('../src/setup/pairing');
const { startFakePairServer, envContent } = require('./helpers/fakePairServer');

async function codeOf(p) {
  try { await p; } catch (err) { assert.ok(err instanceof PairError, err.stack); return err.code; }
  return 'no error';
}

describe('setup page: pairing against a test server', () => {
  let srv;
  before(async () => { srv = await startFakePairServer({ codes: ['A3F9-27C1-0BDE-58E4', '1111-2222-3333-4444'] }); });
  after(() => srv.close());

  it('redeems the code over verified TLS and validates the answer', async () => {
    const r = await redeem({ server: srv.server, code: 'A3F9-27C1-0BDE-58E4', tls: srv.tls });
    assert.equal(r.name, 'Synology Keller');
    assert.equal(r.config.tunnelIp, '10.8.0.7');
    assert.match(r.envContent, /^GC_API_TOKEN=gc_gw_/m);
    const req = srv.requests.at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/gateway/pair');
    assert.deepEqual(req.body, { code: 'A3F9-27C1-0BDE-58E4' });
  });

  it('a code works once', async () => {
    assert.equal(await codeOf(redeem({ server: srv.server, code: 'A3F9-27C1-0BDE-58E4', tls: srv.tls })), 'code_rejected');
  });

  it('refuses a certificate it cannot verify (no pairing over untrusted TLS)', async () => {
    const n = srv.requests.length;
    assert.equal(await codeOf(redeem({ server: srv.server, code: '1111-2222-3333-4444' })), 'server_tls');
    assert.equal(srv.requests.length, n, 'the code never left the gateway');
    assert.ok(srv.codes.has('1111-2222-3333-4444'));
  });

  it('nothing listening: server unreachable', async () => {
    assert.equal(await codeOf(redeem({ server: { host: '127.0.0.1', port: 1 }, code: '1111-2222-3333-4444', tls: srv.tls, timeoutMs: 2000 })), 'server_unreachable');
  });
});

describe('setup page: answers that are not GateControl', () => {
  async function withHandler(handler, fn) {
    const srv = await startFakePairServer({ handler });
    try { return await fn(srv); } finally { await srv.close(); }
  }
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); return true; };

  it('maps status codes to fixed reasons and never follows a redirect', async () => {
    await withHandler((req, res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html>nginx</html>'); return true; },
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'server_not_gatecontrol'));
    await withHandler((req, res) => json(res, 429, { ok: false, error: 'Too many pairing attempts. Try again later.' }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'server_busy'));
    await withHandler((req, res) => json(res, 500, { ok: false, error: 'pair_failed' }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'server_error'));
    await withHandler((req, res) => { res.writeHead(302, { Location: 'https://127.0.0.1:1/api/v1/gateway/pair' }); res.end(); return true; },
      async (s) => {
        assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'server_not_gatecontrol');
        assert.equal(s.requests.length, 1);
      });
  });

  it('rejects an envContent that is not a gateway.env, and oversized answers', async () => {
    await withHandler((req, res) => json(res, 200, { ok: true, envContent: 'GC_SERVER_URL=https://x.example\n' }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'bad_response'));
    await withHandler((req, res) => json(res, 200, { ok: true, envContent: envContent({ tunnelIp: '0.0.0.0' }) }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'bad_response'));
    await withHandler((req, res) => json(res, 200, { ok: true, envContent: 'x'.repeat(200_000) }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'bad_response'));
    await withHandler((req, res) => json(res, 200, { ok: true }),
      async (s) => assert.equal(await codeOf(redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls })), 'server_not_gatecontrol'));
  });

  it('errors carry no text of the server', async () => {
    await withHandler((req, res) => json(res, 400, { ok: false, error: '<script>alert(1)</script>' }), async (s) => {
      try { await redeem({ server: s.server, code: '1111-2222-3333-4444', tls: s.tls }); assert.fail('should throw'); } catch (err) {
        assert.equal(err.code, 'server_not_gatecontrol');
        assert.doesNotMatch(JSON.stringify({ m: err.message, c: err.code, d: err.detail }), /script/);
      }
    });
  });
});

describe('setup page: gateway.env on disk', () => {
  it('writes atomically with mode 0600 and replaces an old file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    const file = path.join(dir, 'gateway.env');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    writeEnvAtomic(file, envContent());
    assert.equal(fs.readFileSync(file, 'utf8'), envContent());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['gateway.env'], 'no temporary file left');
    assert.throws(() => writeEnvAtomic(path.join(dir, 'missing', 'gateway.env'), 'x'));
    fs.rmSync(dir, { recursive: true });
  });

  it('reads the gateway name from the comment line, printable and short', () => {
    assert.equal(peerNameFromEnv(envContent({ name: 'Synology Keller' })), 'Synology Keller');
    assert.equal(peerNameFromEnv('# Peer: A (b) c (ID: 12)\n'), 'A (b) c');
    assert.equal(peerNameFromEnv('# Peer: ' + 'x'.repeat(200) + ' (ID: 1)\n').length, 64);
    assert.equal(peerNameFromEnv('GC_SERVER_URL=x\n'), null);
    assert.equal(peerNameFromEnv(undefined), null);
  });
});
