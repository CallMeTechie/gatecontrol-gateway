'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const signature = require('../src/edge/signature');
const packages = require('../src/edge/packages');
const { keyPair, makePackage } = require('./helpers/edgeFixtures');

const trusted = keyPair();
const keys = [trusted.publicKeyB64];

function check(sign, allowUnsigned) {
  const p = makePackage({ sign, trusted });
  return () => packages.inspect(p.buf, { id: 'demo-edge', version: '1.0.0', sha256: p.sha256, allowUnsigned, gatewayVersion: '1.18.0', keys });
}

test('verify: trusted / untrusted / none / invalid', () => {
  const gcplugin = require('../src/edge/gcplugin');
  for (const [sign, want] of [['trusted', 'trusted'], ['untrusted', 'untrusted'], ['none', 'none'], ['invalid', 'invalid']]) {
    const files = gcplugin.decode(makePackage({ sign, trusted }).buf);
    assert.strictEqual(signature.verify(files, keys).status, want, sign);
  }
});

test('Matrix Signatur × allowUnsigned', () => {
  // trusted → immer
  assert.strictEqual(check('trusted', false)().signature.status, 'trusted');
  assert.strictEqual(check('trusted', true)().signature.status, 'trusted');
  // unsigniert / fremder Schlüssel → nur mit allowUnsigned
  for (const s of ['none', 'untrusted']) {
    assert.throws(check(s, false), (e) => e.code === 'unsigned', s);
    assert.strictEqual(check(s, true)().signature.status, s);
  }
  // nachträglich verändert → nie
  assert.throws(check('invalid', false), (e) => e.code === 'signature_invalid');
  assert.throws(check('invalid', true), (e) => e.code === 'signature_invalid');
});

test('acceptable()', () => {
  assert.strictEqual(signature.acceptable('trusted', false), true);
  assert.strictEqual(signature.acceptable('none', false), false);
  assert.strictEqual(signature.acceptable('none', true), true);
  assert.strictEqual(signature.acceptable('untrusted', true), true);
  assert.strictEqual(signature.acceptable('invalid', true), false);
  assert.strictEqual(signature.acceptable('weird', true), false);
});

test('kaputte Signaturdatei = invalid', () => {
  const gcplugin = require('../src/edge/gcplugin');
  const files = gcplugin.decode(makePackage({ sign: 'none', trusted }).buf);
  for (const body of ['nope', '{"v":2}', JSON.stringify({ v: 1, alg: 'Ed25519', publicKey: 'x', sig: 'y' })]) {
    files.set('signature', Buffer.from(body));
    assert.strictEqual(signature.verify(files, keys).status, 'invalid');
  }
});

test('Schlüsseldatei im Image: lesbar, nur gültige Zeilen', () => {
  const list = signature.parseKeyFile(fs.readFileSync(signature.KEYS_FILE, 'utf8'));
  assert.ok(list.length >= 1);
  for (const k of list) assert.strictEqual(Buffer.from(k, 'base64').length, 32);
  assert.throws(() => signature.parseKeyFile('kein-schluessel'));
  assert.deepStrictEqual(signature.parseKeyFile('# nur Kommentar\n\n'), []);
});

test('GC_EDGE_PUBKEYS ergänzt die eingebauten Schlüssel', () => {
  const extra = keyPair().publicKeyB64;
  const k = signature.trustedKeys({ GC_EDGE_PUBKEYS: JSON.stringify([extra, 'kaputt']) });
  assert.ok(k.includes(extra));
  assert.ok(!k.includes('kaputt'));
  assert.deepStrictEqual(signature.trustedKeys({ GC_EDGE_PUBKEYS: '{nicht json' }), signature.trustedKeys({}));
});

test('sha256 muss zum Sollzustand passen', () => {
  const p = makePackage({ sign: 'trusted', trusted });
  assert.throws(() => packages.inspect(p.buf, { id: 'demo-edge', version: '1.0.0', sha256: '0'.repeat(64), allowUnsigned: false, keys }),
    (e) => e.code === 'sha256_mismatch');
});

test('id/version/minGateway aus dem Manifest werden geprüft', () => {
  const p = makePackage({ sign: 'trusted', trusted });
  assert.throws(() => packages.inspect(p.buf, { id: 'other', version: '1.0.0', sha256: p.sha256, keys }), (e) => e.code === 'bad_manifest');
  assert.throws(() => packages.inspect(p.buf, { id: 'demo-edge', version: '2.0.0', sha256: p.sha256, keys }), (e) => e.code === 'bad_manifest');
  const q = makePackage({ sign: 'trusted', trusted, edge: { entry: 'edge/index.js', minGateway: '9.0.0' } });
  assert.throws(() => packages.inspect(q.buf, { id: 'demo-edge', version: '1.0.0', sha256: q.sha256, gatewayVersion: '1.18.0', keys }),
    (e) => e.code === 'gateway_too_old');
});
