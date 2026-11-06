'use strict';

// Beweis für den isolierten Betrieb (network_mode: none): der Edge-Host läuft
// als eigener Prozess mit Haken auf allen Netzfunktionen und öffnet KEINEN
// IP-Socket – Kanal zum Server, Paket-Download, UDP-Echo und eine HTTP-Anfrage
// an ein „LAN-Gerät“ laufen trotzdem, alles über den Unix-Socket des Gateways
// (EdgeBridge in diesem Testprozess). Das "LAN" ist 127.0.0.0/8.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { keyPair } = require('./helpers/edgeFixtures');
const { buildPackage, FakeServer, makeBridge } = require('./helpers/edgeHarness');

const trusted = keyPair();
const PORT = 41000 + crypto.randomInt(0, 8000);
const CAPS = { udp: { ports: [PORT], multicast: [] }, http: { lan: true } };

let tmp;
let server;
let bridge;
let child;
let pkg;

function ask(msg, key) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer to ${msg}`)), 5000);
    const on = (m) => { if (m && m[key] !== undefined) { clearTimeout(t); child.off('message', on); resolve(m[key]); } };
    child.on('message', on);
    child.send(msg);
  });
}

let seq = 0;
async function call(method, params) {
  const id = `s${++seq}`;
  server.send({ t: 'call', id, plugin: 'echo', method, params });
  return server.wait((m) => m.t === 'result' && m.id === id, 8000, `result ${method}`);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-iso-'));
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(tmp, 'status'));
  server = new FakeServer();
  await server.listen();
  pkg = buildPackage({ key: trusted, port: PORT, caps: CAPS });
  server.packages.set(pkg.version, pkg.buf);
  bridge = makeBridge({ runDir, server });
  await bridge.start();
  child = fork(path.join(__dirname, 'helpers', 'edgeHostChild.js'), [], {
    env: { ...process.env, GC_TEST_RUN_DIR: runDir, GC_TEST_STATE_DIR: tmp, GC_TEST_KEY: trusted.publicKeyB64, LOG_LEVEL: 'silent' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    child.once('message', (m) => (m && m.started ? resolve() : reject(new Error(m && m.error))));
    child.once('exit', (c) => reject(new Error(`edge host exited ${c}`)));
  });
});

after(async () => {
  if (child && child.connected) {
    child.send('stop');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
  }
  await bridge.stop();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Edge-Host ohne Netz: Kanal, Paket, UDP und HTTP über den Gateway-Socket – kein einziger IP-Socket', async () => {
  const hello = await server.wait((m) => m.t === 'hello', 8000, 'hello');
  assert.deepStrictEqual(hello.gw.isolation, { mode: 'isolated', active: true });
  server.send({ t: 'state', edgeEnabled: true, allowUnsigned: false, mqtt: { enabled: false },
    plugins: [{ id: 'echo', version: pkg.version, sha256: pkg.sha256, memoryMb: 32, enabled: true, caps: CAPS }] });
  await server.wait((m) => m.t === 'status' && m.plugins.some((p) => p.id === 'echo' && p.state === 'running'), 15000, 'running');

  // UDP-Echo: das Gateway hält den Socket, der Edge-Teil antwortet über RPC
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  let got = null;
  sock.on('message', (m) => { got = m.toString(); });
  for (let i = 0; i < 40 && !got; i++) { sock.send('iso', PORT, '127.0.0.1'); await new Promise((r) => setTimeout(r, 100)); }
  sock.close();
  assert.strictEqual(got, 'echo:iso');

  // HTTP an ein LAN-Gerät (hier der Fake-Server auf 127.0.0.1)
  const r = await call('httpTo', { url: `http://127.0.0.1:${server.port}/lan-device` });
  assert.deepStrictEqual(r.result, { status: 200, text: 'hello from the lan' });
  assert.ok(server.httpHits >= 1);
  // … aber nichts außerhalb des LAN
  assert.deepStrictEqual((await call('httpTo', { url: 'http://93.184.216.34/' })).result, { code: 'denied' });

  const attempts = await ask('attempts', 'attempts');
  assert.deepStrictEqual(attempts, [], `der Edge-Host hat IP-Sockets geöffnet: ${JSON.stringify(attempts)}`);
});

test('Gegenprobe: die Haken im Edge-Prozess bemerken TCP und UDP', async () => {
  const seen = await ask('selftest', 'selftest');
  assert.deepStrictEqual(seen.map((a) => a.kind).sort(), ['tcp', 'udp.bind', 'udp.send']); // send bindet implizit
});
