'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/netwatch/dnsWire');

/** Antwort mit Kompression bauen: Frage + PTR-Antwort (Ziel als Zeiger) + A-Eintrag. */
function buildPtrResponse(id, qname, target, ip) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(1, 10);
  const q = Buffer.concat([w.encodeName(qname), Buffer.from([0, 12, 0, 1])]);
  const tgt = w.encodeName(target);
  const ans = Buffer.concat([Buffer.from([0xc0, 12]), Buffer.from([0, 12, 0, 1, 0, 0, 0, 120]), Buffer.from([0, tgt.length]), tgt]);
  const targetOffset = 12 + q.length + 12; // Name der Antwort (2) + Typ..Länge (10)
  const add = Buffer.concat([Buffer.from([0xc0 | (targetOffset >> 8), targetOffset & 0xff]), Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4]), Buffer.from(ip.split('.').map(Number))]);
  return Buffer.concat([head, q, ans, add]);
}

describe('dnsWire', () => {
  it('encodes a PTR query for the reverse name', () => {
    const q = w.encodeQuery(7, w.reverseName('192.168.1.77'));
    assert.equal(q.readUInt16BE(0), 7);
    assert.equal(q.readUInt16BE(4), 1);
    assert.equal(w.reverseName('192.168.1.77'), '77.1.168.192.in-addr.arpa');
    assert.ok(q.includes(Buffer.from('in-addr')));
  });

  it('decodes PTR + A with compression pointers', () => {
    const buf = buildPtrResponse(7, '77.1.168.192.in-addr.arpa', 'esp32-9f12aa.local', '192.168.1.77');
    const r = w.decodeResponse(buf);
    assert.equal(r.id, 7);
    assert.deepEqual(r.records, [
      { name: '77.1.168.192.in-addr.arpa', type: 'PTR', data: 'esp32-9f12aa.local' },
      { name: 'esp32-9f12aa.local', type: 'A', data: '192.168.1.77' },
    ]);
  });

  it('rejects queries, truncated packets and pointer loops without throwing', () => {
    assert.equal(w.decodeResponse(w.encodeQuery(1, 'x.local')), null); // keine Antwort
    assert.equal(w.decodeResponse(Buffer.alloc(5)), null);
    assert.equal(w.decodeResponse('nope'), null);
    const loop = Buffer.alloc(16);
    loop.writeUInt16BE(0x8400, 2);
    loop.writeUInt16BE(1, 6);
    loop[12] = 0xc0; loop[13] = 12; // Zeiger auf sich selbst
    assert.equal(w.decodeResponse(loop), null);
    const full = buildPtrResponse(1, 'a.b', 'c.local', '10.0.0.1');
    for (let n = 12; n < full.length; n += 3) {
      const r = w.decodeResponse(full.subarray(0, n));
      assert.ok(r === null || Array.isArray(r.records));
    }
  });

  it('NetBIOS node status: query shape and name extraction', () => {
    const q = w.encodeNbstatQuery(0x4001);
    assert.equal(q.length, 12 + 34 + 4);
    assert.equal(q[12], 32);
    assert.equal(q.readUInt16BE(q.length - 4), 0x21);
    // Antwort: Kopf + Name (Zeiger) + Typ/Klasse/TTL/Länge + Namen-Tabelle
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x4001, 0); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(1, 6);
    const entry = (name, suffix, flags) => {
      const b = Buffer.alloc(18, 0x20);
      b.write(name, 0, 'latin1'); b[15] = suffix; b.writeUInt16BE(flags, 16);
      return b;
    };
    const table = Buffer.concat([Buffer.from([3]), entry('WORKGROUP', 0x00, 0x8400), entry('NAS-BUERO', 0x20, 0x0400), entry('NAS-BUERO', 0x00, 0x0400)]);
    const rr = Buffer.concat([q.subarray(12, 12 + 34), Buffer.from([0, 0x21, 0, 1, 0, 0, 0, 0]), Buffer.from([0, table.length]), table]);
    assert.equal(w.decodeNbstatName(Buffer.concat([head, rr])), 'NAS-BUERO');
    assert.equal(w.decodeNbstatName(Buffer.concat([head, rr]).subarray(0, 60)), null);
    assert.equal(w.decodeNbstatName(Buffer.alloc(3)), null);
  });
});
