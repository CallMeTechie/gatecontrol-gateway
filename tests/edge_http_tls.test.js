'use strict';

// gc.lan.http.request über HTTPS: Standard = volle Zertifikatsprüfung,
// pinSha256 = Pin statt Kette (src/proxy/tlsPin.js); ohne Prüfung geht nichts
// (kein insecure, keine Fähigkeit http.selfSigned). gc.lan.tlsFingerprint
// liest den Fingerabdruck für trust on first use. Das Testzertifikat ist echt
// selbstsigniert und wird zur Laufzeit erzeugt.

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
const { parseState } = require('../src/edge/protocol');

let srv;
let port;
let fp;
let fpHex;
let hits = 0;
let handshakes = 0;
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
  fpHex = fp.replace(/:/g, '').toLowerCase();
  srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => { hits++; res.end('ok'); });
  srv.on('connection', () => { handshakes++; }); // TCP-Verbindungen (auch abgebrochene Handshakes)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});

after(() => { if (srv) srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function net(http, extra = {}) {
  return new PluginNet({ pluginId: 'p', caps: () => ({ http, ...extra }), guard: makeLanGuard({ getSubnets: () => ['127.0.0.0/8'] }), toChild: () => {} });
}

test('Standard: selbstsigniertes Zertifikat wird abgelehnt', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const before = hits;
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/` }), (e) => e.code === 'tls_error');
  assert.strictEqual(hits, before, 'keine Anfrage erreicht das Gerät');
});

test('pinSha256: passender Pin → Antwort; falscher Pin → tls_pin_mismatch mit neuem Fingerabdruck, nichts gesendet', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const r = await net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: fp });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Buffer.from(r.b64, 'base64').toString(), 'ok');
  const r2 = await net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: fpHex });
  assert.strictEqual(r2.status, 200);
  const before = hits;
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: 'ab'.repeat(32) }), (e) => {
    assert.strictEqual(e.code, 'tls_pin_mismatch');
    assert.strictEqual(e.data.sha256, fpHex, 'der Fehler nennt den Fingerabdruck, den das Gerät jetzt zeigt');
    assert.strictEqual(e.data.expectedSha256, 'ab'.repeat(32));
    assert.strictEqual(e.data.certificate.sha256, fpHex);
    assert.strictEqual(e.data.certificate.selfSigned, true);
    return true;
  });
  assert.strictEqual(hits, before);
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: 'kaputt' }), (e) => e.code === 'bad_request');
  await assert.rejects(net({ lan: true }).httpRequest({ url: 'http://127.0.0.1:1/', pinSha256: fp }), (e) => e.code === 'bad_request');
});

test('insecure gibt es nicht: abgelehnt (denied), auch mit einer alten Fähigkeit selfSigned, nichts gesendet', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const before = hits;
  const hs = handshakes;
  for (const caps of [{ lan: true }, { lan: true, selfSigned: true }]) {
    for (const insecure of [true, 1, 'yes']) {
      await assert.rejects(net(caps).httpRequest({ url: `https://127.0.0.1:${port}/`, insecure }), (e) => e.code === 'denied');
    }
  }
  assert.strictEqual(hits, before);
  assert.strictEqual(handshakes, hs, 'abgelehnt, bevor überhaupt eine Verbindung aufgebaut wird');
  // insecure: false fordert nur die Prüfung an, die ohnehin gilt
  await assert.rejects(net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, insecure: false }), (e) => e.code === 'tls_error');
});

test('Fähigkeit http.selfSigned gibt es nicht mehr: Manifest und state werden abgelehnt', () => {
  assert.deepStrictEqual(validateCaps({ http: { lan: true } }).http, { lan: true });
  assert.throws(() => validateCaps({ http: { lan: true, selfSigned: true } }), (e) => e.code === 'bad_caps' && /selfSigned is no longer supported/.test(e.message));
  assert.throws(() => validateCaps({ http: { lan: true, selfSigned: false } }), (e) => e.code === 'bad_caps');
  assert.throws(() => validateCaps({ http: { lan: true, insecure: true } }), (e) => e.code === 'bad_caps');
  const m = validateCaps({ http: { lan: true } });
  assert.deepStrictEqual(intersectCaps(m, { http: { lan: true, selfSigned: true } }).http, { lan: true }, 'nie durch die Schnittmenge');
  // ein state eines älteren Servers mit selfSigned → Edge-Teil abgelehnt (bad_caps), nie still ohne Prüfung
  const st = parseState({ t: 'state', edgeEnabled: true, plugins: [{ id: 'demo-plugin', version: '1.0.0', sha256: 'a'.repeat(64), caps: { http: { lan: true, selfSigned: true } } }] });
  assert.match(st.plugins[0].capsError, /selfSigned is no longer supported/);
  assert.deepStrictEqual(st.plugins[0].caps, {});
});

test('tlsFingerprint: liefert das Leaf-Zertifikat, nur Handshake, keine Anfrage', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const before = hits;
  const hs = handshakes;
  const info = await net({ lan: true }).tlsFingerprint({ host: '127.0.0.1', port });
  assert.deepStrictEqual(Object.keys(info).sort(), ['issuer', 'selfSigned', 'sha256', 'subject', 'validTo']);
  assert.strictEqual(info.sha256, fpHex);
  assert.strictEqual(info.subject, 'CN=lan-device');
  assert.strictEqual(info.issuer, 'CN=lan-device');
  assert.strictEqual(info.selfSigned, true);
  assert.ok(Date.parse(info.validTo) > Date.now());
  for (let i = 0; i < 50 && handshakes === hs; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(handshakes, hs + 1, 'genau eine Verbindung');
  assert.strictEqual(hits, before, 'keine HTTP-Anfrage');
  // der gelesene Wert ist als Pin direkt verwendbar
  const r = await net({ lan: true }).httpRequest({ url: `https://127.0.0.1:${port}/`, pinSha256: info.sha256 });
  assert.strictEqual(r.status, 200);
  // tcp.lan reicht auch
  assert.strictEqual((await net(undefined, { tcp: { lan: true } }).tlsFingerprint({ host: '127.0.0.1', port })).sha256, fpHex);
});

test('tlsFingerprint: Fähigkeit, Ziele, Port, Fehler', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const hs = handshakes;
  await assert.rejects(net(undefined).tlsFingerprint({ host: '127.0.0.1', port }), (e) => e.code === 'denied');
  await assert.rejects(net({ lan: false }).tlsFingerprint({ host: '127.0.0.1', port }), (e) => e.code === 'denied');
  for (const host of ['8.8.8.8', '1.1.1.1', '192.168.1.10', 'example.com', 'localhost', '::1', undefined]) {
    await assert.rejects(net({ lan: true }).tlsFingerprint({ host, port }), (e) => e.code === 'denied', String(host));
  }
  for (const p of [0, 70000, 'x', 1.5]) {
    await assert.rejects(net({ lan: true }).tlsFingerprint({ host: '127.0.0.1', port: p }), (e) => e.code === 'denied', String(p));
  }
  assert.strictEqual(handshakes, hs, 'abgelehnte Ziele werden nicht kontaktiert');
  // geschlossener Port → net_error
  const closed = await new Promise((r) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await assert.rejects(net({ lan: true }).tlsFingerprint({ host: '127.0.0.1', port: closed }), (e) => e.code === 'net_error');
});

test('tlsFingerprint: Zeitlimit, wenn das Gerät den Handshake nicht beantwortet', async () => {
  const silent = require('node:net').createServer((s) => { s.on('error', () => {}); setTimeout(() => s.destroy(), 3000).unref(); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  await assert.rejects(net({ lan: true }).tlsFingerprint({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 1000 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2500);
  silent.close();
});

test('Edge-Teil (echter Plugin-Prozess): tlsFingerprint → Pin merken → gepinnte Anfrage; pin_mismatch mit e.sha256; insecure → denied', async (t) => {
  if (skip) return t.skip('openssl fehlt');
  const { EdgeProcess } = require('../src/edge/pluginProcess');
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-tofu-'));
  fs.mkdirSync(path.join(pdir, 'edge'));
  fs.writeFileSync(path.join(pdir, 'edge/index.js'), `
    module.exports = { start(gc) {
      gc.handle('fp', (p) => gc.lan.tlsFingerprint({ host: '127.0.0.1', port: p.port }));
      gc.handle('get', async (p) => {
        try {
          const r = await gc.lan.http.request({ url: 'https://127.0.0.1:' + p.port + '/', pinSha256: p.pin, insecure: p.insecure });
          return { status: r.status, text: r.text() };
        } catch (e) { return { code: e.code, sha256: e.sha256 || null, expectedSha256: e.expectedSha256 || null, certificate: e.certificate || null }; }
      });
    } };`);
  const pnet = net({ lan: true });
  const proc = new EdgeProcess({ id: 'tofu', version: '1.0.0', dir: pdir, entry: 'edge/index.js', memoryMb: 32 },
    { hooks: { hostCall: (api, args) => pnet.apis()[api](args), config: () => null } });
  t.after(async () => { await proc.stop(); fs.rmSync(pdir, { recursive: true, force: true }); });
  const started = new Promise((resolve, reject) => { proc.once('started', resolve); proc.once('exit', () => reject(new Error(proc.lastError || 'exit'))); });
  proc.start();
  await started;
  const info = await proc.call('fp', { port });
  assert.strictEqual(info.sha256, fpHex);
  assert.strictEqual(info.selfSigned, true);
  assert.deepStrictEqual(await proc.call('get', { port, pin: info.sha256 }), { status: 200, text: 'ok' });
  const mm = await proc.call('get', { port, pin: 'cd'.repeat(32) });
  assert.strictEqual(mm.code, 'tls_pin_mismatch');
  assert.strictEqual(mm.sha256, fpHex, 'neuer Fingerabdruck am Fehler');
  assert.strictEqual(mm.expectedSha256, 'cd'.repeat(32));
  assert.strictEqual(mm.certificate.subject, 'CN=lan-device');
  assert.strictEqual((await proc.call('get', { port, insecure: true })).code, 'denied');
  assert.strictEqual((await proc.call('get', { port })).code, 'tls_error', 'ohne Pin: volle Prüfung, selbstsigniert scheitert');
});
