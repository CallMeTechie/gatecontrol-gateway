'use strict';

// Zweiter TLS-Port für Geräte mit Fingerabdruck (docs/vpn-cert.md „Zweiter Port für
// Geräte mit Fingerabdruck“): Unterschalter features.mqtt_tls.fingerprint_port,
// Standard aus, nur zusammen mit dem Gerätezertifikat. Port 8884 lauscht dann mit
// dem selbst erzeugten Zertifikat (derselbe Fingerabdruck wie bisher auf 8883),
// Port 8883 behält das Gerätezertifikat. Fällt 8883 auf das selbst erzeugte
// zurück, entfällt 8884.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { MqttManager } = require('../src/edge/mqtt/manager');
const broker = require('../src/edge/mqtt/broker');

const AREA = 'geraete.vpn.example.test';
const WILDCARD = `*.${AREA}`;
const NAME = 'mqtt-gw-keller';
const TUNNEL = '10.8.0.7';
const LAN = '192.168.1.10';
const quiet = { info() {}, warn() {}, debug() {} };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; }
  async connect() { this.connected = true; }
  async subscribe() {}
  async unsubscribe() {}
  async publish() {}
  end() { this.connected = false; }
}

function wildcard(days = 90) {
  const c = makeSelfSigned({ commonName: WILDCARD, days, altNames: [{ dns: WILDCARD }] });
  return { ...c, notAfter: new Date(Date.now() + days * 86_400_000).toISOString() };
}

function fakeVpnCert(dir) {
  const st = { cur: null };
  return {
    st,
    set(c) {
      st.cur = c;
      if (c) { fs.writeFileSync(path.join(dir, 'fullchain.pem'), c.cert); fs.writeFileSync(path.join(dir, 'privkey.pem'), c.key); }
    },
    status: () => (st.cur ? { state: 'ok', wildcard: WILDCARD, fingerprint: st.cur.sha256, notAfter: st.cur.notAfter } : null),
    files: () => (st.cur ? { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') } : null),
  };
}

const ON = { enabled: true, tls: true, accounts: [], pluginTopics: {} };
const VPN = { vpn_cert: true, vpn_name: NAME };
const FP = { ...VPN, fingerprint_port: true };

function setup({ tunnelUp = true, portTaken = () => false } = {}) {
  const dir = tmp('gc-mqtt-');
  const state = tmp('gc-state-');
  const certDir = tmp('gc-vpncert-');
  let changes = 0;
  const m = new MqttManager({ dir, brokerDir: '/gc-mqtt', tlsDir: path.join(state, 'mqtt-tls'), logger: quiet, hostname: 'gw-keller',
    getLanAddrs: () => [LAN], clientFactory: () => new FakeClient(), onChange: () => { changes++; } });
  const vpnCert = fakeVpnCert(certDir);
  m.attachVpnCert({ vpnCert, tunnelIp: TUNNEL, hasAddr: (ip) => tunnelUp && ip === TUNNEL, portTaken });
  const conf = () => fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
  const listeners = () => conf().match(/^listener .*$/gm);
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const reload = () => { try { return read('reload'); } catch { return null; } };
  const cleanup = async () => { await m.stop(); for (const d of [dir, state, certDir]) fs.rmSync(d, { recursive: true, force: true }); };
  return { m, dir, vpnCert, conf, listeners, read, reload, cleanup, changes: () => changes };
}

test('Unterschalter fehlt (Standard, älterer Server): alles wie in 1.44.0 – kein Port 8884, kein tls-self/', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(VPN);
    assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', `listener 1883 ${LAN}`, `listener 8883 ${LAN}`, `listener 8883 ${TUNNEL}`]);
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls-self')));
    assert.ok(!t.conf().includes('8884'));
    assert.strictEqual(t.m.status().tlsFp, undefined);
    assert.deepStrictEqual(t.m.fingerprintPortTelemetry(), { enabled: false, port: 8884, state: 'off', tunnel: null });
    // fingerprint_port ohne vpn_cert ist wirkungslos
    t.m.applyVpnCert({ fingerprint_port: true });
    assert.ok(!t.conf().includes('8884'));
    assert.strictEqual(t.m.status().tlsSource, 'self');
    assert.strictEqual(t.m.fingerprintPortTelemetry().enabled, false);
  } finally { await t.cleanup(); }
});

test('Unterschalter an: 8883 behält das Gerätezertifikat, 8884 hat das selbst erzeugte mit unverändertem Fingerabdruck', async () => {
  const t = setup();
  try {
    const c = wildcard();
    t.vpnCert.set(c);
    await t.m.apply(ON);
    const own = t.m.status(); // vorher: 8883 mit dem selbst erzeugten
    assert.strictEqual(own.tlsSource, 'self');
    t.m.applyVpnCert(VPN);
    const before = t.changes();
    t.m.applyVpnCert(FP);
    assert.ok(t.changes() > before, 'der neue Zustand wird gemeldet');
    assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', `listener 1883 ${LAN}`, `listener 8883 ${LAN}`, `listener 8883 ${TUNNEL}`,
      `listener 8884 ${LAN}`, `listener 8884 ${TUNNEL}`], '8884 an denselben Adressen wie 8883, 1883 nie am Tunnel');
    const lines = t.conf().split('\n');
    const i = lines.indexOf(`listener 8884 ${LAN}`);
    assert.deepStrictEqual(lines.slice(i, i + 3), [`listener 8884 ${LAN}`, `certfile ${path.join(t.dir, 'tls-self', 'server.crt')}`, `keyfile ${path.join(t.dir, 'tls-self', 'server.key')}`]);
    const j = lines.indexOf(`listener 8883 ${LAN}`);
    assert.strictEqual(lines[j + 1], `certfile ${path.join(t.dir, 'tls', 'server.crt')}`, '8883 bleibt beim Gerätezertifikat');
    assert.strictEqual(t.read('tls/server.crt'), c.cert);
    assert.strictEqual(t.read('tls-self/server.crt'), own.tlsCert, 'derselbe PEM wie vorher auf 8883');
    assert.ok(t.conf().includes(`SHA-256 ${own.tlsSha256}`));
    // Rechte wie beim Zertifikat von 8883: niemand außer Besitzer und Gruppe des Brokers
    assert.strictEqual(fs.statSync(path.join(t.dir, 'tls-self', 'server.key')).mode & 0o777, 0o640);
    assert.strictEqual(fs.statSync(path.join(t.dir, 'tls-self')).mode & 0o777, 0o750);
    const st = t.m.status();
    assert.strictEqual(st.tlsSource, 'vpn-cert');
    assert.strictEqual(st.tlsSha256, c.sha256);
    assert.deepStrictEqual(st.tlsFp, { port: 8884, sha256: own.tlsSha256, cert: own.tlsCert });
    assert.deepStrictEqual(t.m.fingerprintPortTelemetry(), { enabled: true, port: 8884, state: 'active', tunnel: 'listening' });
    assert.ok(!JSON.stringify(t.m.fingerprintPortTelemetry()).includes('PRIVATE'), 'kein Schlüssel in der Telemetrie');
  } finally { await t.cleanup(); }
});

test('Erneuerung des Gerätezertifikats: nur reload, mosquitto.conf und tls-self/ bleiben unverändert (Verbindungen auf 8884 bleiben)', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(FP);
    const conf = t.conf();
    const self = [t.read('tls-self/server.crt'), t.read('tls-self/server.key')];
    const mtime = fs.statSync(path.join(t.dir, 'tls-self', 'server.key')).mtimeMs;
    const r = t.reload();
    const c2 = wildcard();
    t.vpnCert.set(c2);
    t.m.refresh();
    assert.strictEqual(t.conf(), conf, 'keine neue conf → kein Neustart');
    assert.notStrictEqual(t.reload(), r, 'reload → SIGHUP');
    assert.strictEqual(t.read('tls/server.crt'), c2.cert);
    assert.deepStrictEqual([t.read('tls-self/server.crt'), t.read('tls-self/server.key')], self);
    assert.strictEqual(fs.statSync(path.join(t.dir, 'tls-self', 'server.key')).mtimeMs, mtime, 'die Dateien von 8884 werden nicht angefasst');
    // nichts geändert → auch kein reload
    const r2 = t.reload();
    t.m.refresh();
    assert.strictEqual(t.reload(), r2);
  } finally { await t.cleanup(); }
});

test('Fallback auf das selbst erzeugte (Ablauf/Entzug): 8884 entfällt, tls-self/ wird entfernt; wieder da → 8884 zurück', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(FP);
    const fp = t.m.status().tlsFp.sha256;
    t.vpnCert.set(null);
    t.m.refresh();
    assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', `listener 1883 ${LAN}`, `listener 8883 ${LAN}`]);
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls-self')));
    const st = t.m.status();
    assert.strictEqual(st.tlsSource, 'self');
    assert.strictEqual(st.tlsSha256, fp, '8883 hat wieder das selbst erzeugte');
    assert.strictEqual(st.tlsFp, undefined);
    assert.deepStrictEqual(t.m.fingerprintPortTelemetry(), { enabled: true, port: 8884, state: 'fallback', tunnel: null });
    t.vpnCert.set(wildcard());
    t.m.refresh();
    assert.ok(t.listeners().includes(`listener 8884 ${LAN}`));
    assert.strictEqual(t.m.status().tlsFp.sha256, fp);
  } finally { await t.cleanup(); }
});

test('Unterschalter oder Gerätezertifikat aus: tls-self/ wird entfernt, conf wieder wie vorher', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(VPN);
    const confVpn = t.conf();
    t.m.applyVpnCert(FP);
    assert.ok(fs.existsSync(path.join(t.dir, 'tls-self', 'server.key')));
    t.m.applyVpnCert(VPN);
    assert.strictEqual(t.conf(), confVpn);
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls-self')));
    assert.strictEqual(t.m.fingerprintPortTelemetry().state, 'off');
    t.m.applyVpnCert(FP);
    t.m.applyVpnCert(undefined);
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls-self')));
    assert.ok(!t.conf().includes('8884'));
    assert.strictEqual(t.m.status().tlsSource, 'self');
  } finally { await t.cleanup(); }
});

test('TLS aus oder Broker aus: auch der Schlüssel von 8884 verlässt die Ablage', async () => {
  for (const off of [{ ...ON, tls: false }, { ...ON, enabled: false }]) {
    const t = setup();
    try {
      t.vpnCert.set(wildcard());
      await t.m.apply(ON);
      t.m.applyVpnCert(FP);
      assert.ok(fs.existsSync(path.join(t.dir, 'tls-self', 'server.key')));
      await t.m.apply(off);
      assert.ok(!fs.existsSync(path.join(t.dir, 'tls-self')));
      assert.strictEqual(t.m.status().tlsFp, undefined);
      assert.strictEqual(t.m.fingerprintPortTelemetry().state, 'broker_off');
    } finally { await t.cleanup(); }
  }
});

test('Tunnel: 8884 nur, wenn die Adresse da und 8884 dort frei ist – Mosquitto scheitert nie am Port', async () => {
  const cases = [
    [{ tunnelUp: false }, 'no_address', 'no_address'],
    [{ portTaken: (p) => p === 8884 }, 'listening', 'port_in_use'],
    [{ portTaken: (p) => p === 8883 }, 'port_in_use', 'listening'],
  ];
  for (const [opts, tun8883, tun8884] of cases) {
    const t = setup(opts);
    try {
      t.vpnCert.set(wildcard());
      await t.m.apply(ON);
      t.m.applyVpnCert(FP);
      const ls = t.listeners();
      assert.ok(ls.includes(`listener 8884 ${LAN}`), 'im LAN immer');
      assert.strictEqual(ls.includes(`listener 8884 ${TUNNEL}`), tun8884 === 'listening');
      assert.strictEqual(ls.includes(`listener 8883 ${TUNNEL}`), tun8883 === 'listening');
      assert.strictEqual(t.m.vpnTelemetry().tunnel, tun8883);
      assert.deepStrictEqual(t.m.fingerprintPortTelemetry(), { enabled: true, port: 8884, state: 'active', tunnel: tun8884 });
    } finally { await t.cleanup(); }
  }
});

test('buildConf: 8884 nur neben dem Gerätezertifikat; TLS_FP_PORT', () => {
  assert.strictEqual(broker.TLS_FP_PORT, 8884);
  const tlsFiles = { certfile: '/x/tls/server.crt', keyfile: '/x/tls/server.key', sha256: 'ab', source: 'self', extraAddrs: [] };
  const fp = { certfile: '/x/tls-self/server.crt', keyfile: '/x/tls-self/server.key', sha256: 'cd', extraAddrs: [TUNNEL, 'kein-ip'] };
  assert.ok(!broker.buildConf({ dir: '/x', listenAddrs: [LAN], tls: tlsFiles, fp }).includes('8884'), 'mit dem selbst erzeugten auf 8883 kein zweiter Port');
  const conf = broker.buildConf({ dir: '/x', listenAddrs: [LAN], tls: { ...tlsFiles, source: 'vpn-cert', wildcard: WILDCARD }, fp }).split('\n');
  assert.ok(conf.includes(`listener 8884 ${LAN}`));
  assert.ok(conf.includes(`listener 8884 ${TUNNEL}`));
  assert.ok(!conf.some((l) => l.includes('kein-ip')));
  assert.ok(conf.includes('# TLS 8884: Zertifikat des Gateways (fester Fingerabdruck), SHA-256 cd'));
});
