'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, catalogue } = require('../src/discovery/categories');

test('catalogue() returns key+label only for every category', () => {
  const cat = catalogue();
  assert.equal(cat.length, CATEGORIES.length);
  for (const c of cat) {
    assert.deepEqual(Object.keys(c).sort(), ['key', 'label']);
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
  }
  assert.deepEqual(cat.map(c => c.key),
    ['web', 'media', 'remote_access', 'file_sharing', 'printers', 'databases', 'iot']);
});

test('CATEGORIES carry ports/mdns/ssdp for Phase 2', () => {
  const web = CATEGORIES.find(c => c.key === 'web');
  assert.ok(web.ports.includes(443) && web.ports.includes(80));
  assert.ok(web.mdns.includes('_http._tcp'));
  const iot = CATEGORIES.find(c => c.key === 'iot');
  assert.ok(iot.ports.includes(1883));
  // HTTP-vs-L4 is decided per-port in Phase 2 (spec §9.1) — no per-category routeClass.
  for (const c of CATEGORIES) assert.equal(c.routeClass, undefined);
});

test('every CATEGORIES entry has array ports/mdns/ssdp (structural completeness)', () => {
  for (const c of CATEGORIES) {
    assert.ok(Array.isArray(c.ports), `${c.key}: ports must be an array`);
    assert.ok(Array.isArray(c.mdns), `${c.key}: mdns must be an array`);
    assert.ok(Array.isArray(c.ssdp), `${c.key}: ssdp must be an array`);
  }
});
