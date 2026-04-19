'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/sync/configStore');

describe('ConfigStore', () => {
  it('starts empty', () => {
    const s = new ConfigStore();
    assert.equal(s.currentHash, null);
    assert.deepEqual(s.httpRoutes, []);
    assert.deepEqual(s.l4Routes, []);
  });

  it('replaces config + records hash + emits change event', () => {
    const s = new ConfigStore();
    let changeCount = 0;
    s.on('change', () => changeCount++);
    s.replaceConfig({ peer_id: 1, routes: [{ id: 1, domain: 'a.example' }], l4_routes: [] }, 'sha256:aaa');
    assert.equal(s.currentHash, 'sha256:aaa');
    assert.equal(changeCount, 1);
  });

  it('ignores identical hash (no-op)', () => {
    const s = new ConfigStore();
    let changeCount = 0;
    s.on('change', () => changeCount++);
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [] }, 'sha256:aaa');
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [] }, 'sha256:aaa');
    assert.equal(changeCount, 1);
  });

  it('computes l4 diff for TCP listener reload', () => {
    const s = new ConfigStore();
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 },
    ] }, 'sha256:a');
    const diff = s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 }, // unchanged
      { id: 2, listen_port: 2222, target_lan_host: 'y', target_lan_port: 22 },    // added
    ] }, 'sha256:b');
    assert.deepEqual(diff.l4Added.map(r => r.id), [2]);
    assert.deepEqual(diff.l4Removed, []);
    assert.deepEqual(diff.l4Changed, []);
  });

  it('computes l4 diff for changed port', () => {
    const s = new ConfigStore();
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 },
    ] }, 'sha256:a');
    const diff = s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 14000, target_lan_host: 'x', target_lan_port: 3389 }, // port changed
    ] }, 'sha256:b');
    assert.equal(diff.l4Changed.length, 1);
    assert.equal(diff.l4Changed[0].id, 1);
  });
});
