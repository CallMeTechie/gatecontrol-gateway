'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { computeConfigHash } = require('@callmetechie/gatecontrol-config-hash');
const { normalizeFeatures, normalizeMac, stableJson, configHash } = require('../src/features/config');

describe('normalizeFeatures', () => {
  it('without features (old server) everything is off', () => {
    for (const raw of [undefined, null, 'x', [], 42]) {
      const f = normalizeFeatures(raw);
      assert.equal(f.received, false);
      assert.equal(f.netwatch.enabled, false);
      assert.equal(f.inetq.enabled, false);
      assert.equal(f.presence.enabled, false);
      assert.equal(f.ups.enabled, false);
    }
  });

  it('applies contract defaults for missing sub-objects', () => {
    const f = normalizeFeatures({});
    assert.equal(f.received, true);
    assert.deepEqual(f.netwatch, { enabled: true, portscan: true });
    assert.deepEqual(f.inetq, { enabled: true, speedtest: '4x', targets: ['1.1.1.1', '9.9.9.9'] });
    assert.deepEqual(f.presence, { enabled: true, macs: [], awayAfterSec: 600 });
    assert.equal(f.ups.enabled, false);
  });

  it('normalises and caps presence MACs, ignores garbage', () => {
    const macs = ['AA-BB-CC-DD-EE-01', 'aa:bb:cc:dd:ee:01', 'aabb.ccdd.ee02', 'nope', 7, 'aa:bb:cc:dd:ee:0g'];
    const f = normalizeFeatures({ presence: { enabled: true, macs } });
    assert.deepEqual(f.presence.macs, ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
    const many = Array.from({ length: 300 }, (_, i) => `02:00:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`);
    assert.equal(normalizeFeatures({ presence: { macs: many } }).presence.macs.length, 256);
  });

  it('clamps awayAfterSec', () => {
    assert.equal(normalizeFeatures({ presence: { awayAfterSec: 5 } }).presence.awayAfterSec, 60);
    assert.equal(normalizeFeatures({ presence: { awayAfterSec: 99999 } }).presence.awayAfterSec, 3600);
    assert.equal(normalizeFeatures({ presence: { awayAfterSec: 900 } }).presence.awayAfterSec, 900);
    assert.equal(normalizeFeatures({ presence: { awayAfterSec: '900' } }).presence.awayAfterSec, 600);
  });

  it('filters inetq targets and speedtest plan', () => {
    const f = normalizeFeatures({ inetq: { speedtest: 'daily', targets: ['8.8.8.8', '127.0.0.1', '0.0.0.0', '224.0.0.1', 'host.example', '8.8.8.8', '8.8.4.4'] } });
    assert.equal(f.inetq.speedtest, '4x');
    assert.deepEqual(f.inetq.targets, ['8.8.8.8', '8.8.4.4']);
    assert.deepEqual(normalizeFeatures({ inetq: { targets: [] } }).inetq.targets, ['1.1.1.1', '9.9.9.9']);
    assert.equal(normalizeFeatures({ inetq: { speedtest: 'off' } }).inetq.speedtest, 'off');
  });

  it('ups only with a usable host, validates name and port', () => {
    assert.equal(normalizeFeatures({ ups: { enabled: true, host: '' } }).ups.enabled, false);
    assert.equal(normalizeFeatures({ ups: { enabled: true, host: 'bad host;rm' } }).ups.enabled, false);
    const u = normalizeFeatures({ ups: { enabled: true, host: '192.168.1.10', port: 3493, name: 'ups' } }).ups;
    assert.deepEqual(u, { enabled: true, host: '192.168.1.10', port: 3493, name: 'ups' });
    const v = normalizeFeatures({ ups: { enabled: true, host: 'nas.fritz.box', port: 99999, name: 'a b\nLIST' } }).ups;
    assert.deepEqual(v, { enabled: true, host: 'nas.fritz.box', port: 3493, name: null });
  });

  it('normalizeMac', () => {
    assert.equal(normalizeMac('00:11:32:AA:BB:01'), '00:11:32:aa:bb:01');
    assert.equal(normalizeMac('001132aabb01'), '00:11:32:aa:bb:01');
    assert.equal(normalizeMac(''), null);
    assert.equal(normalizeMac(null), null);
  });
});

describe('config hash with features (contract: server side 1)', () => {
  const base = { config_hash_version: 1, peer_id: 3, routes: [], l4_routes: [] };

  it('stableJson sorts keys recursively, keeps array order and null', () => {
    assert.equal(stableJson({ b: 1, a: { d: [3, 1], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('without features: the plain library hash', () => {
    assert.equal(configHash(base, computeConfigHash), computeConfigHash(base));
  });

  it('with features: sha256(libHash + \\n + stableJson(features)), key order irrelevant', () => {
    const features = { netwatch: { enabled: true, portscan: false }, ups: { enabled: false, host: '', port: 3493, name: null } };
    const lib = computeConfigHash(base);
    const want = 'sha256:' + crypto.createHash('sha256').update(lib + '\n' + stableJson(features)).digest('hex');
    assert.equal(configHash({ ...base, features }, computeConfigHash), want);
    const reordered = { ups: { name: null, port: 3493, host: '', enabled: false }, netwatch: { portscan: false, enabled: true } };
    assert.equal(configHash({ ...base, features: reordered }, computeConfigHash), want);
    assert.notEqual(configHash({ ...base, features: { ...features, netwatch: { enabled: false, portscan: false } } }, computeConfigHash), want);
  });
});
