'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateCaps, validateOptionalCaps, intersectCaps, validateEdgeManifest, compareVersions, multicastAllowed } = require('../src/edge/manifest');
const { makeLanGuard, checkPort, isPrivateNet } = require('../src/edge/lanGuard');
const topics = require('../src/edge/topics');

test('udp: Ports ≥ 1024, nie 5353; Multicast nur 224/4 ohne 224.0.0.0/24 (außer mDNS)', () => {
  assert.deepStrictEqual(validateCaps({ udp: { ports: [5683, 5683], multicast: ['224.0.1.187'] } }).udp, { ports: [5683], multicast: ['224.0.1.187'] });
  for (const bad of [[80], [1023], [5353], [70000], ['5683']]) assert.throws(() => validateCaps({ udp: { ports: bad } }), /udp\.ports/);
  for (const g of ['224.0.0.1', '224.0.0.252', '10.0.0.1', '240.0.0.1', 'x']) assert.strictEqual(multicastAllowed(g), false, g);
  for (const g of ['224.0.0.251', '224.0.1.187', '239.255.255.250']) assert.strictEqual(multicastAllowed(g), true, g);
  assert.throws(() => validateCaps({ udp: { ports: [5683], multicast: ['224.0.0.1'] } }), /multicast/);
});

test('mdns, tcp, http, mqtt, serial; unbekannte Fähigkeit wird abgelehnt', () => {
  assert.deepStrictEqual(validateCaps({ mdns: { services: ['_shelly._tcp'] } }).mdns, { services: ['_shelly._tcp'] });
  assert.throws(() => validateCaps({ mdns: { services: ['shelly'] } }));
  assert.deepStrictEqual(validateCaps({ tcp: { lan: true }, http: { lan: false } }), { tcp: { lan: true }, http: { lan: false } });
  assert.throws(() => validateCaps({ tcp: { lan: 'yes' } }));
  assert.throws(() => validateCaps({ tcp: { lan: true, wan: true } }));
  assert.deepStrictEqual(validateCaps({ mqtt: { topics: ['shellies/#'] } }).mqtt, { topics: ['shellies/#'] });
  for (const t of ['#', '+/x', '$SYS/#', 'a/#/b', 'a+b']) assert.throws(() => validateCaps({ mqtt: { topics: [t] } }), t);
  assert.throws(() => validateCaps({ mqtt: { topics: Array.from({ length: 17 }, (_, i) => `t${i}`) } }));
  assert.deepStrictEqual(validateCaps({ serial: ['zigbee'] }).serial, ['zigbee']);
  assert.throws(() => validateCaps({ serial: ['/dev/ttyUSB0'] }));
  assert.throws(() => validateCaps({ shell: true }), /unknown capability/);
  assert.deepStrictEqual(validateCaps(undefined), {});
});

test('wirksam = Manifest ∩ Genehmigung', () => {
  const m = validateCaps({ udp: { ports: [5683, 40000], multicast: ['224.0.1.187'] }, tcp: { lan: true }, mqtt: { topics: ['a/#', 'b/#'] }, http: { lan: true } });
  const a = validateCaps({ udp: { ports: [5683, 41000], multicast: [] }, tcp: { lan: true }, mqtt: { topics: ['b/#', 'c/#'] }, mdns: { services: ['_x._tcp'] } });
  const e = intersectCaps(m, a);
  assert.deepStrictEqual(e.udp, { ports: [5683], multicast: [] });
  assert.deepStrictEqual(e.tcp, { lan: true });
  assert.deepStrictEqual(e.mqtt, { topics: ['b/#'] });
  assert.strictEqual(e.http, undefined, 'nicht genehmigt');
  assert.strictEqual(e.mdns, undefined, 'nicht verlangt');
});

test('optionalCapabilities (MQTT): nie doppelt, höchstens 16 zusammen', () => {
  const base = { id: 'x', version: '1.0.0' };
  const edge = (extra) => ({ ...base, edge: { entry: 'edge/index.js', capabilities: { mqtt: { topics: ['shellies/#', 'tasmota/#'] } }, ...extra } });
  const ok = validateEdgeManifest(edge({ optionalCapabilities: { mqtt: { topics: ['zigbee2mqtt/#', 'zigbee2mqtt/#'] } } }));
  assert.deepStrictEqual(ok.optionalCapabilities, { mqtt: { topics: ['zigbee2mqtt/#'] } });
  assert.deepStrictEqual(ok.capabilities.mqtt, { topics: ['shellies/#', 'tasmota/#'] }, 'Pflicht unverändert');
  // ältere Manifeste ohne den Schlüssel
  assert.deepStrictEqual(validateEdgeManifest(edge({})).optionalCapabilities, {});
  assert.deepStrictEqual(validateEdgeManifest(edge({ optionalCapabilities: {} })).optionalCapabilities, {});
  // ohne Pflicht-MQTT nur optional
  assert.deepStrictEqual(validateEdgeManifest({ ...base, edge: { entry: 'e/i.js', optionalCapabilities: { mqtt: { topics: ['a/#'] } } } }).optionalCapabilities, { mqtt: { topics: ['a/#'] } });
  const reject = (opt, re) => assert.throws(() => validateEdgeManifest(edge({ optionalCapabilities: opt })), (e) => e.code === 'bad_caps' && re.test(e.message), JSON.stringify(opt));
  // andere Schlüssel (mdns, http, serial, unbekannte eines neueren Servers) werden übergangen – sie gelten nie
  assert.deepStrictEqual(validateEdgeManifest(edge({ optionalCapabilities: { http: { lan: true }, mdns: { services: ['_x._tcp'] }, future: 1 } })).optionalCapabilities, {});
  reject({ mqtt: { topics: ['a/#'], qos: 1 } }, /only "topics" can be optional/);
  reject({ mqtt: { topics: ['#'] } }, /optionalCapabilities\.mqtt\.topics: #/);
  reject({ mqtt: { topics: 'a/#' } }, /optionalCapabilities\.mqtt\.topics/);
  reject({ mqtt: { topics: ['tasmota/#'] } }, /tasmota\/# is already in edge\.capabilities/);
  reject({ mqtt: { topics: Array.from({ length: 15 }, (_, i) => `t${i}/#`) } }, /at most 16 topics together/);
  reject([], /must be an object/);
  // 14 + 2 = 16 geht
  assert.strictEqual(validateEdgeManifest(edge({ optionalCapabilities: { mqtt: { topics: Array.from({ length: 14 }, (_, i) => `t${i}/#`) } } })).optionalCapabilities.mqtt.topics.length, 14);
  assert.deepStrictEqual(validateOptionalCaps(undefined, {}), {});
});

test('wirksam mit optionalen Topics: (Pflicht ∪ optional) ∩ state – entzogen fällt heraus', () => {
  const req = validateCaps({ mqtt: { topics: ['shellies/#', 'tasmota/#'] }, tcp: { lan: true } });
  const opt = { mqtt: { topics: ['zigbee2mqtt/#'] } };
  // Server schickt das bestätigte optionale Topic mit
  const confirmed = validateCaps({ mqtt: { topics: ['shellies/#', 'tasmota/#', 'zigbee2mqtt/#', 'fremd/#'] }, tcp: { lan: true } });
  assert.deepStrictEqual(intersectCaps(req, confirmed, opt).mqtt, { topics: ['shellies/#', 'tasmota/#', 'zigbee2mqtt/#'] }, 'fremd/# hat das Paket nie verlangt');
  assert.deepStrictEqual(intersectCaps(req, confirmed, opt).tcp, { lan: true });
  // nicht (mehr) bestätigt
  const revoked = validateCaps({ mqtt: { topics: ['shellies/#', 'tasmota/#'] }, tcp: { lan: true } });
  assert.deepStrictEqual(intersectCaps(req, revoked, opt).mqtt, { topics: ['shellies/#', 'tasmota/#'] });
  // ohne optionale wie bisher
  assert.deepStrictEqual(intersectCaps(req, confirmed).mqtt, { topics: ['shellies/#', 'tasmota/#'] });
  assert.deepStrictEqual(intersectCaps(req, confirmed, {}).mqtt, { topics: ['shellies/#', 'tasmota/#'] });
  // nur optionale MQTT-Topics im Manifest
  assert.deepStrictEqual(intersectCaps({}, confirmed, opt).mqtt, { topics: ['zigbee2mqtt/#'] });
  assert.strictEqual(intersectCaps({}, {}, opt).mqtt, undefined, 'ohne Genehmigung nichts');
  // Eingaben bleiben unverändert
  assert.deepStrictEqual(req.mqtt, { topics: ['shellies/#', 'tasmota/#'] });
});

test('Manifest edge: entry im Unterordner, memoryMb 16–256, minGateway', () => {
  const base = { id: 'x', version: '1.0.0' };
  const ok = validateEdgeManifest({ ...base, edge: { entry: 'edge/index.js', memoryMb: 64, minGateway: '1.0.0' } }, { gatewayVersion: '1.18.0' });
  assert.strictEqual(ok.entryDir, 'edge');
  assert.strictEqual(ok.memoryMb, 64);
  assert.strictEqual(validateEdgeManifest({ ...base, edge: { entry: 'edge/a.js' } }).memoryMb, 48);
  for (const entry of ['index.js', '../edge/x.js', 'edge/x.sh', '/abs/x.js', 'edge/.hidden.js']) {
    assert.throws(() => validateEdgeManifest({ ...base, edge: { entry } }), entry);
  }
  for (const memoryMb of [8, 512, 1.5]) assert.throws(() => validateEdgeManifest({ ...base, edge: { entry: 'e/i.js', memoryMb } }));
  assert.throws(() => validateEdgeManifest({ ...base }), (e) => e.code === 'no_edge');
  assert.throws(() => validateEdgeManifest({ ...base, edge: { entry: 'e/i.js', minGateway: '2.0.0' } }, { gatewayVersion: '1.20.0' }), (e) => e.code === 'gateway_too_old');
});

test('compareVersions', () => {
  assert.strictEqual(compareVersions('1.20.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('1.20.0', '1.20.0'), 0);
  assert.strictEqual(compareVersions('1.20.0-beta.1', '1.20.0'), -1);
  assert.strictEqual(compareVersions('1.2.3', '2.0.0'), -1);
});

test('LAN-Grenzen: nur IPv4 in den LAN-Subnetzen, nie Tunnel, Server, Netzadresse', () => {
  const g = makeLanGuard({ getSubnets: () => ['192.168.1.0/24', '10.20.0.0/16'], tunnelIp: '10.8.0.5', serverAddrs: () => ['192.168.1.200'] });
  for (const ip of ['192.168.1.1', '192.168.1.42', '192.168.1.255', '10.20.3.4']) assert.strictEqual(g.allowed(ip), true, ip);
  for (const ip of ['192.168.2.1', '8.8.8.8', '127.0.0.1', '10.8.0.5', '10.8.0.1', '192.168.1.200', '192.168.1.0', 'nas.local', '::1', 'fe80::1', '']) {
    assert.strictEqual(g.allowed(ip), false, ip);
  }
  assert.throws(() => g.check('8.8.8.8'), (e) => e.code === 'denied');
  // Tunnel-Adresse im LAN-Bereich bleibt gesperrt
  const g2 = makeLanGuard({ getSubnets: () => ['10.0.0.0/8'], tunnelIp: () => '10.8.0.5' });
  assert.strictEqual(g2.allowed('10.8.0.5'), false);
  assert.strictEqual(g2.allowed('10.8.0.9'), true);
  // Multicast nur mit Fähigkeit
  assert.strictEqual(g.allowed('224.0.1.187'), false);
  assert.strictEqual(g.allowed('224.0.1.187', { multicast: ['224.0.1.187'] }), true);
  for (const c of ['10.0.0.0/8', '172.16.0.0/12', '172.31.5.0/24', '192.168.1.0/24']) assert.ok(isPrivateNet(c), c);
  for (const c of ['192.0.2.0/24', '172.32.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '8.8.8.0/24']) assert.ok(!isPrivateNet(c), c);
  assert.throws(() => checkPort(0));
  assert.throws(() => checkPort(65536));
  assert.strictEqual(checkPort(443), 443);
});

test('MQTT-Filter: matches/covers', () => {
  assert.ok(topics.matches('shellies/#', 'shellies/x/relay/0'));
  assert.ok(topics.matches('shellies/+/relay/0', 'shellies/x/relay/0'));
  assert.ok(!topics.matches('shellies/+', 'shellies/x/relay'));
  assert.ok(topics.matches('a/#', 'a'));
  assert.ok(!topics.matches('#', '$SYS/broker'));
  assert.ok(topics.covers('shellies/#', 'shellies/+/relay/#'));
  assert.ok(topics.covers('shellies/+/relay', 'shellies/x/relay'));
  assert.ok(!topics.covers('shellies/+/relay', 'shellies/#'));
  assert.ok(!topics.covers('shellies/x', 'shellies/+'));
  assert.ok(!topics.covers('a/b', 'a/b/c'));
  assert.ok(topics.validTopic('a/b'));
  assert.ok(!topics.validTopic('a/+'));
});
