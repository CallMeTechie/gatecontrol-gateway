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
    assert.deepEqual(t, { host: '192.168.1.10', port: 5001, wolMac: null, routeId: undefined });
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
});
