'use strict';

// MQTT-TLS mit dem Gerätezertifikat (docs/vpn-cert.md „MQTT mit dem
// Gerätezertifikat“): Schalter features.mqtt_tls.vpn_cert, Standard aus. Port 8883
// nimmt dann das weitergegebene Wildcard *.geraete.<zone> statt des selbst
// erzeugten, lauscht auch an der Tunnel-Adresse; ohne gültiges Zertifikat oder
// mit Schalter aus bleibt alles wie bisher. Erneuerung → nur `reload` (SIGHUP).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const EventEmitter = require('node:events');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { MqttManager, hasLocalAddress } = require('../src/edge/mqtt/manager');
const broker = require('../src/edge/mqtt/broker');

const AREA = 'geraete.vpn.example.test';
const WILDCARD = `*.${AREA}`;
const NAME = 'mqtt-gw-keller';
const HOST = `${NAME}.${AREA}`;
const TUNNEL = '10.8.0.7';
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

/** Wie VpnCertManager: status() und files() über die abgelegten Dateien. */
function fakeVpnCert(dir) {
  const st = { cur: null };
  return {
    st,
    set(c) {
      st.cur = c;
      if (c) { fs.writeFileSync(path.join(dir, 'fullchain.pem'), c.cert); fs.writeFileSync(path.join(dir, 'privkey.pem'), c.key); } else {
        fs.rmSync(path.join(dir, 'fullchain.pem'), { force: true });
        fs.rmSync(path.join(dir, 'privkey.pem'), { force: true });
      }
    },
    status: () => (st.cur ? { state: 'ok', wildcard: WILDCARD, fingerprint: st.cur.sha256, notAfter: st.cur.notAfter } : null),
    files: () => (st.cur ? { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') } : null),
  };
}

const ON = { enabled: true, tls: true, accounts: [], pluginTopics: {} };
const SWITCH = { vpn_cert: true, vpn_name: NAME };

function setup({ tunnelUp = true, portTaken = () => false } = {}) {
  const dir = tmp('gc-mqtt-');
  const state = tmp('gc-state-');
  const certDir = tmp('gc-vpncert-');
  let changes = 0;
  const m = new MqttManager({ dir, brokerDir: '/gc-mqtt', tlsDir: path.join(state, 'mqtt-tls'), logger: quiet, hostname: 'gw-keller',
    getLanAddrs: () => ['192.168.1.10'], clientFactory: () => new FakeClient(), onChange: () => { changes++; } });
  const vpnCert = fakeVpnCert(certDir);
  m.attachVpnCert({ vpnCert, tunnelIp: TUNNEL, hasAddr: (ip) => tunnelUp && ip === TUNNEL, portTaken });
  const conf = () => fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8');
  const listeners = () => conf().match(/^listener .*$/gm);
  const served = () => fs.readFileSync(path.join(dir, 'tls', 'server.crt'), 'utf8');
  const reload = () => { try { return fs.readFileSync(path.join(dir, 'reload'), 'utf8'); } catch { return null; } };
  const cleanup = async () => { await m.stop(); for (const d of [dir, state, certDir]) fs.rmSync(d, { recursive: true, force: true }); };
  return { m, dir, vpnCert, conf, listeners, served, reload, cleanup, changes: () => changes };
}

test('Schalter aus (Standard): selbst erzeugtes Zertifikat wie bisher, auch wenn ein Gerätezertifikat da ist', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10', 'listener 8883 192.168.1.10']);
    const st = t.m.status();
    assert.strictEqual(st.tlsSource, 'self');
    assert.ok(st.tlsCert, 'das selbst erzeugte geht weiter als PEM an den Server');
    assert.notStrictEqual(st.tlsSha256, t.vpnCert.st.cur.sha256);
    assert.ok(!/Gerätezertifikat/.test(t.conf()));
    assert.deepStrictEqual(t.m.vpnTelemetry(), { enabled: false, state: 'off', host: null, tunnel: null });
    // features.mqtt_tls fehlt (älterer Server) → aus
    t.m.applyVpnCert(undefined);
    assert.strictEqual(t.m.status().tlsSource, 'self');
  } finally { await t.cleanup(); }
});

test('Schalter an mit gültigem Wildcard: Port 8883 mit dem Gerätezertifikat, auch an der Tunnel-Adresse, Name mqtt-<gateway>.<Bereich>', async () => {
  const t = setup();
  try {
    const c = wildcard();
    t.vpnCert.set(c);
    await t.m.apply(ON);
    const before = t.changes();
    t.m.applyVpnCert(SWITCH);
    assert.ok(t.changes() > before, 'der neue Zustand wird gemeldet');
    assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10', 'listener 8883 192.168.1.10', `listener 8883 ${TUNNEL}`],
      '1883 bleibt nur im LAN, 8883 zusätzlich an der Tunnel-Adresse');
    // Mosquitto liest Zertifikat und Schlüssel direkt aus der Ablage des Gateways (/gc-mqtt-conf)
    assert.ok(t.conf().includes(`listener 8883 ${TUNNEL}\ncertfile ${path.join(t.dir, 'tls', 'server.crt')}\nkeyfile ${path.join(t.dir, 'tls', 'server.key')}\n`));
    assert.match(t.conf(), /# TLS: Gerätezertifikat \*\.geraete\.vpn\.example\.test – Erneuerung per SIGHUP/);
    assert.ok(!t.conf().includes(c.sha256), 'kein Fingerabdruck in der conf: eine Erneuerung startet Mosquitto nicht neu');
    assert.strictEqual(t.served(), c.cert);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'tls', 'server.key'), 'utf8'), c.key);
    // Gateway-Ablage: nur der Broker (Gruppe 61001) liest, niemand sonst
    assert.strictEqual(fs.statSync(path.join(t.dir, 'tls', 'server.key')).mode & 0o007, 0);
    const st = t.m.status();
    assert.strictEqual(st.tls, 'on');
    assert.strictEqual(st.tlsSource, 'vpn-cert');
    assert.strictEqual(st.tlsSha256, c.sha256);
    assert.strictEqual(st.tlsHost, HOST);
    assert.ok(!('tlsCert' in st), 'kein PEM: Clients prüfen hier den Namen');
    assert.ok(!JSON.stringify(st).includes('PRIVATE KEY'));
    assert.deepStrictEqual(t.m.vpnTelemetry(), { enabled: true, state: 'active', host: HOST, tunnel: 'listening' });
    assert.ok(!JSON.stringify(t.m.vpnTelemetry()).includes('PRIVATE KEY'));
  } finally { await t.cleanup(); }
});

test('ein TLS-Client prüft Kette und Namen mqtt-<gateway>.<Bereich> – ohne eigenes Vertrauen außer der CA', async () => {
  const t = setup();
  try {
    const c = wildcard();
    t.vpnCert.set(c);
    await t.m.apply(ON);
    t.m.applyVpnCert(SWITCH);
    const srv = tls.createServer({ cert: fs.readFileSync(path.join(t.dir, 'tls', 'server.crt')), key: fs.readFileSync(path.join(t.dir, 'tls', 'server.key')) }, (s) => s.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const connect = (servername) => new Promise((resolve, reject) => {
      // das Testzertifikat ist seine eigene CA; im Betrieb ist es eine öffentliche
      const s = tls.connect({ host: '127.0.0.1', port: srv.address().port, ca: [c.cert], servername }, () => { s.end(); resolve('ok'); });
      s.on('error', (e) => reject(e));
    });
    try {
      assert.strictEqual(await connect(HOST), 'ok');
      await assert.rejects(connect(`a.${HOST}`), /altnames|Hostname/i, 'zwei Ebenen deckt das Wildcard nicht');
    } finally { await new Promise((r) => srv.close(r)); }
  } finally { await t.cleanup(); }
});

test('Erneuerung: neue Dateien und nur reload (SIGHUP) – die mosquitto.conf bleibt, Clients bleiben verbunden', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(SWITCH);
    const conf1 = t.conf();
    const r1 = t.reload();
    t.m.refresh();
    assert.strictEqual(t.reload(), r1, 'ohne neues Zertifikat kein SIGHUP');
    const next = wildcard(80);
    t.vpnCert.set(next);
    t.m.refresh();
    assert.strictEqual(t.conf(), conf1, 'conf unverändert → der Wächter startet Mosquitto nicht neu');
    assert.notStrictEqual(t.reload(), r1, 'reload geändert → der Wächter schickt SIGHUP');
    assert.strictEqual(t.served(), next.cert);
    assert.strictEqual(t.m.status().tlsSha256, next.sha256);
  } finally { await t.cleanup(); }
});

test('Abruf schreibt gerade (Schlüssel passt nicht zum Fingerabdruck): das zuletzt geprüfte bleibt', async () => {
  const t = setup();
  try {
    const c = wildcard();
    t.vpnCert.set(c);
    await t.m.apply(ON);
    t.m.applyVpnCert(SWITCH);
    const other = wildcard();
    // neuer Fingerabdruck gemeldet, aber noch die alten Dateien
    t.vpnCert.st.cur = other;
    t.m.refresh();
    assert.strictEqual(t.m.status().tlsSha256, c.sha256);
    assert.strictEqual(t.served(), c.cert);
    assert.strictEqual(t.m.vpnTelemetry().state, 'active');
  } finally { await t.cleanup(); }
});

test('Fallback: Entzug, Ablauf und Schalter aus → wieder das selbst erzeugte, Tunnel-Listener weg, Gerätezertifikat nicht mehr in der Ablage', async () => {
  const t = setup();
  try {
    await t.m.apply(ON);
    const self = t.m.status().tlsSha256;
    const c = wildcard();
    t.vpnCert.set(c);
    t.m.applyVpnCert(SWITCH);
    assert.strictEqual(t.m.status().tlsSource, 'vpn-cert');
    // Weitergabe beendet (VpnCertManager löscht die Dateien und ruft onChange → refresh)
    t.vpnCert.set(null);
    t.m.refresh();
    assert.strictEqual(t.m.status().tlsSource, 'self');
    assert.strictEqual(t.m.status().tlsSha256, self, 'dasselbe selbst erzeugte wie vorher – gepinnte Geräte gehen wieder');
    assert.ok(!t.listeners().includes(`listener 8883 ${TUNNEL}`));
    assert.notStrictEqual(t.served(), c.cert);
    assert.ok(!fs.readFileSync(path.join(t.dir, 'tls', 'server.key'), 'utf8').includes(c.key.split('\n')[1]));
    assert.deepStrictEqual(t.m.vpnTelemetry(), { enabled: true, state: 'no_cert', host: null, tunnel: null });
    // abgelaufen
    t.vpnCert.set(wildcard(-1));
    t.m.refresh();
    assert.strictEqual(t.m.status().tlsSource, 'self');
    // wieder gültig, dann Schalter aus
    t.vpnCert.set(wildcard());
    t.m.refresh();
    assert.strictEqual(t.m.status().tlsSource, 'vpn-cert');
    t.m.applyVpnCert(undefined);
    assert.strictEqual(t.m.status().tlsSource, 'self');
    assert.strictEqual(t.m.status().tlsSha256, self);
    assert.deepStrictEqual(t.m.vpnTelemetry(), { enabled: false, state: 'off', host: null, tunnel: null });
  } finally { await t.cleanup(); }
});

test('TLS aus oder Broker aus: kein Schlüssel bleibt in der Ablage des Brokers', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    t.m.applyVpnCert(SWITCH);
    await t.m.apply({ ...ON, tls: false });
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls')));
    assert.ok(!/8883/.test(t.conf()));
    assert.strictEqual(t.m.vpnTelemetry().state, 'broker_off');
    await t.m.apply(ON);
    assert.strictEqual(t.m.status().tlsSource, 'vpn-cert');
    await t.m.apply({ ...ON, enabled: false });
    assert.ok(!fs.existsSync(path.join(t.dir, 'tls')), 'Broker aus: tls/ weg');
    assert.ok(!fs.existsSync(path.join(t.dir, 'enabled')));
    assert.strictEqual(t.m.vpnTelemetry().state, 'broker_off');
  } finally { await t.cleanup(); }
});

test('ohne Namen oder mit ungültigem Namen: kein Gerätezertifikat (no_name)', async () => {
  const t = setup();
  try {
    t.vpnCert.set(wildcard());
    await t.m.apply(ON);
    for (const f of [{ vpn_cert: true }, { vpn_cert: true, vpn_name: 'a.b' }, { vpn_cert: true, vpn_name: 'x\nlistener 1 0.0.0.0' }, { vpn_cert: 'yes', vpn_name: NAME }]) {
      t.m.applyVpnCert(f);
      assert.strictEqual(t.m.status().tlsSource, 'self', JSON.stringify(f));
      assert.ok(!/listener 1 /.test(t.conf()));
    }
    t.m.applyVpnCert({ vpn_cert: true });
    assert.strictEqual(t.m.vpnTelemetry().state, 'no_name');
  } finally { await t.cleanup(); }
});

test('ein Wildcard, das kein Bereich ist (oder Steuerzeichen enthält), wird nicht genommen', async () => {
  const t = setup();
  try {
    const c = wildcard();
    t.vpnCert.set(c);
    t.vpnCert.status = () => ({ state: 'ok', wildcard: '*.geraete.example.test\nlistener 1 0.0.0.0', fingerprint: c.sha256, notAfter: c.notAfter });
    await t.m.apply(ON);
    t.m.applyVpnCert(SWITCH);
    assert.strictEqual(t.m.status().tlsSource, 'self');
    assert.ok(!/listener 1 /.test(t.conf()));
  } finally { await t.cleanup(); }
});

test('Tunnel-Adresse fehlt oder Port 8883 hält eine TCP-Route: Gerätezertifikat im LAN, kein Listener am Tunnel (Mosquitto liefe sonst gar nicht)', async () => {
  for (const [opts, want] of [[{ tunnelUp: false }, 'no_address'], [{ portTaken: (p) => p === 8883 }, 'port_in_use']]) {
    const t = setup(opts);
    try {
      t.vpnCert.set(wildcard());
      await t.m.apply(ON);
      t.m.applyVpnCert(SWITCH);
      assert.deepStrictEqual(t.listeners(), ['listener 1883 127.0.0.1', 'listener 1883 192.168.1.10', 'listener 8883 192.168.1.10']);
      assert.strictEqual(t.m.status().tlsSource, 'vpn-cert');
      assert.strictEqual(t.m.vpnTelemetry().tunnel, want);
    } finally { await t.cleanup(); }
  }
});

test('ohne angebundenes Gerätezertifikat (Edge-Host, alte Compose-Datei): keine Capability, Schalter wirkungslos', async () => {
  const dir = tmp('gc-mqtt-');
  try {
    const m = new MqttManager({ dir, tlsDir: path.join(dir, 'own'), logger: quiet, getLanAddrs: () => ['192.168.1.10'], clientFactory: () => new FakeClient() });
    assert.strictEqual(m.vpnCertSupported(), false);
    await m.apply(ON);
    m.applyVpnCert(SWITCH);
    assert.strictEqual(m.status().tlsSource, 'self');
    await m.stop();
    const g = new MqttManager({ dir, logger: quiet, getLanAddrs: () => [] });
    g.attachVpnCert({ vpnCert: fakeVpnCert(dir), tunnelIp: TUNNEL });
    assert.strictEqual(g.vpnCertSupported(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildConf: Tunnel-Adresse nur mit dem Gerätezertifikat; hasLocalAddress', () => {
  const tlsFiles = { certfile: '/x/tls/server.crt', keyfile: '/x/tls/server.key', sha256: 'ab', source: 'self', extraAddrs: [] };
  assert.ok(!broker.buildConf({ dir: '/x', listenAddrs: ['192.168.1.10'], tls: tlsFiles }).includes(TUNNEL));
  const conf = broker.buildConf({ dir: '/x', listenAddrs: ['192.168.1.10'], tls: { ...tlsFiles, source: 'vpn-cert', wildcard: WILDCARD, extraAddrs: [TUNNEL, 'kein-ip'] } });
  assert.match(conf, new RegExp(`^listener 8883 ${TUNNEL.replace(/\./g, '\\.')}$`, 'm'));
  assert.ok(!conf.includes('kein-ip'));
  assert.ok(!/^listener 1883 10\.8/m.test(conf), '1883 nie am Tunnel');
  assert.strictEqual(hasLocalAddress('10.8.0.7', { wg0: [{ family: 'IPv4', address: '10.8.0.7' }] }), true);
  assert.strictEqual(hasLocalAddress('10.8.0.7', { eth0: [{ family: 'IPv4', address: '192.168.1.10' }] }), false);
  assert.strictEqual(hasLocalAddress(null), false);
});
