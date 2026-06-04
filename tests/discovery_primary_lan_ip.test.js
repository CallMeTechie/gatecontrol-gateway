'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { primaryLanIp } = require('../src/discovery/lanInterfaces');

const FAKE = {
  lo:           [{ address: '127.0.0.1',    netmask: '255.0.0.0',     family: 'IPv4', internal: true }],
  eth0:         [{ address: '192.168.2.228', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  gatecontrol0: [{ address: '10.8.0.79',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  wg0:          [{ address: '10.9.0.2',      netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  docker0:      [{ address: '172.17.0.1',    netmask: '255.255.0.0',   family: 'IPv4', internal: false }],
};

test('returns the host LAN address on the physical interface', () => {
  assert.equal(primaryLanIp('192.168.2.1', FAKE), '192.168.2.228');
});

test('prefers the address whose subnet contains the default gateway (non-first)', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(primaryLanIp('10.0.0.1', two), '10.0.0.5');
});

test('falls back to the first private address when no gateway match', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(primaryLanIp(null, two), '192.168.1.50');
});

test('ignores WireGuard / docker / loopback / VPN interfaces', () => {
  const ifaces = {
    lo:           [{ address: '127.0.0.1', netmask: '255.0.0.0',     family: 'IPv4', internal: true }],
    gatecontrol0: [{ address: '10.8.0.79', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    docker0:      [{ address: '172.17.0.1', netmask: '255.255.0.0',  family: 'IPv4', internal: false }],
    eth0:         [{ address: '192.168.5.10', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(primaryLanIp(null, ifaces), '192.168.5.10');
});

test('rejects public addresses — VPS with only a public /24 yields null', () => {
  const ifaces = {
    ens18: [{ address: '54.36.233.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(primaryLanIp('54.36.233.1', ifaces), null);
});

test('skips IPv6 and never returns loopback / link-local', () => {
  const ifaces = {
    eth0: [
      { address: 'fe80::1',      netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '169.254.1.5',  netmask: '255.255.0.0',           family: 'IPv4', internal: false },
      { address: '192.168.9.20', netmask: '255.255.255.0',         family: 'IPv4', internal: false },
    ],
  };
  assert.equal(primaryLanIp('192.168.9.1', ifaces), '192.168.9.20');
});

test('returns null when there is no physical IPv4 at all', () => {
  assert.equal(primaryLanIp(null, { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }] }), null);
});
