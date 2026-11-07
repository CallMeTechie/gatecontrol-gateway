'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ipp = require('../src/print/ipp');
const escl = require('../src/print/escl');
const discovery = require('../src/print/discovery');
const { normalizePrint, isRfc1918 } = require('../src/print/config');
const { startFakePrinter, mdnsPacket, CAPS } = require('./helpers/fakePrinter');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gw-print-'));

test('IPP: Nachricht kodieren und dekodieren (mehrere Werte, Sammlung, Datenteil)', () => {
  const { TAG, GROUP } = ipp;
  const msg = ipp.encodeMessage(0x0000, 7, [
    [GROUP.operation, [[TAG.charset, 'attributes-charset', 'utf-8']]],
    [GROUP.printer, [[TAG.keyword, 'sides-supported', ['one-sided', 'two-sided-long-edge']], [TAG.integer, 'marker-levels', [80, -1]], [TAG.boolean, 'color-supported', false]]],
  ]);
  // eine Sammlung von Hand dahinter: media-col { media-size { x-dimension 21000 } }
  const coll = Buffer.concat([
    Buffer.from([GROUP.printer]),
    Buffer.from([TAG.begCollection, 0, 9]), Buffer.from('media-col'), Buffer.from([0, 0]),
    Buffer.from([TAG.memberAttrName, 0, 0, 0, 10]), Buffer.from('media-size'),
    Buffer.from([TAG.begCollection, 0, 0, 0, 0]),
    Buffer.from([TAG.memberAttrName, 0, 0, 0, 11]), Buffer.from('x-dimension'),
    Buffer.from([TAG.integer, 0, 0, 0, 4]), Buffer.from([0, 0, 0x52, 0x08]),
    Buffer.from([TAG.endCollection, 0, 0, 0, 0]),
    Buffer.from([TAG.endCollection, 0, 0, 0, 0]),
    Buffer.from([GROUP.end]), Buffer.from('%PDF'),
  ]);
  const r = ipp.decodeResponse(Buffer.concat([msg.subarray(0, -1), coll]));
  assert.equal(r.status, 0);
  assert.equal(r.requestId, 7);
  const a = ipp.attrsOf(r, GROUP.printer);
  assert.deepEqual(a['sides-supported'], ['one-sided', 'two-sided-long-edge']);
  assert.deepEqual(a['marker-levels'], [80, -1]);
  assert.deepEqual(a['color-supported'], [false]);
  assert.deepEqual(a['media-col'], [{ 'media-size': [{ 'x-dimension': [21000] }] }]);
  assert.equal(r.data.toString(), '%PDF');
});

test('IPP: abgeschnittene oder unsinnige Antworten → bad_response', () => {
  assert.throws(() => ipp.decodeResponse(Buffer.from([2, 0, 0])), { code: 'bad_response' });
  const bad = Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x01, 0x44, 0, 50, 0x61]);
  assert.throws(() => ipp.decodeResponse(bad), { code: 'bad_response' });
});

test('IPP gegen einen Test-Drucker: Attribute, Print-Job mit Optionen, Job-Zustand', async () => {
  const fp = await startFakePrinter();
  try {
    const ep = { scheme: 'ipp', host: '127.0.0.1', port: fp.port, path: 'ipp/print' };
    const info = ipp.printerInfo(await ipp.getPrinterAttributes(ep));
    assert.equal(info.state, 'idle');
    assert.equal(info.color, true);
    assert.equal(info.duplex, true);
    assert.equal(info.copiesMax, 99);
    assert.ok(info.formats.includes('application/pdf'));
    assert.equal(info.uuid, 'f0d8a1b2-0000-1000-8000-00aabbccddee');
    assert.deepEqual(info.markers.map((m) => [m.name, m.color, m.level, m.low]), [['Black', '#000000', 70, false], ['Cyan', '#00FFFF', 55, false], ['Magenta', '#FF00FF', 8, true], ['Yellow', '#FFFF00', 40, false]]);

    const dir = tmp();
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, '%PDF-1.4 test');
    const r = await ipp.printJob(ep, file, fs.statSync(file).size, { name: 'Bordkarte.pdf', user: 'Sabine', format: 'application/pdf', copies: 2, duplex: true, color: false });
    assert.equal(r.status, 0);
    assert.equal(r.jobId, 100);
    const p = fp.state.printed[0];
    assert.equal(p.data.toString(), '%PDF-1.4 test');
    assert.deepEqual([p.format, p.name, p.user, p.copies, p.sides, p.color], ['application/pdf', 'Bordkarte.pdf', 'Sabine', 2, 'two-sided-long-edge', 'monochrome']);
    assert.equal((await ipp.getJobAttributes(ep, 100)).state, 'completed');

    fp.state.opts.printStatus = ipp.STATUS.FORMAT_NOT_SUPPORTED;
    const r2 = await ipp.printJob(ep, file, fs.statSync(file).size, { format: 'image/png' });
    assert.equal(r2.status, 0x040a);
  } finally { await fp.close(); }
});

test('IPP: nicht erreichbar → network/timeout', async () => {
  const ep = { scheme: 'ipp', host: '127.0.0.1', port: 9, path: 'ipp/print' };
  await assert.rejects(ipp.getPrinterAttributes(ep, { timeoutMs: 2000 }), (e) => ['network', 'timeout'].includes(e.code));
});

test('eSCL: Fähigkeiten, Zustand und ScanSettings', () => {
  const c = escl.parseCapabilities(CAPS);
  assert.equal(c.platen, true);
  assert.equal(c.feeder, true);
  assert.equal(c.duplex, true);
  assert.deepEqual(c.color, ['bw', 'gray', 'color']);
  assert.deepEqual(c.resolutions, [75, 200, 300, 600]);
  assert.deepEqual(c.formats, ['application/pdf', 'image/jpeg']);
  assert.equal(c.maxW, 2550);
  assert.deepEqual(escl.parseStatus('<pwg:State>Processing</pwg:State><scan:AdfState>ScannerAdfEmpty</scan:AdfState>'), { state: 'processing', adf: 'empty' });
  const x = escl.scanSettings({ source: 'feeder', color: 'gray', resolution: 300, format: 'image/jpeg', duplex: true, maxW: 2550, maxH: 4200 });
  assert.match(x, /<pwg:InputSource>Feeder<\/pwg:InputSource>/);
  assert.match(x, /<scan:Duplex>true<\/scan:Duplex>/);
  assert.match(x, /<scan:ColorMode>Grayscale8<\/scan:ColorMode>/);
  assert.match(x, /<pwg:Width>2480<\/pwg:Width><pwg:Height>3508<\/pwg:Height>/);
  assert.doesNotMatch(escl.scanSettings({ source: 'platen', color: 'color', resolution: 300, format: 'image/jpeg' }), /Duplex/);
});

test('eSCL: der Ort eines Auftrags nur als Pfad auf demselben Gerät', () => {
  const ep = { host: '192.168.1.57', port: 80, path: 'eSCL' };
  assert.equal(escl.jobPath('http://192.168.1.57/eSCL/ScanJobs/abc', ep), '/eSCL/ScanJobs/abc');
  assert.equal(escl.jobPath('http://evil.example/eSCL/ScanJobs/abc', ep), '/eSCL/ScanJobs/abc'); // Host fällt weg
  assert.equal(escl.jobPath('/eSCL/ScanJobs/x/', ep), '/eSCL/ScanJobs/x');
  assert.equal(escl.jobPath('/other/path', ep), null);
  assert.equal(escl.jobPath('/eSCL/ScanJobs/../../admin', ep), null);
  assert.equal(escl.jobPath('', ep), null);
});

test('eSCL gegen einen Test-Scanner: Einzug mit drei Seiten, Glas mit einer, „beschäftigt“ wird abgewartet', async () => {
  const fp = await startFakePrinter({ feederPages: 3, scanBusy: 2 });
  try {
    const ep = { scheme: 'http', host: '127.0.0.1', port: fp.port, path: 'eSCL' };
    const caps = await escl.capabilities(ep);
    assert.equal(caps.feeder, true);
    const dir = tmp();
    const pages = [];
    const r = await escl.scan(ep, { source: 'feeder', color: 'gray', resolution: 300, format: 'image/jpeg', duplex: false }, {
      tmpFile: (n) => path.join(dir, `p${n}`), retryMs: 10,
      onPage: async (file, info) => { pages.push({ ...info, body: fs.readFileSync(file).toString('latin1') }); fs.rmSync(file); },
    });
    assert.equal(r.pages, 3);
    assert.deepEqual(pages.map((p) => [p.n, p.mime]), [[1, 'image/jpeg'], [2, 'image/jpeg'], [3, 'image/jpeg']]);
    assert.match(pages[0].body, /page-job1-3/);
    assert.match(fp.state.scanJobs[0].settings, /Feeder/);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(fp.state.deleted, ['job1']);

    const r2 = await escl.scan(ep, { source: 'platen', color: 'color', resolution: 300, format: 'image/jpeg' }, {
      tmpFile: (n) => path.join(dir, `q${n}`), retryMs: 10, onPage: async (file) => fs.rmSync(file),
    });
    assert.equal(r2.pages, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await fp.close(); }
});

test('mDNS: Dienste lesen, Drucker und Scanner über die UUID zusammenführen', () => {
  const services = discovery.mapServices([mdnsPacket()]);
  assert.equal(services.length, 2);
  assert.deepEqual(services.map((s) => [s.kind, s.scheme, s.ip, s.port, s.path]).sort(), [['printer', 'ipp', '192.168.1.57', 631, 'ipp/print'], ['scanner', 'http', '192.168.1.57', 80, 'eSCL']]);
  const devs = discovery.mergeDevices(services);
  assert.equal(devs.length, 1);
  const d = devs[0];
  assert.equal(d.id, 'u:f0d8a1b2000010008000' + '00aabbccddee');
  assert.equal(d.name, 'HP OfficeJet 8020 [A1B2C3]');
  assert.equal(d.model, 'HP OfficeJet 8020 series');
  assert.equal(d.location, 'Wohnzimmer');
  assert.deepEqual(d.ipp, { scheme: 'ipp', host: '192.168.1.57', port: 631, path: 'ipp/print' });
  assert.deepEqual(d.escl, { scheme: 'http', host: '192.168.1.57', port: 80, path: 'eSCL' });
  assert.equal(d.hints.color, true);
  // nicht erlaubte Adresse fällt weg
  assert.deepEqual(discovery.mergeDevices(services, (ip) => ip !== '192.168.1.57'), []);
});

test('mDNS: fremde Pfade und Geräte ohne Adresse werden nicht übernommen; ohne UUID die Adresse', () => {
  const p = mdnsPacket({ uuid: '' });
  p.additionals[1].data = [Buffer.from('rp=../../etc')];
  const s = discovery.mapServices([p]);
  assert.deepEqual(s.map((x) => x.kind), ['scanner']);
  const d = discovery.mergeDevices(s);
  assert.match(d[0].id, /^h:[0-9a-f]{16}$/);
  const noA = mdnsPacket();
  noA.additionals = noA.additionals.filter((r) => r.type !== 'A');
  assert.deepEqual(discovery.mapServices([noA]), []);
});

test('features.print: nur echtes true schaltet ein; manual nur RFC 1918, höchstens 16', () => {
  assert.deepEqual(normalizePrint(undefined), { enabled: false, manual: [], convert: true });
  assert.deepEqual(normalizePrint({ enabled: 'yes' }), { enabled: false, manual: [], convert: true });
  // PDF umwandeln: Standard an, nur `false` schaltet es aus
  assert.equal(normalizePrint({ enabled: true, convert: false }).convert, false);
  assert.equal(normalizePrint({ enabled: true, convert: 'no' }).convert, true);
  const many = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
  const p = normalizePrint({ enabled: true, manual: ['192.168.1.70', '8.8.8.8', '127.0.0.1', '172.16.0.3', '172.32.0.1', 'printer.local', 7, '192.168.1.70', ...many] });
  assert.equal(p.enabled, true);
  assert.deepEqual(p.manual.slice(0, 2), ['192.168.1.70', '172.16.0.3']);
  assert.equal(p.manual.length, 16);
  assert.equal(isRfc1918('169.254.1.1'), false);
  assert.equal(isRfc1918('100.64.0.1'), false);
});
