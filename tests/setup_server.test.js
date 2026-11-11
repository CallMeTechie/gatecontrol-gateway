'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createSetupController } = require('../src/setup/controller');
const { createSetupServer } = require('../src/setup/server');
const { startFakePairServer, envContent, API_TOKEN, GATEWAY_TOKEN } = require('./helpers/fakePairServer');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const allOk = { internetAndClock: async () => ({ internet: true, clock: true }), vpnDevice: async () => ({ ok: true }), configWritable: () => true };
const CODE = 'A3F9-27C1-0BDE-58E4';

function request(port, { method = 'GET', path: p = '/', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host || `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === null ? undefined : body);
  });
}

describe('setup page: HTTP server', () => {
  let dir, envPath, pairSrv, controller, server, port;

  async function start({ env = false, tunnel = null, checksDeps = allOk, allowedHosts = [] } = {}) {
    if (env) fs.writeFileSync(envPath, envContent());
    controller = createSetupController({
      envPath, stateDir: path.join(dir, 'state'), logger: silent, checksDeps, tls: pairSrv.tls,
      platform: { kind: 'other', label: 'Testgerät' },
    });
    controller.load();
    if (tunnel) controller.tunnel = () => tunnel;
    server = createSetupServer({ controller, logger: silent, port: 0, bind: '127.0.0.1', allowedHosts });
    await server.start();
    port = server.address(0).port;
  }
  const post = (body, headers = {}) => request(port, {
    method: 'POST', path: '/api/pair', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-GC-Setup': controller.csrf, ...headers },
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.mkdirSync(path.join(dir, 'state'));
    envPath = path.join(dir, 'config', 'gateway.env');
    pairSrv = await startFakePairServer({ codes: [CODE] });
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    await pairSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page without external resources and with a strict CSP', async () => {
    await start();
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    // keine Inline-Skripte/-Stile, nichts von außen
    assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(page.text, /<style|style=|https?:\/\//i);
    for (const f of ['/setup.css', '/setup.js']) {
      const r = await request(port, { path: f });
      assert.equal(r.status, 200, f);
      assert.doesNotMatch(r.text, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, f + ' loads nothing from outside');
      assert.doesNotMatch(r.text, /innerHTML|document\.write|eval\(/, f);
    }
    assert.equal((await request(port, { path: '/healthz' })).status, 200);
    assert.equal((await request(port, { path: '/etc/passwd' })).status, 404);
    assert.equal((await request(port, { path: '/../package.json' })).status, 404);
    assert.equal((await request(port, { method: 'DELETE', path: '/api/state' })).status, 405);
  });

  it('state in setup mode: checks, no secrets', async () => {
    await start();
    const r = await request(port, { path: '/api/state' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'setup');
    assert.equal(r.json.ready, true);
    assert.deepEqual(r.json.checks, { internet: true, clock: true, tun: true, config: true });
  });

  it('refuses foreign Host headers (DNS rebinding) and proxied requests', async () => {
    await start();
    for (const host of ['evil.example.com', `evil.example.com:${port}`, '8.8.8.8']) {
      const r = await request(port, { path: '/api/state', host });
      assert.equal(r.status, 421, host);
      assert.equal(r.json, null);
    }
    assert.equal((await request(port, { path: '/api/state', host: 'gatecontrol.local' })).status, 200);
    for (const h of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'Via']) {
      assert.equal((await request(port, { path: '/api/state', headers: { [h]: '203.0.113.5' } })).status, 403, h);
    }
    assert.equal((await post({ server: pairSrv.address, code: CODE }, { 'X-Forwarded-For': '192.168.1.5' })).status, 403);
    assert.equal(pairSrv.requests.length, 0);
  });

  it('GC_SETUP_ALLOWED_HOSTS adds a name', async () => {
    await start({ allowedHosts: ['nas.fritz.box'] });
    assert.equal((await request(port, { path: '/api/state', host: 'nas.fritz.box:8642' })).status, 200);
    assert.equal((await request(port, { path: '/api/state', host: 'other.fritz.box' })).status, 421);
  });

  it('CSRF: no pairing without the token of the page, from another origin or as a form post', async () => {
    await start();
    const body = JSON.stringify({ server: pairSrv.address, code: CODE });
    const tries = [
      { headers: { 'Content-Type': 'application/json' } },
      { headers: { 'Content-Type': 'application/json', 'X-GC-Setup': 'x'.repeat(48) } },
      { headers: { 'Content-Type': 'text/plain', 'X-GC-Setup': controller.csrf } },
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GC-Setup': controller.csrf } },
      { headers: { 'Content-Type': 'application/json', 'X-GC-Setup': controller.csrf, Origin: 'https://evil.example.com' } },
      { headers: { 'Content-Type': 'application/json', 'X-GC-Setup': controller.csrf, 'Sec-Fetch-Site': 'cross-site' } },
    ];
    for (const t of tries) {
      const r = await request(port, { method: 'POST', path: '/api/pair', body, ...t });
      assert.equal(r.status, 403, JSON.stringify(t.headers));
      assert.deepEqual(r.json, { ok: false, error: 'forbidden' });
    }
    assert.equal(pairSrv.requests.length, 0, 'nothing was sent to the server');
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post(JSON.stringify({ code: 'x'.repeat(5000) }))).status, 400);
  });

  it('pairs through the page against the test server and then only shows the state', async () => {
    await start();
    const waiting = controller.waitForPairing();
    const wrong = await post({ server: pairSrv.address, code: '0000-0000-0000-0000' });
    assert.equal(wrong.status, 502);
    assert.deepEqual(wrong.json, { ok: false, error: 'code_rejected', server: pairSrv.address });

    const ok = await post({ server: `https://${pairSrv.address}/gateways`, code: CODE.toLowerCase() }, { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true });
    const cfg = await waiting;
    assert.equal(cfg.apiToken, API_TOKEN);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(envPath, 'utf8'), /^GC_GATEWAY_TOKEN=/m);

    const st = await request(port, { path: '/api/state' });
    assert.equal(st.json.mode, 'connecting');
    assert.deepEqual(st.json.steps, { code: 'done', saved: 'done', tunnel: 'wait', online: 'todo' });
    assert.equal(st.json.name, 'Synology Keller');
    controller.hooks.onHeartbeat({ ok: true, status: 200 });
    const done = await request(port, { path: '/api/state' });
    assert.equal(done.json.mode, 'connected');
    // keine Eingaben mehr, keine Geheimnisse – in keiner Antwort
    assert.equal((await post({ server: pairSrv.address, code: CODE })).status, 409);
    for (const text of [ok.text, st.text, done.text]) {
      assert.ok(!text.includes(API_TOKEN) && !text.includes(GATEWAY_TOKEN) && !/WG_|priv/.test(text));
    }
  });

  it('rate limit over HTTP: the sixth attempt gets 429 with Retry-After', async () => {
    await start();
    for (let i = 0; i < 5; i++) assert.equal((await post({ server: pairSrv.address, code: '0000-0000-0000-0000' })).status, 502);
    const r = await post({ server: pairSrv.address, code: CODE });
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'rate_limited');
    assert.ok(Number(r.headers['retry-after']) > 200);
    assert.equal(pairSrv.requests.length, 5);
    assert.ok(pairSrv.codes.has(CODE), 'the good code was not used up');
  });

  it('closes connections that come through the tunnel without an answer', async () => {
    // die Verbindung kommt auf der „Tunnel-Adresse“ des Gateways an
    await start({ env: true, tunnel: { tunnelIp: '127.0.0.1', tunnelCidrs: [] } });
    await assert.rejects(request(port, { path: '/api/state' }), /ECONNRESET|socket hang up/);
    const got = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      let data = '';
      s.on('data', (c) => { data += c; });
      s.on('close', () => resolve(data));
      s.on('error', () => resolve(data));
      s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    });
    assert.equal(got, '', 'not a single byte');
  });

  it('"Statusseite im Heimnetz" off: the port closes, state F opens it again', async () => {
    await start({ env: true });
    controller.hooks.onHeartbeat({ ok: true, status: 200 });
    assert.equal((await request(port, { path: '/api/state' })).json.mode, 'connected');
    controller.hooks.onConfig({ features: { setup_page: { status: false } } });
    await server.start();
    assert.equal(server.address(0), null);
    await assert.rejects(request(port, { path: '/api/state' }), /ECONNREFUSED/);
    controller.hooks.onConfig({ features: { setup_page: { status: true } } });
    await server.start();
    assert.equal((await request(server.address(0).port, { path: '/api/state' })).json.mode, 'connected');
  });
});

describe('setup page: the gateway process without gateway.env', () => {
  const index = path.join(__dirname, '..', 'src', 'index.js');
  const healthcheck = path.join(__dirname, '..', 'src', 'healthcheck.js');

  function freePort() {
    return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  }

  it('stays up in setup mode, is healthy, and ends cleanly on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    const p = await freePort();
    const env = { ...process.env, GATEWAY_ENV_PATH: path.join(dir, 'gateway.env'), GATEWAY_STATE_DIR: dir, GC_SETUP_PORT: String(p), LOG_LEVEL: 'silent', NODE_ENV: 'test' };
    const child = spawn(process.execPath, [index], { env, stdio: 'ignore' });
    try {
      let state = null;
      for (let i = 0; i < 60 && !state; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { state = (await request(p, { path: '/healthz' })).status; } catch { state = null; }
      }
      assert.equal(state, 200, 'setup page answers');
      assert.equal(child.exitCode, null, 'the process does not exit without gateway.env');
      assert.equal(spawnSync(process.execPath, [healthcheck], { env }).status, 0, 'container healthcheck is green in setup mode');
      const exit = new Promise((r) => child.on('exit', (code) => r(code)));
      child.kill('SIGTERM');
      assert.equal(await exit, 0);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GC_SETUP_PAGE=off keeps the old behaviour: exit without gateway.env', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    const env = { ...process.env, GATEWAY_ENV_PATH: path.join(dir, 'gateway.env'), GATEWAY_STATE_DIR: dir, GC_SETUP_PAGE: 'off', LOG_LEVEL: 'silent', NODE_ENV: 'test' };
    const r = spawnSync(process.execPath, [index], { env, timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.equal(spawnSync(process.execPath, [healthcheck], { env }).status, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
