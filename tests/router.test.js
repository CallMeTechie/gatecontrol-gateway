'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/proxy/router');

describe('http router', () => {
  it('resolves by domain', () => {
    const r = new Router();
    r.setRoutes([
      { domain: 'nas.example.com', target_lan_host: '192.168.1.10', target_lan_port: 5001, wol_enabled: false },
    ]);
    const t = r.resolve('nas.example.com');
    assert.deepEqual(t, {
      host: '192.168.1.10', port: 5001, backendHttps: false, wolMac: null, routeId: undefined,
      backendTlsFingerprint: null, backendTlsPinInvalid: false,
    });
  });

  it('carries backend_https flag so LAN target can be HTTPS (e.g. DSM :5001)', () => {
    const r = new Router();
    r.setRoutes([
      { id: 7, domain: 'nas.example.com', target_lan_host: '192.168.1.10', target_lan_port: 5001, backend_https: true },
    ]);
    const t = r.resolve('nas.example.com');
    assert.equal(t.backendHttps, true);
    assert.equal(t.host, '192.168.1.10');
    assert.equal(t.port, 5001);
  });

  it('backendHttps defaults to false when flag absent', () => {
    const r = new Router();
    r.setRoutes([
      { id: 8, domain: 'plain.example.com', target_lan_host: '192.168.1.11', target_lan_port: 80 },
    ]);
    assert.equal(r.resolve('plain.example.com').backendHttps, false);
  });

  it('normalizes backend_tls_fingerprint to bare lowercase hex', () => {
    const r = new Router();
    const hex = 'ab'.repeat(32);
    r.setRoutes([
      { id: 10, domain: 'pinned.example', target_lan_host: '192.168.1.10', target_lan_port: 5001,
        backend_https: true, backend_tls_fingerprint: hex.toUpperCase() },
    ]);
    const t = r.resolve('pinned.example');
    assert.equal(t.backendTlsFingerprint, hex);
    assert.equal(t.backendTlsPinInvalid, false);
  });

  it('leaves the pin unset when the field is absent or null', () => {
    const r = new Router();
    r.setRoutes([
      { id: 11, domain: 'a.example', target_lan_host: '10.0.0.1', target_lan_port: 443, backend_https: true },
      { id: 12, domain: 'b.example', target_lan_host: '10.0.0.2', target_lan_port: 443, backend_https: true, backend_tls_fingerprint: null },
      { id: 13, domain: 'c.example', target_lan_host: '10.0.0.3', target_lan_port: 443, backend_https: true, backend_tls_fingerprint: '' },
    ]);
    for (const d of ['a.example', 'b.example', 'c.example']) {
      assert.equal(r.resolve(d).backendTlsFingerprint, null);
      assert.equal(r.resolve(d).backendTlsPinInvalid, false, d);
    }
  });

  // Fail closed: "pinning requested but unusable" must NOT silently degrade to
  // "no pinning" — the proxy refuses such a route instead.
  it('marks an unusable backend_tls_fingerprint as invalid instead of ignoring it', () => {
    const r = new Router();
    r.setRoutes([
      { id: 14, domain: 'broken.example', target_lan_host: '10.0.0.4', target_lan_port: 443,
        backend_https: true, backend_tls_fingerprint: 'deadbeef' },
    ]);
    const t = r.resolve('broken.example');
    assert.equal(t.backendTlsFingerprint, null);
    assert.equal(t.backendTlsPinInvalid, true);
  });

  // A plain-http route has no TLS to verify, so an inert/garbled fingerprint
  // must not take the route down — it is warned about, not refused.
  it('does not break a plain-http route over a fingerprint it cannot apply', () => {
    const r = new Router();
    r.setRoutes([
      { id: 15, domain: 'plainpin.example', target_lan_host: '10.0.0.5', target_lan_port: 80,
        backend_tls_fingerprint: 'deadbeef' },
      { id: 16, domain: 'plainpin2.example', target_lan_host: '10.0.0.6', target_lan_port: 80,
        backend_tls_fingerprint: 'ab'.repeat(32) },
    ]);
    assert.equal(r.resolve('plainpin.example').backendTlsPinInvalid, false);
    assert.equal(r.resolve('plainpin2.example').backendTlsPinInvalid, false);
  });

  it('returns null for unknown domain', () => {
    const r = new Router();
    r.setRoutes([]);
    assert.equal(r.resolve('unknown.example.com'), null);
  });

  it('atomic swap keeps old routes serving until new ones ready', () => {
    const r = new Router();
    r.setRoutes([{ domain: 'a.example', target_lan_host: '1.1.1.1', target_lan_port: 80 }]);
    const oldMap = r._map;
    r.setRoutes([{ domain: 'b.example', target_lan_host: '2.2.2.2', target_lan_port: 80 }]);
    assert.notEqual(r._map, oldMap, 'map reference must be swapped, not mutated');
  });

  it('passes wol_mac when present', () => {
    const r = new Router();
    r.setRoutes([
      { id: 1, domain: 'x.example', target_lan_host: '10.0.0.1', target_lan_port: 80, wol_enabled: true, wol_mac: 'AA:BB:CC:DD:EE:FF' },
    ]);
    const t = r.resolve('x.example');
    assert.equal(t.wolMac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(t.routeId, 1);
  });

  // Kills the `route.wol_enabled ? wol_mac : null` mutant — without this the
  // mutant `wol_enabled ? null : wol_mac` would survive because no test
  // covers the disabled-but-MAC-set case.
  it('wolMac is null when wol_enabled=false even if wol_mac is set', () => {
    const r = new Router();
    r.setRoutes([
      { id: 2, domain: 'y.example', target_lan_host: '10.0.0.2', target_lan_port: 80,
        wol_enabled: false, wol_mac: 'AA:BB:CC:DD:EE:FF' },
    ]);
    assert.equal(r.resolve('y.example').wolMac, null);
  });

  it('wolMac is null when wol_enabled=true but wol_mac missing', () => {
    const r = new Router();
    r.setRoutes([
      { id: 3, domain: 'z.example', target_lan_host: '10.0.0.3', target_lan_port: 80,
        wol_enabled: true },
    ]);
    assert.equal(r.resolve('z.example').wolMac, null);
  });
});
