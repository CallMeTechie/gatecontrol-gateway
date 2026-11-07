'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const ippLib = require('../src/print/ipp');
const esclLib = require('../src/print/escl');
const convertLib = require('../src/print/convert');
const { PrintService } = require('../src/print/print');
const { FeatureManager } = require('../src/features/manager');
const { normalizeFeatures } = require('../src/features/config');
const { createFeaturesRouter } = require('../src/api/routes/features');
const { startFakePrinter, mdnsPacket } = require('./helpers/fakePrinter');

// Die Geräte haben LAN-Adressen (192.168.1.x); verbunden wird mit dem Test-Drucker auf 127.0.0.1.
const local = (port) => (ep) => ({ ...ep, host: '127.0.0.1', port });
function redirected(port) {
  const to = local(port);
  return {
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => ippLib.getPrinterAttributes(to(ep), o), printJob: (ep, ...a) => ippLib.printJob(to(ep), ...a), getJobAttributes: (ep, ...a) => ippLib.getJobAttributes(to(ep), ...a) },
    escl: { ...esclLib, capabilities: (ep, o) => esclLib.capabilities(to(ep), o), status: (ep, o) => esclLib.status(to(ep), o), scan: (ep, ...a) => esclLib.scan(to(ep), ...a) },
  };
}

function fakeServer() {
  const s = { posts: [], jobs: [], files: new Map(), pages: [], etagCalls: 0 };
  s.reporter = { post: async (p, body) => { s.posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return { ok: true, status: 200 }; } };
  s.client = {
    jobs: async () => { s.etagCalls++; return { changed: true, jobs: s.jobs.slice(), etag: '"x"' }; },
    file: async (id, sha, size, dest) => { const b = s.files.get(id); if (!b) { const e = new Error('nf'); e.code = 'not_found'; throw e; } fs.writeFileSync(dest, b); },
    page: async (scanId, n, file, mime, bytes) => { s.pages.push({ scanId, n, mime, bytes, body: fs.readFileSync(file) }); },
  };
  s.addJob = (id, body, extra = {}) => {
    s.files.set(id, body);
    s.jobs.push({ id, deviceId: 'u:f0d8a1b2000010008000' + '00aabbccddee', format: 'application/pdf', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), copies: 1, color: false, duplex: false, name: 'Test.pdf', user: 'Marc', ...extra });
  };
  s.of = (p) => s.posts.filter((x) => x.path === p).map((x) => x.body);
  return s;
}

function service(fp, srv, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-print-svc-'));
  const ps = new PrintService({
    reporter: srv.reporter, client: srv.client, stateDir: dir,
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }],
    browse: async () => [mdnsPacket({ ip: '192.168.1.57' })],
    ...redirected(fp.port), retryMs: 50, jobPollMs: 10, jobWatchMs: 2000, browseMs: 10, cycleMs: 3600_000, jobsMs: 3600_000,
    ...extra,
  });
  return { ps, dir };
}

const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';

test('Suche: Gerät gefunden, Tinte und Fähigkeiten gemeldet, Zustand gespeichert', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps, dir } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    const rep = srv.of('/api/v1/gateway/print/devices').pop();
    assert.equal(rep.devices.length, 1);
    const d = rep.devices[0];
    assert.equal(d.id, ID);
    assert.equal(d.ip, '192.168.1.57');
    assert.equal(d.online, true);
    assert.equal(d.printer.state, 'idle');
    assert.equal(d.printer.markers[2].low, true);
    assert.equal(d.scanner.feeder, true);
    assert.deepEqual(d.scanner.color, ['bw', 'gray', 'color']);
    assert.equal(d.ipp, undefined, 'keine Endpunkte im Bericht');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'print-devices.json'), 'utf8'));
    assert.equal(saved.devices[0].ipp.port, 631);
    const tel = ps.featureTelemetry();
    assert.deepEqual([tel.enabled, tel.devices, tel.printers, tel.scanners], [true, 1, 1, 1]);
  } finally { ps.stop(); await fp.close(); }
});

test('Gerät außerhalb des eigenen LAN wird nie übernommen', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps } = service(fp, srv, { browse: async () => [mdnsPacket({ ip: '10.9.9.9' })] });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    assert.deepEqual(srv.of('/api/v1/gateway/print/devices').pop().devices, []);
    assert.equal(ps.isAllowed('8.8.8.8'), false);
    ps.cfg.manual = ['10.9.9.9'];
    assert.equal(ps.isAllowed('10.9.9.9'), true);
  } finally { ps.stop(); await fp.close(); }
});

test('Druckauftrag: geladen, gedruckt, Zustände sending → printing → done, Datei weg', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps, dir } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    srv.addJob('job_aaaaaaaa1', Buffer.from('%PDF-1.4 hallo'), { copies: 2, duplex: true, color: true });
    await ps.pollJobs();
    const states = srv.of('/api/v1/gateway/print/jobs/job_aaaaaaaa1').map((b) => b.state);
    assert.deepEqual(states, ['sending', 'printing', 'done']);
    assert.equal(fp.state.printed.length, 1);
    assert.equal(fp.state.printed[0].data.toString(), '%PDF-1.4 hallo');
    assert.equal(fp.state.printed[0].copies, 2);
    assert.equal(fp.state.printed[0].sides, 'two-sided-long-edge');
    assert.equal(fp.state.printed[0].color, 'color');
    assert.equal(fp.state.printed[0].user, 'Marc');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'print-tmp')), []);
    // der Server listet ihn nicht mehr → nichts passiert
    srv.jobs = [];
    await ps.pollJobs();
    assert.equal(fp.state.printed.length, 1);
  } finally { ps.stop(); await fp.close(); }
});

test('Drucker aus: Auftrag wartet und geht raus, sobald er wieder da ist', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    fp.state.opts.down = true;
    srv.addJob('job_bbbbbbbb2', Buffer.from('%PDF-1.4 später'));
    await ps.pollJobs();
    const first = srv.of('/api/v1/gateway/print/jobs/job_bbbbbbbb2');
    assert.deepEqual(first.map((b) => [b.state, b.error]), [['waiting', 'printer_offline']]);
    // vor Ablauf der Wartezeit kein neuer Versuch
    await ps.pollJobs();
    assert.equal(srv.of('/api/v1/gateway/print/jobs/job_bbbbbbbb2').length, 1);
    fp.state.opts.down = false;
    await new Promise((r) => setTimeout(r, 60));
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_bbbbbbbb2').map((b) => b.state), ['waiting', 'sending', 'printing', 'done']);
    assert.equal(fp.state.printed.length, 1);
  } finally { ps.stop(); await fp.close(); }
});

test('Format passt nicht: abgelehnt ohne Versuch; Drucker lehnt ab: failed', async () => {
  // nur ein Herstellerformat, kein Raster, kein JPEG: das Gateway kann PDF nicht umwandeln
  const fp = await startFakePrinter({ printer: { formats: ['application/vnd.hp-pcl'] } });
  const srv = fakeServer();
  const { ps } = service(fp, srv, { converter: { ...convertLib, available: () => true } });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    srv.addJob('job_cccccccc3', Buffer.from('%PDF'));
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_cccccccc3').map((b) => [b.state, b.error, b.message]), [['failed', 'format_unsupported', 'no_raster_format']]);
    assert.equal(fp.state.printed.length, 0);
    srv.jobs = [];
    fp.state.opts.printer = { formats: ['application/vnd.hp-pcl', 'image/jpeg'] };
    await ps.search();
    fp.state.opts.printStatus = 0x040b; // client-error-attributes-or-values-not-supported
    srv.addJob('job_dddddddd4', Buffer.from([0xff, 0xd8, 0xff]), { format: 'image/jpeg' });
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_dddddddd4').map((b) => b.state), ['sending', 'failed']);
  } finally { ps.stop(); await fp.close(); }
});

test('Neustart nach dem Senden: nicht noch einmal drucken (Journal)', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps, dir } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    ps.journal.set('job_eeeeeeee5', { at: Date.now(), ippJobId: 42 });
    ps._persist();
    ps.stop();
    const again = service(fp, srv, { stateDir: dir }).ps;
    again.stateDir = dir;
    await again.apply({ enabled: true, manual: [] });
    srv.addJob('job_eeeeeeee5', Buffer.from('%PDF'));
    await again.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_eeeeeeee5'), [{ state: 'done', ippJobId: 42, message: 'unconfirmed' }]);
    assert.equal(fp.state.printed.length, 0);
    again.stop();
  } finally { await fp.close(); }
});

test('Scan: Einstellungen nach Fähigkeiten, Seiten hochgeladen, fertig gemeldet; unbekanntes Gerät/doppelt abgelehnt', async () => {
  const fp = await startFakePrinter({ feederPages: 2 });
  const srv = fakeServer();
  const { ps } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    assert.equal(ps.requestScan({ scanId: 'scan_12345678', deviceId: 'u:0000000000000000' }), 'unknown_device');
    assert.equal(ps.requestScan({ scanId: 'bad', deviceId: ID }), 'invalid');
    assert.equal(ps.requestScan({ scanId: 'scan_12345678', deviceId: ID, source: 'feeder', color: 'bw', resolution: 250, format: 'image/jpeg' }), 'accepted');
    assert.equal(ps.requestScan({ scanId: 'scan_87654321', deviceId: ID }), 'busy');
    for (let i = 0; i < 100 && ps.scans.size; i++) await new Promise((r) => setTimeout(r, 20));
    const st = srv.of('/api/v1/gateway/print/scans/scan_12345678');
    assert.equal(st[0].state, 'scanning');
    assert.equal(st[0].source, 'feeder');
    assert.equal(st[0].color, 'gray', 'JPEG in Schwarz-Weiß → Graustufen');
    assert.equal(st[0].resolution, 200);
    assert.deepEqual(st.pop(), { state: 'done', pages: 2 });
    assert.deepEqual(srv.pages.map((p) => [p.n, p.mime]), [[1, 'image/jpeg'], [2, 'image/jpeg']]);
  } finally { ps.stop(); await fp.close(); }
});

test('settingsFor: Glas statt Einzug, wenn es keinen gibt; kleinste Auflösung als Rückfall', () => {
  const caps = { platen: true, feeder: false, duplex: false, color: ['color'], resolutions: [300, 600], formats: ['application/pdf'] };
  assert.deepEqual(PrintService.settingsFor(caps, { source: 'feeder', color: 'gray', resolution: 150, format: 'image/jpeg', duplex: true }),
    { source: 'platen', color: 'color', resolution: 300, format: 'application/pdf', duplex: false, maxW: undefined, maxH: undefined });
});

test('Feature-Manager: print aus dem Config-Pull, Capability, Mgmt-Routen', async () => {
  const f = normalizeFeatures({ print: { enabled: true, manual: ['192.168.1.70'] } });
  assert.deepEqual(f.print, { enabled: true, manual: ['192.168.1.70'], convert: true });
  assert.equal(normalizeFeatures({ print: { enabled: true, convert: false } }).print.convert, false);
  assert.equal(normalizeFeatures(undefined).print.enabled, false);
  assert.equal(normalizeFeatures({}).print.enabled, false);
  const calls = [];
  const stub = { apply() {}, stop() {}, telemetry: () => ({}), featureTelemetry: () => ({ enabled: false }), requestScan: () => {}, requestSpeedtest: () => {} };
  const print = { apply: async (c) => calls.push(c), stop() {}, featureTelemetry: () => ({ enabled: true, devices: 1 }), requestSearch: () => 'accepted', requestJobs: () => 'accepted', requestScan: (b) => (b.deviceId === 'x' ? 'unknown_device' : 'accepted'), cancelScan: () => 'accepted' };
  const mgr = new FeatureManager({ netwatch: stub, inetq: stub, presence: stub, ups: { ...stub, featureTelemetry: () => ({}) }, print });
  await mgr.apply({ print: { enabled: true } });
  assert.deepEqual(calls[0], { enabled: true, manual: [], convert: true });
  const tel = mgr.telemetry();
  assert.ok(tel.capabilities.includes('print'));
  assert.ok(tel.capabilities.includes('print-convert'), 'PDF-Umwandlung für Drucker ohne PDF');
  assert.deepEqual(tel.features.print, { enabled: true, devices: 1 });

  const app = express();
  app.use(express.json());
  app.use('/api', createFeaturesRouter({ featureMgr: mgr }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    assert.equal((await post('/print/discover')).status, 202);
    assert.equal((await post('/print/jobs')).status, 202);
    assert.equal((await post('/print/scan', { scanId: 'scan_12345678', deviceId: 'y' })).status, 202);
    assert.equal((await post('/print/scan', { scanId: 'scan_12345678', deviceId: 'x' })).status, 404);
    assert.equal((await post('/print/scan/cancel', { scanId: 'scan_12345678' })).status, 202);
    const off = new FeatureManager({ netwatch: stub, inetq: stub, presence: stub, ups: stub });
    const app2 = express(); app2.use(express.json()); app2.use('/api', createFeaturesRouter({ featureMgr: off }));
    const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/print/discover`, { method: 'POST' });
    assert.equal(r.status, 503);
    s2.close();
  } finally { srv.close(); }
});
