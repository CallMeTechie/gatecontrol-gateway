'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');

// Minimal valid env (mirrors src/config.js ConfigSchema required fields).
const BASE = [
  'GC_SERVER_URL=https://srv.example.com',
  'GC_API_TOKEN=gc_gw_' + 'a'.repeat(64),
  'GC_GATEWAY_TOKEN=' + 'b'.repeat(64),
  'GC_TUNNEL_IP=10.8.0.9',
  'WG_PRIVATE_KEY=x', 'WG_PUBLIC_KEY=x', 'WG_ENDPOINT=host:51820',
  'WG_SERVER_PUBLIC_KEY=x', 'WG_ADDRESS=10.8.0.9/32',
];
function writeEnv(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const p = path.join(dir, 'gateway.env');
  fs.writeFileSync(p, BASE.concat(extra).join('\n') + '\n');
  return p;
}

test('discovery config defaults', () => {
  const c = loadConfig(writeEnv());
  assert.equal(c.discoveryMaxPrefix, 22);
  assert.equal(c.discoveryTimeoutMs, 45000);
  assert.equal(c.discoveryConcurrency, 128);
});

test('discovery config overrides + bounds', () => {
  const c = loadConfig(writeEnv([
    'GC_DISCOVERY_MAX_PREFIX=24', 'GC_DISCOVERY_TIMEOUT_MS=30000', 'GC_DISCOVERY_CONCURRENCY=64',
  ]));
  assert.equal(c.discoveryMaxPrefix, 24);
  assert.equal(c.discoveryTimeoutMs, 30000);
  assert.equal(c.discoveryConcurrency, 64);
  assert.throws(() => loadConfig(writeEnv(['GC_DISCOVERY_MAX_PREFIX=40']))); // zod max(32) → 40 rejected
});
