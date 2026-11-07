'use strict';

// Funksticks von Hand festlegen (docs/radio.md „Sticks von Hand festlegen“,
// Capability radio-stick-assign): feste Kennung je Stick (by-id-Name aus
// /dev/serial/by-id oder aus sysfs gebaut, sonst die USB-Buchse), die Wahl aus
// features.radio.sticks geht vor, Hinweise statt Sperren, kein Ausweichen auf
// andere Sticks, wenn der gewählte fehlt. Echte Sticks gibt es hier nicht –
// sysfs und /dev/serial/by-id sind Attrappen.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detect, ID_RE, udevEnc, usableSerial } = require('../src/radio/detect');
const { normalizeRadio } = require('../src/radio/config');
const { RadioService, assignSticks } = require('../src/radio/radio');
const { ThreadBorderRouter, createOtbrClient } = require('../src/radio/thread');
const { BleKeyStore } = require('../src/radio/blekeys');
const { CAPABILITIES } = require('../src/features/manager');
const { makeSysfs, makeDevById } = require('./helpers/fakeSysfs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NO_DEV = path.join(os.tmpdir(), 'gc-no-dev-here');

// Seriennummern zur Laufzeit (keine echten Geräte)
const SER = { conbee: 'DE' + '2123456', zbt: '9e2a' + 'dbd75b8beb11', dongleE: '2024' + '0123', dongleP: 'a0b1' + 'c2d3', nrf: 'F1E2' + 'D3C4B5' };
const CONBEE2 = { port: '1-1.2', vid: '1cf1', pid: '0030', manufacturer: 'dresden elektronik ingenieurtechnik GmbH', product: 'ConBee II', serial: SER.conbee, tty: 'ttyACM0', dev: '166:0' };
const ZBT1 = { port: '1-1.3', vid: '10c4', pid: 'ea60', manufacturer: 'Nabu Casa', product: 'Home Assistant Connect ZBT-1', serial: SER.zbt, tty: 'ttyUSB0', dev: '188:0' };
const DONGLE_E = { port: '1-1.4', vid: '1a86', pid: '55d4', manufacturer: 'ITEAD', product: 'SONOFF Zigbee 3.0 USB Dongle Plus V2', serial: SER.dongleE, tty: 'ttyACM1', dev: '166:1' };
const DONGLE_P = { port: '1-1.5', vid: '10c4', pid: 'ea60', manufacturer: 'ITEAD', product: 'Sonoff Zigbee 3.0 USB Dongle Plus', serial: SER.dongleP, tty: 'ttyUSB1', dev: '188:1' };
const NRF = { port: '1-1.6', vid: '1915', pid: 'cafe', manufacturer: 'Nordic Semiconductor', product: 'nRF528xx OpenThread Device', serial: SER.nrf, tty: 'ttyACM2', dev: '166:2' };

const ID = {
  conbee: `usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_II_${SER.conbee}-if00`,
  zbt: `usb-Nabu_Casa_Home_Assistant_Connect_ZBT-1_${SER.zbt}-if00-port0`,
  dongleE: `usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_${SER.dongleE}-if00`,
  dongleP: `usb-ITEAD_Sonoff_Zigbee_3.0_USB_Dongle_Plus_${SER.dongleP}-if00-port0`,
  nrf: `usb-Nordic_Semiconductor_nRF528xx_OpenThread_Device_${SER.nrf}-if00`,
};

const roots = [];
const sysfs = (usb) => { const r = makeSysfs({ usb }); roots.push(r); return r; };
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

// ─── Feste Kennung ──────────────────────────────────────────────────────

describe('radio sticks: stable ids', () => {
  it('a stick with a serial number gets its by-id name, built from sysfs like udev does', () => {
    const r = detect({ sysRoot: sysfs([CONBEE2, ZBT1, DONGLE_E]), devRoot: NO_DEV });
    assert.deepEqual(r.sticks.map((s) => [s.model, s.id, s.idKind]), [
      ['ConBee II', ID.conbee, 'serial'],
      ['Sonoff ZBDongle-E', ID.dongleE, 'serial'],
      ['Home Assistant Connect ZBT-1', ID.zbt, 'serial'],
    ]);
    for (const s of r.sticks) assert.match(s.id, ID_RE);
  });

  it('/dev/serial/by-id wins when the container sees it (fake by-id links)', () => {
    const real = `usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_${SER.dongleE}-if00`;
    const dev = makeDevById({ [real]: 'ttyACM1', 'usb-evil/../x': 'ttyACM0', [`usb-Other_${SER.conbee}`]: 'sda1' });
    roots.push(dev);
    const r = detect({ sysRoot: sysfs([CONBEE2, DONGLE_E]), devRoot: dev });
    assert.equal(r.sticks.find((s) => s.model === 'Sonoff ZBDongle-E').id, real);
    assert.equal(r.sticks.find((s) => s.model === 'ConBee II').id, ID.conbee, 'no usable link → built from sysfs');
  });

  it('the id stays when the stick comes back on another ttyACM number', () => {
    const a = detect({ sysRoot: sysfs([CONBEE2, DONGLE_E]), devRoot: NO_DEV }).sticks.find((s) => s.model === 'Sonoff ZBDongle-E');
    const b = detect({ sysRoot: sysfs([{ ...DONGLE_E, port: '1-1.1', tty: 'ttyACM3', dev: '166:3' }]), devRoot: NO_DEV }).sticks[0];
    assert.notEqual(a.tty, b.tty);
    assert.equal(a.id, b.id);
  });

  it('no serial, a factory serial like 0001 or two sticks with the same serial → the USB socket', () => {
    const noSer = { ...DONGLE_P, serial: undefined };
    const r = detect({ sysRoot: sysfs([noSer, { ...ZBT1, serial: '0001' }]), devRoot: NO_DEV });
    assert.deepEqual(r.sticks.map((s) => [s.id, s.idKind]), [['port:1-1.3:1.0', 'port'], ['port:1-1.5:1.0', 'port']]);
    const twins = detect({ sysRoot: sysfs([DONGLE_E, { ...DONGLE_E, port: '1-1.7', tty: 'ttyACM4', dev: '166:4' }]), devRoot: NO_DEV }).sticks;
    assert.deepEqual(twins.map((s) => s.id), ['port:1-1.4:1.0', 'port:1-1.7:1.0']);
  });

  it('hostile strings in sysfs end up as a harmless id', () => {
    const r = detect({ sysRoot: sysfs([{ ...CONBEE2, manufacturer: 'dresden elektronik $(reboot)/..', serial: 'DE21\u0007 23;rm -rf' }]), devRoot: NO_DEV });
    assert.match(r.sticks[0].id, ID_RE);
    assert.ok(!/[\s/;$()]/.test(r.sticks[0].id));
    assert.equal(udevEnc('  Nabu  Casa '), 'Nabu_Casa');
    assert.equal(usableSerial('0001'), false);
    assert.equal(usableSerial('AAAAAA'), false);
    assert.equal(usableSerial(SER.zbt), true);
  });

  it('the RaspBee on the GPIO header is uart:ttyAMA0', () => {
    const sys = makeSysfs({ uart: [{ tty: 'ttyAMA0', dev: '204:64' }] });
    roots.push(sys);
    const r = detect({ sysRoot: sys, devRoot: NO_DEV, hostProfile: { radios: [{ kind: 'zigbee', device: '/dev/ttyAMA0', type: 'raspbee2', detected: true }] } });
    assert.deepEqual([r.sticks[0].id, r.sticks[0].idKind], ['uart:ttyAMA0', 'uart']);
  });
});

// ─── Einstellung ────────────────────────────────────────────────────────

describe('radio sticks: features.radio.sticks', () => {
  it('only valid entries, the first per id, "auto" is the default and not kept', () => {
    const n = normalizeRadio({ sticks: [
      { id: ID.zbt, use: 'thread' }, { id: ID.zbt, use: 'zigbee' }, { id: ID.conbee, use: 'auto' }, { id: 'port:1-1.5:1.0', use: 'none' },
      { id: '../../etc/passwd', use: 'zigbee' }, { id: 'x'.repeat(129), use: 'zigbee' }, { id: ID.nrf, use: 'zha' }, 'junk', null,
    ] });
    assert.deepEqual(n.sticks, [{ id: ID.zbt, use: 'thread' }, { id: 'port:1-1.5:1.0', use: 'none' }]);
    assert.deepEqual(normalizeRadio({ sticks: 'all' }).sticks, []);
    assert.equal(normalizeRadio({ sticks: Array.from({ length: 40 }, (_, i) => ({ id: 'port:1-' + i, use: 'none' })) }).sticks.length, 16);
  });

  it('the gateway names the capability radio-stick-assign', () => {
    assert.ok(CAPABILITIES.includes('radio-stick-assign'));
  });

  it('assignSticks: the choice wins, automatic only gives sticks without a choice', () => {
    const sticks = detect({ sysRoot: sysfs([DONGLE_E, ZBT1, NRF]), devRoot: NO_DEV }).sticks;
    const auto = assignSticks(sticks, { z2m: true, thread: true, deconzStick: null });
    assert.deepEqual([auto.z2mStick.model, auto.threadStick.model], ['Sonoff ZBDongle-E', 'nRF52840 (OpenThread)']);
    const choices = new Map([[ID.zbt, 'zigbee'], [ID.dongleE, 'thread']]);
    const hand = assignSticks(sticks, { z2m: true, thread: true, deconzStick: null, choices });
    assert.deepEqual([hand.z2mStick.model, hand.threadStick.model], ['Home Assistant Connect ZBT-1', 'Sonoff ZBDongle-E']);
    // "nicht verwenden": der nRF bleibt frei, Thread nimmt dann keinen Stick
    const none = assignSticks(sticks, { z2m: true, thread: true, deconzStick: null, choices: new Map([[ID.nrf, 'none'], [ID.zbt, 'none']]) });
    assert.equal(none.z2mStick.model, 'Sonoff ZBDongle-E');
    assert.equal(none.threadStick, null);
    assert.equal(none.threadBusy, true, 'the only Thread stick left serves Zigbee');
  });
});

// ─── Dienst: Steuerdateien der Wächter ──────────────────────────────────

function fakeMqtt() {
  return {
    available: () => true, brokerEnabled: () => true, localReady: () => true, setLocal() {},
    localSubscribe: () => () => {}, localPublish: async () => {},
  };
}

describe('radio sticks: the service honours the choice in the control files', () => {
  let ctl; let st; let r;
  const unreachable = async () => { throw Object.assign(new Error('x'), { code: 'unreachable' }); };
  function service(usb, extra = {}) {
    ctl = tmp('gc-ctl-'); st = tmp('gc-st-');
    const sys = sysfs(usb);
    r = new RadioService({
      stateDir: st, ctlDir: ctl, sysRoot: sys, devRoot: NO_DEV, getInfra: () => 'eth0',
      client: { probe: unreachable },
      thread: new ThreadBorderRouter({ ctlDir: ctl, client: createOtbrClient({ send: unreachable }), procRoot: '/nonexistent' }),
      keys: new BleKeyStore({ apiToken: 't' }),
      ...extra,
    });
    r.attachMqtt(fakeMqtt());
    return sys;
  }
  const env = (name) => { try { return fs.readFileSync(path.join(ctl, name), 'utf8'); } catch { return null; } };
  const replug = (usb) => { r.sysRoot = sysfs(usb); r.refresh(); };
  afterEach(() => {
    if (r) r.stop();
    for (const d of [ctl, st]) if (d) fs.rmSync(d, { recursive: true, force: true });
    r = null;
  });

  it('zigbee2mqtt and Thread swapped by hand; the device follows the stick to another ttyUSB; telemetry says what serves what', async () => {
    service([DONGLE_E, ZBT1]);
    await r.apply({ stack: 'zigbee2mqtt', thread: true, sticks: [{ id: ID.zbt, use: 'zigbee' }, { id: ID.dongleE, use: 'thread' }] });
    assert.match(env('z2m.env'), /^DEVICE=ttyUSB0\nDEV=188:0\nADAPTER=ember\n/);
    assert.match(env('thread.env'), /^DEVICE=ttyACM1\nDEV=166:1\n/);
    let t = r.featureTelemetry();
    const row = (id) => t.sticks.find((s) => s.id === id);
    assert.deepEqual([row(ID.zbt).choice, row(ID.zbt).use, row(ID.zbt).note], ['zigbee', 'zigbee2mqtt', null]);
    assert.deepEqual([row(ID.dongleE).choice, row(ID.dongleE).use, row(ID.dongleE).note], ['thread', 'thread', null]);
    assert.deepEqual(t.missing, []);
    // umgesteckt: der ZBT-1 kommt als ttyUSB3 wieder
    replug([DONGLE_E, { ...ZBT1, port: '1-1.1', tty: 'ttyUSB3', dev: '188:3' }]);
    assert.match(env('z2m.env'), /^DEVICE=ttyUSB3\nDEV=188:3\n/);
    t = r.featureTelemetry();
    assert.equal(row(ID.zbt).tty, 'ttyUSB3');
    assert.ok(JSON.stringify(t).length < 6000, 'heartbeat stays small');
  });

  it('the chosen stick is missing: the radio waits for it and takes no other stick (not even an automatic one)', async () => {
    service([CONBEE2, DONGLE_E]);
    await r.apply({ stack: 'zigbee2mqtt', thread: true, sticks: [{ id: ID.zbt, use: 'zigbee' }, { id: ID.dongleE, use: 'thread' }] });
    assert.equal(env('z2m.env'), null, 'neither the ConBee (automatic) nor the ZBDongle-E (Thread) for zigbee2mqtt');
    assert.match(env('thread.env'), /^DEVICE=ttyACM1\n/);
    const t = r.featureTelemetry();
    assert.equal(t.zigbee2mqtt.state, 'stick_missing');
    assert.deepEqual(t.missing, [{ id: ID.zbt, use: 'zigbee' }]);
    assert.equal(t.sticks.find((s) => s.model === 'ConBee II').use, null);
  });

  it('Thread waits for its missing stick; Zigbee stays automatic', async () => {
    service([CONBEE2, DONGLE_E]);
    await r.apply({ zigbee: null, thread: true, sticks: [{ id: ID.zbt, use: 'thread' }] });
    assert.match(env('zigbee.env'), /^DEVICE=ttyACM0\n/, 'deCONZ automatic on the ConBee');
    assert.equal(env('thread.env'), null, 'the ZBDongle-E (automatic, RCP) is not taken instead');
    assert.equal(r.featureTelemetry().thread.state, 'stick_missing');
  });

  it('"nicht verwenden": deCONZ does not start on that ConBee; "Automatisch" again → it does', async () => {
    service([CONBEE2]);
    await r.apply({ zigbee: null, sticks: [{ id: ID.conbee, use: 'none' }] });
    assert.equal(env('zigbee.env'), null);
    let t = r.featureTelemetry();
    assert.equal(t.zigbee.state, 'off');
    assert.deepEqual([t.sticks[0].choice, t.sticks[0].use], ['none', null]);
    await r.apply({ zigbee: null, sticks: [] });
    assert.match(env('zigbee.env'), /^DEVICE=ttyACM0\n/);
    t = r.featureTelemetry();
    assert.deepEqual([t.sticks[0].choice, t.sticks[0].use], ['auto', 'deconz']);
  });

  it('hints, not bans: deCONZ on a stick it does not speak is still used ("fit"); a second Zigbee stick stays free ("second")', async () => {
    service([CONBEE2, DONGLE_E]);
    await r.apply({ zigbee: null, sticks: [{ id: ID.dongleE, use: 'zigbee' }, { id: ID.conbee, use: 'zigbee' }] });
    assert.match(env('zigbee.env'), /^DEVICE=ttyACM1\nDEV=166:1\nBAUD=0\n/, 'the stick chosen first for Zigbee (order of the setting, not the tty number)');
    const t = r.featureTelemetry();
    const row = (m) => t.sticks.find((s) => s.model === m);
    assert.deepEqual([row('Sonoff ZBDongle-E').use, row('Sonoff ZBDongle-E').note], ['deconz', 'fit']);
    assert.deepEqual([row('ConBee II').use, row('ConBee II').note], [null, 'second']);
  });

  it('zigbee2mqtt has no adapter for a chosen stick → "unsupported", the stick stays free', async () => {
    service([NRF]);
    await r.apply({ stack: 'zigbee2mqtt', sticks: [{ id: ID.nrf, use: 'zigbee' }] });
    assert.equal(env('z2m.env'), null);
    const t = r.featureTelemetry();
    assert.equal(t.zigbee2mqtt.state, 'unsupported');
    assert.equal(t.sticks[0].note, 'no_adapter');
  });

  it('Thread by hand on a stick the detection does not know as RCP: used, with the hint "fit"; Thread off → "radio_off"', async () => {
    service([DONGLE_P]);
    await r.apply({ thread: true, sticks: [{ id: ID.dongleP, use: 'thread' }] });
    assert.match(env('thread.env'), /^DEVICE=ttyUSB1\nDEV=188:1\nBAUD=460800\nINFRA=eth0\n/);
    assert.equal(r.featureTelemetry().sticks[0].note, 'fit');
    await r.apply({ thread: false, sticks: [{ id: ID.dongleP, use: 'thread' }] });
    assert.equal(env('thread.env'), null);
    assert.deepEqual([r.featureTelemetry().sticks[0].note, r.featureTelemetry().sticks[0].use], ['radio_off', null]);
  });

  it('an older server without features.radio.sticks: everything automatic as before', async () => {
    service([DONGLE_E, ZBT1]);
    await r.apply({ stack: 'zigbee2mqtt', thread: true });
    assert.match(env('z2m.env'), /^DEVICE=ttyACM1\n/);
    assert.match(env('thread.env'), /^DEVICE=ttyUSB0\n/);
    assert.ok(r.featureTelemetry().sticks.every((s) => s.choice === 'auto' && s.note === null));
  });
});
