'use strict';

// Optionale LAN-Fähigkeiten (docs/edge.md „Optionale Fähigkeiten“): tcp.lan, udp.port:<n>, udp.broadcast –
// z. B. Tuya-WLAN-Geräte (TCP 6668, Suche über UDP 6666/6667/7000). Dazu UDP-Broadcast nur an die eigenen
// Ports und 64 TCP-Verbindungen je Edge-Teil.

const { test } = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const net = require('node:net');
const { validateCaps, validateOptionalCaps, intersectCaps, validateEdgeManifest } = require('../src/edge/manifest');
const { makeLanGuard, broadcastOf } = require('../src/edge/lanGuard');
const { PluginNet } = require('../src/edge/netProxy');
const { LIMITS } = require('../src/edge/constants');

const base = { id: 'smart-home', version: '1.0.0' };
const required = { mqtt: { topics: ['shellies/#'] }, udp: { ports: [5683], multicast: ['224.0.1.187'] } };
const tuya = { tcp: { lan: true }, udp: { ports: [6666, 6667, 7000], broadcast: true } };
const manifest = (opt, caps = required) => validateEdgeManifest({ ...base, edge: { entry: 'edge/index.js', capabilities: caps, optionalCapabilities: opt } });

test('optional tcp.lan, udp.ports und udp.broadcast werden gelesen', () => {
  const m = manifest({ mqtt: { topics: ['zigbee2mqtt/#'] }, ...tuya });
  assert.deepStrictEqual(m.optionalCapabilities, { mqtt: { topics: ['zigbee2mqtt/#'] }, tcp: { lan: true }, udp: { ports: [6666, 6667, 7000], broadcast: true } });
  // Broadcast allein, Ports aus capabilities
  assert.deepStrictEqual(manifest({ udp: { broadcast: true } }).optionalCapabilities, { udp: { ports: [], broadcast: true } });
  assert.deepStrictEqual(validateOptionalCaps({ udp: { ports: [7000] } }, {}), { udp: { ports: [7000] } });
});

test('optional tcp/udp: eng – nie doppelt, keine Multicast-Gruppen, ≤ 16 Ports, Broadcast nur mit Ports', () => {
  const reject = (opt, re, caps) => assert.throws(() => manifest(opt, caps), (e) => e.code === 'bad_caps' && re.test(e.message), JSON.stringify(opt));
  reject({ tcp: { lan: false } }, /only \{ "lan": true \} can be optional/);
  reject({ tcp: { lan: 'ja' } }, /tcp must be/);
  reject({ tcp: { lan: true } }, /tcp\.lan is already in edge\.capabilities/, { tcp: { lan: true } });
  reject({ udp: { ports: [6666], multicast: ['239.1.2.3'] } }, /only "ports" and "broadcast" can be optional/);
  reject({ udp: { ports: [5683] } }, /5683 is already in edge\.capabilities/);
  reject({ udp: { ports: [53] } }, /udp\.ports: 53/);
  reject({ udp: { ports: [5353] } }, /5353 only through "mdns"/);
  reject({ udp: { ports: [6666], broadcast: 'ja' } }, /udp\.broadcast must be true or false/);
  reject({ udp: { ports: Array.from({ length: 16 }, (_, i) => 20000 + i) } }, /at most 16 ports together/);
  reject({ udp: { broadcast: true } }, /udp\.broadcast needs udp\.ports/, {});
  reject({ udp: { broadcast: true } }, /udp\.broadcast is already in edge\.capabilities/, { udp: { ports: [7000], broadcast: true } });
  assert.strictEqual(manifest({ udp: { ports: Array.from({ length: 15 }, (_, i) => 20000 + i) } }).optionalCapabilities.udp.ports.length, 15);
});

test('wirksam: (Pflicht ∪ optional) ∩ state – nur die bestätigten Schlüssel, Broadcast nur, wenn beide ihn nennen', () => {
  const m = manifest(tuya);
  const st = (o) => validateCaps({ mqtt: { topics: ['shellies/#'] }, udp: { ports: [5683], multicast: ['224.0.1.187'] }, ...o });
  // nichts bestätigt: wie vorher
  let e = intersectCaps(m.capabilities, st({}), m.optionalCapabilities);
  assert.strictEqual(e.tcp, undefined);
  assert.deepStrictEqual(e.udp, { ports: [5683], multicast: ['224.0.1.187'] });
  // tcp.lan, udp.port:7000, udp.broadcast bestätigt (der Server schickt sie im state)
  e = intersectCaps(m.capabilities, st({ tcp: { lan: true }, udp: { ports: [5683, 7000], multicast: ['224.0.1.187'], broadcast: true } }), m.optionalCapabilities);
  assert.deepStrictEqual(e.tcp, { lan: true });
  assert.deepStrictEqual(e.udp, { ports: [5683, 7000], multicast: ['224.0.1.187'], broadcast: true });
  // was das Paket nicht verlangt, gilt nie – auch wenn der state es nennt
  e = intersectCaps(m.capabilities, st({ udp: { ports: [5683, 9999], multicast: ['224.0.1.187'], broadcast: true } }));
  assert.deepStrictEqual(e.udp, { ports: [5683], multicast: ['224.0.1.187'] }, 'ohne optionale: kein Port 9999, kein Broadcast');
  assert.strictEqual(intersectCaps({}, st({ tcp: { lan: true } })).tcp, undefined);
});

test('lanGuard: Broadcast-Ziele nur der privaten LAN-Subnetze', () => {
  assert.strictEqual(broadcastOf('192.168.1.0', 24), '192.168.1.255');
  assert.strictEqual(broadcastOf('10.20.0.0', 16), '10.20.255.255');
  assert.strictEqual(broadcastOf('172.16.0.0', 12), '172.31.255.255');
  assert.strictEqual(broadcastOf('192.168.1.4', 31), null);
  assert.strictEqual(broadcastOf('192.168.1.4', 32), null);
  const g = makeLanGuard({ getSubnets: () => ['192.168.1.0/24', '10.20.0.0/16', '192.168.9.8/31'] });
  assert.deepStrictEqual(g.broadcasts(), ['192.168.1.255', '10.20.255.255']);
  assert.deepStrictEqual(g.broadcastTargets('255.255.255.255'), ['192.168.1.255', '10.20.255.255']);
  assert.deepStrictEqual(g.broadcastTargets('192.168.1.255'), ['192.168.1.255']);
  for (const h of ['192.168.2.255', '192.168.1.42', '10.8.0.255', 'x', null]) assert.strictEqual(g.broadcastTargets(h), null, String(h));
});

function plugin(caps, subnets = ['127.0.0.0/24']) {
  const pushed = [];
  const p = new PluginNet({ pluginId: 'smart-home', caps: () => caps, guard: makeLanGuard({ getSubnets: () => subnets }), toChild: (m) => pushed.push(m) });
  return { p, pushed };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const got = [];
    s.on('message', (m, r) => got.push({ text: m.toString(), address: r.address }));
    s.once('error', reject);
    s.bind(port, '0.0.0.0', () => resolve({ s, got, port: s.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (t) => Buffer.from(t).toString('base64');

test('udp.send an Broadcast: nur mit udp.broadcast und nur an die eigenen Ports; 255.255.255.255 → Subnetz-Broadcasts', async () => {
  const l = await listen(0);
  const other = await listen(0);
  try {
    // ohne Fähigkeit: denied (auch die Subnetz-Broadcast-Adresse ist kein Unicast-Ziel)
    let { p } = plugin({ udp: { ports: [l.port], multicast: [] } });
    for (const host of ['255.255.255.255', '127.0.0.255']) {
      await assert.rejects(p.udpSend({ host, port: l.port, b64: b64('x') }), (e) => e.code === 'denied' && /udp\.broadcast/.test(e.message), host);
    }
    p.closeAll();
    // mit Fähigkeit, aber an einen fremden Port: denied
    ({ p } = plugin({ udp: { ports: [l.port], multicast: [], broadcast: true } }));
    await assert.rejects(p.udpSend({ host: '255.255.255.255', port: other.port, b64: b64('x') }), (e) => e.code === 'denied' && /broadcast only to the plugin's UDP ports/.test(e.message));
    // erlaubt: an die Broadcast-Adresse des LAN-Subnetzes (hier 127.0.0.0/24 → 127.0.0.255)
    assert.deepStrictEqual(await p.udpSend({ host: '255.255.255.255', port: l.port, b64: b64('scan') }), { sent: 1 });
    assert.deepStrictEqual(await p.udpSend({ host: '127.0.0.255', port: l.port, b64: b64('direct') }), { sent: 1 });
    // Unicast wie bisher (auch nach SO_BROADCAST auf dem flüchtigen Socket)
    assert.deepStrictEqual(await p.udpSend({ host: '127.0.0.1', port: other.port, b64: b64('unicast') }), {});
    await assert.rejects(p.udpSend({ host: '8.8.8.8', port: l.port, b64: b64('x') }), (e) => e.code === 'denied');
    await wait(100);
    assert.deepStrictEqual(l.got.map((x) => x.text).sort(), ['direct', 'scan']);
    assert.deepStrictEqual(other.got.map((x) => x.text), ['unicast']);
    // vom gebundenen Port aus (gc.lan.udp.bind → handle.send)
    const free = await listen(0);
    const port = free.port;
    free.s.close();
    const q = plugin({ udp: { ports: [l.port, port], multicast: [], broadcast: true } });
    const { id } = await q.p.udpBind({ port });
    assert.deepStrictEqual(await q.p.udpSend({ id, host: '255.255.255.255', port: l.port, b64: b64('bound') }), { sent: 1 });
    await wait(100);
    assert.ok(l.got.some((x) => x.text === 'bound'));
    q.p.closeAll();
    p.closeAll();
  } finally {
    l.s.close();
    other.s.close();
  }
});

test('udp.send an Broadcast ohne LAN-Subnetz mit Broadcast-Adresse: denied', async () => {
  const { p } = plugin({ udp: { ports: [40000], multicast: [], broadcast: true } }, ['192.168.9.8/31']);
  // 255.255.255.255 ist ein Broadcast-Ziel, aber es gibt kein Subnetz dafür
  await assert.rejects(p.udpSend({ host: '255.255.255.255', port: 40000, b64: b64('x') }), (e) => e.code === 'denied' && /no LAN subnet/.test(e.message));
  p.closeAll();
});

test('TCP: 64 Verbindungen je Edge-Teil (vorher 32), gemeinsamer Schreibpuffer 32 MB', async () => {
  assert.strictEqual(LIMITS.tcpSocketsPerPlugin, 64);
  assert.strictEqual(LIMITS.tcpWriteBufferTotalBytes, 32 * 1024 * 1024);
  const conns = new Set();
  const server = net.createServer((s) => { conns.add(s); s.on('error', () => {}); s.on('close', () => conns.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { p } = plugin({ tcp: { lan: true } });
  try {
    // 63 Plätze belegt (ohne echte Sockets – keine flüchtigen Ports, die parallele Tests brauchen)
    for (let i = 0; i < 63; i++) p.tcp.set(-1 - i, { destroy() {}, end() {}, writableLength: 0 });
    const { id } = await p.tcpConnect({ host: '127.0.0.1', port });
    assert.strictEqual(p.tcp.size, 64, 'die 64. Verbindung geht');
    await assert.rejects(async () => p.tcpConnect({ host: '127.0.0.1', port }), (e) => e.code === 'busy' && /at most 64/.test(e.message));
    p.tcp.delete(-1);
    p.tcpDestroy({ id });
    assert.ok((await p.tcpConnect({ host: '127.0.0.1', port })).id, 'nach dem Schließen wieder eine frei');
    // gemeinsamer Schreibpuffer: zusammen höchstens 32 MB
    p.tcp.get(-2).writableLength = 32 * 1024 * 1024;
    const own = [...p.tcp.keys()].find((k) => k > 0);
    await assert.rejects(p.tcpWrite({ id: own, b64: b64('x') }), (e) => e.code === 'busy' && /write buffers of this edge part full/.test(e.message));
    p.tcp.get(-2).writableLength = 0;
    assert.deepStrictEqual(await p.tcpWrite({ id: own, b64: b64('x') }), {});
    // ohne tcp.lan: denied
    const q = plugin({});
    await assert.rejects(async () => q.p.tcpConnect({ host: '127.0.0.1', port }), (e) => e.code === 'denied');
  } finally {
    p.closeAll();
    for (const c of conns) c.destroy();
    await new Promise((r) => server.close(r));
  }
});
