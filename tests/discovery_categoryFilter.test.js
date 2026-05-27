'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCategories, passivePasses } = require('../src/discovery/categoryFilter');

test('include mode: only selected categories contribute ports', () => {
  const r = resolveCategories('include', ['web']);
  assert.ok(r.ports.includes(80) && r.ports.includes(443));
  assert.ok(!r.ports.includes(1883)); // iot not selected
  assert.deepEqual(r.activeKeys, ['web']);
});

test('exclude mode: all categories except selected', () => {
  const r = resolveCategories('exclude', ['iot']);
  assert.ok(!r.ports.includes(1883)); // iot excluded
  assert.ok(r.ports.includes(80));    // web still in
  assert.ok(!r.activeKeys.includes('iot'));
});

test('passive hit in an inactive category is dropped; active kept; uncategorised always kept', () => {
  const inc = resolveCategories('include', ['web']);
  assert.equal(passivePasses({ mdnsType: '_hap._tcp' }, inc), false);      // iot, not active
  assert.equal(passivePasses({ mdnsType: '_http._tcp' }, inc), true);      // web, active
  assert.equal(passivePasses({ mdnsType: '_unknown._tcp' }, inc), true);   // uncategorised → kept
  const exc = resolveCategories('exclude', ['iot']);
  assert.equal(passivePasses({ mdnsType: '_hap._tcp' }, exc), false);      // iot excluded
  assert.equal(passivePasses({ ssdpServer: 'Linux/3 UPnP/1.0 WeMo/1' }, exc), false); // WeMo→iot excluded
});
