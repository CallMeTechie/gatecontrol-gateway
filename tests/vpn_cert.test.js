'use strict';

// Zertifikat der VPN-Namen (src/vpncert/vpnCert.js, docs/vpn-cert.md):
// Prüfung der Antwort, Ablage (atomar, Rechte), Löschen, Wiederholung mit
// Backoff, Status/Heartbeat ohne Schlüssel, Anzeige auf der Statusseite.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { VpnCertManager, parseSummary, verifyMaterial, writeAtomic, CERT_FILE, KEY_FILE, META_FILE } = require('../src/vpncert/vpnCert');
const { createSetupController } = require('../src/setup/controller');
const { envContent } = require('./helpers/fakePairServer');

const WILDCARD = '*.vpn.example.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(5); }
  throw new Error('timeout waiting for condition');
}

function material(names = [WILDCARD]) {
  const c = makeSelfSigned({ commonName: names[0], days: 90, altNames: names.map((dns) => ({ dns })) });
  return { ...c, summary: { wildcard: WILDCARD, fingerprint: c.sha256, not_after: new Date(Date.now() + 90 * 86_400_000).toISOString() } };
}
const okBody = (m) => ({ ok: true, wildcard: WILDCARD, zone: 'vpn.example.com', cert_pem: m.cert, key_pem: m.key, not_after: m.summary.not_after, fingerprint: m.sha256 });

function recordingLogger() {
  const lines = [];
  const rec = (level) => (...args) => lines.push({ level, text: JSON.stringify(args) });
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
}

describe('vpn cert: summary from the config pull', () => {
  it('takes wildcard, fingerprint and expiry, refuses anything else', () => {
    const fp = 'ab'.repeat(32);
    assert.deepEqual(parseSummary({ wildcard: '*.VPN.example.com', fingerprint: fp.toUpperCase(), not_after: '2027-02-01T00:00:00Z' }),
      { wildcard: '*.vpn.example.com', zone: 'vpn.example.com', fingerprint: fp, notAfter: '2027-02-01T00:00:00.000Z' });
    assert.equal(parseSummary(undefined), null);
    assert.equal(parseSummary(null), null);
    assert.equal(parseSummary({ wildcard: 'vpn.example.com', fingerprint: fp }), null);
    assert.equal(parseSummary({ wildcard: '*.vpn.example.com', fingerprint: 'xyz' }), null);
    assert.equal(parseSummary({ wildcard: '*.bad_zone/../x', fingerprint: fp }), null);
  });
});

describe('vpn cert: checking the answer', () => {
  it('accepts the certificate whose fingerprint the config named', () => {
    const m = material();
    const r = verifyMaterial(okBody(m), parseSummary(m.summary));
    assert.equal(r.fingerprint, m.sha256);
    assert.equal(r.keyPem, m.key);
  });
  it('discards another certificate (fingerprint), a foreign key and a wrong name', () => {
    const m = material();
    const other = material();
    const want = parseSummary(m.summary);
    assert.throws(() => verifyMaterial(okBody(other), want), { code: 'fingerprint_mismatch' });
    assert.throws(() => verifyMaterial({ ...okBody(m), fingerprint: other.sha256 }, want), { code: 'fingerprint_mismatch' });
    assert.throws(() => verifyMaterial({ ...okBody(m), key_pem: other.key }, want), { code: 'key_mismatch' });
    const named = material(['*.other.example.com']);
    assert.throws(() => verifyMaterial(okBody(named), { ...want, fingerprint: named.sha256 }), { code: 'wrong_name' });
    assert.throws(() => verifyMaterial({ ok: true, cert_pem: 'nope', key_pem: 'nope' }, want), { code: 'bad_response' });
    assert.throws(() => verifyMaterial(null, want), { code: 'bad_response' });
  });
});

describe('vpn cert: manager', () => {
  let dir;
  beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpncert-')), 'vpn-cert'); });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  function make({ answers, ...extra } = {}) {
    const calls = [];
    const logger = recordingLogger();
    const mgr = new VpnCertManager({
      dir, apiToken: 'gc_gw_' + 'a'.repeat(64), tunnelIp: '10.8.0.5', logger, retryMinMs: 20, retryMaxMs: 80,
      fetch: async (o) => { calls.push(o); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
      ...extra,
    });
    return { mgr, calls, logger };
  }

  it('fetches over the tunnel, stores certificate and key atomically with tight modes', async () => {
    const m = material();
    const { mgr, calls, logger } = make({ answers: [{ status: 200, body: okBody(m) }] });
    assert.equal(mgr.status(), null, 'nothing shared, nothing shown');
    mgr.apply(m.summary, { serverIp: '10.8.0.1' });
    await until(() => mgr.state === 'ok');
    assert.equal(calls.length, 1);
    assert.deepEqual({ serverIp: calls[0].serverIp, zone: calls[0].zone, localAddress: calls[0].localAddress }, { serverIp: '10.8.0.1', zone: 'vpn.example.com', localAddress: '10.8.0.5' });
    assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), m.key);
    assert.equal(fs.readFileSync(path.join(dir, CERT_FILE), 'utf8'), m.cert);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, CERT_FILE)).mode & 0o777, 0o600);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
    assert.equal(meta.fingerprint, m.sha256);
    assert.deepEqual(fs.readdirSync(dir).sort(), [CERT_FILE, META_FILE, KEY_FILE].sort(), 'no temporary files left');
    assert.deepEqual(mgr.telemetry(), { fingerprint: m.sha256, not_after: mgr.status().notAfter });
    const st = mgr.status();
    assert.equal(st.state, 'ok');
    assert.equal(st.fingerprint, m.sha256);
    assert.ok(st.fetchedAt > 0);
    const everything = JSON.stringify([st, mgr.telemetry(), logger.lines]);
    assert.ok(!everything.includes('PRIVATE KEY'), 'the key is never in status, heartbeat or log');
    assert.ok(!everything.includes(m.key.split('\n')[1]));
  });

  it('same fingerprint again: no new fetch; new fingerprint: fetches the new one', async () => {
    const a = material();
    const b = material();
    const { mgr, calls } = make({ answers: [{ status: 200, body: okBody(a) }, { status: 200, body: okBody(b) }] });
    mgr.apply(a.summary);
    await until(() => mgr.state === 'ok');
    mgr.apply({ ...a.summary });
    await wait(30);
    assert.equal(calls.length, 1);
    mgr.apply(b.summary);
    await until(() => mgr.telemetry()?.fingerprint === b.sha256);
    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf8'), b.key);
  });

  it('a certificate with another fingerprint is discarded and fetched again with backoff', async () => {
    const want = material();
    const other = material();
    const { mgr, calls } = make({ answers: [{ status: 200, body: okBody(other) }, { status: 403, body: { ok: false, error: 'not_from_vpn' } }, new Error('socket hang up'), { status: 200, body: okBody(want) }] });
    mgr.apply(want.summary);
    await until(() => calls.length >= 1 && mgr.state === 'error');
    assert.equal(mgr.status().error, 'fingerprint_mismatch');
    assert.equal(fs.existsSync(path.join(dir, KEY_FILE)), false, 'nothing stored');
    await until(() => mgr.state === 'error' && mgr.error === 'not_from_vpn');
    await until(() => mgr.state === 'error' && mgr.error === 'fetch_failed');
    const t3 = mgr.nextRetryAt - mgr.lastAttemptAt;
    assert.ok(t3 >= 80 && t3 < 130, `third retry capped at retryMaxMs (got ${t3})`);
    await until(() => mgr.state === 'ok', 2000);
    assert.equal(calls.length, 4);
    assert.equal(mgr.failures, 0);
    assert.equal(mgr.status().error, null);
  });

  it('vpn_cert missing in the config: certificate, key and folder are removed', async () => {
    const m = material();
    const { mgr } = make({ answers: [{ status: 200, body: okBody(m) }] });
    mgr.apply(m.summary);
    await until(() => mgr.state === 'ok');
    mgr.apply(undefined);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(mgr.telemetry(), null);
    assert.equal(mgr.status(), null);
  });

  it('a pending retry stops when passing on is switched off', async () => {
    const m = material();
    const { mgr, calls } = make({ answers: [{ status: 404, body: { ok: false, error: 'no_certificate' } }], retryMinMs: 40 });
    mgr.apply(m.summary);
    await until(() => mgr.state === 'error');
    mgr.apply(undefined);
    await wait(80);
    assert.equal(calls.length, 1);
    assert.equal(mgr.timer, null);
  });

  it('after a restart: the stored certificate counts until the config says otherwise', async () => {
    const m = material();
    const first = make({ answers: [{ status: 200, body: okBody(m) }] });
    first.mgr.apply(m.summary);
    await until(() => first.mgr.state === 'ok');
    const again = make({ answers: [] });
    assert.equal(again.mgr.state, 'ok');
    assert.deepEqual(again.mgr.telemetry(), first.mgr.telemetry());
    again.mgr.apply(m.summary);
    await wait(20);
    assert.equal(again.calls.length, 0, 'same fingerprint: nothing fetched');
  });

  it('a fingerprint change during a fetch fetches the newer one right after', async () => {
    const a = material();
    const b = material();
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const mgr = new VpnCertManager({
      dir, apiToken: 't', retryMinMs: 20,
      fetch: async () => { calls.push(1); if (calls.length === 1) { await gate; return { status: 200, body: okBody(a) }; } return { status: 200, body: okBody(b) }; },
    });
    mgr.apply(a.summary);
    await until(() => calls.length === 1);
    mgr.apply(b.summary);
    release();
    await until(() => mgr.telemetry()?.fingerprint === b.sha256);
    assert.equal(calls.length, 2);
  });

  it('writeAtomic leaves no temporary file when writing fails', () => {
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => writeAtomic(path.join(dir, 'missing', 'x.pem'), 'x'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('vpn cert: status page', () => {
  it('shows state, name, fingerprint, expiry, last fetch and error – never key or path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-cert-'));
    try {
      fs.mkdirSync(path.join(tmp, 'config'));
      const envPath = path.join(tmp, 'config', 'gateway.env');
      fs.writeFileSync(envPath, envContent({ serverUrl: 'https://gate.example.com' }));
      let t = 1_000_000;
      const c = createSetupController({
        envPath, stateDir: tmp, logger: { info() {}, warn() {}, error() {}, debug() {} }, now: () => t,
        checksDeps: { internetAndClock: async () => ({ internet: true, clock: true }), vpnDevice: async () => ({ ok: true }), configWritable: () => true },
        platform: { kind: 'docker', label: 'Docker' },
      });
      c.load();
      c.hooks.onHeartbeat({ ok: true, status: 200 });
      let snap = await c.snapshot();
      assert.equal(snap.vpnCert, null);
      const fp = 'cd'.repeat(32);
      c.hooks.attachVpnCert(() => ({ state: 'error', wildcard: WILDCARD, fingerprint: fp, notAfter: '2027-02-01T00:00:00.000Z', fetchedAt: t - 120_000, error: 'not_from_vpn', nextRetryAt: t + 60_000, key: 'secret' }));
      snap = await c.snapshot();
      assert.deepEqual(snap.vpnCert, { state: 'error', wildcard: WILDCARD, fingerprint: fp, notAfter: '2027-02-01T00:00:00.000Z', fetchedAgoS: 120, error: 'not_from_vpn', retryInS: 60 });
      c.hooks.attachVpnCert(() => { throw new Error('boom'); });
      assert.equal((await c.snapshot()).vpnCert, null);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
