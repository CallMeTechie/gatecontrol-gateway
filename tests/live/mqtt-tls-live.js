#!/usr/bin/env node
'use strict';

// Live-Test des MQTT-Brokers mit TLS gegen einen echten Mosquitto – als root
// ausführen (CI-Job mqtt-tls, lokal: sudo node tests/live/mqtt-tls-live.js;
// MOSQUITTO=/pfad/zu/mosquitto, sonst der aus dem PATH).
//
// Nachgestellt wird die neue Compose-Datei (docs/edge.md „MQTT“):
//   /gc-mqtt-conf  Ablage des Gateways, root:61001, 2750 – der MqttManager schreibt
//                  mosquitto.conf/passwd/acl (0640) und tls/server.crt + server.key
//   /gc-mqtt       Volume des Brokers, 61001 – der Wächter kopiert conf/passwd/acl (0600)
//   Mosquitto      läuft als 61001:61001 und liest Zertifikat und Schlüssel
//                  direkt aus der Ablage des Gateways (nur über die Gruppe)
// Geprüft:
//   1. Port 8883 spricht TLS mit genau dem Zertifikat, dessen Fingerabdruck der Status meldet;
//   2. ein Konto meldet sich über TLS an, ein falsches Passwort nicht;
//   3. Port 1883 läuft daneben weiter;
//   4. TLS aus → nach dem Neustart des Brokers ist 8883 zu, 1883 läuft;
//   5. Gerätezertifikat (features.mqtt_tls.vpn_cert): 8883 auch an der Tunnel-Adresse, Kette
//      und Name mqtt-<gateway>.<Bereich> gelten; Erneuerung nur per SIGHUP – eine bestehende
//      Verbindung bleibt, neue sehen das neue Zertifikat; aus → wieder das selbst erzeugte.
//   6. Zweiter Port (features.mqtt_tls.fingerprint_port): neben dem Gerätezertifikat auf 8883
//      lauscht 8884 mit dem selbst erzeugten – derselbe Fingerabdruck wie vorher auf 8883, an
//      LAN- und Tunnel-Adresse; eine Erneuerung auf 8883 (SIGHUP) lässt eine Verbindung auf
//      8884 offen; Unterschalter aus → 8884 zu, tls-self/ entfernt.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');
const { MqttManager } = require('../../src/edge/mqtt/manager');
const { hashPassword, PORT, TLS_PORT, TLS_FP_PORT } = require('../../src/edge/mqtt/broker');
const { makeSelfSigned } = require('../../src/cache/selfsigned');

const UID = 61001;
const LAN = '127.0.0.2'; // steht für die LAN-Adresse des Gateways
const TUNNEL = '127.0.0.3'; // steht für die Tunnel-Adresse
const AREA = 'geraete.vpn.example.test';
const VPN_HOST = `mqtt-gw-live.${AREA}`;
const MOSQUITTO = process.env.MOSQUITTO || 'mosquitto';
const quiet = { info() {}, warn(...a) { console.log('warn:', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))); }, debug() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** MQTT 3.1.1 CONNECT → Rückgabecode des CONNACK (0 = angenommen). */
function connack(socket, { username, password }) {
  const str = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
  const body = Buffer.concat([str('MQTT'), Buffer.from([4, 0xc2, 0, 30]), str(`live-${process.pid}-${Date.now()}`), str(username), str(password)]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no CONNACK')), 5000);
    socket.once('data', (d) => { clearTimeout(t); resolve(d[0] === 0x20 ? d[3] : -1); });
    socket.once('error', (e) => { clearTimeout(t); reject(e); });
    socket.write(Buffer.concat([Buffer.from([0x10, body.length]), body]));
  });
}

function plain(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: LAN, port }, () => resolve(s));
    s.once('error', reject);
  });
}

/** TLS wie ein Gerät, das den Fingerabdruck hinterlegt hat: verbunden wird nur mit genau diesem Zertifikat. */
function pinned(port, sha256, host = LAN) {
  return new Promise((resolve, reject) => {
    // die Kettenprüfung ersetzt hier der Fingerabdruck (checkServerIdentity läuft nur nach bestandener Kette,
    // deshalb das Zertifikat selbst als Vertrauensanker – wie „eigenes Zertifikat“ im Gerät)
    const s = tls.connect({ host, port, ca: [sha256.cert], checkServerIdentity: (_h, cert) => {
      const seen = cert.fingerprint256.replace(/:/g, '').toLowerCase();
      return seen === sha256.hex ? undefined : new Error(`fingerprint ${seen} is not the reported ${sha256.hex}`);
    } }, () => resolve(s));
    s.once('error', reject);
  });
}

/** TLS wie ein Client im VPN: Kette (hier: das Testzertifikat als CA) und Name werden voll geprüft. */
function named(host, ca) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: TLS_PORT, ca: [ca], servername: VPN_HOST }, () => resolve(s));
    s.once('error', reject);
  });
}
/** Nimmt `host:port` eine Verbindung an? (sofort wieder zu) */
function tcp(host, port) {
  return new Promise((resolve, reject) => { const x = net.connect({ host, port }, () => { x.destroy(); resolve(); }); x.once('error', reject); });
}
const fpOf = (s) => s.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase();

/** MQTT PINGREQ → PINGRESP: lebt die Verbindung noch? */
function ping(socket) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no PINGRESP')), 5000);
    socket.once('data', (d) => { clearTimeout(t); resolve(d[0] === 0xd0); });
    socket.once('error', (e) => { clearTimeout(t); reject(e); });
    socket.write(Buffer.from([0xc0, 0]));
  });
}

/** Das Gerätezertifikat (*.geraete.<zone>) wie es VpnCertManager ablegt. */
function deviceCert(dir) {
  const st = { cur: null };
  return {
    set() {
      const c = makeSelfSigned({ commonName: `*.${AREA}`, days: 90, altNames: [{ dns: `*.${AREA}` }] });
      st.cur = { ...c, notAfter: new Date(Date.now() + 90 * 86_400_000).toISOString() };
      fs.writeFileSync(path.join(dir, 'fullchain.pem'), c.cert, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'privkey.pem'), c.key, { mode: 0o600 });
      return st.cur;
    },
    status: () => (st.cur ? { state: 'ok', wildcard: `*.${AREA}`, fingerprint: st.cur.sha256, notAfter: st.cur.notAfter } : null),
    files: () => (st.cur ? { dir, cert: path.join(dir, 'fullchain.pem'), key: path.join(dir, 'privkey.pem') } : null),
  };
}

async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (e) { if (Date.now() > end) throw new Error(`${what}: ${e.message}`); }
    await wait(100);
  }
}

async function main() {
  if (process.getuid() !== 0) { console.error('needs root (files of gid 61001, Mosquitto as uid 61001)'); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mqtt-live-'));
  fs.chmodSync(tmp, 0o755);
  const conf = path.join(tmp, 'gc-mqtt-conf');
  const vol = path.join(tmp, 'gc-mqtt');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(conf); fs.chownSync(conf, 0, UID); fs.chmodSync(conf, 0o2750);
  fs.mkdirSync(vol); fs.chownSync(vol, UID, UID); fs.chmodSync(vol, 0o700);
  fs.mkdirSync(state, { mode: 0o700 });
  const as = { uid: UID, gid: UID };
  // der Wächter des Dienstes mqtt (docker-compose.example.yml): conf/passwd/acl kopieren, data/ anlegen
  const take = () => {
    const r = spawnSync('sh', ['-c', 'mkdir -p "$C/data"; for f in mosquitto.conf passwd acl; do cp "$G/$f" "$C/.$f" && chmod 600 "$C/.$f" && mv -f "$C/.$f" "$C/$f" || exit 1; done'],
      { ...as, env: { G: conf, C: vol, PATH: process.env.PATH }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `take: ${r.stderr}`);
  };
  let proc = null;
  let out = '';
  const start = () => {
    out = '';
    proc = spawn(MOSQUITTO, ['-c', path.join(vol, 'mosquitto.conf')], { ...as, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
  };
  const stop = () => new Promise((resolve) => { if (!proc || proc.exitCode !== null) return resolve(); proc.once('exit', resolve); proc.kill('SIGTERM'); });

  const m = new MqttManager({ dir: conf, brokerDir: vol, tlsDir: path.join(state, 'mqtt-tls'), logger: quiet, hostname: 'gw-live', getLanAddrs: () => [LAN], retryMs: 500 });
  // Hashes wie vom Server (101 Runden, 12 Byte Salz): die liest jeder Mosquitto ab 2.0 – der aus dem
  // Paket des CI-Runners (2.0.x) genauso wie der gepinnte 2.1 der Compose-Datei
  const hash = (pw) => hashPassword(pw, { iterations: 101, salt: crypto.randomBytes(12) });
  m.internalHash = hash(m.password);
  const account = { user: 'shelly-kueche', hash: hash('geheim-123'), acl: [{ access: 'readwrite', topic: 'shellies/#' }] };
  try {
    await m.apply({ enabled: true, tls: true, accounts: [account], pluginTopics: {} });
    assert.strictEqual(fs.statSync(path.join(conf, 'tls', 'server.key')).gid, UID, 'the key belongs to the group of the broker (setgid of the store)');
    assert.strictEqual(fs.statSync(path.join(conf, 'tls', 'server.key')).mode & 0o777, 0o640);
    take();
    start();
    const st = await until(async () => { const s = m.status(); assert.ok(s.running, 'internal account not connected'); return s; }, 'broker did not start');
    assert.strictEqual(st.tls, 'on');
    console.log('broker runs, TLS on, fingerprint', st.tlsSha256);

    // 1 + 2: TLS mit dem gemeldeten Zertifikat, Anmeldung eines Kontos
    const pin = { hex: st.tlsSha256, cert: st.tlsCert };
    let s = await until(() => pinned(TLS_PORT, pin), 'port 8883');
    assert.strictEqual(s.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase(), st.tlsSha256);
    assert.strictEqual(await connack(s, { username: 'shelly-kueche', password: 'geheim-123' }), 0, 'account accepted over TLS');
    s.destroy();
    s = await pinned(TLS_PORT, pin);
    assert.notStrictEqual(await connack(s, { username: 'shelly-kueche', password: 'falsch' }), 0, 'wrong password refused over TLS');
    s.destroy();
    await assert.rejects(pinned(TLS_PORT, { hex: '00'.repeat(32), cert: st.tlsCert }), /fingerprint/, 'another fingerprint does not connect');
    console.log('8883: TLS with the reported certificate, account accepted, wrong password refused');

    // 3: der unverschlüsselte Port bleibt
    s = await plain(PORT);
    assert.strictEqual(await connack(s, { username: 'shelly-kueche', password: 'geheim-123' }), 0, 'port 1883 keeps working');
    s.destroy();
    console.log('1883: still open next to 8883');

    // 4: TLS aus → mosquitto.conf ändert sich → der Wächter startet den Broker neu
    const before = fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8');
    await m.apply({ enabled: true, tls: false, accounts: [account], pluginTopics: {} });
    assert.notStrictEqual(fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(conf, 'tls')), 'the key leaves the store of the broker');
    await stop();
    take();
    start();
    s = await until(() => plain(PORT), 'port 1883 after the restart');
    assert.strictEqual(await connack(s, { username: 'shelly-kueche', password: 'geheim-123' }), 0);
    s.destroy();
    await assert.rejects(plain(TLS_PORT), /ECONNREFUSED/, 'port 8883 is closed without TLS');
    console.log('TLS off: 8883 closed, 1883 runs');

    // wieder an: dasselbe Zertifikat (State-Verzeichnis)
    await m.apply({ enabled: true, tls: true, accounts: [account], pluginTopics: {} });
    assert.strictEqual(m.status().tlsSha256, st.tlsSha256, 'the certificate stays the same');
    await stop();
    take();
    start();
    await until(() => pinned(TLS_PORT, pin).then((x) => x.destroy()), 'port 8883 after TLS on again');

    // 5: Gerätezertifikat – Schalter an
    const certDir = path.join(state, 'vpn-cert');
    fs.mkdirSync(certDir, { mode: 0o700 });
    const dev = deviceCert(certDir);
    const c1 = dev.set();
    m.attachVpnCert({ vpnCert: dev, tunnelIp: TUNNEL, hasAddr: (ip) => ip === TUNNEL });
    const confSelf = fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8');
    m.applyVpnCert({ vpn_cert: true, vpn_name: 'mqtt-gw-live' });
    const confVpn = fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8');
    assert.notStrictEqual(confVpn, confSelf, 'new listener at the tunnel address → the watcher restarts the broker');
    assert.strictEqual(m.status().tlsSource, 'vpn-cert');
    assert.strictEqual(m.status().tlsHost, VPN_HOST);
    await stop();
    take();
    start();
    s = await until(() => named(TUNNEL, c1.cert), 'port 8883 at the tunnel address');
    assert.strictEqual(fpOf(s), c1.sha256);
    assert.strictEqual(await connack(s, { username: 'shelly-kueche', password: 'geheim-123' }), 0, 'account accepted over the device certificate');
    const kept = s; // bleibt über die Erneuerung offen
    s = await named(LAN, c1.cert);
    assert.strictEqual(fpOf(s), c1.sha256, 'the LAN listener has the device certificate as well');
    s.destroy();
    await assert.rejects(tcp(TUNNEL, PORT), /ECONNREFUSED/, 'port 1883 never at the tunnel address');
    console.log('device certificate: 8883 at LAN and tunnel address, chain and name valid');

    // Erneuerung: nur die Dateien und reload → der Wächter schickt SIGHUP
    const r1 = fs.readFileSync(path.join(conf, 'reload'), 'utf8');
    const c2 = dev.set();
    m.refresh();
    assert.strictEqual(fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8'), confVpn, 'renewal: mosquitto.conf unchanged (no restart)');
    assert.notStrictEqual(fs.readFileSync(path.join(conf, 'reload'), 'utf8'), r1, 'renewal: reload changed (SIGHUP)');
    take();
    proc.kill('SIGHUP');
    await until(async () => { const x = await named(TUNNEL, c2.cert); const fp = fpOf(x); x.destroy(); assert.strictEqual(fp, c2.sha256); }, 'new certificate after SIGHUP');
    assert.strictEqual(await ping(kept), true, 'the connection opened before the renewal is still up');
    kept.destroy();
    console.log('renewal: SIGHUP, new connections see the new certificate, the open one stays');

    // 6: zweiter Port 8884 mit dem selbst erzeugten neben dem Gerätezertifikat
    m.applyVpnCert({ vpn_cert: true, vpn_name: 'mqtt-gw-live', fingerprint_port: true });
    const confFp = fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8');
    assert.notStrictEqual(confFp, confVpn, 'new listener 8884 → the watcher restarts the broker');
    assert.strictEqual(fs.statSync(path.join(conf, 'tls-self', 'server.key')).gid, UID, 'the key of 8884 belongs to the group of the broker');
    assert.strictEqual(fs.statSync(path.join(conf, 'tls-self', 'server.key')).mode & 0o777, 0o640);
    assert.deepStrictEqual(m.status().tlsFp, { port: TLS_FP_PORT, sha256: st.tlsSha256, cert: st.tlsCert }, '8884 reports the fingerprint 8883 had before');
    await stop();
    take();
    start();
    s = await until(() => pinned(TLS_FP_PORT, pin), 'port 8884 with the self-made certificate');
    assert.strictEqual(fpOf(s), st.tlsSha256, '8884 serves the old fingerprint');
    assert.strictEqual(await connack(s, { username: 'shelly-kueche', password: 'geheim-123' }), 0, 'account accepted on 8884');
    const keptFp = s; // bleibt über die Erneuerung auf 8883 offen
    s = await pinned(TLS_FP_PORT, pin, TUNNEL);
    assert.strictEqual(fpOf(s), st.tlsSha256, '8884 at the tunnel address as well');
    s.destroy();
    s = await named(TUNNEL, c2.cert);
    assert.strictEqual(fpOf(s), c2.sha256, '8883 keeps the device certificate');
    s.destroy();
    await assert.rejects(tcp(TUNNEL, PORT), /ECONNREFUSED/, 'port 1883 never at the tunnel address');
    console.log('fingerprint port: 8883 device certificate, 8884 the self-made one with the old fingerprint');

    // Erneuerung auf 8883: nur SIGHUP – die Verbindung auf 8884 bleibt, 8884 behält den Fingerabdruck
    const r2 = fs.readFileSync(path.join(conf, 'reload'), 'utf8');
    const c3 = dev.set();
    m.refresh();
    assert.strictEqual(fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8'), confFp, 'renewal: mosquitto.conf unchanged');
    assert.notStrictEqual(fs.readFileSync(path.join(conf, 'reload'), 'utf8'), r2);
    take();
    proc.kill('SIGHUP');
    await until(async () => { const x = await named(TUNNEL, c3.cert); const fp = fpOf(x); x.destroy(); assert.strictEqual(fp, c3.sha256); }, 'renewed certificate on 8883');
    assert.strictEqual(await ping(keptFp), true, 'the connection on 8884 stays open over the renewal on 8883');
    keptFp.destroy();
    s = await pinned(TLS_FP_PORT, pin);
    assert.strictEqual(fpOf(s), st.tlsSha256, '8884 keeps its fingerprint over the renewal');
    s.destroy();
    console.log('renewal on 8883: connection on 8884 stays, fingerprint of 8884 unchanged');

    // Unterschalter aus → 8884 zu, die Dateien gehen
    m.applyVpnCert({ vpn_cert: true, vpn_name: 'mqtt-gw-live' });
    assert.strictEqual(fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8'), confVpn, 'without the sub-switch exactly as before');
    assert.ok(!fs.existsSync(path.join(conf, 'tls-self')), 'the key of 8884 leaves the store');
    await stop();
    take();
    start();
    await until(() => named(TUNNEL, c3.cert).then((x) => x.destroy()), 'port 8883 after the restart');
    await assert.rejects(tcp(LAN, TLS_FP_PORT), /ECONNREFUSED/, 'port 8884 closed without the sub-switch');
    console.log('sub-switch off: 8884 closed');

    // Schalter aus → wieder das selbst erzeugte
    m.applyVpnCert(undefined);
    assert.strictEqual(m.status().tlsSource, 'self');
    assert.strictEqual(m.status().tlsSha256, st.tlsSha256);
    assert.strictEqual(fs.readFileSync(path.join(conf, 'mosquitto.conf'), 'utf8'), confSelf);
    await stop();
    take();
    start();
    s = await until(() => pinned(TLS_PORT, pin), 'self-made certificate again');
    s.destroy();
    await assert.rejects(tcp(TUNNEL, TLS_PORT), /ECONNREFUSED/, 'no listener at the tunnel address without the device certificate');
    console.log('switch off: self-made certificate again, tunnel listener gone');
    console.log('OK');
  } catch (e) {
    console.error('mosquitto output:\n' + out);
    throw e;
  } finally {
    await m.stop();
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
