'use strict';

// eSCL („AirScan“, HTTP + XML) für „Drucken & Scannen“ (docs/print.md):
// ScannerCapabilities, ScannerStatus, ScanJobs anlegen, Seiten mit
// NextDocument holen bis 404. Kein XML-Paket: die wenigen Felder werden mit
// eng begrenzten Mustern gelesen. Ziele prüft der Aufrufer (print.js); der
// Ort eines Auftrags (Location) wird nur als Pfad auf demselben Gerät benutzt.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { tlsFor, netError } = require('./ipp');
const { cleanText } = require('./config');

const MAX_XML = 256 * 1024;
const MAX_PAGE = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 180_000;
const A4 = { w: 2480, h: 3508 }; // 1/300 Zoll
const MODES = Object.freeze({ bw: 'BlackAndWhite1', gray: 'Grayscale8', color: 'RGB24' });
const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;

class EsclError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
}

function request(ep, method, path, { body = null, accept = '*/*', timeoutMs = TIMEOUT_MS, max = MAX_XML, toFile = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let tls;
    try { tls = tlsFor(ep, 'https', EsclError); } catch (e) { reject(e); return; }
    const lib = ep.scheme === 'https' ? https : http;
    const headers = { Accept: accept };
    if (body != null) { headers['Content-Type'] = 'text/xml'; headers['Content-Length'] = String(Buffer.byteLength(body)); }
    const req = lib.request({ host: ep.host, port: ep.port, method, path, headers, timeout: timeoutMs, ...tls }, (res) => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) { res.resume(); resolve({ status, headers: res.headers, body: null, bytes: 0 }); return; }
      let n = 0;
      if (toFile) {
        const out = fs.createWriteStream(toFile, { mode: 0o600 });
        let failed = false;
        const fail = (e) => { if (failed) return; failed = true; res.destroy(); out.destroy(); reject(e); };
        res.on('data', (c) => { n += c.length; if (n > max) fail(new EsclError('too_large', 'scan page too large')); });
        res.on('error', (e) => fail(new EsclError('network', e.message)));
        res.on('aborted', () => fail(new EsclError('network', 'aborted')));
        out.on('error', (e) => fail(new EsclError('write', e.message)));
        out.on('finish', () => { if (!failed) resolve({ status, headers: res.headers, body: null, bytes: n }); });
        res.pipe(out);
        return;
      }
      const chunks = [];
      res.on('data', (c) => {
        n += c.length;
        if (n > max) { res.destroy(); reject(new EsclError('too_large', 'eSCL answer too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), bytes: n }));
      res.on('error', (e) => reject(new EsclError('network', e.message)));
    });
    const fail = (e) => { req.destroy(); reject(e instanceof EsclError ? e : netError(EsclError, e)); };
    req.on('timeout', () => fail(new EsclError('timeout', 'eSCL request timed out')));
    req.on('error', fail);
    if (signal) {
      if (signal.aborted) { fail(new EsclError('aborted')); return; }
      signal.addEventListener('abort', () => fail(new EsclError('aborted')), { once: true });
    }
    req.end(body == null ? undefined : body);
  });
}

const base = (ep) => '/' + String(ep.path || 'eSCL').replace(/^\/+|\/+$/g, '');

/** Inhalte aller <prefix:Name>…</prefix:Name> (ohne Namensraum-Präfix verglichen). */
function tags(xml, name) {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) && out.length < 200) out.push(m[1].trim());
  return out;
}
const has = (xml, name) => new RegExp(`<(?:[A-Za-z0-9]+:)?${name}[\\s>/]`).test(xml);
const nums = (list) => list.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0 && x <= 4800);

/** ScannerCapabilities-XML → der Scanner-Teil des Geräteberichts (+ maxW/maxH intern). */
function parseCapabilities(xml) {
  const s = String(xml || '');
  const platenXml = tags(s, 'Platen')[0] || '';
  const adfXml = tags(s, 'Adf')[0] || '';
  const modesRaw = new Set(tags(s, 'ColorMode'));
  const color = [];
  if (modesRaw.has('BlackAndWhite1')) color.push('bw');
  if (modesRaw.has('Grayscale8') || modesRaw.has('Grayscale16')) color.push('gray');
  if (modesRaw.has('RGB24') || modesRaw.has('RGB48')) color.push('color');
  const resolutions = [...new Set(nums(tags(s, 'XResolution')))].sort((a, b) => a - b).slice(0, 16);
  const formats = [...new Set([...tags(s, 'DocumentFormat'), ...tags(s, 'DocumentFormatExt')].map((f) => f.toLowerCase()).filter((f) => /^[a-z]+\/[a-z0-9.+-]+$/.test(f)))].slice(0, 12);
  const dim = (x, k) => nums(tags(x, k))[0] || null;
  const src = platenXml || adfXml;
  return {
    model: cleanText(tags(s, 'MakeAndModel')[0] || '', 120),
    platen: !!platenXml,
    feeder: !!adfXml,
    duplex: has(adfXml, 'AdfDuplexInputCaps'),
    color: color.length ? color : ['color'],
    resolutions: resolutions.length ? resolutions : [300],
    formats: formats.length ? formats : ['image/jpeg'],
    maxW: dim(src, 'MaxWidth') || A4.w,
    maxH: dim(src, 'MaxHeight') || A4.h,
  };
}

/** ScannerStatus-XML → { state: idle|processing|stopped, adf: loaded|empty|null } */
function parseStatus(xml) {
  const s = String(xml || '');
  const st = (tags(s, 'State')[0] || '').toLowerCase();
  const adf = (tags(s, 'AdfState')[0] || '').toLowerCase();
  return {
    state: st === 'processing' ? 'processing' : (st === 'stopped' || st === 'testing' ? 'stopped' : 'idle'),
    adf: adf.includes('loaded') ? 'loaded' : (adf.includes('empty') ? 'empty' : null),
  };
}

function xmlEscape(v) { return String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }

/** ScanSettings-XML (eSCL 2.0) */
function scanSettings({ source, color, resolution, format, duplex, maxW, maxH }) {
  const w = Math.min(maxW || A4.w, A4.w);
  const h = Math.min(maxH || A4.h, A4.h);
  const fmt = xmlEscape(format);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">'
    + '<pwg:Version>2.0</pwg:Version>'
    + '<pwg:ScanRegions><pwg:ScanRegion><pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>'
    + `<pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset><pwg:Width>${w}</pwg:Width><pwg:Height>${h}</pwg:Height>`
    + '</pwg:ScanRegion></pwg:ScanRegions>'
    + `<pwg:InputSource>${source === 'feeder' ? 'Feeder' : 'Platen'}</pwg:InputSource>`
    + (source === 'feeder' ? `<scan:Duplex>${duplex ? 'true' : 'false'}</scan:Duplex>` : '')
    + `<scan:ColorMode>${MODES[color] || MODES.gray}</scan:ColorMode>`
    + `<scan:XResolution>${resolution}</scan:XResolution><scan:YResolution>${resolution}</scan:YResolution>`
    + `<pwg:DocumentFormat>${fmt}</pwg:DocumentFormat><scan:DocumentFormatExt>${fmt}</scan:DocumentFormatExt>`
    + '</scan:ScanSettings>';
}

async function capabilities(ep, opts = {}) {
  const r = await request(ep, 'GET', base(ep) + '/ScannerCapabilities', { accept: 'text/xml', ...opts });
  if (r.status !== 200) throw new EsclError('http_status', `HTTP ${r.status}`, { httpStatus: r.status });
  const caps = parseCapabilities(r.body.toString('utf8'));
  if (!caps.platen && !caps.feeder) throw new EsclError('no_source', 'scanner names no input source');
  return caps;
}

async function status(ep, opts = {}) {
  const r = await request(ep, 'GET', base(ep) + '/ScannerStatus', { accept: 'text/xml', ...opts });
  if (r.status !== 200) throw new EsclError('http_status', `HTTP ${r.status}`, { httpStatus: r.status });
  return parseStatus(r.body.toString('utf8'));
}

/** Der Pfad eines Auftrags aus `Location` – nur der Pfad, immer auf demselben Gerät. */
function jobPath(location, ep) {
  if (typeof location !== 'string' || !location) return null;
  let p;
  try { p = new URL(location, `http://${ep.host}:${ep.port}`).pathname; } catch { return null; }
  p = p.replace(/\/+$/, '');
  return PATH_RE.test(p) && p.startsWith(base(ep) + '/ScanJobs/') ? p : null;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new EsclError('aborted')); }, { once: true });
});

/**
 * Ein Scan: Auftrag anlegen, Seiten holen, bis das Gerät 404 sagt.
 * onPage(file, { n, mime, bytes }) wird je Seite aufgerufen (await) – die
 * Datei gehört danach dem Aufrufer. tmpFile(n) liefert den Pfad je Seite.
 * → { pages }
 */
async function scan(ep, settings, { onPage, tmpFile, signal = null, retryMs = 1000, maxBusy = 120 } = {}) {
  const r = await request(ep, 'POST', base(ep) + '/ScanJobs', { body: scanSettings(settings), signal });
  if (r.status === 503 || r.status === 409) throw new EsclError('scanner_busy', 'scanner busy', { httpStatus: r.status });
  if (r.status === 400) throw new EsclError('rejected', `HTTP ${r.status}`, { httpStatus: r.status });
  if (r.status !== 201 && r.status !== 200) throw new EsclError('http_status', `HTTP ${r.status}`, { httpStatus: r.status });
  const job = jobPath(r.headers.location, ep);
  if (!job) throw new EsclError('bad_location', 'scanner gave no usable job location');
  let n = 0;
  let busy = 0;
  try {
    for (;;) {
      if (n >= MAX_PAGES) break;
      const file = tmpFile(n + 1);
      let d;
      try {
        d = await request(ep, 'GET', job + '/NextDocument', { toFile: file, max: MAX_PAGE, timeoutMs: PAGE_TIMEOUT_MS, signal });
      } catch (e) { fs.rmSync(file, { force: true }); throw e; }
      if (d.status === 404 || d.status === 410) { fs.rmSync(file, { force: true }); break; }
      if (d.status === 503) {
        fs.rmSync(file, { force: true });
        if (++busy > maxBusy) throw new EsclError('timeout', 'scanner did not deliver a page');
        await sleep(retryMs, signal);
        continue;
      }
      if (d.status !== 200) {
        fs.rmSync(file, { force: true });
        // ohne Papier im Einzug antworten manche Geräte gleich mit 409/500
        if (n === 0) throw new EsclError(settings.source === 'feeder' ? 'feeder_empty' : 'http_status', `HTTP ${d.status}`, { httpStatus: d.status });
        break;
      }
      if (!d.bytes) { fs.rmSync(file, { force: true }); break; }
      busy = 0;
      n += 1;
      const mime = String(d.headers['content-type'] || settings.format).split(';')[0].trim().toLowerCase() || settings.format;
      await onPage(file, { n, mime, bytes: d.bytes });
      // vom Glas kommt nur eine Seite – manche Geräte sagen erst danach 404, manche gar nicht
      if (settings.source !== 'feeder') {
        const more = await request(ep, 'GET', job + '/NextDocument', { toFile: tmpFile(n + 1), max: MAX_PAGE, timeoutMs: 5_000, signal }).catch(() => ({ status: 404 }));
        if (more.status === 200 && more.bytes) {
          n += 1;
          await onPage(tmpFile(n), { n, mime, bytes: more.bytes });
        } else fs.rmSync(tmpFile(n + 1), { force: true });
        break;
      }
    }
  } finally {
    request(ep, 'DELETE', job, { timeoutMs: 5_000 }).catch(() => {});
  }
  return { pages: n };
}

module.exports = { EsclError, parseCapabilities, parseStatus, scanSettings, capabilities, status, scan, jobPath, MODES, MAX_PAGE, MAX_PAGES };
