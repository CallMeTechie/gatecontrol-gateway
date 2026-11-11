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

test('collectTelemetry exposes lan_ip — private IPv4 or null, never loopback/public', () => {
  delete require.cache[require.resolve('../src/health/telemetry')];
  const { collectTelemetry } = require('../src/health/telemetry');
  const t = collectTelemetry();

  assert.ok('lan_ip' in t, 'lan_ip field is present');
  // Host-dependent: either null (no private LAN address, e.g. CI/VPS) or an
  // RFC1918 private IPv4 — never loopback or a public address.
  if (t.lan_ip !== null) {
    assert.match(t.lan_ip, /^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    assert.ok(!t.lan_ip.startsWith('127.'), 'never loopback');
  }
});

test('collectTelemetry exposes lan_ip6 / lan_subnets6 — unique local addresses (fc00::/7) only', () => {
  const { collectTelemetry } = require('../src/health/telemetry');
  const { isUlaIpv6 } = require('../src/discovery/lanInterfaces');
  const t = collectTelemetry();
  assert.ok('lan_ip6' in t && Array.isArray(t.lan_subnets6));
  if (t.lan_ip6 !== null) assert.ok(isUlaIpv6(t.lan_ip6), t.lan_ip6);
  for (const s of t.lan_subnets6) {
    assert.equal(typeof s.iface, 'string');
    assert.match(s.cidr, /^f[cd][0-9a-f:]*\/\d{2,3}$/);
  }
  // mdns_name comes from the heartbeat (bootstrap), not from collectTelemetry — no socket here
  assert.equal('mdns_name' in t, false);
});

test('telemetry.runtime: container (Docker/Podman) or native (Proxmox LXC installer, no edge container)', () => {
  const { collectTelemetry, runtimeKind } = require('../src/health/telemetry');
  assert.equal(runtimeKind((f) => f === '/.dockerenv'), 'container');
  assert.equal(runtimeKind((f) => f === '/run/.containerenv'), 'container');
  assert.equal(runtimeKind(() => false), 'native');
  assert.equal(runtimeKind(() => { throw new Error('EACCES'); }), null);
  assert.ok(['container', 'native'].includes(collectTelemetry().runtime));
});
