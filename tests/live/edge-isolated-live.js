#!/usr/bin/env node
'use strict';

// Live-Test des isolierten Edge-Betriebs (Compose: network_mode: none) – als
// root ausführen (CI-Job edge-isolated, lokal: sudo node tests/live/edge-isolated-live.js).
//
// Der „Gateway-Container“ (Fake-Server + EdgeBridge auf einem Unix-Socket)
// läuft in diesem Prozess im normalen Netz; der Edge-Host läuft per
// `unshare -n` in einem eigenen, leeren Netz-Namespace (nur lo) – wie ein
// Container ohne Netz. Geprüft:
//   1. der Edge-Host erkennt selbst „isoliert“ (echte Prüfung, keine Netzgrenze nötig);
//   2. eine direkte Verbindung zum Server scheitert (kein Netz);
//   3. trotzdem: hello über das Relay, Paket über den Socket, Edge-Teil läuft,
//      UDP-Echo im „LAN“ (127.0.0.0/8) über das Gateway;
//   4. Ziele außerhalb des LAN lehnt das Gateway ab.

const assert = require('node:assert');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { keyPair } = require('../helpers/edgeFixtures');
const { buildPackage, FakeServer, makeBridge } = require('../helpers/edgeHarness');

const PORT = 42000 + crypto.randomInt(0, 8000);
const CAPS = { udp: { ports: [PORT], multicast: [] }, http: { lan: true } };

async function main() {
  if (process.getuid() !== 0) { console.error('needs root (unshare -n)'); process.exit(2); }
  const trusted = keyPair();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-live-'));
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(tmp, 'status'));
  const server = new FakeServer();
  await server.listen();
  const pkg = buildPackage({ key: trusted, port: PORT, caps: CAPS });
  server.packages.set(pkg.version, pkg.buf);
  const bridge = makeBridge({ runDir, server });
  await bridge.start();

  const child = spawn('unshare', ['-n', 'sh', '-c', 'ip link set lo up 2>/dev/null; exec "$0" "$1"', process.execPath, path.join(__dirname, '..', 'helpers', 'edgeHostChild.js')], {
    env: { ...process.env, GC_TEST_RUN_DIR: runDir, GC_TEST_STATE_DIR: tmp, GC_TEST_KEY: trusted.publicKeyB64, GC_TEST_REAL_BOUNDARY: '1', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ask = (msg, key) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(msg)}`)), 8000);
    const on = (m) => { if (m && m[key] !== undefined) { clearTimeout(t); child.off('message', on); resolve(m[key]); } };
    child.on('message', on);
    child.send(msg);
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('message', (m) => (m && m.started ? resolve() : reject(new Error(m && m.error))));
      child.once('exit', (c) => reject(new Error(`edge host exited ${c}`)));
    });
    const mode = await ask('mode', 'mode');
    console.log('edge host:', JSON.stringify(mode));
    assert.strictEqual(mode.mode, 'isolated', 'ohne Netz erkannt');
    assert.strictEqual(mode.fence.active, true, 'Isolation bestätigt');

    const direct = await ask({ direct: { host: '127.0.0.1', port: server.port } }, 'direct');
    console.log('direkt zum Server aus dem Edge-Namespace:', direct);
    assert.notStrictEqual(direct, 'CONNECTED');

    const hello = await server.wait((m) => m.t === 'hello', 10000, 'hello');
    assert.deepStrictEqual(hello.gw.isolation, { mode: 'isolated', active: true });
    server.send({ t: 'state', edgeEnabled: true, allowUnsigned: false, mqtt: { enabled: false },
      plugins: [{ id: 'echo', version: pkg.version, sha256: pkg.sha256, memoryMb: 32, enabled: true, caps: CAPS }] });
    await server.wait((m) => m.t === 'status' && m.plugins.some((p) => p.id === 'echo' && p.state === 'running'), 20000, 'running');

    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    let got = null;
    sock.on('message', (m) => { got = m.toString(); });
    for (let i = 0; i < 50 && !got; i++) { sock.send('live', PORT, '127.0.0.1'); await new Promise((r) => setTimeout(r, 100)); }
    sock.close();
    assert.strictEqual(got, 'echo:live', 'UDP-Echo über das Gateway');

    server.send({ t: 'call', id: 'x1', plugin: 'echo', method: 'httpTo', params: { url: 'http://1.1.1.1/' } });
    const denied = await server.wait((m) => m.t === 'result' && m.id === 'x1', 8000, 'denied');
    assert.deepStrictEqual(denied.result, { code: 'denied' });
    server.send({ t: 'call', id: 'x2', plugin: 'echo', method: 'httpTo', params: { url: `http://127.0.0.1:${server.port}/lan-device` } });
    const ok = await server.wait((m) => m.t === 'result' && m.id === 'x2', 8000, 'lan http');
    assert.deepStrictEqual(ok.result, { status: 200, text: 'hello from the lan' });
    console.log('ok: Edge-Host ohne Netz – Kanal, Paket, UDP und HTTP über den Gateway-Socket, Internet abgelehnt');
  } finally {
    if (child.connected) child.send('stop');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    await bridge.stop();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
