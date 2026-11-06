'use strict';

// `manual`-Adressen (Drucker, die mDNS nicht findet, oder in einem anderen
// privaten Subnetz) und die Diagnose der Suche, die der Server anzeigt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ippLib = require('../src/print/ipp');
const esclLib = require('../src/print/escl');
const { PrintService } = require('../src/print/print');
const { startFakePrinter, mdnsPacket, hpPackets, HP } = require('./helpers/fakePrinter');

const local = (port) => (ep) => ({ ...ep, host: '127.0.0.1', port });

function reporter() {
  const posts = [];
  return { posts, post: async (p, body) => { posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return { ok: true, status: 200 }; } };
}
const client = { jobs: async () => ({ changed: false }), file: async () => {}, page: async () => {} };

function make(extra) {
  const rep = reporter();
  const ps = new PrintService({
    reporter: rep, client, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-print-man-')),
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }],
    browse: async () => [], browseMs: 10, cycleMs: 3600_000, jobsMs: 3600_000,
    inspect: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
    ...extra,
  });
  return { ps, rep, last: () => rep.posts.filter((x) => x.path === '/api/v1/gateway/print/devices').pop().body };
}

test('manual: Drucker in einem anderen privaten Subnetz – per IPP auf 631 gefragt, Name und Modell aus printer-make-and-model', async () => {
  const fp = await startFakePrinter();
  const to = local(fp.port);
  const seen = [];
  const { ps, last } = make({
    // mDNS kennt den Drucker auch, aber im anderen Subnetz → ohne `manual` verworfen
    browse: async () => [mdnsPacket({ ip: '192.168.20.5' })],
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => { seen.push(`${ep.scheme}:${ep.port}/${ep.path}`); return ippLib.getPrinterAttributes(to(ep), o); } },
    escl: { ...esclLib, capabilities: (ep, o) => esclLib.capabilities(to(ep), o), status: (ep, o) => esclLib.status(to(ep), o) },
  });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    let b = last();
    assert.deepEqual(b.devices, []);
    assert.deepEqual(b.search.dropped, { other_subnet: 1 });
    assert.deepEqual(b.search.hosts, [{ ip: '192.168.20.5', reason: 'other_subnet', name: 'HP OfficeJet 8020 [A1B2C3]' }]);
    // der Administrator trägt die Adresse ein → mDNS-Fund jetzt erlaubt, sonst direkt gefragt
    ps.cfg = { enabled: true, manual: ['192.168.20.5'] };
    await ps.search();
    b = last();
    assert.equal(b.devices.length, 1);
    assert.equal(b.devices[0].ip, '192.168.20.5');
    assert.deepEqual(b.search.manual, [{ ip: '192.168.20.5', found: true, via: 'mdns' }]);
    // ohne mDNS: direkt per IPP
    ps.browse = async () => [];
    ps.devices.clear();
    await ps.search();
    b = last();
    assert.equal(b.devices.length, 1);
    const d = b.devices[0];
    assert.equal(d.source, 'manual');
    assert.equal(d.name, 'HP OfficeJet 8020 series');
    assert.equal(d.model, 'HP OfficeJet 8020 series');
    assert.equal(d.location, 'Wohnzimmer');
    assert.equal(d.id, 'u:f0d8a1b2000010008000' + '00aabbccddee');
    assert.ok(d.printer && d.scanner, 'Drucker und Scanner (eSCL auf 80)');
    assert.deepEqual(b.search.manual, [{ ip: '192.168.20.5', found: true, via: 'manual' }]);
    assert.equal(seen[seen.length - 1], 'ipp:631/ipp/print');
    assert.equal(ps.featureTelemetry().search.devices, 0);
    assert.equal(ps.featureTelemetry().search.manual[0].via, 'manual');
  } finally { ps.stop(); await fp.close(); }
});

test('manual: 631 zu → IPPS auf 443 mit beim ersten Kontakt gelerntem Zertifikat; eSCL über https mit demselben Pin', async () => {
  const PIN = 'ab'.repeat(32);
  const calls = [];
  const attrs = {
    'printer-info': ['HP OfficeJet Pro 8720 [5A3B2C]'], 'printer-make-and-model': ['HP OfficeJet Pro 8720'], 'printer-name': ['HP_OfficeJet_Pro_8720'],
    'printer-uuid': ['urn:uuid:' + HP.uuid], 'printer-state': [3], 'document-format-supported': ['application/pdf'],
  };
  const down = () => Object.assign(new Error('ECONNREFUSED'), { code: 'network' });
  const { ps, last } = make({
    inspect: async ({ port }) => { calls.push('inspect:' + port); if (port === 443) return { sha256: PIN }; throw down(); },
    ipp: {
      ...ippLib,
      getPrinterAttributes: async (ep) => {
        calls.push(`ipp ${ep.scheme}:${ep.port}/${ep.path}${ep.pin ? ' pinned' : ''}`);
        if (ep.scheme === 'ipps' && ep.port === 443 && ep.pin === PIN) return attrs;
        throw down();
      },
    },
    escl: {
      ...esclLib,
      capabilities: async (ep) => {
        calls.push(`escl ${ep.scheme}:${ep.port}${ep.pin ? ' pinned' : ''}`);
        if (ep.scheme === 'https' && ep.pin === PIN) return { model: 'HP OfficeJet Pro 8720', platen: true, feeder: true, duplex: false, color: ['color'], resolutions: [300], formats: ['image/jpeg'] };
        throw down();
      },
      status: async () => ({ state: 'idle', adf: null }),
    },
  });
  try {
    await ps.apply({ enabled: true, manual: ['10.0.40.7'] });
    await ps.search();
    // 631 nicht erreichbar → keine weiteren Pfade auf 631, gleich IPPS
    assert.deepEqual(calls.slice(0, 5), ['ipp ipp:631/ipp/print', 'inspect:443', 'ipp ipps:443/ipp/print pinned', 'escl http:80', 'escl https:443 pinned']);
    const d = last().devices[0];
    assert.equal(d.name, 'HP OfficeJet Pro 8720 [5A3B2C]');
    assert.equal(d.model, 'HP OfficeJet Pro 8720');
    assert.equal(d.id, 'u:' + HP.uuid.replace(/-/g, ''));
    const saved = ps.devices.get(d.id);
    assert.deepEqual(saved.ipp, { scheme: 'ipps', host: '10.0.40.7', port: 443, path: 'ipp/print', pin: PIN });
    assert.equal(saved.escl.pin, PIN);
  } finally { ps.stop(); }
});

test('manual: IPP antwortet unter /ipp/print mit 404 → weitere Pfade; nichts erreichbar → „unreachable“, nur Webserver → „no_service“', async () => {
  const paths = [];
  const http404 = () => Object.assign(new Error('HTTP 404'), { code: 'http_status' });
  const { ps, last } = make({
    ipp: { ...ippLib, getPrinterAttributes: async (ep) => { paths.push(`${ep.host}/${ep.path}`); if (ep.host === '192.168.1.80') throw http404(); throw Object.assign(new Error('t'), { code: 'timeout' }); } },
    escl: { ...esclLib, capabilities: async (ep) => { if (ep.host === '192.168.1.80') throw http404(); throw Object.assign(new Error('t'), { code: 'network' }); } },
  });
  try {
    await ps.apply({ enabled: true, manual: ['192.168.1.80', '192.168.1.81'] });
    await ps.search();
    const b = last();
    assert.deepEqual(b.devices, []);
    assert.deepEqual(b.search.manual, [{ ip: '192.168.1.80', found: false, error: 'no_service' }, { ip: '192.168.1.81', found: false, error: 'unreachable' }]);
    assert.deepEqual(paths.filter((p) => p.startsWith('192.168.1.80')), ['192.168.1.80/ipp/print', '192.168.1.80/ipp', '192.168.1.80/']);
    assert.deepEqual(paths.filter((p) => p.startsWith('192.168.1.81')), ['192.168.1.81/ipp/print']);
  } finally { ps.stop(); }
});

test('Suche: Diagnose im Bericht – Schnittstellen, Antworten, Dienste, Geräte; ohne LAN „no_lan“', async () => {
  const fp = await startFakePrinter();
  const to = local(fp.port);
  const { ps, last } = make({
    browse: async ({ diag }) => { diag.responders.add('192.168.1.57'); return hpPackets(); },
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => ippLib.getPrinterAttributes(to(ep), o) },
    escl: { ...esclLib, capabilities: (ep, o) => esclLib.capabilities(to(ep), o), status: (ep, o) => esclLib.status(to(ep), o) },
  });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    const s = last().search;
    assert.equal(s.interfaces, 1);
    assert.equal(s.responses, 10);
    assert.equal(s.responders, 1);
    assert.equal(s.services, 3);
    assert.equal(s.devices, 1);
    assert.deepEqual(s.dropped, {});
    assert.deepEqual(s.errors, []);
    assert.equal(last().devices[0].name, HP.name);
    ps.getSubnets = () => [];
    await ps.search();
    assert.deepEqual(last().search.errors, ['no_lan']);
    assert.equal(last().search.interfaces, 0);
  } finally { ps.stop(); await fp.close(); }
});
