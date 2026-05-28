'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('collectTelemetry exposes lan_subnets + category catalogue (data only)', () => {
  delete require.cache[require.resolve('../src/health/telemetry')];
  const { collectTelemetry } = require('../src/health/telemetry');
  const t = collectTelemetry();

  // lan_subnets: array of { iface, cidr, primary } (host-dependent contents → shape only)
  assert.ok(Array.isArray(t.lan_subnets));
  for (const s of t.lan_subnets) {
    assert.deepEqual(Object.keys(s).sort(), ['cidr', 'iface', 'primary']);
    assert.match(s.cidr, /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
  }
  // at most one primary (could be 0 on a host with no scannable LAN subnet)
  assert.ok(t.lan_subnets.filter(s => s.primary).length <= 1);

  // category catalogue: keys+labels
  assert.ok(Array.isArray(t.lan_discovery_categories));
  assert.deepEqual(t.lan_discovery_categories.map(c => c.key),
    ['web', 'media', 'remote_access', 'file_sharing', 'printers', 'databases', 'iot']);

  // Phase 2: the capability flag is now set (the /api/lan-scan endpoint exists).
  assert.equal(t.lan_discovery, true);
});
