'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, isRfc1918, isTunnelIpValid } = require('../src/config');

describe('config', () => {
  function writeEnv(content) {
    const f = path.join(os.tmpdir(), `gw-env-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(f, content);
    return f;
  }

  it('loads required keys from .env file', () => {
    const f = writeEnv(`
GC_SERVER_URL=https://example.com
GC_API_TOKEN=gc_gw_${'a'.repeat(64)}
GC_GATEWAY_TOKEN=${'b'.repeat(64)}
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
GC_HEARTBEAT_INTERVAL_S=30
GC_POLL_INTERVAL_S=300
WG_PRIVATE_KEY=xxx
WG_PUBLIC_KEY=yyy
WG_ENDPOINT=example.com:51820
WG_SERVER_PUBLIC_KEY=zzz
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1
    `.trim());
    const cfg = loadConfig(f);
    assert.equal(cfg.serverUrl, 'https://example.com');
    assert.equal(cfg.tunnelIp, '10.8.0.5');
    assert.equal(cfg.proxyPort, 8080);
    assert.equal(cfg.apiPort, 9876);
    assert.equal(cfg.heartbeatIntervalS, 30);
  });

  it('throws on missing required key', () => {
    const f = writeEnv('GC_SERVER_URL=https://example.com\n');
    assert.throws(() => loadConfig(f), /GC_API_TOKEN|missing/i);
  });

  it('throws on malformed API_TOKEN', () => {
    const f = writeEnv(`GC_SERVER_URL=https://example.com
GC_API_TOKEN=invalid
GC_GATEWAY_TOKEN=${'b'.repeat(64)}
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
WG_PRIVATE_KEY=xxx
WG_PUBLIC_KEY=yyy
WG_ENDPOINT=example.com:51820
WG_SERVER_PUBLIC_KEY=zzz
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1`);
    assert.throws(() => loadConfig(f), /GC_API_TOKEN|format/i);
  });

  it('isRfc1918 accepts private ranges', () => {
    assert.equal(isRfc1918('10.0.0.1'), true);
    assert.equal(isRfc1918('172.16.0.1'), true);
    assert.equal(isRfc1918('192.168.1.1'), true);
    assert.equal(isRfc1918('169.254.1.1'), true); // link-local
  });

  it('isRfc1918 rejects public + loopback', () => {
    assert.equal(isRfc1918('8.8.8.8'), false);
    assert.equal(isRfc1918('127.0.0.1'), false);
    assert.equal(isRfc1918('1.2.3.4'), false);
    assert.equal(isRfc1918('172.15.0.1'), false); // out of 172.16/12
    assert.equal(isRfc1918('172.32.0.1'), false);
  });

  it('isTunnelIpValid rejects 0.0.0.0', () => {
    assert.equal(isTunnelIpValid('0.0.0.0'), false);
    assert.equal(isTunnelIpValid('10.8.0.5'), true);
  });

  // Exact-boundary tests — kill mutants that flip comparison operators
  // (e.g. >= 16 → > 16) in the 172.16.0.0/12 detection.
  it('isRfc1918: exact 172.16/12 boundaries', () => {
    assert.equal(isRfc1918('172.16.0.0'), true);   // first
    assert.equal(isRfc1918('172.31.255.255'), true); // last
    assert.equal(isRfc1918('172.15.255.255'), false); // just below
    assert.equal(isRfc1918('172.32.0.0'), false);    // just above
  });

  it('isRfc1918: exact 169.254/16 boundaries (link-local)', () => {
    assert.equal(isRfc1918('169.254.0.0'), true);
    assert.equal(isRfc1918('169.254.255.255'), true);
    assert.equal(isRfc1918('169.253.255.255'), false);
    assert.equal(isRfc1918('169.255.0.0'), false);
  });

  it('isRfc1918: exact 192.168/16 boundary', () => {
    assert.equal(isRfc1918('192.168.0.0'), true);
    assert.equal(isRfc1918('192.168.255.255'), true);
    assert.equal(isRfc1918('192.169.0.0'), false);
    assert.equal(isRfc1918('192.167.255.255'), false);
  });

  it('isRfc1918: exact 10/8 boundary', () => {
    assert.equal(isRfc1918('10.0.0.0'), true);
    assert.equal(isRfc1918('10.255.255.255'), true);
    assert.equal(isRfc1918('11.0.0.0'), false);
    assert.equal(isRfc1918('9.255.255.255'), false);
  });

  it('isRfc1918: rejects malformed IPs', () => {
    assert.equal(isRfc1918('not-an-ip'), false);
    assert.equal(isRfc1918(''), false);
    assert.equal(isRfc1918('10.0.0'), false);
    assert.equal(isRfc1918('10.0.0.0.0'), false);
    assert.equal(isRfc1918('10.0.0.256'), false);
    assert.equal(isRfc1918('-1.0.0.1'), false);
  });

  it('isTunnelIpValid: rejects empty and non-IPv4-shaped input', () => {
    assert.equal(isTunnelIpValid(''), false);
    assert.equal(isTunnelIpValid('not-an-ip'), false);
    assert.equal(isTunnelIpValid('10.8.0'), false);
  });
});
