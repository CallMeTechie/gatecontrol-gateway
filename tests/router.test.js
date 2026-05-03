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
    assert.deepEqual(t, { host: '192.168.1.10', port: 5001, backendHttps: false, wolMac: null, routeId: undefined });
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
