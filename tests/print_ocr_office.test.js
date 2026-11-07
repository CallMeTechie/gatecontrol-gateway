'use strict';

// Drucken & Scannen, Restpunkte Phase 3c (docs/print.md): PCLm für Drucker,
// die nur das nehmen, Papier und Fach, der echte Zustand beim Drucken,
// Texterkennung für Scans (tesseract) und Office-Dateien (Dienst office mit
// LibreOffice – hier der Wächter office.sh mit dem soffice des Rechners, in
// der CI aus den Ubuntu-Paketen, wie im Image).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');
const c = require('../src/print/convert');
const ippLib = require('../src/print/ipp');
const esclLib = require('../src/print/escl');
const ocr = require('../src/print/ocr');
const { OfficeService, TYPES } = require('../src/print/office');
const { PrintService } = require('../src/print/print');
const { parseJobs } = require('../src/print/serverClient');
const { startFakePrinter, mdnsPacket } = require('./helpers/fakePrinter');

const FX = path.join(__dirname, 'fixtures', 'print');
const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';
const { TAG } = ippLib;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ─── PCLm ───────────────────────────────────────────────────────────────

/** Ein Objekt eines PDF (n 0 obj … endobj) – Kopf und Strom. */
function objOf(buf, n) {
  const s = buf.toString('latin1');
  const at = s.indexOf(`\n${n} 0 obj\n`);
  assert.ok(at >= 0, `object ${n}`);
  const head = s.slice(at, s.indexOf('\n', at + 2 + String(n).length + 6) + 400);
  const st = s.indexOf('stream\n', at);
  const len = /\/Length (\d+)/.exec(head);
  return { head, stream: len && st >= 0 ? buf.subarray(st + 7, st + 7 + Number(len[1])) : null };
}

test('PCLm: plan nach den Drucker-Attributen, wenn er nur PCLm (und JPEG) nennt', () => {
  const a = {
    'document-format-supported': ['application/PCLm', 'image/jpeg'],
    'pclm-source-resolution-supported': [{ x: 600, y: 600, units: 3 }, { x: 300, y: 300, units: 3 }],
    'pclm-strip-height-preferred': [32],
    'pclm-compression-method-preferred': ['jpeg', 'rle'],
    'pclm-raster-back-side': ['rotated'],
  };
  const printer = { formats: ['application/pclm', 'image/jpeg'], raster: c.rasterInfo(a) };
  const p = c.plan(printer, { color: true });
  assert.equal(p.format, c.PCLM);
  assert.deepEqual([p.dpi, p.type, p.strip, p.compression, p.back], [300, 'srgb_8', 32, 'rle', 'rotated']);
  assert.equal(c.plan(printer, { color: false }).type, 'sgray_8');
  // ohne Angaben: 300 dpi, 16 Zeilen, Flate
  const bare = c.plan({ formats: ['application/pclm'], raster: c.rasterInfo({}) }, {});
  assert.deepEqual([bare.dpi, bare.strip, bare.compression], [300, 16, 'flate']);
  // PWG geht vor PCLm, PCLm vor JPEG
  assert.equal(c.plan({ formats: ['application/pclm', 'image/pwg-raster'], raster: c.rasterInfo({ 'pwg-raster-document-resolution-supported': [{ x: 300, y: 300, units: 3 }] }) }).format, c.PWG);
  assert.equal(c.targetOf(printer), c.PCLM);
  assert.equal(c.ippFormat(c.PCLM), 'application/PCLm');
  assert.equal(c.sniff(Buffer.from('%PDF-1.7\n%PCLm 1.0\n')), c.PCLM);
  // gewähltes Papier geht vor dem eingelegten
  assert.equal(c.plan(printer, { media: 'na_letter_8.5x11in' }).media.name, 'na_letter_8.5x11in');
});

test('PCLm: Run-Length wie PDF RunLengthDecode', () => {
  const decode = (b) => {
    const out = [];
    for (let i = 0; i < b.length;) {
      const n = b[i++];
      if (n === 128) break;
      if (n < 128) { for (let k = 0; k <= n; k++) out.push(b[i++]); } else { const v = b[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); }
    }
    return Buffer.from(out);
  };
  for (const raw of [Buffer.alloc(1000, 0xff), crypto.randomBytes(777), Buffer.concat([Buffer.alloc(3, 1), crypto.randomBytes(300), Buffer.alloc(260, 7)]), Buffer.from([5]), Buffer.from('AAB'.repeat(200))]) {
    const enc = c.rle(raw);
    assert.equal(enc[enc.length - 1], 128);
    assert.deepEqual(decode(enc), raw);
  }
});

test('PCLm: echtes PDF → PCLm-Datei, die poppler lesen kann (Streifen, Größe, xref)', async (t) => {
  const dir = tmp('gw-pclm-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const printer = { formats: ['application/pclm'], raster: c.rasterInfo({ 'pclm-strip-height-preferred': [64] }) };
  const p = { ...c.plan(printer, { color: false }), dpi: 100 };
  const out = await c.convert(path.join(FX, 'sample.pdf'), path.join(dir, 'job.conv'), p, {});
  assert.equal(out.format, c.PCLM);
  assert.equal(out.pages, 1);
  const buf = fs.readFileSync(out.files[0].file);
  assert.ok(buf.subarray(0, 19).equals(Buffer.from('%PDF-1.7\n%PCLm 1.0\n')));
  // A4 bei 100 dpi: 827 × 1169 Pixel → 19 Streifen à 64 Zeilen (der letzte 17)
  const strips = Math.ceil(1169 / 64);
  const first = objOf(buf, 5);
  assert.match(first.head, /\/Width 827 \/Height 64 \/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Filter \/FlateDecode/);
  assert.equal(zlib.inflateSync(first.stream).length, 827 * 64);
  const last = objOf(buf, 4 + strips);
  assert.match(last.head, /\/Height 17 /);
  // poppler liest die Datei (xref und Seitenbaum stimmen) und sieht ein A4-Blatt
  const info = execFileSync('pdfinfo', [out.files[0].file]).toString();
  assert.match(info, /Pages:\s+1/);
  assert.match(info, /Page size:\s+595\.\d+ x 841\.\d+ pts/);
  // und gerendert ist oben links Text (nicht leer)
  const png = execFileSync('pdftoppm', ['-r', '30', '-gray', out.files[0].file]);
  assert.ok(png.length > 1000);
});

// ─── Papier und Fach ────────────────────────────────────────────────────

test('Papier und Fächer aus den Drucker-Attributen; media-col zum Drucker', () => {
  const m = ippLib.mediaInfo({
    'media-supported': ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'na_index-4x6_4x6in_borderless', 'om_custom_10x10mm', 'iso_a5_148x210mm'],
    'media-default': ['iso_a4_210x297mm'],
    'media-source-supported': ['auto', 'main', 'photo', 'by-pass-tray', 'BAD SOURCE'],
    'media-col-default': [{ 'media-size': [{ 'x-dimension': [21000], 'y-dimension': [29700] }], 'media-source': ['main'] }],
    'media-col-ready': [
      { 'media-size': [{ 'x-dimension': [21000], 'y-dimension': [29700] }], 'media-source': ['main'] },
      { 'media-size': [{ 'x-dimension': [10160], 'y-dimension': [15240] }], 'media-source': ['photo'] },
    ],
  });
  assert.deepEqual(m.sizes, ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'na_index-4x6_4x6in', 'iso_a5_148x210mm']);
  assert.equal(m.default, 'iso_a4_210x297mm');
  assert.deepEqual(m.sources, ['auto', 'main', 'photo', 'by-pass-tray']);
  assert.equal(m.sourceDefault, 'main');
  assert.deepEqual(m.ready, [{ size: 'iso_a4_210x297mm', source: 'main' }, { size: 'na_index-4x6_4x6in', source: 'photo' }]);
  assert.equal(ippLib.mediaByDims(29700, 21000), 'iso_a4_210x297mm', 'quer erkannt');
  // Sammlung kodiert und wieder gelesen (gleiche Kodierung wie die Antwort)
  const msg = ippLib.encodeMessage(0, 1, [[ippLib.GROUP.job, [[TAG.begCollection, 'media-col', { members: [
    [TAG.begCollection, 'media-size', { members: [[TAG.integer, 'x-dimension', 21000], [TAG.integer, 'y-dimension', 29700]] }],
    [TAG.keyword, 'media-source', 'photo'],
  ] }]]]]);
  const col = ippLib.attrsOf(ippLib.decodeResponse(msg), ippLib.GROUP.job)['media-col'][0];
  assert.deepEqual(col, { 'media-size': [{ 'x-dimension': [21000], 'y-dimension': [29700] }], 'media-source': ['photo'] });
});

test('Auftragsliste: Papier/Fach und Office-Typen werden übernommen, Unsinn nicht', () => {
  const base = { id: 'job_aaaaaaaa1', deviceId: ID, size: 10, sha256: 'a'.repeat(64) };
  const [a, b, d] = parseJobs({ jobs: [
    { ...base, format: 'application/pdf', media: 'iso_a5_148x210mm', source: 'tray-2' },
    { ...base, id: 'job_aaaaaaaa2', format: TYPES ? Object.keys(TYPES)[0] : 'x', media: '../etc', source: 'Tray 1' },
    { ...base, id: 'job_aaaaaaaa3', format: 'application/x-msdownload' },
  ] });
  assert.deepEqual([a.media, a.source], ['iso_a5_148x210mm', 'tray-2']);
  assert.equal(b.format, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual([b.media, b.source], [null, null]);
  assert.equal(d, undefined, 'unbekanntes Format fällt weg');
});

// ─── Der Dienst mit echtem Drucker-Ersatz ───────────────────────────────

const local = (port) => (ep) => ({ ...ep, host: '127.0.0.1', port });
function redirected(port, over = {}) {
  const to = local(port);
  return {
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => ippLib.getPrinterAttributes(to(ep), o), printJob: (ep, ...a) => ippLib.printJob(to(ep), ...a), getJobAttributes: (ep, ...a) => ippLib.getJobAttributes(to(ep), ...a), ...over },
    escl: { ...esclLib, capabilities: (ep, o) => esclLib.capabilities(to(ep), o), status: (ep, o) => esclLib.status(to(ep), o), scan: (ep, ...a) => esclLib.scan(to(ep), ...a) },
  };
}

function fakeServer() {
  const s = { posts: [], jobs: [], files: new Map(), ocrPages: new Map(), results: [] };
  s.reporter = { post: async (p, body) => { s.posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return { ok: true, status: 200 }; } };
  s.client = {
    jobs: async () => ({ changed: true, jobs: s.jobs.slice(), etag: '"x"' }),
    file: async (id, sha, size, dest) => { fs.writeFileSync(dest, s.files.get(id)); },
    page: async () => {},
    ocrPage: async (id, n, dest) => { const b = s.ocrPages.get(`${id}/${n}`); if (!b) { const e = new Error('nf'); e.code = 'not_found'; throw e; } fs.writeFileSync(dest, b); },
    ocrResult: async (id, kind, file, mime) => { s.results.push({ id, kind, mime, body: fs.readFileSync(file) }); },
  };
  s.addJob = (id, body, extra = {}) => {
    s.files.set(id, body);
    s.jobs.push({ id, deviceId: ID, format: 'application/pdf', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), copies: 1, color: false, duplex: false, name: 'Test', user: 'Marc', media: null, source: null, ...extra });
  };
  s.of = (p) => s.posts.filter((x) => x.path === p).map((x) => x.body);
  return s;
}

function service(fp, srv, extra = {}) {
  const dir = tmp('gw-print-p3c-');
  const ps = new PrintService({
    reporter: srv.reporter, client: srv.client, stateDir: dir,
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }],
    browse: async () => [mdnsPacket({ ip: '192.168.1.57' })],
    ...redirected(fp.port, extra.ipp || {}), retryMs: 50, jobPollMs: 10, jobWatchMs: 2000, browseMs: 10, cycleMs: 3600_000, jobsMs: 3600_000,
    ...extra.opts,
  });
  return { ps, dir };
}

const MEDIA_ATTRS = [
  [TAG.keyword, 'media-supported', ['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_index-4x6_4x6in']],
  [TAG.keyword, 'media-source-supported', ['main', 'photo']],
];

test('Papier und Fach gehen an den Drucker (media-col mit Fach, sonst media); nicht genannt → Standard', async () => {
  const fp = await startFakePrinter({ printer: { extra: MEDIA_ATTRS } });
  const srv = fakeServer();
  const { ps } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    const rep = srv.of('/api/v1/gateway/print/devices').pop();
    assert.deepEqual(rep.devices[0].printer.media.sizes, ['iso_a4_210x297mm', 'iso_a5_148x210mm', 'na_index-4x6_4x6in']);
    assert.deepEqual(rep.devices[0].printer.media.sources, ['main', 'photo']);
    srv.addJob('job_media0001', Buffer.from('%PDF-1.4 a'), { media: 'na_index-4x6_4x6in', source: 'photo' });
    await ps.pollJobs();
    srv.jobs = [];
    srv.addJob('job_media0002', Buffer.from('%PDF-1.4 b'), { media: 'iso_a5_148x210mm' });
    await ps.pollJobs();
    srv.jobs = [];
    srv.addJob('job_media0003', Buffer.from('%PDF-1.4 c'), { media: 'na_letter_8.5x11in', source: 'tray-9' });
    await ps.pollJobs();
    const [a, b, d] = fp.state.printed;
    assert.deepEqual(a.mediaCol, { 'media-size': [{ 'x-dimension': [10160], 'y-dimension': [15240] }], 'media-source': ['photo'] });
    assert.equal(a.media, null);
    assert.equal(b.media, 'iso_a5_148x210mm');
    assert.equal(b.mediaCol, null);
    assert.deepEqual([d.media, d.mediaCol], [null, null], 'was der Drucker nicht nennt, geht nicht hin');
  } finally { ps.stop(); await fp.close(); }
});

test('Zustand beim Drucken: hält der Drucker an (Papier leer), meldet das Gateway den Grund', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  let polls = 0;
  const reasons = { v: ['none'] };
  const fake = {
    getJobAttributes: async () => {
      polls += 1;
      if (polls <= 2) return { state: 'stopped', reasons: ['printer-stopped'] };
      if (polls === 3) return { state: 'processing', reasons: ['job-printing'] };
      return { state: 'completed', reasons: [] };
    },
  };
  const { ps } = service(fp, srv, { ipp: fake });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    fp.state.opts.printer = { reasons: ['media-empty-error'], state: 5 };
    srv.addJob('job_stop00001', Buffer.from('%PDF-1.4 x'));
    void reasons;
    await ps.pollJobs();
    const st = srv.of('/api/v1/gateway/print/jobs/job_stop00001');
    assert.deepEqual(st.map((b) => [b.state, b.message || null]), [['sending', null], ['printing', null], ['printing', 'media-empty'], ['printing', null], ['done', null]]);
  } finally { ps.stop(); await fp.close(); }
});

// ─── Office-Dateien ─────────────────────────────────────────────────────

/** Ein Wächter office.sh im Hintergrund (ctlDir), soffice: echtes oder ein Ersatz. */
function startWatcher(ctlDir, env = {}) {
  fs.mkdirSync(ctlDir, { recursive: true });
  const office = new OfficeService({ ctlDir, pollMs: 50, ...env.opts });
  office.apply(true); // legt office.sh, run, in/ und out/ an
  const child = spawn('/bin/sh', [path.join(ctlDir, 'office.sh')], {
    env: { ...process.env, GC_OFFICE_DIR: ctlDir, GC_OFFICE_TMP: tmp('gw-office-t-'), ...env.vars }, stdio: 'ignore',
  });
  return { office, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); }) };
}

async function until(fn, ms = 20_000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
}

test('office.js: an/aus, Wunsch für das Pi-Image, Bitte an den Host; Zustand des Wächters', async (t) => {
  const ctl = tmp('gw-office-ctl-');
  const state = tmp('gw-office-state-');
  t.after(() => { fs.rmSync(ctl, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(state, 'hardware.json'), JSON.stringify({ office_start: true }));
  let now = 1_800_000_000_000;
  const o = new OfficeService({ ctlDir: ctl, stateDir: state, now: () => now });
  assert.equal(o.service(), 'absent');
  o.apply(true);
  assert.ok(fs.existsSync(path.join(ctl, 'run')));
  assert.ok(fs.readFileSync(path.join(ctl, 'office.sh')).equals(fs.readFileSync(path.join(__dirname, '..', 'src', 'print', 'office.sh'))));
  assert.equal(fs.readFileSync(path.join(state, 'office.json'), 'utf8'), '{"want":true}\n');
  assert.ok(fs.existsSync(path.join(state, 'office-start')), 'Pi-Image: Host soll den Dienst anlegen');
  fs.writeFileSync(path.join(ctl, 'office.state'), `running ${Math.floor(now / 1000)}\n`);
  assert.equal(o.service(), 'managed');
  assert.equal(o.ready(), true);
  now += 120_000;
  assert.equal(o.service(), 'absent', 'Wächter meldet sich nicht mehr');
  o.apply(false);
  assert.ok(!fs.existsSync(path.join(ctl, 'run')));
  assert.equal(fs.readFileSync(path.join(state, 'office.json'), 'utf8'), '{"want":false}\n');
  await assert.rejects(o.toPdf('job_aaaaaaaa1', path.join(FX, 'sample.docx'), TYPES['application/rtf'] ? 'application/rtf' : 'x', path.join(ctl, 'x.pdf')), { code: 'office_off' });
  assert.equal(new OfficeService({ ctlDir: path.join(ctl, 'nope') }).service(), 'missing');
});

test('office.sh mit Ersatz-soffice: Erfolg, Fehler, falscher Typ; ein Auftrag nach dem anderen', async (t) => {
  const ctl = tmp('gw-office-fake-');
  const bin = tmp('gw-office-bin-');
  // Ersatz: schreibt ein PDF namens <Datei>.pdf in --outdir; „fail“ im Namen → Fehler
  fs.writeFileSync(path.join(bin, 'soffice'), `#!/bin/sh
out=""; src=""
while [ $# -gt 0 ]; do case "$1" in --outdir) out="$2"; shift ;; -*) ;; *) src="$1" ;; esac; shift; done
case "$src" in *fail*) exit 3 ;; esac
b="\${src##*/}"; b="\${b%.*}"
printf '%%PDF-1.4 fake %s\\n' "$b" > "$out/$b.pdf"
`, { mode: 0o755 });
  const w = startWatcher(ctl, { vars: { GC_SOFFICE: path.join(bin, 'soffice') } });
  t.after(async () => { await w.stop(); fs.rmSync(ctl, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  await until(() => w.office.service() === 'managed');
  const src = path.join(ctl, 'src.docx');
  fs.writeFileSync(src, 'PK fake');
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const [r1, r2] = await Promise.all([
    w.office.toPdf('job_office001', src, docx, path.join(ctl, 'a.pdf')),
    w.office.toPdf('job_office002', src, 'application/rtf', path.join(ctl, 'b.pdf')),
  ]);
  assert.match(fs.readFileSync(r1.file, 'utf8'), /^%PDF-1.4 fake job_office001/);
  assert.match(fs.readFileSync(r2.file, 'utf8'), /^%PDF-1.4 fake job_office002/);
  await assert.rejects(w.office.toPdf('job_failfail1', src, docx, path.join(ctl, 'c.pdf')), { code: 'office_failed' });
  await assert.rejects(w.office.toPdf('job_office003', src, 'text/plain', path.join(ctl, 'd.pdf')), { code: 'office_type' });
  // aufgeräumt: nichts bleibt in in/ und out/
  assert.deepEqual(fs.readdirSync(path.join(ctl, 'in')), []);
  assert.deepEqual(fs.readdirSync(path.join(ctl, 'out')), []);
});

test('office.sh mit echtem LibreOffice: docx, xlsx, pptx, odt, ods, odp, rtf → PDF', async (t) => {
  const ctl = tmp('gw-office-real-');
  const w = startWatcher(ctl, { opts: { timeoutMs: 120_000 } });
  t.after(async () => { await w.stop(); fs.rmSync(ctl, { recursive: true, force: true }); });
  await until(() => w.office.service() === 'managed');
  for (const [mime, ext] of Object.entries(TYPES)) {
    const r = await w.office.toPdf(`job_real_${ext}`, path.join(FX, `sample.${ext}`), mime, path.join(ctl, `${ext}.pdf`));
    const head = fs.readFileSync(r.file).subarray(0, 5).toString('latin1');
    assert.equal(head, '%PDF-', ext);
    assert.match(execFileSync('pdfinfo', [r.file]).toString(), /Pages:\s+[1-9]/, ext);
  }
});

test('Druckauftrag mit Office-Datei: erst PDF (Dienst office), dann gedruckt; aus → failed; Dienst fehlt → wartet', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const pdf = fs.readFileSync(path.join(FX, 'sample.pdf'));
  let ready = true;
  const office = {
    apply() {}, ready: () => ready, snapshot: () => ({ enabled: true, service: ready ? 'managed' : 'absent' }),
    toPdf: async (id, src, mime, dst) => { assert.equal(mime, docx); fs.writeFileSync(dst, pdf); return { file: dst, size: pdf.length }; },
  };
  const { ps } = service(fp, srv, { opts: { office } });
  try {
    await ps.apply({ enabled: true, manual: [], office: true });
    await ps.search();
    assert.equal(srv.of('/api/v1/gateway/print/devices').pop().devices[0].printer.office, true);
    srv.addJob('job_office101', fs.readFileSync(path.join(FX, 'sample.docx')), { format: docx });
    await ps.pollJobs();
    const st = srv.of('/api/v1/gateway/print/jobs/job_office101');
    assert.deepEqual(st.map((b) => b.state), ['sending', 'sending', 'printing', 'done']);
    assert.equal(st[0].message, 'converting_office');
    assert.equal(st[2].pages, 1, 'Seitenzahl nach dem Umwandeln');
    assert.equal(fp.state.printed[0].format, 'application/pdf');
    assert.ok(fp.state.printed[0].data.subarray(0, 5).equals(Buffer.from('%PDF-')));
    // Dienst noch nicht da → wartet (bis er läuft oder der Auftrag abläuft)
    ready = false;
    srv.jobs = [];
    srv.addJob('job_office102', Buffer.from('PK\x03\x04 docx'), { format: docx });
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_office102').map((b) => [b.state, b.error]), [['waiting', 'office_starting']]);
    // ausgeschaltet → failed office_off, ohne Download
    await ps.apply({ enabled: true, manual: [], office: false });
    srv.jobs = [];
    srv.addJob('job_office103', Buffer.from('PK\x03\x04 docx'), { format: docx });
    await ps.pollJobs();
    const off = srv.of('/api/v1/gateway/print/jobs/job_office103').pop();
    assert.deepEqual([off.state, off.error, off.message], ['failed', 'format_unsupported', 'office_off']);
    assert.equal(srv.of('/api/v1/gateway/print/devices').pop().devices[0].printer.office, false);
  } finally { ps.stop(); await fp.close(); }
});

// ─── Texterkennung ──────────────────────────────────────────────────────

test('ocr.js: Werkzeuge und Sprachen deu+eng da; zwei Seiten → durchsuchbares PDF und Text', async (t) => {
  assert.equal(ocr.available(), true);
  assert.deepEqual(ocr.probe().langs, ['deu', 'eng']);
  const dir = tmp('gw-ocr-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = [];
  const page = path.join(FX, 'scan-page.jpg');
  const r = await ocr.recognize([page, page], { dir, dpi: 150, onPage: (n) => pages.push(n) });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(r.pages, 2);
  assert.match(r.text, /Rechnung Nr\. 4711/);
  assert.match(execFileSync('pdfinfo', [r.pdf]).toString(), /Pages:\s+2[\s\S]*Page size:\s+59\d\.\d+ x 84\d\.\d+ pts/);
  assert.match(execFileSync('pdftotext', [r.pdf, '-']).toString(), /4711/, 'Text liegt im PDF');
  await assert.rejects(ocr.recognize([page], { dir, pageTimeoutMs: 1 }), { code: 'ocr_timeout' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(ocr.recognize([page], { dir, signal: ac.signal }), { code: 'canceled' });
});

test('Texterkennung im Dienst: Seiten holen, erkennen, PDF + Text hoch, fertig; aus/ungültig/voll abgelehnt', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps } = service(fp, srv);
  const jpg = fs.readFileSync(path.join(FX, 'scan-page.jpg'));
  try {
    await ps.apply({ enabled: true, manual: [], ocr: false });
    assert.equal(ps.requestOcr({ ocrId: 'ocr_aaaaaaaa1', pages: 1 }), 'disabled');
    await ps.apply({ enabled: true, manual: [], ocr: true });
    assert.equal(ps.requestOcr({ ocrId: 'x', pages: 1 }), 'invalid');
    assert.equal(ps.requestOcr({ ocrId: 'ocr_aaaaaaaa1', pages: 0 }), 'invalid');
    srv.ocrPages.set('ocr_aaaaaaaa1/1', jpg);
    srv.ocrPages.set('ocr_aaaaaaaa1/2', jpg);
    assert.equal(ps.requestOcr({ ocrId: 'ocr_aaaaaaaa1', pages: 2, dpi: 150 }), 'accepted');
    assert.equal(ps.requestOcr({ ocrId: 'ocr_aaaaaaaa1', pages: 2, dpi: 150 }), 'accepted', 'doppelt: schon angenommen');
    // die Warteschlange ist begrenzt
    for (let i = 2; i <= 4; i++) assert.equal(ps.requestOcr({ ocrId: `ocr_aaaaaaaa${i}`, pages: 1 }), 'accepted');
    assert.equal(ps.requestOcr({ ocrId: 'ocr_aaaaaaaa9', pages: 1 }), 'busy');
    assert.equal(ps.featureTelemetry().ocr.running, true);
    await until(() => srv.of('/api/v1/gateway/print/ocr/ocr_aaaaaaaa4').some((b) => b.state === 'failed'), 60_000);
    const first = srv.of('/api/v1/gateway/print/ocr/ocr_aaaaaaaa1');
    assert.deepEqual(first.map((b) => [b.state, b.page]), [['running', 0], ['running', 1], ['running', 2], ['done', 2]]);
    const doc = srv.results.find((x) => x.id === 'ocr_aaaaaaaa1' && x.kind === 'document');
    const txt = srv.results.find((x) => x.id === 'ocr_aaaaaaaa1' && x.kind === 'text');
    assert.ok(doc.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.match(txt.body.toString('utf8'), /Rechnung Nr\. 4711/);
    // die anderen haben keine Seiten beim Server: abgebrochen (der Server kennt sie nicht mehr)
    assert.equal(srv.of('/api/v1/gateway/print/ocr/ocr_aaaaaaaa2').pop().error, 'canceled');
    const tel = ps.featureTelemetry().ocr;
    assert.deepEqual([tel.enabled, tel.available, tel.running, tel.queued], [true, true, false, 0]);
  } finally { ps.stop(); await fp.close(); }
});
