'use strict';

// gc.lan.http.request über HTTPS: Standard = volle Zertifikatsprüfung,
// pinSha256 = Pin statt Kette (src/proxy/tlsPin.js), insecure nur mit der
// Fähigkeit http.selfSigned. Das Testzertifikat wird zur Laufzeit erzeugt.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { PluginNet } = require('../src/edge/netProxy');
const { makeLanGuard } = require('../src/edge/lanGuard');
const { validateCaps, intersectCaps } = require('../src/edge/manifest');

let srv;
let port;
let fp;
let hits = 0;
let skip = false;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=lan-device', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  } catch {
    skip = true;
    return;
  }
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  fp = new crypto.X509Certificate(cert).fingerprint256;
  srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => { hits++; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});

after(() => { if (srv) srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function net(http) {
  return new PluginNet({ pluginId: 'p', caps: () => ({ http }), guard: makeLanGuard({ getSubnets: () => ['127.0.0.0/8'] }), toChild: () => {} });
}

test('Standard: selbstsigniertes Zertifikat wird abgelehnt', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const before = hits;
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/` }), (e) => e.code === 'tls_error');
  assert.strictEqual(hits, before, 'keine Anfrage erreicht das Gerät');
});

test('pinSha256: passender Pin → Antwort; falscher Pin → tls_pin_mismatch, nichts gesendet', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const r = await net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: fp });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Buffer.from(r.b64, 'base64').toString(), 'ok');
  const r2 = await net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: fp.replace(/:/g, '').toLowerCase() });
  assert.strictEqual(r2.status, 200);
  const before = hits;
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: 'ab'.repeat(32) }), (e) => e.code === 'tls_pin_mismatch');
  assert.strictEqual(hits, before);
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: 'kaputt' }), (e) => e.code === 'bad_request');
  await assert.rejects(net({ lan: true }).httpRequest({ url: 'http://127.0.0.1:1/', pinSha256: fp }), (e) => e.code === 'bad_request');
});

test('insecure nur mit Fähigkeit http.selfSigned', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, insecure: true }), (e) => e.code === 'denied');
  const r = await net({ lan: true, selfSigned: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, insecure: true });
  assert.strictEqual(r.status, 200);
});

test('Fähigkeit selfSigned: Prüfung und Schnittmenge', () => {
  assert.deepStrictEqual(validateCaps({ http: { lan: true, selfSigned: true } }).http, { lan: true, selfSigned: true });
  assert.deepStrictEqual(validateCaps({ http: { lan: true, selfSigned: false } }).http, { lan: true });
  assert.throws(() => validateCaps({ http: { lan: true, selfSigned: 'ja' } }));
  assert.throws(() => validateCaps({ http: { lan: true, insecure: true } }));
  const m = validateCaps({ http: { lan: true, selfSigned: true } });
  assert.deepStrictEqual(intersectCaps(m, validateCaps({ http: { lan: true } })).http, { lan: true }, 'Admin hat selfSigned nicht freigegeben');
  assert.deepStrictEqual(intersectCaps(m, m).http, { lan: true, selfSigned: true });
  assert.deepStrictEqual(intersectCaps(validateCaps({ http: { lan: true } }), m).http, { lan: true }, 'Manifest verlangt es nicht');
});
