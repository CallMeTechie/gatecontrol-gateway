'use strict';

// Drucker finden wie im echten LAN: Geräte, die nur den PTR schicken, SRV/TXT/A
// in getrennten Paketen und in anderer Schreibweise; das Gateway neben dem
// mDNS-Dienst des Hosts (avahi auf Synology); Diagnose für die Oberfläche.

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const os = require('node:os');
const discovery = require('../src/print/discovery');
const { HP, hpAnswer, hpPackets, fakeMdnsFactory, startFakeMdnsResponder, mdnsPacket } = require('./helpers/fakePrinter');

const HP_ID = 'u:' + HP.uuid.replace(/-/g, '');
const own = (ip) => ip.startsWith('192.168.1.');

test('HP 8720: PTR, SRV/TXT und A in getrennten Paketen, andere Schreibweise → ein Gerät mit Drucker und Scanner', () => {
  const services = discovery.mapServices(hpPackets());
  assert.deepEqual(services.map((s) => [s.kind, s.scheme, s.port, s.path]).sort(), [
    ['printer', 'ipp', 631, 'ipp/print'], ['printer', 'ipps', 443, 'ipp/print'], ['scanner', 'http', 80, 'eSCL'],
  ]);
  // die LAN-Adresse vor der Wi-Fi-Direct-Adresse, wenn nur das LAN erlaubt ist
  const devs = discovery.mergeDevices(services, own);
  assert.equal(devs.length, 1);
  const d = devs[0];
  assert.equal(d.id, HP_ID);
  assert.equal(d.ip, '192.168.1.57');
  assert.equal(d.name, HP.name);
  assert.equal(d.model, HP.model);
  assert.deepEqual(d.ipp, { scheme: 'ipp', host: '192.168.1.57', port: 631, path: 'ipp/print' });
  assert.deepEqual(d.escl, { scheme: 'http', host: '192.168.1.57', port: 80, path: 'eSCL' });
  assert.equal(d.hints.duplex, true);
});

test('Nachfragen: was fehlt, wird gezielt gefragt (SRV/TXT je Dienst, A je Rechner) – und nichts, wenn alles da ist', () => {
  const ptrOnly = hpPackets().slice(0, 3);
  const q1 = discovery.followUps(discovery.collect(ptrOnly));
  assert.equal(q1.filter((q) => q.type === 'SRV').length, 3);
  assert.equal(q1.filter((q) => q.type === 'TXT').length, 3);
  assert.equal(q1.filter((q) => q.type === 'A').length, 0);
  // SRV da, A fehlt (nur AAAA) → nach A fragen; der Dienst zählt als „ohne IPv4“
  const noA = hpPackets().slice(0, 9);
  noA.push({ answers: [{ type: 'AAAA', name: HP.host, data: 'fe80::1' }] });
  const q2 = discovery.followUps(discovery.collect(noA));
  assert.deepEqual(q2, [{ name: HP.host.toLowerCase(), type: 'A' }]);
  const r = discovery.analyze(noA, own);
  assert.deepEqual(r.devices, []);
  assert.deepEqual(r.stats.dropped, { no_ipv4: 1 });
  assert.deepEqual(discovery.followUps(discovery.collect(hpPackets())), []);
  // Abschied (TTL 0) zählt nicht
  const bye = hpPackets();
  for (const p of bye) for (const rec of p.answers) if (rec.type === 'A') rec.ttl = 0;
  assert.deepEqual(discovery.analyze(bye, own).devices, []);
});

test('Diagnose: anderes Subnetz und öffentliche Adressen verworfen (mit Grund und Adresse), gerettete Dienste zählen nicht', () => {
  const pub = mdnsPacket({ ip: '8.8.4.4', name: 'Fremd', uuid: '' });
  for (const rec of pub.additionals) { if (rec.type === 'A') rec.name = 'fremd.local'; if (rec.type === 'SRV') rec.data.target = 'fremd.local'; }
  const r = discovery.analyze([mdnsPacket({ ip: '10.9.9.9' }), pub, ...hpPackets()], own);
  assert.deepEqual(r.devices.map((d) => d.id), [HP_ID]);
  assert.deepEqual(r.stats.dropped, { other_subnet: 1, not_private: 1 });
  assert.deepEqual(r.stats.hosts, [
    { ip: '10.9.9.9', reason: 'other_subnet', name: 'HP OfficeJet 8020 [A1B2C3]' },
    { ip: '8.8.4.4', reason: 'not_private', name: 'Fremd' },
  ]);
  assert.equal(r.stats.devices, 1);
  assert.equal(r.stats.responses, 12);
  // nur der PTR – nie aufgelöst
  const s = discovery.analyze(hpPackets().slice(0, 3), own).stats;
  assert.deepEqual([s.services, s.resolved, s.devices, s.dropped], [3, 0, 0, { incomplete: 1 }]);
});

test('Instanznamen in anderer Schreibweise und mit Punkt am Ende', () => {
  assert.equal(discovery.typeOf('X._IPP._TCP.LOCAL.'), '_ipp._tcp.local');
  assert.equal(discovery.instanceLabel('Drucker\\032Büro._IPP._tcp.local'), 'Drucker Büro');
  const p = mdnsPacket();
  for (const rec of [...p.answers, ...p.additionals]) {
    rec.name = rec.name.toUpperCase();
    if (rec.type === 'PTR') rec.data = rec.data.toUpperCase();
  }
  const d = discovery.mergeDevices(discovery.mapServices([p]));
  assert.equal(d.length, 1);
  assert.ok(d[0].ipp && d[0].escl);
  assert.equal(d[0].model, 'HP OfficeJet 8020 series');
});

test('browse: Port 5353 an 0.0.0.0 gebunden (nicht an die LAN-Adresse) plus Legacy-Unicast-Frage; Nachfragen finden den HP', async () => {
  const { factory, log } = fakeMdnsFactory();
  const diag = { errors: [], responders: new Set() };
  const packets = await discovery.browse({ ifaceIp: '192.168.1.10', timeoutMs: 120, factory, diag });
  const mdns = log.sockets.find((x) => x.way === 'mdns');
  assert.equal(mdns.bind, '0.0.0.0');
  assert.equal(mdns.interface, '192.168.1.10');
  assert.equal(mdns.port, 5353);
  assert.equal(log.sockets.find((x) => x.way === 'legacy').port, 0);
  for (const q of log.queries) assert.deepEqual(q.to, { port: 5353, address: '224.0.0.251' });
  assert.ok(log.queries.some((q) => q.type === 'SRV'), 'SRV nachgefragt');
  assert.ok(log.queries.some((q) => q.type === 'A' && q.name.toLowerCase() === HP.host.toLowerCase()), 'A nachgefragt');
  const r = discovery.analyze(packets, own);
  assert.deepEqual(r.devices.map((d) => d.id), [HP_ID]);
  assert.deepEqual([...diag.responders], ['192.168.1.57']);
  assert.deepEqual(diag.errors, []);
});

test('browse: Port 5353 belegt (ohne SO_REUSEADDR) → über die Legacy-Frage trotzdem gefunden, Fehler in der Diagnose', async () => {
  const { factory } = fakeMdnsFactory({ fail: { mdns: 'EADDRINUSE' } });
  const diag = { errors: [], responders: new Set() };
  const packets = await discovery.browse({ ifaceIp: '192.168.1.10', timeoutMs: 120, factory, diag });
  assert.deepEqual(discovery.analyze(packets, own).devices.map((d) => d.id), [HP_ID]);
  assert.deepEqual(diag.errors, ['mdns_port_busy']);
  // beide kaputt → sofort fertig, leer
  const both = fakeMdnsFactory({ fail: { mdns: 'EADDRINUSE', legacy: 'EACCES' } });
  const d2 = { errors: [], responders: new Set() };
  assert.deepEqual(await discovery.browse({ ifaceIp: '192.168.1.10', timeoutMs: 5000, factory: both.factory, diag: d2 }), []);
  assert.deepEqual(d2.errors, ['mdns_port_busy', 'legacy_failed']);
  assert.deepEqual(await discovery.browse({ ifaceIp: null }), []);
});

// ─── echte Sockets ─────────────────────────────────────────────────────

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/** Kommt Multicast auf dieser Maschine über die Schnittstelle zurück (Loopback)? Sonst ist der Test sinnlos. */
function multicastLoops(ifaceIp, port) {
  return new Promise((resolve) => {
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const tx = dgram.createSocket('udp4');
    const end = (ok) => { clearTimeout(t); try { rx.close(); } catch (_e) { /* zu */ } try { tx.close(); } catch (_e) { /* zu */ } resolve(ok); };
    const t = setTimeout(() => end(false), 500);
    rx.on('error', () => end(false));
    tx.on('error', () => end(false));
    rx.on('message', () => end(true));
    rx.bind(port, '0.0.0.0', () => {
      try { rx.addMembership('224.0.0.251', ifaceIp); } catch (_e) { end(false); return; }
      tx.bind(0, () => {
        try { tx.setMulticastInterface(ifaceIp); tx.setMulticastLoopback(true); tx.send('x', port, '224.0.0.251'); } catch (_e) { end(false); }
      });
    });
  });
}

const IFACE = lanIp();
const PORT = 20000 + Math.floor(Math.random() * 20000);

test('echte Sockets: Antworten nur per Multicast (wie die meisten Drucker) kommen an', async (t) => {
  if (!IFACE || !await multicastLoops(IFACE, PORT)) { t.skip('kein Multicast auf dieser Maschine'); return; }
  const responder = await startFakeMdnsResponder({ ifaceIp: IFACE, port: PORT, legacy: false });
  try {
    const diag = { errors: [], responders: new Set() };
    const packets = await discovery.browse({ ifaceIp: IFACE, timeoutMs: 1500, port: PORT, diag });
    const r = discovery.analyze(packets, own);
    assert.deepEqual(r.devices.map((d) => d.id), [HP_ID], 'mit einem an die LAN-Adresse gebundenen Socket käme keine Antwort an');
    assert.ok(responder.seen.some((q) => q.type === 'A' && !q.legacy), 'A per Multicast nachgefragt');
  } finally { await responder.close(); }
});

test('echte Sockets: ein Gerät, das nur Legacy-Unicast beantwortet, wird auch gefunden', async (t) => {
  const port = PORT + 1;
  if (!IFACE || !await multicastLoops(IFACE, port)) { t.skip('kein Multicast auf dieser Maschine'); return; }
  const responder = await startFakeMdnsResponder({ ifaceIp: IFACE, port, multicast: false });
  try {
    const packets = await discovery.browse({ ifaceIp: IFACE, timeoutMs: 1500, port });
    assert.deepEqual(discovery.analyze(packets, own).devices.map((d) => d.id), [HP_ID]);
    assert.ok(responder.seen.every((q) => q.legacy));
  } finally { await responder.close(); }
});

test('hpAnswer kennt nur seine eigenen Namen', () => {
  assert.equal(hpAnswer({ name: '_http._tcp.local', type: 'PTR' }), null);
  assert.equal(hpAnswer({ name: 'other.local', type: 'A' }), null);
});
