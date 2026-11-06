'use strict';

// Gateway-Socket (src/edge/bridge.js): die Prüfung der Netz-Aufrufe des
// Edge-Containers passiert im Gateway – Nicht-LAN-Ziele, Server, Tunnel,
// Hostnamen, nicht genehmigte Fähigkeiten und abgeschaltete Plugins werden
// abgelehnt, egal was der Edge-Container behauptet. Dazu Relay-Statuscodes,
// Paket-Download und Rechte der Socket-Datei.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { parseState } = require('../src/edge/protocol');
const { RPC_PATH, RPC_PROTOCOL, SOCKET_NAME } = require('../src/edge/constants');
const { unixWsUrl, WS_PATH } = require('../src/edge/channel');
const { FakeServer, makeBridge, TOKEN } = require('./helpers/edgeHarness');

let tmp;
let server;
let bridge;
let rpc;
let sock;
const pushes = [];

// Antwort einem offenen Aufruf zuordnen: nur ganzzahlige ids, die dieser Client selbst vergeben hat
function settle(pending, m) {
  if (!Number.isInteger(m.id)) return;
  const done = pending.get(m.id);
  if (typeof done !== 'function') return;
  pending.delete(m.id);
  done(m);
}

function rpcClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(unixWsUrl(sock, RPC_PATH), RPC_PROTOCOL);
    const pending = new Map();
    let n = 0;
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'result') settle(pending, m);
      if (m.t === 'push') pushes.push(m);
    });
    ws.call = (plugin, api, args, caps) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ t: 'call', id, plugin, api, args, caps })); });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const SERVER_CAPS = { udp: { ports: [45678], multicast: [] }, http: { lan: true } };
function setState(over = {}) {
  bridge.setDesired(parseState({ t: 'state', edgeEnabled: true, allowUnsigned: false, mqtt: { enabled: false },
    plugins: [{ id: 'shelly', version: '1.0.0', sha256: 'a'.repeat(64), enabled: true, caps: SERVER_CAPS },
      { id: 'off-plugin', version: '1.0.0', sha256: 'b'.repeat(64), enabled: false, caps: SERVER_CAPS }], ...over }));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-bridge-'));
  server = new FakeServer();
  await server.listen();
  bridge = makeBridge({ runDir: tmp, server, extraServerAddrs: ['127.0.0.5'] });
  await bridge.start();
  sock = path.join(tmp, SOCKET_NAME);
  rpc = await rpcClient();
});

after(async () => {
  rpc.terminate();
  await bridge.stop();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Paket-Pfad: das Muster der Bridge passt zu PACKAGES_PATH', () => {
  const { PACKAGE_RE } = require('../src/edge/bridge');
  const { PACKAGES_PATH } = require('../src/edge/constants');
  assert.deepStrictEqual(PACKAGE_RE.exec(`${PACKAGES_PATH}/shelly/1.2.3`).slice(1), ['shelly', '1.2.3']);
  assert.strictEqual(PACKAGE_RE.exec(`${PACKAGES_PATH}/shelly/1.2.3/x`), null);
  assert.strictEqual(PACKAGE_RE.exec(`${PACKAGES_PATH}/shelly`), null);
});

test('Socket-Datei: nur Besitzer und Gruppe (0660)', () => {
  const st = fs.statSync(sock);
  assert.ok(st.isSocket());
  assert.strictEqual(st.mode & 0o777, 0o660);
});

test('RPC ohne Sollzustand oder für abgeschaltete Plugins → not_enabled', async () => {
  const r0 = await rpc.call('shelly', 'http.request', { url: `http://127.0.0.1:${server.port}/lan-device` }, SERVER_CAPS);
  assert.strictEqual(r0.error.code, 'not_enabled');
  setState();
  assert.strictEqual((await rpc.call('off-plugin', 'udp.send', { host: '127.0.0.1', port: 9, b64: '' }, SERVER_CAPS)).error.code, 'not_enabled');
  assert.strictEqual((await rpc.call('unknown', 'udp.send', { host: '127.0.0.1', port: 9, b64: '' }, SERVER_CAPS)).error.code, 'not_enabled');
  assert.strictEqual((await rpc.call('../x', 'udp.send', {}, SERVER_CAPS)).error.code, 'bad_request');
});

test('RPC lehnt Nicht-LAN-Ziele ab: Internet, Hostname, Server, Tunnel; LAN geht', async () => {
  setState();
  const req = (url) => rpc.call('shelly', 'http.request', { url }, SERVER_CAPS);
  for (const url of ['http://8.8.8.8/', 'http://93.184.216.34/', 'http://example.com/', `http://localhost:${server.port}/`,
    'http://127.0.0.5/', 'http://127.9.9.9/', 'http://[::1]/']) {
    const r = await req(url);
    assert.strictEqual(r.ok, false, url);
    assert.strictEqual(r.error.code, 'denied', `${url}: ${JSON.stringify(r.error)}`);
  }
  const udp = await rpc.call('shelly', 'udp.send', { host: '1.1.1.1', port: 53, b64: '' }, SERVER_CAPS);
  assert.strictEqual(udp.error.code, 'denied');
  const ok = await req(`http://127.0.0.1:${server.port}/lan-device`);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(Buffer.from(ok.result.b64, 'base64').toString(), 'hello from the lan');
});

test('Fähigkeiten: der Edge-Container kann nur einengen, nie erweitern', async () => {
  setState();
  const wider = { udp: { ports: [45678, 45679], multicast: [] }, http: { lan: true }, tcp: { lan: true } };
  assert.strictEqual((await rpc.call('shelly', 'udp.bind', { port: 45679 }, wider)).error.code, 'denied');
  assert.strictEqual((await rpc.call('shelly', 'tcp.connect', { host: '127.0.0.1', port: server.port }, wider)).error.code, 'denied');
  // Edge sagt „kein HTTP“ → auch das Gateway nicht
  assert.strictEqual((await rpc.call('shelly', 'http.request', { url: `http://127.0.0.1:${server.port}/lan-device` }, { udp: SERVER_CAPS.udp })).error.code, 'denied');
  assert.strictEqual((await rpc.call('shelly', 'udp.bind', { port: 45678 }, { bogus: 1 })).error.code, 'bad_request');
  assert.strictEqual((await rpc.call('shelly', 'exec', {}, SERVER_CAPS)).error.code, 'unknown_api');
  assert.strictEqual((await rpc.call('shelly', 'mqtt.publish', { topic: 'a', b64: '' }, SERVER_CAPS)).error.code, 'not_available');
  // erlaubter Port geht; Datagramme kommen als push zurück
  const b = await rpc.call('shelly', 'udp.bind', { port: 45678 }, wider);
  assert.strictEqual(b.ok, true);
  const dgram = require('node:dgram');
  const s = dgram.createSocket('udp4');
  for (let i = 0; i < 20 && !pushes.length; i++) { s.send('ping', 45678, '127.0.0.1'); await new Promise((r) => setTimeout(r, 50)); }
  s.close();
  assert.ok(pushes.some((p) => p.plugin === 'shelly' && p.msg.t === 'udp' && Buffer.from(p.msg.b64, 'base64').toString() === 'ping'));
});

test('edgeEnabled:false oder Plugin aus dem Sollzustand → Sockets zu, Aufrufe abgelehnt', async () => {
  setState({ edgeEnabled: false });
  assert.strictEqual(bridge.plugins.size, 0);
  assert.strictEqual((await rpc.call('shelly', 'udp.bind', { port: 45678 }, SERVER_CAPS)).error.code, 'not_enabled');
});

test('Pakete: nur aus dem Sollzustand, Download mit dem Token des Gateways', async () => {
  setState();
  server.packages.set('1.0.0', Buffer.from('paket'));
  const get = (p) => new Promise((resolve) => http.get({ socketPath: sock, path: p }, (res) => {
    const c = [];
    res.on('data', (d) => c.push(d));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
  }));
  // der Fake-Server kennt nur "echo" – shelly 1.0.0 steht im Sollzustand, liegt dort aber nicht → 404
  assert.strictEqual((await get('/api/v1/gateway/edge/packages/shelly/1.0.0')).status, 404);
  assert.strictEqual((await get('/api/v1/gateway/edge/packages/other/1.0.0')).status, 404);
  assert.strictEqual((await get('/api/v1/gateway/edge/packages/shelly/9.9.9')).status, 404);
  assert.strictEqual((await get('/etc/passwd')).status, 404);
  setState({ plugins: [{ id: 'echo', version: '1.0.0', sha256: 'a'.repeat(64), enabled: true, caps: {} }] });
  const ok = await get('/api/v1/gateway/edge/packages/echo/1.0.0');
  assert.deepStrictEqual(ok, { status: 200, body: 'paket' });
  assert.ok(server.auth.includes(`Bearer ${TOKEN}`));
});

function relayStatus(b) {
  return new Promise((resolve) => {
    const ws = new WebSocket(unixWsUrl(path.join(b.runDir, SOCKET_NAME), WS_PATH), 'gc-edge.v1');
    ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve('open'); ws.terminate(); });
    ws.on('error', () => {});
  });
}

test('Relay: Ablehnung des Servers kommt mit derselben Statuszeile an, Server weg → 502, sonst offen', async () => {
  assert.strictEqual(await relayStatus(bridge), 'open');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-bridge2-'));
  const bad = makeBridge({ runDir: dir, server });
  bad.upstream = () => ({ serverUrl: server.url, apiToken: 'wrong', serverAddrs: [] });
  await bad.start();
  try {
    assert.strictEqual(await relayStatus(bad), 401);
    bad.upstream = () => ({ serverUrl: 'http://127.0.0.1:1', apiToken: TOKEN, serverAddrs: [] });
    assert.strictEqual(await relayStatus(bad), 502);
    bad.upstream = () => null;
    assert.strictEqual(await relayStatus(bad), 503);
  } finally {
    await bad.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Relay liest den Sollzustand mit; Frames gehen 1:1 in beide Richtungen', async () => {
  const ws = new WebSocket(unixWsUrl(sock, WS_PATH), 'gc-edge.v1');
  await new Promise((r) => ws.once('open', r));
  const got = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));
  ws.send(JSON.stringify({ t: 'hello', v: 1, gw: { version: 'x' } }));
  await server.wait((m) => m.t === 'hello' && m.gw.version === 'x');
  server.send({ t: 'state', edgeEnabled: true, plugins: [{ id: 'relay-seen', version: '2.0.0', sha256: 'c'.repeat(64), caps: {} }] });
  const m = await got;
  assert.strictEqual(m.t, 'state');
  assert.ok(bridge.desired.plugins.some((p) => p.id === 'relay-seen'));
  // kaputter Sollzustand ändert nichts
  server.send({ t: 'state', plugins: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(bridge.desired.plugins.some((p) => p.id === 'relay-seen'));
  ws.terminate();
});

test('MQTT im Gateway: Broker-Dateien aus dem mitgelesenen Sollzustand (0640, Pfade des Brokers), gc.mqtt.* geprüft', async () => {
  const EventEmitter = require('node:events');
  const { MqttManager } = require('../src/edge/mqtt/manager');
  const { hashPassword } = require('../src/edge/mqtt/broker');
  class FakeClient extends EventEmitter {
    constructor() { super(); this.connected = false; this.subs = []; this.pubs = []; }
    async connect() { this.connected = true; }
    async subscribe(f) { this.subs.push(f); return 1; }
    async unsubscribe() {}
    async publish(t, p) { this.pubs.push([t, p.toString()]); }
    end() { this.connected = false; }
  }
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mqtt-conf-'));
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-bridge3-'));
  const fake = new FakeClient();
  const mqtt = new MqttManager({ dir: conf, brokerDir: '/gc-mqtt', getLanAddrs: () => ['192.168.1.10'], clientFactory: () => fake });
  const b = makeBridge({ runDir: run, server, mqtt });
  await b.start();
  const ws = await new Promise((resolve) => {
    const w = new WebSocket(unixWsUrl(path.join(run, SOCKET_NAME), RPC_PATH), RPC_PROTOCOL);
    const pending = new Map();
    let n = 0;
    const infos = [];
    w.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'info') infos.push(m); if (m.t === 'result') settle(pending, m); });
    w.call = (plugin, api, args, caps) => new Promise((r) => { const id = ++n; pending.set(id, r); w.send(JSON.stringify({ t: 'call', id, plugin, api, args, caps })); });
    w.infos = infos;
    w.once('open', () => resolve(w));
  });
  try {
    const caps = { mqtt: { topics: ['shellies/#'] } };
    b.setDesired(parseState({ t: 'state', edgeEnabled: true,
      mqtt: { enabled: true, accounts: [{ user: 'dev', hash: hashPassword('x'), acl: [{ access: 'readwrite', topic: 'shellies/#' }] }], pluginTopics: { shelly: ['shellies/#'] } },
      plugins: [{ id: 'shelly', version: '1.0.0', sha256: 'a'.repeat(64), caps }] }));
    await new Promise((r) => setTimeout(r, 50));
    const confText = fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8');
    assert.match(confText, /^password_file \/gc-mqtt\/passwd$/m);
    assert.match(confText, /^persistence_location \/gc-mqtt\/data\/$/m);
    assert.match(confText, /^listener 1883 192\.168\.1\.10$/m);
    assert.strictEqual(fs.statSync(path.join(conf, 'passwd')).mode & 0o777, 0o640);
    assert.ok(!fs.existsSync(path.join(conf, 'data')), 'data/ legt der Wächter im eigenen Volume an');
    assert.ok(fs.existsSync(path.join(conf, 'enabled')));
    assert.ok(fake.connected, 'internes Konto im Gateway');
    assert.ok(ws.infos.some((i) => i.mqtt.available === true));
    const ok = await ws.call('shelly', 'mqtt.publish', { topic: 'shellies/a/relay/0', b64: Buffer.from('on').toString('base64') }, caps);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(fake.pubs, [['shellies/a/relay/0', 'on']]);
    // breiter als genehmigt → abgelehnt, auch wenn der Edge mehr behauptet
    const no = await ws.call('shelly', 'mqtt.publish', { topic: 'other/x', b64: '' }, { mqtt: { topics: ['shellies/#', 'other/#'] } });
    assert.strictEqual(no.error.code, 'denied');
    // MQTT aus → enabled weg
    b.setDesired(parseState({ t: 'state', edgeEnabled: false, plugins: [] }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!fs.existsSync(path.join(conf, 'enabled')));
  } finally {
    ws.terminate();
    await b.stop();
    fs.rmSync(conf, { recursive: true, force: true });
    fs.rmSync(run, { recursive: true, force: true });
  }
});
