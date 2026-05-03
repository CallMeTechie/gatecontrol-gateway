'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMagicPacket, validateMac, _computeBroadcast } = require('../src/wol');

describe('wol', () => {
  it('buildMagicPacket produces 102 bytes: 6xFF + 16xMAC', () => {
    const p = buildMagicPacket('AA:BB:CC:DD:EE:FF');
    assert.equal(p.length, 6 + 16 * 6);
    for (let i = 0; i < 6; i++) assert.equal(p[i], 0xff);
    for (let r = 0; r < 16; r++) {
      const off = 6 + r * 6;
      assert.equal(p[off], 0xaa);
      assert.equal(p[off + 1], 0xbb);
      assert.equal(p[off + 5], 0xff);
    }
  });

  it('buildMagicPacket accepts mac with dashes', () => {
    const p = buildMagicPacket('AA-BB-CC-DD-EE-FF');
    assert.equal(p.length, 102);
  });

  it('buildMagicPacket accepts mac without separators', () => {
    const p = buildMagicPacket('AABBCCDDEEFF');
    assert.equal(p.length, 102);
  });

  it('buildMagicPacket throws on invalid mac', () => {
    assert.throws(() => buildMagicPacket('ZZ:ZZ:ZZ:ZZ:ZZ:ZZ'), /mac/i);
    assert.throws(() => buildMagicPacket('AA:BB:CC:DD:EE'), /mac/i);
  });

  it('validateMac accepts standard formats', () => {
    assert.equal(validateMac('AA:BB:CC:DD:EE:FF'), true);
    assert.equal(validateMac('aa-bb-cc-dd-ee-ff'), true);
    assert.equal(validateMac('not-a-mac'), false);
  });

  it('_computeBroadcast: 192.168.1.5 / 255.255.255.0 → 192.168.1.255', () => {
    assert.equal(_computeBroadcast('192.168.1.5', '255.255.255.0'), '192.168.1.255');
  });

  it('_computeBroadcast: 10.0.0.1 / 255.0.0.0 → 10.255.255.255', () => {
    assert.equal(_computeBroadcast('10.0.0.1', '255.0.0.0'), '10.255.255.255');
  });

  it('_computeBroadcast: /30 subnet (192.168.1.5 / 255.255.255.252) → 192.168.1.7', () => {
    assert.equal(_computeBroadcast('192.168.1.5', '255.255.255.252'), '192.168.1.7');
  });

  it('_computeBroadcast: invalid input returns null', () => {
    assert.equal(_computeBroadcast('', '255.255.255.0'), null);
    assert.equal(_computeBroadcast('192.168.1.5', '255.255'), null);
  });

  // Boundary tests — kill mutants that flip octet-range comparisons.
  it('_computeBroadcast: rejects octet > 255 in IP', () => {
    assert.equal(_computeBroadcast('192.168.1.999', '255.255.255.0'), null);
    assert.equal(_computeBroadcast('256.168.1.5', '255.255.255.0'), null);
  });

  it('_computeBroadcast: rejects octet > 255 in mask', () => {
    assert.equal(_computeBroadcast('192.168.1.5', '999.255.255.0'), null);
  });

  it('_computeBroadcast: rejects negative octets / non-numeric', () => {
    assert.equal(_computeBroadcast('-1.168.1.5', '255.255.255.0'), null);
    assert.equal(_computeBroadcast('a.b.c.d', '255.255.255.0'), null);
  });

  it('_computeBroadcast: /16 boundary — 192.168.1.5 / 255.255.0.0 → 192.168.255.255', () => {
    assert.equal(_computeBroadcast('192.168.1.5', '255.255.0.0'), '192.168.255.255');
  });

  it('_computeBroadcast: /32 host route → IP itself', () => {
    assert.equal(_computeBroadcast('192.168.1.5', '255.255.255.255'), '192.168.1.5');
  });

  // validateMac edge-cases — kills mutants that simplify the regex.
  it('validateMac rejects empty + partial MACs', () => {
    assert.equal(validateMac(''), false);
    assert.equal(validateMac('AA:BB:CC:DD:EE'), false);    // 5 octets
    assert.equal(validateMac('AA:BB:CC:DD:EE:FF:11'), false); // 7 octets
    assert.equal(validateMac('GG:HH:II:JJ:KK:LL'), false);  // hex out of range
  });

  it('validateMac accepts no-separator and dash forms', () => {
    assert.equal(validateMac('AABBCCDDEEFF'), true);
    assert.equal(validateMac('AA-BB-CC-DD-EE-FF'), true);
    assert.equal(validateMac('aa:bb:cc:dd:ee:ff'), true);
  });

  it('buildMagicPacket accepts lowercase mac and produces uppercase-equivalent bytes', () => {
    const lower = buildMagicPacket('aa:bb:cc:dd:ee:ff');
    const upper = buildMagicPacket('AA:BB:CC:DD:EE:FF');
    assert.deepEqual(lower, upper);
  });
});
