'use strict';

// ipps/https zu Druckern und Scannern: nie ohne Prüfung – trust on first use
// mit dem Fingerabdruck des Leaf-Zertifikats (src/proxy/tlsPin.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ippLib = require('../src/print/ipp');
const esclLib = require('../src/print/escl');
const { inspectLeafCertificate } = require('../src/proxy/tlsPin');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { PrintService } = require('../src/print/print');
const { startFakePrinter, mdnsPacket } = require('./helpers/fakePrinter');

const tls = makeSelfSigned({ commonName: 'HP OfficeJet 8020', altNames: [{ ip: '127.0.0.1' }] });
const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';

test('ipps mit passendem Pin: Antwort; anderer Pin: cert_changed; ohne Pin: no_pin – ohne ein Byte zu senden', async () => {
  const fp = await startFakePrinter({ tls });
  try {
    const base = { scheme: 'ipps', host: '127.0.0.1', port: fp.port, path: 'ipp/print' };
    const info = ippLib.printerInfo(await ippLib.getPrinterAttributes({ ...base, pin: tls.sha256 }));
    assert.equal(info.state, 'idle');
    assert.equal(fp.state.ippOps.length, 1);
    await assert.rejects(ippLib.getPrinterAttributes({ ...base, pin: 'ab'.repeat(32) }), (e) => e.code === 'cert_changed' && e.seenSha256 === tls.sha256);
    await assert.rejects(ippLib.getPrinterAttributes(base), { code: 'no_pin' });
    assert.equal(fp.state.ippOps.length, 1, 'nach einem falschen Pin erreicht den Drucker keine Anfrage');
  } finally { await fp.close(); }
});

test('eSCL über https nur mit Pin', async () => {
  const fp = await startFakePrinter({ tls });
  try {
    const base = { scheme: 'https', host: '127.0.0.1', port: fp.port, path: 'eSCL' };
    assert.equal((await esclLib.capabilities({ ...base, pin: tls.sha256 })).feeder, true);
    await assert.rejects(esclLib.capabilities({ ...base, pin: '00'.repeat(32) }), { code: 'cert_changed' });
    await assert.rejects(esclLib.capabilities(base), { code: 'no_pin' });
  } finally { await fp.close(); }
});

test('Gerät nur mit ipps/uscans: Pin beim ersten Kontakt gelernt, gedruckt; neues Zertifikat → cert_changed, erst nach Bestätigung wieder', async () => {
  const fp = await startFakePrinter({ tls });
  const to = (ep) => ({ ...ep, host: '127.0.0.1', port: fp.port });
  const posts = [];
  const files = new Map();
  let jobs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-print-pin-'));
  const ps = new PrintService({
    reporter: { post: async (p, body) => { posts.push({ p, body: JSON.parse(JSON.stringify(body)) }); return { ok: true }; } },
    client: { jobs: async () => ({ changed: true, jobs: jobs.slice(), etag: null }), file: async (id, sha, size, dest) => fs.writeFileSync(dest, files.get(id)), page: async () => {} },
    stateDir: dir,
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }],
    browse: async () => [mdnsPacket({ tls: true, port: 631, esclPort: 443 })],
    inspect: (o) => inspectLeafCertificate({ ...o, host: '127.0.0.1', port: fp.port }),
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => ippLib.getPrinterAttributes(to(ep), o), printJob: (ep, ...a) => ippLib.printJob(to(ep), ...a), getJobAttributes: (ep, ...a) => ippLib.getJobAttributes(to(ep), ...a) },
    escl: { ...esclLib, capabilities: (ep, o) => esclLib.capabilities(to(ep), o), status: (ep, o) => esclLib.status(to(ep), o) },
    retryMs: 0, jobPollMs: 10, jobWatchMs: 2000, browseMs: 10, cycleMs: 3600_000, jobsMs: 3600_000,
  });
  const devReport = () => posts.filter((x) => x.p === '/api/v1/gateway/print/devices').pop().body.devices[0];
  const jobStates = (id) => posts.filter((x) => x.p === `/api/v1/gateway/print/jobs/${id}`).map((x) => [x.body.state, x.body.error || null]);
  const add = (id) => {
    const b = Buffer.from('%PDF-1.4 ' + id);
    files.set(id, b);
    jobs = [{ id, deviceId: ID, format: 'application/pdf', size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), copies: 1, color: false, duplex: false, name: 'x', user: 'Marc' }];
  };
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    const d = ps.devices.get(ID);
    assert.equal(d.ipp.scheme, 'ipps');
    assert.equal(d.ipp.pin, tls.sha256, 'Pin beim ersten Kontakt gelernt');
    assert.equal(d.escl.pin, tls.sha256);
    assert.equal(devReport().online, true);
    assert.equal(devReport().problem, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'print-devices.json'), 'utf8')).devices[0].ipp.pin, tls.sha256, 'Pin übersteht den Neustart');

    add('job_pinok0001');
    await ps.pollJobs();
    assert.deepEqual(jobStates('job_pinok0001').map((s) => s[0]), ['sending', 'printing', 'done']);

    // das Gerät meldet sich jetzt mit einem anderen Zertifikat (hier: gespeicherter Pin passt nicht mehr)
    d.ipp.pin = 'cd'.repeat(32);
    d.escl.pin = 'cd'.repeat(32);
    await ps.search(); // eine neue Suche überschreibt den gelernten Pin nicht
    assert.equal(d.ipp.pin, 'cd'.repeat(32));
    assert.equal(devReport().problem, 'cert_changed');
    assert.equal(devReport().seenSha256, tls.sha256);
    const before = fp.state.printed.length;
    add('job_pinbad002');
    await ps.pollJobs();
    assert.deepEqual(jobStates('job_pinbad002'), [['waiting', 'cert_changed']]);
    assert.equal(fp.state.printed.length, before, 'mit falschem Zertifikat wird nichts gedruckt');

    // Administrator bestätigt das neue Zertifikat
    assert.equal(ps.requestSearch({ retrust: ID }), 'accepted');
    await ps.searching;
    assert.equal(d.ipp.pin, tls.sha256);
    assert.equal(devReport().problem, null);
    await ps.pollJobs();
    assert.deepEqual(jobStates('job_pinbad002').map((s) => s[0]), ['waiting', 'sending', 'printing', 'done']);
  } finally { ps.stop(); await fp.close(); }
});
