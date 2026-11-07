'use strict';

// PDF für Drucker ohne PDF (docs/print.md „Umwandeln“): viele Tintenstrahler
// (z. B. HP OfficeJet Pro 8720) nennen in `document-format-supported` nur
// image/pwg-raster, image/urf, image/jpeg und eigene Formate. Das Gateway
// rendert die Seiten dann selbst (poppler: pdfinfo, pdftoppm – je Seite ein
// Prozess, niedrige Priorität) und schreibt PWG-Raster (IPP Everywhere),
// Apple-Raster (URF, AirPrint) oder je Seite ein JPEG – in der Auflösung,
// den Farbarten, dem Papier und der Rückseiten-Lage, die der Drucker nennt.
// Dazu das Erkennen des Formats am Inhalt (sniff) statt am Namen.
//
// PCLm (Wi-Fi Alliance, viele HP-Drucker nennen nur das): ein PDF, dessen Seiten
// aus waagerechten Bildstreifen bestehen – je Streifen ein Bild (Flate oder
// Run-Length), Höhe, Auflösung und Rückseiten-Lage, wie der Drucker sie nennt
// (pclm-strip-height-preferred, pclm-source-resolution-supported,
// pclm-compression-method-preferred, pclm-raster-back-side). Das Gateway
// schreibt es selbst (zlib), ohne weiteres Werkzeug.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');

const PWG = 'image/pwg-raster';
const URF = 'image/urf';
const JPEG = 'image/jpeg';
const PDF = 'application/pdf';
const PCLM = 'application/pclm'; // so (klein) in `formats`; an den Drucker geht „application/PCLm“
const PCLM_IPP = 'application/PCLm';

const PREFERRED_DPI = 300;
const PAGE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 1024 * 1024 * 1024; // 1 GiB Rasterdaten je Auftrag
const MAX_PAGE_PIXELS = 120e6;
const MAX_INFO = 4 * 1024 * 1024;
const PT_PER_MM = 72 / 25.4;
const A4 = Object.freeze({ name: 'iso_a4_210x297mm', w: 210 * PT_PER_MM, h: 297 * PT_PER_MM });
const SHEET_BACK = ['normal', 'flipped', 'rotated', 'manual-tumble'];

class ConvertError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ─── Format am Inhalt erkennen ──────────────────────────────────────────

/** Die ersten Bytes einer Datei → MIME-Typ oder null (nicht erkannt). */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const at = (s, o = 0) => buf.length >= o + s.length && buf.subarray(o, o + s.length).equals(Buffer.from(s, 'latin1'));
  if (buf.subarray(0, 1024).indexOf('%PDF-') >= 0) return buf.subarray(0, 64).indexOf('%PCLm') >= 0 ? PCLM : PDF;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return JPEG;
  if (at('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at('RaS2')) return PWG;
  if (at('UNIRAST\0')) return URF;
  if (at('GIF87a') || at('GIF89a')) return 'image/gif';
  if (at('RIFF') && at('WEBP', 8)) return 'image/webp';
  if (at('II*\0') || at('MM\0*')) return 'image/tiff';
  if (at('ftyp', 4) && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  if (at('%!PS')) return 'application/postscript';
  return null;
}

/** Format einer Datei am Inhalt (die ersten 1024 Bytes). */
function sniffFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return sniff(b.subarray(0, n));
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_e) { /* schon zu */ }
  }
}

// ─── Was der Drucker nimmt ──────────────────────────────────────────────

const dpiOf = (r) => {
  if (!r || typeof r !== 'object' || !Number.isInteger(r.x) || r.x <= 0) return null;
  const dpi = r.units === 4 ? Math.round(r.x * 2.54) : r.x; // 3 = dpi, 4 = dpcm
  return r.y === r.x && dpi >= 72 && dpi <= 2400 ? dpi : null;
};

/** PWG-Medienname ("iso_a4_210x297mm", "na_letter_8.5x11in") → { name, w, h } in Punkt, sonst null. */
function mediaOf(name) {
  if (typeof name !== 'string' || name.length > 80) return null;
  const m = /_(\d{1,5}(?:\.\d{1,4})?)x(\d{1,5}(?:\.\d{1,4})?)(mm|in)$/.exec(name);
  if (!m) return null;
  const k = m[3] === 'mm' ? PT_PER_MM : 72;
  const w = Number(m[1]) * k;
  const h = Number(m[2]) * k;
  if (!(w >= 144 && h >= 144 && w <= 2600 && h <= 3700)) return null;
  return { name: name.slice(0, 63), w, h };
}

/** URF-Schlüsselwörter (urf-supported: "W8", "SRGB24", "RS300-600", "DM3", …) → { types, res, back } */
function urfOf(list) {
  const out = { types: [], res: [], back: 'normal' };
  for (const k of list) {
    if (typeof k !== 'string') continue;
    if (/^W8(-|$)/.test(k)) out.types.push('sgray_8');
    else if (/^SRGB24(-|$)/.test(k)) out.types.push('srgb_8');
    else if (/^RS\d/.test(k)) out.res.push(...k.slice(2).split('-').map(Number).filter((n) => Number.isInteger(n) && n >= 72 && n <= 2400));
    else if (/^DM[1-4]$/.test(k)) out.back = SHEET_BACK[Number(k[2]) - 1];
  }
  return out;
}

/**
 * Die Raster-Fähigkeiten aus Get-Printer-Attributes (ipp.printerInfo) → { pwg, urf, media }.
 * pwg/urf: { res: [dpi], types: ['srgb_8', 'sgray_8', 'black_1'], back } oder null.
 */
function rasterInfo(a) {
  const list = (k) => (Array.isArray(a[k]) ? a[k].filter((x) => x != null) : []);
  const pwgRes = list('pwg-raster-document-resolution-supported').map(dpiOf).filter(Boolean);
  const pwgTypes = list('pwg-raster-document-type-supported').filter((t) => typeof t === 'string');
  const back = list('pwg-raster-document-sheet-back').find((x) => SHEET_BACK.includes(x)) || 'normal';
  const urf = urfOf(list('urf-supported'));
  const media = mediaOf(list('media-ready').find((x) => typeof x === 'string' && mediaOf(x)) || list('media-default')[0]);
  const pclmRes = list('pclm-source-resolution-supported').map(dpiOf).filter(Boolean);
  const strip = list('pclm-strip-height-preferred').find((n) => Number.isInteger(n) && n >= 1 && n <= 1024);
  const comp = list('pclm-compression-method-preferred').filter((k) => typeof k === 'string').map((k) => k.toLowerCase());
  const pclmBack = list('pclm-raster-back-side').find((x) => SHEET_BACK.includes(x)) || 'normal';
  return {
    pwg: pwgRes.length ? { res: [...new Set(pwgRes)].slice(0, 8), types: pwgTypes.filter((t) => ['srgb_8', 'sgray_8', 'black_1'].includes(t)), back } : null,
    urf: urf.res.length && urf.types.length ? { res: [...new Set(urf.res)].slice(0, 8), types: [...new Set(urf.types)], back: urf.back } : null,
    // PCLm: ohne genannte Auflösung 300 dpi (Pflicht für PCLm-Drucker), Streifen 16 Zeilen
    pclm: { res: pclmRes.length ? [...new Set(pclmRes)].slice(0, 8) : [PREFERRED_DPI], strip: strip || 16, compression: comp.slice(0, 4), back: pclmBack },
    media: media ? media.name : null,
  };
}

/** 300 dpi, sonst die kleinste darüber, sonst die größte (ruhig für schwache Geräte wie den Raspberry Pi). */
function chooseDpi(res) {
  if (res.includes(PREFERRED_DPI)) return PREFERRED_DPI;
  const above = res.filter((r) => r > PREFERRED_DPI).sort((x, y) => x - y);
  return above.length ? above[0] : Math.max(...res);
}

function chooseType(types, color) {
  if (color && types.includes('srgb_8')) return 'srgb_8';
  if (types.includes('sgray_8')) return 'sgray_8';
  if (types.includes('srgb_8')) return 'srgb_8';
  return types.includes('black_1') ? 'black_1' : null;
}

/** Flate, wenn der Drucker es nennt (oder gar nichts nennt), sonst Run-Length; JPEG kann das Gateway nicht schreiben. */
function pclmCompression(list) {
  if (!list.length || list.includes('flate')) return 'flate';
  return list.includes('rle') ? 'rle' : 'flate';
}

/**
 * Wie eine PDF-Datei auf diesen Drucker kommt: { format, dpi, type, mono, back, media } oder
 * null (der Drucker nennt kein Format, das das Gateway erzeugen kann).
 * printer: der Drucker-Teil (formats, raster), opts: { color, media } (media: das gewählte Papier, PWG-Name).
 * Reihenfolge: PWG-Raster, Apple-Raster, PCLm, JPEG (je Seite ein Auftrag).
 */
function plan(printer, { color = false, media: wanted = null } = {}) {
  const f = printer && Array.isArray(printer.formats) ? printer.formats : [];
  const r = (printer && printer.raster) || {};
  const media = mediaOf(wanted) || mediaOf(r.media) || A4;
  if (f.includes(PWG) && r.pwg && r.pwg.res.length) {
    const type = chooseType(r.pwg.types.length ? r.pwg.types : ['sgray_8', 'srgb_8'], color);
    if (type) return { format: PWG, dpi: chooseDpi(r.pwg.res), type, mono: !color, back: r.pwg.back || 'normal', media };
  }
  if (f.includes(URF) && r.urf && r.urf.res.length) {
    const type = chooseType(r.urf.types, color);
    if (type) return { format: URF, dpi: chooseDpi(r.urf.res), type, mono: !color, back: r.urf.back || 'normal', media };
  }
  if (f.includes(PCLM)) {
    const pc = r.pclm || { res: [PREFERRED_DPI], strip: 16, compression: [], back: 'normal' };
    return {
      format: PCLM, dpi: chooseDpi(pc.res && pc.res.length ? pc.res : [PREFERRED_DPI]), type: color ? 'srgb_8' : 'sgray_8', mono: !color,
      back: pc.back || 'normal', media, strip: pc.strip || 16, compression: pclmCompression(pc.compression || []),
    };
  }
  if (f.includes(JPEG)) return { format: JPEG, dpi: PREFERRED_DPI, type: color ? 'srgb_8' : 'sgray_8', mono: !color, back: 'normal', media };
  return null;
}

/** Das Zielformat für den Gerätebericht (`printer.convert`): das Format oder null. */
function targetOf(printer) {
  const p = plan(printer, { color: true });
  return p ? p.format : null;
}

// ─── Werkzeuge ──────────────────────────────────────────────────────────

const TOOLS = { pdfinfo: process.env.GC_PDFINFO || 'pdfinfo', pdftoppm: process.env.GC_PDFTOPPM || 'pdftoppm' };
let toolsOk = null;

/** Gibt es pdfinfo und pdftoppm (poppler-utils im Image)? Einmal geprüft. */
function available() {
  if (toolsOk === null) {
    toolsOk = [TOOLS.pdfinfo, TOOLS.pdftoppm].every((t) => {
      try { return spawnSync(t, ['-v'], { timeout: 5_000, stdio: 'ignore' }).error == null; } catch (_e) { return false; }
    });
  }
  return toolsOk;
}

/** Ein Werkzeug laufen lassen → stdout (Buffer, höchstens max Bytes); niedrige Priorität. */
function run(cmd, args, { max, timeoutMs = PAGE_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(new ConvertError('no_converter', e.message)); return; }
    try { os.setPriority(child.pid, 10); } catch (_e) { /* nur ein Hinweis an den Kernel */ }
    const chunks = [];
    let n = 0;
    let err = '';
    let done = false;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (e) { try { child.kill('SIGKILL'); } catch (_x) { /* schon beendet */ } reject(e); } else resolve(v);
    };
    const timer = setTimeout(() => finish(new ConvertError('convert_failed', 'timeout')), timeoutMs);
    const onAbort = () => finish(new ConvertError('aborted'));
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (c) => {
      n += c.length;
      if (n > max) { finish(new ConvertError('convert_too_large', 'page too large')); return; }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => { if (err.length < 2000) err += c.toString('utf8'); });
    child.on('error', (e) => finish(new ConvertError(e.code === 'ENOENT' ? 'no_converter' : 'convert_failed', e.message)));
    child.on('close', (code) => {
      if (code === 0) finish(null, Buffer.concat(chunks));
      else finish(new ConvertError('convert_failed', (/password|encrypt/i.test(err) ? 'encrypted: ' : '') + err.trim().split('\n').pop().slice(0, 160)));
    });
  });
}

/** pdfinfo → [{ w, h }] je Seite in Punkt, mit der Drehung (/Rotate) schon eingerechnet. */
async function pageSizes(file, opts) {
  const head = (await run(TOOLS.pdfinfo, [file], { ...opts, max: MAX_INFO })).toString('utf8');
  const m = /^Pages:\s+(\d+)/m.exec(head);
  const count = m ? Number(m[1]) : 0;
  if (!count) throw new ConvertError('convert_failed', 'no pages');
  const text = (await run(TOOLS.pdfinfo, ['-f', '1', '-l', String(count), file], { ...opts, max: MAX_INFO })).toString('utf8');
  const sizes = new Map();
  const rots = new Map();
  for (const x of text.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/gm)) sizes.set(Number(x[1]), { w: Number(x[2]), h: Number(x[3]) });
  for (const x of text.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) rots.set(Number(x[1]), Number(x[2]) % 360);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const s = sizes.get(i) || out[out.length - 1] || { w: A4.w, h: A4.h };
    const turned = rots.get(i) === 90 || rots.get(i) === 270;
    out.push(turned ? { w: s.h, h: s.w } : { w: s.w, h: s.h });
  }
  return out;
}

const PNM_HEAD_MAX = 512;
const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;

/**
 * PNM (P5 Grau / P6 RGB, 8 Bit) → { width, height, bpp, data }. Der Kopf wird
 * Zeichen für Zeichen gelesen (Leerraum, Kommentare „# … bis Zeilenende“,
 * höchstens PNM_HEAD_MAX Bytes) – linear, ohne regulären Ausdruck.
 */
function parsePnm(buf) {
  const bad = (why) => new ConvertError('convert_failed', why || 'unexpected renderer output');
  if (!Buffer.isBuffer(buf) || buf.length < 3 || buf[0] !== 0x50 || (buf[1] !== 0x35 && buf[1] !== 0x36)) throw bad();
  const bpp = buf[1] === 0x35 ? 1 : 3;
  const limit = Math.min(buf.length, PNM_HEAD_MAX);
  let o = 2;
  const nums = [];
  while (nums.length < 3) {
    // Leerraum und Kommentare überspringen
    while (o < limit && (isSpace(buf[o]) || buf[o] === 0x23)) {
      if (buf[o] === 0x23) { while (o < limit && buf[o] !== 0x0a) o++; } else o++;
    }
    let n = 0;
    let digits = 0;
    while (o < limit && buf[o] >= 0x30 && buf[o] <= 0x39 && digits < 6) { n = n * 10 + (buf[o] - 0x30); o++; digits++; }
    if (!digits || o >= limit || !isSpace(buf[o])) throw bad();
    nums.push(n);
  }
  o++; // genau ein Leerzeichen nach dem Maximalwert, dann die Pixel
  const [width, height, max] = nums;
  if (max !== 255 || !width || !height) throw bad();
  const data = buf.subarray(o);
  if (data.length < width * height * bpp) throw bad('short renderer output');
  return { width, height, bpp, data: data.subarray(0, width * height * bpp) };
}

// ─── Seiten zurechtlegen ────────────────────────────────────────────────

/**
 * Wie eine Seite (w × h Punkt) aufs Papier kommt: quer auf hochkant gedreht,
 * zu groß → verkleinert, nie vergrößert, mittig. → { rw, rh, turn, W, H, x, y }
 * (rw × rh: gerendert in Pixeln vor dem Drehen; W × H: das Blatt).
 */
function layout(page, media, dpi) {
  const px = (pt) => Math.max(1, Math.round((pt / 72) * dpi));
  const W = px(media.w);
  const H = px(media.h);
  const turn = (page.w > page.h) !== (media.w > media.h) && Math.abs(page.w - page.h) > 1;
  const fw = turn ? page.h : page.w;
  const fh = turn ? page.w : page.h;
  const s = Math.min(1, media.w / fw, media.h / fh);
  // auf das Blatt passend (Rundung): höchstens W × H
  const ow = Math.min(W, px(fw * s));
  const oh = Math.min(H, px(fh * s));
  return { rw: turn ? oh : ow, rh: turn ? ow : oh, turn, W, H, x: Math.floor((W - ow) / 2), y: Math.floor((H - oh) / 2) };
}

/** Pixel um 90° gegen den Uhrzeigersinn drehen (oben → links). */
function rotate90(img) {
  const { width: w, height: h, bpp, data } = img;
  const out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * bpp;
      const dst = ((w - 1 - x) * h + y) * bpp;
      for (let c = 0; c < bpp; c++) out[dst + c] = data[src + c];
    }
  }
  return { width: h, height: w, bpp, data: out };
}

/** Das gerenderte Bild mittig auf ein weißes Blatt W × H. */
function onSheet(img, W, H, x0, y0) {
  if (img.width === W && img.height === H) return img;
  const { bpp } = img;
  const out = Buffer.alloc(W * H * bpp, 0xff);
  const cw = Math.min(img.width, W - x0);
  for (let y = 0; y < img.height && y + y0 < H; y++) {
    img.data.copy(out, ((y + y0) * W + x0) * bpp, y * img.width * bpp, (y * img.width + cw) * bpp);
  }
  return { width: W, height: H, bpp, data: out };
}

/** Rückseite für den Drucker: 'rotated' → 180°, 'flipped' → Zeilen von unten nach oben (beidseitig, lange Kante). */
function backSide(img, back) {
  if (back !== 'rotated' && back !== 'flipped') return img;
  const { width: w, height: h, bpp, data } = img;
  const row = w * bpp;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    const src = data.subarray(y * row, (y + 1) * row);
    const dst = (h - 1 - y) * row;
    if (back === 'flipped') { src.copy(out, dst); continue; }
    for (let x = 0; x < w; x++) {
      const s = x * bpp;
      const d = dst + (w - 1 - x) * bpp;
      for (let c = 0; c < bpp; c++) out[d + c] = src[s + c];
    }
  }
  return { ...img, data: out };
}

/** Grau → RGB (Drucker ohne Graustufen-Raster) bzw. Grau → 1 Bit schwarz (black_1: 1 = schwarz). */
function toType(img, type) {
  if (type === 'srgb_8' && img.bpp === 1) {
    const out = Buffer.alloc(img.width * img.height * 3);
    for (let i = 0, j = 0; i < img.data.length; i++, j += 3) { out[j] = img.data[i]; out[j + 1] = img.data[i]; out[j + 2] = img.data[i]; }
    return { ...img, bpp: 3, data: out };
  }
  if (type === 'black_1') {
    const row = Math.ceil(img.width / 8);
    const out = Buffer.alloc(row * img.height);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) if (img.data[y * img.width + x] < 128) out[y * row + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return { ...img, bpp: 0, row, data: out };
  }
  return img;
}

// ─── PWG-Raster und Apple-Raster (URF) ──────────────────────────────────

/**
 * Eine Zeile komprimiert (PWG 5102.4 / URF, gleiches Verfahren): Steuerbyte
 * 0…127 = das folgende Pixel (n+1)-mal, 129…255 = (257−n) Pixel wörtlich.
 * unit: Bytes je Pixel (1-Bit-Raster: je Byte).
 */
function packLine(line, unit) {
  const n = line.length / unit;
  const out = Buffer.allocUnsafe(n * unit + Math.ceil(n / 128) * 2 + 2 + n);
  let o = 0;
  const same = unit === 1
    ? (a, b) => line[a] === line[b]
    : (a, b) => {
      const x = a * unit;
      const y = b * unit;
      for (let c = 0; c < unit; c++) if (line[x + c] !== line[y + c]) return false;
      return true;
    };
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && same(i, i + run)) run++;
    if (run > 1 || i + 1 >= n) {
      out[o++] = run - 1;
      o += line.copy(out, o, i * unit, (i + 1) * unit);
      i += run;
      continue;
    }
    const start = i;
    i++;
    while (i < n && i - start < 128 && !(i + 1 < n && same(i, i + 1))) i++;
    const count = i - start;
    out[o++] = count === 1 ? 0 : 257 - count;
    o += line.copy(out, o, start * unit, i * unit);
  }
  return out.subarray(0, o);
}

/** Alle Zeilen einer Seite: je Gruppe gleicher Zeilen ein Wiederholungsbyte (0…255) und die gepackte Zeile. */
function packPage(img) {
  const row = img.row || img.width * img.bpp;
  const unit = img.bpp || 1;
  const parts = [];
  let y = 0;
  while (y < img.height) {
    const line = img.data.subarray(y * row, (y + 1) * row);
    let rep = 0;
    while (y + rep + 1 < img.height && rep < 255 && img.data.subarray((y + rep + 1) * row, (y + rep + 2) * row).equals(line)) rep++;
    parts.push(Buffer.from([rep]), packLine(line, unit));
    y += rep + 1;
  }
  return Buffer.concat(parts);
}

const TYPE = {
  srgb_8: { bpc: 8, bpp: 24, cs: 19, colors: 3, urf: 1 },
  sgray_8: { bpc: 8, bpp: 8, cs: 18, colors: 1, urf: 0 },
  black_1: { bpc: 1, bpp: 1, cs: 3, colors: 1, urf: null },
};

/** Der 1796-Byte-Kopf einer PWG-Seite (PWG 5102.4 §4.3, Felder wie cups_page_header2_t). */
function pwgHeader({ width, height, dpi, type, media, duplex, pages, transform = 1 }) {
  const t = TYPE[type];
  const h = Buffer.alloc(1796);
  h.write('PwgRaster', 0, 'latin1');
  const u = (off, v) => h.writeUInt32BE(v >>> 0, off);
  u(272, duplex ? 1 : 0);
  u(276, dpi); u(280, dpi);
  u(352, Math.round(media.w)); u(356, Math.round(media.h));
  u(372, width); u(376, height);
  u(384, t.bpc); u(388, t.bpp); u(392, Math.ceil((width * t.bpp) / 8));
  u(396, 0); u(400, t.cs); u(420, t.colors);
  u(452, pages);
  u(456, transform); u(460, transform); // CrossFeedTransform, FeedTransform (−1: Rückseite gedreht)
  u(464, 0); u(468, 0); u(472, width); u(476, height);
  u(480, 0x00ffffff);
  h.write(media.name.slice(0, 63), 1732, 'latin1');
  return h;
}

/** Der 32-Byte-Kopf einer URF-Seite. */
function urfHeader({ width, height, dpi, type, duplex }) {
  const t = TYPE[type];
  const h = Buffer.alloc(32);
  h[0] = t.bpp;
  h[1] = t.urf;
  h[2] = duplex ? 3 : 1; // 3 = beidseitig, lange Kante
  h[3] = 4; // normale Qualität
  h.writeUInt32BE(width, 12);
  h.writeUInt32BE(height, 16);
  h.writeUInt32BE(dpi, 20);
  return h;
}

// ─── PCLm ───────────────────────────────────────────────────────────────

/** PDF-RunLengthDecode: 0…127 = die nächsten n+1 Bytes wörtlich, 129…255 = das nächste Byte (257−n)-mal, 128 = Ende. */
function rle(buf) {
  const out = Buffer.allocUnsafe(buf.length * 2 + 2); // schlimmster Fall: je Einzelbyte ein Steuerbyte
  let o = 0;
  let i = 0;
  while (i < buf.length) {
    let run = 1;
    while (i + run < buf.length && run < 128 && buf[i + run] === buf[i]) run++;
    if (run > 1) { out[o++] = 257 - run; out[o++] = buf[i]; i += run; continue; }
    const start = i;
    i++;
    while (i < buf.length && i - start < 128 && !(i + 1 < buf.length && buf[i] === buf[i + 1])) i++;
    out[o++] = i - start - 1;
    o += buf.copy(out, o, start, i);
  }
  out[o++] = 128;
  return out.subarray(0, o);
}

/**
 * PCLm-Datei schreiben (PCLm 1.0, Wi-Fi Alliance): Kopf „%PDF-1.7 / %PCLm 1.0“,
 * je Seite ein Inhalt mit Streifen von oben nach unten, je Streifen ein Bild.
 * Gibt { page(img), end() } zurück; die Objektnummern stehen fest, weil alle
 * Seiten dasselbe Blatt haben (W × H Pixel bei dpi).
 */
function pclmWriter(out, { width, height, dpi, type, strip, compression, pages }) {
  const bpp = type === 'srgb_8' ? 3 : 1;
  const strips = Math.ceil(height / strip);
  const perPage = 2 + strips;
  const offsets = [];
  let pos = 0;
  const put = (b) => { out.write(b); pos += b.length; };
  const obj = (n, head, stream = null) => {
    offsets[n] = pos;
    if (stream) {
      put(Buffer.from(`${n} 0 obj\n${head.replace('%LEN%', String(stream.length))}\nstream\n`, 'latin1'));
      put(stream);
      put(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else put(Buffer.from(`${n} 0 obj\n${head}\nendobj\n`, 'latin1'));
  };
  const pageNo = (i) => 3 + i * perPage;
  const wPt = ((width * 72) / dpi).toFixed(2);
  const hPt = ((height * 72) / dpi).toFixed(2);
  const filter = compression === 'rle' ? '/RunLengthDecode' : '/FlateDecode';
  const cs = bpp === 3 ? '/DeviceRGB' : '/DeviceGray';
  put(Buffer.from('%PDF-1.7\n%PCLm 1.0\n', 'latin1'));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  let i = 0;
  return {
    page(img) {
      const base = pageNo(i);
      const rowBytes = width * bpp;
      const xo = [];
      const ops = [`${(72 / dpi).toFixed(6)} 0 0 ${(72 / dpi).toFixed(6)} 0 0 cm`];
      for (let k = 0; k < strips; k++) {
        const y0 = k * strip;
        const h = Math.min(strip, height - y0);
        const raw = img.data.subarray(y0 * rowBytes, (y0 + h) * rowBytes);
        const data = compression === 'rle' ? rle(raw) : zlib.deflateSync(raw, { level: 6 });
        obj(base + 2 + k, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter ${filter} /Length %LEN% >>`, data);
        xo.push(`/Image${k} ${base + 2 + k} 0 R`);
        // PDF zählt von unten: der oberste Streifen liegt bei y = H − h
        ops.push(`/P <</MCID 0>> BDC q\n${width} 0 0 ${h} 0 ${height - y0 - h} cm\n/Image${k} Do Q\nEMC`);
      }
      const content = Buffer.from(ops.join('\n') + '\n', 'latin1');
      obj(base + 1, '<< /Length %LEN% >>', content);
      obj(base, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << ${xo.join(' ')} >> >> /Contents ${base + 1} 0 R >>`);
      i += 1;
    },
    end() {
      const kids = Array.from({ length: i }, (_x, k) => `${pageNo(k)} 0 R`).join(' ');
      obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${i} >>`);
      const size = 3 + i * perPage;
      const xref = pos;
      let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
      for (let n = 1; n < size; n++) x += `${String(offsets[n] || 0).padStart(10, '0')} 00000 n \n`;
      x += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      put(Buffer.from(x, 'latin1'));
      if (i !== pages) throw new ConvertError('convert_failed', 'page count');
    },
  };
}

// ─── Umwandeln ──────────────────────────────────────────────────────────

/** Schreibt Teile in eine Datei und zählt mit (höchstens max Bytes). */
function sink(file, max) {
  const fd = fs.openSync(file, 'w', 0o600);
  let size = 0;
  return {
    write(b) {
      size += b.length;
      if (size > max) throw new ConvertError('convert_too_large', `more than ${max} bytes`);
      fs.writeSync(fd, b);
    },
    close() { fs.closeSync(fd); return size; },
    get size() { return size; },
  };
}

/** Eine Seite rendern (pdftoppm, Grau oder RGB) und aufs Blatt legen. */
async function renderPage(file, n, page, p, opts) {
  const l = layout(page, p.media, p.dpi);
  if (l.W * l.H > MAX_PAGE_PIXELS) throw new ConvertError('convert_too_large', 'sheet too large');
  // schwarz-weiß auf einem Drucker nur mit sRGB: grau gerendert, dann als RGB geschrieben
  const rgb = p.type === 'srgb_8' && !p.mono;
  const args = ['-f', String(n), '-l', String(n), '-scale-to-x', String(l.rw), '-scale-to-y', String(l.rh)];
  if (!rgb) args.push('-gray');
  args.push(file);
  let img = parsePnm(await run(TOOLS.pdftoppm, args, { ...opts, max: l.rw * l.rh * (rgb ? 3 : 1) + 1024 }));
  if (l.turn) img = rotate90(img);
  return onSheet(img, l.W, l.H, l.x, l.y);
}

/**
 * PDF-Datei `src` → Datei(en) im Format des Plans.
 * opts: { duplex, signal, maxBytes } → { format, pages, files: [{ file, size }] }
 * PWG/URF: eine Datei `dst`; JPEG: je Seite `dst.<n>.jpg` (je ein Auftrag).
 */
async function convert(src, dst, p, opts = {}) {
  if (!available()) throw new ConvertError('no_converter', 'pdftoppm/pdfinfo missing');
  const max = opts.maxBytes || MAX_OUTPUT;
  const ro = { signal: opts.signal || null, timeoutMs: opts.pageTimeoutMs || PAGE_TIMEOUT_MS };
  const pages = await pageSizes(src, ro);
  if (p.format === JPEG) {
    const files = [];
    let total = 0;
    try {
      for (let n = 1; n <= pages.length; n++) {
        const root = `${dst}.${n}`;
        const args = ['-f', String(n), '-l', String(n), '-r', String(p.dpi), '-jpeg', '-jpegopt', 'quality=90', '-singlefile'];
        if (p.type !== 'srgb_8') args.push('-gray');
        await run(TOOLS.pdftoppm, [...args, src, root], { ...ro, max: 1024 });
        const size = fs.statSync(root + '.jpg').size;
        total += size;
        files.push({ file: root + '.jpg', size });
        if (total > max) throw new ConvertError('convert_too_large', `more than ${max} bytes`);
      }
    } catch (e) {
      for (const f of files) fs.rmSync(f.file, { force: true });
      fs.rmSync(`${dst}.${files.length + 1}.jpg`, { force: true });
      throw e;
    }
    return { format: JPEG, pages: pages.length, files };
  }
  if (p.format === PCLM) return convertPclm(src, dst, p, pages, opts, ro, max);
  const out = sink(dst, max);
  try {
    if (p.format === PWG) out.write(Buffer.from('RaS2', 'latin1'));
    else {
      const head = Buffer.alloc(12);
      head.write('UNIRAST\0', 0, 'latin1');
      head.writeUInt32BE(pages.length, 8);
      out.write(head);
    }
    const type = p.format === URF && p.type === 'black_1' ? 'sgray_8' : p.type;
    for (let i = 0; i < pages.length; i++) {
      let img = await renderPage(src, i + 1, pages[i], { ...p, type }, ro);
      const back = opts.duplex && i % 2 === 1 ? p.back : 'normal';
      img = toType(backSide(img, back), type);
      const transform = back === 'rotated' ? -1 : 1;
      const hdr = { width: img.width, height: img.height, dpi: p.dpi, type, media: p.media, duplex: !!opts.duplex, pages: pages.length, transform };
      out.write(p.format === PWG ? pwgHeader(hdr) : urfHeader(hdr));
      out.write(packPage(img));
    }
  } catch (e) {
    out.close();
    fs.rmSync(dst, { force: true });
    throw e;
  }
  return { format: p.format, pages: pages.length, files: [{ file: dst, size: out.close() }] };
}

/** PDF → PCLm: Seiten rendern wie für PWG, dann als Streifen-Bilder (Flate/Run-Length). */
async function convertPclm(src, dst, p, pages, opts, ro, max) {
  const out = sink(dst, max);
  try {
    const sheet = layout({ w: p.media.w, h: p.media.h }, p.media, p.dpi);
    if (sheet.W * sheet.H > MAX_PAGE_PIXELS) throw new ConvertError('convert_too_large', 'sheet too large');
    const w = pclmWriter(out, { width: sheet.W, height: sheet.H, dpi: p.dpi, type: p.type, strip: p.strip || 16, compression: p.compression || 'flate', pages: pages.length });
    for (let i = 0; i < pages.length; i++) {
      let img = await renderPage(src, i + 1, pages[i], p, ro);
      const back = opts.duplex && i % 2 === 1 ? p.back : 'normal';
      img = toType(backSide(img, back), p.type);
      w.page(img);
    }
    w.end();
  } catch (e) {
    out.close();
    fs.rmSync(dst, { force: true });
    throw e;
  }
  return { format: PCLM, pages: pages.length, files: [{ file: dst, size: out.close() }] };
}

/** Wie das Format an den Drucker geht (document-format): PCLm in der Schreibweise der Norm. */
const ippFormat = (f) => (f === PCLM ? PCLM_IPP : f);

module.exports = {
  ConvertError, PWG, URF, JPEG, PDF, PCLM, A4,
  sniff, sniffFile, rasterInfo, mediaOf, urfOf, plan, targetOf, available, convert, ippFormat, pageSizes, pclmWriter, rle,
  layout, rotate90, onSheet, backSide, toType, packLine, packPage, pwgHeader, urfHeader, parsePnm, chooseDpi,
  _tools: TOOLS, _reset() { toolsOk = null; },
};
