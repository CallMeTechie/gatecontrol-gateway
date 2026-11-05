'use strict';

// DNS-Nachrichten für den DNS-Filter (RFC 1035, EDNS RFC 6891, EDE RFC 8914).
// Anfragen kommen von beliebigen Geräten im LAN, Antworten vom Upstream –
// beides wird begrenzt gelesen; Fehler liefern null statt zu werfen.

const { readName } = require('../netwatch/dnsWire');

const TYPE = Object.freeze({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, OPT: 41, HTTPS: 65, ANY: 255 });
const RCODE = Object.freeze({ NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 });
const CLASS_IN = 1;
const EDNS_UDP = 1232;
const EDE_BLOCKED = 15;
const MAX_RR = 512;

const TYPE_NAMES = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
const typeName = (t) => TYPE_NAMES[t] || `TYPE${t}`;

/** Labels eines (wire-)Namens ab `off` ohne Kompression lesen → { labels: [Buffer], end } */
function readQuestionName(buf, off) {
  const labels = [];
  let pos = off;
  let total = 0;
  for (;;) {
    if (pos >= buf.length) return null;
    const len = buf[pos];
    if (len === 0) return { labels, end: pos + 1 };
    if (len > 63) return null; // Kompression/Erweiterungen in der Frage: nicht erlaubt
    if (pos + 1 + len > buf.length) return null;
    labels.push(buf.subarray(pos + 1, pos + 1 + len));
    total += len + 1;
    if (total > 255) return null;
    pos += 1 + len;
  }
}

/** Label → Kleinbuchstaben-Text; null bei Zeichen, die in Hostnamen nichts verloren haben ('.', Steuerzeichen). */
function labelText(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    let c = b[i];
    if (c <= 0x20 || c >= 0x7f || c === 0x2e) return null;
    if (c >= 0x41 && c <= 0x5a) c += 32;
    s += String.fromCharCode(c);
  }
  return s;
}

/** RR-Kopf ab `pos` überspringen → Position nach RDATA, oder -1. */
function skipRR(buf, pos) {
  const n = readName(buf, pos);
  const p = n.next;
  if (p + 10 > buf.length) return -1;
  const rdlen = buf.readUInt16BE(p + 8);
  if (p + 10 + rdlen > buf.length) return -1;
  return p + 10 + rdlen;
}

/**
 * Anfrage zerlegen → {
 *   id, opcode, rd, cd, qdcount, name (klein, ohne Punkt am Ende, '' = Wurzel),
 *   nameOk (false bei seltsamen Zeichen), qtype, qclass, question (Buffer),
 *   edns: { udpSize, do } | null
 * } oder null (kein sinnvolles DNS-Paket).
 */
function parseQuery(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > 65535) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    if (flags & 0x8000) return null; // Antwort, keine Anfrage
    const opcode = (flags >> 11) & 0xf;
    const qdcount = buf.readUInt16BE(4);
    const base = { id, opcode, rd: !!(flags & 0x0100), cd: !!(flags & 0x0010), qdcount, edns: null };
    if (qdcount !== 1) return { ...base, name: null, question: null };
    const q = readQuestionName(buf, 12);
    if (!q || q.end + 4 > buf.length) return { ...base, name: null, question: null };
    const qtype = buf.readUInt16BE(q.end);
    const qclass = buf.readUInt16BE(q.end + 2);
    const qEnd = q.end + 4;
    const texts = q.labels.map(labelText);
    const nameOk = texts.every((t) => t !== null);
    const name = nameOk ? texts.join('.') : null;
    let pos = qEnd;
    const an = buf.readUInt16BE(6);
    const ns = buf.readUInt16BE(8);
    const ar = buf.readUInt16BE(10);
    if (an + ns + ar > MAX_RR) return { ...base, name: null, question: null };
    for (let i = 0; i < an + ns && pos !== -1; i++) pos = skipRR(buf, pos);
    let edns = null;
    for (let i = 0; i < ar && pos !== -1; i++) {
      const n = readName(buf, pos);
      if (n.next + 10 > buf.length) break;
      if (buf.readUInt16BE(n.next) === TYPE.OPT) {
        const ttl = buf.readUInt32BE(n.next + 4);
        edns = { udpSize: Math.max(512, buf.readUInt16BE(n.next + 2)), do: !!(ttl & 0x8000), version: (ttl >>> 16) & 0xff };
      }
      pos = skipRR(buf, pos);
    }
    return {
      ...base, name, nameOk, qtype, qclass,
      question: Buffer.from(buf.subarray(12, qEnd)), edns,
    };
  } catch (_e) {
    return null;
  }
}

function encodeName(name) {
  const parts = String(name).split('.').filter(Boolean);
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'ascii');
    if (b.length > 63) throw new Error('label too long');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function questionFor(name, qtype, qclass = CLASS_IN) {
  const t = Buffer.alloc(4);
  t.writeUInt16BE(qtype, 0);
  t.writeUInt16BE(qclass, 2);
  return Buffer.concat([encodeName(name), t]);
}

/** OPT-RR (EDNS); optional Extended DNS Error. */
function optRecord({ udpSize = EDNS_UDP, doBit = false, ede = null } = {}) {
  const opts = [];
  if (ede !== null) {
    const o = Buffer.alloc(6);
    o.writeUInt16BE(15, 0); // OPTION-CODE EDE
    o.writeUInt16BE(2, 2);
    o.writeUInt16BE(ede, 4);
    opts.push(o);
  }
  const rdata = Buffer.concat(opts);
  const h = Buffer.alloc(11);
  h[0] = 0; // Wurzel
  h.writeUInt16BE(TYPE.OPT, 1);
  h.writeUInt16BE(udpSize, 3);
  h.writeUInt32BE(doBit ? 0x8000 : 0, 5);
  h.writeUInt16BE(rdata.length, 9);
  return Buffer.concat([h, rdata]);
}

/** Upstream-Anfrage bauen (immer RD; EDNS nur, wenn der Client EDNS sprach). */
function buildQuery({ id = 0, name, qtype, qclass = CLASS_IN, edns = null, cd = false }) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id & 0xffff, 0);
  h.writeUInt16BE(0x0100 | (cd ? 0x0010 : 0), 2);
  h.writeUInt16BE(1, 4);
  h.writeUInt16BE(edns ? 1 : 0, 10);
  const parts = [h, questionFor(name, qtype, qclass)];
  if (edns) parts.push(optRecord({ doBit: !!edns.do }));
  return Buffer.concat(parts);
}

/**
 * Antwort auf `query` bauen. answers: [{ name, type, ttl, rdata }] (Name ==
 * Fragename → Zeiger 0xC00C). `query` braucht id, opcode, rd, cd, question, edns.
 */
function buildResponse(query, { rcode = RCODE.NOERROR, answers = [], tc = false, ede = null } = {}) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(query.id & 0xffff, 0);
  const flags = 0x8000 | ((query.opcode & 0xf) << 11) | (tc ? 0x0200 : 0) | (query.rd ? 0x0100 : 0)
    | 0x0080 | (query.cd ? 0x0010 : 0) | (rcode & 0xf);
  h.writeUInt16BE(flags, 2);
  const hasQ = Buffer.isBuffer(query.question);
  h.writeUInt16BE(hasQ ? 1 : 0, 4);
  h.writeUInt16BE(hasQ ? answers.length : 0, 6);
  h.writeUInt16BE(query.edns ? 1 : 0, 10);
  const parts = [h];
  if (hasQ) {
    parts.push(query.question);
    for (const a of answers) {
      parts.push(a.name === query.name ? Buffer.from([0xc0, 0x0c]) : encodeName(a.name));
      const f = Buffer.alloc(10);
      f.writeUInt16BE(a.type, 0);
      f.writeUInt16BE(CLASS_IN, 2);
      f.writeUInt32BE(Math.max(0, a.ttl | 0), 4);
      f.writeUInt16BE(a.rdata.length, 8);
      parts.push(f, a.rdata);
    }
  }
  if (query.edns) parts.push(optRecord({ doBit: query.edns.do, ede }));
  return Buffer.concat(parts);
}

/**
 * Upstream-Antwort zerlegen → {
 *   id, rcode, tc, qEnd, ttlOffsets, minTtl (Antworten+Autorität, ohne OPT),
 *   negTtl (aus SOA bei NXDOMAIN/NODATA), answers: [{ name, type, ttl, rdata, target? }]
 * } oder null.
 */
function parseResponse(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const flags = buf.readUInt16BE(2);
    if (!(flags & 0x8000)) return null;
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    const ns = buf.readUInt16BE(8);
    const ar = buf.readUInt16BE(10);
    if (an + ns + ar > MAX_RR || qd > 1) return null;
    let pos = 12;
    let qname = null;
    if (qd === 1) {
      const n = readName(buf, pos);
      qname = n.name.toLowerCase();
      pos = n.next + 4;
      if (pos > buf.length) return null;
    }
    const ttlOffsets = [];
    const answers = [];
    let minTtl = null;
    let negTtl = null;
    for (let i = 0; i < an + ns + ar; i++) {
      const n = readName(buf, pos);
      const p = n.next;
      if (p + 10 > buf.length) return null;
      const type = buf.readUInt16BE(p);
      const ttl = buf.readUInt32BE(p + 4);
      const rdlen = buf.readUInt16BE(p + 8);
      const rd = p + 10;
      if (rd + rdlen > buf.length) return null;
      if (type !== TYPE.OPT) {
        ttlOffsets.push(p + 4);
        if (i < an + ns) minTtl = minTtl === null ? ttl : Math.min(minTtl, ttl);
        if (i >= an && i < an + ns && type === TYPE.SOA) {
          const m = readName(buf, rd);
          const r = readName(buf, m.next);
          if (r.next + 20 <= rd + rdlen) negTtl = Math.min(ttl, buf.readUInt32BE(r.next + 16));
        }
      }
      if (i < an) {
        const a = { name: n.name.toLowerCase(), type, ttl, rdata: buf.subarray(rd, rd + rdlen) };
        if (type === TYPE.CNAME) a.target = readName(buf, rd).name.toLowerCase();
        answers.push(a);
      }
      pos = rd + rdlen;
    }
    return { id: buf.readUInt16BE(0), rcode: flags & 0xf, tc: !!(flags & 0x0200), qname, ttlOffsets, minTtl, negTtl, answers, an };
  } catch (_e) {
    return null;
  }
}

/**
 * Gespeicherte Upstream-Antwort für einen Client herrichten: ID setzen,
 * Frage im Original (Groß-/Kleinschreibung, 0x20) zurückschreiben, TTLs um
 * `ageSec` senken. Gibt eine Kopie zurück.
 */
function adaptResponse(buf, { id, question, ttlOffsets = [], ageSec = 0 }) {
  const out = Buffer.from(buf);
  out.writeUInt16BE(id & 0xffff, 0);
  if (question && buf.readUInt16BE(4) === 1 && 12 + question.length <= out.length) {
    // Gleich langer Name (nur Schreibweise anders) → Bytes ersetzen, Zeiger bleiben gültig.
    const n = readQuestionName(out, 12);
    if (n && n.end + 4 - 12 === question.length) question.copy(out, 12);
  }
  if (ageSec > 0) {
    for (const off of ttlOffsets) {
      const t = out.readUInt32BE(off);
      out.writeUInt32BE(t > ageSec ? t - ageSec : 0, off);
    }
  }
  return out;
}

const ipv4Rdata = (ip) => Buffer.from(ip.split('.').map(Number));

module.exports = {
  TYPE, RCODE, CLASS_IN, EDNS_UDP, EDE_BLOCKED, typeName,
  parseQuery, buildQuery, buildResponse, parseResponse, adaptResponse, encodeName, questionFor, optRecord, ipv4Rdata,
};
