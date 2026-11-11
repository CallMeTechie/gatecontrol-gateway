'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSetupController, RATE_MAX, RATE_WINDOW_MS } = require('../src/setup/controller');
const { PairError } = require('../src/setup/pairing');
const { parseConfig } = require('../src/config');
const { envContent } = require('./helpers/fakePairServer');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const CODE = 'A3F9-27C1-0BDE-58E4';
const allOk = { internetAndClock: async () => ({ internet: true, clock: true }), vpnDevice: async () => ({ ok: true }), configWritable: () => true };
const REFUSED = { ok: false, status: 403, error: 'invalid_token' };

describe('setup page: controller', () => {
  let dir, envPath, t, restarts;
  const now = () => t;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.mkdirSync(path.join(dir, 'state'));
    envPath = path.join(dir, 'config', 'gateway.env');
    t = 1_000_000;
    restarts = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function make(extra = {}) {
    const text = envContent({ serverUrl: 'https://gate.example.de' });
    const redeemed = [];
    const c = createSetupController({
      envPath, stateDir: path.join(dir, 'state'), logger: silent, now, checksDeps: allOk,
      platform: { kind: 'synology', label: 'Synology DS224+' },
      redeem: async (p) => { redeemed.push(p); return { envContent: text, config: parseConfig(text), name: 'Synology Keller' }; },
      onRestart: () => { restarts += 1; },
      ...extra,
    });
    return { c, redeemed };
  }

  it('without gateway.env: setup mode, the page shows checks and no secrets', async () => {
    const { c } = make();
    assert.equal(c.load(), null);
    assert.equal(c.mode(), 'setup');
    assert.equal(c.visible(), true);
    const snap = await c.snapshot();
    assert.equal(snap.mode, 'setup');
    assert.equal(snap.ready, true);
    assert.equal(snap.device, 'Synology DS224+');
    assert.deepEqual(snap.checks, { internet: true, clock: true, tun: true, config: true });
    assert.equal(snap.attemptsLeft, RATE_MAX);
  });

  it('an unreadable or invalid gateway.env also leads to setup mode', () => {
    fs.writeFileSync(envPath, 'GC_SERVER_URL=nonsense\n');
    const { c } = make();
    assert.equal(c.load(), null);
    assert.equal(c.mode(), 'setup');
  });

  it('with a valid gateway.env: connecting, then status page only', async () => {
    fs.writeFileSync(envPath, envContent({ serverUrl: 'https://gate.example.de' }));
    const { c } = make();
    const cfg = c.load();
    assert.equal(cfg.tunnelIp, '10.8.0.7');
    assert.equal(c.mode(), 'connecting');
    assert.deepEqual((await c.snapshot()).steps, { code: null, saved: 'done', tunnel: 'wait', online: 'todo' });
    assert.deepEqual(await c.pair({ server: 'evil.example.com', code: CODE }), { ok: false, status: 409, error: 'not_in_setup' });
    c.hooks.onHeartbeat({ ok: true, status: 200 });
    assert.equal(c.mode(), 'connected');
    t += 12_000;
    const snap = await c.snapshot();
    assert.equal(snap.server, 'gate.example.de');
    assert.equal(snap.name, 'Synology Keller');
    assert.equal(snap.lastContactS, 12);
    assert.equal(snap.openUrl, 'https://gate.example.de/gateways');
    // keine Eingaben, keine Geheimnisse
    assert.deepEqual(await c.pair({ server: 'evil.example.com', code: CODE }), { ok: false, status: 409, error: 'not_in_setup' });
    const all = JSON.stringify(snap);
    assert.doesNotMatch(all, /gc_gw_|bbbbbbbb|priv|10\.8\.0\./);
    assert.deepEqual(c.tunnel().tunnelIp, '10.8.0.7');
  });

  it('pairing: writes gateway.env (0600), reports the steps and hands the config to the waiting start', async () => {
    const { c, redeemed } = make();
    c.load();
    const waiting = c.waitForPairing();
    const r = await c.pair({ server: 'https://gate.example.de/login', code: 'a3f9 27c1 0bde 58e4' });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(redeemed[0].server, { host: 'gate.example.de', port: 443, display: 'gate.example.de', origin: 'https://gate.example.de' });
    assert.equal(redeemed[0].code, CODE);
    assert.equal((await waiting).tunnelIp, '10.8.0.7');
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(c.mode(), 'connecting');
    const snap = await c.snapshot();
    assert.deepEqual(snap.steps, { code: 'done', saved: 'done', tunnel: 'wait', online: 'todo' });
    assert.equal(snap.name, 'Synology Keller');
    assert.equal(restarts, 0);
  });

  it('the old form CODE@host fills the server address', async () => {
    const { c, redeemed } = make();
    c.load();
    assert.deepEqual(await c.pair({ server: '', code: `${CODE}@gate.example.de` }), { ok: true });
    assert.equal(redeemed[0].server.host, 'gate.example.de');
  });

  it('bad input is refused before anything is sent and does not use up attempts', async () => {
    const { c, redeemed } = make();
    c.load();
    assert.equal((await c.pair({ server: 'gate.example.de', code: 'nope' })).error, 'bad_code');
    assert.equal((await c.pair({ server: 'not a host', code: CODE })).error, 'bad_server');
    assert.equal((await c.pair({ code: CODE })).error, 'bad_server');
    assert.equal((await c.pair(null)).error, 'bad_code');
    assert.equal(redeemed.length, 0);
    assert.equal((await c.snapshot()).attemptsLeft, RATE_MAX);
  });

  it('rate limit: 5 attempts per 5 minutes, then a wait time', async () => {
    const { c, redeemed } = make({ redeem: async () => { throw new PairError('code_rejected'); } });
    c.load();
    for (let i = 0; i < RATE_MAX; i++) {
      const r = await c.pair({ server: 'gate.example.de', code: CODE });
      assert.equal(r.error, 'code_rejected');
      assert.equal(r.server, 'gate.example.de');
      t += 10_000;
    }
    const blocked = await c.pair({ server: 'gate.example.de', code: CODE });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.error, 'rate_limited');
    assert.equal(blocked.retryAfterS, (RATE_WINDOW_MS - 50_000) / 1000);
    assert.equal((await c.snapshot()).attemptsLeft, 0);
    assert.equal(redeemed.length, 0);
    t += RATE_WINDOW_MS - 50_000;
    assert.equal((await c.pair({ server: 'gate.example.de', code: CODE })).error, 'code_rejected');
  });

  it('config folder read-only: the code is not sent (it would be used up)', async () => {
    const { c, redeemed } = make({ checksDeps: { ...allOk, configWritable: () => false } });
    c.load();
    assert.equal((await c.snapshot()).ready, false);
    const r = await c.pair({ server: 'gate.example.de', code: CODE });
    assert.deepEqual(r, { ok: false, status: 409, error: 'config_readonly' });
    assert.equal(redeemed.length, 0);
  });

  it('a missing requirement blocks connecting', async () => {
    const { c, redeemed } = make({ checksDeps: { ...allOk, vpnDevice: async () => ({ ok: false }) } });
    c.load();
    const snap = await c.snapshot();
    assert.equal(snap.ready, false);
    assert.equal(snap.checks.tun, false);
    assert.equal((await c.pair({ server: 'gate.example.de', code: CODE })).error, 'not_ready');
    assert.equal(redeemed.length, 0);
  });

  it('server errors reach the page only as fixed reasons', async () => {
    const { c } = make({ redeem: async () => { const e = new Error('<b>secret detail</b>'); e.response = { data: 'x' }; throw e; } });
    c.load();
    const r = await c.pair({ server: 'gate.example.de', code: CODE });
    assert.deepEqual(r, { ok: false, status: 502, error: 'server_unreachable', server: 'gate.example.de' });
    assert.equal(fs.existsSync(envPath), false);
  });

  describe('state F: the server refuses the access', () => {
    function connected(extra) {
      fs.writeFileSync(envPath, envContent({ serverUrl: 'https://gate.example.de' }));
      const m = make(extra);
      m.c.load();
      m.c.hooks.onHeartbeat({ ok: true, status: 200 });
      return m;
    }

    it('opens the code entry only after several refusals over time', () => {
      const { c } = connected();
      for (let i = 0; i < 3; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      assert.equal(c.mode(), 'connected', 'three refusals are not enough');
      c.hooks.onHeartbeat(REFUSED);
      assert.equal(c.mode(), 'invalid');
      assert.equal(c.visible(), true);
    });

    it('many refusals in a short time are not enough', () => {
      const { c } = connected();
      for (let i = 0; i < 10; i++) { c.hooks.onHeartbeat(REFUSED); t += 1_000; }
      assert.equal(c.mode(), 'connected');
    });

    it('never on network errors, timeouts, TLS errors or error pages', () => {
      const { c } = connected();
      const others = [
        { ok: false, status: null, error: null },                 // Netz/Timeout/TLS
        { ok: false, status: 403, error: null },                  // 403-Seite eines Proxys/WAF
        { ok: false, status: 401, error: null },                  // Basic-Auth eines Proxys
        { ok: false, status: 403, error: 'gateway_disabled' },    // Gateway in GateControl deaktiviert
        { ok: false, status: 500, error: 'invalid_token' },
        { ok: false, status: 429, error: null },
        { ok: false, status: 502, error: null },
        undefined,
      ];
      for (let i = 0; i < 40; i++) { c.hooks.onHeartbeat(others[i % others.length]); t += 30_000; }
      assert.equal(c.mode(), 'connected');
    });

    it('a success in between starts the count again', () => {
      const { c } = connected();
      for (let i = 0; i < 3; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      c.hooks.onHeartbeat({ ok: true, status: 200 });
      for (let i = 0; i < 3; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      assert.equal(c.mode(), 'connected');
    });

    it('the server address is fixed: no moving to another server from the home network', async () => {
      const { c, redeemed } = connected();
      for (let i = 0; i < 5; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      const snap = await c.snapshot();
      assert.equal(snap.mode, 'invalid');
      assert.equal(snap.server, 'gate.example.de');
      assert.equal(snap.ready, true);
      assert.deepEqual(await c.pair({ server: 'evil.example.com', code: `${CODE}@evil.example.com` }), { ok: true });
      assert.equal(redeemed.length, 1);
      assert.equal(redeemed[0].server.host, 'gate.example.de');
      assert.equal(redeemed[0].server.port, 443);
      await new Promise((r) => setImmediate(r));
      assert.equal(restarts, 1, 'the process restarts with the new gateway.env');
      assert.equal(c.mode(), 'connecting');
    });

    it('with a read-only config folder the page says so and does not use up the code', async () => {
      const { c, redeemed } = connected({ checksDeps: { ...allOk, configWritable: () => false } });
      for (let i = 0; i < 5; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      const snap = await c.snapshot();
      assert.equal(snap.checks.config, false);
      assert.equal(snap.ready, false);
      assert.equal((await c.pair({ code: CODE })).error, 'config_readonly');
      assert.equal(redeemed.length, 0);
      assert.equal(restarts, 0);
    });

    it('closes again when the server accepts the gateway after all', () => {
      const { c } = connected();
      for (let i = 0; i < 5; i++) { c.hooks.onHeartbeat(REFUSED); t += 30_000; }
      assert.equal(c.mode(), 'invalid');
      c.hooks.onHeartbeat({ ok: true, status: 200 });
      assert.equal(c.mode(), 'connected');
    });
  });

  describe('"Statusseite im Heimnetz" (switched per gateway by the server)', () => {
    it('default on; off closes the status page, survives a restart, never hides setup or state F', () => {
      fs.writeFileSync(envPath, envContent());
      const { c } = make();
      c.load();
      c.hooks.onHeartbeat({ ok: true, status: 200 });
      let changes = 0;
      c.onChange(() => { changes += 1; });
      c.hooks.onConfig({ features: {} });
      assert.equal(c.visible(), true);
      assert.equal(changes, 0);
      c.hooks.onConfig({ features: { setup_page: { status: false } } });
      assert.equal(c.visible(), false);
      assert.equal(changes, 1);
      assert.deepEqual(c.hooks.telemetry(), { status: false, mode: 'connected' });

      // Neustart: die Einstellung gilt, bevor der erste Config-Pull da ist
      const again = make().c;
      again.load();
      assert.equal(again.visible(), false);
      for (let i = 0; i < 5; i++) { again.hooks.onHeartbeat(REFUSED); t += 30_000; }
      assert.equal(again.visible(), true, 'state F opens the page regardless');
      again.hooks.onConfig({ features: { setup_page: { status: true } } });
      assert.equal(again.visible(), true);

      // ohne gateway.env immer sichtbar
      fs.rmSync(envPath);
      fs.writeFileSync(path.join(dir, 'state', 'setup-page.json'), JSON.stringify({ status: false }));
      const fresh = make().c;
      fresh.load();
      assert.equal(fresh.visible(), true);
    });

    it('an old server (no features.setup_page) leaves it on', () => {
      fs.writeFileSync(envPath, envContent());
      const { c } = make();
      c.load();
      c.hooks.onConfig({});
      c.hooks.onConfig({ features: { setup_page: 'off' } });
      c.hooks.onConfig(undefined);
      assert.equal(c.visible(), true);
    });
  });

  it('tunnel state for the status page comes from the WireGuard handshake', async () => {
    fs.writeFileSync(envPath, envContent());
    let age = null;
    const { c } = make({ wireguard: { getStatus: async () => ({ peers: [{ handshakeAgeS: age }] }) } });
    c.load();
    assert.equal((await c.snapshot()).steps.tunnel, 'wait');
    c.hooks.onStage('wg_up');
    assert.equal((await c.snapshot()).steps.tunnel, 'wait');
    age = 4; t += 6_000;
    assert.equal((await c.snapshot()).steps.tunnel, 'done');
    c.hooks.onHeartbeat({ ok: true, status: 200 });
    t += 120_000;
    const snap = await c.snapshot();
    assert.equal(snap.tunnelUp, true);
    assert.equal(snap.tunnelSinceS, 120);
    age = 900; t += 6_000;
    assert.equal((await c.snapshot()).tunnelUp, false);
  });
});
