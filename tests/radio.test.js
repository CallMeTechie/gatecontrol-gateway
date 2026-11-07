'use strict';

// Funk (Phase 3c, Schritt 2 – docs/radio.md): Erkennung aus sysfs, BLE-Formate,
// Zigbee-Steuerung (zigbee.env, Wächter, Schlüssel, Anlernen) mit einem
// deCONZ-Stub, BLE-Scanner mit einem Stub für gc-blescan, Management-Routen.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { createApiServer } = require('../src/api/server');

const { detect, classify } = require('../src/radio/detect');
const { parseAdvert, parseBthome } = require('../src/radio/bleparse');
const { Zigbee, devicesOf, macOf } = require('../src/radio/zigbee');
const { BleScanner } = require('../src/radio/ble');
const { RadioService } = require('../src/radio/radio');
const { normalizeRadio } = require('../src/radio/config');
const { normalizeFeatures } = require('../src/features/config');
const { createFeaturesRouter } = require('../src/api/routes/features');
const { createDeconzClient, deconzError } = require('../src/radio/deconz');
const { makeSysfs, CONBEE2, ZBT1 } = require('./helpers/fakeSysfs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ─── Erkennung ───────────────────────────────────────────────────────────

describe('radio: detect (sysfs)', () => {
  it('ConBee II and ZBT-1 over USB, built-in and USB Bluetooth', () => {
    const sys = makeSysfs({
      usb: [CONBEE2, ZBT1, { port: '1-1.5', vid: '0403', pid: '6001', product: 'FT232R USB UART', tty: 'ttyUSB1', dev: '188:1' }],
      bt: [{ name: 'hci0' }, { name: 'hci1', usbPort: '1-1.4', product: 'CSR8510 A10' }],
    });
    const r = detect({ sysRoot: sys });
    assert.equal(r.sticks.length, 2, 'the FTDI cable is no radio');
    const [cb, zbt] = r.sticks;
    assert.deepEqual({ kind: cb.kind, model: cb.model, tty: cb.tty, dev: cb.dev, deconz: cb.deconz, baud: cb.baud, bus: cb.bus },
      { kind: 'zigbee', model: 'ConBee II', tty: 'ttyACM0', dev: '166:0', deconz: true, baud: 115200, bus: 'usb' });
    assert.deepEqual({ kind: zbt.kind, model: zbt.model, deconz: zbt.deconz, dev: zbt.dev }, { kind: 'multi', model: 'Home Assistant Connect ZBT-1', deconz: false, dev: '188:0' });
    assert.deepEqual(r.bluetooth, [{ name: 'hci0', bus: 'builtin', model: null }, { name: 'hci1', bus: 'usb', model: 'CSR8510 A10' }]);
  });

  it('RaspBee from hardware.json of the Pi image (and only on ttyAMA); a wrong major number is no device', () => {
    const sys = makeSysfs({ uart: [{ tty: 'ttyAMA0', dev: '204:64' }], usb: [{ ...CONBEE2, dev: '4:64' }] });
    const host = { radios: [{ kind: 'zigbee', device: '/dev/ttyAMA0', type: 'raspbee2-conbee2', firmware: '0x26780700', detected: true, enabled: true }] };
    const r = detect({ sysRoot: sys, hostProfile: host });
    assert.equal(r.sticks[0].model, 'RaspBee II');
    assert.equal(r.sticks[0].dev, '204:64');
    assert.equal(r.sticks[0].firmware, '0x26780700');
    assert.equal(r.sticks[1].dev, null, 'ttyACM with major 4 is refused');
    const evil = detect({ sysRoot: sys, hostProfile: { radios: [{ kind: 'zigbee', device: '/dev/../etc/passwd', detected: true }] } });
    assert.equal(evil.sticks.filter((s) => s.bus === 'uart').length, 0);
  });

  it('no sysfs → nothing, no throw', () => {
    assert.deepEqual(detect({ sysRoot: '/nonexistent-gc' }), { sticks: [], bluetooth: [] });
  });

  it('classify: known sticks', () => {
    assert.equal(classify({ vid: '1a86', pid: '55d4', product: 'SONOFF Zigbee 3.0 USB Dongle Plus V2' }).model, 'Sonoff ZBDongle-E');
    assert.equal(classify({ vid: '10c4', pid: 'ea60', product: 'Sonoff Zigbee 3.0 USB Dongle Plus' }).deconz, false);
    assert.equal(classify({ vid: '0403', pid: '6015', product: 'ConBee III' }).model, 'ConBee III');
    assert.equal(classify({ vid: '1915', pid: 'cafe', product: 'nRF528xx OpenThread Device' }).kind, 'thread');
    assert.equal(classify({ vid: '0403', pid: '6001', product: 'FT232R' }), null);
  });
});

// ─── Bluetooth-Formate ───────────────────────────────────────────────────

function adv(uuid, payload, name) {
  const sd = Buffer.concat([Buffer.from([payload.length + 3, 0x16, uuid & 0xff, uuid >> 8]), Buffer.from(payload)]);
  const flags = Buffer.from([2, 0x01, 0x06]);
  const n = name ? Buffer.concat([Buffer.from([name.length + 1, 0x09]), Buffer.from(name)]) : Buffer.alloc(0);
  return Buffer.concat([flags, sd, n]);
}

describe('radio: BLE formats', () => {
  it('BTHome v2 (Shelly BLU H&T): battery, humidity, temperature', () => {
    // 0x40 = v2 unverschlüsselt; 0x00 Paket 14; 0x01 Batterie 100; 0x2e Feuchte 71; 0x45 Temperatur 14,2 °C
    const p = parseAdvert('7C:C6:B6:00:11:22', adv(0xfcd2, [0x44, 0x00, 0x0e, 0x01, 0x64, 0x2e, 0x47, 0x45, 0x8e, 0x00], 'SBHT-003C'));
    assert.deepEqual(p, { format: 'bthome', encrypted: false, keyState: null, decrypted: false, values: { battery: 100, humidity: 71, temperature: 14.2 }, name: 'SBHT-003C' });
  });
  it('BTHome v2: 0.01 values, signed temperature, binary window, button; unknown object stops reading', () => {
    const r = parseBthome(Buffer.from([0x40, 0x02, 0x18, 0xfc, 0x03, 0xbf, 0x13, 0x2d, 0x01, 0x3a, 0x01, 0x99, 0x01, 0x02]));
    assert.deepEqual(r.values, { temperature: -10, humidity: 50.55, window: true, button: 1 });
  });
  it('BTHome v2 encrypted / v1 / too short', () => {
    assert.deepEqual(parseBthome(Buffer.from([0x41, 1, 2, 3])), { encrypted: true, values: {} });
    assert.equal(parseBthome(Buffer.from([0x20, 0x01, 0x64])), null);
    assert.equal(parseBthome(Buffer.alloc(0)), null);
  });
  it('ATC1441 and pvvx (LYWSD03MMC with custom firmware); MAC must match', () => {
    const mac = 'A4:C1:38:11:22:33';
    const atc = [0xa4, 0xc1, 0x38, 0x11, 0x22, 0x33, 0x00, 0x59, 64, 82, 0x0b, 0x86, 1];
    assert.deepEqual(parseAdvert(mac, adv(0x181a, atc)).values, { temperature: 8.9, humidity: 64, battery: 82, voltage: 2.95 });
    assert.equal(parseAdvert('A4:C1:38:99:99:99', adv(0x181a, atc)), null);
    const pv = [0x33, 0x22, 0x11, 0x38, 0xc1, 0xa4, 0x66, 0x08, 0xa0, 0x11, 0xb8, 0x0b, 90, 7, 0];
    assert.deepEqual(parseAdvert(mac, adv(0x181a, pv)), { format: 'pvvx', encrypted: false, keyState: null, decrypted: false, values: { temperature: 21.5, humidity: 45.12, voltage: 3, battery: 90 }, name: null });
  });
  it('MiBeacon (Xiaomi firmware): recognised, values encrypted', () => {
    const p = parseAdvert('A4:C1:38:11:22:33', adv(0xfe95, [0x58, 0x58, 0x5b, 0x05, 0x01, 0x33, 0x22]));
    assert.equal(p.format, 'mibeacon');
    assert.equal(p.encrypted, true);
    assert.equal(p.keyState, 'no_key', 'without a bindkey from GateControl');
  });
  it('other adverts and broken lengths → null', () => {
    assert.equal(parseAdvert('00:11:22:33:44:55', Buffer.from([2, 0x01, 0x06, 5, 0xff, 0x4c, 0x00, 1, 2])), null);
    assert.equal(parseAdvert('00:11:22:33:44:55', Buffer.from([30, 0x16, 0xd2])), null);
  });
});

// ─── deCONZ-Client ───────────────────────────────────────────────────────

describe('radio: deCONZ client', () => {
  it('createKey: factory login first, then without; refused → key_needed', async () => {
    const calls = [];
    const send = async (o) => {
      calls.push(o.headers && o.headers.Authorization ? 'basic' : 'plain');
      return { status: 403, json: [{ error: { type: 101, description: 'link button not pressed' } }] };
    };
    const c = createDeconzClient({ send });
    await assert.rejects(() => c.createKey(), (e) => e.code === 'key_needed');
    assert.deepEqual(calls, ['basic', 'plain']);
    const ok = createDeconzClient({ send: async () => ({ status: 200, json: [{ success: { username: 'ABCDEF1234' } }] }) });
    assert.equal(await ok.createKey(), 'ABCDEF1234');
  });
  it('errors: unauthorized, link button, bad response', () => {
    assert.equal(deconzError([{ error: { type: 1 } }]).code, 'unauthorized');
    assert.equal(deconzError([{ error: { type: 101 } }]).code, 'link_button');
    assert.equal(deconzError([{ success: {} }]), null);
  });
  it('no key → unauthorized without a request', async () => {
    let n = 0;
    const c = createDeconzClient({ send: async () => { n++; return { status: 200, json: {} }; } });
    await assert.rejects(() => c.lights('../x'), (e) => e.code === 'unauthorized');
    assert.equal(n, 0);
  });
});

// ─── Zigbee ──────────────────────────────────────────────────────────────

function fakeDeconz(over = {}) {
  const st = {
    up: true, keyOk: true, created: 0, permit: [], unlocks: 0,
    lights: { 1: { type: 'Configuration tool', uniqueid: '00:21:2e:ff:ff:00:00:01-01' }, 2: { type: 'Extended color light', name: 'Flur', modelid: 'LCT015', manufacturername: 'Philips', uniqueid: '00:17:88:01:02:03:04:05-0b' } },
    sensors: { 1: { type: 'Daylight', modelid: 'PHDL00' }, 2: { type: 'ZHATemperature', uniqueid: '00:15:8d:00:01:02:03:04-01-0402', modelid: 'lumi.weather' }, 3: { type: 'ZHAHumidity', uniqueid: '00:15:8d:00:01:02:03:04-01-0405' }, 4: { type: 'CLIPPresence', uniqueid: 'clip' } },
    cfg: { zigbeechannel: 15, fwversion: '0x26780700', devicename: 'ConBee II', permitjoin: 0, rfconnected: true },
    ...over,
  };
  const down = () => Object.assign(new Error('down'), { code: 'unreachable' });
  const unauth = () => Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  return {
    st,
    probe: async () => { if (!st.up) throw down(); return {}; },
    createKey: async () => { if (st.refuse) throw Object.assign(new Error('no'), { code: 'key_needed' }); st.created++; st.keyOk = true; return 'KEY' + st.created + 'ABCDEF'; },
    config: async () => st.cfg,
    lights: async () => { if (!st.keyOk) throw unauth(); return st.lights; },
    sensors: async () => st.sensors,
    permitJoin: async (k, s) => { st.permit.push(s); },
    unlock: async () => { st.unlocks++; },
  };
}

describe('radio: zigbee control', () => {
  let ctl; let state; let sys; let clock;
  beforeEach(() => {
    ctl = tmp('gc-ctl-'); state = tmp('gc-st-');
    sys = detect({ sysRoot: makeSysfs({ usb: [CONBEE2] }) });
    clock = 1_800_000_000_000;
  });
  afterEach(() => { fs.rmSync(ctl, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  const make = (client = fakeDeconz()) => new Zigbee({ client, stateDir: state, ctlDir: ctl, now: () => clock });
  const alive = (s = 'running ttyACM0') => fs.writeFileSync(path.join(ctl, 'deconz.state'), `${s} ${Math.floor(clock / 1000)}\n`);

  it('automatic with a ConBee: zigbee.env for the watcher, radio.json for the Pi host; off removes it', () => {
    const z = make();
    z.apply({ mode: null, sticks: sys.sticks, hostProfile: null });
    assert.equal(fs.readFileSync(path.join(ctl, 'zigbee.env'), 'utf8'), 'DEVICE=ttyACM0\nDEV=166:0\nBAUD=115200\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'radio.json'), 'utf8')), { zigbee: null, want: true });
    z.apply({ mode: false });
    assert.equal(fs.existsSync(path.join(ctl, 'zigbee.env')), false);
    assert.equal(z.telemetry().state, 'off');
    assert.equal(z.telemetry().mode, 'off');
  });

  it('settings.txt ZIGBEE=off counts only while GateControl says automatic', () => {
    const z = make();
    const host = { radios: [{ kind: 'zigbee', mode: 'off' }] };
    z.apply({ mode: null, sticks: sys.sticks, hostProfile: host });
    assert.equal(z.want(), false);
    z.apply({ mode: true });
    assert.equal(z.want(), true);
  });

  it('running: key, channel, firmware, devices (one per MAC, no CLIP/Daylight/coordinator)', async () => {
    const z = make();
    z.apply({ mode: true, sticks: sys.sticks, hostProfile: null });
    alive();
    await z.tick();
    const t = z.telemetry();
    assert.equal(t.state, 'running');
    assert.equal(t.service, 'managed');
    assert.deepEqual({ model: t.model, channel: t.channel, firmware: t.firmware, devices: t.devices }, { model: 'ConBee II', channel: 15, firmware: '0x26780700', devices: 2 });
    const key = JSON.parse(fs.readFileSync(path.join(state, 'radio-deconz.json'), 'utf8'));
    assert.match(key.key, /^KEY1/);
    assert.equal((fs.statSync(path.join(state, 'radio-deconz.json')).mode & 0o777), 0o600);
  });

  it('a key deCONZ no longer accepts is fetched again', async () => {
    const c = fakeDeconz();
    const z = make(c);
    z.apply({ mode: true, sticks: sys.sticks, hostProfile: null });
    await z.tick();
    c.st.keyOk = false;
    await z.tick();
    assert.equal(c.st.created, 2);
    assert.equal(z.telemetry().state, 'running');
  });

  it('deCONZ refuses a key → key_needed; retry asks again', async () => {
    const c = fakeDeconz({ refuse: true });
    const z = make(c);
    z.apply({ mode: true, sticks: sys.sticks, hostProfile: null });
    await z.tick();
    assert.equal(z.telemetry().state, 'key_needed');
    assert.equal(await z.pair(180), 'key_needed');
    c.st.refuse = false;
    await z.retry();
    assert.equal(z.telemetry().state, 'running');
  });

  it('pairing: permitjoin, new device found in the window, recent list', async () => {
    const c = fakeDeconz();
    const z = make(c);
    z.apply({ mode: true, sticks: sys.sticks, hostProfile: null });
    await z.tick();
    assert.equal(await z.pair(500), 'accepted');
    assert.deepEqual(c.st.permit, [254], 'clamped to deCONZ\'s maximum');
    assert.ok(z.telemetry().permitUntil);
    c.st.sensors[9] = { type: 'ZHAOpenClose', name: 'OpenClose 9', modelid: 'lumi.sensor_magnet.aq2', manufacturername: 'LUMI', uniqueid: '00:15:8d:00:0a:0b:0c:0d-01-0006' };
    clock += 20_000;
    await z.tick();
    const t = z.telemetry();
    assert.equal(t.recent.length, 1);
    assert.deepEqual({ mac: t.recent[0].mac, type: t.recent[0].type, model: t.recent[0].model, manufacturer: t.recent[0].manufacturer },
      { mac: '00:15:8d:00:0a:0b:0c:0d', type: 'sensor', model: 'lumi.sensor_magnet.aq2', manufacturer: 'LUMI' });
    assert.equal(t.devices, 3);
    clock += 31 * 60_000;
    assert.equal(z.telemetry().recent.length, 0, 'forgotten after 30 minutes');
  });

  it('not reachable: no stick → no_stick, other stick → unsupported, no service → service_missing, Pi asks the host', async () => {
    const c = fakeDeconz({ up: false });
    const z = make(c);
    z.apply({ mode: true, sticks: [], hostProfile: null });
    await z.tick();
    assert.equal(z.telemetry().state, 'no_stick');
    z.apply({ sticks: detect({ sysRoot: makeSysfs({ usb: [ZBT1] }) }).sticks });
    assert.equal(z.telemetry().state, 'unsupported');
    z.apply({ sticks: sys.sticks });
    assert.equal(z.telemetry().service, 'absent', 'volume there, watcher not alive');
    assert.equal(z.telemetry().state, 'service_missing');
    z.apply({ hostProfile: { radio_start: true } });
    await z.tick();
    assert.equal(z.telemetry().state, 'starting');
    assert.ok(fs.existsSync(path.join(state, 'radio-start')), 'flag for gatecontrol-radio.path');
    fs.rmSync(path.join(state, 'radio-start'));
    await z.tick();
    assert.equal(fs.existsSync(path.join(state, 'radio-start')), false, 'at most every 10 minutes');
    alive('exit 1');
    assert.equal(z.telemetry().state, 'error');
    assert.equal(z.telemetry().error.code, 'deconz_exit');
  });

  it('old compose without /gc-radio: deCONZ of the image counts as "image"', async () => {
    const z = new Zigbee({ client: fakeDeconz(), stateDir: state, ctlDir: path.join(ctl, 'missing'), now: () => clock });
    z.apply({ mode: null, sticks: sys.sticks, hostProfile: null });
    await z.tick();
    assert.equal(z.telemetry().service, 'image');
    assert.equal(z.telemetry().state, 'running');
    assert.equal(await z.unlock(), 'accepted');
  });

  it('helpers: macOf, devicesOf', () => {
    assert.equal(macOf('00:15:8D:00:01:02:03:04-01-0402'), '00:15:8d:00:01:02:03:04');
    assert.equal(macOf('clip'), null);
    assert.equal(devicesOf(null, undefined).size, 0);
  });
});

// ─── BLE-Scanner ─────────────────────────────────────────────────────────

function fakeSpawn() {
  const children = [];
  const fn = (bin, args) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.args = args;
    c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 0)); };
    children.push(c);
    return c;
  };
  return { fn, children };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('radio: BLE scanner', () => {
  it('runs the helper for the first adapter, keeps known sensors, reports them', async () => {
    const sp = fakeSpawn();
    const posts = [];
    const reporter = { post: async (p, b) => { posts.push([p, b]); return { ok: true, status: 202 }; } };
    let clock = 1_800_000_000_000;
    const s = new BleScanner({ reporter, now: () => clock, spawnFn: sp.fn });
    s.apply({ enabled: true, adapters: [{ name: 'hci1', bus: 'usb', model: 'CSR' }] });
    assert.deepEqual(sp.children[0].args, ['1']);
    const out = sp.children[0].stdout;
    out.write('S ready legacy hci1\n');
    out.write('A A4:C1:38:11:22:33 0 -71 ' + adv(0x181a, [0xa4, 0xc1, 0x38, 0x11, 0x22, 0x33, 0x00, 0x59, 64, 82, 0x0b, 0x86, 1]).toString('hex') + '\n');
    out.write('A 11:22:33:44:55:66 1 -40 0201060aff4c0010050b1c\n');
    out.write('A bogus\n');
    await tick();
    const t = s.telemetry();
    assert.equal(t.state, 'running');
    assert.equal(t.mode, 'legacy');
    assert.equal(t.sensors, 1);
    await s.report();
    assert.equal(posts.length, 1);
    assert.equal(posts[0][0], '/api/v1/gateway/radio/ble');
    assert.deepEqual(posts[0][1].sensors[0].values, { temperature: 8.9, humidity: 64, battery: 82, voltage: 2.95 });
    assert.equal(posts[0][1].sensors[0].rssi, -71);
    assert.deepEqual(posts[0][1].adapter, { name: 'hci1', bus: 'usb' });
    clock += 5_000;
    assert.equal(await s.report(), null, 'nothing new, not due');
    s.stop();
    await tick();
    assert.equal(sp.children[0].killed, true);
    assert.equal(s.telemetry().state, 'off');
  });

  it('helper error → error with a reason, restart later; no adapter → no_adapter', async () => {
    const sp = fakeSpawn();
    const s = new BleScanner({ reporter: null, spawnFn: sp.fn });
    s.apply({ enabled: true, adapters: [] });
    assert.equal(s.telemetry().state, 'no_adapter');
    assert.equal(sp.children.length, 0);
    s.apply({ enabled: true, adapters: [{ name: 'hci0', bus: 'builtin' }] });
    sp.children[0].stdout.write('E bind 19\n');
    await tick();
    assert.equal(s.telemetry().state, 'error');
    assert.equal(s.telemetry().error.code, 'no_adapter');
    assert.ok(s.restartTimer, 'restart planned');
    s.stop();
  });
});

// ─── Dienst, Config, Routen ─────────────────────────────────────────────

describe('radio: service, config, routes', () => {
  it('normalizeRadio / features.radio', () => {
    const off = { stack: 'deconz', thread: false, bleKeys: null };
    assert.deepEqual(normalizeRadio(undefined), { zigbee: null, ble: false, ...off });
    assert.deepEqual(normalizeRadio({ zigbee: 'yes', ble: 1, stack: 'zha', thread: 'yes', bleKeys: 'XYZ' }), { zigbee: null, ble: false, ...off });
    assert.deepEqual(normalizeRadio({ zigbee: false, ble: true }), { zigbee: false, ble: true, ...off });
    assert.deepEqual(normalizeRadio({ zigbee: true, stack: 'zigbee2mqtt', thread: true, bleKeys: 'abcdef0123456789' }),
      { zigbee: true, ble: false, stack: 'zigbee2mqtt', thread: true, bleKeys: 'abcdef0123456789' });
    assert.deepEqual(normalizeFeatures(undefined).radio, { zigbee: null, ble: false, ...off });
    assert.deepEqual(normalizeFeatures({ radio: { zigbee: true } }).radio, { zigbee: true, ble: false, ...off });
  });

  it('RadioService: telemetry stays small and names sticks, Thread and Bluetooth', async () => {
    const sp = fakeSpawn();
    const ctl = tmp('gc-ctl-');
    const r = new RadioService({
      stateDir: tmp('gc-st-'), ctlDir: ctl, client: fakeDeconz(),
      sysRoot: makeSysfs({ usb: [CONBEE2, ZBT1], bt: [{ name: 'hci0' }] }),
      ble: new BleScanner({ reporter: null, spawnFn: sp.fn }),
    });
    await r.apply({ zigbee: null, ble: true });
    const t = r.featureTelemetry();
    r.stop();
    assert.equal(t.enabled, true);
    assert.deepEqual(t.sticks.map((s) => s.kind), ['zigbee', 'multi', 'bluetooth']);
    assert.deepEqual({ sticks: t.thread.sticks, models: t.thread.models, otbr: t.thread.otbr, state: t.thread.state }, { sticks: 1, models: ['Home Assistant Connect ZBT-1'], otbr: false, state: 'off' });
    assert.deepEqual(t.sticks.map((s) => s.use), ['deconz', null, null], 'the ConBee serves deCONZ');
    assert.equal(t.sticks[1].z2m, 'ember');
    assert.equal(t.sticks[1].thread, true);
    assert.equal(t.zigbee.stack, 'deconz');
    assert.equal(t.zigbee2mqtt, null);
    assert.equal(t.ble.adapter.name, 'hci0');
    assert.ok(JSON.stringify(t).length < 3000, 'heartbeat limit 16 KB');
    assert.ok(fs.existsSync(path.join(ctl, 'zigbee.env')));
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
  it('routes: status, pair (validated), unlock, retry; disabled without a radio part', async () => {
    const seen = [];
    const radio = {
      status: async () => ({ zigbee: { state: 'running' } }),
      requestPair: async (b) => { seen.push(b.seconds); return 'accepted'; },
      requestUnlock: async () => 'not_running',
      requestRetry: async () => 'accepted',
    };
    const a = await serve(radio);
    try {
      assert.deepEqual(await post(a, '/api/radio/status', {}), { status: 200, body: { radio: { zigbee: { state: 'running' } } } });
      assert.equal((await post(a, '/api/radio/zigbee/pair', {})).status, 202);
      assert.equal((await post(a, '/api/radio/zigbee/pair', { seconds: 120 })).status, 202);
      assert.equal((await post(a, '/api/radio/zigbee/pair', { seconds: 5 })).status, 400);
      assert.equal((await post(a, '/api/radio/zigbee/pair', { seconds: '180' })).status, 400);
      assert.deepEqual(seen, [undefined, 120]);
      assert.deepEqual(await post(a, '/api/radio/zigbee/unlock', {}), { status: 409, body: { error: 'not_running' } });
      assert.equal((await post(a, '/api/radio/zigbee/retry', {})).status, 202);
    } finally { a.close(); }
    const none = await serve(undefined);
    try {
      assert.equal((await post(none, '/api/radio/status', {})).status, 503);
      assert.equal((await post(none, '/api/radio/zigbee/pair', {})).status, 503);
    } finally { none.close(); }
  });
});
