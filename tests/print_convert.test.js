'use strict';

// PDF für Drucker ohne PDF (src/print/convert.js, docs/print.md „Umwandeln“):
// Format am Inhalt, Wahl des Rasterformats aus den Drucker-Attributen,
// PWG-/URF-Kodierung (mit einem Dekoder hier im Test geprüft), Seiten
// zurechtlegen und – mit poppler (pdftoppm/pdfinfo) – echte PDF-Seiten.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../src/print/convert');
const ippLib = require('../src/print/ipp');
const { PrintService } = require('../src/print/print');
const { startFakePrinter, mdnsPacket } = require('./helpers/fakePrinter');

// ─── Hilfen ─────────────────────────────────────────────────────────────

/** Ein kleines PDF: pages [{ w, h, ops }] (Inhalt als PDF-Operatoren). */
function makePdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  const kids = [];
  for (const p of pages) {
    const content = Buffer.from(p.ops || '');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
    const cN = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Contents ${cN} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Gepackte Zeilen einer Seite (PWG/URF) → Pixel. */
function unpack(buf, o, width, height, unit, row) {
  const data = Buffer.alloc(row * height);
  let y = 0;
  while (y < height) {
    const rep = buf[o++] + 1;
    const line = Buffer.alloc(row);
    let x = 0;
    while (x < row) {
      const n = buf[o++];
      if (n <= 127) {
        for (let k = 0; k <= n; k++) { buf.copy(line, x, o, o + unit); x += unit; }
        o += unit;
      } else {
        const len = (257 - n) * unit;
        buf.copy(line, x, o, o + len); x += len; o += len;
      }
    }
    for (let k = 0; k < rep && y < height; k++, y++) line.copy(data, y * row);
  }
  return { data, end: o };
}

/** Ein PWG- oder URF-Strom → { format, pages: [{ width, height, dpi, bpp, cs, duplex, total, xf, data }] } */
function decodeRaster(buf) {
  const pages = [];
  if (buf.subarray(0, 4).toString('latin1') === 'RaS2') {
    let o = 4;
    while (o < buf.length) {
      const h = buf.subarray(o, o + 1796);
      o += 1796;
      const u = (k) => h.readUInt32BE(k);
      const p = { width: u(372), height: u(376), dpi: u(276), bpp: u(388), row: u(392), cs: u(400), duplex: u(272), total: u(452), xf: h.readInt32BE(456), name: h.toString('latin1', 1732, 1796).replace(/\0+$/, ''), cls: h.toString('latin1', 0, 9) };
      const r = unpack(buf, o, p.width, p.height, Math.max(1, p.bpp / 8), p.row);
      p.data = r.data;
      o = r.end;
      pages.push(p);
    }
    return { format: 'pwg', pages };
  }
  assert.equal(buf.subarray(0, 8).toString('latin1'), 'UNIRAST\0');
  const count = buf.readUInt32BE(8);
  let o = 12;
  for (let i = 0; i < count; i++) {
    const h = buf.subarray(o, o + 32);
    o += 32;
    const p = { bpp: h[0], cs: h[1], duplex: h[2], width: h.readUInt32BE(12), height: h.readUInt32BE(16), dpi: h.readUInt32BE(20) };
    const unit = p.bpp / 8;
    const r = unpack(buf, o, p.width, p.height, unit, p.width * unit);
    p.data = r.data;
    o = r.end;
    pages.push(p);
  }
  assert.equal(o, buf.length);
  return { format: 'urf', pages };
}

const gray = (p, x, y) => p.data[y * p.width + x];

// HP OfficeJet Pro 8720 (so meldet er sich per IPP): kein application/pdf
const HP_FORMATS = ['application/vnd.hp-pcl', 'image/jpeg', 'application/pclm', 'image/urf', 'image/pwg-raster', 'application/octet-stream'];
const HP_ATTRS = {
  'document-format-supported': HP_FORMATS,
  'pwg-raster-document-resolution-supported': [{ x: 300, y: 300, units: 3 }, { x: 600, y: 600, units: 3 }],
  'pwg-raster-document-type-supported': ['srgb_8', 'sgray_8'],
  'pwg-raster-document-sheet-back': ['rotated'],
  'urf-supported': ['V1.4', 'CP1', 'PQ3-4-5', 'RS300-600', 'SRGB24', 'W8', 'DM3', 'IS1'],
  'media-default': ['iso_a4_210x297mm'],
};

// Die Tests mit echten PDF-Seiten brauchen poppler-utils (pdftoppm, pdfinfo) – im Image und in der CI installiert.
// ─── Format am Inhalt ───────────────────────────────────────────────────

test('sniff: PDF, Bilder und Raster am Inhalt – nicht am Namen', () => {
  assert.equal(c.sniff(Buffer.from('%PDF-1.7\n…')), 'application/pdf');
  // manche Programme schreiben vor %PDF noch etwas (BOM, Leerzeilen, Kopf eines Mailprogramms)
  assert.equal(c.sniff(Buffer.concat([Buffer.from('\xef\xbb\xbf\r\n', 'latin1'), Buffer.from('%PDF-1.4')])), 'application/pdf');
  assert.equal(c.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(c.sniff(Buffer.from('\x89PNG\r\n\x1a\n....', 'latin1')), 'image/png');
  assert.equal(c.sniff(Buffer.from('RaS2....')), 'image/pwg-raster');
  assert.equal(c.sniff(Buffer.from('UNIRAST\0\0\0\0\x01', 'latin1')), 'image/urf');
  assert.equal(c.sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(c.sniff(Buffer.from('\0\0\0\x18ftypheic\0\0', 'latin1')), 'image/heic');
  assert.equal(c.sniff(Buffer.from('PK\x03\x04 Word', 'latin1')), null);
  assert.equal(c.sniff(Buffer.from('ab')), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sniff-'));
  fs.writeFileSync(path.join(dir, 'x'), makePdf([{ w: 595, h: 842 }]));
  assert.equal(c.sniffFile(path.join(dir, 'x')), 'application/pdf');
  assert.equal(c.sniffFile(path.join(dir, 'fehlt')), null);
});

// ─── Was der Drucker nimmt ──────────────────────────────────────────────

test('ipp.printerInfo: Raster-Fähigkeiten; plan: PWG mit 300 dpi, Farbe nach Auftrag, Rückseite gedreht', () => {
  const info = ippLib.printerInfo({ ...HP_ATTRS, 'color-supported': [true] });
  assert.deepEqual(info.raster.pwg, { res: [300, 600], types: ['srgb_8', 'sgray_8'], back: 'rotated' });
  assert.deepEqual(info.raster.urf, { res: [300, 600], types: ['srgb_8', 'sgray_8'], back: 'rotated' });
  assert.equal(info.raster.media, 'iso_a4_210x297mm');
  const color = c.plan(info, { color: true });
  assert.deepEqual([color.format, color.dpi, color.type, color.mono, color.back, color.media.name], ['image/pwg-raster', 300, 'srgb_8', false, 'rotated', 'iso_a4_210x297mm']);
  const mono = c.plan(info, { color: false });
  assert.deepEqual([mono.format, mono.type, mono.mono], ['image/pwg-raster', 'sgray_8', true]);
  assert.equal(c.targetOf(info), 'image/pwg-raster');
});

test('plan: URF, wenn es kein PWG gibt; JPEG als letzter Weg; Herstellerformat allein → null', () => {
  const urfOnly = { formats: ['image/urf'], raster: { urf: c.urfOf(['RS600', 'W8', 'DM2']) } };
  assert.deepEqual(c.urfOf(['RS600', 'W8', 'DM2']), { types: ['sgray_8'], res: [600], back: 'flipped' });
  const p = c.plan(urfOnly, { color: true });
  assert.deepEqual([p.format, p.dpi, p.type, p.back], ['image/urf', 600, 'sgray_8', 'flipped']);
  assert.equal(c.plan({ formats: ['image/jpeg'], raster: {} }, {}).format, 'image/jpeg');
  assert.equal(c.plan({ formats: ['application/vnd.hp-pcl', 'application/octet-stream'], raster: {} }, {}), null);
  // PWG genannt, aber keine Auflösung (kein IPP Everywhere) → nicht raten
  assert.equal(c.plan({ formats: ['image/pwg-raster'], raster: { pwg: null } }, {}), null);
  assert.equal(c.chooseDpi([600, 1200]), 600);
  assert.equal(c.chooseDpi([150, 200]), 200);
  assert.deepEqual(c.mediaOf('na_letter_8.5x11in'), { name: 'na_letter_8.5x11in', w: 612, h: 792 });
  assert.equal(c.mediaOf('custom_max_8000x8000mm'), null);
  // ohne Medium: A4
  assert.equal(c.plan({ formats: ['image/pwg-raster'], raster: { pwg: { res: [300], types: ['sgray_8'] } } }, {}).media.name, 'iso_a4_210x297mm');
});

// ─── Kodierung ──────────────────────────────────────────────────────────

test('packLine/packPage: Wiederholungen, wörtliche Folgen, gleiche Zeilen – verlustfrei', () => {
  const rnd = crypto.createHash('sha256');
  const bytes = [];
  for (let i = 0; bytes.length < 3 * 700; i++) bytes.push(...rnd.copy().update(String(i)).digest());
  for (const unit of [1, 3]) {
    const width = 700;
    const rows = [];
    rows.push(Buffer.alloc(width * unit, 0xff)); // weiß
    rows.push(Buffer.alloc(width * unit, 0xff)); // gleiche Zeile
    rows.push(Buffer.from(bytes.slice(0, width * unit))); // Rauschen
    const mixed = Buffer.alloc(width * unit, 0xff);
    for (let x = 100; x < 101; x++) mixed.fill(0, x * unit, (x + 1) * unit); // ein einzelnes Pixel
    for (let x = 300; x < 650; x++) mixed.fill(x % 2 ? 0 : 0x80, x * unit, (x + 1) * unit); // wechselnd
    rows.push(mixed);
    rows.push(Buffer.from(bytes.slice(5, 5 + width * unit)));
    const img = { width, height: rows.length, bpp: unit, data: Buffer.concat(rows) };
    const packed = c.packPage(img);
    const back = unpack(packed, 0, width, rows.length, unit, width * unit);
    assert.equal(back.end, packed.length);
    assert.ok(back.data.equals(img.data), `unit ${unit}`);
    assert.ok(packed.length < img.data.length, 'weiße Zeilen werden kurz');
  }
  // eine Zeile aus einem Pixel, aus zwei verschiedenen
  assert.deepEqual([...c.packLine(Buffer.from([7]), 1)], [0, 7]);
  assert.deepEqual([...c.packLine(Buffer.from([7, 8]), 1)], [255, 7, 8]);
});

test('parsePnm: Kopf linear gelesen (auch Kommentare); bösartige Köpfe schnell abgelehnt', () => {
  const px = Buffer.from([1, 2, 3, 4, 5, 6]);
  const ok = c.parsePnm(Buffer.concat([Buffer.from('P5\n# von pdftoppm\n3 2\n255\n'), px]));
  assert.deepEqual([ok.width, ok.height, ok.bpp, ...ok.data], [3, 2, 1, 1, 2, 3, 4, 5, 6]);
  const rgb = c.parsePnm(Buffer.concat([Buffer.from('P6 1 2 255 '), px]));
  assert.deepEqual([rgb.width, rgb.height, rgb.bpp, rgb.data.length], [1, 2, 3, 6]);
  // „P5 #“ und viele „ #“: früher exponentielles Backtracking im regulären Ausdruck
  const evil = Buffer.from('P5 #' + ' #'.repeat(50000));
  const t0 = Date.now();
  assert.throws(() => c.parsePnm(evil), { code: 'convert_failed' });
  assert.ok(Date.now() - t0 < 200, 'linear');
  for (const bad of ['P4\n3 2\n255\n', 'P5\n3 2\n65535\n', 'P5\n3\n', 'P5 x 2 255 ', 'P5\n0 2\n255\n']) {
    assert.throws(() => c.parsePnm(Buffer.concat([Buffer.from(bad), px])), { code: 'convert_failed' }, bad);
  }
  assert.throws(() => c.parsePnm(Buffer.from('P5\n3 2\n255\n\x01')), /short renderer output/);
});

test('pwgHeader: Felder an den Stellen von PWG 5102.4; urfHeader', () => {
  const h = c.pwgHeader({ width: 2480, height: 3508, dpi: 300, type: 'srgb_8', media: c.A4, duplex: true, pages: 3, transform: -1 });
  assert.equal(h.length, 1796);
  assert.equal(h.toString('latin1', 0, 9), 'PwgRaster');
  assert.deepEqual([h.readUInt32BE(272), h.readUInt32BE(276), h.readUInt32BE(280)], [1, 300, 300]);
  assert.deepEqual([h.readUInt32BE(352), h.readUInt32BE(356)], [595, 842]);
  assert.deepEqual([h.readUInt32BE(372), h.readUInt32BE(376), h.readUInt32BE(384), h.readUInt32BE(388), h.readUInt32BE(392)], [2480, 3508, 8, 24, 7440]);
  assert.deepEqual([h.readUInt32BE(400), h.readUInt32BE(420), h.readUInt32BE(452), h.readInt32BE(456), h.readInt32BE(460)], [19, 3, 3, -1, -1]);
  assert.equal(h.toString('latin1', 1732, 1748), 'iso_a4_210x297mm');
  const g = c.pwgHeader({ width: 100, height: 10, dpi: 300, type: 'black_1', media: c.A4, duplex: false, pages: 1 });
  assert.deepEqual([g.readUInt32BE(384), g.readUInt32BE(388), g.readUInt32BE(392), g.readUInt32BE(400)], [1, 1, 13, 3]);
  const u = c.urfHeader({ width: 2480, height: 3508, dpi: 300, type: 'sgray_8', duplex: true });
  assert.deepEqual([u[0], u[1], u[2], u.readUInt32BE(12), u.readUInt32BE(16), u.readUInt32BE(20)], [8, 0, 3, 2480, 3508, 300]);
});

test('layout: hochkant bleibt, quer wird gedreht, zu groß verkleinert, nie vergrößert', () => {
  const a4 = c.A4;
  const same = c.layout({ w: a4.w, h: a4.h }, a4, 300);
  assert.deepEqual([same.W, same.H, same.turn, same.rw, same.rh, same.x, same.y], [2480, 3508, false, 2480, 3508, 0, 0]);
  const land = c.layout({ w: a4.h, h: a4.w }, a4, 300);
  assert.deepEqual([land.turn, land.rw, land.rh], [true, 3508, 2480]);
  const letter = c.layout({ w: 612, h: 792 }, a4, 300); // Letter auf A4: etwas schmaler
  assert.ok(letter.rw <= 2480 && letter.rh < 3508 && letter.y > 0);
  const a6 = c.layout({ w: 298, h: 420 }, a4, 300); // klein: in der Mitte, Originalgröße
  assert.deepEqual([a6.rw, a6.rh], [1242, 1750]);
  assert.equal(a6.x, Math.floor((2480 - 1242) / 2));
});

test('rotate90, backSide, onSheet, toType', () => {
  // 3 × 2, Grau: Zeilen [1 2 3] [4 5 6]
  const img = { width: 3, height: 2, bpp: 1, data: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const r = c.rotate90(img); // gegen den Uhrzeigersinn: oben → links
  assert.deepEqual([r.width, r.height, ...r.data], [2, 3, 3, 6, 2, 5, 1, 4]);
  assert.deepEqual([...c.backSide(img, 'rotated').data], [6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...c.backSide(img, 'flipped').data], [4, 5, 6, 1, 2, 3]);
  assert.equal(c.backSide(img, 'normal'), img);
  assert.equal(c.backSide(img, 'manual-tumble'), img);
  const s = c.onSheet(img, 5, 4, 1, 1);
  assert.deepEqual([...s.data], [255, 255, 255, 255, 255, 255, 1, 2, 3, 255, 255, 4, 5, 6, 255, 255, 255, 255, 255, 255]);
  const rgb = c.toType(img, 'srgb_8');
  assert.deepEqual([rgb.bpp, ...rgb.data.subarray(0, 6)], [3, 1, 1, 1, 2, 2, 2]);
  const bw = c.toType({ width: 9, height: 1, bpp: 1, data: Buffer.from([0, 255, 0, 255, 255, 255, 255, 255, 10]) }, 'black_1');
  assert.deepEqual([bw.row, ...bw.data], [2, 0b10100000, 0b10000000]);
});

// ─── Echte PDF-Seiten (poppler) ─────────────────────────────────────────

test('poppler-utils sind da (Image: apk poppler-utils, CI: apt poppler-utils)', () => {
  assert.equal(c.available(), true);
});

const BOX = (w, h) => `0 0 0 rg 0 ${h - 72} 72 72 re f`; // schwarzes Quadrat oben links (1 Zoll)

test('convert: PDF → PWG-Raster (hochkant, quer gedreht, Rückseite gedreht), mit poppler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-convert-'));
  const src = path.join(dir, 'in.pdf');
  fs.writeFileSync(src, makePdf([{ w: 595, h: 842, ops: BOX(595, 842) }, { w: 842, h: 595, ops: BOX(842, 595) }, { w: 595, h: 842, ops: BOX(595, 842) }]));
  const plan = { format: c.PWG, dpi: 72, type: 'sgray_8', mono: true, back: 'rotated', media: c.A4 };
  const out = await c.convert(src, path.join(dir, 'out'), plan, { duplex: true });
  assert.deepEqual([out.format, out.pages, out.files.length], ['image/pwg-raster', 3, 1]);
  const r = decodeRaster(fs.readFileSync(out.files[0].file));
  assert.equal(r.pages.length, 3);
  for (const p of r.pages) assert.deepEqual([p.cls, p.width, p.height, p.dpi, p.bpp, p.cs, p.duplex, p.total, p.name], ['PwgRaster', 595, 842, 72, 8, 18, 1, 3, 'iso_a4_210x297mm']);
  const [p1, p2, p3] = r.pages;
  // Seite 1: Quadrat oben links, unten rechts weiß
  assert.ok(gray(p1, 10, 10) < 64 && gray(p1, 580, 830) > 200);
  // Seite 2 (Rückseite, quer): gedreht auf hochkant (oben → links), dann für den Drucker um 180°
  assert.equal(p2.xf, -1);
  assert.ok(gray(p2, 584, 30) < 64, 'Quadrat nach dem Drehen oben rechts');
  assert.ok(gray(p2, 10, 10) > 200);
  assert.ok(gray(p3, 10, 10) < 64 && p3.xf === 1);
});

test('convert: URF in Farbe und JPEG je Seite; kaputtes PDF → convert_failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-convert-'));
  const src = path.join(dir, 'in.pdf');
  fs.writeFileSync(src, makePdf([{ w: 595, h: 842, ops: '1 0 0 rg 0 770 72 72 re f' }, { w: 595, h: 842 }]));
  const u = await c.convert(src, path.join(dir, 'u'), { format: c.URF, dpi: 72, type: 'srgb_8', mono: false, back: 'normal', media: c.A4 }, {});
  const r = decodeRaster(fs.readFileSync(u.files[0].file));
  assert.deepEqual([r.pages.length, r.pages[0].bpp, r.pages[0].cs, r.pages[0].duplex, r.pages[0].width], [2, 24, 1, 1, 595]);
  const px = r.pages[0].data.subarray((10 * 595 + 10) * 3, (10 * 595 + 10) * 3 + 3);
  assert.ok(px[0] > 200 && px[1] < 64 && px[2] < 64, 'rot bleibt rot');
  const j = await c.convert(src, path.join(dir, 'j'), { format: c.JPEG, dpi: 50, type: 'sgray_8', mono: true, back: 'normal', media: c.A4 }, {});
  assert.equal(j.files.length, 2);
  for (const f of j.files) assert.equal(c.sniffFile(f.file), 'image/jpeg');
  fs.writeFileSync(path.join(dir, 'bad.pdf'), '%PDF-1.4\nkaputt');
  await assert.rejects(c.convert(path.join(dir, 'bad.pdf'), path.join(dir, 'b'), { format: c.PWG, dpi: 72, type: 'sgray_8', back: 'normal', media: c.A4 }, {}), { code: 'convert_failed' });
  assert.equal(fs.existsSync(path.join(dir, 'b')), false);
  await assert.rejects(c.convert(src, path.join(dir, 'big'), { format: c.PWG, dpi: 72, type: 'srgb_8', back: 'normal', media: c.A4 }, { maxBytes: 2000 }), { code: 'convert_too_large' });
  assert.equal(fs.existsSync(path.join(dir, 'big')), false);
});

// ─── Im Druckdienst ─────────────────────────────────────────────────────

const ID = 'u:f0d8a1b2000010008000' + '00aabbccddee';
const HP_PRINTER = { formats: HP_FORMATS, pwgRes: [300, 600], pwgTypes: ['srgb_8', 'sgray_8'], sheetBack: 'rotated', urf: HP_ATTRS['urf-supported'], media: 'iso_a4_210x297mm' };

function fakeServer() {
  const s = { posts: [], jobs: [], files: new Map() };
  s.reporter = { post: async (p, body) => { s.posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return { ok: true, status: 200 }; } };
  s.client = {
    jobs: async () => ({ changed: true, jobs: s.jobs.slice(), etag: '"x"' }),
    file: async (id, sha, size, dest) => { fs.writeFileSync(dest, s.files.get(id)); },
  };
  s.addJob = (id, body, extra = {}) => {
    s.files.set(id, body);
    s.jobs.push({ id, deviceId: ID, format: 'application/pdf', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), copies: 1, color: false, duplex: false, name: 'Digitaler Elternabend.pdf', user: 'Marc', ...extra });
  };
  s.of = (p) => s.posts.filter((x) => x.path === p).map((x) => x.body);
  return s;
}

function service(fp, srv, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-print-conv-'));
  const to = (ep) => ({ ...ep, host: '127.0.0.1', port: fp.port });
  const ps = new PrintService({
    reporter: srv.reporter, client: srv.client, stateDir: dir,
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }],
    browse: async () => [mdnsPacket({ ip: '192.168.1.57' })],
    ipp: { ...ippLib, getPrinterAttributes: (ep, o) => ippLib.getPrinterAttributes(to(ep), o), printJob: (ep, ...a) => ippLib.printJob(to(ep), ...a), getJobAttributes: (ep, ...a) => ippLib.getJobAttributes(to(ep), ...a) },
    escl: { capabilities: async () => { throw Object.assign(new Error('x'), { code: 'network' }); }, status: async () => ({}) },
    retryMs: 50, jobPollMs: 10, jobWatchMs: 2000, browseMs: 10, cycleMs: 3600_000, jobsMs: 3600_000,
    ...extra,
  });
  return { ps, dir };
}

/** Ein Umwandler ohne poppler: schreibt einen erkennbaren Raster-Strom. */
const fakeConverter = (log = []) => ({
  ...c,
  available: () => true,
  convert: async (src, dst, plan, opts) => {
    log.push({ plan, opts, sniff: c.sniffFile(src) });
    const body = Buffer.concat([Buffer.from(plan.format === c.URF ? 'UNIRAST\0' : 'RaS2', 'latin1'), Buffer.from('seiten')]);
    fs.writeFileSync(dst, body);
    return { format: plan.format, pages: 1, files: [{ file: dst, size: body.length }] };
  },
});

test('Drucker ohne PDF (HP OfficeJet Pro 8720): Bericht nennt convert, Auftrag als PWG-Raster gedruckt', async () => {
  const fp = await startFakePrinter({ printer: HP_PRINTER });
  const srv = fakeServer();
  const log = [];
  const { ps, dir } = service(fp, srv, { converter: fakeConverter(log) });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    const rep = srv.of('/api/v1/gateway/print/devices').pop();
    assert.equal(rep.devices[0].printer.convert, 'image/pwg-raster');
    assert.equal(rep.devices[0].printer.raster, undefined, 'Raster-Einzelheiten bleiben im Gateway');
    assert.deepEqual(ps.featureTelemetry().convert, { enabled: true, available: true });
    srv.addJob('job_conv00001', makePdf([{ w: 595, h: 842 }]), { duplex: true, color: true });
    await ps.pollJobs();
    const states = srv.of('/api/v1/gateway/print/jobs/job_conv00001').map((b) => [b.state, b.message || null]);
    assert.deepEqual(states, [['sending', 'converting'], ['sending', null], ['printing', null], ['done', null]]);
    assert.equal(fp.state.printed.length, 1);
    assert.equal(fp.state.printed[0].format, 'image/pwg-raster');
    assert.equal(fp.state.printed[0].data.subarray(0, 4).toString(), 'RaS2');
    assert.equal(fp.state.printed[0].color, 'color');
    assert.equal(fp.state.printed[0].sides, 'two-sided-long-edge');
    assert.deepEqual([log[0].plan.format, log[0].plan.dpi, log[0].plan.type, log[0].plan.back, log[0].opts.duplex, log[0].sniff], ['image/pwg-raster', 300, 'srgb_8', 'rotated', true, 'application/pdf']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'print-tmp')), [], 'Datei und Umwandlung weg');
  } finally { ps.stop(); await fp.close(); }
});

test('Ende zu Ende mit poppler: einseitiger Elternbrief (PDF) → PWG-Raster 300 dpi A4, Graustufen', async () => {
  const fp = await startFakePrinter({ printer: HP_PRINTER });
  const srv = fakeServer();
  const { ps } = service(fp, srv);
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    srv.addJob('job_conv00003', makePdf([{ w: 595.28, h: 841.89, ops: BOX(595.28, 841.89) }]));
    await ps.pollJobs();
    assert.equal(fp.state.printed.length, 1);
    assert.equal(fp.state.printed[0].format, 'image/pwg-raster');
    assert.equal(fp.state.printed[0].color, 'monochrome');
    const r = decodeRaster(fp.state.printed[0].data);
    assert.deepEqual(r.pages.map((p) => [p.width, p.height, p.dpi, p.cs, p.total]), [[2480, 3508, 300, 18, 1]]);
    assert.ok(gray(r.pages[0], 50, 50) < 64 && gray(r.pages[0], 2400, 3400) > 200);
  } finally { ps.stop(); await fp.close(); }
});

test('„PDF umwandeln“ aus: abgelehnt mit Grund convert_off, Bericht ohne convert; Umschalten meldet sofort', async () => {
  // ohne application/octet-stream (das hieße: „schick, ich erkenne es selbst“ – dann ginge das PDF wie bisher unverändert raus)
  const fp = await startFakePrinter({ printer: { ...HP_PRINTER, formats: HP_FORMATS.filter((f) => f !== 'application/octet-stream') } });
  const srv = fakeServer();
  const { ps } = service(fp, srv, { converter: fakeConverter() });
  try {
    await ps.apply({ enabled: true, manual: [], convert: false });
    await ps.search();
    assert.equal(srv.of('/api/v1/gateway/print/devices').pop().devices[0].printer.convert, null);
    srv.addJob('job_conv00002', makePdf([{ w: 595, h: 842 }]));
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_conv00002').map((b) => [b.state, b.error, b.message]), [['failed', 'format_unsupported', 'convert_off']]);
    assert.equal(fp.state.printed.length, 0);
    const before = srv.of('/api/v1/gateway/print/devices').length;
    await ps.apply({ enabled: true, manual: [], convert: true });
    await new Promise((r) => setImmediate(r));
    const after = srv.of('/api/v1/gateway/print/devices');
    assert.equal(after.length, before + 1);
    assert.equal(after.pop().devices[0].printer.convert, 'image/pwg-raster');
  } finally { ps.stop(); await fp.close(); }
});

test('Format am Inhalt: „application/octet-stream“, das ein PDF ist, geht als PDF an einen PDF-Drucker', async () => {
  const fp = await startFakePrinter();
  const srv = fakeServer();
  const { ps } = service(fp, srv, { converter: fakeConverter() });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    srv.addJob('job_sniff0001', makePdf([{ w: 595, h: 842 }]), { format: 'application/octet-stream' });
    await ps.pollJobs();
    assert.equal(fp.state.printed[0].format, 'application/pdf');
  } finally { ps.stop(); await fp.close(); }
});

test('Drucker nennt PDF, lehnt es aber ab (0x040a): einmal umgewandelt gedruckt; ohne Umwandler: format_unsupported', async () => {
  const fp = await startFakePrinter({ printer: { ...HP_PRINTER, formats: ['application/pdf', ...HP_FORMATS] }, refuse: ['application/pdf'] });
  const srv = fakeServer();
  const { ps } = service(fp, srv, { converter: fakeConverter() });
  try {
    await ps.apply({ enabled: true, manual: [] });
    await ps.search();
    srv.addJob('job_refuse001', makePdf([{ w: 595, h: 842 }]));
    await ps.pollJobs();
    assert.equal(fp.state.printed.length, 1);
    assert.equal(fp.state.printed[0].format, 'image/pwg-raster');
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_refuse001').map((b) => b.state), ['sending', 'sending', 'printing', 'done']);
    ps.converter = { ...c, available: () => false };
    srv.jobs = [];
    srv.addJob('job_refuse002', makePdf([{ w: 595, h: 842 }]));
    await ps.pollJobs();
    assert.deepEqual(srv.of('/api/v1/gateway/print/jobs/job_refuse002').map((b) => [b.state, b.error || null, b.message || null]), [['sending', null, null], ['failed', 'format_unsupported', 'printer_refused']]);
  } finally { ps.stop(); await fp.close(); }
});
