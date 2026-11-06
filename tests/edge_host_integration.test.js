'use strict';

// Integrationstest: echter Edge-Host gegen einen Fake-Server, dazwischen die
// Gateway-Seite (EdgeBridge auf einem Unix-Socket) wie im Betrieb mit
// network_mode: none – Kanal, Pakete und gc.lan.* laufen über den Socket,
// geprüft im „Gateway“. Echter Plugin-Prozess (Permission-Model + Sperren)
// mit einem Beispiel-Edge-Teil (UDP-Echo). Das "LAN" ist hier 127.0.0.0/8.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EdgeHost } = require('../src/edge/host');
const { keyPair } = require('./helpers/edgeFixtures');
const { TOKEN, buildPackage: build, FakeServer, makeBridge } = require('./helpers/edgeHarness');

const trusted = keyPair();
const PORT = 40000 + crypto.randomInt(0, 9000);
const buildPackage = (o = {}) => build({ key: trusted, port: PORT, ...o });

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

let bridge;
let runDir;

function publish(p) { server.packages.set(p.version, p.buf); }

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-int-'));
  const p = { runDir: path.join(tmp, 'run'), statusDir: path.join(tmp, 'status'), stateDir: tmp, packagesDir: path.join(tmp, 'packages'), dataDir: path.join(tmp, 'data') };
  runDir = p.runDir;
  for (const d of [p.runDir, p.statusDir]) fs.mkdirSync(d);
  pkgs = { current: buildPackage() };
  server = new FakeServer();
  await server.listen();
  publish(pkgs.current);
  bridge = makeBridge({ runDir: p.runDir, server });
  await bridge.start();
  host = new EdgeHost({
    paths: p,
    keys: [trusted.publicKeyB64],
    fenceCheck: async () => (fenceActive ? { mode: 'isolated', active: true, backend: 'isolated', reason: null } : { mode: 'isolated', active: false, backend: null, reason: 'probe_sent' }),
    hardware: () => ({ arch: process.arch }),
    backoff: [100, 200],
    timing: { statusDebounceMs: 20, statusEveryMs: 60000, fenceCheckMs: 60000 },
    rpcTiming: { rpcReconnectMinMs: 50, rpcReconnectMaxMs: 200 },
    channelTiming: { reconnectMinMs: 50, reconnectMaxMs: 300 },
  });
  await host.start();
});

after(async () => {
  await host.stop();
  await bridge.stop();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hello → state → Edge-Teil läuft', async () => {
  const hello = await server.wait((m) => m.t === 'hello', 8000, 'hello');
  assert.strictEqual(hello.v, 1);
  assert.strictEqual(hello.gw.edgeHost, '1.1.0');
  assert.strictEqual(typeof hello.gw.version, 'string');
  assert.deepStrictEqual(hello.gw.fence, { active: true, backend: 'isolated' });
  assert.deepStrictEqual(hello.gw.isolation, { mode: 'isolated', active: true });
  // das Token setzt das Gateway; der Edge-Host kennt es nicht
  assert.ok(server.auth.includes(`Bearer ${TOKEN}`));
  for (const f of fs.readdirSync(runDir)) {
    if (fs.statSync(path.join(runDir, f)).isFile()) assert.ok(!fs.readFileSync(path.join(runDir, f), 'utf8').includes(TOKEN), f);
  }
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
  // die Tunnel-Adresse des Gateways ist kein LAN-Ziel (geprüft im Gateway)
  assert.deepStrictEqual((await call('udpTo', { host: '127.9.9.9', port: PORT })).result, { code: 'denied' });
});

test('Paket kam über den Gateway-Socket (Download mit dem Token des Gateways)', () => {
  const downloads = server.auth.filter((a) => a === `Bearer ${TOKEN}`).length;
  assert.ok(downloads >= 2, 'Kanal + Paket über das Gateway');
  assert.ok(fs.existsSync(path.join(tmp, 'packages', 'echo', '1.0.0')));
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

test('Gateway-Socket kurz weg (Gateway neu gestartet) → Edge-Teil startet neu, UDP geht wieder', async () => {
  await bridge.stop();
  bridge = makeBridge({ runDir, server });
  await bridge.start();
  server.clear();
  await server.wait((m) => m.t === 'hello', 8000, 'hello after relay restart');
  server.send(state());
  await server.wait(pluginStatus((p) => p.state === 'running'), 15000, 'running after gateway restart');
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  let got = null;
  sock.on('message', (m) => { got = m.toString(); });
  for (let i = 0; i < 40 && !got; i++) { sock.send('wieder', PORT, '127.0.0.1'); await new Promise((r) => setTimeout(r, 100)); }
  sock.close();
  assert.strictEqual(got, 'echo:wieder');
});

test('ohne bestätigte Isolation kein Plugin-Prozess (fail closed)', async () => {
  fenceActive = false;
  server.clear();
  await host.tick();
  const st = await server.wait(pluginStatus((p) => p.state === 'denied'), 8000, 'denied');
  assert.match(st.plugins[0].lastError, /network_isolation_inactive/);
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
  publish(pkgs.current);
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
