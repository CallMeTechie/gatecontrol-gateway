'use strict';

// Minimale DNS-Nachrichten für den Netzwerk-Wächter: Unicast-mDNS-Anfrage
// (RFC 6762 §5.5, „legacy unicast“ an Port 5353) und NetBIOS-Knotenstatus
// (RFC 1002, UDP 137). Antworten kommen von beliebigen Geräten im LAN und
// sind nicht vertrauenswürdig: jede Leseoperation ist begrenzt, Fehler
// liefern null statt zu werfen.

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_NBSTAT = 0x21;
const MAX_JUMPS = 16;
const MAX_RECORDS = 64;

function encodeName(name) {
  const parts = String(name).split('.').filter(Boolean);
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error('label too long');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function header(id, qd) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id & 0xffff, 0);
  h.writeUInt16BE(0, 2);          // Standardanfrage, keine Rekursion
  h.writeUInt16BE(qd, 4);
  return h;
}

/** Eine Frage (Typ PTR/A), Klasse IN. */
function encodeQuery(id, name, type = TYPE_PTR) {
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2);
  return Buffer.concat([header(id, 1), encodeName(name), q]);
}

/** "192.168.1.7" → "7.1.168.192.in-addr.arpa" */
function reverseName(ip) {
  return ip.split('.').reverse().join('.') + '.in-addr.arpa';
}

/** Name ab `off` lesen (mit Kompression). → { name, next } oder wirft. */
function readName(buf, off) {
  const labels = [];
  let pos = off;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('name out of range');
    const len = buf[pos];
    if (len === 0) { pos += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('pointer out of range');
      if (++jumps > MAX_JUMPS) throw new Error('too many pointers');
      if (next === -1) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('bad label');
    if (pos + 1 + len > buf.length) throw new Error('label out of range');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    if (labels.length > 128) throw new Error('name too long');
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

/**
 * Antwort zerlegen → { id, records: [{ name, type, data }] } (nur A und PTR
 * werden ausgewertet) oder null bei kaputten Paketen.
 */
function decodeResponse(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    if ((buf.readUInt16BE(2) & 0x8000) === 0) return null; // keine Antwort
    const qd = buf.readUInt16BE(4);
    const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) {
      pos = readName(buf, pos).next + 4;
    }
    const records = [];
    for (let i = 0; i < rr && i < MAX_RECORDS; i++) {
      const n = readName(buf, pos);
      pos = n.next;
      if (pos + 10 > buf.length) break;
      const type = buf.readUInt16BE(pos);
      const rdlen = buf.readUInt16BE(pos + 8);
      const rd = pos + 10;
      if (rd + rdlen > buf.length) break;
      if (type === TYPE_A && rdlen === 4) {
        records.push({ name: n.name, type: 'A', data: `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}` });
      } else if (type === TYPE_PTR) {
        records.push({ name: n.name, type: 'PTR', data: readName(buf, rd).name });
      }
      pos = rd + rdlen;
    }
    return { id, records };
  } catch (_e) {
    return null;
  }
}

/** NetBIOS-Knotenstatus-Anfrage für den Namen "*". */
function encodeNbstatQuery(id) {
  const raw = Buffer.alloc(16, 0);
  raw[0] = 0x2a; // '*'
  const enc = Buffer.alloc(34);
  enc[0] = 32;
  for (let i = 0; i < 16; i++) {
    enc[1 + i * 2] = 0x41 + (raw[i] >> 4);
    enc[2 + i * 2] = 0x41 + (raw[i] & 0x0f);
  }
  enc[33] = 0;
  const q = Buffer.alloc(4);
  q.writeUInt16BE(TYPE_NBSTAT, 0);
  q.writeUInt16BE(1, 2);
  return Buffer.concat([header(id, 1), enc, q]);
}

/** NBSTAT-Antwort → Rechnername (eindeutiger Name mit Suffix 0x00) oder null. */
function decodeNbstatName(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if ((buf.readUInt16BE(2) & 0x8000) === 0 || buf.readUInt16BE(6) < 1) return null;
    let pos = 12;
    for (let i = 0; i < buf.readUInt16BE(4); i++) pos = readName(buf, pos).next + 4;
    pos = readName(buf, pos).next;
    if (pos + 10 > buf.length || buf.readUInt16BE(pos) !== TYPE_NBSTAT) return null;
    let p = pos + 10;
    const count = buf[p];
    p += 1;
    for (let i = 0; i < count && i < 64; i++) {
      if (p + 18 > buf.length) return null;
      const suffix = buf[p + 15];
      const group = (buf.readUInt16BE(p + 16) & 0x8000) !== 0;
      if (suffix === 0x00 && !group) {
        let e = p + 15;
        while (e > p && (buf[e - 1] === 0x20 || buf[e - 1] === 0x00)) e--;
        const name = buf.toString('latin1', p, e);
        if (name) return name;
      }
      p += 18;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  encodeQuery, decodeResponse, reverseName, encodeNbstatQuery, decodeNbstatName, encodeName,
  TYPE_A, TYPE_PTR,
};
