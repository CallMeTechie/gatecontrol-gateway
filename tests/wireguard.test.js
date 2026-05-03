'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseWgShowDump, buildWgConfFile } = require('../src/wireguard');

describe('wireguard', () => {
  it('parseWgShowDump extracts peer + handshake age', () => {
    // wg show wg0 dump format:
    // privatekey publickey listenport fwmark
    // peer_pub preshared_key endpoint allowed_ips latest_handshake rx tx persistent_keepalive
    const sample = [
      'PRIV\tPUB\t51820\toff',
      'PEERKEY\t(none)\t203.0.113.1:51820\t0.0.0.0/0\t1700000000\t1234\t5678\t25',
    ].join('\n');
    const now = 1700000060; // 60s after handshake
    const parsed = parseWgShowDump(sample, now);
    assert.equal(parsed.interface.privateKey, 'PRIV');
    assert.equal(parsed.peers.length, 1);
    assert.equal(parsed.peers[0].publicKey, 'PEERKEY');
    assert.equal(parsed.peers[0].latestHandshakeTs, 1700000000);
    assert.equal(parsed.peers[0].handshakeAgeS, 60);
  });

  it('buildWgConfFile produces valid wg-quick INI', () => {
    const cfg = {
      wg: {
        privateKey: 'PRIV',
        address: '10.8.0.5/24',
        dns: '10.8.0.1',
        publicKey: 'IGNORED',
        serverPublicKey: 'SERV',
        endpoint: 'host.example:51820',
      },
    };
    const ini = buildWgConfFile(cfg);
    assert.match(ini, /\[Interface\]/);
    assert.match(ini, /PrivateKey\s*=\s*PRIV/);
    assert.match(ini, /Address\s*=\s*10\.8\.0\.5\/24/);
    assert.match(ini, /\[Peer\]/);
    assert.match(ini, /PublicKey\s*=\s*SERV/);
    assert.match(ini, /Endpoint\s*=\s*host\.example:51820/);
    assert.match(ini, /AllowedIPs\s*=\s*10\.8\.0\.0\/24/, 'default AllowedIPs = tunnel subnet, NOT 0.0.0.0/0');
  });

  it('buildWgConfFile respects custom allowedIps from config', () => {
    const cfg = { wg: { privateKey: 'P', address: '10.8.0.5/24',
      serverPublicKey: 'S', endpoint: 'h:51820', allowedIps: '10.0.0.0/8' } };
    const ini = buildWgConfFile(cfg);
    assert.match(ini, /AllowedIPs\s*=\s*10\.0\.0\.0\/8/);
  });
});

describe('wireguard runCommand timeout', () => {
  const fs = require('node:fs');
  const { _runCommand } = require('../src/wireguard');
  const hasSleep = (() => { try { return fs.statSync('/bin/sleep').isFile(); } catch { return false; } })();
  const skip = !hasSleep;

  it('rejects with timeout error and kills child when timeoutMs exceeded', { skip }, async () => {
    const start = Date.now();
    await assert.rejects(
      _runCommand('/bin/sleep', ['5'], { timeoutMs: 80 }),
      /timed out after 80ms/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected timeout to fire fast, took ${elapsed}ms`);
  });

  it('resolves normally when child exits before timeoutMs', { skip }, async () => {
    const out = await _runCommand('/bin/sh', ['-c', 'echo hello'], { timeoutMs: 2000 });
    assert.match(out, /hello/);
  });

  it('without timeoutMs the legacy (unbounded) path still works', { skip }, async () => {
    const out = await _runCommand('/bin/sh', ['-c', 'echo legacy']);
    assert.match(out, /legacy/);
  });
});
