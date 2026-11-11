'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { addressKind, isLanPeer, isAllowedHost, parseCode, parseServer, parseCidrs } = require('../src/setup/net');

describe('setup page: who may reach it', () => {
  it('classifies addresses', () => {
    assert.equal(addressKind('192.168.178.20'), 'private');
    assert.equal(addressKind('10.1.2.3'), 'private');
    assert.equal(addressKind('172.16.0.1'), 'private');
    assert.equal(addressKind('172.32.0.1'), 'public');
    assert.equal(addressKind('169.254.10.1'), 'link-local');
    assert.equal(addressKind('127.0.0.1'), 'loopback');
    assert.equal(addressKind('::ffff:192.168.1.5'), 'private');
    assert.equal(addressKind('::ffff:8.8.8.8'), 'public');
    assert.equal(addressKind('fe80::1%eth0'), 'link-local');
    assert.equal(addressKind('fd12:3456::1'), 'private');
    assert.equal(addressKind('2a01:4f8::1'), 'public');
    assert.equal(addressKind('::1'), 'loopback');
    assert.equal(addressKind('8.8.8.8'), 'public');
    assert.equal(addressKind('100.64.0.1'), 'public'); // CGNAT ist kein Heimnetz
    assert.equal(addressKind('nonsense'), 'invalid');
    assert.equal(addressKind(undefined), 'invalid');
  });

  it('answers the home network only — no public address, nothing from the tunnel', () => {
    const tunnel = { tunnelIp: '10.8.0.7', tunnelCidrs: parseCidrs('10.8.0.7/32, 10.8.0.0/24') };
    assert.equal(isLanPeer({ remote: '192.168.178.44', local: '192.168.178.20' }, tunnel), true);
    assert.equal(isLanPeer({ remote: '::ffff:192.168.178.44', local: '::ffff:192.168.178.20' }, tunnel), true);
    assert.equal(isLanPeer({ remote: 'fe80::abcd', local: 'fe80::1' }, tunnel), true);
    assert.equal(isLanPeer({ remote: '203.0.113.9', local: '192.168.178.20' }, tunnel), false);
    assert.equal(isLanPeer({ remote: '2a01:4f8::1', local: '2a01:4f8::2' }, tunnel), false);
    // der Server oder ein anderer Peer über den Tunnel
    assert.equal(isLanPeer({ remote: '10.8.0.1', local: '10.8.0.7' }, tunnel), false);
    assert.equal(isLanPeer({ remote: '10.8.0.1', local: '192.168.178.20' }, tunnel), false);
    assert.equal(isLanPeer({ remote: '192.168.178.44', local: '10.8.0.7' }, tunnel), false);
    // ohne Tunnel (Einrichtungsmodus) zählt nur die Art der Adresse
    assert.equal(isLanPeer({ remote: '10.8.0.1', local: '10.8.0.7' }), true);
    // AllowedIPs 0.0.0.0/0 sperrt nicht das ganze Heimnetz aus
    assert.equal(isLanPeer({ remote: '192.168.1.9', local: '192.168.1.2' }, { tunnelIp: '10.8.0.7', tunnelCidrs: parseCidrs('0.0.0.0/0') }), true);
  });

  it('accepts only local names and addresses as Host (DNS rebinding)', () => {
    for (const ok of ['192.168.178.20:8642', '192.168.178.20', '10.0.0.5:80', 'gatecontrol.local', 'gatecontrol.local:8642', 'GateControl.local',
      'nas', 'nas:8642', 'localhost:8642', '127.0.0.1:8642', '[fe80::1]:8642', '[::1]', 'gw.lan', 'gw.home.arpa', 'pi.internal']) {
      assert.equal(isAllowedHost(ok), true, ok);
    }
    for (const bad of ['evil.example.com', 'evil.example.com:8642', '8.8.8.8:8642', 'attacker.com.', '', undefined, 'a b', 'x.local.evil.com',
      '[2a01:4f8::1]:8642', 'nas.fritz.box', '192.168.1.1:abc', 'foo:bar:baz', '-x.local']) {
      assert.equal(isAllowedHost(bad), false, String(bad));
    }
    assert.equal(isAllowedHost('nas.fritz.box:8642', ['nas.fritz.box']), true);
  });
});

describe('setup page: input', () => {
  it('normalises the setup code', () => {
    assert.deepEqual(parseCode('A3F9-27C1-0BDE-58E4'), { code: 'A3F9-27C1-0BDE-58E4', host: null });
    assert.deepEqual(parseCode(' a3f9 27c1 0bde 58e4 '), { code: 'A3F9-27C1-0BDE-58E4', host: null });
    assert.deepEqual(parseCode('a3f927c10bde58e4'), { code: 'A3F9-27C1-0BDE-58E4', host: null });
    // alte Form CODE@host
    assert.deepEqual(parseCode('A3F9-27C1-0BDE-58E4@gate.example.de'), { code: 'A3F9-27C1-0BDE-58E4', host: 'gate.example.de' });
    for (const bad of ['', 'A3F9-27C1-0BDE', 'G3F9-27C1-0BDE-58E4', 'A3F9-27C1-0BDE-58E4-AAAA', null, 42, 'x'.repeat(500)]) {
      assert.equal(parseCode(bad), null, String(bad));
    }
  });

  it('cleans the server address and always uses https', () => {
    assert.deepEqual(parseServer('gate.example.de'), { host: 'gate.example.de', port: 443, display: 'gate.example.de', origin: 'https://gate.example.de' });
    assert.equal(parseServer('https://Gate.Example.de/login?next=1').origin, 'https://gate.example.de');
    assert.equal(parseServer('http://gate.example.de').origin, 'https://gate.example.de');
    assert.equal(parseServer('  gate.example.de:8443/ ').origin, 'https://gate.example.de:8443');
    assert.deepEqual(parseServer('127.0.0.1:9443'), { host: '127.0.0.1', port: 9443, display: '127.0.0.1:9443', origin: 'https://127.0.0.1:9443' });
    for (const bad of ['', 'gate', 'user:pw@gate.example.de', 'gate.example.de:99999', 'ga te.example.de', 'gate..de', '-a.example.de', 'x@y.de', null, 'a'.repeat(400) + '.de']) {
      assert.equal(parseServer(bad), null, String(bad));
    }
  });
});
