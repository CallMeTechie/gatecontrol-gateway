'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const EventEmitter = require('node:events');
const broker = require('../src/edge/mqtt/broker');
const { MqttClient, Parser, encodeLength, T } = require('../src/edge/mqtt/client');
const { MqttManager, lanAddresses } = require('../src/edge/mqtt/manager');
const { parseState } = require('../src/edge/protocol');

// Ausgabe von `mosquitto_passwd -H sha512-pbkdf2` (Mosquitto 2.1.2) für das Passwort "beispiel"
const ITER = '1000';
const SALT_B64 = '5o7XcQTaAEHaTWgV6JFg4eFGRDOlGO6U9qifkb/a3GdjW0xQmMMQgag5NIFrxcfEcIT0WknrC78kPvkoqzmB3g==';
const DIGEST_B64 = 'ev1j+wCcSrqNsDxC2r/CJMJGBz3trZ44IilaKwXZtMU2wm4XxLQe7vX2kWFygfPRHazH7pHsbfThfZn1maNouA==';

test('Hash-Format wie mosquitto_passwd ($7$, PBKDF2-SHA512)', () => {
  const fromTool = ['', '7', ITER, SALT_B64, DIGEST_B64].join('$');
  assert.ok(broker.verifyPassword('beispiel', fromTool), 'Hash von mosquitto_passwd wird erkannt');
  assert.ok(!broker.verifyPassword('anders', fromTool));
  const own = broker.hashPassword('beispiel', { salt: Buffer.from(SALT_B64, 'base64') });
  assert.strictEqual(own, fromTool, 'gleiches Ergebnis bei gleichem Salz');
  const h = broker.hashPassword('x');
  assert.match(h, /^\$7\$1000\$[A-Za-z0-9+/]{86}==\$[A-Za-z0-9+/]{86}==$/);
  // vom Server gelieferte Hashes dieses Formats passieren die state-Prüfung
  assert.doesNotThrow(() => parseState({ t: 'state', mqtt: { enabled: true, accounts: [{ user: 'shelly', hash: fromTool, acl: [] }] } }));
});

test('mosquitto.conf: nur LAN-Adressen + 127.0.0.1, ohne anonyme Anmeldung; ACL internes Konto nur pluginTopics', () => {
  const conf = broker.buildConf({ dir: '/gc-mqtt', listenAddrs: ['192.168.1.10', 'fe80::1', 'x'], tls: null });
  assert.match(conf, /^allow_anonymous false$/m);
  assert.match(conf, /^password_file \/gc-mqtt\/passwd$/m);
  assert.match(conf, /^acl_file \/gc-mqtt\/acl$/m);
  assert.deepStrictEqual(conf.match(/^listener .*$/gm), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10']);
  assert.ok(!/0\.0\.0\.0/.test(conf));
  const tls = broker.buildConf({ dir: '/gc-mqtt', listenAddrs: ['192.168.1.10'], tls: { certfile: '/c', keyfile: '/k' } });
  assert.match(tls, /^listener 8883 192\.168\.1\.10\ncertfile \/c\nkeyfile \/k$/m);
  const accounts = [{ user: 'shelly', hash: '$7$1$a$b', acl: [{ access: 'readwrite', topic: 'shellies/#' }, { access: 'read', topic: 'zigbee/+' }] }];
  assert.strictEqual(broker.buildPasswd(accounts, '$7$1$i$j'), 'gc-edge:$7$1$i$j\nshelly:$7$1$a$b\n');
  const acl = broker.buildAcl(accounts, ['shellies/#']);
  const block = (u) => acl.split('\n\n').find((b) => b.startsWith(`user ${u}`)).split('\n');
  assert.deepStrictEqual(block('gc-edge'), ['user gc-edge', 'topic read $SYS/broker/clients/connected', 'topic read $SYS/broker/log/N', 'topic readwrite shellies/#']);
  assert.deepStrictEqual(block('shelly'), ['user shelly', 'topic readwrite shellies/#', 'topic read zigbee/+', '']);
});

test('Dateien: 0600, reload nur bei geänderten Konten, enabled/disable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mqtt-'));
  try {
    const f = new broker.BrokerFiles(dir);
    const base = { accounts: [], internalHash: '$7$1$i$j', internalTopics: [], listenAddrs: ['192.168.1.10'], tls: false };
    assert.deepStrictEqual(f.write(base), { confChanged: true, authChanged: true, tls: 'off' });
    for (const n of ['mosquitto.conf', 'passwd', 'acl']) assert.strictEqual(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600, n);
    const r1 = fs.readFileSync(path.join(dir, 'reload'), 'utf8');
    assert.deepStrictEqual(f.write(base), { confChanged: false, authChanged: false, tls: 'off' });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'reload'), 'utf8'), r1, 'kein unnötiges SIGHUP');
    const r = f.write({ ...base, accounts: [{ user: 'a', hash: '$7$1$a$b', acl: [] }] });
    assert.deepStrictEqual(r, { confChanged: false, authChanged: true, tls: 'off' });
    assert.notStrictEqual(fs.readFileSync(path.join(dir, 'reload'), 'utf8'), r1);
    assert.strictEqual(f.write({ ...base, listenAddrs: ['192.168.1.11'] }).confChanged, true);
    assert.strictEqual(f.write({ ...base, tls: true }).tls, 'missing_cert');
    assert.ok(fs.existsSync(path.join(dir, 'enabled')));
    f.disable();
    assert.ok(!fs.existsSync(path.join(dir, 'enabled')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LAN-Adressen des Brokers: nur physische Schnittstellen, nur RFC 1918', () => {
  const ifaces = {
    eth0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    gatecontrol0: [{ family: 'IPv4', address: '10.8.0.5', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    wan0: [{ family: 'IPv4', address: '203.0.113.5', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  assert.deepStrictEqual(lanAddresses(ifaces), ['192.168.1.10']);
});

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; this.subs = []; this.unsubs = []; this.pubs = []; }
  async connect() { this.connected = true; }
  async subscribe(f) { this.subs.push(f); return 1; }
  async unsubscribe(f) { this.unsubs.push(f); }
  async publish(t, p, o) { this.pubs.push([t, p.toString(), o]); }
  end() { this.connected = false; }
}

test('gc.mqtt.*: nur genehmigte Themen (Manifest ∩ pluginTopics), Abos mit Referenzzähler, Verteilung', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mqtt-'));
  const fake = new FakeClient();
  const m = new MqttManager({ dir, getLanAddrs: () => ['192.168.1.10'], clientFactory: () => fake });
  try {
    await m.apply({ enabled: true, tls: false, accounts: [], pluginTopics: { p1: ['shellies/#'] } });
    await new Promise((r) => setImmediate(r));
    assert.ok(fake.connected);
    assert.deepStrictEqual(fake.subs, ['$SYS/broker/clients/connected', '$SYS/broker/log/N']);
    const caps = () => ({ mqtt: { topics: ['shellies/#', 'other/#'] } });
    const got = [];
    const toChild = (msg) => got.push(msg);
    const a = await m.pluginCall('p1', caps, 'mqtt.subscribe', { topic: 'shellies/+/relay/#' }, toChild);
    const b = await m.pluginCall('p1', caps, 'mqtt.subscribe', { topic: 'shellies/+/relay/#' }, toChild);
    assert.deepStrictEqual(fake.subs.slice(2), ['shellies/+/relay/#'], 'Broker-Abo nur einmal');
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.subscribe', { topic: 'other/x' }, toChild), (e) => e.code === 'denied', 'nicht in pluginTopics');
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.subscribe', { topic: '#' }, toChild), (e) => e.code === 'denied');
    await assert.rejects(m.pluginCall('p2', caps, 'mqtt.subscribe', { topic: 'shellies/#' }, toChild), (e) => e.code === 'denied', 'anderes Plugin');
    fake.emit('message', 'shellies/s1/relay/0', Buffer.from('on'), { qos: 0, retain: true });
    fake.emit('message', 'zigbee/x', Buffer.from('no'), { qos: 0, retain: false });
    assert.strictEqual(got.length, 2);
    assert.deepStrictEqual(got[0], { t: 'mqtt', id: a.id, topic: 'shellies/s1/relay/0', b64: Buffer.from('on').toString('base64'), retain: true, qos: 0 });
    await m.pluginCall('p1', caps, 'mqtt.publish', { topic: 'shellies/s1/relay/0/command', b64: Buffer.from('off').toString('base64'), qos: 1, retain: false }, toChild);
    assert.deepStrictEqual(fake.pubs, [['shellies/s1/relay/0/command', 'off', { qos: 1, retain: false }]]);
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.publish', { topic: 'shellies/#', b64: '' }, toChild), (e) => e.code === 'denied');
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.publish', { topic: 'other/x', b64: '' }, toChild), (e) => e.code === 'denied');
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.publish', { topic: 'shellies/x', b64: Buffer.alloc(300 * 1024).toString('base64') }, toChild), (e) => e.code === 'too_large');
    await m.pluginCall('p1', caps, 'mqtt.unsubscribe', { id: a.id }, toChild);
    assert.deepStrictEqual(fake.unsubs, []);
    m.dropPlugin('p1');
    assert.deepStrictEqual(fake.unsubs, ['shellies/+/relay/#'], 'letztes Abo weg → Broker-Abo weg');
    assert.ok(b.id);
    // Konten + Clients aus $SYS
    m.cfg.accounts = [{ user: 'shelly', hash: 'x', acl: [] }];
    fake.emit('message', '$SYS/broker/clients/connected', Buffer.from('3'), {});
    fake.emit('message', '$SYS/broker/log/N', Buffer.from("1: New client connected from 192.168.1.20:5000 as shelly1 (p2, c1, k60, u'shelly')."), {});
    let st = m.status();
    assert.strictEqual(st.clients, 2, 'ohne das interne Konto');
    assert.strictEqual(st.accounts[0].connected, true);
    fake.emit('message', '$SYS/broker/log/N', Buffer.from('2: Client shelly1 [192.168.1.20:5000] disconnected.'), {});
    st = m.status();
    assert.strictEqual(st.accounts[0].connected, false);
    assert.ok(st.accounts[0].lastSeen);
    // ausgeschaltet → not_enabled, Datei enabled weg
    await m.apply({ enabled: false, tls: false, accounts: [], pluginTopics: {} });
    await assert.rejects(m.pluginCall('p1', caps, 'mqtt.publish', { topic: 'shellies/x', b64: '' }, toChild), (e) => e.code === 'not_enabled');
    assert.ok(!fs.existsSync(path.join(dir, 'enabled')));
  } finally {
    await m.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MQTT-Client gegen einen Fake-Broker: CONNECT, SUBSCRIBE, PUBLISH QoS 1 in beide Richtungen', async () => {
  assert.deepStrictEqual([...encodeLength(321)], [0xc1, 0x02]);
  const seen = [];
  const srv = net.createServer((s) => {
    const p = new Parser();
    s.on('data', (d) => {
      for (const pk of p.push(d)) {
        seen.push(pk.type);
        if (pk.type === T.CONNECT) {
          const user = pk.body.toString('utf8');
          s.write(Buffer.from([0x20, 2, 0, user.includes('gc-edge') ? 0 : 5]));
        } else if (pk.type === T.SUBSCRIBE) {
          s.write(Buffer.from([0x90, 3, pk.body[0], pk.body[1], 1]));
          // eingehende Nachricht QoS 1, Paket-ID 7
          const topic = Buffer.from('a/b');
          s.write(Buffer.concat([Buffer.from([0x32, 2 + topic.length + 2 + 2, 0, topic.length]), topic, Buffer.from([0, 7]), Buffer.from('hi')]));
        } else if (pk.type === T.PUBLISH) {
          s.write(Buffer.from([0x40, 2, pk.body[pk.body.readUInt16BE(0) + 2], pk.body[pk.body.readUInt16BE(0) + 3]]));
        } else if (pk.type === T.PUBACK) {
          seen.push(`puback:${pk.body.readUInt16BE(0)}`);
        }
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const bad = new MqttClient({ port, clientId: 'x', username: 'wrong', password: 'p' });
    await assert.rejects(bad.connect(), (e) => e.code === 'auth');
    const c = new MqttClient({ port, clientId: 'x', username: 'gc-edge', password: 'p' });
    await c.connect();
    const msg = new Promise((r) => c.once('message', (t, p, meta) => r([t, p.toString(), meta])));
    assert.strictEqual(await c.subscribe('a/#', 1), 1);
    assert.deepStrictEqual(await msg, ['a/b', 'hi', { qos: 1, retain: false }]);
    await c.publish('a/c', Buffer.from('x'), { qos: 1 });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.includes('puback:7'), 'eingehendes QoS 1 bestätigt');
    c.end();
  } finally {
    srv.close();
  }
});

test('mDNS: _mqtt._tcp wird angekündigt und auf Fragen beantwortet; browse liefert Funde', () => {
  const { MdnsService } = require('../src/edge/mdnsService');
  const sent = [];
  let opts = null;
  const fake = Object.assign(new EventEmitter(), { respond: (r) => sent.push(['respond', r]), query: (q) => sent.push(['query', q]), destroy() {} });
  const s = new MdnsService({ factory: (o) => { opts = o; return fake; }, getInterface: () => '192.168.1.10' });
  s.announce({ instance: 'GateControl MQTT gw', service: '_mqtt._tcp', host: 'gw', port: 1883, addresses: ['192.168.1.10'] });
  assert.deepStrictEqual({ bind: opts.bind, interface: opts.interface }, { bind: '0.0.0.0', interface: '192.168.1.10' });
  assert.strictEqual(sent[0][0], 'respond');
  fake.emit('query', { questions: [{ name: '_mqtt._tcp.local', type: 'PTR' }] });
  fake.emit('query', { questions: [{ name: '_http._tcp.local', type: 'PTR' }] });
  assert.strictEqual(sent.filter((x) => x[0] === 'respond').length, 2);
  const srv = sent[1][1].additionals.find((r) => r.type === 'SRV');
  assert.deepStrictEqual(srv.data, { port: 1883, weight: 0, priority: 0, target: 'gw.local' });
  const found = [];
  s.browse('_shelly._tcp', (f) => found.push(f));
  fake.emit('response', { answers: [{ type: 'SRV', name: 'plug._shelly._tcp.local', data: { port: 80, target: 'plug.local' } }],
    additionals: [{ type: 'A', name: 'plug.local', data: '192.168.1.50' }, { type: 'TXT', name: 'plug._shelly._tcp.local', data: [Buffer.from('gen=2')] }] });
  fake.emit('response', { answers: [{ type: 'SRV', name: 'plug._shelly._tcp.local', data: { port: 80, target: 'plug.local' } }], additionals: [{ type: 'A', name: 'plug.local', data: '192.168.1.50' }] });
  assert.deepStrictEqual(found, [{ host: 'plug.local', ip: '192.168.1.50', port: 80, service: '_shelly._tcp', txt: ['gen=2'] }], 'einmal je Gerät');
  s.announce(null);
  s.close();
});
