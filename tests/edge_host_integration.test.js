'use strict';

// Integrationstest: echter Edge-Host gegen einen Fake-Server (WebSocket),
// echter Plugin-Prozess (Permission-Model + Sperren) mit einem Beispiel-
// Edge-Teil (UDP-Echo). Das "LAN" ist hier 127.0.0.0/8.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const gcplugin = require('../src/edge/gcplugin');
const signature = require('../src/edge/signature');
const { EdgeHost } = require('../src/edge/host');
const { makeLanGuard } = require('../src/edge/lanGuard');
const { keyPair } = require('./helpers/edgeFixtures');

const trusted = keyPair();
const PORT = 40000 + crypto.randomInt(0, 9000);

function buildPackage({ sign = true, version = '1.0.0', caps } = {}) {
  const src = fs.readFileSync(path.join(__dirname, 'fixtures/edge/echo-plugin.js'), 'utf8')
    .replace('|| 40000', `|| ${PORT}`).replace('bind(40001', `bind(${PORT + 1}`);
  const manifest = { id: 'echo', version, name: 'Echo', edge: { entry: 'edge/index.js', memoryMb: 32, capabilities: caps || { udp: { ports: [PORT], multicast: [] } } } };
  let files = new Map([['plugin.json', Buffer.from(JSON.stringify(manifest))], ['edge/index.js', Buffer.from(src)], ['server/index.js', Buffer.from('x')]]);
  if (sign) files = signature.sign(files, trusted.privateKey).files;
  const buf = gcplugin.encode(files);
  return { buf, sha256: crypto.createHash('sha256').update(buf).digest('hex'), version };
}

class FakeServer {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.ws = null;
  }
  async listen() {
    this.http = http.createServer();
    this.wss = new WebSocket.Server({ noServer: true, handleProtocols: () => 'gc-edge.v1' });
    this.http.on('upgrade', (req, sock, head) => this.wss.handleUpgrade(req, sock, head, (ws) => {
      this.ws = ws;
      ws.on('message', (d) => { const m = JSON.parse(d); this.msgs.push(m); this.check(); });
    }));
    await new Promise((r) => this.http.listen(0, '127.0.0.1', r));
    return this.http.address().port;
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  check() {
    for (const w of [...this.waiters]) {
      const hit = this.msgs.find(w.pred);
      if (hit) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(hit); }
    }
  }
  wait(pred, ms = 8000, what = 'message') {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, t: setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms) };
      this.waiters.push(w);
      this.check();
    });
  }
  clear() { this.msgs = []; }
  close() { try { this.ws && this.ws.terminate(); } catch { /* zu */ } this.http.close(); }
}

let tmp;
let server;
let host;
let pkgs;
let fenceActive = true;

function state(over = {}) {
  const p = pkgs.current;
  return { t: 'state', edgeEnabled: true, allowUnsigned: false,
    plugins: [{ id: 'echo', version: p.version, sha256: p.sha256, memoryMb: 32, enabled: true, caps: { udp: { ports: [PORT], multicast: [] } } }],
    mqtt: { enabled: false }, ...over };
}

const pluginStatus = (pred) => (m) => m.t === 'status' && m.plugins.some((p) => p.id === 'echo' && pred(p));
let callSeq = 0;
async function call(method, params, timeoutMs) {
  const id = `c${++callSeq}`;
  server.send({ t: 'call', id, plugin: 'echo', method, params, timeoutMs });
  return server.wait((m) => m.t === 'result' && m.id === id, 8000, `result ${method}`);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-int-'));
  const p = { runDir: path.join(tmp, 'run'), statusDir: path.join(tmp, 'status'), stateDir: tmp, packagesDir: path.join(tmp, 'packages'), dataDir: path.join(tmp, 'data') };
  for (const d of [p.runDir, p.statusDir]) fs.mkdirSync(d);
  pkgs = { current: buildPackage() };
  server = new FakeServer();
  const port = await server.listen();
  host = new EdgeHost({
    paths: p,
    keys: [trusted.publicKeyB64],
    loadCredentials: () => ({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_test', serverAddrs: [], tunnelIp: null }),
    download: async (_c, id, version) => (version === pkgs.current.version ? pkgs.current.buf : pkgs.other.buf),
    fenceCheck: async () => (fenceActive ? { active: true, backend: 'test', reason: null } : { active: false, backend: null, reason: 'no_marker' }),
    guard: makeLanGuard({ getSubnets: () => ['127.0.0.0/8'] }),
    hardware: () => ({ arch: process.arch }),
    backoff: [100, 200],
    timing: { statusDebounceMs: 20, statusEveryMs: 60000, fenceCheckMs: 60000 },
  });
  await host.start();
});

after(async () => {
  await host.stop();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hello → state → Edge-Teil läuft', async () => {
  const hello = await server.wait((m) => m.t === 'hello', 8000, 'hello');
  assert.strictEqual(hello.v, 1);
  assert.strictEqual(hello.gw.edgeHost, '1.0.0');
  assert.strictEqual(typeof hello.gw.version, 'string');
  assert.deepStrictEqual(hello.gw.fence, { active: true, backend: 'test' });
  server.send(state());
  const st = await server.wait(pluginStatus((p) => p.state === 'running'), 15000, 'running');
  const p = st.plugins.find((x) => x.id === 'echo');
  assert.strictEqual(p.version, '1.0.0');
  assert.ok(p.rssMb === null || p.rssMb > 0);
  assert.ok(fs.existsSync(path.join(tmp, 'status', 'status.json')), 'Zusammenfassung für die Telemetrie');
});

test('Aufrufe: Ergebnis, Fehlercode, Timeout', async () => {
  const r = await call('ping', { a: 1 });
  assert.deepStrictEqual(r, { t: 'result', id: r.id, ok: true, result: { pong: { a: 1 } } });
  const f = await call('fail');
  assert.deepStrictEqual(f.error, { code: 'my_code', message: 'kaputt' });
  const t = await call('slow', null, 200);
  assert.strictEqual(t.error.code, 'timeout');
  const u = await call('nope');
  assert.strictEqual(u.error.code, 'unknown_method');
  server.send({ t: 'call', id: 'x1', plugin: 'unknown-plugin', method: 'ping' });
  const n = await server.wait((m) => m.t === 'result' && m.id === 'x1');
  assert.strictEqual(n.error.code, 'not_enabled');
});

test('UDP-Echo über den Edge-Host; Ereignis mit seq, ack', async () => {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const reply = new Promise((r) => sock.once('message', (m) => r(m.toString())));
  sock.send('hallo', PORT, '127.0.0.1');
  assert.strictEqual(await reply, 'echo:hallo');
  sock.close();
  const ev = await server.wait((m) => m.t === 'event' && m.name === 'udp');
  assert.deepStrictEqual(ev.data, { text: 'hallo', from: '127.0.0.1' });
  assert.ok(Number.isInteger(ev.seq) && ev.seq > 0);
  assert.strictEqual(host.plugins.get('echo').buffer.size, 1);
  server.send({ t: 'ack', plugin: 'echo', seq: ev.seq });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(host.plugins.get('echo').buffer.size, 0);
});

test('Fähigkeiten: kein Ziel außerhalb des LAN, kein fremder Port, kein TCP ohne Fähigkeit', async () => {
  assert.deepStrictEqual((await call('udpTo', { host: '8.8.8.8', port: 53 })).result, { code: 'denied' });
  assert.deepStrictEqual((await call('udpTo', { host: 'example.com', port: 53 })).result, { code: 'denied' });
  assert.deepStrictEqual((await call('udpTo', { host: '127.0.0.1', port: 9 })).result, { ok: true });
  assert.deepStrictEqual((await call('bindOther')).result, { code: 'denied' });
  assert.deepStrictEqual((await call('tcpTo', { host: '127.0.0.1', port: 80 })).result, { code: 'denied' });
});

test('Isolation: keine eigenen Netz-, Prozess- oder Dateizugriffe, keine Geheimnisse in der Umgebung', async () => {
  const r = (await call('probe')).result;
  assert.strictEqual(r.dgram, 'denied');
  assert.strictEqual(r.net, 'denied');
  assert.strictEqual(r.child_process, 'denied');
  assert.strictEqual(r.fsRead, 'ERR_ACCESS_DENIED');
  assert.strictEqual(r.fsWrite, 'ERR_ACCESS_DENIED');
  assert.strictEqual(r.kill, 'denied');
  assert.strictEqual(r.fetch, 'denied');
  assert.strictEqual(r.env, 'allowed');
});

test('configure (nur im Speicher) und gc.store', async () => {
  server.send({ t: 'configure', plugin: 'echo', data: { mode: 'x' } });
  const ev = await server.wait((m) => m.t === 'event' && m.name === 'configured');
  assert.deepStrictEqual(ev.data, { mode: 'x' });
  assert.deepStrictEqual((await call('config')).result, { mode: 'x' });
  assert.deepStrictEqual((await call('store', { v: 1 })).result, { v: 1 });
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'echo', 'store.json')));
});

test('Ereignisse > 50/s werden verworfen und im Status gemeldet', async () => {
  server.clear();
  await call('emit', { n: 80 });
  await new Promise((r) => setTimeout(r, 100));
  const n = server.msgs.filter((m) => m.t === 'event' && m.name === 'burst').length;
  assert.ok(n <= 50, `zu viele Ereignisse: ${n}`);
  host.sendStatus();
  const st = await server.wait(pluginStatus((p) => p.throttled > 0));
  assert.ok(st.plugins[0].throttled >= 30);
});

test('Absturz → Neustart mit Backoff', async () => {
  server.clear();
  await call('crash');
  await server.wait(pluginStatus((p) => p.state === 'crashed'), 8000, 'crashed');
  const st = await server.wait(pluginStatus((p) => p.state === 'running' && p.restarts >= 1), 15000, 'restarted');
  assert.ok(st);
  assert.deepStrictEqual((await call('ping', 2)).result, { pong: 2 });
});

test('ohne aktive Netzgrenze kein Plugin-Prozess (fail closed)', async () => {
  fenceActive = false;
  server.clear();
  await host.tick();
  const st = await server.wait(pluginStatus((p) => p.state === 'denied'), 8000, 'denied');
  assert.match(st.plugins[0].lastError, /network_fence_inactive/);
  const r = await call('ping', 1);
  assert.strictEqual(r.error.code, 'denied');
  fenceActive = true;
  server.clear();
  await host.tick();
  await server.wait(pluginStatus((p) => p.state === 'running'), 15000, 'running again');
});

test('unsigniert ohne allowUnsigned → denied; mit allowUnsigned → läuft (Update auf 1.1.0)', async () => {
  pkgs.other = pkgs.current;
  pkgs.current = buildPackage({ sign: false, version: '1.1.0' });
  server.clear();
  server.send(state());
  const st = await server.wait(pluginStatus((p) => p.state === 'denied' && p.version === '1.1.0'), 8000, 'denied unsigned');
  assert.match(st.plugins[0].lastError, /^unsigned/);
  server.clear();
  server.send(state({ allowUnsigned: true }));
  await server.wait(pluginStatus((p) => p.state === 'running' && p.version === '1.1.0'), 15000, 'running 1.1.0');
  // alte Version nach erfolgreichem Start gelöscht
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'packages', 'echo')), ['1.1.0']);
});

test('edgeEnabled:false stoppt alles', async () => {
  server.clear();
  server.send(state({ edgeEnabled: false }));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(host.plugins.get('echo') ? host.plugins.get('echo').proc : null, null);
  const r = await call('ping', 1);
  assert.strictEqual(r.error.code, 'not_enabled');
});
