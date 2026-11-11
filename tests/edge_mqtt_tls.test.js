'use strict';

// MQTT-Broker mit TLS (docs/edge.md „MQTT“ › TLS): zusätzlich Port 8883 mit einem
// selbst erzeugten Zertifikat des Gateways – pro Gateway schaltbar (state.mqtt.tls),
// Standard aus, Port 1883 bleibt. Das Zertifikat bleibt über Neustarts gleich
// (State-Verzeichnis), sein Fingerabdruck geht mit dem Status an den Server.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const EventEmitter = require('node:events');
const broker = require('../src/edge/mqtt/broker');
const { MqttManager } = require('../src/edge/mqtt/manager');
const { EdgeBridge } = require('../src/edge/bridge');
const { RemoteMqtt } = require('../src/edge/remote');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { info() {}, warn() {}, debug() {} };

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; }
  async connect() { this.connected = true; }
  async subscribe() {}
  async unsubscribe() {}
  async publish() {}
  end() { this.connected = false; }
}

function manager(dir, tlsDir, extra = {}) {
  return new MqttManager({ dir, tlsDir, logger: quiet, hostname: 'gw-keller.fritz.box', getLanAddrs: () => ['192.168.1.10'], clientFactory: () => new FakeClient(), ...extra });
}
const ON = { enabled: true, tls: true, accounts: [], pluginTopics: {} };
const OFF = { enabled: true, tls: false, accounts: [], pluginTopics: {} };

test('Standard aus: kein Zertifikat, kein Listener 8883, kein Fingerabdruck im Status', async () => {
  const dir = tmp('gc-mqtt-');
  const state = tmp('gc-state-');
  try {
    const m = manager(dir, path.join(state, 'mqtt-tls'));
    await m.apply(OFF);
    const conf = fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
    assert.deepStrictEqual(conf.match(/^listener .*$/gm), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10']);
    assert.ok(!/certfile|keyfile/.test(conf));
    assert.ok(!fs.existsSync(path.join(state, 'mqtt-tls')), 'ohne TLS wird kein Zertifikat erzeugt');
    const st = m.status();
    assert.strictEqual(st.tls, 'off');
    assert.ok(!('tlsSha256' in st) && !('tlsCert' in st));
    await m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('TLS an: selbst erzeugtes Zertifikat, Listener 8883 neben 1883, Fingerabdruck im Status', async () => {
  const dir = tmp('gc-mqtt-');
  const state = tmp('gc-state-');
  try {
    let changes = 0;
    const m = manager(dir, path.join(state, 'mqtt-tls'), { onChange: () => { changes++; } });
    await m.apply(ON);
    const conf = fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
    assert.deepStrictEqual(conf.match(/^listener .*$/gm), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10', 'listener 8883 192.168.1.10'],
      'der unverschlüsselte Port bleibt, 8883 nur an den LAN-Adressen');
    const crt = path.join(dir, 'tls', 'server.crt');
    const key = path.join(dir, 'tls', 'server.key');
    assert.match(conf, new RegExp(`^listener 8883 192\\.168\\.1\\.10\\ncertfile ${crt}\\nkeyfile ${key}$`, 'm'));
    for (const f of [crt, key]) assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, f);
    const st = m.status();
    assert.strictEqual(st.tls, 'on');
    assert.match(st.tlsSha256, /^[0-9a-f]{64}$/);
    const x = new crypto.X509Certificate(st.tlsCert);
    assert.strictEqual(crypto.createHash('sha256').update(x.raw).digest('hex'), st.tlsSha256, 'der Fingerabdruck gehört zum gemeldeten Zertifikat');
    assert.strictEqual(fs.readFileSync(crt, 'utf8'), st.tlsCert, 'der Broker bekommt genau dieses Zertifikat');
    assert.ok(x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(key, 'utf8'))));
    assert.match(x.subject, /CN=GateControl MQTT/);
    assert.match(x.subjectAltName, /DNS:gw-keller/);
    assert.match(x.subjectAltName, /DNS:gw-keller\.local/);
    assert.match(x.subjectAltName, /IP Address:192\.168\.1\.10/);
    assert.ok(new Date(x.validTo).getTime() > Date.now() + 9 * 365 * 86_400_000, 'lange gültig – Geräte prüfen den Fingerabdruck');
    assert.ok(conf.includes(st.tlsSha256), 'der Fingerabdruck steht in der mosquitto.conf (neues Zertifikat → Neustart des Brokers)');
    assert.ok(!JSON.stringify(st).includes('PRIVATE KEY'), 'der Schlüssel geht nie in den Status');
    assert.ok(changes >= 1, 'der neue TLS-Zustand wird gemeldet');
    // der Schlüssel im State-Verzeichnis: nur für den Besitzer
    assert.strictEqual(fs.statSync(path.join(state, 'mqtt-tls', 'key.pem')).mode & 0o777, 0o600);

    // wieder aus: Listener weg, Schlüssel nicht mehr in der Ablage des Brokers, Zertifikat bleibt im State-Verzeichnis
    await m.apply(OFF);
    assert.ok(!/8883/.test(fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8')));
    assert.ok(!fs.existsSync(key));
    assert.strictEqual(m.status().tls, 'off');
    assert.ok(fs.existsSync(path.join(state, 'mqtt-tls', 'cert.pem')));
    await m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('Neustart: dasselbe Zertifikat (State-Verzeichnis), auch wenn die Ablage des Brokers ein leeres tmpfs ist', async () => {
  const state = tmp('gc-state-');
  const dirs = [tmp('gc-mqtt-'), tmp('gc-mqtt-')];
  try {
    const a = manager(dirs[0], path.join(state, 'mqtt-tls'));
    await a.apply(ON);
    const first = a.status();
    await a.stop();
    // neuer Prozess, neue (leere) Ablage, andere LAN-Adresse
    const b = manager(dirs[1], path.join(state, 'mqtt-tls'), { getLanAddrs: () => ['192.168.1.77'] });
    await b.apply(ON);
    const second = b.status();
    assert.strictEqual(second.tlsSha256, first.tlsSha256);
    assert.strictEqual(second.tlsCert, first.tlsCert);
    assert.strictEqual(fs.readFileSync(path.join(dirs[1], 'tls', 'server.crt'), 'utf8'), first.tlsCert);
    assert.match(fs.readFileSync(path.join(dirs[1], 'mosquitto.conf'), 'utf8'), /^listener 8883 192\.168\.1\.77$/m);
    // der Tick schreibt nichts neu (kein Neustart des Brokers ohne Änderung)
    const before = fs.statSync(path.join(dirs[1], 'mosquitto.conf')).mtimeMs;
    b.refresh();
    assert.strictEqual(fs.statSync(path.join(dirs[1], 'mosquitto.conf')).mtimeMs, before);
    await b.stop();
  } finally { for (const d of [state, ...dirs]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('ohne tlsDir (alte Compose-Datei, Edge-Host): das Zertifikat bleibt in der eigenen Ablage', async () => {
  const dir = tmp('gc-mqtt-');
  try {
    const a = manager(dir, undefined);
    await a.apply(ON);
    const fp = a.status().tlsSha256;
    await a.stop();
    assert.ok(fs.existsSync(path.join(dir, 'tls-own', 'cert.pem')));
    const b = manager(dir, undefined);
    await b.apply(ON);
    assert.strictEqual(b.status().tlsSha256, fp);
    await b.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Gateway-Ablage (Wächter liest mit Gruppe 61001): tls/ 0750, Dateien 0640, Pfade in der mosquitto.conf zeigen in die Ablage', async () => {
  const dir = tmp('gc-mqtt-conf-');
  const state = tmp('gc-state-');
  try {
    const m = new MqttManager({ dir, brokerDir: '/gc-mqtt', tlsDir: path.join(state, 'mqtt-tls'), logger: quiet, getLanAddrs: () => ['10.0.0.5'], clientFactory: () => new FakeClient() });
    await m.apply(ON);
    assert.strictEqual(fs.statSync(path.join(dir, 'tls')).mode & 0o777, 0o750);
    for (const f of ['server.crt', 'server.key']) assert.strictEqual(fs.statSync(path.join(dir, 'tls', f)).mode & 0o777, 0o640, f);
    const conf = fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
    assert.match(conf, /^password_file \/gc-mqtt\/passwd$/m);
    // Mosquitto liest Zertifikat und Schlüssel direkt aus der Ablage des Gateways (der Wächter kopiert nur conf/passwd/acl)
    assert.ok(conf.includes(`certfile ${path.join(dir, 'tls', 'server.crt')}\nkeyfile ${path.join(dir, 'tls', 'server.key')}`));
    await m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); }
});

test('Zertifikat lässt sich nicht anlegen → tls: missing_cert, Port 1883 läuft weiter', async () => {
  const dir = tmp('gc-mqtt-');
  try {
    const m = manager(dir, path.join(dir, 'x'), { loadCert: () => { throw new Error('read-only file system'); } });
    await m.apply(ON);
    const conf = fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
    assert.deepStrictEqual(conf.match(/^listener .*$/gm), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10']);
    const st = m.status();
    assert.strictEqual(st.tls, 'missing_cert');
    assert.ok(!('tlsSha256' in st));
    await m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildConf: der Fingerabdruck als Kommentar, Zertifikat je LAN-Adresse', () => {
  const conf = broker.buildConf({ dir: '/gc-mqtt', listenAddrs: ['192.168.1.10', '10.0.0.5'], tls: { certfile: '/c', keyfile: '/k', sha256: 'ab'.repeat(32) } });
  assert.match(conf, new RegExp(`^# TLS: Zertifikat des Gateways, SHA-256 ${'ab'.repeat(32)}$`, 'm'));
  assert.strictEqual(conf.match(/^listener 8883 /gm).length, 2);
  assert.strictEqual(conf.match(/^certfile \/c$/gm).length, 2);
});

test('ein TLS-Client mit dem gemeldeten Fingerabdruck erreicht genau dieses Zertifikat (Pinning wie im Gerät)', async () => {
  const dir = tmp('gc-mqtt-');
  try {
    const m = manager(dir, path.join(dir, 'state'));
    await m.apply(ON);
    const st = m.status();
    // ein TLS-Server mit den Dateien, die der Broker bekommt
    const srv = tls.createServer({ cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')), key: fs.readFileSync(path.join(dir, 'tls', 'server.key')) }, (s) => s.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const seen = await new Promise((resolve, reject) => {
        // wie ein Gerät mit hinterlegtem Zertifikat: nur dieses eine gilt
        const c = tls.connect({ host: '127.0.0.1', port: srv.address().port, ca: [st.tlsCert], servername: 'gw-keller.local' }, () => {
          const fp = c.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase();
          c.end();
          resolve(fp);
        });
        c.on('error', reject);
      });
      assert.strictEqual(seen, st.tlsSha256);
    } finally { await new Promise((r) => srv.close(r)); }
    await m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hello/info: die Fähigkeit tlsCert geht vom Gateway über den Socket an den Edge-Host', () => {
  const m = new MqttManager({ dir: '/nonexistent-gc-mqtt', logger: quiet });
  assert.strictEqual(m.tlsCert(), true);
  const sent = [];
  const bridge = Object.create(EdgeBridge.prototype);
  bridge.mqtt = m;
  bridge.rpc = { readyState: 1, send: (t) => sent.push(JSON.parse(t)) };
  bridge.sendInfo();
  assert.deepStrictEqual(sent[0].mqtt, { available: false, tlsCert: true });
  // Edge-Host: ein älterer Gateway-Container meldet die Fähigkeit nicht
  const rpc = new EventEmitter();
  rpc.info = null;
  const remote = new RemoteMqtt({ rpc });
  assert.strictEqual(remote.tlsCert(), false);
  rpc.info = { mqtt: { available: true, tlsCert: true }, mqttStatus: { running: true, clients: 0, tls: 'on', tlsSha256: 'ab'.repeat(32), accounts: [] } };
  assert.strictEqual(remote.tlsCert(), true);
  assert.strictEqual(remote.status().tlsSha256, 'ab'.repeat(32), 'der Status des Gateways geht unverändert weiter');
});
