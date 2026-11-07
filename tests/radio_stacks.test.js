'use strict';

// Funk, zweiter Teil (docs/radio.md): zigbee2mqtt (Steuerdatei, Konto am Broker,
// Geräteliste aus einer bridge/devices-Aufnahme, Anlernen, Schalten), Thread
// (Border Router mit einem REST-Stub: Netz anlegen, beitreten, Datensatz),
// verschlüsselte Bluetooth-Sensoren mit veröffentlichten Testvektoren
// (bthome-ble und xiaomi-ble), Schlüsselablage, Stick-Zuteilung und Routen.
// Echte Sticks und Sensoren gibt es hier nicht – alles mit Attrappen.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const EventEmitter = require('node:events');
const { createApiServer } = require('../src/api/server');
const { createFeaturesRouter } = require('../src/api/routes/features');

const { detect, classify } = require('../src/radio/detect');
const { parseAdvert } = require('../src/radio/bleparse');
const { decryptBthome, decryptMibeacon, mibeaconValues } = require('../src/radio/blecrypto');
const { BleKeyStore, parse: parseKeys } = require('../src/radio/blekeys');
const { Zigbee2Mqtt, summarize, valuesOf, setPayload, deviceOf, macOfIeee, ieeeOf, USER } = require('../src/radio/z2m');
const { ThreadBorderRouter, createOtbrClient, networkOf } = require('../src/radio/thread');
const { RadioService, assignSticks } = require('../src/radio/radio');
const { BleScanner } = require('../src/radio/ble');
const { MqttManager } = require('../src/edge/mqtt/manager');
const { makeSysfs, CONBEE2, ZBT1 } = require('./helpers/fakeSysfs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DEVICES = fs.readFileSync(path.join(__dirname, 'fixtures', 'radio', 'z2m-bridge-devices.json'));
const ZBDONGLE_E = { port: '1-1.4', vid: '1a86', pid: '55d4', manufacturer: 'ITEAD', product: 'SONOFF Zigbee 3.0 USB Dongle Plus V2', tty: 'ttyACM1', dev: '166:1' };
const ZBDONGLE_P = { port: '1-1.5', vid: '10c4', pid: 'ea60', manufacturer: 'ITEAD', product: 'Sonoff Zigbee 3.0 USB Dongle Plus', tty: 'ttyUSB1', dev: '188:1' };
const NRF = { port: '1-1.6', vid: '1915', pid: 'cafe', manufacturer: 'Nordic Semiconductor', product: 'nRF528xx OpenThread Device', tty: 'ttyACM2', dev: '166:2' };

// Service-Daten eines Werbepakets: Flags, 16-bit-Service-Daten (UUID LE + Nutzlast)
function adv(uuid, payload) {
  const p = Buffer.from(payload);
  return Buffer.concat([Buffer.from([2, 0x01, 0x06, p.length + 3, 0x16, uuid & 0xff, uuid >> 8]), p]);
}

// ─── Erkennung: welcher Stack passt ─────────────────────────────────────

describe('radio: sticks for zigbee2mqtt and Thread', () => {
  it('classify: adapter for zigbee2mqtt and RCP ability', () => {
    assert.deepEqual(pickK(classify({ vid: '1a86', pid: '55d4', product: 'SONOFF Zigbee 3.0 USB Dongle Plus V2' })), { z2m: 'ember', thread: true, deconz: false });
    assert.deepEqual(pickK(classify({ vid: '10c4', pid: 'ea60', product: 'Sonoff Zigbee 3.0 USB Dongle Plus' })), { z2m: 'zstack', thread: false, deconz: false });
    assert.deepEqual(pickK(classify({ vid: '10c4', pid: 'ea60', product: 'SkyConnect v1.0' })), { z2m: 'ember', thread: true, deconz: false });
    assert.deepEqual(pickK(classify({ vid: '1cf1', pid: '0030', product: 'ConBee II' })), { z2m: 'deconz', thread: false, deconz: true });
    assert.equal(classify({ vid: '0451', pid: '16a8' }).z2m, 'zstack');
    assert.equal(classify({ vid: '10c4', pid: 'ea60', product: 'slae.sh cc2652rb stick - slaesh\'s iot stuff' }).z2m, 'zstack');
  });
  function pickK(k) { return { z2m: k.z2m || null, thread: k.thread === true, deconz: k.deconz === true }; }

  it('one stick serves one radio: Zigbee first, Thread takes another one or reports busy', () => {
    const sticks = detect({ sysRoot: makeSysfs({ usb: [ZBDONGLE_E, ZBT1] }) }).sticks;
    const a = assignSticks(sticks, { z2m: true, thread: true, deconzStick: null });
    assert.equal(a.z2mStick.model, 'Sonoff ZBDongle-E');
    assert.equal(a.threadStick.model, 'Home Assistant Connect ZBT-1');
    const one = detect({ sysRoot: makeSysfs({ usb: [ZBT1] }) }).sticks;
    const b = assignSticks(one, { z2m: true, thread: true, deconzStick: null });
    assert.equal(b.z2mStick.model, 'Home Assistant Connect ZBT-1');
    assert.equal(b.threadStick, null);
    assert.equal(b.threadBusy, true);
    // ein reiner Thread-Stick geht vor; ein reiner Zigbee-Stick (CC2652P) vor einem Multi-Stick
    const mix = detect({ sysRoot: makeSysfs({ usb: [ZBT1, ZBDONGLE_P, NRF] }) }).sticks;
    const c = assignSticks(mix, { z2m: true, thread: true, deconzStick: null });
    assert.equal(c.z2mStick.model, 'Sonoff ZBDongle-P');
    assert.equal(c.threadStick.model, 'nRF52840 (OpenThread)');
  });
});

// ─── MQTT-Broker: eigene Konten und Abos des Gateways ───────────────────

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; this.subs = []; this.unsubs = []; this.pubs = []; }
  async connect() { this.connected = true; }
  async subscribe(f) { this.subs.push(f); return 1; }
  async unsubscribe(f) { this.unsubs.push(f); }
  async publish(t, p, o) { this.pubs.push([t, p.toString(), o]); }
  end() { this.connected = false; }
}

describe('radio: MQTT broker for zigbee2mqtt', () => {
  it('local account and topics: own account wins over a server account of the same name; local subscribe/publish', async () => {
    const dir = tmp('gc-mqtt-');
    const fake = new FakeClient();
    const m = new MqttManager({ dir, getLanAddrs: () => ['192.168.1.10'], clientFactory: () => fake });
    try {
      await m.apply({ enabled: true, tls: false, accounts: [{ user: USER, hash: '$7$1$evil$evil', acl: [{ access: 'readwrite', topic: '#' }] }], pluginTopics: {} });
      await new Promise((r) => setImmediate(r));
      m.setLocal({ accounts: [{ user: USER, hash: '$7$1$own$own', acl: [{ access: 'readwrite', topic: 'zigbee2mqtt/#' }] }], topics: ['zigbee2mqtt/#'] });
      const passwd = fs.readFileSync(path.join(dir, 'passwd'), 'utf8');
      assert.match(passwd, /gc-zigbee2mqtt:\$7\$1\$own\$own/);
      assert.doesNotMatch(passwd, /evil/);
      assert.match(fs.readFileSync(path.join(dir, 'acl'), 'utf8'), /user gc-edge[\s\S]*topic readwrite zigbee2mqtt\/#/);
      const got = [];
      const off = m.localSubscribe('zigbee2mqtt/#', (t, p) => got.push([t, p.toString()]));
      assert.ok(fake.subs.includes('zigbee2mqtt/#'));
      fake.emit('message', 'zigbee2mqtt/bridge/state', Buffer.from('online'), { qos: 0, retain: true });
      assert.deepEqual(got, [['zigbee2mqtt/bridge/state', 'online']]);
      await m.localPublish('zigbee2mqtt/bridge/request/permit_join', '{"time":60}');
      assert.deepEqual(fake.pubs.at(-1), ['zigbee2mqtt/bridge/request/permit_join', '{"time":60}', { qos: 0, retain: false }]);
      await assert.rejects(m.localPublish('shellies/x', 'no'), (e) => e.code === 'denied');
      assert.throws(() => m.localSubscribe('#', () => {}), (e) => e.code === 'denied');
      off();
      assert.deepEqual(fake.unsubs, ['zigbee2mqtt/#']);
      assert.equal(m.brokerEnabled(), true);
      m.setLocal({ accounts: [], topics: [] });
      assert.doesNotMatch(fs.readFileSync(path.join(dir, 'passwd'), 'utf8'), /own/);
      assert.match(fs.readFileSync(path.join(dir, 'mosquitto.conf'), 'utf8'), /^max_packet_size 4194304$/m, 'big enough for bridge/devices');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── zigbee2mqtt ─────────────────────────────────────────────────────────

/** Eine Attrappe des MqttManager (nur was z2m.js braucht). */
function fakeMqtt({ enabled = true, available = true } = {}) {
  const st = { local: null, handlers: [], pubs: [], enabled, available, ready: true };
  return {
    st,
    available: () => st.available,
    brokerEnabled: () => st.available && st.enabled,
    localReady: () => st.ready,
    setLocal: (l) => { st.local = l; },
    localSubscribe: (f, fn) => { st.handlers.push(fn); return () => { st.handlers = st.handlers.filter((x) => x !== fn); }; },
    localPublish: async (t, p) => { st.pubs.push([t, JSON.parse(p.toString())]); },
    emit: (t, p) => st.handlers.forEach((fn) => fn(t, Buffer.from(typeof p === 'string' ? p : JSON.stringify(p)))),
  };
}

describe('radio: zigbee2mqtt', () => {
  let ctl; let state; let clock; let stick;
  beforeEach(() => {
    ctl = tmp('gc-ctl-'); state = tmp('gc-st-'); clock = 1_800_000_000_000;
    stick = detect({ sysRoot: makeSysfs({ usb: [ZBDONGLE_E] }) }).sticks[0];
  });
  afterEach(() => { fs.rmSync(ctl, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  const alive = (s = 'running ttyACM1') => fs.writeFileSync(path.join(ctl, 'z2m.state'), `${s} ${Math.floor(clock / 1000)}\n`);

  it('switched on: own broker account (password kept in /state, 0600), z2m.env for the watcher; off removes both', () => {
    const mq = fakeMqtt();
    const z = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    z.attach(mq);
    z.apply({ want: true, stick });
    const env = fs.readFileSync(path.join(ctl, 'z2m.env'), 'utf8');
    assert.match(env, /^DEVICE=ttyACM1\nDEV=166:1\nADAPTER=ember\nBAUD=0\nMQTT_USER=gc-zigbee2mqtt\nMQTT_PASS=[A-Za-z0-9_-]{32}\n$/);
    assert.equal(fs.statSync(path.join(ctl, 'z2m.env')).mode & 0o777, 0o600);
    const acc = JSON.parse(fs.readFileSync(path.join(state, 'radio-z2m.json'), 'utf8'));
    assert.equal(fs.statSync(path.join(state, 'radio-z2m.json')).mode & 0o777, 0o600);
    assert.ok(env.includes(acc.password));
    assert.deepEqual(mq.st.local.topics, ['zigbee2mqtt/#']);
    assert.deepEqual(mq.st.local.accounts[0].acl, [{ access: 'readwrite', topic: 'zigbee2mqtt/#' }]);
    assert.equal(mq.st.local.accounts[0].hash, acc.hash);
    // ein neuer Start nimmt dasselbe Konto
    const z2 = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    z2.attach(fakeMqtt());
    z2.apply({ want: true, stick });
    assert.equal(fs.readFileSync(path.join(ctl, 'z2m.env'), 'utf8'), env);
    z.apply({ want: false, stick });
    assert.ok(!fs.existsSync(path.join(ctl, 'z2m.env')));
    assert.deepEqual(mq.st.local, { accounts: [], topics: [] });
  });

  it('without the broker: mqtt_off / mqtt_missing and no z2m.env (zigbee2mqtt would only fail)', () => {
    const z = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    z.attach(fakeMqtt({ enabled: false }));
    z.apply({ want: true, stick });
    assert.equal(z.state(), 'mqtt_off');
    assert.ok(!fs.existsSync(path.join(ctl, 'z2m.env')));
    const y = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    y.apply({ want: true, stick });
    assert.equal(y.state(), 'mqtt_missing');
    const n = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    n.attach(fakeMqtt());
    n.apply({ want: true, stick: null });
    assert.equal(n.state(), 'no_stick');
  });

  it('bridge/devices of a real installation → devices with kind and capabilities; states; telemetry; report', async () => {
    const mq = fakeMqtt();
    const posts = [];
    const z = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock, reporter: { post: async (p, b) => { posts.push([p, b]); return { ok: true, status: 200 }; } } });
    z.attach(mq);
    z.apply({ want: true, stick });
    alive();
    assert.equal(z.state(), 'starting');
    mq.emit('zigbee2mqtt/bridge/state', { state: 'online' });
    mq.emit('zigbee2mqtt/bridge/info', { version: '2.14.2', coordinator: { type: 'EmberZNet', meta: { revision: '7.4.4.0' } }, network: { channel: 15, pan_id: 6754 }, permit_join: false, config: { advanced: { network_key: [1, 2, 3] } } });
    mq.emit('zigbee2mqtt/bridge/devices', DEVICES.toString());
    assert.equal(z.state(), 'running');
    const list = z.list();
    assert.deepEqual(list.map((d) => [d.name, d.kind]), [['0xa4c138aabbccddee', 'other'], ['Bad Klima', 'sensor'], ['Haustür', 'sensor'], ['Steckdose Kaffee', 'plug'], ['Wohnzimmer/Decke', 'light']]);
    const bulb = list.find((d) => d.kind === 'light');
    assert.deepEqual(bulb.caps, { bri: true, ct: true, color: 'xy' });
    assert.equal(bulb.ieee, '00:17:88:01:0b:2c:3d:4e');
    assert.equal(list[0].supported, false);
    assert.equal(list[0].interview, 'running');
    // Zustände – auch mit „/“ im Namen; eigene /set-Nachrichten zählen nicht
    mq.emit('zigbee2mqtt/Wohnzimmer/Decke', { state: 'ON', brightness: 127, color_temp: 370, linkquality: 120 });
    mq.emit('zigbee2mqtt/Wohnzimmer/Decke/set', { state: 'OFF' });
    mq.emit('zigbee2mqtt/Haustür', { contact: false, battery: 91 });
    mq.emit('zigbee2mqtt/Bad Klima', { temperature: 21.37, humidity: 55.1, pressure: 1003, battery: 100 });
    mq.emit('zigbee2mqtt/Bad Klima/availability', { state: 'offline' });
    const by = Object.fromEntries(z.list().map((d) => [d.name, d]));
    assert.deepEqual(by['Wohnzimmer/Decke'].values, { on: true, bri: 50, ct: 370, linkquality: 120 });
    assert.deepEqual(by['Haustür'].values, { battery: 91, opening: true });
    assert.equal(by['Bad Klima'].available, false);
    const t = z.telemetry();
    assert.deepEqual({ state: t.state, devices: t.devices, channel: t.channel, version: t.version, adapter: t.adapter, firmware: t.firmware }, { state: 'running', devices: 5, channel: 15, version: '2.14.2', adapter: 'ember', firmware: '7.4.4.0' });
    assert.doesNotMatch(JSON.stringify(t), /network_key/);
    await z.report(true);
    assert.equal(posts[0][0], '/api/v1/gateway/radio/zigbee');
    assert.equal(posts[0][1].stack, 'zigbee2mqtt');
    assert.equal(posts[0][1].devices.length, 5);
    z.stop();
  });

  it('pairing, events, remove, set (only known devices, only what they can)', async () => {
    const mq = fakeMqtt();
    const z = new Zigbee2Mqtt({ stateDir: state, ctlDir: ctl, now: () => clock });
    z.attach(mq);
    z.apply({ want: true, stick });
    assert.equal(await z.pair(120), 'not_running');
    mq.emit('zigbee2mqtt/bridge/state', 'online');
    mq.emit('zigbee2mqtt/bridge/devices', DEVICES.toString());
    assert.equal(await z.pair(120), 'accepted');
    assert.deepEqual(mq.st.pubs.at(-1), ['zigbee2mqtt/bridge/request/permit_join', { time: 120 }]);
    assert.ok(z.pairing());
    mq.emit('zigbee2mqtt/bridge/event', { type: 'device_joined', data: { ieee_address: '0x0017880100aabbcc', friendly_name: '0x0017880100aabbcc' } });
    mq.emit('zigbee2mqtt/bridge/event', { type: 'device_interview', data: { ieee_address: '0x0017880100aabbcc', status: 'successful', friendly_name: '0x0017880100aabbcc', definition: { model: '8718699673147', vendor: 'Philips' } } });
    const rec = z.telemetry().recent;
    assert.equal(rec.length, 1);
    assert.deepEqual({ mac: rec[0].mac, model: rec[0].model, manufacturer: rec[0].manufacturer }, { mac: '00:17:88:01:00:aa:bb:cc', model: '8718699673147', manufacturer: 'Philips' });
    assert.equal(await z.remove('00:00:00:00:00:00:00:01'), 'not_found');
    assert.equal(await z.remove('00:0d:6f:ff:fe:1a:2b:3c'), 'accepted');
    assert.deepEqual(mq.st.pubs.at(-1), ['zigbee2mqtt/bridge/request/device/remove', { id: '0x000d6ffffe1a2b3c', force: false }]);
    assert.equal(await z.set('0x001788010b2c3d4e', { on: true, bri: 40, hue: 21845, sat: 254 }), 'accepted');
    assert.deepEqual(mq.st.pubs.at(-1), ['zigbee2mqtt/Wohnzimmer/Decke/set', { state: 'ON', brightness: 102, color: { hue: 120, saturation: 100 } }]);
    assert.equal(await z.set('0x000d6ffffe1a2b3c', { on: false, bri: 30 }), 'accepted');
    assert.deepEqual(mq.st.pubs.at(-1), ['zigbee2mqtt/Steckdose Kaffee/set', { state: 'OFF' }], 'a plug has no brightness');
    assert.equal(await z.set('0x00158d0001a2b3c4', { on: true }), 'invalid', 'a sensor cannot be switched');
  });

  it('helpers: summarize, valuesOf, setPayload, deviceOf, ieee conversion', () => {
    assert.equal(macOfIeee('0x00158D0001A2B3C4'), '00:15:8d:00:01:a2:b3:c4');
    assert.equal(ieeeOf('00:15:8d:00:01:a2:b3:c4'), '0x00158d0001a2b3c4');
    assert.equal(ieeeOf('../etc'), null);
    assert.equal(deviceOf({ type: 'Coordinator', ieee_address: '0x00124b0024c2f1a0', friendly_name: 'C' }), null);
    assert.equal(deviceOf({ type: 'Router', ieee_address: '0x00124b0024c2f1a0', friendly_name: 'x'.repeat(200) }), null);
    assert.deepEqual(summarize({ exposes: [{ type: 'binary', name: 'occupancy', property: 'occupancy' }, { type: 'numeric', name: 'illuminance', property: 'illuminance' }] }), { kind: 'sensor', caps: {} });
    assert.deepEqual(summarize({ exposes: [{ type: 'enum', name: 'action', property: 'action' }, { type: 'numeric', name: 'battery', property: 'battery' }] }), { kind: 'remote', caps: { battery: true } });
    assert.deepEqual(valuesOf({ water_leak: true, smoke: false, illuminance_lux: 312.4, occupancy: true, action: 'single' }), { illuminance: 312, motion: true, moisture_wet: true, smoke: false, action: 'single' });
    assert.equal(setPayload({ kind: 'sensor', caps: {} }, { on: true }), null);
    assert.deepEqual(setPayload({ kind: 'light', caps: { stateProp: 'state', bri: true, ct: true } }, { ct: 999 }), { color_temp: 500 });
  });
});

// ─── Thread ──────────────────────────────────────────────────────────────

/** REST-Stub des Border Routers (ot-br-posix): Rolle, Datensatz, Zustand. */
function fakeOtbr() {
  const st = { role: 'disabled', dataset: null, tlv: null, puts: [] };
  const send = async ({ method, path: p, body, accept, contentType }) => {
    if (st.down) throw Object.assign(new Error('down'), { code: 'unreachable' });
    if (method === 'GET' && p === '/node/state') return { status: 200, text: JSON.stringify(st.role) };
    if (method === 'GET' && p === '/node/num-of-router') return { status: 200, text: '1' };
    if (method === 'GET' && p === '/node/dataset/active') {
      if (!st.dataset) return { status: 204, text: '' };
      return accept === 'text/plain' ? { status: 200, text: st.tlv } : { status: 200, text: JSON.stringify(st.dataset) };
    }
    if (method === 'PUT' && p === '/node/state') { st.puts.push(['state', body]); st.role = body === 'enable' ? 'leader' : 'disabled'; return { status: 200, text: '' }; }
    if (method === 'PUT' && p === '/node/dataset/active') {
      if (st.role !== 'disabled') return { status: 409, text: '' };
      st.puts.push(['dataset', contentType === 'text/plain' ? 'tlv' : body]);
      st.dataset = { NetworkName: (body && body.networkName) || 'Imported', ExtPanId: 'DEAD00BEEF00CAFE', PanId: 4660, Channel: 25, NetworkKey: '00112233445566778899AABBCCDDEEFF', PSKc: 'aa' };
      st.tlv = '0e080000000000010000000300001935060004001fffe0';
      return { status: st.created ? 200 : 201, text: '' };
    }
    return { status: 404, text: '' };
  };
  return { st, client: createOtbrClient({ send }) };
}

describe('radio: thread border router', () => {
  let ctl; let clock; let stick;
  beforeEach(() => { ctl = tmp('gc-ctl-'); clock = 1_800_000_000_000; stick = detect({ sysRoot: makeSysfs({ usb: [ZBT1] }) }).sticks[0]; });
  afterEach(() => fs.rmSync(ctl, { recursive: true, force: true }));

  it('thread.env for the watcher (device, baud, LAN interface); off removes it', () => {
    const t = new ThreadBorderRouter({ ctlDir: ctl, client: fakeOtbr().client, now: () => clock, procRoot: '/nonexistent' });
    t.apply({ want: true, stick, infra: 'eth0' });
    assert.equal(fs.readFileSync(path.join(ctl, 'thread.env'), 'utf8'), 'DEVICE=ttyUSB0\nDEV=188:0\nBAUD=460800\nINFRA=eth0\n');
    t.apply({ want: true, stick, infra: 'eth0; rm -rf /' });
    assert.ok(!fs.existsSync(path.join(ctl, 'thread.env')), 'a strange interface name is not written');
    assert.equal(t.state(), 'no_lan');
    t.apply({ want: false, stick, infra: 'eth0' });
    assert.equal(t.state(), 'off');
    t.apply({ want: true, stick: null, infra: 'eth0', busy: true });
    assert.equal(t.state(), 'stick_busy');
  });

  it('form a network, read network data without the key, dataset on request, join with a TLV', async () => {
    const o = fakeOtbr();
    const proc = tmp('gc-proc-');
    fs.mkdirSync(path.join(proc, 'sys', 'net', 'ipv6', 'conf', 'all'), { recursive: true });
    fs.writeFileSync(path.join(proc, 'sys', 'net', 'ipv6', 'conf', 'all', 'forwarding'), '0\n');
    const t = new ThreadBorderRouter({ ctlDir: ctl, client: o.client, now: () => clock, procRoot: proc });
    t.apply({ want: true, stick, infra: 'eth0' });
    assert.equal(await t.form(), 'not_running');
    await t.tick();
    assert.equal(t.state(), 'no_network');
    assert.equal(await t.form('Haus'), 'accepted');
    assert.deepEqual(o.st.puts, [['state', 'disable'], ['dataset', { networkName: 'Haus' }], ['state', 'enable']]);
    const tel = t.telemetry();
    assert.equal(tel.state, 'running');
    assert.equal(tel.role, 'leader');
    assert.deepEqual(tel.network, { name: 'Haus', extPanId: 'dead00beef00cafe', panId: 4660, channel: 25 });
    assert.equal(tel.forwarding, false);
    assert.doesNotMatch(JSON.stringify(tel), /00112233445566778899/i, 'never the network key');
    assert.equal(await t.form('Noch eins'), 'has_network');
    assert.deepEqual(await t.dataset(), { outcome: 'ok', tlv: '0e080000000000010000000300001935060004001fffe0' });
    assert.equal(await t.join('zz'), 'invalid');
    o.st.created = true;
    assert.equal(await t.join('0e080000000000010000000300000f35060004001fffe0'), 'accepted');
    assert.deepEqual(o.st.puts.slice(-3), [['state', 'disable'], ['dataset', 'tlv'], ['state', 'enable']]);
    fs.rmSync(proc, { recursive: true, force: true });
  });

  it('not reachable: starting, then service_missing / error from the watcher', async () => {
    const o = fakeOtbr();
    o.st.down = true;
    const t = new ThreadBorderRouter({ ctlDir: ctl, client: o.client, now: () => clock, procRoot: '/nonexistent' });
    t.apply({ want: true, stick, infra: 'eth0' });
    await t.tick();
    assert.equal(t.state(), 'starting');
    clock += 5 * 60_000;
    assert.equal(t.state(), 'service_missing');
    fs.writeFileSync(path.join(ctl, 'otbr.state'), `exit 1 ${Math.floor(clock / 1000)}\n`);
    assert.equal(t.state(), 'error');
    assert.equal(t.telemetry().error.code, 'otbr_exit');
    assert.deepEqual(networkOf({ networkName: 'x'.repeat(40), channel: 99, panId: -1, extPanId: 'nothex' }), { name: 'x'.repeat(16), extPanId: null, panId: null, channel: null });
  });
});

// ─── Verschlüsselte Bluetooth-Sensoren (veröffentlichte Testvektoren) ────

describe('radio: encrypted BLE sensors', () => {
  // bthome-ble, tests/test_parser_v2.py test_bindkey_correct: Shelly BLU H&T 54:48:E6:8F:80:A5 → 25,06 °C, 50,55 %
  const BTHOME_BIND = '231d39c1d7cc1ab1aee224cd096db932';
  const BTHOME_MAC = '54:48:E6:8F:80:A5';
  const BTHOME_DATA = Buffer.from('41a47266c95f73001122337823721 4'.replace(/ /g, ''), 'hex');

  it('BTHome v2 with the right key → values; wrong key → wrong_key; no key → no_key', () => {
    const d = decryptBthome(BTHOME_MAC, BTHOME_DATA, BTHOME_BIND);
    assert.equal(d.ok, true);
    assert.equal(d.counter, 0x33221100);
    const keyFor = (m) => (m === BTHOME_MAC ? BTHOME_BIND : null);
    const p = parseAdvert(BTHOME_MAC, adv(0xfcd2, BTHOME_DATA), { keyFor });
    assert.deepEqual({ format: p.format, encrypted: p.encrypted, keyState: p.keyState, values: p.values }, { format: 'bthome', encrypted: true, keyState: 'ok', values: { temperature: 25.06, humidity: 50.55 } });
    // bthome-ble test_bindkey_wrong (anderer Sensor, anderer Schlüssel)
    const wrong = parseAdvert('A4:C1:38:8D:18:B2', adv(0xfcd2, Buffer.from('41d2fcefe52eb212d600112233bc38c966', 'hex').subarray(0)), { keyFor: () => '814aac74c4f17b6c1581e1ab87816b99' });
    assert.equal(wrong.keyState, 'wrong_key');
    assert.deepEqual(wrong.values, {});
    assert.equal(parseAdvert(BTHOME_MAC, adv(0xfcd2, BTHOME_DATA)).keyState, 'no_key');
    // ein verändertes Byte → MIC passt nicht
    const bad = Buffer.from(BTHOME_DATA); bad[3] ^= 1;
    assert.equal(decryptBthome(BTHOME_MAC, bad, BTHOME_BIND).ok, false);
    assert.equal(decryptBthome('nope', BTHOME_DATA, BTHOME_BIND).ok, false);
    assert.equal(decryptBthome(BTHOME_MAC, BTHOME_DATA, 'short').ok, false);
  });

  // xiaomi-ble, tests/test_parser.py (MiBeacon v5 mit Bindkey)
  const MI = [
    // test_Xiaomi_LYWSD03MMC_encrypted: Feuchte 0x1006 = 46,7 % (xiaomi-ble rundet für dieses Modell ab: 46)
    { name: 'LYWSD03MMC', mac: 'A4:C1:38:02:83:F4', bind: 'e9ea895fac7cca6d30532432a516f3a8', hex: '58585b0550f4830238c1a495ef58763c26000097e2abb5', values: { humidity: 46.7 } },
    // test_Xiaomi_CGG1: Feuchte 59,6 %
    { name: 'CGG1', mac: '5A:58:2D:34:12:5F', bind: '814aac74c4f17b6c1581e1ab87816b99', hex: '5858480b685f12342d585a0b1841e2aa000e00a4964fb5', values: { humidity: 59.6 } },
    // test_Xiaomi_CGDK2: Temperatur 22,6 °C
    { name: 'CGDK2', mac: '58:2D:34:12:20:89', bind: 'a3bfe9853dd85a620debe3620caaa351', hex: '58586f0607892012342d585f176dd54f0200002fa453fa', values: { temperature: 22.6 } },
    // test_Xiaomi_LYWSD02MMC_v2_temperature: ohne MAC im Paket, Objekt 0x4C01 (float) 26,1 °C
    { name: 'LYWSD02MMC', mac: 'A4:C1:38:0E:FD:78', bind: '19b1c678ab0a8bc3dc77765f059188d4', hex: '4858422529202d8c7a76b756a82a0078b8224e', values: { temperature: 26.1 } },
    // test_Xiaomi_XMWSDJ04MMC: Objekt 0x4C08 (float) Feuchte 45 %
    { name: 'XMWSDJ04MMC', mac: '2C:11:65:25:70:04', bind: 'b2cf9a553d53571b5657defd582d676e', hex: '48590312a41b776e7c96add7000000f2bf545b', values: { humidity: 45 } },
  ];
  for (const v of MI) {
    it(`MiBeacon v5 ${v.name}: bindkey → values`, () => {
      const p = parseAdvert(v.mac, adv(0xfe95, Buffer.from(v.hex, 'hex')), { keyFor: () => v.bind });
      assert.equal(p.format, 'mibeacon');
      assert.equal(p.keyState, 'ok');
      assert.deepEqual(p.values, v.values);
    });
  }
  it('MiBeacon: wrong bindkey, no bindkey, legacy v2/v3, unencrypted objects', () => {
    const v = MI[0];
    assert.equal(parseAdvert(v.mac, adv(0xfe95, Buffer.from(v.hex, 'hex')), { keyFor: () => MI[1].bind }).keyState, 'wrong_key');
    assert.equal(parseAdvert(v.mac, adv(0xfe95, Buffer.from(v.hex, 'hex'))).keyState, 'no_key');
    // xiaomi-ble test_encryption_needs_v2: MiBeacon v3 (ältere Verschlüsselung) – nicht unterstützt
    const legacy = Buffer.from('X0\xb6\x03\xd2\x8b\x98\xc5A$\xf8\xc3I\x14vu~\x00\x00\x00\x99', 'latin1');
    assert.equal(parseAdvert('F8:24:41:C5:98:8B', adv(0xfe95, legacy), { keyFor: () => '00'.repeat(16) }).keyState, 'unsupported');
    // xiaomi-ble test_Xiaomi_LYWSDCGQ: unverschlüsselt, 0x100D Temperatur 18,0 °C und Feuchte 66,1 %
    const plain = Buffer.from('P \xaa\x01\xa3\xbf.;4-X\r\x10\x04\xb4\x00\x95\x02', 'latin1');
    const pp = parseAdvert('58:2D:34:3B:2E:BF', adv(0xfe95, plain));
    assert.deepEqual({ encrypted: pp.encrypted, values: pp.values }, { encrypted: false, values: { temperature: 18, humidity: 66.1 } });
    assert.deepEqual(mibeaconValues(Buffer.from([0x0a, 0x10, 0x01, 0x5d, 0x04, 0x10, 0x09])), { battery: 93 }, 'a cut object ends reading');
    assert.equal(decryptMibeacon('A4:C1:38:02:83:F4', Buffer.from([1, 2]), MI[0].bind).ok, false);
  });

  it('scanner: the key from GateControl decrypts, keyState goes to the server', async () => {
    const s = new BleScanner({ reporter: null, keys: { get: (m) => (m === BTHOME_MAC ? BTHOME_BIND : null) } });
    s.advert(BTHOME_MAC, -60, adv(0xfcd2, BTHOME_DATA));
    s.advert(MI[0].mac, -70, adv(0xfe95, Buffer.from(MI[0].hex, 'hex')));
    const l = Object.fromEntries(s.list().map((x) => [x.mac, x]));
    assert.deepEqual({ k: l[BTHOME_MAC].keyState, v: l[BTHOME_MAC].values }, { k: 'ok', v: { temperature: 25.06, humidity: 50.55 } });
    assert.equal(l[MI[0].mac].keyState, 'no_key');
  });
});

describe('radio: key store for encrypted sensors', () => {
  it('fetched only when the stand changes, kept encrypted in /state (0600), never readable without the token', async () => {
    const dir = tmp('gc-st-');
    let calls = 0;
    const answer = { rev: 'abcdef0123456789', keys: { '54:48:e6:8f:80:a5': '231D39C1D7CC1AB1AEE224CD096DB932', 'XX': 'bad', '11:22:33:44:55:66': 'short' } };
    const k = new BleKeyStore({ apiToken: 'tok-1', stateDir: dir, fetcher: async () => { calls++; return answer; } });
    assert.equal(await k.sync('abcdef0123456789'), true);
    assert.equal(await k.sync('abcdef0123456789'), false);
    assert.equal(calls, 1);
    assert.equal(k.get('54:48:E6:8F:80:A5'), '231d39c1d7cc1ab1aee224cd096db932');
    assert.equal(k.size, 1);
    const file = path.join(dir, 'radio-ble-keys.bin');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /231d39c1/i, 'not in plain text');
    const again = new BleKeyStore({ apiToken: 'tok-1', stateDir: dir, fetcher: async () => { throw new Error('offline'); } });
    assert.equal(again.get('54:48:E6:8F:80:A5'), '231d39c1d7cc1ab1aee224cd096db932', 'a restart without the server keeps the keys');
    const other = new BleKeyStore({ apiToken: 'tok-2', stateDir: dir });
    assert.equal(other.size, 0, 'another token cannot read them');
    assert.equal(await k.sync(null), true);
    assert.ok(!fs.existsSync(file));
    assert.equal(parseKeys({ rev: 'x', keys: [] }).keys.size, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Dienst und Routen ───────────────────────────────────────────────────

describe('radio: service with zigbee2mqtt and Thread', () => {
  it('stack zigbee2mqtt: deCONZ stays off, the ZBDongle-E goes to zigbee2mqtt, the ZBT-1 to Thread; Pi host asked once for both', async () => {
    const ctl = tmp('gc-ctl-');
    const st = tmp('gc-st-');
    fs.writeFileSync(path.join(st, 'hardware.json'), JSON.stringify({ radio_start: true }));
    const mq = fakeMqtt();
    const r = new RadioService({
      stateDir: st, ctlDir: ctl, sysRoot: makeSysfs({ usb: [CONBEE2, ZBDONGLE_E, ZBT1] }), getInfra: () => 'eth0',
      client: { probe: async () => { throw Object.assign(new Error('x'), { code: 'unreachable' }); } },
      thread: new ThreadBorderRouter({ ctlDir: ctl, client: createOtbrClient({ send: async () => { throw Object.assign(new Error('x'), { code: 'unreachable' }); } }), procRoot: '/nonexistent' }),
      keys: new BleKeyStore({ apiToken: 't' }),
    });
    r.attachMqtt(mq);
    // Wächter beider Dienste fehlen (Volume da, Container nicht)
    fs.writeFileSync(path.join(ctl, 'z2m.state'), 'idle - 1\n');
    fs.writeFileSync(path.join(ctl, 'otbr.state'), 'idle - 1\n');
    await r.apply({ zigbee: null, stack: 'zigbee2mqtt', thread: true, ble: false });
    const t = r.featureTelemetry();
    r.stop();
    assert.ok(!fs.existsSync(path.join(ctl, 'zigbee.env')), 'deCONZ off');
    assert.match(fs.readFileSync(path.join(ctl, 'z2m.env'), 'utf8'), /^DEVICE=ttyACM1\n/);
    assert.match(fs.readFileSync(path.join(ctl, 'thread.env'), 'utf8'), /^DEVICE=ttyUSB0\n/);
    assert.deepEqual(t.sticks.map((s) => s.use), [null, 'zigbee2mqtt', 'thread']);
    assert.equal(t.zigbee.stack, 'zigbee2mqtt');
    assert.equal(t.zigbee2mqtt.state, 'starting');
    assert.equal(t.thread.state, 'starting');
    const flag = JSON.parse(fs.readFileSync(path.join(st, 'radio-start'), 'utf8'));
    assert.deepEqual(flag.services, ['otbr', 'zigbee2mqtt']);
    const wish = JSON.parse(fs.readFileSync(path.join(st, 'radio.json'), 'utf8'));
    assert.deepEqual({ want: wish.want, stack: wish.stack, z2m: wish.z2m, thread: wish.thread }, { want: false, stack: 'zigbee2mqtt', z2m: true, thread: true });
    assert.ok(JSON.stringify(t).length < 5000, 'heartbeat limit 16 KB');
  });

  const TOK = 'f'.repeat(64);
  async function serve(radio) {
    const a = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: TOK, routerFactories: { '/api': () => createFeaturesRouter({ featureMgr: { radio } }) } });
    const srv = a.listen(0, '127.0.0.1');
    await new Promise((r) => srv.on('listening', r));
    return srv;
  }
  function post(srv, p, body) {
    return new Promise((resolve) => {
      const d = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Gateway-Token': TOK } }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
      });
      req.end(d);
    });
  }
  it('routes: zigbee remove/set, thread form/join/dataset (validated)', async () => {
    const seen = [];
    const radio = {
      requestRemove: async (b) => { seen.push(['rm', b.ieee]); return 'not_found'; },
      requestSet: async (b) => { seen.push(['set', b.ieee, b.set]); return 'accepted'; },
      requestThreadForm: async (b) => { seen.push(['form', b.name]); return 'has_network'; },
      requestThreadJoin: async () => 'accepted',
      requestThreadDataset: async () => ({ outcome: 'ok', tlv: '0e08aa' }),
    };
    const a = await serve(radio);
    try {
      assert.equal((await post(a, '/api/radio/zigbee/remove', { ieee: '0x00158d0001a2b3c4' })).status, 404);
      assert.equal((await post(a, '/api/radio/zigbee/remove', { ieee: '../x' })).status, 400);
      assert.equal((await post(a, '/api/radio/zigbee/set', { ieee: '00:15:8d:00:01:a2:b3:c4', set: { on: true } })).status, 202);
      assert.equal((await post(a, '/api/radio/zigbee/set', { ieee: '00:15:8d:00:01:a2:b3:c4', set: [1] })).status, 400);
      assert.deepEqual(await post(a, '/api/radio/thread/form', { name: 'Haus' }), { status: 409, body: { error: 'has_network' } });
      assert.equal((await post(a, '/api/radio/thread/form', { name: 'x'.repeat(30) })).status, 400);
      assert.equal((await post(a, '/api/radio/thread/join', { dataset: 'nothex' })).status, 400);
      assert.equal((await post(a, '/api/radio/thread/join', { dataset: '0e080000000000010000000300000f35' })).status, 202);
      assert.deepEqual(await post(a, '/api/radio/thread/dataset', {}), { status: 200, body: { dataset: '0e08aa' } });
      assert.deepEqual(seen, [['rm', '0x00158d0001a2b3c4'], ['set', '00:15:8d:00:01:a2:b3:c4', { on: true }], ['form', 'Haus']]);
    } finally { a.close(); }
    const none = await serve(undefined);
    try {
      assert.equal((await post(none, '/api/radio/thread/dataset', {})).status, 503);
      assert.equal((await post(none, '/api/radio/zigbee/set', { ieee: '0x00158d0001a2b3c4', set: {} })).status, 503);
    } finally { none.close(); }
  });
});
