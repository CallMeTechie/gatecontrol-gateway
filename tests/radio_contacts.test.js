'use strict';

// Fensterkontakte für Edge-Teile (docs/radio.md „Fensterkontakte für Edge-Teile“, Capability radio-contacts):
// Bluetooth- und zigbee2mqtt-Kontakte als gehaltene Nachrichten unter gatecontrol/contacts/#, das Konto-ACL des
// Gateways und die Teile von setLocal (zigbee2mqtt und Kontakte nebeneinander). Alles mit Attrappen.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { ContactFeed, fromBle, fromZ2m, ROOT, REFRESH_MS, FORGET_MS } = require('../src/radio/contacts');
const { Zigbee2Mqtt } = require('../src/radio/z2m');
const { RadioService } = require('../src/radio/radio');
const { MqttManager } = require('../src/edge/mqtt/manager');
const { CAPABILITIES } = require('../src/features/manager');

const T0 = 1_800_000_000_000;

function fakeMqtt() {
  const st = { local: {}, pubs: [], ready: true };
  return {
    st,
    localReady: () => st.ready,
    setLocal: (l, part) => { st.local[part || 'radio'] = l; },
    localPublish: async (t, p, o) => { st.pubs.push([t, p.length ? JSON.parse(p.toString()) : null, o]); },
  };
}

const bleSensor = (mac, values, at) => ({ mac, values, seenAt: new Date(at).toISOString() });

describe('radio: contacts for edge parts', () => {
  it('reads only contacts: Bluetooth window/door/opening, zigbee2mqtt opening (contact false)', () => {
    assert.deepEqual(fromBle(bleSensor('A4:C1:38:00:11:22', { window: true, battery: 90 }, T0)), { id: 'ble-a4c138001122', open: true, seen: T0 });
    assert.deepEqual(fromBle(bleSensor('A4:C1:38:00:11:22', { door: false, opening: false }, T0)), { id: 'ble-a4c138001122', open: false, seen: T0 });
    assert.equal(fromBle(bleSensor('A4:C1:38:00:11:22', { temperature: 21.5 }, T0)), null, 'a thermometer is no contact');
    assert.equal(fromBle({ mac: 'nope', values: { window: true } }), null);
    assert.deepEqual(fromZ2m({ ieee: '0x00158d0001a2b3c4', values: { opening: true }, seen: T0, available: false }), { id: 'z2m-00158d0001a2b3c4', open: true, seen: T0, online: false });
    assert.deepEqual(fromZ2m({ ieee: '0x00158d0001a2b3c4', values: { opening: false }, seen: T0, available: null }), { id: 'z2m-00158d0001a2b3c4', open: false, seen: T0 });
    assert.equal(fromZ2m({ ieee: '0x00158d0001a2b3c4', values: { temperature: 20 } }), null);
    assert.equal(fromZ2m({ ieee: '00:15:8d:00:01:a2:b3:c4', values: { opening: true } }), null);
  });

  it('retained messages: the feature first, every contact, a change at once, the rest every 10 min; reconnect sends all again', async () => {
    let clock = T0;
    let ble = [bleSensor('A4:C1:38:00:11:22', { window: false }, T0)];
    let z2m = [{ ieee: '0x00158d0001a2b3c4', values: { opening: true }, seen: T0 - 60_000, available: true }];
    const feed = new ContactFeed({ now: () => clock, ble: () => ble, z2m: () => z2m });
    const mq = fakeMqtt();
    mq.st.ready = false;
    feed.attach(mq);
    assert.deepEqual(mq.st.local.contacts, { accounts: [], topics: [ROOT + '/#'] }, 'own part of the internal account');
    assert.equal(await feed.tick(), 0, 'no broker yet: nothing sent');
    mq.st.ready = true;
    await feed.tick();
    assert.deepEqual(mq.st.pubs.map((p) => p[0]), [ROOT, `${ROOT}/ble-a4c138001122`, `${ROOT}/z2m-00158d0001a2b3c4`]);
    assert.deepEqual(mq.st.pubs[0][1], { v: 1, feature: 'radio-contacts', sources: ['ble', 'z2m'] });
    assert.deepEqual(mq.st.pubs[1][1], { open: false, since: T0, seen: T0 });
    assert.deepEqual(mq.st.pubs[2][1], { open: true, since: T0 - 60_000, seen: T0 - 60_000, online: true });
    assert.ok(mq.st.pubs.every((p) => p[2].retain === true), 'retained');
    mq.st.pubs = [];
    clock += 5000;
    assert.equal(await feed.tick(), 0, 'nothing changed');
    // the window opens: only that contact, `since` from its report
    ble = [bleSensor('A4:C1:38:00:11:22', { window: true }, clock)];
    await feed.tick();
    assert.deepEqual(mq.st.pubs, [[`${ROOT}/ble-a4c138001122`, { open: true, since: clock, seen: clock }, { qos: 0, retain: true }]]);
    mq.st.pubs = [];
    // zigbee2mqtt goes offline: sent although `open` stays
    z2m = [{ ...z2m[0], available: false }];
    await feed.tick();
    assert.deepEqual(mq.st.pubs.map((p) => [p[0], p[1].online]), [[`${ROOT}/z2m-00158d0001a2b3c4`, false]]);
    mq.st.pubs = [];
    clock += REFRESH_MS;
    await feed.tick();
    assert.equal(mq.st.pubs.length, 2, 'refreshed after 10 min');
    mq.st.pubs = [];
    mq.st.ready = false;
    await feed.tick();
    mq.st.ready = true;
    await feed.tick();
    assert.deepEqual(mq.st.pubs.map((p) => p[0]), [ROOT, `${ROOT}/ble-a4c138001122`, `${ROOT}/z2m-00158d0001a2b3c4`], 'all again after a reconnect');
  });

  it('a contact that stays silent for 24 h is cleared (empty retained message); one that just left the scan is kept', async () => {
    let clock = T0;
    let ble = [bleSensor('A4:C1:38:00:11:22', { door: true }, T0)];
    const feed = new ContactFeed({ now: () => clock, ble: () => ble });
    const mq = fakeMqtt();
    feed.attach(mq);
    await feed.tick();
    mq.st.pubs = [];
    ble = [];
    clock += 60 * 60_000;
    await feed.tick();
    assert.ok(!mq.st.pubs.some((p) => p[1] === null), 'kept: the window may still be open');
    clock = T0 + FORGET_MS + 1;
    await feed.tick();
    assert.deepEqual(mq.st.pubs.at(-1), [`${ROOT}/ble-a4c138001122`, null, { qos: 0, retain: true }]);
    assert.equal(feed.known.size, 0);
  });

  it('a failing publish never throws; the next run sends everything again', async () => {
    const feed = new ContactFeed({ now: () => T0, ble: () => [bleSensor('A4:C1:38:00:11:22', { window: true }, T0)] });
    const mq = fakeMqtt();
    let fail = true;
    const pub = mq.localPublish;
    mq.localPublish = async (...a) => { if (fail) throw new Error('broker gone'); return pub(...a); };
    feed.attach(mq);
    assert.equal(await feed.tick(), 0);
    fail = false;
    await feed.tick();
    assert.deepEqual(mq.st.pubs.map((p) => p[0]), [ROOT, `${ROOT}/ble-a4c138001122`]);
  });

  it('zigbee2mqtt lists its contacts with IEEE address, last report and availability', () => {
    const z = new Zigbee2Mqtt({ now: () => T0 });
    z.devices.set('0x00158d0001a2b3c4', { ieee: '0x00158d0001a2b3c4', caps: {} });
    z.devices.set('0x00158d0001a2b3c5', { ieee: '0x00158d0001a2b3c5', caps: {} });
    z.values.set('0x00158d0001a2b3c4', { opening: false, battery: 80 });
    z.values.set('0x00158d0001a2b3c5', { temperature: 21 });
    z.seen.set('0x00158d0001a2b3c4', T0);
    z.available.set('0x00158d0001a2b3c4', true);
    assert.deepEqual(z.contacts(), [{ ieee: '0x00158d0001a2b3c4', values: { opening: false }, seen: T0, available: true }]);
  });

  it('the radio service feeds Bluetooth only while it is on and zigbee2mqtt only with that stack', () => {
    const r = new RadioService({ now: () => T0 });
    r.ble.list = () => [bleSensor('A4:C1:38:00:11:22', { window: true }, T0)];
    r.z2m.contacts = () => [{ ieee: '0x00158d0001a2b3c4', values: { opening: true }, seen: T0 }];
    assert.equal(r.contacts.current().size, 0);
    r.cfg = { ...r.cfg, ble: true, stack: 'zigbee2mqtt' };
    assert.deepEqual([...r.contacts.current().keys()], ['ble-a4c138001122', 'z2m-00158d0001a2b3c4']);
    const mq = fakeMqtt();
    r.attachMqtt(mq);
    assert.deepEqual(Object.keys(mq.st.local).sort(), ['contacts', 'radio']);
    r.stop();
  });

  it('capability radio-contacts in the heartbeat', () => {
    assert.ok(CAPABILITIES.includes('radio-contacts'));
  });
});

class FakeClient extends EventEmitter {
  constructor() { super(); this.connected = false; this.subs = []; this.pubs = []; }
  async connect() { this.connected = true; }
  async subscribe(f) { this.subs.push(f); return 1; }
  async unsubscribe() {}
  async publish(t, p, o) { this.pubs.push([t, p.toString(), o]); }
  end() { this.connected = false; }
}

describe('MQTT broker: parts of the internal account', () => {
  it('zigbee2mqtt and the contacts set their own topics side by side; each part replaces only its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mqtt-'));
    const fake = new FakeClient();
    const m = new MqttManager({ dir, getLanAddrs: () => ['192.168.1.10'], clientFactory: () => fake });
    try {
      await m.apply({ enabled: true, tls: false, accounts: [], pluginTopics: {} });
      await new Promise((r) => setImmediate(r));
      m.setLocal({ accounts: [{ user: 'gc-zigbee2mqtt', hash: '$7$1$own$own', acl: [{ access: 'readwrite', topic: 'zigbee2mqtt/#' }] }], topics: ['zigbee2mqtt/#'] });
      m.setLocal({ accounts: [], topics: [ROOT + '/#'] }, 'contacts');
      const acl = () => fs.readFileSync(path.join(dir, 'acl'), 'utf8');
      assert.match(acl(), /topic readwrite zigbee2mqtt\/#/);
      assert.match(acl(), /topic readwrite gatecontrol\/contacts\/#/);
      await m.localPublish(`${ROOT}/ble-a4c138001122`, '{"open":true}', { retain: true });
      assert.deepEqual(fake.pubs.at(-1), [`${ROOT}/ble-a4c138001122`, '{"open":true}', { qos: 0, retain: true }]);
      await m.localPublish(ROOT, '{"v":1}', { retain: true });
      m.setLocal({ accounts: [], topics: [] }); // zigbee2mqtt off
      assert.doesNotMatch(acl(), /zigbee2mqtt/);
      assert.match(acl(), /gatecontrol\/contacts\/#/, 'the contacts stay');
      assert.match(fs.readFileSync(path.join(dir, 'passwd'), 'utf8'), /^(?![\s\S]*gc-zigbee2mqtt)/);
      // an edge part reads them only with the topic approved for it (pluginTopics from the state)
      await m.apply({ enabled: true, tls: false, accounts: [], pluginTopics: { 'gatecontrol-smarthome': [ROOT + '/#'] } });
      const caps = () => ({ mqtt: { topics: [ROOT + '/#'] } });
      const r = await m.pluginCall('gatecontrol-smarthome', caps, 'mqtt.subscribe', { topic: ROOT + '/#' }, () => {});
      assert.ok(r.id > 0);
      await assert.rejects(m.pluginCall('other', caps, 'mqtt.subscribe', { topic: ROOT + '/#' }, () => {}), (e) => e.code === 'denied');
    } finally { await m.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
