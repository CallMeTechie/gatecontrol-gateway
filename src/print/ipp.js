'use strict';

// Kleiner IPP-Client (RFC 8010/8011, IPP 2.0) für „Drucken & Scannen“
// (docs/print.md): Nachrichten kodieren/dekodieren, Get-Printer-Attributes,
// Print-Job (Datei gestreamt), Get-Job-Attributes, Cancel-Job. Nur die
// Adressen, die der Aufrufer prüft (print.js: selbst gefunden oder `manual`),
// keine Weiterleitungen, Antworten begrenzt.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const OP = Object.freeze({ PRINT_JOB: 0x0002, VALIDATE_JOB: 0x0004, CANCEL_JOB: 0x0008, GET_JOB_ATTRIBUTES: 0x0009, GET_PRINTER_ATTRIBUTES: 0x000b });
const GROUP = Object.freeze({ operation: 0x01, job: 0x02, end: 0x03, printer: 0x04, unsupported: 0x05 });
const TAG = Object.freeze({
  unsupported: 0x10, unknown: 0x12, noValue: 0x13,
  integer: 0x21, boolean: 0x22, enum: 0x23,
  octetString: 0x30, dateTime: 0x31, resolution: 0x32, rangeOfInteger: 0x33, begCollection: 0x34,
  textWithLanguage: 0x35, nameWithLanguage: 0x36, endCollection: 0x37,
  text: 0x41, name: 0x42, keyword: 0x44, uri: 0x45, uriScheme: 0x46, charset: 0x47, naturalLanguage: 0x48,
  mimeMediaType: 0x49, memberAttrName: 0x4a,
});
// Status-Codes, die einen späteren Versuch lohnen (Drucker beschäftigt / nimmt gerade nichts an)
const RETRY_STATUS = new Set([0x0502, 0x0506, 0x0507]);
const STATUS = Object.freeze({ OK: 0x0000, FORMAT_NOT_SUPPORTED: 0x040a, NOT_FOUND: 0x0406 });
const JOB_STATE = Object.freeze({ 3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' });
const PRINTER_STATE = Object.freeze({ 3: 'idle', 4: 'processing', 5: 'stopped' });

const MAX_RESPONSE = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

class IppError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
}

// ─── Kodieren ───────────────────────────────────────────────────────────

function str(tag, name, value) {
  const n = Buffer.from(name, 'utf8');
  const v = Buffer.from(String(value), 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  let o = b.writeUInt8(tag, 0);
  o = b.writeUInt16BE(n.length, o); o += n.copy(b, o);
  o = b.writeUInt16BE(v.length, o); v.copy(b, o);
  return b;
}

function int(tag, name, value) {
  const n = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + 4);
  let o = b.writeUInt8(tag, 0);
  o = b.writeUInt16BE(n.length, o); o += n.copy(b, o);
  o = b.writeUInt16BE(4, o); b.writeInt32BE(value, o);
  return b;
}

function bool(name, value) {
  const n = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + 1);
  let o = b.writeUInt8(TAG.boolean, 0);
  o = b.writeUInt16BE(n.length, o); o += n.copy(b, o);
  o = b.writeUInt16BE(1, o); b.writeUInt8(value ? 1 : 0, o);
  return b;
}

/** Ein Attribut ([tag, name, value | values[]]) → Buffer; mehrere Werte mit leerem Namen (RFC 8010 §3.1.5). */
function encodeAttr([tag, name, value]) {
  const values = Array.isArray(value) ? value : [value];
  return Buffer.concat(values.map((v, i) => {
    const nm = i === 0 ? name : '';
    if (tag === TAG.integer || tag === TAG.enum) return int(tag, nm, v);
    if (tag === TAG.boolean) return bool(nm, v);
    return str(tag, nm, v);
  }));
}

/** Eine IPP-Nachricht: code = Operation (Anfrage) oder Status (Antwort), groups = [[groupTag, attrs[]], …]. */
function encodeMessage(code, requestId, groups) {
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0); head.writeUInt8(0, 1);
  head.writeUInt16BE(code, 2);
  head.writeUInt32BE(requestId >>> 0, 4);
  const parts = [head];
  for (const [gt, list] of groups) {
    if (!list || !list.length) continue;
    parts.push(Buffer.from([gt]));
    for (const a of list) parts.push(encodeAttr(a));
  }
  parts.push(Buffer.from([GROUP.end]));
  return Buffer.concat(parts);
}

/** Eine IPP-Anfrage. attrs: { operation: [[tag, name, value | values[]], …], job: […] }. */
function encodeRequest(op, requestId, attrs) {
  return encodeMessage(op, requestId, [[GROUP.operation, attrs && attrs.operation], [GROUP.job, attrs && attrs.job]]);
}

// ─── Dekodieren ─────────────────────────────────────────────────────────

function readValue(tag, buf) {
  switch (tag) {
    case TAG.integer: case TAG.enum: return buf.length === 4 ? buf.readInt32BE(0) : null;
    case TAG.boolean: return buf.length === 1 ? buf[0] !== 0 : null;
    case TAG.rangeOfInteger: return buf.length === 8 ? { lower: buf.readInt32BE(0), upper: buf.readInt32BE(4) } : null;
    case TAG.resolution: return buf.length === 9 ? { x: buf.readInt32BE(0), y: buf.readInt32BE(4), units: buf[8] } : null;
    case TAG.dateTime: return null;
    case TAG.textWithLanguage: case TAG.nameWithLanguage: {
      if (buf.length < 4) return null;
      const ll = buf.readUInt16BE(0);
      const tl = buf.length >= 4 + ll ? buf.readUInt16BE(2 + ll) : 0;
      return buf.subarray(4 + ll, 4 + ll + tl).toString('utf8');
    }
    case TAG.unsupported: case TAG.unknown: case TAG.noValue: return null;
    default: return buf.toString('utf8');
  }
}

/**
 * IPP-Antwort → { version, status, requestId, groups: [{ tag, attrs: { name: [values] } }], data }.
 * Sammlungen (begCollection) werden zu Objekten { member: [values] }; Tiefe ≤ 8.
 */
function decodeResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) throw new IppError('bad_response', 'short IPP response');
  const out = { version: `${buf[0]}.${buf[1]}`, status: buf.readUInt16BE(2), requestId: buf.readUInt32BE(4), groups: [], data: null };
  let o = 8;
  let group = null;
  let last = null;
  // Stapel für Sammlungen: [{ obj, member }]
  const stack = [];
  const need = (n) => { if (o + n > buf.length) throw new IppError('bad_response', 'truncated IPP response'); };
  while (o < buf.length) {
    const tag = buf[o]; o += 1;
    if (tag === GROUP.end) { out.data = buf.subarray(o); break; }
    if (tag < 0x10) { group = { tag, attrs: {} }; out.groups.push(group); last = null; continue; }
    need(2); const nl = buf.readUInt16BE(o); o += 2;
    need(nl); const name = buf.toString('utf8', o, o + nl); o += nl;
    need(2); const vl = buf.readUInt16BE(o); o += 2;
    need(vl); const raw = buf.subarray(o, o + vl); o += vl;
    if (!group) throw new IppError('bad_response', 'attribute outside a group');
    const top = stack.length ? stack[stack.length - 1] : null;
    if (tag === TAG.begCollection) {
      if (stack.length >= 8) throw new IppError('bad_response', 'collections nested too deep');
      const obj = {};
      if (top) {
        if (nl) throw new IppError('bad_response', 'named value inside a collection');
        if (!top.member) throw new IppError('bad_response', 'collection without member name');
        (top.obj[top.member] = top.obj[top.member] || []).push(obj);
      } else if (nl) { last = name; (group.attrs[name] = group.attrs[name] || []).push(obj); } else if (last) group.attrs[last].push(obj);
      stack.push({ obj, member: null });
      continue;
    }
    if (tag === TAG.endCollection) { stack.pop(); continue; }
    if (top) {
      if (tag === TAG.memberAttrName) { top.member = raw.toString('utf8'); continue; }
      if (top.member) (top.obj[top.member] = top.obj[top.member] || []).push(readValue(tag, raw));
      continue;
    }
    const v = readValue(tag, raw);
    if (nl) { last = name; group.attrs[name] = [v]; } else if (last) group.attrs[last].push(v);
  }
  return out;
}

/** Alle Attribute einer Gruppe (printer/job/operation) zusammen → { name: [values] }. */
function attrsOf(res, tag) {
  const all = {};
  for (const g of res.groups) if (g.tag === tag) Object.assign(all, g.attrs);
  return all;
}

// ─── Transport ──────────────────────────────────────────────────────────

/** { scheme: 'ipp'|'ipps', host, port, path } → printer-uri und HTTP-Ziel */
function endpointUri(ep) {
  return `${ep.scheme}://${ep.host}:${ep.port}/${String(ep.path || '').replace(/^\/+/, '')}`;
}

/**
 * POST application/ipp. body: Buffer (Kopf) und optional eine Datei, die
 * dahinter gestreamt wird ({ file, size }). → decodeResponse(…)
 */
function post(ep, head, { file = null, size = 0, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const lib = ep.scheme === 'ipps' ? https : http;
    const length = head.length + (file ? size : 0);
    const req = lib.request({
      host: ep.host, port: ep.port, method: 'POST', path: '/' + String(ep.path || '').replace(/^\/+/, ''),
      headers: { 'Content-Type': 'application/ipp', 'Content-Length': String(length), Accept: 'application/ipp' },
      timeout: timeoutMs, agent: false,
      // Drucker im LAN haben selbst signierte Zertifikate; die Adresse prüft print.js
      ...(ep.scheme === 'ipps' ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new IppError('http_status', `HTTP ${res.statusCode}`, { httpStatus: res.statusCode })); return; }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_RESPONSE) { res.destroy(); reject(new IppError('too_large', 'IPP response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => { try { resolve(decodeResponse(Buffer.concat(chunks))); } catch (e) { reject(e); } });
      res.on('error', (e) => reject(new IppError('network', e.message)));
    });
    const fail = (e) => { req.destroy(); reject(e instanceof IppError ? e : new IppError('network', e.message, { errno: e.code })); };
    req.on('timeout', () => fail(new IppError('timeout', 'IPP request timed out')));
    req.on('error', fail);
    if (signal) {
      if (signal.aborted) { fail(new IppError('aborted')); return; }
      signal.addEventListener('abort', () => fail(new IppError('aborted')), { once: true });
    }
    req.write(head);
    if (!file) { req.end(); return; }
    const rs = fs.createReadStream(file);
    rs.on('error', (e) => fail(new IppError('read', e.message)));
    rs.pipe(req);
  });
}

let nextId = 1;
const reqId = () => { nextId = (nextId % 0x7fffffff) + 1; return nextId; };

const baseOps = (ep) => [
  [TAG.charset, 'attributes-charset', 'utf-8'],
  [TAG.naturalLanguage, 'attributes-natural-language', 'en'],
  [TAG.uri, 'printer-uri', endpointUri(ep)],
];

const PRINTER_ATTRS = [
  'printer-state', 'printer-state-reasons', 'printer-is-accepting-jobs', 'printer-make-and-model', 'printer-name',
  'printer-info', 'printer-location', 'printer-uuid', 'color-supported', 'sides-supported', 'print-color-mode-supported',
  'document-format-supported', 'copies-supported', 'marker-names', 'marker-colors', 'marker-levels', 'marker-types', 'marker-low-levels',
];

async function getPrinterAttributes(ep, opts = {}) {
  const head = encodeRequest(OP.GET_PRINTER_ATTRIBUTES, reqId(), {
    operation: [...baseOps(ep), [TAG.name, 'requesting-user-name', 'GateControl'], [TAG.keyword, 'requested-attributes', PRINTER_ATTRS]],
  });
  const res = await post(ep, head, opts);
  if (res.status >= 0x0400) throw new IppError('ipp_status', `IPP status 0x${res.status.toString(16)}`, { ippStatus: res.status });
  return attrsOf(res, GROUP.printer);
}

const { cleanText } = require('./config');

const clip = (s, n) => (typeof s === 'string' ? cleanText(s, n) : null);
const COLOR_RE = /^#[0-9A-Fa-f]{6}/;

/** Printer-Attribute → der Drucker-Teil des Geräteberichts (Vertrag §2). */
function printerInfo(a) {
  const first = (k) => (Array.isArray(a[k]) && a[k].length ? a[k][0] : null);
  const list = (k) => (Array.isArray(a[k]) ? a[k].filter((x) => x != null) : []);
  const names = list('marker-names');
  const colors = list('marker-colors');
  const levels = list('marker-levels');
  const types = list('marker-types');
  const lows = list('marker-low-levels');
  const markers = names.slice(0, 12).map((n, i) => {
    const lvl = Number.isInteger(levels[i]) ? levels[i] : null;
    const level = lvl != null && lvl >= 0 && lvl <= 100 ? lvl : null;
    const low = level != null && Number.isInteger(lows[i]) ? level <= lows[i] : false;
    const c = typeof colors[i] === 'string' && COLOR_RE.test(colors[i]) ? colors[i].slice(0, 7).toUpperCase() : null;
    return { name: clip(n, 60) || '', color: c, type: clip(types[i], 40), level, low };
  });
  const copies = first('copies-supported');
  const sides = list('sides-supported');
  const modes = list('print-color-mode-supported');
  const reasons = list('printer-state-reasons').filter((r) => typeof r === 'string' && r !== 'none').slice(0, 8).map((r) => clip(r, 60));
  return {
    state: PRINTER_STATE[first('printer-state')] || 'idle',
    accepting: first('printer-is-accepting-jobs') !== false,
    reasons,
    color: first('color-supported') === true || modes.includes('color'),
    duplex: sides.some((s) => typeof s === 'string' && s.startsWith('two-sided')),
    formats: [...new Set(list('document-format-supported').filter((f) => typeof f === 'string').map((f) => f.toLowerCase().slice(0, 60)))].slice(0, 24),
    copiesMax: copies && Number.isInteger(copies.upper) ? Math.max(1, Math.min(999, copies.upper)) : 1,
    markers,
    model: clip(first('printer-make-and-model'), 120),
    name: clip(first('printer-info'), 120) || clip(first('printer-name'), 120),
    location: clip(first('printer-location'), 120),
    uuid: typeof first('printer-uuid') === 'string' ? first('printer-uuid').replace(/^urn:uuid:/i, '').toLowerCase() : null,
  };
}

/**
 * Print-Job: die Datei hinter dem Kopf. → { status, jobId, jobState }
 * job: { name, user, format, copies, duplex, color }
 */
async function printJob(ep, file, size, job, opts = {}) {
  const jobAttrs = [];
  if (Number.isInteger(job.copies) && job.copies > 1) jobAttrs.push([TAG.integer, 'copies', job.copies]);
  if (typeof job.duplex === 'boolean') jobAttrs.push([TAG.keyword, 'sides', job.duplex ? 'two-sided-long-edge' : 'one-sided']);
  if (typeof job.color === 'boolean') jobAttrs.push([TAG.keyword, 'print-color-mode', job.color ? 'color' : 'monochrome']);
  const head = encodeRequest(OP.PRINT_JOB, reqId(), {
    operation: [
      ...baseOps(ep),
      [TAG.name, 'requesting-user-name', String(job.user || 'GateControl').slice(0, 60)],
      [TAG.name, 'job-name', String(job.name || 'GateControl').slice(0, 120)],
      [TAG.mimeMediaType, 'document-format', job.format],
    ],
    job: jobAttrs,
  });
  const res = await post(ep, head, { ...opts, file, size, timeoutMs: opts.timeoutMs || 120_000 });
  const j = attrsOf(res, GROUP.job);
  const jobId = Array.isArray(j['job-id']) ? j['job-id'][0] : null;
  return { status: res.status, jobId: Number.isInteger(jobId) ? jobId : null, jobState: JOB_STATE[(j['job-state'] || [])[0]] || null };
}

async function getJobAttributes(ep, jobId, opts = {}) {
  const head = encodeRequest(OP.GET_JOB_ATTRIBUTES, reqId(), {
    operation: [...baseOps(ep), [TAG.integer, 'job-id', jobId], [TAG.name, 'requesting-user-name', 'GateControl'],
      [TAG.keyword, 'requested-attributes', ['job-state', 'job-state-reasons']]],
  });
  const res = await post(ep, head, opts);
  if (res.status >= 0x0400) throw new IppError('ipp_status', `IPP status 0x${res.status.toString(16)}`, { ippStatus: res.status });
  const j = attrsOf(res, GROUP.job);
  return { state: JOB_STATE[(j['job-state'] || [])[0]] || null, reasons: (j['job-state-reasons'] || []).filter((x) => typeof x === 'string').slice(0, 8) };
}

async function cancelJob(ep, jobId, opts = {}) {
  const head = encodeRequest(OP.CANCEL_JOB, reqId(), {
    operation: [...baseOps(ep), [TAG.integer, 'job-id', jobId], [TAG.name, 'requesting-user-name', 'GateControl']],
  });
  const res = await post(ep, head, opts);
  return res.status;
}

module.exports = {
  OP, GROUP, TAG, STATUS, RETRY_STATUS, JOB_STATE, PRINTER_STATE, IppError,
  encodeRequest, encodeMessage, decodeResponse, attrsOf, endpointUri, post,
  getPrinterAttributes, printerInfo, printJob, getJobAttributes, cancelJob, PRINTER_ATTRS,
};
